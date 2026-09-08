'use strict';
/*
 * The whole trade, both sides, through the API a screen would use.
 *
 * This is the test that matters: a price confirmed with a manufacturer, an LPO
 * that puts material on order, goods taken in, a client's LPO that commits it,
 * a delivery that takes it out, a tax invoice with 5% VAT and a payment on the
 * terms the client is on.
 */
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv, start } = require('./helpers');

freshEnv('trade');
require('../src/db/seed');

let h;
let admin;
let ctx = {};

test.before(async () => {
  h = await start();
  admin = await h.signIn('admin@akr365.com');
  const masters = await admin.get('/api/masters/bootstrap');
  ctx.masters = masters;
  ctx.pw = masters.applications.find((a) => a.code === 'PW');
  ctx.net60 = masters.paymentTerms.find((t) => t.code === 'NET60');
  ctx.adv50 = masters.paymentTerms.find((t) => t.code === 'ADV50');
  ctx.chqd = masters.paymentTerms.find((t) => t.code === 'CHQD');
  ctx.client = (await admin.get('/api/partners?type=client&limit=1')).rows[0];
  ctx.supplier = (await admin.get('/api/partners?type=supplier&limit=1')).rows[0];
  ctx.item = (await admin.get('/api/items?q=Dismantling&limit=1')).rows[0];
});

test.after(async () => { if (h) await h.stop(); });

test('the seed lays out the company as it actually trades', () => {
  assert.equal(ctx.masters.applications.length, 5, 'five applications');
  assert.equal(ctx.masters.categories.length, 14, 'fourteen product lines');
  const fabrication = ctx.masters.subgroups.filter((s) => s.product_group === 'Misc. Fabrication');
  assert.equal(fabrication.length, 12, 'the twelve fabrication types');
  assert.ok(fabrication.some((s) => s.name === 'Chequered Plate'));
  assert.ok(fabrication.some((s) => s.name === 'Extension Spindles'));
  assert.equal(ctx.masters.companies.length, 6, 'six group companies');
});

test('an item code carries its product line', () => {
  assert.match(ctx.item.item_code, /^AKR-[A-Z]{2,4}-\d{5}$/);
  assert.equal(ctx.item.item_code.split('-')[1], ctx.item.category_code);
});

test('no LPO may be raised until the manufacturer\'s price is confirmed', async () => {
  const quote = await admin.post('/api/purchase/quotations', {
    partner_id: ctx.supplier.id,
    application_id: ctx.pw.id,
    payment_terms_id: ctx.net60.id,
    items: [{ item_id: ctx.item.id, qty: 12, unit_price: 640 }],
  });
  assert.equal(quote.status, 'received');
  ctx.supplierQuote = quote;

  await assert.rejects(
    () => admin.post('/api/purchase/orders', {
      partner_id: ctx.supplier.id, quotation_id: quote.id,
      items: [{ item_id: ctx.item.id, qty: 12, unit_price: 640 }],
    }),
    (err) => err.status === 409 && /price-confirmed/.test(err.message),
  );

  await admin.post(`/api/purchase/quotations/${quote.id}/approve`);
  const after = await admin.get(`/api/purchase/quotations/${quote.id}`);
  assert.equal(after.quotation.status, 'approved');
});

test('sending an LPO puts the material on order in the stock register', async () => {
  const before = (await admin.get(`/api/stock/items/${ctx.item.id}`)).balance;
  assert.equal(before.on_order, 0);

  const lpo = await admin.post('/api/purchase/orders', {
    partner_id: ctx.supplier.id,
    quotation_id: ctx.supplierQuote.id,
    application_id: ctx.pw.id,
    payment_terms_id: ctx.net60.id,
    items: [{ item_id: ctx.item.id, qty: 12, unit_price: 640 }],
  });
  ctx.lpo = lpo;
  assert.equal(lpo.status, 'draft');

  // A draft LPO is not yet a commitment, so it puts nothing on order.
  assert.equal((await admin.get(`/api/stock/items/${ctx.item.id}`)).balance.on_order, 0);

  await admin.post(`/api/purchase/orders/${lpo.id}/send`);
  const after = (await admin.get(`/api/stock/items/${ctx.item.id}`)).balance;
  assert.equal(after.on_order, 12, 'on order once the LPO is with the maker');
  assert.equal(after.on_hand, 0, 'nothing in the yard yet');
});

