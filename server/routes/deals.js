const express = require('express');
const v = require('../validate');
const { requireAuth, requireCompany, requirePermission } = require('../middleware/session');
const { badRequest, conflict, notFound } = require('../errors');

/** Default pipeline, created per company on first use (in the company's language). */
const DEFAULT_STAGES = {
  en: [['New lead', 'open'], ['Contacted', 'open'], ['Proposal sent', 'open'], ['Negotiation', 'open'], ['Won', 'won'], ['Lost', 'lost']],
  ar: [['عميل محتمل جديد', 'open'], ['تم التواصل', 'open'], ['عرض سعر', 'open'], ['تفاوض', 'open'], ['تم البيع', 'won'], ['خسارة', 'lost']]
};

async function ensureStages(trx, company) {
  const existing = await trx('pipeline_stages').where({ company_id: company.id }).orderBy('position');
  if (existing.length) return existing;
  const rows = (DEFAULT_STAGES[company.default_locale] || DEFAULT_STAGES.en).map(([name, kind], i) => ({ company_id: company.id, name, kind, position: i }));
  // Serialise concurrent first loads for the same company.
  await trx.raw('SELECT pg_advisory_xact_lock(727006, hashtext(?))', [company.id]);
  const again = await trx('pipeline_stages').where({ company_id: company.id }).orderBy('position');
  if (again.length) return again;
  return trx('pipeline_stages').insert(rows).returning('*');
}

const stageOut = s => ({ id: s.id, name: s.name, kind: s.kind, position: s.position });
const dealOut = d => ({
  id: d.id, title: d.title, value: Number(d.value), currency: d.currency, stageId: d.stage_id, status: d.status,
  contactId: d.contact_id, contactName: d.contact_name || null, ownerMembershipId: d.owner_membership_id, ownerName: d.owner_name || null,
  expectedClose: d.expected_close ? (d.expected_close instanceof Date ? d.expected_close.toISOString().slice(0, 10) : String(d.expected_close).slice(0, 10)) : null,
  closedAt: d.closed_at, position: Number(d.position), createdAt: d.created_at, updatedAt: d.updated_at
});

/**
 * Sales pipeline. View: customers.view|manage · change: customers.manage.
 */
