const crypto = require('crypto');
const { defineAdapter, ProviderError } = require('../adapter');
const { createGraphClient, downloadMedia, verifyMetaSignature, handleMetaVerification, metaAttachmentType, GRAPH_HOSTS } = require('../meta/core');

/**
 * Facebook Messenger (Pages) adapter.
 *
 * Connect (OAuth, Facebook Login for Business): the company admin logs in with Facebook, grants
 *   pages_show_list, pages_messaging, pages_manage_metadata (and business_management for Pages owned by
 *   a Business), and picks a Page. The long-lived user token is exchanged once; each Page token
 *   obtained from it does not expire unless the user revokes access. Page tokens are stored encrypted.
 * afterConnect: POST /{page-id}/subscribed_apps (messages, postbacks, deliveries, reads).
 * Webhooks: object "page", signed with the app secret (X-Hub-Signature-256), routed by entry.id
 *   (= Page id). Echoes of our own sends are ignored.
 * Policy: standard messaging only inside the 24-hour window after the customer's last message
 *   (replyWindowHours: 24). Message tags / Human Agent are intentionally not used (postponed).
 */
const SCOPES = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'business_management'];
const FIELDS = 'messages,messaging_postbacks,message_deliveries,message_reads';

function createMessengerProvider({ config }) {
  const m = config.meta || {};
  const testMode = m.graphBase !== 'https://graph.facebook.com';
  const graph = createGraphClient({ base: m.graphBase, version: m.graphVersion, appSecret: m.appSecret, hosts: GRAPH_HOSTS, testMode });
  const redirectUri = () => `${config.publicUrl}/api/channels/oauth/callback/messenger`;

  async function storeAttachment(messaging, route, a, token) {
    const url = a.payload?.url;
    if (!url) return null;
    const bytes = await downloadMedia(url, { testMode });
    return messaging.storeInboundMedia(route.company_id, bytes, { name: `${a.type || 'file'}` });
  }

  return defineAdapter({
    id: 'messenger',
    displayName: 'Messenger',
    capabilities: { inbound: true, outbound: true, media: true, templates: false, replyWindowHours: 24, maxTextLength: 2000 },
    connectMode: 'oauth',
    connectFields: [],

    oauthStart({ state }) {
      if (!m.appId || !m.appSecret) throw new ProviderError('meta.not_configured', { retryable: false });
      const u = new URL(`https://www.facebook.com/${m.graphVersion}/dialog/oauth`);
      u.searchParams.set('client_id', m.appId);
      u.searchParams.set('redirect_uri', redirectUri());
      u.searchParams.set('state', state);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', SCOPES.join(','));
      return u.toString();
    },

    /** code → long-lived user token → Pages the user manages (with Page tokens). */
    async oauthCallback({ code }) {
      const short = await graph.get('oauth/access_token', { query: { client_id: m.appId, client_secret: m.appSecret, redirect_uri: redirectUri(), code } });
      const long = await graph.get('oauth/access_token', { query: { grant_type: 'fb_exchange_token', client_id: m.appId, client_secret: m.appSecret, fb_exchange_token: short.access_token } });
      const me = await graph.get('me', { token: long.access_token, query: { fields: 'id,name' } });
      const pages = await graph.get('me/accounts', { token: long.access_token, query: { fields: 'id,name,access_token,tasks', limit: 100 } });
      const accounts = (pages.data || []).filter(p => p.access_token && (!p.tasks || p.tasks.includes('MESSAGING') || p.tasks.includes('MODERATE')))
        .map(p => ({ externalAccountId: String(p.id), displayName: String(p.name || p.id).slice(0, 120), credentials: { pageToken: p.access_token }, externalMeta: { metaUserId: String(me.id) }, scopes: SCOPES }));
      return { accounts };
    },

    async afterConnect({ channel, credentials }) {
      await graph.post(`${channel.external_account_id}/subscribed_apps`, { token: credentials.pageToken, query: { subscribed_fields: FIELDS } });
    },

    async disconnect({ channel, credentials }) {
      await graph.del(`${channel.external_account_id}/subscribed_apps`, { token: credentials.pageToken });
    },

    async healthCheck({ channel, credentials }) {
      const page = await graph.get(String(channel.external_account_id), { token: credentials.pageToken, query: { fields: 'id,name' } });
      return { ok: String(page.id) === String(channel.external_account_id) };
    },

    verifyRequest({ rawBody, headers }) { return verifyMetaSignature(rawBody, headers, m.appSecret); },
    handleVerification({ query }) { return handleMetaVerification(query, m.verifyToken); },

    parseEvents({ rawBody }) {
      let body;
      try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new ProviderError('webhook.bad_payload', { retryable: false, status: 400 }); }
      if (!body || body.object !== 'page' || !Array.isArray(body.entry)) throw new ProviderError('webhook.bad_payload', { retryable: false, status: 400 });
      const events = [];
      for (const entry of body.entry.slice(0, 100)) {
        for (const ev of (entry.messaging || []).slice(0, 100)) {
          const kind = ev.message ? (ev.message.is_echo ? 'echo' : 'message') : ev.postback ? 'postback' : ev.delivery ? 'delivery' : ev.read ? 'read' : 'other';
          const id = ev.message?.mid || ev.postback?.mid || `${kind}:${ev.sender?.id}:${ev.timestamp}:${crypto.createHash('sha256').update(JSON.stringify(ev)).digest('hex').slice(0, 16)}`;
          events.push({ eventKey: `${entry.id}:${id}`, type: kind, externalAccountId: String(entry.id), payload: ev });
        }
      }
      return events;
    },

    async processEvent(event, { messaging }) {
      const route = await messaging.routeByAccount('messenger', event.external_account_id);
      if (!route) return { status: 'ignored', reason: 'channel.not_found' };
      const ev = event.payload;
      const base = { companyId: route.company_id, channelId: route.channel_id };
      const userId = String(ev.sender?.id || '');
      switch (event.event_type) {
        case 'message':
        case 'postback': {
          const msg = ev.message || {};
          const attachments = [];
          let type = 'text';
          if (Array.isArray(msg.attachments)) {
            for (const a of msg.attachments.slice(0, 5)) {
              if (a.type === 'location' || a.type === 'fallback' || a.type === 'template') continue;
              const stored = await storeAttachment(messaging, route, a);
              if (stored) attachments.push(stored);
            }
            const k = attachments[0]?.kind;
            if (k) type = k === 'image' ? 'image' : k === 'audio' ? 'audio' : k === 'video' ? 'video' : 'file';
            else if (msg.attachments.length && !msg.text) type = msg.attachments[0].type === 'location' ? 'location' : 'unsupported';
          }
          if (msg.sticker_id && !attachments.length) type = 'sticker';
          await messaging.recordInbound(route, {
            externalUserId: userId, externalMessageId: msg.mid || ev.postback?.mid || event.event_key,
            body: msg.text || ev.postback?.title || null, type, attachments, timestamp: ev.timestamp
          });
          return { status: 'processed', ...base };
        }
        case 'delivery':
          for (const mid of (ev.delivery?.mids || []).slice(0, 100)) await messaging.recordStatus(route, { externalMessageId: mid, status: 'delivered', at: ev.delivery.watermark });
          return { status: 'processed', ...base };
        case 'read':
          await messaging.recordReadUpTo(route, userId, ev.read?.watermark);
          return { status: 'processed', ...base };
        default:
          return { status: 'ignored', reason: `messenger.${event.event_type}`, ...base };
      }
    },

    async sendMessage(request) {
      const token = request.credentials?.pageToken;
      const recipient = { id: request.to };
      let last;
      for (const a of (request.attachments || []).slice(0, 1)) {
        const bytes = await a.read();
        const form = new FormData();
        form.append('recipient', JSON.stringify(recipient));
        form.append('messaging_type', 'RESPONSE');
        form.append('message', JSON.stringify({ attachment: { type: metaAttachmentType(a.kind), payload: { is_reusable: false } } }));
        form.append('filedata', new Blob([bytes], { type: a.contentType || 'application/octet-stream' }), a.name || 'file');
        last = await graph.post('me/messages', { token, multipart: form, timeoutMs: 60000 });
      }
      if (request.text) {
        last = await graph.post('me/messages', { token, json: { recipient, messaging_type: 'RESPONSE', message: { text: request.text.slice(0, 2000) } } });
      }
      if (!last?.message_id) throw new ProviderError('provider.bad_request', { retryable: false });
      return { externalMessageId: String(last.message_id) };
    }
  });
}

module.exports = { createMessengerProvider, MESSENGER_SCOPES: SCOPES };
