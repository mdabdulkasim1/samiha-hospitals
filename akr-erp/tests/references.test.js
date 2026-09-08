'use strict';
/*
 * References, and following them.
 *
 * The company's own shapes are already on paper that suppliers and clients
 * hold — AKR-FD26-016 for an LPO, AKR-SO-082026-014 for a client's order — so
 * the system follows them rather than renumbering everything. And a reference
 * is only worth having if, a year later, somebody can type it in and be shown
 * the whole story.
 */
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv, start } = require('./helpers');

freshEnv('references');
require('../src/db/seed');

let h;
let admin;
let sales;
let ctx = {};

test.before(async () => {
  h = await start();
  admin = await h.signIn('admin@akr365.com');
  sales = await h.signIn('sales@akr365.com');
  ctx.supplier = (await admin.get('/api/partners?type=supplier&limit=1')).rows[0];
  ctx.client = (await admin.get('/api/partners?type=client&limit=1')).rows[0];
  ctx.item = (await admin.get('/api/items?limit=1')).rows[0];
});

test.after(async () => { if (h) await h.stop(); });

const thisYear = String(new Date().getFullYear());
const yy = thisYear.slice(-2);
const mmyyyy = `${String(new Date().getMonth() + 1).padStart(2, '0')}${thisYear}`;

test('the reference shapes are the company\'s own', async () => {
  const quote = await admin.post('/api/purchase/quotations', {
    partner_id: ctx.supplier.id, items: [{ item_id: ctx.item.id, qty: 2, unit_price: 100 }],
  });
  await admin.post(`/api/purchase/quotations/${quote.id}/approve`);
  const lpo = await admin.post('/api/purchase/orders', {
    partner_id: ctx.supplier.id, quotation_id: quote.id,
    items: [{ item_id: ctx.item.id, qty: 2, unit_price: 100 }],
  });
  // AKR-FD26-016
  assert.match(lpo.lpo_no, new RegExp(`^AKR-FD${yy}-\\d{3}$`));

  const order = await admin.post('/api/sales/orders', {
    partner_id: ctx.client.id, client_lpo_no: 'CLIENT/1',
    items: [{ item_id: ctx.item.id, qty: 1, unit_price: 200 }],
  });
  // AKR-SO-082026-014
  assert.match(order.so_no, new RegExp(`^AKR-SO-${mmyyyy}-\\d{3}$`));
  ctx.lpo = lpo;
  ctx.order = order;
});

test('every kind of document carries its own series', async () => {
  const series = await admin.get('/api/masters/document-numbers');
  assert.equal(series.rows.length, 14, 'every document is numbered');
  for (const row of series.rows) {
    assert.ok(row.next_reference, `${row.doc_kind} has a reference`);
    assert.ok(/\{n(:\d+)?\}/.test(row.pattern), `${row.doc_kind} has a serial in its pattern`);
    assert.ok(row.next_reference.startsWith('AKR-'), `${row.doc_kind} is stamped with the company`);
  }
  // No two series produce the same reference.
  const refs = series.rows.map((r) => r.next_reference);
  assert.equal(new Set(refs).size, refs.length, 'no two documents could share a reference');
});

test('a series is gap-free and never repeats', async () => {
  const seen = new Set();
  for (let i = 0; i < 5; i += 1) {
    const e = await sales.post('/api/sales/enquiries', { partner_id: ctx.client.id, subject: `E${i}` });
    assert.ok(!seen.has(e.enquiry_no), 'a reference is never issued twice');
    seen.add(e.enquiry_no);
  }
  const numbers = [...seen].map((r) => Number(r.split('-').pop())).sort((a, b) => a - b);
  for (let i = 1; i < numbers.length; i += 1) {
    assert.equal(numbers[i], numbers[i - 1] + 1, 'and the series has no gaps');
  }
});

