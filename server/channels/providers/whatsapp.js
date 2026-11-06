const { defineAdapter, ProviderError } = require('../adapter');
const { createGraphClient, downloadMedia, verifyMetaSignature, handleMetaVerification, GRAPH_HOSTS } = require('../meta/core');

/**
 * WhatsApp Business Cloud API adapter (official Meta API only — no unofficial WhatsApp Web clients).
 *
 * Connect
 *  - Manual (available now): a business that already has a WhatsApp Business Account enters its
 *    Phone number ID, WABA ID and a permanent System User access token. The token is validated with
 *    GET /{phone-number-id} and stored encrypted; afterConnect subscribes the app to the WABA.
 *  - Embedded Signup (prepared, disabled): requires Meta Tech Provider status and META_WA_CONFIG_ID.
 *    POST /api/channels/whatsapp/embedded-signup { code, phoneNumberId, wabaId } exchanges the code
 *    for a business token. It refuses to run until the platform owner enables it.
 * Webhooks: object "whatsapp_business_account", signed with the app secret, routed by
 *   value.metadata.phone_number_id. Messages (text, image, document, audio, video, sticker,
 *   location, interactive/button replies) and statuses (sent, delivered, read, failed).
 * Media: GET /{media-id} → short-lived lookaside URL → download with the token (SSRF allow-list).
 * Sending: text and media (uploaded to /{phone-number-id}/media first). Outside the 24-hour customer
 *   service window only approved templates may be sent (enforced before queueing; templates are
 *   allowed when the window is closed).
 */
const MEDIA_TYPES = ['image', 'document', 'audio', 'video', 'sticker'];