test('a goods receipt moves it out of "on order" and into the yard', async () => {
  const po = await admin.get(`/api/purchase/orders/${ctx.lpo.id}`);
  await admin.post('/api/purchase/grns', {
    partner_id: ctx.supplier.id,
    po_id: ctx.lpo.id,
    supplier_dn_ref: 'GVM-DN-7742',
    items: [{ po_item_id: po.items[0].id, qty: 12, rate: 640 }],
  });

  const b = (await admin.get(`/api/stock/items/${ctx.item.id}`)).balance;
  assert.equal(b.on_order, 0);
  assert.equal(b.on_hand, 12);
  assert.equal(b.received_total, 12);

  const closed = await admin.get(`/api/purchase/orders/${ctx.lpo.id}`);
  assert.equal(closed.order.status, 'received');
  // The last landed cost becomes what the next quotation is priced from.
  const item = await admin.get(`/api/items/${ctx.item.id}`);
  assert.equal(item.item.cost_price, 640);
});

test('a short delivery leaves the LPO open', async () => {
  const quote = await admin.post('/api/purchase/quotations', {
    partner_id: ctx.supplier.id,
    items: [{ item_id: ctx.item.id, qty: 10, unit_price: 640 }],
  });
  await admin.post(`/api/purchase/quotations/${quote.id}/approve`);
  const lpo = await admin.post('/api/purchase/orders', {
    partner_id: ctx.supplier.id, quotation_id: quote.id,
    items: [{ item_id: ctx.item.id, qty: 10, unit_price: 640 }],
  });
  await admin.post(`/api/purchase/orders/${lpo.id}/send`);
  const po = await admin.get(`/api/purchase/orders/${lpo.id}`);

  await admin.post('/api/purchase/grns', {
    partner_id: ctx.supplier.id, po_id: lpo.id,
    items: [{ po_item_id: po.items[0].id, qty: 4, rate: 640 }],
  });
  const after = await admin.get(`/api/purchase/orders/${lpo.id}`);
  assert.equal(after.order.status, 'partial');
  assert.equal(after.items[0].pending_qty, 6);

  const b = (await admin.get(`/api/stock/items/${ctx.item.id}`)).balance;
  assert.equal(b.on_order, 6, 'the balance is still on order');
  assert.equal(b.on_hand, 16);

  // More than is outstanding is refused rather than quietly accepted.
  await assert.rejects(
    () => admin.post('/api/purchase/grns', {
      partner_id: ctx.supplier.id, po_id: lpo.id,
      items: [{ po_item_id: po.items[0].id, qty: 99, rate: 640 }],
    }),
    (err) => err.status === 400 && /still outstanding/.test(err.message),
  );
});

