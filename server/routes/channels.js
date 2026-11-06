const express = require('express');
const crypto = require('crypto');
const v = require('../validate');
const { requireAuth, requireCompany, requirePermission } = require('../middleware/session');
const { AppError, badRequest, conflict, forbidden, notFound } = require('../errors');
const { parseCookies } = require('../middleware/session');
const { audit } = require('../services/audit');
const { connectChannel, disconnectChannel, readCredentials, flagChannel, channelOut, usage, providerAllowed, planFor, KNOWN_PROVIDERS } = require('../services/channels');
const { ProviderError } = require('../channels/adapter');

/**
 * Company channel management.
 *
 *   GET    /api/channels                  list (managers see operational details; inbox users see names)
 *   GET    /api/channels/providers        enabled providers + plan allowance + usage
 *   POST   /api/channels/:provider/connect   provider-specific input (e.g. Telegram bot token) →
 *          adapter.connect() validates it with the provider, then the channel is stored with
 *          encrypted credentials and adapter.afterConnect() registers webhooks (same transaction:
 *          a failed webhook registration leaves nothing behind)
 *   POST   /api/channels/:id/test         adapter.healthCheck() with the stored credentials
 *   DELETE /api/channels/:id              disconnect: adapter.disconnect() (best effort), stop
 *                                         routing, delete stored credentials, keep history
 *
 * Secrets submitted here are never echoed back, logged or audited.
 */
