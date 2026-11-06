const crypto = require('crypto');
const { defineAdapter, ProviderError } = require('../adapter');
const { createGraphClient, downloadMedia, verifyMetaSignature, handleMetaVerification, metaAttachmentType, IG_HOSTS } = require('../meta/core');

/**
 * Instagram adapter — "Instagram API with Instagram Login" (no Facebook Page required).
 *
 * Connect (OAuth): www.instagram.com/oauth/authorize with instagram_business_basic +
 *   instagram_business_manage_messages → code → short-lived token (api.instagram.com) →
 *   long-lived token (60 days, graph.instagram.com) → /me (user_id, username, account_type).
 *   Only professional (Business/Creator) accounts can message.
 * Tokens: refreshCredentials() renews the long-lived token (allowed once it is ≥24h old); the
 *   channel maintenance job refreshes tokens expiring within 10 days, and flags the channel when
 *   refresh fails so the company can reconnect.
 * afterConnect: POST /me/subscribed_apps (messages, messaging_postbacks, messaging_seen).
 * Webhooks: object "instagram", signed with the Instagram app secret, routed by entry.id.
 * Sending: POST graph.instagram.com/<v>/me/messages. Attachments are sent by URL (a short-lived
 *   signed link to our private media). 24-hour standard messaging window enforced before queueing.
 */
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];
const FIELDS = 'messages,messaging_postbacks,messaging_seen';