test('a series that carries a month counts within it; the LPO counts by year', async () => {
  const series = await admin.get('/api/masters/document-numbers');
  for (const row of series.rows) {
    const carriesMonth = /\{(mm|mmyyyy|yyyymm)\}/.test(row.pattern);
    assert.equal(row.reset_on, carriesMonth ? 'monthly' : 'yearly',
      `${row.doc_kind} restarts on whatever its reference actually names`);
  }
  const lpo = series.rows.find((r) => r.doc_kind === 'purchaseOrder');
  assert.equal(lpo.reset_on, 'yearly', 'its reference names a year and no month');
  assert.match(lpo.note || '', /Fabrication Division/, 'and FD is written down, not left as a riddle');
  assert.equal(series.rows.filter((r) => r.reset_on === 'monthly').length, 13);
});

test('a serial cannot be made to restart on something the reference does not say', async () => {
  // Monthly, on a pattern naming no month: January's 001 and February's 001.
  await assert.rejects(
    () => admin.raw('PUT', '/api/masters/document-numbers/purchaseOrder',
      { pattern: '{company}-FD{yy}-{n:3}', reset_on: 'monthly' }),
    (err) => err.status === 400 && /names no month/.test(err.message),
  );
  // Monthly, with a month but no year: August 2026 and August 2027.
  await assert.rejects(
    () => admin.raw('PUT', '/api/masters/document-numbers/salesQuotation',
      { pattern: '{company}-QT-{mm}-{n:3}', reset_on: 'monthly' }),
    (err) => err.status === 400 && /names no year/.test(err.message),
  );
  // Yearly, with no year at all.
  await assert.rejects(
    () => admin.raw('PUT', '/api/masters/document-numbers/deliveryNote',
      { pattern: '{company}-DN-{n:4}', reset_on: 'yearly' }),
    (err) => err.status === 400 && /names no year/.test(err.message),
  );
});

test('every month-bearing series counts from one again each month', async () => {
  const numbering = require('../src/services/numbering');
  const aug = new Date('2028-08-15T00:00:00Z');
  const sep = new Date('2028-09-15T00:00:00Z');
  for (const kind of ['salesInvoice', 'deliveryNote', 'salesQuotation', 'grn', 'receipt']) {
    const first = numbering.next(null, 'AKR', kind, aug);
    const second = numbering.next(null, 'AKR', kind, aug);
    const next = numbering.next(null, 'AKR', kind, sep);
    assert.ok(first.endsWith('-001'), `${kind} starts at 001`);
    assert.ok(second.endsWith('-002'));
    assert.ok(next.endsWith('-001'), `${kind} starts again the next month`);
    assert.ok(first.includes('082028') && next.includes('092028'),
      `${kind} says which month it belongs to`);
  }
});

test('two months of sales orders each count from one', async () => {
  // Straight at the numbering, because the API can only issue for today.
  const numbering = require('../src/services/numbering');
  const august = new Date('2027-08-15T00:00:00Z');
  const september = new Date('2027-09-15T00:00:00Z');

  const first = numbering.next(null, 'AKR', 'salesOrder', august);
  const second = numbering.next(null, 'AKR', 'salesOrder', august);
  const third = numbering.next(null, 'AKR', 'salesOrder', september);

  assert.equal(first, 'AKR-SO-082027-001');
  assert.equal(second, 'AKR-SO-082027-002');
  assert.equal(third, 'AKR-SO-092027-001', 'September starts again at one');

  // The LPO, counting through its year, does not.
  const janLpo = numbering.next(null, 'AKR', 'purchaseOrder', new Date('2027-01-10T00:00:00Z'));
  const junLpo = numbering.next(null, 'AKR', 'purchaseOrder', new Date('2027-06-10T00:00:00Z'));
  assert.equal(janLpo, 'AKR-FD27-001');
  assert.equal(junLpo, 'AKR-FD27-002', 'the same series runs through the year');
});

test('a series can be continued from a number already on paper', async () => {
  const saved = await admin.raw('PUT', '/api/masters/document-numbers/purchaseOrder', {
    pattern: `{company}-FD{yy}-{n:3}`, reset_on: 'yearly', next_number: 200,
  });
  assert.equal(saved.next_reference, `AKR-FD${yy}-200`);

  const quote = await admin.post('/api/purchase/quotations', {
    partner_id: ctx.supplier.id, items: [{ item_id: ctx.item.id, qty: 1, unit_price: 50 }],
  });
  await admin.post(`/api/purchase/quotations/${quote.id}/approve`);
  const lpo = await admin.post('/api/purchase/orders', {
    partner_id: ctx.supplier.id, quotation_id: quote.id,
    items: [{ item_id: ctx.item.id, qty: 1, unit_price: 50 }],
  });
  assert.equal(lpo.lpo_no, `AKR-FD${yy}-200`);
});

