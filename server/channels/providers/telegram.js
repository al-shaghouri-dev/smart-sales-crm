const crypto = require('crypto');
const { defineAdapter, ProviderError } = require('../adapter');
const { safeEqual } = require('../../webhooks/signatures');
const { safeFetch } = require('../../net/safe-fetch');

/**
 * Telegram Bot API adapter (official HTTPS API; bots are created by the customer with @BotFather).
 *
 * Connect:   POST /api/channels/telegram/connect { token }
 *            → getMe (validates the token) → channel stored with the token encrypted
 *            → setWebhook(PUBLIC_URL/webhooks/telegram/<channelId>, secret_token)
 * Webhooks:  Telegram sends X-Telegram-Bot-Api-Secret-Token. The secret is derived per channel:
 *            HMAC-SHA256(WEBHOOK_SECRET_KEY, "telegram|<channelId>") — nothing extra is stored and a
 *            leaked secret of one channel reveals nothing about another. Compared in constant time.
 * Events:    private-chat messages (text, photo, document, audio, voice, video, sticker, location).
 *            Group/channel posts and edits are ignored. Event key = <channelId>:<update_id>.
 * Media:     getFile → download from the official file endpoint through safeFetch (size-limited,
 *            SSRF-checked). Bots can download files up to 20 MB.
 * Sending:   sendMessage / sendPhoto / sendDocument. Telegram errors are mapped to stable codes:
 *            401 → provider.token_invalid (channel flagged), 403 → provider.recipient_blocked,
 *            429 → provider.rate_limited (retried), 5xx/network → retried, 400 → permanent.
 * The bot token appears only in request URLs to api.telegram.org; it is never logged or returned.
 */
const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DOWNLOAD = 20 * 1024 * 1024;

function webhookSecret(config, channelId) {
  if (!config.webhookSecretKey) throw new ProviderError('telegram.webhook_secret_missing', { retryable: false });
  return crypto.createHmac('sha256', String(config.webhookSecretKey)).update(`telegram|${channelId}`).digest('base64url');
}