function createInstagramProvider({ config }) {
  const m = config.meta || {};
  const testMode = m.igGraphBase !== 'https://graph.instagram.com';
  const graph = createGraphClient({ base: m.igGraphBase, version: m.graphVersion, appSecret: null, hosts: IG_HOSTS, testMode });
  const api = createGraphClient({ base: m.igApiBase, version: null, appSecret: null, hosts: IG_HOSTS, testMode });
  const redirectUri = () => `${config.publicUrl}/api/channels/oauth/callback/instagram`;
  const secret = () => m.igAppSecret || m.appSecret;

  return defineAdapter({
    id: 'instagram',
    displayName: 'Instagram',
    capabilities: { inbound: true, outbound: true, media: true, templates: false, replyWindowHours: 24, maxTextLength: 1000 },
    connectMode: 'oauth',
    connectFields: [],

    oauthStart({ state }) {
      if (!m.igAppId || !secret()) throw new ProviderError('meta.not_configured', { retryable: false });
      const u = new URL('https://www.instagram.com/oauth/authorize');
      u.searchParams.set('client_id', m.igAppId);
      u.searchParams.set('redirect_uri', redirectUri());
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', SCOPES.join(','));
      u.searchParams.set('state', state);
      return u.toString();
    },

    async oauthCallback({ code }) {
      const short = await api.post('oauth/access_token', { form: { client_id: m.igAppId, client_secret: secret(), grant_type: 'authorization_code', redirect_uri: redirectUri(), code } });
      const long = await graph.get('access_token', { versioned: false, query: { grant_type: 'ig_exchange_token', client_secret: secret(), access_token: short.access_token } });
      const me = await graph.get('me', { token: long.access_token, query: { fields: 'user_id,username,name,account_type' } });
      if (!['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(String(me.account_type || '').toUpperCase()) && me.account_type) {
        throw new ProviderError('instagram.not_professional', { retryable: false });
      }
      const id = String(me.user_id || me.id);
      return {
        accounts: [{
          externalAccountId: id, displayName: me.username ? `@${me.username}` : String(me.name || id),
          credentials: { accessToken: long.access_token }, externalMeta: { username: me.username || null },
          scopes: SCOPES, expiresAt: new Date(Date.now() + Number(long.expires_in || 5184000) * 1000)
        }]
      };
    },

    async afterConnect({ credentials }) {
      await graph.post('me/subscribed_apps', { token: credentials.accessToken, query: { subscribed_fields: FIELDS } });
    },

    async refreshCredentials({ credentials }) {
      const r = await graph.get('refresh_access_token', { versioned: false, query: { grant_type: 'ig_refresh_token', access_token: credentials.accessToken } });
      return { credentials: { accessToken: r.access_token }, expiresAt: new Date(Date.now() + Number(r.expires_in || 5184000) * 1000) };
    },

    async healthCheck({ channel, credentials }) {
      const me = await graph.get('me', { token: credentials.accessToken, query: { fields: 'user_id,username' } });
      return { ok: String(me.user_id || me.id) === String(channel.external_account_id) };
    },

    verifyRequest({ rawBody, headers }) { return verifyMetaSignature(rawBody, headers, secret()); },
    handleVerification({ query }) { return handleMetaVerification(query, m.verifyToken); },

    parseEvents({ rawBody }) {
      let body;
      try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new ProviderError('webhook.bad_payload', { retryable: false, status: 400 }); }
      if (!body || body.object !== 'instagram' || !Array.isArray(body.entry)) throw new ProviderError('webhook.bad_payload', { retryable: false, status: 400 });
      const events = [];
      for (const entry of body.entry.slice(0, 100)) {
        for (const ev of (entry.messaging || []).slice(0, 100)) {
          const kind = ev.message ? (ev.message.is_echo ? 'echo' : (ev.message.is_deleted ? 'deleted' : 'message')) : ev.postback ? 'postback' : ev.read ? 'read' : 'other';
          const id = ev.message?.mid || ev.postback?.mid || `${kind}:${ev.sender?.id}:${ev.timestamp}:${crypto.createHash('sha256').update(JSON.stringify(ev)).digest('hex').slice(0, 16)}`;
          events.push({ eventKey: `${entry.id}:${id}`, type: kind, externalAccountId: String(entry.id), payload: ev });
        }
      }
      return events;
    },

    async processEvent(event, { messaging }) {
      const route = await messaging.routeByAccount('instagram', event.external_account_id);
      if (!route) return { status: 'ignored', reason: 'channel.not_found' };
      const ev = event.payload;
      const base = { companyId: route.company_id, channelId: route.channel_id };
      if (event.event_type === 'message' || event.event_type === 'postback') {
        const msg = ev.message || {};
        const attachments = [];
        let type = 'text';
        for (const a of (msg.attachments || []).slice(0, 5)) {
          if (!a.payload?.url || ['share', 'story_mention', 'reel', 'ig_reel', 'fallback'].includes(a.type)) continue;
          const bytes = await downloadMedia(a.payload.url, { testMode });
          const stored = await messaging.storeInboundMedia(route.company_id, bytes, { name: a.type });
          if (stored) attachments.push(stored);
        }
        const k = attachments[0]?.kind;
        if (k) type = k === 'image' ? 'image' : k === 'audio' ? 'audio' : k === 'video' ? 'video' : 'file';
        else if ((msg.attachments || []).length && !msg.text) type = 'unsupported';
        await messaging.recordInbound(route, {
          externalUserId: String(ev.sender?.id || ''), externalMessageId: msg.mid || ev.postback?.mid || event.event_key,
          body: msg.text || ev.postback?.title || null, type, attachments, timestamp: ev.timestamp
        });
        return { status: 'processed', ...base };
      }
      if (event.event_type === 'read' && ev.read?.mid) {
        await messaging.recordStatus(route, { externalMessageId: ev.read.mid, status: 'read', at: ev.timestamp });
        return { status: 'processed', ...base };
      }
      return { status: 'ignored', reason: `instagram.${event.event_type}`, ...base };
    },

    async sendMessage(request, ctx = {}) {
      const token = request.credentials?.accessToken;
      const recipient = { id: request.to };
      let last;
      for (const a of (request.attachments || []).slice(0, 1)) {
        const url = ctx.messaging?.signedMediaUrl?.({ key: a.key, contentType: a.contentType }) || null;
        if (!url) throw new ProviderError('provider.unsupported_media', { retryable: false });
        last = await graph.post('me/messages', { token, json: { recipient, message: { attachment: { type: metaAttachmentType(a.kind), payload: { url } } } } });
      }
      if (request.text) last = await graph.post('me/messages', { token, json: { recipient, message: { text: request.text.slice(0, 1000) } } });
      if (!last?.message_id) throw new ProviderError('provider.bad_request', { retryable: false });
      return { externalMessageId: String(last.message_id) };
    }
  });
}

module.exports = { createInstagramProvider, INSTAGRAM_SCOPES: SCOPES };