test('a client LPO commits the material, and delivery takes it out', async () => {
  const quote = await admin.post('/api/sales/quotations', {
    partner_id: ctx.client.id,
    application_id: ctx.pw.id,
    payment_terms_id: ctx.net60.id,
    project: 'Al Barsha Water Network — Phase 2',
    items: [{ item_id: ctx.item.id, qty: 12, unit_price: 880, cost_price: 640 }],
  });
  ctx.salesQuote = quote;

  const order = await admin.post('/api/sales/orders', {
    partner_id: ctx.client.id,
    quotation_id: quote.id,
    client_lpo_no: 'ASC/LPO/2026/0912',
    application_id: ctx.pw.id,
    payment_terms_id: ctx.net60.id,
    items: [{ item_id: ctx.item.id, qty: 12, unit_price: 880, cost_price: 640 }],
  });
  ctx.order = order;

  let b = (await admin.get(`/api/stock/items/${ctx.item.id}`)).balance;
  assert.equal(b.committed, 12, 'spoken for by the client');
  assert.equal(b.on_hand, 16, 'still in the yard until it goes');
  assert.equal(b.free, 4, 'free stock is what is left uncommitted');

  // The quotation is closed off, and the same LPO cannot be taken twice.
  const q = await admin.get(`/api/sales/quotations/${quote.id}`);
  assert.equal(q.quotation.status, 'converted');
  await assert.rejects(
    () => admin.post('/api/sales/orders', {
      partner_id: ctx.client.id, client_lpo_no: 'ASC/LPO/2026/0912',
      items: [{ item_id: ctx.item.id, qty: 1, unit_price: 880 }],
    }),
    (err) => err.status === 409 && /already on the books/.test(err.message),
  );

  const so = await admin.get(`/api/sales/orders/${order.id}`);
  const dn = await admin.post('/api/sales/deliveries', {
    partner_id: ctx.client.id, so_id: order.id, vehicle_no: 'DXB 61204',
    items: [{ so_item_id: so.items[0].id, qty: 12 }],
  });
  ctx.dn = dn;

  b = (await admin.get(`/api/stock/items/${ctx.item.id}`)).balance;
  assert.equal(b.committed, 0, 'released once it has gone');
  assert.equal(b.on_hand, 4, 'out of the yard');
  assert.equal(b.delivered_total, 12);
});

test('the tax invoice carries 5% VAT and everything the UAE asks for', async () => {
  const invoice = await admin.post('/api/sales/invoices', {
    partner_id: ctx.client.id, so_id: ctx.order.id, dn_id: ctx.dn.id,
  });
  ctx.invoice = invoice;

  assert.equal(invoice.subtotal, 10560);
  assert.equal(invoice.vat_amount, 528, '5% of 10,560');
  assert.equal(invoice.total, 11088);
  assert.equal(invoice.company_name, 'AKR GENERAL TRADING L.L.C');
  assert.equal(invoice.client_lpo_no, 'ASC/LPO/2026/0912');

  const full = await admin.get(`/api/sales/invoices/${invoice.id}`);
  assert.match(full.amountInWords, /^AED Eleven Thousand Eighty Eight Only$/);
  assert.equal(full.margin.margin, 2880, 'sold at 880 against a cost of 640');
});

test('payment terms decide the due date', async () => {
  const invoice = await admin.get(`/api/sales/invoices/${ctx.invoice.id}`);
  const issued = new Date(`${invoice.invoice.invoice_date}T00:00:00Z`);
  const due = new Date(`${invoice.invoice.due_date}T00:00:00Z`);
  assert.equal((due - issued) / 86400000, 60, 'sixty days, as the client is on NET60');
});

test('a receipt settles the invoice, and a bounced cheque unsettles it', async () => {
  const receipt = await admin.post('/api/accounts/payments', {
    direction: 'in', partner_id: ctx.client.id, amount: ctx.invoice.total,
    mode: 'cheque', cheque_no: '004521', cheque_date: '2026-01-05',
  });
  assert.equal(receipt.applied.allocated, ctx.invoice.total);
  assert.equal((await admin.get(`/api/sales/invoices/${ctx.invoice.id}`)).invoice.status, 'paid');

  await admin.post(`/api/accounts/payments/${receipt.id}/status`,
    { status: 'bounced', notes: 'Insufficient funds' });
  const after = await admin.get(`/api/sales/invoices/${ctx.invoice.id}`);
  assert.ok(['unpaid', 'overdue'].includes(after.invoice.status),
    'the invoice is open again once the cheque comes back');
  assert.equal(after.invoice.paid_amount, 0);

  // And a bounce is not a deletion — the cheque is still in the register.
  const cheques = await admin.get('/api/accounts/cheques');
  assert.ok(cheques.rows.some((c) => c.cheque_no === '004521' && c.status === 'bounced'));
});

