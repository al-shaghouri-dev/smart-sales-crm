const express = require('express');
const crypto = require('crypto');
const { parseSignedRequest } = require('../channels/meta/core');
const { flagChannel, disconnectChannel } = require('../services/channels');

/**
 * Meta platform callbacks required for App Review (no session; authenticated by signed_request):
 *
 *   POST /api/public/meta/:provider/deauthorize    a user removed the app → affected channels are
 *        flagged "needs_reconnect" and their stored tokens deleted.
 *   POST /api/public/meta/:provider/data-deletion  a user asked Meta to delete their data → affected
 *        channels are disconnected and tokens deleted; responds { url, confirmation_code }.
 *   GET  /api/public/meta/deletion-status/:code    human-readable status page for that request.
 *
 * provider: messenger | whatsapp (Facebook app secret) or instagram (Instagram app secret).
 * Lookups use a narrow SECURITY DEFINER function; changes run in each company's own context.
 */
module.exports = function metaCallbackRoutes({ db, config }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '16kb' }));
  const secretFor = provider => (provider === 'instagram' ? (config.meta?.igAppSecret || config.meta?.appSecret) : config.meta?.appSecret);
  const PROVIDERS = ['messenger', 'instagram', 'whatsapp'];

  async function affectedChannels(provider, userId) {
    const r = await db.knex.raw('SELECT * FROM app_channels_for_meta_user(?, ?)', [provider, String(userId)]);
    return r.rows;
  }

  function verify(req) {
    const provider = String(req.params.provider);
    if (!PROVIDERS.includes(provider)) return null;
    const data = parseSignedRequest(req.body?.signed_request, secretFor(provider));
    return data && data.user_id ? { provider, userId: String(data.user_id) } : null;
  }

  router.post('/:provider/deauthorize', async (req, res) => {
    const v = verify(req);
    if (!v) return res.status(400).json({ ok: false });
    for (const ch of await affectedChannels(v.provider, v.userId)) {
      await db.withContext({ companyId: ch.company_id, system: true }, async trx => {
        await flagChannel(trx, { id: ch.channel_id, company_id: ch.company_id }, { status: 'needs_reconnect', error: 'meta.deauthorized' });
        await trx('channel_credentials').where({ channel_id: ch.channel_id, company_id: ch.company_id }).del();
      });
    }
    res.json({ ok: true });
  });

  router.post('/:provider/data-deletion', async (req, res) => {
    const v = verify(req);
    if (!v) return res.status(400).json({ ok: false });
    const channels = await affectedChannels(v.provider, v.userId);
    for (const ch of channels) {
      await db.withContext({ companyId: ch.company_id, system: true }, trx => disconnectChannel(trx, ch.company_id, ch.channel_id).catch(() => {}));
    }
    const code = crypto.randomBytes(12).toString('hex');
    await db.withContext({ system: true }, trx => trx('meta_data_deletions').insert({ code, provider: v.provider, status: 'completed', channels_affected: channels.length }));
    res.json({ url: `${config.publicUrl || config.appUrl}/api/public/meta/deletion-status/${code}`, confirmation_code: code });
  });

  router.get('/deletion-status/:code', async (req, res) => {
    const code = String(req.params.code);
    const row = /^[0-9a-f]{24}$/.test(code) ? await db.withContext({ system: true }, trx => trx('meta_data_deletions').where({ code }).first()) : null;
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!row) return res.status(404).send('<!doctype html><meta charset="utf-8"><title>Not found</title><p>Unknown confirmation code.</p>');
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Data deletion status</title>
<main style="font-family:system-ui;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.6">
<h1>Data deletion request</h1><p>Confirmation code: <code>${code}</code></p>
<p>Status: <strong>${row.status === 'completed' ? 'Completed' : 'In progress'}</strong> (${new Date(row.created_at).toISOString().slice(0, 10)}).</p>
<p>Access tokens for the connected accounts were deleted and the connections were removed.</p>
<hr><h2 dir="rtl">طلب حذف البيانات</h2><p dir="rtl">الحالة: <strong>${row.status === 'completed' ? 'مكتمل' : 'قيد التنفيذ'}</strong>. حُذفت رموز الوصول للحسابات المرتبطة وأُزيل الربط.</p></main>`);
  });

  return router;
};