function createWhatsAppProvider({ config }) {
  const m = config.meta || {};
  const testMode = m.graphBase !== 'https://graph.facebook.com';
  const graph = createGraphClient({ base: m.graphBase, version: m.graphVersion, appSecret: m.appSecret, hosts: GRAPH_HOSTS, testMode });

  async function describeNumber(token, phoneNumberId) {
    const n = await graph.get(String(phoneNumberId), { token, query: { fields: 'id,display_phone_number,verified_name,quality_rating' } });
    if (String(n.id) !== String(phoneNumberId)) throw new ProviderError('provider.invalid_input', { retryable: false });
    return n;
  }

  const account = (n, wabaId, token, extra = {}) => ({
    displayName: `${n.verified_name || 'WhatsApp'} (${n.display_phone_number || n.id})`.slice(0, 120),
    externalAccountId: String(n.id),
    externalMeta: { wabaId: String(wabaId), phone: n.display_phone_number || null, qualityRating: n.quality_rating || null, ...extra },
    credentials: { accessToken: token }
  });

  return defineAdapter({
    id: 'whatsapp',
    displayName: 'WhatsApp',
    capabilities: { inbound: true, outbound: true, media: true, templates: true, replyWindowHours: 24, maxTextLength: 4096 },
    connectMode: 'form',
    connectFields: [
      { name: 'phoneNumberId', type: 'text', required: true },
      { name: 'wabaId', type: 'text', required: true },
      { name: 'accessToken', type: 'secret', required: true }
    ],
    embeddedSignupEnabled: () => Boolean(m.waConfigId && m.appId && m.appSecret),

    async connect({ input }) {
      const phoneNumberId = String(input.phoneNumberId || '').trim();
      const wabaId = String(input.wabaId || '').trim();
      const token = String(input.accessToken || '').trim();
      if (!/^\d{5,25}$/.test(phoneNumberId) || !/^\d{5,25}$/.test(wabaId) || !/^[A-Za-z0-9_-]{20,600}$/.test(token)) throw new ProviderError('provider.invalid_input', { retryable: false });
      return account(await describeNumber(token, phoneNumberId), wabaId, token);
    },

    /** Embedded Signup (Tech Provider only): exchange the code from the FB JS SDK flow. */
    async embeddedSignup({ code, phoneNumberId, wabaId }) {
      if (!this.embeddedSignupEnabled()) throw new ProviderError('whatsapp.embedded_signup_disabled', { retryable: false });
      if (!/^\d{5,25}$/.test(String(phoneNumberId)) || !/^\d{5,25}$/.test(String(wabaId)) || !/^[A-Za-z0-9_.-]{10,1000}$/.test(String(code))) throw new ProviderError('provider.invalid_input', { retryable: false });
      const t = await graph.get('oauth/access_token', { query: { client_id: m.appId, client_secret: m.appSecret, code } });
      return account(await describeNumber(t.access_token, phoneNumberId), wabaId, t.access_token, { embeddedSignup: true });
    },

    async afterConnect({ channel, credentials }) {
      await graph.post(`${channel.external_meta.wabaId}/subscribed_apps`, { token: credentials.accessToken });
    },

    async disconnect({ channel, credentials }) {
      await graph.del(`${channel.external_meta.wabaId}/subscribed_apps`, { token: credentials.accessToken });
    },

    async healthCheck({ channel, credentials }) {
      const n = await describeNumber(credentials.accessToken, channel.external_account_id);
      return { ok: true, code: n.quality_rating === 'RED' ? 'whatsapp.quality_low' : null };
    },

    async listTemplates({ channel, credentials }) {
      const r = await graph.get(`${channel.external_meta.wabaId}/message_templates`, { token: credentials.accessToken, query: { status: 'APPROVED', limit: 200, fields: 'name,language,status,category,components' } });
      return (r.data || []).filter(t => t.status === 'APPROVED').map(t => ({
        name: t.name, language: t.language, category: t.category,
        body: (t.components || []).find(c => c.type === 'BODY')?.text || '',
        params: ((t.components || []).find(c => c.type === 'BODY')?.text || '').match(/\{\{\d+\}\}/g)?.length || 0
      }));
    },

    verifyRequest({ rawBody, headers }) { return verifyMetaSignature(rawBody, headers, m.appSecret); },
    handleVerification({ query }) { return handleMetaVerification(query, m.verifyToken); },

    parseEvents({ rawBody }) {
      let body;
      try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new ProviderError('webhook.bad_payload', { retryable: false, status: 400 }); }
      if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) throw new ProviderError('webhook.bad_payload', { retryable: false, status: 400 });
      const events = [];
      for (const entry of body.entry.slice(0, 100)) {
        for (const change of (entry.changes || []).slice(0, 100)) {
          const v = change.value || {};
          const phoneId = v.metadata?.phone_number_id ? String(v.metadata.phone_number_id) : null;
          if (change.field !== 'messages' || !phoneId) {
            events.push({ eventKey: `${entry.id}:${change.field}:${JSON.stringify(v).length}:${entry.time || ''}`, type: change.field || 'other', externalAccountId: phoneId, payload: { field: change.field, value: v } });
            continue;
          }
          for (const msg of (v.messages || []).slice(0, 100)) {
            const contact = (v.contacts || []).find(c => c.wa_id === msg.from);
            events.push({ eventKey: `msg:${msg.id}`, type: 'message', externalAccountId: phoneId, payload: { message: msg, profile: contact?.profile || null } });
          }
          for (const st of (v.statuses || []).slice(0, 100)) {
            events.push({ eventKey: `status:${st.id}:${st.status}`, type: 'status', externalAccountId: phoneId, payload: { status: st } });
          }
        }
      }
      return events;
    },

    async processEvent(event, { messaging }) {
      const route = await messaging.routeByAccount('whatsapp', event.external_account_id);
      if (!route) return { status: 'ignored', reason: 'channel.not_found' };
      const base = { companyId: route.company_id, channelId: route.channel_id };
      if (event.event_type === 'status') {
        const st = event.payload.status;
        const code = st.errors?.[0]?.code;
        const mapped = code ? require('../meta/core').mapGraphError(400, { code }).code : null;
        const r = await messaging.recordStatus(route, { externalMessageId: st.id, status: st.status, at: st.timestamp ? Number(st.timestamp) * 1000 : undefined, errorCode: mapped });
        // A receipt can arrive before our send transaction stored the wamid: retry the event later.
        if (!r && ['sent', 'delivered', 'read'].includes(st.status) && event.attempts < 3) throw new ProviderError('whatsapp.status_before_send');
        return r ? { status: 'processed', ...base } : { status: 'ignored', reason: 'status.unknown_message', ...base };
      }
      if (event.event_type !== 'message') return { status: 'ignored', reason: `whatsapp.${event.event_type}`, ...base };

      const msg = event.payload.message;
      let type = 'text', body = null;
      const attachments = [];
      if (msg.type === 'text') body = msg.text?.body || null;
      else if (MEDIA_TYPES.includes(msg.type)) {
        const media = msg[msg.type] || {};
        body = media.caption || null;
        type = msg.type === 'document' ? 'file' : msg.type;
        const credentials = await messaging.getCredentials(route);
        try {
          const info = await graph.get(String(media.id), { token: credentials.accessToken });
          if (info.file_size && info.file_size > 20 * 1024 * 1024) {
            attachments.push({ id: require('crypto').randomUUID(), name: media.filename || msg.type, size: info.file_size, kind: 'file', omitted: 'too_large' });
          } else {
            const bytes = await downloadMedia(info.url, { token: credentials.accessToken, testMode });
            const stored = await messaging.storeInboundMedia(route.company_id, bytes, { name: media.filename || `${msg.type}` });
            if (stored) attachments.push(stored);
          }
        } catch (error) {
          if (error.code === 'provider.token_invalid' || error.code === 'provider.token_expired') await messaging.flagRoute(route, error.code);
          if (error.retryable !== false) throw error;
        }
      } else if (msg.type === 'location') { type = 'location'; body = `${msg.location?.latitude},${msg.location?.longitude}`; }
      else if (msg.type === 'button') body = msg.button?.text || null;
      else if (msg.type === 'interactive') body = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || null;
      else type = 'unsupported';

      await messaging.recordInbound(route, {
        externalUserId: String(msg.from), profile: { name: event.payload.profile?.name || null },
        externalMessageId: msg.id, type, body, attachments, timestamp: msg.timestamp ? Number(msg.timestamp) * 1000 : undefined
      });
      // WhatsApp identities are phone numbers: keep the number on the contact for search.
      return { status: 'processed', ...base };
    },

    async sendMessage(request) {
      const token = request.credentials?.accessToken;
      const phoneId = request.channel.externalAccountId;
      const to = request.to;
      let last;
      if (request.template) {
        const t = request.template;
        last = await graph.post(`${phoneId}/messages`, { token, json: {
          messaging_product: 'whatsapp', to, type: 'template',
          template: { name: t.name, language: { code: t.language }, components: t.params?.length ? [{ type: 'body', parameters: t.params.map(text => ({ type: 'text', text: String(text) })) }] : undefined }
        } });
        return { externalMessageId: String(last.messages?.[0]?.id || '') };
      }
      for (const a of (request.attachments || []).slice(0, 1)) {
        const bytes = await a.read();
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', a.contentType || 'application/octet-stream');
        form.append('file', new Blob([bytes], { type: a.contentType || 'application/octet-stream' }), a.name || 'file');
        const up = await graph.post(`${phoneId}/media`, { token, multipart: form, timeoutMs: 60000 });
        const kind = a.kind === 'image' && /^image\/(png|jpeg)$/.test(a.contentType) ? 'image' : a.kind === 'audio' ? 'audio' : a.kind === 'video' ? 'video' : 'document';
        const payload = { id: up.id };
        if (kind !== 'audio' && request.text && request.text.length <= 1024) payload.caption = request.text;
        if (kind === 'document') payload.filename = a.name || 'file';
        last = await graph.post(`${phoneId}/messages`, { token, json: { messaging_product: 'whatsapp', to, type: kind, [kind]: payload } });
        if (payload.caption) return { externalMessageId: String(last.messages?.[0]?.id || '') };
      }
      if (request.text) last = await graph.post(`${phoneId}/messages`, { token, json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: request.text.slice(0, 4096), preview_url: false } } });
      const id = last?.messages?.[0]?.id;
      if (!id) throw new ProviderError('provider.bad_request', { retryable: false });
      return { externalMessageId: String(id) };
    }
  });
}

module.exports = { createWhatsAppProvider };
