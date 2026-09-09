'use strict';
/*
 * The enquiry, on both sides of the trade.
 *
 * The company's rule on the buying side is that a manufacturer's quotation is
 * always the answer to an enquiry we raised — so there is a record of what was
 * asked, of whom, and when, including the makers who never came back. These
 * tests hold that rule, and hold the two sides apart: a client's enquiry is not
 * something a maker can quote against, and neither list shows the other's.
 */
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv, start } = require('./helpers');

freshEnv('enquiries');
require('../src/db/seed');

let h;
let admin;
let kam;
let sales;
let logistics;
let accounts;
const ctx = {};

test.before(async () => {
  h = await start();
  admin = await h.signIn('admin@akr365.com');
  kam = await h.signIn('kam@akr365.com');
  sales = await h.signIn('sales@akr365.com');
  logistics = await h.signIn('logistics@akr365.com');
  accounts = await h.signIn('accounts@akr365.com');
  ctx.supplier = (await admin.get('/api/partners?type=supplier&limit=1')).rows[0];
  ctx.other = (await admin.get('/api/partners?type=supplier&limit=2')).rows[1];
  ctx.client = (await admin.get('/api/partners?type=client&limit=1')).rows[0];
  ctx.item = (await admin.get('/api/items?limit=1')).rows[0];
});

test.after(async () => { if (h) await h.stop(); });

test('an enquiry to a manufacturer carries its own reference', async () => {
  const now = new Date();
  const mmyyyy = `${String(now.getMonth() + 1).padStart(2, '0')}${now.getFullYear()}`;
  ctx.rfq = await kam.post('/api/purchase/enquiries', {
    partner_id: ctx.supplier.id,
    subject: 'DN300 gate valves',
    project: 'Al Barsha reservoir',
    requirement: '12 no. DN300 PN16 resilient seated gate valves',
    due_on: '2026-12-31',
  });
  assert.match(ctx.rfq.enquiry_no, new RegExp(`^AKR-RFQ-${mmyyyy}-\\d{3}$`),
    'the RFQ series, not the client enquiry series');
  assert.equal(ctx.rfq.side, 'supplier');
  assert.equal(ctx.rfq.status, 'open');
});

test('the two sides do not show each other\'s enquiries', async () => {
  const clientSide = await sales.post('/api/sales/enquiries', {
    partner_id: ctx.client.id, subject: 'Fabrication for the pump room' });
  assert.match(clientSide.enquiry_no, /^AKR-ENQ-/);

  const ours = await kam.get('/api/purchase/enquiries?limit=200');
  const theirs = await sales.get('/api/sales/enquiries?limit=200');
  assert.ok(ours.rows.every((r) => r.side === 'supplier'), 'the buy list is ours alone');
  assert.ok(theirs.rows.every((r) => r.side === 'client'), 'the sell list is theirs alone');
  assert.ok(ours.rows.some((r) => r.id === ctx.rfq.id));
  assert.ok(!ours.rows.some((r) => r.id === clientSide.id));
  ctx.clientEnquiry = clientSide;
});

test('no manufacturer quotation exists without an enquiry behind it', async () => {
  await assert.rejects(
    () => kam.post('/api/purchase/quotations', {
      partner_id: ctx.supplier.id,
      items: [{ item_id: ctx.item.id, qty: 12, unit_price: 640 }],
    }),
    (err) => err.status === 400 && /Raise the enquiry/.test(err.message),
  );
});

test('a client\'s enquiry cannot be answered by a manufacturer', async () => {
  await assert.rejects(
    () => kam.post('/api/purchase/quotations', {
      partner_id: ctx.supplier.id, enquiry_id: ctx.clientEnquiry.id,
      items: [{ item_id: ctx.item.id, qty: 1, unit_price: 10 }],
    }),
    (err) => err.status === 404,
  );
});

test('a price is refused against an enquiry raised with somebody else', async () => {
  await assert.rejects(
    () => kam.post('/api/purchase/quotations', {
      partner_id: ctx.other.id, enquiry_id: ctx.rfq.id,
      items: [{ item_id: ctx.item.id, qty: 1, unit_price: 10 }],
    }),
    (err) => err.status === 400 && /raised with somebody else/.test(err.message),
  );
});