module.exports = function dealRoutes({ db }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany);
  const tenant = (req, fn) => db.withContext({ companyId: req.company.id, userId: req.user.id }, fn);
  const canView = requirePermission('customers.view', 'customers.manage');
  const canManage = requirePermission('customers.manage');

  const dealQuery = (trx, req) => trx('deals as d')
    .leftJoin('contacts as c', 'c.id', 'd.contact_id')
    .leftJoin('company_memberships as om', 'om.id', 'd.owner_membership_id').leftJoin('users as ou', 'ou.id', 'om.user_id')
    .where('d.company_id', req.company.id)
    .select('d.*', 'c.display_name as contact_name', 'ou.name as owner_name');

  async function refs(trx, req, b) {
    const outRefs = {};
    if (b.contactId !== undefined) {
      if (b.contactId === null || b.contactId === '') outRefs.contact_id = null;
      else {
        const c = await trx('contacts').where({ id: v.uuid(b.contactId, { field: 'contactId' }), company_id: req.company.id }).first('id');
        if (!c) throw badRequest('validation.invalid', 'Unknown customer', { field: 'contactId' });
        outRefs.contact_id = c.id;
      }
    }
    if (b.ownerMembershipId !== undefined) {
      if (b.ownerMembershipId === null || b.ownerMembershipId === '') outRefs.owner_membership_id = null;
      else {
        const m = await trx('company_memberships').where({ id: v.uuid(b.ownerMembershipId, { field: 'ownerMembershipId' }), company_id: req.company.id, status: 'active' }).first('id');
        if (!m) throw badRequest('validation.invalid', 'Unknown team member', { field: 'ownerMembershipId' });
        outRefs.owner_membership_id = m.id;
      }
    }
    return outRefs;
  }

  function fields(b) {
    let expected;
    if (b.expectedClose !== undefined) {
      if (b.expectedClose === null || b.expectedClose === '') expected = null;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.expectedClose))) expected = String(b.expectedClose);
      else throw badRequest('validation.invalid', 'Invalid date', { field: 'expectedClose' });
    }
    const title = v.str(b.title, { field: 'title', max: 160 });
    return v.compact({ title: title === null ? undefined : title, value: v.number(b.value, { field: 'value', max: 1e12 }), expected_close: expected });
  }

  router.get('/', canView, async (req, res) => {
    const data = await tenant(req, async trx => {
      const stages = await ensureStages(trx, req.company);
      const q = dealQuery(trx, req).where(w => w.where('d.status', 'open').orWhere('d.closed_at', '>', trx.raw("now() - interval '30 days'")));
      if (req.query.owner === 'me') q.where('d.owner_membership_id', req.membership.id);
      if (req.query.search) q.whereRaw("(d.title ILIKE ? OR c.display_name ILIKE ?)", [`%${String(req.query.search).slice(0, 100)}%`, `%${String(req.query.search).slice(0, 100)}%`]);
      const deals = await q.orderBy([{ column: 'd.position' }, { column: 'd.created_at', order: 'desc' }]).limit(2000);
      return { stages, deals };
    });
    const totals = {};
    for (const s of data.stages) {
      const list = data.deals.filter(d => d.stage_id === s.id);
      totals[s.id] = { count: list.length, value: list.reduce((sum, d) => sum + Number(d.value), 0) };
    }
    res.json({ stages: data.stages.map(stageOut), deals: data.deals.map(dealOut), totals, currency: req.company.currency });
  });

  router.post('/', canManage, async (req, res) => {
    const b = req.body || {};
    if (!b.title) throw badRequest('validation.required', 'Title is required', { field: 'title' });
    const deal = await tenant(req, async trx => {
      const stages = await ensureStages(trx, req.company);
      const stage = b.stageId ? stages.find(s => s.id === b.stageId) : stages.find(s => s.kind === 'open');
      if (!stage) throw badRequest('validation.invalid', 'Unknown stage', { field: 'stageId' });
      const r = await refs(trx, req, { ownerMembershipId: req.membership.id, ...b });
      const top = await trx('deals').where({ company_id: req.company.id, stage_id: stage.id }).min('position as p').first();
      const [d] = await trx('deals').insert({
        company_id: req.company.id, stage_id: stage.id, currency: req.company.currency, status: stage.kind,
        closed_at: stage.kind === 'open' ? null : new Date(), position: (top?.p ?? 1) - 1, created_by_user_id: req.user.id,
        ...fields(b), ...r
      }).returning('*');
      return dealQuery(trx, req).where('d.id', d.id).first();
    });
    res.status(201).json({ deal: dealOut(deal) });
  });

  router.patch('/:id', canManage, async (req, res) => {
    const id = v.uuid(req.params.id);
    const b = req.body || {};
    const deal = await tenant(req, async trx => {
      const current = await trx('deals').where({ id, company_id: req.company.id }).first();
      if (!current) throw notFound('deals.not_found', 'Deal not found');
      const patch = { ...fields(b), ...(await refs(trx, req, b)) };
      if (b.stageId !== undefined) {
        const stage = await trx('pipeline_stages').where({ id: v.uuid(b.stageId, { field: 'stageId' }), company_id: req.company.id }).first();
        if (!stage) throw badRequest('validation.invalid', 'Unknown stage', { field: 'stageId' });
        patch.stage_id = stage.id;
        if (stage.kind !== current.status) { patch.status = stage.kind; patch.closed_at = stage.kind === 'open' ? null : new Date(); }
      }
      if (b.position !== undefined) patch.position = v.number(b.position, { field: 'position', min: -1e9, max: 1e9 });
      if (!Object.keys(patch).length) throw badRequest('validation.required', 'Nothing to update');
      await trx('deals').where({ id }).update({ ...patch, updated_at: new Date() });
      return dealQuery(trx, req).where('d.id', id).first();
    });
    res.json({ deal: dealOut(deal) });
  });

  router.delete('/:id', canManage, async (req, res) => {
    const n = await tenant(req, trx => trx('deals').where({ id: v.uuid(req.params.id), company_id: req.company.id }).del());
    if (!n) throw notFound('deals.not_found', 'Deal not found');
    res.json({ ok: true });
  });

  /** Replace the stage list: [{ id?, name, kind }] in display order. Stages with deals cannot be removed. */
  router.put('/stages', canManage, async (req, res) => {
    const list = req.body?.stages;
    if (!Array.isArray(list) || list.length < 2 || list.length > 15) throw badRequest('validation.invalid', 'Between 2 and 15 stages', { field: 'stages' });
    const parsed = list.map((s, i) => ({
      id: s.id ? v.uuid(s.id, { field: 'stages' }) : null,
      name: v.str(s.name, { field: 'stages', required: true, max: 60 }),
      kind: v.oneOf(s.kind || 'open', ['open', 'won', 'lost'], { field: 'stages' }), position: i
    }));
    if (!parsed.some(s => s.kind === 'open')) throw badRequest('deals.stage_open_required', 'At least one open stage is required');
    const stages = await tenant(req, async trx => {
      const current = await ensureStages(trx, req.company);
      const keep = new Set(parsed.filter(s => s.id).map(s => s.id));
      for (const s of parsed) if (s.id && !current.some(c => c.id === s.id)) throw badRequest('validation.invalid', 'Unknown stage', { field: 'stages' });
      for (const s of current.filter(c => !keep.has(c.id))) {
        const used = Number((await trx('deals').where({ stage_id: s.id }).count('* as n').first()).n);
        if (used) throw conflict('deals.stage_in_use', 'Move the deals out of this stage before removing it');
        await trx('pipeline_stages').where({ id: s.id }).del();
      }
      for (const s of parsed) {
        if (s.id) {
          await trx('pipeline_stages').where({ id: s.id }).update({ name: s.name, kind: s.kind, position: s.position, updated_at: new Date() });
          await trx('deals').where({ stage_id: s.id }).whereNot('status', s.kind)
            .update({ status: s.kind, closed_at: s.kind === 'open' ? null : trx.fn.now(), updated_at: new Date() });
        } else {
          await trx('pipeline_stages').insert({ company_id: req.company.id, name: s.name, kind: s.kind, position: s.position });
        }
      }
      return trx('pipeline_stages').where({ company_id: req.company.id }).orderBy('position');
    });
    res.json({ stages: stages.map(stageOut) });
  });

  return router;
};

module.exports.ensureStages = ensureStages;
