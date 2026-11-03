const express = require('express');
const v = require('../validate');
const { requireAuth } = require('../middleware/session');

/** The signed-in user's own profile and preferences (language, theme). */
module.exports = function meRoutes({ db }) {
  const router = express.Router();
  router.use(requireAuth);

  router.patch('/', async (req, res) => {
    const patch = v.compact({
      name: v.str(req.body?.name, { field: 'name', max: 120, min: 1 }),
      phone: v.str(req.body?.phone, { field: 'phone', max: 40 })
    });
    if (patch.name === null) delete patch.name;
    if (Object.keys(patch).length) {
      await db.withContext({ userId: req.user.id }, trx => trx('users').where({ id: req.user.id }).update(patch));
    }
    res.json({ ok: true });
  });

  // locale/theme = null means "follow the device".
  router.patch('/preferences', async (req, res) => {
    const patch = v.compact({
      locale: v.oneOf(req.body?.locale, v.LOCALES, { field: 'locale' }),
      theme: v.oneOf(req.body?.theme, v.THEMES, { field: 'theme' })
    });
    if (Object.keys(patch).length) {
      await db.withContext({ userId: req.user.id }, trx => trx('users').where({ id: req.user.id }).update(patch));
    }
    res.json({ ok: true, preferences: patch });
  });

  return router;
};
