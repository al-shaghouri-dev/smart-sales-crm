const express = require('express');
const v = require('../validate');
const { requireAuth, requireCompany, requirePermission } = require('../middleware/session');
const { badRequest, notFound } = require('../errors');
const { audit } = require('../services/audit');

const STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];
const ORDER_LOCK = 727005;
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const csv = val => {
  let s = val === null || val === undefined ? '' : String(val);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

const orderOut = (o, items) => ({
  id: o.id, number: o.number, status: o.status, currency: o.currency,
  subtotal: Number(o.subtotal), discount: Number(o.discount), tax: Number(o.tax), shipping: Number(o.shipping), total: Number(o.total),
  notes: o.notes, shippingAddress: o.shipping_address, contactId: o.contact_id, contactName: o.contact_name || null, contactPhone: o.contact_phone || null,
  dealId: o.deal_id, createdAt: o.created_at, updatedAt: o.updated_at,
  items: items ? items.map(i => ({ id: i.id, name: i.name, quantity: Number(i.quantity), unitPrice: Number(i.unit_price), lineTotal: Number(i.line_total) })) : undefined
});

/**
 * Orders with line items. Totals are always computed on the server:
 *   subtotal = Σ quantity × unit price; tax = (subtotal − discount) × company tax rate (or taxRate);
 *   total = subtotal − discount + tax + shipping.
 * View: orders.view|manage · change: orders.manage · export: orders.export.
 */
module.exports = function orderRoutes({ db }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany);
  const tenant = (req, fn) => db.withContext({ companyId: req.company.id, userId: req.user.id }, fn);
  const canView = requirePermission('orders.view', 'orders.manage');
  const canManage = requirePermission('orders.manage');

  const base = (trx, req) => trx('orders as o').leftJoin('contacts as c', 'c.id', 'o.contact_id').where('o.company_id', req.company.id)
    .select('o.*', 'c.display_name as contact_name', 'c.phone as contact_phone');

  function parseItems(raw) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw badRequest('orders.items_required', 'Add at least one item', { field: 'items' });
    return raw.map((it, i) => {
      const name = v.str(it.name, { field: 'items', required: true, max: 200 });
      const quantity = v.number(it.quantity ?? 1, { field: 'items', min: 0.001, max: 1e6 });
      const unitPrice = v.number(it.unitPrice ?? 0, { field: 'items', min: 0, max: 1e10 });
      return { name, quantity, unit_price: round2(unitPrice), line_total: round2(quantity * unitPrice), position: i };
    });
  }

  async function totals(trx, req, items, b, current) {
    const settings = await trx('company_settings').where({ company_id: req.company.id }).first('tax_rate', 'shipping_fee');
    const subtotal = round2(items.reduce((s, i) => s + i.line_total, 0));
    const discount = round2(v.number(b.discount ?? current?.discount ?? 0, { field: 'discount', max: 1e10 }));
    if (discount > subtotal) throw badRequest('orders.discount_too_large', 'Discount cannot exceed the subtotal', { field: 'discount' });
    const rate = b.taxRate !== undefined ? v.number(b.taxRate, { field: 'taxRate', max: 100 }) : Number(settings?.tax_rate || 0);
    const shipping = round2(v.number(b.shipping ?? current?.shipping ?? Number(settings?.shipping_fee || 0), { field: 'shipping', max: 1e10 }));
    const tax = round2((subtotal - discount) * rate / 100);
    return { subtotal, discount, tax, shipping, total: round2(subtotal - discount + tax + shipping) };
  }

  async function contactRef(trx, req, id) {
    if (id === undefined) return undefined;
    if (id === null || id === '') return null;
    const c = await trx('contacts').where({ id: v.uuid(id, { field: 'contactId' }), company_id: req.company.id }).first('id');
    if (!c) throw badRequest('validation.invalid', 'Unknown customer', { field: 'contactId' });
    return c.id;
  }

  function listQuery(trx, req) {
    const q = base(trx, req);
    if (req.query.status) q.where('o.status', v.oneOf(req.query.status, STATUSES, { field: 'status' }));
    if (req.query.contactId) q.where('o.contact_id', v.uuid(req.query.contactId, { field: 'contactId' }));
    const search = v.str(req.query.search, { field: 'search', max: 100 });
    if (search) {
      const num = Number.parseInt(search.replace(/^#/, ''), 10);
      q.where(w => { w.whereRaw('c.display_name ILIKE ?', [`%${search}%`]).orWhereRaw('c.phone ILIKE ?', [`%${search}%`]); if (Number.isFinite(num)) w.orWhere('o.number', num); });
    }
    return q;
  }

  router.get('/', canView, async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 100);
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const data = await tenant(req, async trx => {
      const total = Number((await listQuery(trx, req).clearSelect().count('* as n').first()).n);
      const rows = await listQuery(trx, req).orderBy('o.created_at', 'desc').limit(limit).offset((page - 1) * limit);
      const byStatus = await trx('orders').where({ company_id: req.company.id }).groupBy('status').select('status').count('* as n');
      return { total, rows, byStatus };
    });
    res.json({ orders: data.rows.map(o => orderOut(o)), total: data.total, page, pages: Math.max(1, Math.ceil(data.total / limit)),
      counts: Object.fromEntries(STATUSES.map(s => [s, Number(data.byStatus.find(x => x.status === s)?.n || 0)])) });
  });

  router.get('/export.csv', requirePermission('orders.export'), async (req, res) => {
    const rows = await tenant(req, trx => listQuery(trx, req).orderBy('o.number').limit(50000));
    const header = ['Number', 'Date', 'Customer', 'Phone', 'Status', 'Subtotal', 'Discount', 'Tax', 'Shipping', 'Total', 'Currency'];
    const lines = [header.map(csv).join(',')].concat(rows.map(o => [o.number, o.created_at?.toISOString(), o.contact_name, o.contact_phone, o.status,
      o.subtotal, o.discount, o.tax, o.shipping, o.total, o.currency].map(csv).join(',')));
    await tenant(req, trx => audit(trx, req, { action: 'orders.exported', companyId: req.company.id, entityType: 'order', after: { rows: rows.length } }));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  router.post('/', canManage, async (req, res) => {
    const b = req.body || {};
    const items = parseItems(b.items);
    const order = await tenant(req, async trx => {
      const contactId = await contactRef(trx, req, b.contactId);
      let dealId = null;
      if (b.dealId) {
        const d = await trx('deals').where({ id: v.uuid(b.dealId, { field: 'dealId' }), company_id: req.company.id }).first('id');
        if (!d) throw badRequest('validation.invalid', 'Unknown deal', { field: 'dealId' });
        dealId = d.id;
      }
      const t = await totals(trx, req, items, b);
      await trx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [ORDER_LOCK, req.company.id]);
      const next = Number((await trx('orders').where({ company_id: req.company.id }).max('number as m').first()).m || 1000) + 1;
      const [o] = await trx('orders').insert({
        company_id: req.company.id, number: next, contact_id: contactId ?? null, deal_id: dealId, currency: req.company.currency,
        status: v.oneOf(b.status || 'new', STATUSES, { field: 'status' }), notes: v.str(b.notes, { field: 'notes', max: 2000 }) ?? null,
        shipping_address: v.str(b.shippingAddress, { field: 'shippingAddress', max: 500 }) ?? null, created_by_user_id: req.user.id, ...t
      }).returning('*');
      await trx('order_items').insert(items.map(i => ({ ...i, company_id: req.company.id, order_id: o.id })));
      if (contactId) await trx('contacts').where({ id: contactId }).whereIn('status', ['new', 'lead']).update({ status: 'customer', updated_at: new Date() });
      return o.id;
    });
    const full = await tenant(req, async trx => ({ o: await base(trx, req).where('o.id', order).first(), items: await trx('order_items').where({ order_id: order }).orderBy('position') }));
    res.status(201).json({ order: orderOut(full.o, full.items) });
  });

  router.get('/:id', canView, async (req, res) => {
    const id = v.uuid(req.params.id);
    const data = await tenant(req, async trx => {
      const o = await base(trx, req).where('o.id', id).first();
      if (!o) throw notFound('orders.not_found', 'Order not found');
      return { o, items: await trx('order_items').where({ order_id: id }).orderBy('position') };
    });
    res.json({ order: orderOut(data.o, data.items) });
  });

  router.patch('/:id', canManage, async (req, res) => {
    const id = v.uuid(req.params.id);
    const b = req.body || {};
    await tenant(req, async trx => {
      const current = await trx('orders').where({ id, company_id: req.company.id }).first();
      if (!current) throw notFound('orders.not_found', 'Order not found');
      const patch = v.compact({
        status: v.oneOf(b.status, STATUSES, { field: 'status' }) ?? undefined,
        notes: v.str(b.notes, { field: 'notes', max: 2000 }),
        shipping_address: v.str(b.shippingAddress, { field: 'shippingAddress', max: 500 }),
        contact_id: await contactRef(trx, req, b.contactId)
      });
      if (b.items !== undefined || b.discount !== undefined || b.shipping !== undefined || b.taxRate !== undefined) {
        const items = b.items !== undefined ? parseItems(b.items)
          : (await trx('order_items').where({ order_id: id }).orderBy('position')).map(i => ({ name: i.name, quantity: Number(i.quantity), unit_price: Number(i.unit_price), line_total: Number(i.line_total), position: i.position }));
        Object.assign(patch, await totals(trx, req, items, b, current));
        if (b.items !== undefined) {
          await trx('order_items').where({ order_id: id }).del();
          await trx('order_items').insert(items.map(i => ({ ...i, company_id: req.company.id, order_id: id })));
        }
      }
      if (!Object.keys(patch).length) throw badRequest('validation.required', 'Nothing to update');
      await trx('orders').where({ id }).update({ ...patch, updated_at: new Date() });
    });
    const full = await tenant(req, async trx => ({ o: await base(trx, req).where('o.id', id).first(), items: await trx('order_items').where({ order_id: id }).orderBy('position') }));
    res.json({ order: orderOut(full.o, full.items) });
  });

  router.delete('/:id', canManage, async (req, res) => {
    const id = v.uuid(req.params.id);
    await tenant(req, async trx => {
      const o = await trx('orders').where({ id, company_id: req.company.id }).first();
      if (!o) throw notFound('orders.not_found', 'Order not found');
      await trx('orders').where({ id }).del();
      await audit(trx, req, { action: 'orders.deleted', companyId: req.company.id, entityType: 'order', entityId: id, before: { number: o.number, total: Number(o.total) } });
    });
    res.json({ ok: true });
  });

  return router;
};

module.exports.ORDER_STATUSES = STATUSES;