test('their price answers the enquiry, and takes its details', async () => {
  const quote = await kam.post('/api/purchase/quotations', {
    enquiry_id: ctx.rfq.id,
    supplier_ref: 'YESS/Q/2026/119',
    items: [{ item_id: ctx.item.id, qty: 12, unit_price: 640 }],
  });
  assert.equal(quote.enquiry_no, ctx.rfq.enquiry_no, 'the quotation names the enquiry');
  assert.equal(quote.partner_id, ctx.supplier.id, 'the maker is taken from the enquiry');
  assert.equal(quote.subject, 'DN300 gate valves', 'and so is what was asked about');
  assert.equal(quote.project, 'Al Barsha reservoir');
  assert.equal(quote.status, 'received');

  const after = await kam.get(`/api/purchase/enquiries/${ctx.rfq.id}`);
  assert.equal(after.enquiry.status, 'quoted', 'the enquiry is answered');
  assert.equal(after.quotations.length, 1, 'and lists the price that answered it');
  assert.equal(after.quotations[0].quote_no, quote.quote_no);
  ctx.quote = quote;
});

test('a closed enquiry takes no more prices', async () => {
  const closed = await kam.post('/api/purchase/enquiries', {
    partner_id: ctx.supplier.id, subject: 'Nothing came of it' });
  await kam.patch(`/api/purchase/enquiries/${closed.id}`, { status: 'closed' });
  await assert.rejects(
    () => kam.post('/api/purchase/quotations', {
      enquiry_id: closed.id, items: [{ item_id: ctx.item.id, qty: 1, unit_price: 10 }] }),
    (err) => err.status === 400 && /closed/.test(err.message),
  );
});

test('the enquiry is the first step of the trace, before the price', async () => {
  const res = await kam.get(`/api/reports/trace?ref=${encodeURIComponent(ctx.rfq.enquiry_no)}`);
  assert.equal(res.found.length, 1, 'the RFQ number finds itself, and only itself');
  assert.equal(res.matched.route, 'supplier-enquiries', 'and opens on the buying side');
  assert.equal(res.matched.label, 'Our enquiry to the maker', 'read as ours, not a client\'s');

  const refs = res.chain.steps.map((s) => s.ref);
  assert.equal(refs[0], ctx.rfq.enquiry_no, 'the story starts at the enquiry');
  assert.ok(refs.includes(ctx.quote.quote_no), 'and reaches the price that answered it');
});

test('a client enquiry with nothing behind it yet still traces', async () => {
  const res = await sales.get(
    `/api/reports/trace?ref=${encodeURIComponent(ctx.clientEnquiry.enquiry_no)}`);
  assert.equal(res.matched.route, 'enquiries', 'a client\'s opens on the selling side');
  assert.equal(res.chain.steps.length, 1, 'the enquiry is the whole story so far');
  assert.equal(res.chain.steps[0].ref, ctx.clientEnquiry.enquiry_no);
});

test('the LPO carries the enquiry, and prints it', async () => {
  await kam.post(`/api/purchase/quotations/${ctx.quote.id}/approve`);
  const lpo = await kam.post('/api/purchase/orders', {
    partner_id: ctx.supplier.id, quotation_id: ctx.quote.id,
    items: [{ item_id: ctx.item.id, qty: 8, unit_price: 1250 }],
  });
  const full = await kam.get(`/api/purchase/orders/${lpo.id}`);
  assert.equal(full.order.enquiry_no, ctx.rfq.enquiry_no,
    'the reference travels from the enquiry through the price onto the order');
  assert.equal(full.order.supplier_quote_no, ctx.quote.quote_no);
  assert.equal(full.order.supplier_quote_ref, 'YESS/Q/2026/119',
    "and the maker's own quotation number, which is what they file by");

  // It is on the list too, where somebody looks for it by eye.
  const listed = (await kam.get('/api/purchase/orders?limit=50')).rows
    .find((r) => r.id === lpo.id);
  assert.equal(listed.enquiry_no, ctx.rfq.enquiry_no);
  ctx.lpo = lpo;
});

test('an LPO raised without a quotation can still name the enquiry', async () => {
  const rfq = await kam.post('/api/purchase/enquiries', {
    partner_id: ctx.supplier.id, subject: 'Straight to order' });
  const lpo = await kam.post('/api/purchase/orders', {
    partner_id: ctx.supplier.id, enquiry_id: rfq.id,
    items: [{ item_id: ctx.item.id, qty: 2, unit_price: 90 }],
  });
  const full = await kam.get(`/api/purchase/orders/${lpo.id}`);
  assert.equal(full.order.enquiry_no, rfq.enquiry_no);

  await assert.rejects(
    () => kam.post('/api/purchase/orders', {
      partner_id: ctx.supplier.id, enquiry_id: ctx.clientEnquiry.id,
      items: [{ item_id: ctx.item.id, qty: 1, unit_price: 10 }] }),
    (err) => err.status === 404, "a client's enquiry is not ours to order against",
  );
});

