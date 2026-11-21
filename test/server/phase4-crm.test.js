const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const h = require('./helpers');

const skip = !h.enabled && 'set TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL to run database tests';

describe('Phase 4 CRM core', { skip }, () => {
  let app;
  before(async () => { await h.setupDatabase(); app = h.makeApp(); });
  beforeEach(() => h.resetDatabase());
  after(() => h.teardown());

  async function session(email) {
    const s = await h.login(app, email);
    return { ...s, call: (m, u, b) => s.agent[m](u).set('X-CSRF-Token', s.csrf).send(b) };
  }
  async function company(name) {
    const c = await h.createCompanyFixture(name, `owner@${name.toLowerCase()}.test`);
    return { ...c, owner: await session(`owner@${name.toLowerCase()}.test`) };
  }

  test('customers: create, search, filter, tags, notes, detail, update, delete rules', async () => {
    const a = await company('Acme');
    const r1 = await a.owner.call('post', '/api/customers', { displayName: 'سارة أحمد', phone: '+966500000001', email: 'sara@example.com', tags: ['vip', 'vip', ' riyadh '], status: 'lead' });
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    assert.deepEqual(r1.body.customer.tags, ['vip', 'riyadh']);
    assert.equal(r1.body.customer.source, 'manual');
    await a.owner.call('post', '/api/customers', { displayName: 'Omar', companyName: 'Omar Trading', status: 'customer' });
    assert.equal((await a.owner.call('post', '/api/customers', { displayName: '' })).status, 400);
    assert.equal((await a.owner.call('post', '/api/customers', { displayName: 'x', status: 'bogus' })).status, 400);
    const list = await a.owner.agent.get('/api/customers?search=omar');
    assert.equal(list.body.total, 1);
    assert.equal((await a.owner.agent.get('/api/customers?tag=vip')).body.customers[0].displayName, 'سارة أحمد');
    assert.equal((await a.owner.agent.get('/api/customers?status=customer')).body.total, 1);
    assert.deepEqual((await a.owner.agent.get('/api/customers')).body.counts, { new: 0, lead: 1, customer: 1, inactive: 0 });
    assert.deepEqual((await a.owner.agent.get('/api/customers/tags')).body.tags, ['riyadh', 'vip']);
    const id = r1.body.customer.id;
    const note = await a.owner.call('post', `/api/customers/${id}/notes`, { body: 'Called, interested in plan B' });
    assert.equal(note.status, 201);
    const detail = await a.owner.agent.get(`/api/customers/${id}`);
    assert.equal(detail.body.notes.length, 1);
    assert.equal(detail.body.notes[0].mine, true);
    const upd = await a.owner.call('patch', `/api/customers/${id}`, { status: 'customer', ownerMembershipId: null, email: '' });
    assert.equal(upd.body.customer.status, 'customer');
    assert.equal(upd.body.customer.email, null);
    assert.equal((await a.owner.call('delete', `/api/customers/${id}`)).status, 200);
    assert.equal((await a.owner.agent.get(`/api/customers/${id}`)).status, 404);
  });

  test('customers export: permission, CSV formula injection neutralised, audited', async () => {
    const a = await company('Acme');
    await a.owner.call('post', '/api/customers', { displayName: '=HYPERLINK("http://evil","x")', phone: '+1 555' });
    const res = await a.owner.agent.get('/api/customers/export.csv');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.ok(res.text.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), res.text);
    assert.ok(res.text.includes(`"'+1 555"`));
    await h.addMember(a.companyId, 'employee', 'emp@acme.test');
    const e = await session('emp@acme.test');
    assert.equal((await e.agent.get('/api/customers/export.csv')).status, 403);
    assert.equal((await e.agent.get('/api/customers')).status, 200, 'employees can view');
    assert.equal((await e.call('post', '/api/customers', { displayName: 'x' })).status, 403, 'but not edit');
  });

  test('pipeline: default stages in the company language, create/move deals, won/lost, stage editing', async () => {
    const a = await company('Acme');
    const board = await a.owner.agent.get('/api/deals');
    assert.equal(board.status, 200);
    assert.equal(board.body.stages.length, 6);
    assert.deepEqual(board.body.stages.map(s => s.kind), ['open', 'open', 'open', 'open', 'won', 'lost']);
    const cust = (await a.owner.call('post', '/api/customers', { displayName: 'Buyer' })).body.customer;
    const d = await a.owner.call('post', '/api/deals', { title: 'Website', value: 1500, contactId: cust.id, expectedClose: '2026-12-31' });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.equal(d.body.deal.stageId, board.body.stages[0].id);
    assert.equal(d.body.deal.contactName, 'Buyer');
    assert.equal(d.body.deal.expectedClose, '2026-12-31');
    const won = board.body.stages.find(s => s.kind === 'won');
    const moved = await a.owner.call('patch', `/api/deals/${d.body.deal.id}`, { stageId: won.id, position: 0 });
    assert.equal(moved.body.deal.status, 'won');
    assert.ok(moved.body.deal.closedAt);
    const back = await a.owner.call('patch', `/api/deals/${d.body.deal.id}`, { stageId: board.body.stages[1].id });
    assert.equal(back.body.deal.status, 'open');
    assert.equal(back.body.deal.closedAt, null);
    // Stages: rename and add; removing a stage with deals is refused.
    const stages = board.body.stages.map(s => ({ id: s.id, name: s.name, kind: s.kind }));
    stages[0].name = 'Fresh';
    const put = await a.owner.call('put', '/api/deals/stages', { stages: [...stages, { name: 'On hold', kind: 'open' }] });
    assert.equal(put.status, 200);
    assert.equal(put.body.stages.length, 7);
    assert.equal(put.body.stages[0].name, 'Fresh');
    const without = put.body.stages.filter(s => s.id !== board.body.stages[1].id).map(s => ({ id: s.id, name: s.name, kind: s.kind }));
    assert.equal((await a.owner.call('put', '/api/deals/stages', { stages: without })).body.code, 'deals.stage_in_use');
    assert.equal((await a.owner.call('put', '/api/deals/stages', { stages: [{ name: 'A', kind: 'won' }, { name: 'B', kind: 'lost' }] })).body.code, 'deals.stage_open_required');
  });

  test('orders: numbering, server-side totals with tax/discount/shipping, status, customer becomes "customer"', async () => {
    const a = await company('Acme');
    await a.owner.call('patch', '/api/company', { taxRate: 15, shippingFee: 20 });
    const cust = (await a.owner.call('post', '/api/customers', { displayName: 'Buyer', status: 'lead' })).body.customer;
    const o1 = await a.owner.call('post', '/api/orders', { contactId: cust.id, items: [{ name: 'Shirt', quantity: 2, unitPrice: 50 }, { name: 'Hat', quantity: 1, unitPrice: 30 }], discount: 30, total: 1 });
    assert.equal(o1.status, 201, JSON.stringify(o1.body));
    const o = o1.body.order;
    assert.equal(o.number, 1001);
    assert.equal(o.subtotal, 130);
    assert.equal(o.discount, 30);
    assert.equal(o.tax, 15);
    assert.equal(o.shipping, 20);
    assert.equal(o.total, 135, 'client-sent total is ignored');
    assert.equal(o.items.length, 2);
    const o2 = await a.owner.call('post', '/api/orders', { items: [{ name: 'X', quantity: 1, unitPrice: 10 }], shipping: 0, taxRate: 0 });
    assert.equal(o2.body.order.number, 1002);
    assert.equal(o2.body.order.total, 10);
    assert.equal((await a.owner.call('post', '/api/orders', { items: [] })).body.code, 'orders.items_required');
    assert.equal((await a.owner.call('post', '/api/orders', { items: [{ name: 'X', quantity: 1, unitPrice: 10 }], discount: 50 })).body.code, 'orders.discount_too_large');
    const shipped = await a.owner.call('patch', `/api/orders/${o.id}`, { status: 'shipped', items: [{ name: 'Shirt', quantity: 1, unitPrice: 50 }] });
    assert.equal(shipped.body.order.status, 'shipped');
    assert.equal(shipped.body.order.subtotal, 50);
    assert.equal((await a.owner.agent.get(`/api/customers/${cust.id}`)).body.customer.status, 'customer');
    const list = await a.owner.agent.get('/api/orders?search=%23' + o.number);
    assert.equal(list.body.total, 1);
    assert.equal((await a.owner.agent.get('/api/orders?status=shipped')).body.total, 1);
    // Concurrent creation never duplicates numbers.
    const many = await Promise.all([...Array(8)].map(() => a.owner.call('post', '/api/orders', { items: [{ name: 'Y', quantity: 1, unitPrice: 1 }] })));
    const numbers = many.map(r => r.body.order.number);
    assert.equal(new Set(numbers).size, 8);
  });

  test('tasks: own tasks for employees, manager assignment, done/overdue filters', async () => {
    const a = await company('Acme');
    const emp = await h.addMember(a.companyId, 'employee', 'emp@acme.test');
    const e = await session('emp@acme.test');
    const t1 = await e.call('post', '/api/tasks', { title: 'Call back', dueAt: new Date(Date.now() - 3600e3).toISOString() });
    assert.equal(t1.status, 201);
    assert.equal(t1.body.task.overdue, true);
    assert.equal((await e.call('post', '/api/tasks', { title: 'x', assigneeMembershipId: a.owner.me.membership.id })).body.code, 'tasks.assign_forbidden');
    const t2 = await a.owner.call('post', '/api/tasks', { title: 'For Sara', assigneeMembershipId: emp.membershipId });
    assert.equal(t2.status, 201);
    const mine = await e.agent.get('/api/tasks');
    assert.deepEqual(mine.body.tasks.map(t => t.title).sort(), ['Call back', 'For Sara']);
    assert.equal(mine.body.canAssignOthers, false);
    const ownerOnly = await a.owner.call('post', '/api/tasks', { title: 'Owner private' });
    assert.equal((await e.call('patch', `/api/tasks/${ownerOnly.body.task.id}`, { done: true })).status, 404, 'cannot touch others');
    assert.equal((await e.agent.get('/api/tasks?filter=overdue')).body.tasks.length, 1);
    const done = await e.call('patch', `/api/tasks/${t1.body.task.id}`, { done: true });
    assert.ok(done.body.task.doneAt);
    assert.equal((await e.agent.get('/api/tasks?filter=done')).body.tasks.length, 1);
    assert.equal((await a.owner.agent.get('/api/tasks?filter=all')).body.tasks.length, 3, 'managers see all');
  });

  test('reports: activity for reports.view, revenue only with reports.financial', async () => {
    const a = await company('Acme');
    await a.owner.call('post', '/api/customers', { displayName: 'A' });
    await a.owner.call('post', '/api/orders', { items: [{ name: 'X', quantity: 2, unitPrice: 25 }], taxRate: 0, shipping: 0 });
    const r = await a.owner.agent.get('/api/reports/summary?days=7');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.labels.length, 7);
    assert.equal(r.body.totals.newContacts, 1);
    assert.equal(r.body.totals.revenue, 50);
    assert.equal(r.body.totals.orders, 1);
    assert.equal(r.body.series.revenue.reduce((s, x) => s + x, 0), 50);
    await h.addMember(a.companyId, 'supervisor', 'sup@acme.test');
    const s = await session('sup@acme.test');
    const sr = await s.agent.get('/api/reports/summary');
    assert.equal(sr.status, 200);
    assert.equal(sr.body.financial, false);
    assert.equal(sr.body.totals.revenue, undefined, 'no financial figures without reports.financial');
    await h.addMember(a.companyId, 'employee', 'emp@acme.test');
    assert.equal((await (await session('emp@acme.test')).agent.get('/api/reports/summary')).status, 403);
  });

  test('isolation: another company cannot read or change customers, deals, orders or tasks', async () => {
    const a = await company('Acme');
    const b = await company('Beta');
    const cust = (await a.owner.call('post', '/api/customers', { displayName: 'Secret' })).body.customer;
    const deal = (await a.owner.call('post', '/api/deals', { title: 'Secret deal', value: 9 })).body.deal;
    const order = (await a.owner.call('post', '/api/orders', { items: [{ name: 'S', quantity: 1, unitPrice: 1 }] })).body.order;
    const task = (await a.owner.call('post', '/api/tasks', { title: 'Secret task' })).body.task;
    for (const [m, u, body] of [['get', `/api/customers/${cust.id}`], ['patch', `/api/customers/${cust.id}`, { displayName: 'x' }], ['delete', `/api/customers/${cust.id}`],
      ['post', `/api/customers/${cust.id}/notes`, { body: 'x' }], ['patch', `/api/deals/${deal.id}`, { title: 'x' }], ['delete', `/api/deals/${deal.id}`],
      ['get', `/api/orders/${order.id}`], ['patch', `/api/orders/${order.id}`, { status: 'cancelled' }], ['delete', `/api/orders/${order.id}`],
      ['patch', `/api/tasks/${task.id}`, { done: true }], ['delete', `/api/tasks/${task.id}`]]) {
      assert.equal((await b.owner.call(m, u, body)).status, 404, `${m} ${u}`);
    }
    assert.equal((await b.owner.agent.get('/api/customers')).body.total, 0);
    assert.equal((await b.owner.agent.get('/api/deals')).body.deals.length, 0);
    assert.equal((await b.owner.agent.get('/api/orders')).body.total, 0);
    assert.equal((await b.owner.agent.get('/api/tasks?filter=all')).body.tasks.length, 0);
    // Linking another company's customer to an order or deal is rejected.
    assert.equal((await b.owner.call('post', '/api/orders', { contactId: cust.id, items: [{ name: 'x', quantity: 1, unitPrice: 1 }] })).status, 400);
    assert.equal((await b.owner.call('post', '/api/deals', { title: 'x', contactId: cust.id })).status, 400);
    // Database layer: no context sees nothing.
    for (const table of ['contact_notes', 'pipeline_stages', 'deals', 'orders', 'order_items', 'tasks']) {
      assert.equal((await h.getDb().withContext({}, trx => trx(table))).length, 0, table);
    }
    void request;
  });
  test('dashboard: real figures, permission-scoped blocks, tenant isolation', async () => {
    const a = await company('Acme');
    const b = await company('Beta');
    const c1 = (await a.owner.call('post', '/api/customers', { displayName: 'Lina', status: 'lead' })).body.customer;
    await a.owner.call('post', '/api/customers', { displayName: 'Sami', status: 'new' });
    await b.owner.call('post', '/api/customers', { displayName: 'Other tenant' });
    await a.owner.call('post', '/api/orders', { contactId: c1.id, items: [{ name: 'Item', quantity: 2, unitPrice: 50 }], shipping: 0 });
    await a.owner.call('post', '/api/tasks', { title: 'Call Lina', contactId: c1.id, dueAt: new Date(Date.now() + 3600e3).toISOString() });

    const d = await a.owner.agent.get('/api/dashboard?days=30');
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.labels.length, 30);
    assert.equal(d.body.kpis.customers.value, 2, 'other tenant not counted');
    assert.equal(d.body.kpis.conversion.value, 50, 'Lina became a customer by ordering');
    assert.ok(d.body.kpis.sales.value >= 100, 'order total');
    assert.equal(d.body.kpis.sales.series.reduce((x, y) => x + y, 0), d.body.kpis.sales.value);
    assert.equal(d.body.topCustomers[0].name, 'Lina');
    assert.deepEqual(d.body.sources, [{ source: 'manual', count: 2 }]);
    assert.equal(d.body.tasks[0].title, 'Call Lina');
    assert.ok(d.body.activity.some(e => e.type === 'order'));
    assert.ok(!JSON.stringify(d.body).includes('Other tenant'));

    const y = await a.owner.agent.get('/api/dashboard?days=365');
    assert.equal(y.body.unit, 'month');
    assert.equal(y.body.labels.length, 12);
    assert.equal(y.body.kpis.customers.added, 2);

    await h.addMember(a.companyId, 'employee', 'emp@acme.test');
    const e = await session('emp@acme.test');
    const ed = await e.agent.get('/api/dashboard');
    assert.equal(ed.status, 200);
    assert.equal(ed.body.kpis.sales, undefined, 'no revenue without reports.financial');
    assert.equal(ed.body.topCustomers, undefined);
    assert.equal(ed.body.kpis.conversations, undefined);
    assert.ok(ed.body.kpis.customers, 'employees can view customers');
    assert.ok(ed.body.activity.every(x => x.value === undefined), 'no amounts in activity');
    assert.deepEqual(ed.body.tasks, [], 'only own tasks');
  });
});
