const express = require('express');
const v = require('../validate');
const { requireAuth, requireCompany, requirePermission } = require('../middleware/session');
const { AppError, conflict, notFound } = require('../errors');
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
          capabilities: a?.capabilities || null, connectFields: a ? providers.get(id).connectFields || [] : [],
          connectMode: a ? providers.get(id).connectMode || 'form' : null
        };
      })
    });
  });

  router.post('/:provider/connect', manage, async (req, res) => {
    const provider = String(req.params.provider);
    const adapter = providers.get(provider);
    if (!adapter || typeof adapter.connect !== 'function') throw notFound('channels.provider_unavailable', 'This channel type is not available');
    let account;
    try {
      account = await adapter.connect({ input: req.body || {}, config, companyId: req.company.id });
    } catch (error) { throw providerError(error); }
    const result = await tenant(req, async trx => {
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
