const express = require('express');
const v = require('../validate');
const { requireAuth, requireCompany, requirePermission } = require('../middleware/session');
const { badRequest, conflict, notFound } = require('../errors');
const { audit } = require('../services/audit');
const { visibilityOf, scopeConversations } = require('../messaging/access');

const STATUSES = ['new', 'lead', 'customer', 'inactive'];
const escapeLike = s => s.replace(/[\\%_]/g, m => `\\${m}`);

const out = c => ({
  id: c.id, displayName: c.display_name, phone: c.phone, email: c.email, companyName: c.company_name,
  status: c.status, tags: Array.isArray(c.tags) ? c.tags : [], source: c.source, notes: c.notes,
  ownerMembershipId: c.owner_membership_id, ownerName: c.owner_name || null,
  firstContactAt: c.first_contact_at, lastContactAt: c.last_contact_at, createdAt: c.created_at,
  openDeals: c.open_deals !== undefined ? Number(c.open_deals) : undefined,
  orders: c.orders_count !== undefined ? Number(c.orders_count) : undefined
});

function parseTags(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw badRequest('validation.invalid', 'tags must be a list', { field: 'tags' });
  return [...new Set(raw.map(t => String(t).trim()).filter(Boolean).map(t => t.slice(0, 40)))].slice(0, 20);
}