function createTelegramProvider({ config: baseConfig = {}, fetchImpl = safeFetch } = {}) {
  const apiBase = () => (baseConfig.telegram?.apiBase || 'https://api.telegram.org');
  // A non-official base URL is only possible outside production (config.js), for local mock servers.
  const testMode = () => apiBase() !== 'https://api.telegram.org';
  const netOpts = extra => ({ allowHttp: testMode(), allowPrivate: testMode(), ...extra });

  function mapError(status, data) {
    const description = String(data?.description || '').toLowerCase();
    if (status === 401 || status === 404) return new ProviderError('provider.token_invalid', { retryable: false });
    if (status === 403) return new ProviderError('provider.recipient_blocked', { retryable: false });
    if (status === 429) return new ProviderError('provider.rate_limited', { retryable: true });
    if (status === 409) return new ProviderError('provider.conflict', { retryable: false });
    if (status >= 500 || !status) return new ProviderError('provider.unavailable', { retryable: true });
    if (/too big|too large/.test(description)) return new ProviderError('provider.media_too_large', { retryable: false });
    if (/chat not found|user not found/.test(description)) return new ProviderError('provider.recipient_blocked', { retryable: false });
    return new ProviderError('provider.bad_request', { retryable: false });
  }

  async function call(token, method, params, { multipart = false, timeoutMs = 20000 } = {}) {
    if (!TOKEN.test(String(token || ''))) throw new ProviderError('provider.token_invalid', { retryable: false });
    let body, headers;
    if (multipart) { body = params; } else { body = JSON.stringify(params || {}); headers = { 'Content-Type': 'application/json' }; }
    const res = await fetchImpl(`${apiBase()}/bot${token}/${method}`, netOpts({ method: 'POST', headers, body, timeoutMs, maxBytes: 1024 * 1024 }));
    const data = res.json();
    if (!res.ok || !data || data.ok !== true) throw mapError(res.status, data);
    return data.result;
  }

  async function download(token, fileId) {
    const file = await call(token, 'getFile', { file_id: fileId });
    if (!file?.file_path || (file.file_size && file.file_size > MAX_DOWNLOAD)) return null;
    if (!/^[A-Za-z0-9_./-]{1,300}$/.test(file.file_path) || file.file_path.includes('..')) return null;
    const res = await fetchImpl(`${apiBase()}/file/bot${token}/${file.file_path}`, netOpts({ maxBytes: MAX_DOWNLOAD, timeoutMs: 60000 }));
    if (!res.ok) throw mapError(res.status, null);
    return { buffer: res.body, name: file.file_path.split('/').pop() };
  }

  const webhookUrl = (config, channelId) => `${(config.publicUrl || config.appUrl || '').replace(/\/+$/, '')}/webhooks/telegram/${channelId}`;

  return defineAdapter({
    id: 'telegram',
    displayName: 'Telegram',
    capabilities: { inbound: true, outbound: true, media: true, templates: false, replyWindowHours: null, maxTextLength: 4096 },
    connectMode: 'form',
    connectFields: [{ name: 'token', type: 'secret', required: true }],

    async connect({ input }) {
      const token = String(input.token || '').trim();
      if (!TOKEN.test(token)) throw new ProviderError('provider.invalid_input', { retryable: false });
      const me = await call(token, 'getMe', {});
      if (!me?.is_bot || !me.id) throw new ProviderError('provider.invalid_input', { retryable: false });
      return {
        displayName: me.username ? `${me.first_name || me.username} (@${me.username})` : String(me.first_name || me.id),
        externalAccountId: String(me.id),
        externalMeta: { username: me.username || null },
        credentials: { token }
      };
    },

    async afterConnect({ channel, credentials, config }) {
      const url = webhookUrl(config, channel.id);
      if (config.isProd && !url.startsWith('https://')) throw new ProviderError('telegram.public_url_required', { retryable: false });
      await call(credentials.token, 'setWebhook', {
        url, secret_token: webhookSecret(config, channel.id), allowed_updates: ['message'], max_connections: 40, drop_pending_updates: false
      });
    },

    async disconnect({ credentials }) {
      await call(credentials.token, 'deleteWebhook', { drop_pending_updates: false });
    },

    async healthCheck({ channel, credentials, config }) {
      const me = await call(credentials.token, 'getMe', {});
      if (String(me.id) !== String(channel.external_account_id)) return { ok: false, code: 'provider.token_invalid' };
      const info = await call(credentials.token, 'getWebhookInfo', {});
      if (info.url !== webhookUrl(config, channel.id)) {
        // Someone (or another tool) changed the webhook: restore it.
        await call(credentials.token, 'setWebhook', { url: webhookUrl(config, channel.id), secret_token: webhookSecret(config, channel.id), allowed_updates: ['message'] });
        return { ok: true, code: 'telegram.webhook_restored' };
      }
      if (info.last_error_date && Date.now() / 1000 - info.last_error_date < 600) return { ok: false, code: 'telegram.webhook_errors' };
      return { ok: true };
    },

    verifyRequest({ headers, endpointKey, config }) {
      if (!UUID.test(String(endpointKey || ''))) return false;
      return safeEqual(String(headers['x-telegram-bot-api-secret-token'] || ''), webhookSecret(config, endpointKey.toLowerCase()));
    },

    parseEvents({ rawBody, endpointKey }) {
      let update;
      try { update = JSON.parse(rawBody.toString('utf8')); } catch { throw new ProviderError('webhook.bad_payload', { retryable: false, status: 400 }); }
      if (!update || !Number.isSafeInteger(update.update_id)) throw new ProviderError('webhook.bad_payload', { retryable: false, status: 400 });
      const type = update.message ? 'message' : Object.keys(update).find(k => k !== 'update_id') || 'unknown';
      return [{ eventKey: `${endpointKey.toLowerCase()}:${update.update_id}`, type, externalAccountId: endpointKey.toLowerCase(), payload: update }];
    },

    async processEvent(event, { messaging }) {
      const route = await messaging.routeById(event.endpoint_key);
      if (!route || route.provider !== 'telegram' || route.status === 'disconnected') return { status: 'ignored', reason: 'channel.not_found' };
      const m = event.payload.message;
      if (!m) return { status: 'ignored', reason: 'telegram.unsupported_update', companyId: route.company_id, channelId: route.channel_id };
      if (m.chat?.type !== 'private' || !m.from || m.from.is_bot) return { status: 'ignored', reason: 'telegram.not_private_chat', companyId: route.company_id, channelId: route.channel_id };

      let type = 'text';
      let body = m.text || m.caption || null;
      const attachments = [];
      const media = m.photo ? { id: m.photo[m.photo.length - 1].file_id, size: m.photo[m.photo.length - 1].file_size, kind: 'image', name: 'photo.jpg' }
        : m.document ? { id: m.document.file_id, size: m.document.file_size, kind: 'file', name: m.document.file_name }
          : m.audio ? { id: m.audio.file_id, size: m.audio.file_size, kind: 'audio', name: m.audio.file_name || 'audio' }
            : m.voice ? { id: m.voice.file_id, size: m.voice.file_size, kind: 'audio', name: 'voice.ogg' }
              : m.video ? { id: m.video.file_id, size: m.video.file_size, kind: 'video', name: m.video.file_name || 'video.mp4' }
                : m.sticker && !m.sticker.is_animated && !m.sticker.is_video ? { id: m.sticker.file_id, size: m.sticker.file_size, kind: 'sticker', name: 'sticker.webp' }
                  : null;
      if (media) {
        type = media.kind === 'image' ? 'image' : media.kind === 'audio' ? 'audio' : media.kind === 'video' ? 'video' : media.kind === 'sticker' ? 'sticker' : 'file';
        if (media.size && media.size > MAX_DOWNLOAD) {
          attachments.push({ id: crypto.randomUUID(), name: media.name, size: media.size, kind: 'file', omitted: 'too_large' });
        } else {
          const credentials = await messaging.getCredentials(route);
          try {
            const file = credentials ? await download(credentials.token, media.id) : null;
            const stored = file ? await messaging.storeInboundMedia(route.company_id, file.buffer, { name: media.name || file.name }) : null;
            if (stored) attachments.push(stored);
          } catch (error) {
            if (error.code === 'provider.token_invalid') await messaging.flagRoute(route, error.code);
            if (error.retryable !== false) throw error; // retry the whole event later
          }
        }
      } else if (m.location) {
        type = 'location';
        body = `${m.location.latitude},${m.location.longitude}`;
      } else if (m.sticker) {
        type = 'sticker'; body = m.sticker.emoji || null;
      } else if (!m.text) {
        type = 'unsupported';
      }

      const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ');
      await messaging.recordInbound(route, {
        externalUserId: String(m.chat.id), profile: { name, username: m.from.username }, externalMessageId: `${m.chat.id}:${m.message_id}`, // message ids are unique per chat only
        type, body, attachments, timestamp: m.date ? m.date * 1000 : undefined
      });
      return { status: 'processed', companyId: route.company_id, channelId: route.channel_id };
    },

    async sendMessage(request) {
      const token = request.credentials?.token;
      const chatId = request.to;
      const text = request.text || '';
      let last = null;
      const attachment = (request.attachments || [])[0];
      if (attachment) {
        const bytes = await attachment.read();
        if (!bytes) throw new ProviderError('provider.bad_request', { retryable: false });
        const form = new FormData();
        form.append('chat_id', String(chatId));
        const photo = attachment.kind === 'image' && /^image\/(png|jpeg|webp)$/.test(attachment.contentType) && bytes.length <= 10 * 1024 * 1024;
        form.append(photo ? 'photo' : 'document', new Blob([bytes], { type: attachment.contentType || 'application/octet-stream' }), attachment.name || 'file');
        if (text && text.length <= 1024) form.append('caption', text);
        last = await call(token, photo ? 'sendPhoto' : 'sendDocument', form, { multipart: true, timeoutMs: 60000 });
        if (text && text.length > 1024) last = await call(token, 'sendMessage', { chat_id: chatId, text });
      } else {
        last = await call(token, 'sendMessage', { chat_id: chatId, text });
      }
      return { externalMessageId: `${chatId}:${last.message_id}` };
    }
  });
}

module.exports = { createTelegramProvider, webhookSecret };