test('the goods receipt and the bill carry it too', async () => {
  const lpoFull = await kam.get(`/api/purchase/orders/${ctx.lpo.id}`);
  await kam.post(`/api/purchase/orders/${ctx.lpo.id}/send`);
  const grn = await logistics.post('/api/purchase/grns', {
    partner_id: ctx.supplier.id, po_id: ctx.lpo.id, supplier_dn_ref: 'AMS-DN-5512',
    items: [{ po_item_id: lpoFull.items[0].id, qty: 8 }],
  });
  const grnFull = await logistics.get(`/api/purchase/grns/${grn.id}`);
  assert.equal(grnFull.grn.enquiry_no, ctx.rfq.enquiry_no, 'the receipt is filed under the enquiry');
  assert.equal((await logistics.get('/api/purchase/grns?limit=50')).rows
    .find((r) => r.id === grn.id).enquiry_no, ctx.rfq.enquiry_no, 'and shows it on the list');

  const bill = await accounts.post('/api/purchase/invoices', {
    partner_id: ctx.supplier.id, po_id: ctx.lpo.id, grn_id: grn.id,
    supplier_inv_no: 'AMS-2026-3391',
    items: [{ item_id: ctx.item.id, qty: 8, unit_price: 1250 }],
  });
  const billFull = await accounts.get(`/api/purchase/invoices/${bill.id}`);
  assert.equal(billFull.invoice.enquiry_no, ctx.rfq.enquiry_no, 'so is their invoice');
  assert.equal((await accounts.get('/api/purchase/invoices?limit=50')).rows
    .find((r) => r.id === bill.id).enquiry_no, ctx.rfq.enquiry_no);
});

test('a receipt or a bill with no order behind it can still name the enquiry', async () => {
  const rfq = await kam.post('/api/purchase/enquiries', {
    partner_id: ctx.supplier.id, subject: 'Straight in' });
  const grn = await logistics.post('/api/purchase/grns', {
    partner_id: ctx.supplier.id, enquiry_id: rfq.id,
    items: [{ item_id: ctx.item.id, qty: 3, description: 'Sample bar', uom: 'NOS' }],
  });
  assert.equal((await logistics.get(`/api/purchase/grns/${grn.id}`)).grn.enquiry_no, rfq.enquiry_no);

  // Booked against that receipt, with no LPO in between.
  const bill = await accounts.post('/api/purchase/invoices', {
    partner_id: ctx.supplier.id, grn_id: grn.id, supplier_inv_no: 'AMS-2026-3392',
    items: [{ item_id: ctx.item.id, qty: 3, unit_price: 40 }],
  });
  assert.equal((await accounts.get(`/api/purchase/invoices/${bill.id}`)).invoice.enquiry_no,
    rfq.enquiry_no, 'the bill takes it from the receipt');

  await assert.rejects(
    () => accounts.post('/api/purchase/invoices', {
      partner_id: ctx.supplier.id, enquiry_id: ctx.clientEnquiry.id,
      supplier_inv_no: 'AMS-2026-3393',
      items: [{ item_id: ctx.item.id, qty: 1, unit_price: 5 }] }),
    (err) => err.status === 404, "a client's enquiry is not something a bill belongs to",
  );
});

test('the payment voucher carries the enquiries it pays', async () => {
  const bill = (await accounts.get('/api/purchase/invoices?limit=50')).rows
    .find((r) => r.enquiry_no === ctx.rfq.enquiry_no);
  assert.ok(bill, 'the bill under this enquiry is there to pay');

  const voucher = await accounts.post('/api/accounts/payments', {
    direction: 'out', partner_id: ctx.supplier.id, amount: bill.total,
    mode: 'bank_transfer', reference: 'TT-88213',
    allocations: [{ invoice_side: 'purchase', invoice_id: bill.id, amount: bill.total }],
  });
  const full = await accounts.get(`/api/accounts/payments/${voucher.id}`);
  assert.equal(full.allocations.length, 1);
  assert.equal(full.allocations[0].enquiry_no, ctx.rfq.enquiry_no,
    'each line of the voucher says which job the money is for');

  const listed = (await accounts.get('/api/accounts/payments?limit=50')).rows
    .find((r) => r.id === voucher.id);
  assert.match(listed.allocated_enquiries || '', new RegExp(ctx.rfq.enquiry_no),
    'and the list shows it without opening the voucher');
});