test('a series is never wound back onto numbers already issued', async () => {
  const res = await admin.raw('PUT', '/api/masters/document-numbers/purchaseOrder', {
    pattern: `{company}-FD{yy}-{n:3}`, reset_on: 'yearly', next_number: 5,
  });
  assert.equal(res.carried.ok, false, 'refused');
  assert.match(res.carried.message, /already been issued/);
  assert.equal(res.next_reference, `AKR-FD${yy}-201`, 'and it carries on from where it was');
});

test('a pattern without a serial is refused', async () => {
  await assert.rejects(
    () => admin.raw('PUT', '/api/masters/document-numbers/purchaseOrder',
      { pattern: '{company}-FIXED' }),
    (err) => err.status === 400 && /\{n\}/.test(err.message),
  );
});

test('a reference can be followed through everything it touched', async () => {
  // A whole trade, both sides.
  const quote = await admin.post('/api/sales/quotations', {
    partner_id: ctx.client.id, items: [{ item_id: ctx.item.id, qty: 3, unit_price: 300 }],
  });
  const order = await admin.post('/api/sales/orders', {
    partner_id: ctx.client.id, quotation_id: quote.id, client_lpo_no: 'ASC/LPO/2026/7788',
    items: [{ item_id: ctx.item.id, qty: 3, unit_price: 300 }],
  });
  const so = await admin.get(`/api/sales/orders/${order.id}`);
  await admin.post('/api/stock/adjustments',
    { item_id: ctx.item.id, qty: 10, reason: 'Opening for the trace test' });
  const dn = await admin.post('/api/sales/deliveries', {
    partner_id: ctx.client.id, so_id: order.id,
    items: [{ so_item_id: so.items[0].id, qty: 3 }],
  });
  const invoice = await admin.post('/api/sales/invoices', {
    partner_id: ctx.client.id, so_id: order.id, dn_id: dn.id });
  await admin.post('/api/accounts/payments', {
    direction: 'in', partner_id: ctx.client.id, amount: invoice.total, mode: 'bank_transfer' });

  // From our invoice.
  const byInvoice = await admin.get(`/api/reports/trace?ref=${encodeURIComponent(invoice.invoice_no)}`);
  const refs = byInvoice.chain.steps.map((s) => s.ref);
  assert.ok(refs.includes(quote.quote_no), 'back to the quotation');
  assert.ok(refs.includes(order.so_no), 'through the order');
  assert.ok(refs.includes(dn.dn_no), 'the delivery');
  assert.ok(refs.includes(invoice.invoice_no), 'the invoice');
  assert.equal(byInvoice.chain.steps.filter((s) => s.label === 'They paid').length, 1, 'and the money');

  // And from the client's own LPO number, which is what they quote on the phone.
  const byTheirs = await admin.get('/api/reports/trace?ref=ASC%2FLPO%2F2026%2F7788');
  assert.equal(byTheirs.matched.kind, 'salesOrder');
  assert.ok(byTheirs.chain.steps.map((s) => s.ref).includes(invoice.invoice_no));
});

test('half a reference offers the candidates rather than guessing', async () => {
  const res = await admin.get(`/api/reports/trace?ref=FD${yy}`);
  assert.ok(res.found.length > 1, 'several answer to it');
  assert.equal(res.chain, null, 'so none is chosen for you');
});

test('a reference that means nothing says so', async () => {
  const res = await admin.get('/api/reports/trace?ref=NOTHING-AT-ALL-999');
  assert.equal(res.found.length, 0);
  assert.equal(res.chain, null);
});

test('a desk that may not see money is not shown it in a trace', async () => {
  const logistics = await h.signIn('logistics@akr365.com');
  const res = await logistics.get('/api/reports/trace?ref=ASC%2FLPO%2F2026%2F7788');
  assert.ok(res.chain.steps.length, 'the chain is theirs to follow');
  for (const step of res.chain.steps) assert.equal(step.amount, null, 'but not the figures');
});
