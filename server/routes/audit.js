const express = require('express');
const { requireAuth, requireCompany, requirePermission } = require('../middleware/session');

module.exports = function auditRoutes({ db }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany, requirePermission('audit.view'));

  router.get('/', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before = Number(req.query.before) || null;
    const rows = await db.withContext({ companyId: req.company.id, userId: req.user.id }, trx => {
      const q = trx('audit_logs').where({ company_id: req.company.id }).orderBy('id', 'desc').limit(limit)
        .select('id', 'action', 'actor_email', 'entity_type', 'entity_id', 'before', 'after', 'ip', 'created_at');
      if (before) q.where('id', '<', before);
      return q;
    });
    res.json({ entries: rows.map(r => ({ ...r, id: Number(r.id) })) });
  });

  return router;
};