test('an advance names the enquiry itself, having no invoice to name', async () => {
  const rfq = await kam.post('/api/purchase/enquiries', {
    partner_id: ctx.supplier.id, subject: 'Mobilisation advance' });
  const voucher = await accounts.post('/api/accounts/payments', {
    direction: 'out', partner_id: ctx.supplier.id, amount: 5000, kind: 'advance',
    mode: 'cheque', cheque_no: '004599', enquiry_id: rfq.id,
  });
  const full = await accounts.get(`/api/accounts/payments/${voucher.id}`);
  assert.equal(full.payment.enquiry_no, rfq.enquiry_no);
  assert.equal(full.allocations.length, 0, 'it settles nothing yet, and still says what it is for');

  await assert.rejects(
    () => accounts.post('/api/accounts/payments', {
      direction: 'out', partner_id: ctx.supplier.id, amount: 100,
      enquiry_id: ctx.clientEnquiry.id }),
    (err) => err.status === 404, "money out does not belong to a client's enquiry",
  );
});

test("a client's receipt reaches back to their own enquiry", async () => {
  // The sell side keeps the enquiry on the quotation, so the receipt has to
  // walk order → quotation to find it. Worth holding: it is the one chain here
  // that is not a column on the document.
  const client = ctx.client;
  const enquiry = await sales.post('/api/sales/enquiries', {
    partner_id: client.id, subject: 'Fabrication, block C' });
  const quote = await sales.post('/api/sales/quotations', {
    partner_id: client.id, enquiry_id: enquiry.id,
    items: [{ item_id: ctx.item.id, qty: 4, unit_price: 700, cost_price: 400 }],
  });
  const order = await sales.post('/api/sales/orders', {
    partner_id: client.id, quotation_id: quote.id, client_lpo_no: 'CLI/LPO/77',
    items: [{ item_id: ctx.item.id, qty: 4, unit_price: 700, cost_price: 400 }],
  });
  await admin.post('/api/stock/adjustments',
    { item_id: ctx.item.id, qty: 10, reason: 'Opening for the receipt test' });
  const so = await sales.get(`/api/sales/orders/${order.id}`);
  const dn = await logistics.post('/api/sales/deliveries', {
    partner_id: client.id, so_id: order.id, items: [{ so_item_id: so.items[0].id, qty: 4 }] });
  const invoice = await accounts.post('/api/sales/invoices',
    { partner_id: client.id, so_id: order.id, dn_id: dn.id });

  const receipt = await accounts.post('/api/accounts/payments', {
    direction: 'in', partner_id: client.id, amount: invoice.total, mode: 'cheque',
    cheque_no: '112233',
    allocations: [{ invoice_side: 'sales', invoice_id: invoice.id, amount: invoice.total }],
  });
  const full = await accounts.get(`/api/accounts/payments/${receipt.id}`);
  assert.equal(full.allocations[0].enquiry_no, enquiry.enquiry_no,
    "the receipt voucher names the client's own enquiry");
});

test('the whole chain reads from the enquiry to the order', async () => {
  const res = await kam.get(`/api/reports/trace?ref=${encodeURIComponent(ctx.lpo.lpo_no)}`);
  const refs = res.chain.steps.map((s) => s.ref);
  assert.equal(refs[0], ctx.rfq.enquiry_no, 'searching the LPO still starts at the enquiry');
  assert.ok(refs.includes(ctx.quote.quote_no));
  assert.ok(refs.includes(ctx.lpo.lpo_no));
});

test('the buying desks may raise one; the others may not', async () => {
  const body = { partner_id: ctx.supplier.id, subject: 'Desk test' };
  const mine = await kam.post('/api/purchase/enquiries', body);
  assert.ok(mine.enquiry_no);
  for (const desk of [sales, logistics]) {
    await assert.rejects(() => desk.post('/api/purchase/enquiries', body),
      (err) => err.status === 403);
  }
  // Reading them is another matter: the desks that see the buy side see these.
  assert.ok((await logistics.get('/api/purchase/enquiries?limit=5')).rows.length >= 0);
});