module.exports = function channelRoutes({ db, config, providers }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany);
  const tenant = (req, fn) => db.withContext({ companyId: req.company.id, userId: req.user.id }, fn);
  const manage = requirePermission('channels.manage');
  /** Provider rejections (bad token, missing permission) → 400; provider outages → 502. Codes only. */
  const providerError = error => {
    if (error instanceof ProviderError || error?.name === 'ProviderError') {
      return new AppError(error.retryable === false ? 400 : 502, error.code, 'The channel provider rejected the request');
    }
    return error;
  };

  router.get('/', requirePermission('channels.manage', 'conversations.view_all', 'conversations.view_assigned'), async (req, res) => {
    const detailed = req.permissions.has('channels.manage');
    const rows = await tenant(req, trx => {
      const q = trx('channels').where({ company_id: req.company.id }).orderBy('created_at');
      if (!detailed || req.query.all !== 'true') q.whereNot('status', 'disconnected');
      return q;
    });
    const creds = detailed ? await tenant(req, trx => trx('channel_credentials').where({ company_id: req.company.id }).select('channel_id', 'expires_at', 'scopes')) : [];
    res.json({
      channels: rows.map(c => {
        const o = channelOut(c, { detailed });
        if (detailed) {
          const cr = creds.find(x => x.channel_id === c.id);
          o.tokenExpiresAt = cr?.expires_at || null;
          o.tokenExpiringSoon = Boolean(cr?.expires_at && new Date(cr.expires_at).getTime() - Date.now() < 7 * 86400 * 1000);
          o.providerEnabled = providers.has(c.provider);
        }
        return o;
      })
    });
  });

  router.get('/providers', manage, async (req, res) => {
    const data = await tenant(req, async trx => ({ usage: await usage(trx, req.company.id), plan: await planFor(trx, req.company.id) }));
    const enabled = providers.list();
    const all = [...new Set([...KNOWN_PROVIDERS, ...enabled.map(p => p.id)])];
    res.json({
      usage: data.usage,
      providers: all.map(id => {
        const a = enabled.find(p => p.id === id);
        return {
          id, enabled: Boolean(a), allowedByPlan: providerAllowed(data.plan, id),
          embeddedSignup: Boolean(a && providers.get(id).embeddedSignupEnabled?.()),
          capabilities: a?.capabilities || null, connectFields: a ? providers.get(id).connectFields || [] : [],
          connectMode: a ? providers.get(id).connectMode || 'form' : null
        };
      })
    });
  });

  /** Create the channel, register webhooks (same transaction) and audit. Shared by form and OAuth connects. */
  async function finishConnect(req, provider, adapter, account) {
    return tenant(req, async trx => {
      const { channel, reconnected } = await connectChannel(trx, config.keyRing, {
        companyId: req.company.id, provider, displayName: String(account.displayName || provider).slice(0, 120),
        externalAccountId: account.externalAccountId, externalMeta: account.externalMeta || {},
        credentials: account.credentials, scopes: account.scopes, expiresAt: account.expiresAt, connectedBy: req.user.id
      });
      if (adapter.afterConnect) {
        try { await adapter.afterConnect({ channel, credentials: account.credentials, config }); } catch (error) { throw providerError(error); }
      }
      await trx('channels').where({ id: channel.id }).update({ last_health_check_at: new Date() });
      await audit(trx, req, { action: reconnected ? 'channel.reconnected' : 'channel.connected', companyId: req.company.id, entityType: 'channel', entityId: channel.id,
        after: { provider, displayName: channel.display_name, externalAccountId: channel.external_account_id } });
      return { channel: await trx('channels').where({ id: channel.id }).first(), reconnected };
    });
  }

  // ---------------------------------------------------------------- OAuth (Messenger, Instagram)
  // State = signed { company, user, provider, nonce, expiry }; the nonce is also kept in an httpOnly
  // cookie, so a callback only completes in the browser (and session) that started it.
  const OAUTH_COOKIE = 'sscrm_oauth';
  const signState = data => {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return `${payload}.${crypto.createHmac('sha256', String(config.webhookSecretKey)).update(`oauth|${payload}`).digest('base64url')}`;
  };
  function readState(state) {
    const [payload, sig] = String(state || '').split('.');
    if (!payload || !sig || !config.webhookSecretKey) return null;
    const expected = crypto.createHmac('sha256', String(config.webhookSecretKey)).update(`oauth|${payload}`).digest('base64url');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try { const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return d.e > Date.now() ? d : null; } catch { return null; }
  }

  router.get('/:provider/oauth/start', manage, async (req, res) => {
    const adapter = providers.get(String(req.params.provider));
    if (!adapter?.oauthStart) throw notFound('channels.provider_unavailable', 'This channel type is not available');
    if (!providerAllowed(await tenant(req, trx => planFor(trx, req.company.id)), adapter.id)) throw forbidden('channels.provider_not_allowed', 'Your plan does not include this channel type');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const state = signState({ c: req.company.id, u: req.user.id, p: adapter.id, n: nonce, e: Date.now() + 10 * 60 * 1000 });
    let url;
    try { url = adapter.oauthStart({ state, config }); } catch (error) { throw providerError(error); }
    res.cookie(OAUTH_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/api/channels/oauth', maxAge: 10 * 60 * 1000 });
    res.redirect(302, url);
  });

  router.get('/oauth/callback/:provider', manage, async (req, res) => {
    const adapter = providers.get(String(req.params.provider));
    const back = (q) => res.redirect(302, `/channels?${new URLSearchParams(q).toString()}`);
    const state = readState(req.query.state);
    const nonce = parseCookies(req.headers.cookie)[OAUTH_COOKIE];
    res.clearCookie(OAUTH_COOKIE, { path: '/api/channels/oauth' });
    if (!adapter?.oauthCallback || !state || state.p !== adapter.id || state.c !== req.company.id || state.u !== req.user.id || !nonce || nonce !== state.n) {
      return back({ oauth_error: 'channels.oauth_invalid_state' });
    }
    if (req.query.error || !req.query.code) return back({ oauth_error: 'channels.oauth_cancelled' });
    let result;
    try { result = await adapter.oauthCallback({ code: String(req.query.code).slice(0, 2000), config }); } catch (error) {
      return back({ oauth_error: error.code && /^[a-z_]+\.[a-z_]+$/.test(error.code) ? error.code : 'provider.unavailable' });
    }
    if (!result.accounts?.length) return back({ oauth_error: 'channels.oauth_no_accounts' });
    const id = await tenant(req, async trx => {
      await trx('channel_oauth_sessions').where('expires_at', '<', new Date()).del();
      const ring = config.keyRing;
      if (!ring) throw new AppError(503, 'channels.encryption_unavailable', 'Credential encryption is not configured on the server');
      const sessionId = crypto.randomUUID();
      const ciphertext = ring.encrypt(JSON.stringify(result.accounts), { purpose: 'oauth_session', companyId: req.company.id, channelId: sessionId });
      await trx('channel_oauth_sessions').insert({
        id: sessionId, company_id: req.company.id, user_id: req.user.id, provider: adapter.id, ciphertext,
        accounts: JSON.stringify(result.accounts.map(a => ({ externalAccountId: a.externalAccountId, displayName: a.displayName }))),
        expires_at: new Date(Date.now() + 15 * 60 * 1000)
      });
      return sessionId;
    });
    back({ oauth: id });
  });

  router.get('/oauth/sessions/:id', manage, async (req, res) => {
    const row = await tenant(req, trx => trx('channel_oauth_sessions').where({ id: v.uuid(req.params.id) }).where('expires_at', '>', new Date()).first('id', 'provider', 'accounts'));
    if (!row) throw notFound('channels.oauth_expired', 'This connection request expired. Start again.');
    res.json({ session: { id: row.id, provider: row.provider, accounts: row.accounts } });
  });

  router.post('/oauth/sessions/:id/connect', manage, async (req, res) => {
    const id = v.uuid(req.params.id);
    const externalAccountId = v.str(req.body?.externalAccountId, { field: 'externalAccountId', required: true, max: 64 });
    const row = await tenant(req, trx => trx('channel_oauth_sessions').where({ id }).where('expires_at', '>', new Date()).first());
    if (!row) throw notFound('channels.oauth_expired', 'This connection request expired. Start again.');
    const accounts = JSON.parse(config.keyRing.decrypt(row.ciphertext, { purpose: 'oauth_session', companyId: req.company.id, channelId: id }));
    const account = accounts.find(a => a.externalAccountId === externalAccountId);
    if (!account) throw badRequest('validation.invalid', 'Unknown account', { field: 'externalAccountId' });
    const adapter = providers.get(row.provider);
    if (!adapter) throw notFound('channels.provider_unavailable', 'This channel type is not available');
    const result = await finishConnect(req, row.provider, adapter, account);
    res.status(result.reconnected ? 200 : 201).json({ channel: channelOut(result.channel, { detailed: true }), reconnected: result.reconnected });
  });

  // ---------------------------------------------------------------- WhatsApp Embedded Signup (disabled until Tech Provider)
  router.post('/whatsapp/embedded-signup', manage, async (req, res) => {
    const adapter = providers.get('whatsapp');
    if (!adapter?.embeddedSignupEnabled?.()) throw notFound('channels.provider_unavailable', 'Embedded Signup is not enabled on this platform');
    let account;
    try { account = await adapter.embeddedSignup({ code: req.body?.code, phoneNumberId: req.body?.phoneNumberId, wabaId: req.body?.wabaId }); } catch (error) { throw providerError(error); }
    const result = await finishConnect(req, 'whatsapp', adapter, account);
    res.status(result.reconnected ? 200 : 201).json({ channel: channelOut(result.channel, { detailed: true }), reconnected: result.reconnected });
  });

  /** Approved message templates of a channel (WhatsApp). */
  router.get('/:id/templates', requirePermission('conversations.reply', 'channels.manage'), async (req, res) => {
    const id = v.uuid(req.params.id);
    const { channel, credentials } = await tenant(req, async trx => {
      const ch = await trx('channels').where({ id, company_id: req.company.id, status: 'active' }).first();
      if (!ch) throw notFound('channels.not_found', 'Channel not found');
      return { channel: ch, credentials: await readCredentials(trx, config.keyRing, ch) };
    });
    const adapter = providers.get(channel.provider);
    if (!adapter?.listTemplates) return res.json({ templates: [] });
    try { res.json({ templates: await adapter.listTemplates({ channel, credentials, config }) }); } catch (error) { throw providerError(error); }
  });

  router.post('/:provider/connect', manage, async (req, res) => {
    const provider = String(req.params.provider);
    const adapter = providers.get(provider);
    if (!adapter || typeof adapter.connect !== 'function') throw notFound('channels.provider_unavailable', 'This channel type is not available');
    let account;
    try {
      account = await adapter.connect({ input: req.body || {}, config, companyId: req.company.id });
    } catch (error) { throw providerError(error); }
    const result = await finishConnect(req, provider, adapter, account);
    res.status(result.reconnected ? 200 : 201).json({ channel: channelOut(result.channel, { detailed: true }), reconnected: result.reconnected });
  });

  router.post('/:id/test', manage, async (req, res) => {
    const id = v.uuid(req.params.id);
    const { channel, credentials } = await tenant(req, async trx => {
      const ch = await trx('channels').where({ id, company_id: req.company.id }).whereNot('status', 'disconnected').first();
      if (!ch) throw notFound('channels.not_found', 'Channel not found');
      let creds = null;
      try { creds = await readCredentials(trx, config.keyRing, ch); } catch { creds = null; }
      return { channel: ch, credentials: creds };
    });
    const adapter = providers.get(channel.provider);
    let ok = false, code = null;
    if (!adapter) code = 'provider.not_enabled';
    else if (!credentials && channel.provider !== 'fake') code = 'channel.credentials_unreadable';
    else if (!adapter.healthCheck) ok = true;
    else {
      try { const r = await adapter.healthCheck({ channel, credentials, config }); ok = r?.ok !== false; code = r?.code || null; } catch (error) {
        code = error.code || 'provider.network_error';
      }
    }
    const row = await tenant(req, async trx => {
      if (ok) {
        await trx('channels').where({ id }).update({ status: 'active', last_health_check_at: new Date(), last_error: null, last_error_at: null, updated_at: new Date() });
      } else {
        await trx('channels').where({ id }).update({ last_health_check_at: new Date() });
        await flagChannel(trx, channel, { status: /token|credentials|unauthorized|permission/.test(code || '') ? 'needs_reconnect' : 'error', error: code });
      }
      return trx('channels').where({ id }).first();
    });
    res.json({ ok, code, channel: channelOut(row, { detailed: true }) });
  });

  router.delete('/:id', manage, async (req, res) => {
    const id = v.uuid(req.params.id);
    const pre = await tenant(req, async trx => {
      const ch = await trx('channels').where({ id, company_id: req.company.id }).whereNot('status', 'disconnected').first();
      if (!ch) throw notFound('channels.not_found', 'Channel not found');
      let creds = null;
      try { creds = await readCredentials(trx, config.keyRing, ch); } catch { creds = null; }
      return { channel: ch, credentials: creds };
    });
    const adapter = providers.get(pre.channel.provider);
    if (adapter?.disconnect && pre.credentials) {
      // Best effort: the channel is disconnected locally even if the provider is unreachable.
      await adapter.disconnect({ channel: pre.channel, credentials: pre.credentials, config }).catch(() => {});
    }
    const channel = await tenant(req, async trx => {
      const ch = await disconnectChannel(trx, req.company.id, id);
      await audit(trx, req, { action: 'channel.disconnected', companyId: req.company.id, entityType: 'channel', entityId: id, before: { provider: ch.provider, displayName: ch.display_name } });
      return ch;
    });
    res.json({ channel: channelOut(channel, { detailed: true }) });
  });

  // Rename (display name only).
  router.patch('/:id', manage, async (req, res) => {
    const id = v.uuid(req.params.id);
    const displayName = v.str(req.body?.displayName, { field: 'displayName', max: 120, min: 1, required: true });
    const row = await tenant(req, async trx => {
      const [ch] = await trx('channels').where({ id, company_id: req.company.id }).whereNot('status', 'disconnected').update({ display_name: displayName, updated_at: new Date() }).returning('*');
      if (!ch) throw notFound('channels.not_found', 'Channel not found');
      return ch;
    });
    res.json({ channel: channelOut(row, { detailed: true }) });
  });

  router.use((error, _req, _res, next) => {
    if (error.code === '23505') return next(conflict('channels.account_in_use', 'This account is already connected to another workspace'));
    next(error);
  });

  return router;
};
