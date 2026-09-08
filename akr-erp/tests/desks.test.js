'use strict';
/*
 * What each desk may reach, and what each desk may see of the money.
 *
 * The rules are not decoration. A driver's delivery note carries quantities and
 * part numbers and no prices; the sales officer works to a price list and never
 * sees what the manufacturer charged; the books belong to accounts and the key
 * account manager. If any of that stops being true, this file fails.
 */
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv, start } = require('./helpers');

freshEnv('desks');
require('../src/db/seed');

let h;
let admin;
let logistics;
let sales;
let accounts;
let kam;
let ctx = {};

test.before(async () => {
  h = await start();
  admin = await h.signIn('admin@akr365.com');
  logistics = await h.signIn('logistics@akr365.com');
  sales = await h.signIn('sales@akr365.com');
  accounts = await h.signIn('accounts@akr365.com');
  kam = await h.signIn('kam@akr365.com');

  ctx.client = (await admin.get('/api/partners?type=client&limit=1')).rows[0];
  ctx.supplier = (await admin.get('/api/partners?type=supplier&limit=1')).rows[0];
  ctx.item = (await admin.get('/api/items?limit=1')).rows[0];
});

test.after(async () => { if (h) await h.stop(); });

test('every desk signs in and is told what it may see', () => {
  assert.equal(logistics.me.permissions.seesPrices, false);
  assert.equal(logistics.me.permissions.seesMoney, false);
  assert.equal(sales.me.permissions.seesPrices, true);
  assert.equal(sales.me.permissions.seesCost, false, 'a sales officer works to a price list');
  assert.equal(accounts.me.permissions.seesMoney, true);
  assert.equal(kam.me.permissions.seesCost, true, 'the KAM sets the price and needs the cost');
});

test('logistics see the catalogue without any prices on it', async () => {
  const res = await logistics.get('/api/items?limit=3');
  for (const row of res.rows) {
    assert.equal(row.cost_price, null);
    assert.equal(row.sell_price, null);
  }
  // And the stock register, which is their screen, still works in full.
  const stock = await logistics.get('/api/stock?limit=5');
  assert.ok(Array.isArray(stock.rows));
  assert.equal(stock.summary, null, 'no valuation for a desk that may not see cost');
});

test('a sales officer sees the price but not the cost behind it', async () => {
  const quote = await sales.post('/api/sales/quotations', {
    partner_id: ctx.client.id,
    items: [{ item_id: ctx.item.id, qty: 3, unit_price: 900, cost_price: 600 }],
  });
  const seenBySales = await sales.get(`/api/sales/quotations/${quote.id}`);
  assert.equal(seenBySales.margin, null);
  assert.equal(seenBySales.items[0].cost_price, null);

  const seenByKam = await kam.get(`/api/sales/quotations/${quote.id}`);
  assert.equal(seenByKam.items[0].cost_price, 600);
  assert.equal(seenByKam.margin.margin, 900, '3 × (900 − 600)');
});

test('a desk cannot do another desk\'s work', async () => {
  // Logistics do not raise quotations to clients.
  await assert.rejects(
    () => logistics.post('/api/sales/quotations', {
      partner_id: ctx.client.id, items: [{ item_id: ctx.item.id, qty: 1, unit_price: 10 }],
    }),
    (err) => err.status === 403,
  );
  // Sales do not place orders with manufacturers.
  await assert.rejects(
    () => sales.post('/api/purchase/orders', {
      partner_id: ctx.supplier.id, items: [{ item_id: ctx.item.id, qty: 1, unit_price: 10 }],
    }),
    (err) => err.status === 403,
  );
  // And nobody but an administrator changes the masters.
  await assert.rejects(
    () => accounts.post('/api/masters/applications', { code: 'XX', name: 'Made up' }),
    (err) => err.status === 403,
  );
});

test('the books are not on a logistics screen', async () => {
  await assert.rejects(() => logistics.get('/api/accounts/payments'), (err) => err.status === 403);
  await assert.rejects(() => logistics.get('/api/accounts/ageing/receivable'), (err) => err.status === 403);
  await assert.rejects(() => logistics.get(`/api/partners/${ctx.client.id}/ledger`), (err) => err.status === 403);
});

test('an unauthenticated request gets nowhere', async () => {
  const anon = h.client();
  await assert.rejects(() => anon.get('/api/items'), (err) => err.status === 401);
  await assert.rejects(() => anon.get('/api/sales/invoices'), (err) => err.status === 401);
  // The health check stays open, so a load balancer can reach it.
  const health = await anon.get('/api/health');
  assert.equal(health.ok, true);
});

test('a mistyped TRN is caught before it reaches an invoice', async () => {
  await assert.rejects(
    () => kam.post('/api/partners', { name: 'Test Client', type: 'client', trn: '12345' }),
    (err) => err.status === 400 && /fifteen digits/.test(err.message),
  );
  const ok = await kam.post('/api/partners', {
    name: 'Test Client L.L.C', type: 'client', trn: '100123456700003',
  });
  assert.equal(ok.trn, '100123456700003');
});