/** CSV cell: quoted, and formula-leading characters neutralised (spreadsheet injection). */
const csv = val => {
  let s = val === null || val === undefined ? '' : String(val);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

/**
 * Customers (the `contacts` table). Contacts are created automatically from conversations and can
 * be added manually. View: customers.view|manage · edit: customers.manage · export: customers.export.
 */
module.exports = function customerRoutes({ db }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany);
  const tenant = (req, fn) => db.withContext({ companyId: req.company.id, userId: req.user.id }, fn);
  const canView = requirePermission('customers.view', 'customers.manage');
  const canManage = requirePermission('customers.manage');

  async function validMember(trx, req, id) {
    if (id === null || id === '' || id === undefined) return id === undefined ? undefined : null;
    const m = await trx('company_memberships').where({ id: v.uuid(id, { field: 'ownerMembershipId' }), company_id: req.company.id, status: 'active' }).first('id');
    if (!m) throw badRequest('validation.invalid', 'Unknown team member', { field: 'ownerMembershipId' });
    return m.id;
  }

  function parse(b, { partial }) {
    const name = v.str(b.displayName, { field: 'displayName', max: 120, required: !partial });
    return v.compact({
      display_name: name === null ? undefined : name,
      phone: v.str(b.phone, { field: 'phone', max: 40 }),
      email: b.email === '' || b.email === null ? (b.email === undefined ? undefined : null) : (b.email !== undefined ? v.email(b.email, { field: 'email', required: false }) : undefined),
      company_name: v.str(b.companyName, { field: 'companyName', max: 120 }),
      status: v.oneOf(b.status, STATUSES, { field: 'status' }) ?? undefined,
      notes: v.str(b.notes, { field: 'notes', max: 4000 }),
      tags: (() => { const t = parseTags(b.tags); return t === undefined ? undefined : JSON.stringify(t); })()
    });
  }

  function listQuery(trx, req) {
    const q = req.query;
    const query = trx('contacts as c').leftJoin('company_memberships as om', 'om.id', 'c.owner_membership_id').leftJoin('users as ou', 'ou.id', 'om.user_id')
      .where('c.company_id', req.company.id);
    const search = v.str(q.search, { field: 'search', max: 100 });
    if (search) {
      const like = `%${escapeLike(search)}%`;
      query.where(w => w.whereRaw("c.display_name ILIKE ? ESCAPE '\\'", [like]).orWhereRaw("c.phone ILIKE ? ESCAPE '\\'", [like])
        .orWhereRaw("c.email ILIKE ? ESCAPE '\\'", [like]).orWhereRaw("c.company_name ILIKE ? ESCAPE '\\'", [like]));
    }
    if (q.status) query.where('c.status', v.oneOf(q.status, STATUSES, { field: 'status' }));
    if (q.tag) query.whereRaw('c.tags @> ?::jsonb', [JSON.stringify([String(q.tag).slice(0, 40)])]);
    if (q.owner === 'me') query.where('c.owner_membership_id', req.membership.id);
    else if (q.owner === 'none') query.whereNull('c.owner_membership_id');
    else if (q.owner) query.where('c.owner_membership_id', v.uuid(q.owner, { field: 'owner' }));
    return query;
  }

  router.get('/', canView, async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 100);
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const data = await tenant(req, async trx => {
      const total = Number((await listQuery(trx, req).count('* as n').first()).n);
      const rows = await listQuery(trx, req)
        .select('c.*', 'ou.name as owner_name',
          trx.raw("(SELECT count(*) FROM deals d WHERE d.contact_id = c.id AND d.status = 'open') AS open_deals"),
          trx.raw('(SELECT count(*) FROM orders o WHERE o.contact_id = c.id) AS orders_count'))
        .orderByRaw('c.last_contact_at DESC NULLS LAST, c.created_at DESC').limit(limit).offset((page - 1) * limit);
      const counts = await trx('contacts').where({ company_id: req.company.id }).groupBy('status').select('status').count('* as n');
      return { total, rows, counts };
    });
    res.json({ customers: data.rows.map(out), total: data.total, page, pages: Math.max(1, Math.ceil(data.total / limit)),
      counts: Object.fromEntries(STATUSES.map(s => [s, Number(data.counts.find(c => c.status === s)?.n || 0)])) });
  });

  router.get('/tags', canView, async (req, res) => {
    const rows = await tenant(req, trx => trx.raw('SELECT DISTINCT jsonb_array_elements_text(tags) AS tag FROM contacts WHERE company_id = ? ORDER BY 1 LIMIT 200', [req.company.id]));
    res.json({ tags: rows.rows.map(r => r.tag) });
  });

  router.get('/export.csv', requirePermission('customers.export'), async (req, res) => {
    const rows = await tenant(req, trx => listQuery(trx, req).select('c.*', 'ou.name as owner_name').orderBy('c.created_at').limit(50000));
    const header = ['Name', 'Phone', 'Email', 'Company', 'Status', 'Tags', 'Source', 'Owner', 'Created', 'Last contact'];
    const lines = [header.map(csv).join(',')].concat(rows.map(c => [c.display_name, c.phone, c.email, c.company_name, c.status,
      (c.tags || []).join('; '), c.source, c.owner_name, c.created_at?.toISOString(), c.last_contact_at?.toISOString()].map(csv).join(',')));
    await tenant(req, trx => audit(trx, req, { action: 'customers.exported', companyId: req.company.id, entityType: 'contact', after: { rows: rows.length } }));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  router.post('/', canManage, async (req, res) => {
    const row = parse(req.body || {}, { partial: false });
    const created = await tenant(req, async trx => {
      const owner = await validMember(trx, req, req.body?.ownerMembershipId);
      const [c] = await trx('contacts').insert({ ...row, company_id: req.company.id, source: 'manual', owner_membership_id: owner ?? null }).returning('*');
      return c;
    });
    res.status(201).json({ customer: out(created) });
  });

  router.get('/:id', canView, async (req, res) => {
    const id = v.uuid(req.params.id);
    const data = await tenant(req, async trx => {
      const c = await trx('contacts as c').leftJoin('company_memberships as om', 'om.id', 'c.owner_membership_id').leftJoin('users as ou', 'ou.id', 'om.user_id')
        .where({ 'c.id': id, 'c.company_id': req.company.id }).first('c.*', 'ou.name as owner_name');
      if (!c) throw notFound('customers.not_found', 'Customer not found');
      const identities = await trx('contact_identities as i').join('channels as ch', 'ch.id', 'i.channel_id').where('i.contact_id', id)
        .select('i.id', 'i.provider', 'i.external_user_id', 'i.profile', 'ch.display_name as channel_name');
      const visibility = visibilityOf(req.permissions);
      const conversations = visibility ? await scopeConversations(trx('conversations as c').join('channels as ch', 'ch.id', 'c.channel_id').where('c.contact_id', id),
        { visibility, membershipId: req.membership?.id }).orderBy('c.last_message_at', 'desc').limit(20)
        .select('c.id', 'c.status', 'c.last_message_preview', 'c.last_message_at', 'ch.provider', 'ch.display_name as channel_name') : [];
      const deals = await trx('deals as d').join('pipeline_stages as s', 's.id', 'd.stage_id').where('d.contact_id', id).orderBy('d.created_at', 'desc')
        .select('d.id', 'd.title', 'd.value', 'd.currency', 'd.status', 's.name as stage_name');
      const canOrders = req.permissions.has('orders.view') || req.permissions.has('orders.manage');
      const orders = canOrders ? await trx('orders').where({ contact_id: id }).orderBy('created_at', 'desc').limit(20).select('id', 'number', 'status', 'total', 'currency', 'created_at') : [];
      const tasks = await trx('tasks as t').leftJoin('company_memberships as am', 'am.id', 't.assignee_membership_id').leftJoin('users as au', 'au.id', 'am.user_id')
        .where('t.contact_id', id).orderByRaw('t.done_at IS NOT NULL, t.due_at NULLS LAST').limit(30)
        .select('t.id', 't.title', 't.due_at', 't.done_at', 'au.name as assignee_name');
      const notes = await trx('contact_notes as n').leftJoin('company_memberships as m', 'm.id', 'n.author_membership_id').leftJoin('users as u', 'u.id', 'm.user_id')
        .where('n.contact_id', id).orderBy('n.created_at', 'desc').limit(100).select('n.id', 'n.body', 'n.created_at', 'n.author_membership_id', 'u.name as author_name');
      return { c, identities, conversations, deals, orders, tasks, notes };
    });
    res.json({
      customer: out(data.c),
      identities: data.identities.map(i => ({ id: i.id, provider: i.provider, externalUserId: i.external_user_id, username: i.profile?.username || null, channelName: i.channel_name })),
      conversations: data.conversations.map(c => ({ id: c.id, status: c.status, preview: c.last_message_preview, lastMessageAt: c.last_message_at, provider: c.provider, channelName: c.channel_name })),
      deals: data.deals.map(d => ({ id: d.id, title: d.title, value: Number(d.value), currency: d.currency, status: d.status, stageName: d.stage_name })),
      orders: data.orders.map(o => ({ id: o.id, number: o.number, status: o.status, total: Number(o.total), currency: o.currency, createdAt: o.created_at })),
      tasks: data.tasks.map(t => ({ id: t.id, title: t.title, dueAt: t.due_at, doneAt: t.done_at, assigneeName: t.assignee_name })),
      notes: data.notes.map(n => ({ id: n.id, body: n.body, createdAt: n.created_at, authorName: n.author_name, mine: n.author_membership_id === req.membership?.id }))
    });
  });

  router.patch('/:id', canManage, async (req, res) => {
    const id = v.uuid(req.params.id);
    const row = parse(req.body || {}, { partial: true });
    const updated = await tenant(req, async trx => {
      const owner = await validMember(trx, req, req.body?.ownerMembershipId);
      const patch = { ...row, ...(owner !== undefined ? { owner_membership_id: owner } : {}) };
      if (!Object.keys(patch).length) throw badRequest('validation.required', 'Nothing to update');
      const [c] = await trx('contacts').where({ id, company_id: req.company.id }).update({ ...patch, updated_at: new Date() }).returning('*');
      if (!c) throw notFound('customers.not_found', 'Customer not found');
      return c;
    });
    res.json({ customer: out(updated) });
  });

  router.delete('/:id', canManage, async (req, res) => {
    const id = v.uuid(req.params.id);
    await tenant(req, async trx => {
      const c = await trx('contacts').where({ id, company_id: req.company.id }).first();
      if (!c) throw notFound('customers.not_found', 'Customer not found');
      const convs = Number((await trx('conversations').where({ contact_id: id }).count('* as n').first()).n);
      if (convs > 0) throw conflict('customers.has_conversations', 'Customers with conversations cannot be deleted');
      await trx('contacts').where({ id }).del();
      await audit(trx, req, { action: 'customers.deleted', companyId: req.company.id, entityType: 'contact', entityId: id, before: { displayName: c.display_name } });
    });
    res.json({ ok: true });
  });

  router.post('/:id/notes', requirePermission('customers.view', 'customers.manage'), async (req, res) => {
    const id = v.uuid(req.params.id);
    const body = v.str(req.body?.body, { field: 'body', required: true, max: 4000 });
    const note = await tenant(req, async trx => {
      const c = await trx('contacts').where({ id, company_id: req.company.id }).first('id');
      if (!c) throw notFound('customers.not_found', 'Customer not found');
      const [n] = await trx('contact_notes').insert({ company_id: req.company.id, contact_id: id, author_membership_id: req.membership.id, body }).returning('*');
      return n;
    });
    res.status(201).json({ note: { id: note.id, body: note.body, createdAt: note.created_at, authorName: req.user.name, mine: true } });
  });

  router.delete('/:id/notes/:noteId', requirePermission('customers.view', 'customers.manage'), async (req, res) => {
    const noteId = v.uuid(req.params.noteId);
    await tenant(req, async trx => {
      const n = await trx('contact_notes').where({ id: noteId, contact_id: v.uuid(req.params.id), company_id: req.company.id }).first();
      if (!n) throw notFound('customers.note_not_found', 'Note not found');
      if (n.author_membership_id !== req.membership.id && !req.permissions.has('customers.manage')) throw notFound('customers.note_not_found', 'Note not found');
      await trx('contact_notes').where({ id: noteId }).del();
    });
    res.json({ ok: true });
  });

  return router;
};

module.exports.CUSTOMER_STATUSES = STATUSES;
