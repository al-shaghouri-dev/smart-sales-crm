const express = require('express');
const v = require('../validate');
const { requireAuth, requireCompany, requirePermission } = require('../middleware/session');
const { imageUpload } = require('../storage');
const { audit } = require('../services/audit');
const { requirePlanFeature } = require('../middleware/plan');

const CURRENCIES = ['USD', 'EUR', 'GBP', 'SAR', 'AED', 'EGP', 'KWD', 'QAR', 'BHD', 'OMR', 'JOD', 'IQD', 'SYP', 'LBP', 'TRY', 'MAD', 'DZD', 'TND'];

function serialize(company, settings, branding) {
  return {
    profile: {
      id: company.id, name: company.name, slug: company.slug, status: company.status, email: company.email,
      phone: company.phone, country: company.country, address: company.address, businessType: company.business_type,
      timezone: company.timezone, currency: company.currency, defaultLocale: company.default_locale, createdAt: company.created_at
    },
    settings: {
      taxRate: Number(settings.tax_rate), shippingFee: Number(settings.shipping_fee),
      autoReplyEnabled: settings.auto_reply_enabled, quickReplies: settings.quick_replies
    },
    branding: {
      displayName: branding.display_name, logoUrl: branding.logo_url,
      primaryColor: branding.primary_color, secondaryColor: branding.secondary_color, accentColor: branding.accent_color
    },
    currencies: CURRENCIES
  };
}

module.exports = function companyRoutes({ db, storage }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany);
  const tenant = (req, fn) => db.withContext({ companyId: req.company.id, userId: req.user.id }, fn);

  async function load(trx, companyId) {
    // Explicit company_id filters in addition to RLS (defence in depth).
    // Sequential on purpose: a transaction is a single connection (pg deprecates overlapping queries).
    const company = await trx('companies').where({ id: companyId }).first();
    const settings = await trx('company_settings').where({ company_id: companyId }).first();
    const branding = await trx('company_branding').where({ company_id: companyId }).first();
    return { company, settings, branding };
  }

  router.get('/', requirePermission('company.settings.view', 'company.settings.manage'), async (req, res) => {
    const data = await tenant(req, trx => load(trx, req.company.id));
    res.json(serialize(data.company, data.settings, data.branding));
  });

  router.patch('/', requirePermission('company.settings.manage'), async (req, res) => {
    const b = req.body || {};
    const companyPatch = v.compact({
      name: v.str(b.name, { field: 'name', max: 120, min: 1 }) ?? undefined,
      email: b.email === '' || b.email === null ? null : (b.email !== undefined ? v.email(b.email, { required: false }) : undefined),
      phone: v.str(b.phone, { field: 'phone', max: 40 }),
      country: v.str(b.country, { field: 'country', max: 80 }),
      address: v.str(b.address, { field: 'address', max: 300 }),
      business_type: v.str(b.businessType, { field: 'businessType', max: 120 }),
      timezone: v.timezone(b.timezone),
      currency: v.oneOf(b.currency, CURRENCIES, { field: 'currency' }) ?? undefined,
      default_locale: v.oneOf(b.defaultLocale, v.LOCALES, { field: 'defaultLocale' }) ?? undefined
    });
    let quickReplies;
    if (b.quickReplies !== undefined) {
      if (!Array.isArray(b.quickReplies)) throw require('../errors').badRequest('validation.invalid', 'quickReplies must be a list', { field: 'quickReplies' });
      quickReplies = b.quickReplies.map(x => v.str(x, { field: 'quickReplies', max: 1000 })).filter(Boolean).slice(0, 30);
    }
    const settingsPatch = v.compact({
      tax_rate: v.number(b.taxRate, { field: 'taxRate', max: 100 }),
      shipping_fee: v.number(b.shippingFee, { field: 'shippingFee', max: 1e7 }),
      auto_reply_enabled: b.autoReplyEnabled === undefined ? undefined : Boolean(b.autoReplyEnabled),
      quick_replies: quickReplies === undefined ? undefined : JSON.stringify(quickReplies)
    });

    const data = await tenant(req, async trx => {
      const before = await load(trx, req.company.id);
      if (Object.keys(companyPatch).length) await trx('companies').where({ id: req.company.id }).update({ ...companyPatch, updated_at: trx.fn.now() });
      if (Object.keys(settingsPatch).length) await trx('company_settings').where({ company_id: req.company.id }).update({ ...settingsPatch, updated_at: trx.fn.now() });
      const after = await load(trx, req.company.id);
      const s = x => serialize(x.company, x.settings, x.branding);
      await audit(trx, req, { action: 'company.settings_updated', companyId: req.company.id, entityType: 'company', entityId: req.company.id,
        before: { ...s(before).profile, ...s(before).settings }, after: { ...s(after).profile, ...s(after).settings } });
      return after;
    });
    res.json(serialize(data.company, data.settings, data.branding));
  });

  // Custom branding is a plan feature: every endpoint that changes branding is gated on the server.
  const brandingFeature = requirePlanFeature('branding.custom');

  router.patch('/branding', requirePermission('company.branding.manage'), brandingFeature, async (req, res) => {
    const b = req.body || {};
    const patch = v.compact({
      display_name: v.str(b.displayName, { field: 'displayName', max: 120 }),
      logo_url: v.url(b.logoUrl, { field: 'logoUrl' }),
      primary_color: v.color(b.primaryColor, { field: 'primaryColor' }),
      secondary_color: v.color(b.secondaryColor, { field: 'secondaryColor' }),
      accent_color: v.color(b.accentColor, { field: 'accentColor' })
    });
    // Company logos must live in this company's own upload folder (or an external https URL).
    if (patch.logo_url && patch.logo_url.startsWith('/uploads/') && !patch.logo_url.startsWith(`/uploads/companies/${req.company.id}/`)) {
      throw require('../errors').badRequest('validation.url', 'Invalid logo URL', { field: 'logoUrl' });
    }
    const data = await tenant(req, async trx => {
      const before = await trx('company_branding').where({ company_id: req.company.id }).first();
      await trx('company_branding').where({ company_id: req.company.id }).update({ ...patch, updated_at: trx.fn.now() });
      const after = await load(trx, req.company.id);
      await audit(trx, req, { action: 'company.branding_updated', companyId: req.company.id, entityType: 'company', entityId: req.company.id, before, after: after.branding });
      return after;
    });
    res.json(serialize(data.company, data.settings, data.branding));
  });

  router.post('/branding/logo', requirePermission('company.branding.manage'), brandingFeature, imageUpload.single('file'), async (req, res) => {
    const url = storage.saveImage(req.file, `companies/${req.company.id}`);
    await tenant(req, async trx => {
      await trx('company_branding').where({ company_id: req.company.id }).update({ logo_url: url, updated_at: trx.fn.now() });
      await audit(trx, req, { action: 'company.logo_uploaded', companyId: req.company.id, entityType: 'company', entityId: req.company.id, after: { logo_url: url } });
    });
    res.json({ ok: true, url });
  });

  return router;
};