test('an order on advance terms is held at the gate until the advance is in', async () => {
  const order = await admin.post('/api/sales/orders', {
    partner_id: ctx.client.id,
    client_lpo_no: 'ASC/LPO/2026/0999',
    payment_terms_id: ctx.adv50.id,
    items: [{ item_id: ctx.item.id, qty: 2, unit_price: 1000 }],
  });
  assert.equal(order.advance_required, 1050, 'half of 2,100 including VAT');

  const so = await admin.get(`/api/sales/orders/${order.id}`);
  assert.equal(so.release.ok, false);

  await assert.rejects(
    () => admin.post('/api/sales/deliveries', {
      partner_id: ctx.client.id, so_id: order.id,
      items: [{ so_item_id: so.items[0].id, qty: 2 }],
    }),
    (err) => err.status === 409 && /advance/.test(err.message),
  );

  await admin.post('/api/accounts/payments', {
    direction: 'in', partner_id: ctx.client.id, amount: 1050,
    mode: 'bank_transfer', kind: 'advance', sales_order_id: order.id, autoAllocate: false,
  });
  const released = await admin.get(`/api/sales/orders/${order.id}`);
  assert.equal(released.release.ok, true, 'released once the advance is in');

  // And a manager may still release it explicitly when it is not.
  const held = await admin.post('/api/sales/orders', {
    partner_id: ctx.client.id, client_lpo_no: 'ASC/LPO/2026/1000',
    payment_terms_id: ctx.adv50.id,
    items: [{ item_id: ctx.item.id, qty: 1, unit_price: 500 }],
  });
  const heldSo = await admin.get(`/api/sales/orders/${held.id}`);
  const dn = await admin.post('/api/sales/deliveries', {
    partner_id: ctx.client.id, so_id: held.id, override_hold: true,
    items: [{ so_item_id: heldSo.items[0].id, qty: 1 }],
  });
  assert.ok(dn.dn_no);
});

test('cancelling an LPO takes the material back off order', async () => {
  const quote = await admin.post('/api/purchase/quotations', {
    partner_id: ctx.supplier.id,
    items: [{ item_id: ctx.item.id, qty: 5, unit_price: 600 }],
  });
  await admin.post(`/api/purchase/quotations/${quote.id}/approve`);
  const lpo = await admin.post('/api/purchase/orders', {
    partner_id: ctx.supplier.id, quotation_id: quote.id,
    items: [{ item_id: ctx.item.id, qty: 5, unit_price: 600 }],
  });
  await admin.post(`/api/purchase/orders/${lpo.id}/send`);
  const withOrder = (await admin.get(`/api/stock/items/${ctx.item.id}`)).balance.on_order;

  await admin.post(`/api/purchase/orders/${lpo.id}/cancel`, { reason: 'Client withdrew' });
  const after = (await admin.get(`/api/stock/items/${ctx.item.id}`)).balance.on_order;
  assert.equal(after, withOrder - 5);
});

test('the VAT return is output tax less input tax', async () => {
  const bill = await admin.post('/api/purchase/invoices', {
    partner_id: ctx.supplier.id, po_id: ctx.lpo.id, supplier_inv_no: 'GVM-2026-8842',
    items: [{ item_id: ctx.item.id, qty: 12, unit_price: 640 }],
  });
  assert.equal(bill.vat_amount, 384);

  const vat = await admin.get('/api/accounts/vat-return?from=2000-01-01&to=2100-01-01');
  assert.ok(vat.output_tax > 0, 'we charged VAT on our invoices');
  assert.equal(vat.input_tax, 384, 'and paid it on theirs');
  assert.equal(vat.net, Math.round((vat.output_tax - vat.input_tax) * 100) / 100);
});

test('an expense books against one of the group companies', async () => {
  const companies = (await admin.get('/api/masters/companies')).rows;
  const second = companies.find((c) => !c.is_default);
  await admin.post('/api/accounts/expenses', {
    company_id: second.id, description: 'Yard rent — September', amount: 12000, vat_amount: 600,
    mode: 'cheque',
  });
  const pl = await admin.get('/api/accounts/profit-and-loss?from=2000-01-01&to=2100-01-01');
  const row = pl.companies.find((c) => c.id === second.id);
  assert.equal(row.expenses, 12000);
  assert.equal(pl.group.expenses, 12000);
});
