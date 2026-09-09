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
  assert.equal(rowBefore.trading_margin, 2000, '10 × (500 − 300)');
  assert.equal(rowBefore.gross_profit, rowBefore.trading_margin - rowBefore.expenses,
    "the month's gross profit is already net of whatever has been spent");

  // The month's overheads, entered in one sitting the way the company does it.
  const spentBefore = rowBefore.expenses;
  for (const [description, amount] of [['Yard rent', 9000], ['Salaries', 22000], ['Fuel', 1400]]) {
    await admin.post('/api/accounts/expenses', {
      description, amount, expense_date: invoice.invoice_date, mode: 'bank_transfer' });
  }

  const after = await admin.get('/api/accounts/profit-and-loss?from=2000-01-01&to=2100-01-01');
  const rowAfter = after.monthly.rows.find((r) => r.month === month);
  assert.equal(rowAfter.trading_margin, rowBefore.trading_margin, 'the margin on the goods is untouched');
  assert.equal(rowAfter.expenses, spentBefore + 32400, "the month's overheads are all in");
  assert.equal(rowAfter.gross_profit,
    rowAfter.trading_margin + rowAfter.other_income - rowAfter.expenses,
    'and the gross profit is the margin less this month\'s expenses');
  assert.equal(rowAfter.gross_profit, rowBefore.gross_profit - 32400,
    'so entering the month\'s overheads moves the gross profit down by exactly them');
  assert.ok(rowAfter.expenses_booked, 'the month is marked as having its expenses entered');
});

test('the profit page names every client and every manufacturer', async () => {
  const pl = await admin.get('/api/accounts/profit-and-loss?from=2000-01-01&to=2100-01-01');

  // Every trading account is listed, quiet ones included: the owner asked for
  // the names, not only for the ones that happened to trade this period.
  const clients = await admin.get('/api/partners?type=client&limit=500');
  const suppliers = await admin.get('/api/partners?type=supplier&limit=500');
  for (const c of clients.rows) {
    assert.ok(pl.clients.some((r) => r.id === c.id), `${c.name} is on the revenue list`);
  }
  for (const sup of suppliers.rows) {
    assert.ok(pl.suppliers.some((r) => r.id === sup.id), `${sup.name} is on the cost list`);
  }

  // The client revenue adds up to what the group made.
  const revenue = pl.clients.reduce((a, r) => a + r.revenue, 0);
  assert.equal(Math.round(revenue * 100) / 100, pl.group.revenue,
    'client by client, it comes to the group figure');
  const cost = pl.clients.reduce((a, r) => a + r.cost_of_sales, 0);
  assert.equal(Math.round(cost * 100) / 100, pl.group.cost_of_sales);

  // And the expenses column reconciles, because whatever is not booked to a
  // supplier is shown as exactly that rather than left out.
  const expenses = pl.suppliers.reduce((a, r) => a + r.expenses, 0);
  assert.equal(Math.round(expenses * 100) / 100, pl.group.expenses,
    'overheads booked to nobody are still on the list');

  const traded = pl.clients.find((r) => r.revenue > 0);
  assert.ok(traded, 'the client we invoiced is there');
  assert.equal(traded.margin, traded.revenue - traded.cost_of_sales);
  assert.ok(traded.traded, 'and is marked as having traded');
  assert.ok(pl.clients.some((r) => !r.traded), 'as are the ones that did not');
});

test('what a manufacturer cost us is their bills plus what was booked to them', async () => {
  const supplier = (await admin.get('/api/partners?type=supplier&limit=1')).rows[0];
  const before = (await admin.get('/api/accounts/profit-and-loss?from=2000-01-01&to=2100-01-01'))
    .suppliers.find((r) => r.id === supplier.id);

  await admin.post('/api/accounts/expenses', {
    description: 'Third-party testing at the works', amount: 1200,
    partner_id: supplier.id, mode: 'bank_transfer' });

  const after = (await admin.get('/api/accounts/profit-and-loss?from=2000-01-01&to=2100-01-01'))
    .suppliers.find((r) => r.id === supplier.id);
  assert.equal(after.expenses, before.expenses + 1200, 'the expense lands on their row');
  assert.equal(after.billed, before.billed, 'what they invoiced is untouched');
  assert.equal(after.total_cost, after.billed + after.expenses,
    'and the cost to us is the two together');
});

test("the bottom line reads the owner's own formula", async () => {
  const pl = await admin.get('/api/accounts/profit-and-loss?from=2000-01-01&to=2100-01-01');
  const st = pl.statement;

  // selling price − buying price − buying overheads − selling overheads
  //   − AKR's own overheads (+ other income) = gross profit
  const gross = st.selling_price - st.buying_price - st.buying_overheads
    - st.selling_overheads - st.general_overheads + st.other_income;
  assert.equal(Math.round(gross * 100) / 100, st.gross_profit, 'the gross profit is the deduction');
  assert.equal(Math.round((st.gross_profit - st.vat) * 100) / 100, st.net_profit,
    'and VAT off the gross is the net');

  // Each term is the thing it says it is.
  assert.equal(st.selling_price, pl.group.revenue);
  assert.equal(st.buying_price, pl.group.cost_of_sales);
  const overheads = Math.round(
    (st.buying_overheads + st.selling_overheads + st.general_overheads) * 100) / 100;
  assert.equal(overheads, pl.group.expenses,
    'every overhead is on exactly one of the three lines');

  const vat = await admin.get('/api/accounts/vat-return?from=2000-01-01&to=2100-01-01');
  assert.equal(st.vat, vat.net, 'the VAT line is the net payable for the period');
});

test('an overhead booked to nobody is spread pro rata across the accounts', async () => {
  const before = await admin.get('/api/accounts/profit-and-loss?from=2000-01-01&to=2100-01-01');
  await admin.post('/api/accounts/expenses',
    { description: 'Trade licence renewal', amount: 4000, mode: 'bank_transfer' });
  const after = await admin.get('/api/accounts/profit-and-loss?from=2000-01-01&to=2100-01-01');

  assert.equal(after.overheads, before.overheads + 4000, 'it lands in the pot to spread');
  const share = (rows) => Math.round(rows.reduce((a, r) => a + r.overhead_share, 0) * 100) / 100;
  assert.equal(share(after.clients), after.overheads,
    'the shares across clients come to the pot exactly');

  /*
   * The same pot is offered to the buy side as well — but only where there is
   * something to apportion on. Nothing was bought in this period here, so
   * nothing is spread and the pot stays visible as its own row rather than
   * being shared out on a basis that does not exist.
   */
  const billed = after.suppliers.reduce((a, r) => a + r.billed, 0);
  if (billed > 0) {
    assert.equal(share(after.suppliers), after.overheads, 'spread across the suppliers who traded');
  } else {
    assert.equal(share(after.suppliers), 0, 'nothing to apportion on, so nothing apportioned');
    const loose = after.suppliers.find((r) => r.unattributed);
    assert.ok(loose, 'and the pot is still on the page');
    assert.equal(loose.expenses, after.overheads);
  }

  // Pro rata: the account that traded most carries most of it.
  const traded = after.clients.filter((r) => r.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);
  if (traded.length > 1) {
    assert.ok(traded[0].overhead_share >= traded[1].overhead_share,
      'the bigger account carries the bigger share');
  }
  for (const r of after.clients) {
    assert.equal(r.contribution,
      Math.round((r.margin - r.expenses - r.overhead_share) * 100) / 100);
  }
});
