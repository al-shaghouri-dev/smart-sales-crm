const express = require('express');
const v = require('../validate');
const { requireAuth, requirePlatformAdmin } = require('../middleware/session');
const { imageUpload } = require('../storage');
const { audit } = require('../services/audit');
const { badRequest } = require('../errors');

const publicBranding = s => ({
  appName: s.app_name, tagline: s.tagline, logoUrl: s.logo_url, faviconUrl: s.favicon_url,
  primaryColor: s.primary_color, secondaryColor: s.secondary_color, accentColor: s.accent_color,
  fontFamily: s.font_family, defaultTheme: s.default_theme, defaultLocale: s.default_locale,
  loginHeading: s.login_heading, loginSubheading: s.login_subheading,
  registrationHeading: s.registration_heading, registrationSubheading: s.registration_subheading,
  supportEmail: s.support_email, supportPhone: s.support_phone, websiteUrl: s.website_url,
  registrationEnabled: s.registration_enabled
});
const adminSettings = s => ({ ...publicBranding(s), expiredAccessPolicy: s.expired_access_policy });

/** Public, unauthenticated: global platform identity for login/registration pages. */
function publicRoutes({ db }) {
  const router = express.Router();
  router.get('/branding', async (_req, res) => {
    const s = await db.withContext({}, trx => trx('platform_settings').where({ id: 1 }).first());
    res.set('Cache-Control', 'no-cache');
    res.json(publicBranding(s));
  });
  return router;
}

/** Super Admin only. Platform context (RLS bypass) is enabled only inside these handlers. */
function platformRoutes(deps) {
  const { db, storage } = deps;
  const router = express.Router();
  router.use(requireAuth, requirePlatformAdmin);
  const platform = (req, fn) => db.withContext({ userId: req.user.id, platformAdmin: true }, fn);

  router.get('/settings', async (req, res) => {
    res.json(adminSettings(await platform(req, trx => trx('platform_settings').where({ id: 1 }).first())));
  });

  router.patch('/settings', async (req, res) => {
    const b = req.body || {};
    const patch = v.compact({
      app_name: v.str(b.appName, { field: 'appName', max: 60, min: 1 }) ?? undefined,
      tagline: v.localized(b.tagline, { field: 'tagline', max: 160 }),
      logo_url: v.url(b.logoUrl, { field: 'logoUrl' }),
      favicon_url: v.url(b.faviconUrl, { field: 'faviconUrl' }),
      primary_color: v.color(b.primaryColor, { field: 'primaryColor' }) ?? undefined,
      secondary_color: v.color(b.secondaryColor, { field: 'secondaryColor' }) ?? undefined,
      accent_color: v.color(b.accentColor, { field: 'accentColor' }) ?? undefined,
      font_family: v.oneOf(b.fontFamily, v.FONTS, { field: 'fontFamily' }) ?? undefined,
      default_theme: v.oneOf(b.defaultTheme, v.THEMES, { field: 'defaultTheme' }) ?? undefined,
      default_locale: v.oneOf(b.defaultLocale, v.LOCALES, { field: 'defaultLocale' }) ?? undefined,
      login_heading: v.localized(b.loginHeading, { field: 'loginHeading' }),
      login_subheading: v.localized(b.loginSubheading, { field: 'loginSubheading', max: 300 }),
      registration_heading: v.localized(b.registrationHeading, { field: 'registrationHeading' }),
      registration_subheading: v.localized(b.registrationSubheading, { field: 'registrationSubheading', max: 300 }),
      support_email: b.supportEmail === '' || b.supportEmail === null ? null : (b.supportEmail !== undefined ? v.email(b.supportEmail, { field: 'supportEmail' }) : undefined),
      support_phone: v.str(b.supportPhone, { field: 'supportPhone', max: 40 }),
      website_url: v.url(b.websiteUrl, { field: 'websiteUrl' }),
      expired_access_policy: v.oneOf(b.expiredAccessPolicy, ['read_only', 'block'], { field: 'expiredAccessPolicy' }) ?? undefined,
      registration_enabled: b.registrationEnabled === undefined ? undefined : Boolean(b.registrationEnabled)
    });
    for (const k of ['logo_url', 'favicon_url']) {
      if (patch[k] && patch[k].startsWith('/uploads/') && !patch[k].startsWith('/uploads/platform/')) throw badRequest('validation.url', 'Invalid URL', { field: k });
    }
    for (const k of ['tagline', 'login_heading', 'login_subheading', 'registration_heading', 'registration_subheading']) {
      if (patch[k] !== undefined) patch[k] = JSON.stringify(patch[k]);
    }
    const s = await platform(req, async trx => {
      const before = await trx('platform_settings').where({ id: 1 }).first();
      await trx('platform_settings').where({ id: 1 }).update({ ...patch, updated_by: req.user.id, updated_at: trx.fn.now() });
      const after = await trx('platform_settings').where({ id: 1 }).first();
      await audit(trx, req, { action: 'platform.settings_updated', entityType: 'platform_settings', entityId: 1, before: adminSettings(before), after: adminSettings(after) });
      return after;
    });
    deps.onPolicyChange?.();
    res.json(adminSettings(s));
  });

  router.post('/branding/:asset', imageUpload.single('file'), async (req, res) => {
    const asset = req.params.asset;
    if (!['logo', 'favicon'].includes(asset)) throw badRequest('validation.invalid', 'Unknown asset');
    const url = storage.saveImage(req.file, 'platform', { allowIco: asset === 'favicon' });
    const column = asset === 'logo' ? 'logo_url' : 'favicon_url';
    await platform(req, async trx => {
      await trx('platform_settings').where({ id: 1 }).update({ [column]: url, updated_by: req.user.id, updated_at: trx.fn.now() });
      await audit(trx, req, { action: `platform.${asset}_uploaded`, entityType: 'platform_settings', entityId: 1, after: { [column]: url } });
    });
    res.json({ ok: true, url });
  });

  router.use('/overview', require('./platform-overview')(deps));
  router.use('/companies', require('./platform-companies')(deps));
  router.use('/plans', require('./platform-plans')(deps));
  router.use('/registrations', require('./platform-registrations').registrationAdminRoutes(deps));
  router.use('/webhook-events', require('./platform-webhooks')(deps));
  router.use('/channels', require('./platform-channels')(deps));

  return router;
}

module.exports = { publicRoutes, platformRoutes, publicBranding };
