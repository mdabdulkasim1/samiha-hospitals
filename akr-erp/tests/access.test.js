'use strict';
/*
 * Who may open what.
 *
 * A desk sets what somebody starts with; the administrator adjusts it person by
 * person. The rule these hold is the one that makes the feature safe: a screen
 * grant says what may be OPENED, and the desk still says what may be DONE.
 * Granting somebody the payments screen lets them read it, never book on it.
 */
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv, start } = require('./helpers');

freshEnv('access');
require('../src/db/seed');

const screens = require('../src/services/screens');

let h;
let admin;
let sales;
const ctx = {};

test.before(async () => {
  h = await start();
  admin = await h.signIn('admin@akr365.com');
  sales = await h.signIn('sales@akr365.com');
  ctx.salesUser = (await admin.get('/api/admin/users')).rows.find((u) => u.role === 'sales');
});

test.after(async () => { if (h) await h.stop(); });

test('the sales desk carries both sides of the trade', () => {
  const s = screens.forRole('sales');
  for (const id of ['enquiries', 'quotations', 'orders', 'deliveries', 'invoices']) {
    assert.ok(s.includes(id), `selling: ${id}`);
  }
  for (const id of ['supplier-enquiries', 'supplier-quotations', 'purchase-orders', 'goods-receipts']) {
    assert.ok(s.includes(id), `buying: ${id}`);
  }
  // The money stays with the desks that answer for it, until somebody says so.
  for (const id of ['payments', 'cheques', 'expenses', 'ledgers', 'vat', 'staff', 'supplier-bills']) {
    assert.ok(!s.includes(id), `${id} is not on the sales desk by default`);
  }
});

test('what somebody may open comes back with their session', async () => {
  const me = await sales.get('/api/auth/me');
  assert.ok(Array.isArray(me.screens));
  assert.ok(me.screens.includes('purchase-orders'), 'the buying side, as the desk now gives it');
  assert.ok(!me.screens.includes('vat'));
});

test('the administrator can grant a screen to one person', async () => {
  const before = await admin.get(`/api/admin/users/${ctx.salesUser.id}/screens`);
  assert.ok(!before.allowed.includes('vat'));

  await assert.rejects(() => sales.get('/api/accounts/vat-return'),
    (err) => err.status === 403, 'refused before the grant');

  const after = await admin.put(`/api/admin/users/${ctx.salesUser.id}/screens`,
    { screens: [...before.allowed, 'vat'] });
  assert.ok(after.allowed.includes('vat'));
  assert.equal(after.overrides.vat, true, 'kept as an exception to the desk, not a copy of it');

  const reopened = await h.signIn('sales@akr365.com');
  assert.ok((await reopened.get('/api/auth/me')).screens.includes('vat'));
  const pl = await reopened.get('/api/accounts/profit-and-loss');
  assert.ok(pl.group, 'and the screen actually opens');
});

test('a granted screen does not widen what they may do', async () => {
  const desk = await h.signIn('sales@akr365.com');
  // They were given the profit page above; they still cannot touch the money.
  await assert.rejects(() => desk.post('/api/accounts/expenses',
    { description: 'Not theirs to book', amount: 10 }), (err) => err.status === 403);
  await assert.rejects(() => desk.post('/api/accounts/payments',
    { direction: 'out', amount: 10 }), (err) => err.status === 403);
});

test('a screen can be taken away as well as given', async () => {
  const current = await admin.get(`/api/admin/users/${ctx.salesUser.id}/screens`);
  const without = current.allowed.filter((id) => id !== 'purchase-orders');
  const after = await admin.put(`/api/admin/users/${ctx.salesUser.id}/screens`, { screens: without });
  assert.ok(!after.allowed.includes('purchase-orders'));
  assert.equal(after.overrides['purchase-orders'], false, 'recorded as taken away from the desk');

  await admin.put(`/api/admin/users/${ctx.salesUser.id}/screens`, { reset: true });
  const reset = await admin.get(`/api/admin/users/${ctx.salesUser.id}/screens`);
  assert.deepEqual(reset.allowed, screens.forRole('sales'), 'and can be put back to the desk');
  assert.deepEqual(reset.overrides, {}, 'with nothing left frozen against them');
});

test('nobody can be locked out of their own account', async () => {
  const after = await admin.put(`/api/admin/users/${ctx.salesUser.id}/screens`, { screens: [] });
  assert.deepEqual(after.allowed, ['account'],
    'everything can go except the screen where they change their own password');
  await admin.put(`/api/admin/users/${ctx.salesUser.id}/screens`, { reset: true });
});

test('the access list is the administrator\'s alone to change', async () => {
  const desk = await h.signIn('sales@akr365.com');
  await assert.rejects(() => desk.get(`/api/admin/users/${ctx.salesUser.id}/screens`),
    (err) => err.status === 403, 'they cannot even read it without the Staff screen');

  // Given the Staff screen, they may read it — and still not change it, or
  // granting Staff would be granting everything.
  await admin.put(`/api/admin/users/${ctx.salesUser.id}/screens`,
    { screens: [...screens.forRole('sales'), 'staff'] });
  const granted = await h.signIn('sales@akr365.com');
  assert.ok((await granted.get('/api/admin/users')).rows.length, 'the list opens');
  await assert.rejects(() => granted.put(`/api/admin/users/${ctx.salesUser.id}/screens`,
    { screens: screens.ALL }), (err) => err.status === 403, 'but nobody grants themselves the rest');
  await assert.rejects(() => granted.post('/api/admin/users',
    { name: 'X', email: 'x@y.z', role: 'admin', password: 'abcd1234' }), (err) => err.status === 403);
  await admin.put(`/api/admin/users/${ctx.salesUser.id}/screens`, { reset: true });
});