test('the catalogue can be loaded from a spreadsheet, and reloaded without duplicating', async () => {
  const csv = [
    'item_code,name,category_code,application_code,subgroup,size,material,uom,cost_price,sell_price',
    ',Butterfly Valve — Wafer,VLP,PW,Butterfly Valve,DN250,Ductile Iron,NOS,1850,2400',
    ',Chequered Plate,MFW,PW,Chequered Plate,8 mm,"Mild Steel, HDG",SQM,320,410',
    ',No line for this one,,,,,,,,',
  ].join('\n');

  const dry = await kam.post('/api/items/import/csv', { csv, dryRun: true });
  assert.equal(dry.created, 2);
  assert.equal(dry.skipped.length, 1, 'the row with no product line is reported, not guessed at');

  const before = (await kam.get('/api/items?limit=1')).total;
  const run = await kam.post('/api/items/import/csv', { csv });
  assert.equal(run.created, 2);
  const after = (await kam.get('/api/items?limit=1')).total;
  assert.equal(after, before + 2);

  const found = await kam.get('/api/items?q=Chequered&limit=5');
  const plate = found.rows.find((r) => r.size === '8 mm');
  assert.ok(plate, 'the imported plate is in the catalogue');
  assert.match(plate.item_code, /^AKR-MFW-\d{5}$/, 'and was given a code in its own line');
  assert.equal(plate.subgroup_name, 'Chequered Plate', 'matched to the fabrication type by name');

  // Re-importing the same sheet with the codes updates rather than duplicating.
  const round2 = [
    'item_code,name,category_code,cost_price',
    `${plate.item_code},Chequered Plate,MFW,345`,
  ].join('\n');
  const again = await kam.post('/api/items/import/csv', { csv: round2 });
  assert.equal(again.updated, 1);
  assert.equal(again.created, 0);
  const reread = await kam.get(`/api/items/${plate.id}`);
  assert.equal(reread.item.cost_price, 345);
});

test('an adjustment needs a reason and cannot take out what is not there', async () => {
  await assert.rejects(
    () => logistics.post('/api/stock/adjustments', { item_id: ctx.item.id, qty: 5 }),
    (err) => err.status === 400 && /reason/i.test(err.message),
  );
  await assert.rejects(
    () => logistics.post('/api/stock/adjustments',
      { item_id: ctx.item.id, qty: -5, reason: 'Damaged' }),
    (err) => err.status === 400 && /only 0/.test(err.message),
  );
  const ok = await logistics.post('/api/stock/adjustments',
    { item_id: ctx.item.id, qty: 5, reason: 'Found unbooked in the yard' });
  assert.equal(ok.balance.on_hand, 5);
});

test('the last administrator cannot be demoted or locked out', async () => {
  const me = admin.me.user;
  await assert.rejects(
    () => admin.patch(`/api/admin/users/${me.id}`, { active: false }),
    (err) => err.status === 400 && /signed in with/.test(err.message),
  );
  await assert.rejects(
    () => admin.patch(`/api/admin/users/${me.id}`, { role: 'sales' }),
    (err) => err.status === 400 && /last administrator/.test(err.message),
  );
});

test('the VAT return and the profit are the administrator\'s alone', async () => {
  // The company's own decision: these two say what the business made and what
  // it owes, and they are not part of running a desk.
  for (const desk of [accounts, kam, sales, logistics]) {
    if (desk === admin) continue;
    await assert.rejects(() => desk.get('/api/accounts/vat-return'), (err) => err.status === 403);
    await assert.rejects(() => desk.get('/api/accounts/profit-and-loss'), (err) => err.status === 403);
  }
  const seen = await admin.get('/api/accounts/profit-and-loss');
  assert.ok(seen.group, 'the administrator sees it');
  assert.ok(seen.monthly, 'and gets it month by month');
});

test('a month\'s expenses come off that month\'s gross profit', async () => {
  const item = (await admin.get('/api/items?limit=1')).rows[0];
  const client = (await admin.get('/api/partners?type=client&limit=1')).rows[0];

  await admin.post('/api/stock/adjustments',
    { item_id: item.id, qty: 20, reason: 'Opening for the monthly profit test' });
  const order = await admin.post('/api/sales/orders', {
    partner_id: client.id, client_lpo_no: 'MONTHLY/1',
    items: [{ item_id: item.id, qty: 10, unit_price: 500, cost_price: 300 }],
  });
  const so = await admin.get(`/api/sales/orders/${order.id}`);
  const dn = await admin.post('/api/sales/deliveries', {
    partner_id: client.id, so_id: order.id, items: [{ so_item_id: so.items[0].id, qty: 10 }] });
  const invoice = await admin.post('/api/sales/invoices', {
    partner_id: client.id, so_id: order.id, dn_id: dn.id });

  const month = invoice.invoice_date.slice(0, 7);
  const before = await admin.get('/api/accounts/profit-and-loss?from=2000-01-01&to=2100-01-01');
  const rowBefore = before.monthly.rows.find((r) => r.month === month);
  assert.equal(rowBefore.gross_profit, 2000, '10 × (500 − 300)');
  assert.equal(rowBefore.net_profit, rowBefore.gross_profit - rowBefore.expenses);

  // The month's overheads, entered in one sitting the way the company does it.
  const spentBefore = rowBefore.expenses;
  for (const [description, amount] of [['Yard rent', 9000], ['Salaries', 22000], ['Fuel', 1400]]) {
    await admin.post('/api/accounts/expenses', {
      description, amount, expense_date: invoice.invoice_date, mode: 'bank_transfer' });
  }

  const after = await admin.get('/api/accounts/profit-and-loss?from=2000-01-01&to=2100-01-01');
  const rowAfter = after.monthly.rows.find((r) => r.month === month);
  assert.equal(rowAfter.gross_profit, rowBefore.gross_profit, 'the gross profit is untouched');
  assert.equal(rowAfter.expenses, spentBefore + 32400, "the month's overheads are all in");
  assert.equal(rowAfter.net_profit, rowAfter.gross_profit + rowAfter.other_income - rowAfter.expenses,
    'and the final figure is the gross less them');
  assert.ok(rowAfter.expenses_booked, 'the month is marked as having its expenses entered');
});
