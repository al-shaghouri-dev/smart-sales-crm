const express = require('express');
const v = require('../validate');
const { requireAuth, requireCompany } = require('../middleware/session');
const { badRequest, forbidden, notFound } = require('../errors');

const taskOut = t => ({
  id: t.id, title: t.title, notes: t.notes, dueAt: t.due_at, doneAt: t.done_at,
  assigneeMembershipId: t.assignee_membership_id, assigneeName: t.assignee_name || null,
  contactId: t.contact_id, contactName: t.contact_name || null, dealId: t.deal_id, dealTitle: t.deal_title || null,
  createdAt: t.created_at, overdue: Boolean(!t.done_at && t.due_at && new Date(t.due_at) < new Date())
});

/**
 * Tasks / follow-ups. Every member sees and manages their own tasks (assigned to or created by them).
 * Members with customers.manage or users.manage see and manage everyone's tasks and may assign to others.
 */
module.exports = function taskRoutes({ db }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany);
  const tenant = (req, fn) => db.withContext({ companyId: req.company.id, userId: req.user.id }, fn);
  const isManager = req => req.permissions.has('customers.manage') || req.permissions.has('users.manage');

  const base = (trx, req) => trx('tasks as t')
    .leftJoin('company_memberships as am', 'am.id', 't.assignee_membership_id').leftJoin('users as au', 'au.id', 'am.user_id')
    .leftJoin('contacts as c', 'c.id', 't.contact_id').leftJoin('deals as d', 'd.id', 't.deal_id')
    .where('t.company_id', req.company.id)
    .select('t.*', 'au.name as assignee_name', 'c.display_name as contact_name', 'd.title as deal_title');

  const scoped = (q, req) => (isManager(req) ? q : q.where(w => w.where('t.assignee_membership_id', req.membership.id).orWhere('t.created_by_user_id', req.user.id)));

  async function refs(trx, req, b) {
    const r = {};
    if (b.assigneeMembershipId !== undefined) {
      if (b.assigneeMembershipId === null || b.assigneeMembershipId === '') r.assignee_membership_id = null;
      else {
        const id = v.uuid(b.assigneeMembershipId, { field: 'assigneeMembershipId' });
        if (id !== req.membership.id && !isManager(req)) throw forbidden('tasks.assign_forbidden', 'You can only assign tasks to yourself');
        const m = await trx('company_memberships').where({ id, company_id: req.company.id, status: 'active' }).first('id');
        if (!m) throw badRequest('validation.invalid', 'Unknown team member', { field: 'assigneeMembershipId' });
        r.assignee_membership_id = m.id;
      }
    }
    for (const [key, col, table] of [['contactId', 'contact_id', 'contacts'], ['dealId', 'deal_id', 'deals']]) {
      if (b[key] === undefined) continue;
      if (b[key] === null || b[key] === '') { r[col] = null; continue; }
      const row = await trx(table).where({ id: v.uuid(b[key], { field: key }), company_id: req.company.id }).first('id');
      if (!row) throw badRequest('validation.invalid', 'Not found', { field: key });
      r[col] = row.id;
    }
    return r;
  }

  function fields(b) {
    let due;
    if (b.dueAt !== undefined) {
      if (b.dueAt === null || b.dueAt === '') due = null;
      else { const d = new Date(b.dueAt); if (Number.isNaN(d.getTime())) throw badRequest('validation.invalid', 'Invalid date', { field: 'dueAt' }); due = d; }
    }
    const title = v.str(b.title, { field: 'title', max: 200 });
    return v.compact({ title: title === null ? undefined : title, notes: v.str(b.notes, { field: 'notes', max: 2000 }), due_at: due });
  }

  router.get('/', async (req, res) => {
    const filter = v.oneOf(req.query.filter || 'open', ['open', 'today', 'overdue', 'done', 'all'], { field: 'filter' });
    const rows = await tenant(req, trx => {
      const q = scoped(base(trx, req), req);
      if (req.query.mine === 'true' || !isManager(req)) q.where(w => w.where('t.assignee_membership_id', req.membership.id).orWhere(w2 => w2.whereNull('t.assignee_membership_id').where('t.created_by_user_id', req.user.id)));
      if (req.query.contactId) q.where('t.contact_id', v.uuid(req.query.contactId, { field: 'contactId' }));
      if (filter === 'open') q.whereNull('t.done_at');
      if (filter === 'done') q.whereNotNull('t.done_at');
      if (filter === 'overdue') q.whereNull('t.done_at').where('t.due_at', '<', trx.fn.now());
      if (filter === 'today') q.whereNull('t.done_at').where('t.due_at', '<', trx.raw("date_trunc('day', now()) + interval '1 day'"));
      return q.orderByRaw(filter === 'done' ? 't.done_at DESC' : 't.due_at ASC NULLS LAST, t.created_at DESC').limit(300);
    });
    res.json({ tasks: rows.map(taskOut), canAssignOthers: isManager(req) });
  });

  router.post('/', async (req, res) => {
    const b = req.body || {};
    if (!b.title) throw badRequest('validation.required', 'Title is required', { field: 'title' });
    const task = await tenant(req, async trx => {
      const r = await refs(trx, req, { assigneeMembershipId: req.membership.id, ...b });
      const [t] = await trx('tasks').insert({ company_id: req.company.id, created_by_user_id: req.user.id, ...fields(b), ...r }).returning('id');
      return base(trx, req).where('t.id', t.id).first();
    });
    res.status(201).json({ task: taskOut(task) });
  });

  router.patch('/:id', async (req, res) => {
    const id = v.uuid(req.params.id);
    const b = req.body || {};
    const task = await tenant(req, async trx => {
      const current = await scoped(trx('tasks as t').where({ 't.id': id, 't.company_id': req.company.id }), req).first('t.*');
      if (!current) throw notFound('tasks.not_found', 'Task not found');
      const patch = { ...fields(b), ...(await refs(trx, req, b)) };
      if (b.done !== undefined) patch.done_at = b.done ? (current.done_at || new Date()) : null;
      if (!Object.keys(patch).length) throw badRequest('validation.required', 'Nothing to update');
      await trx('tasks').where({ id }).update({ ...patch, updated_at: new Date() });
      return base(trx, req).where('t.id', id).first();
    });
    res.json({ task: taskOut(task) });
  });

  router.delete('/:id', async (req, res) => {
    const id = v.uuid(req.params.id);
    await tenant(req, async trx => {
      const current = await scoped(trx('tasks as t').where({ 't.id': id, 't.company_id': req.company.id }), req).first('t.id');
      if (!current) throw notFound('tasks.not_found', 'Task not found');
      await trx('tasks').where({ id }).del();
    });
    res.json({ ok: true });
  });

  return router;
};
