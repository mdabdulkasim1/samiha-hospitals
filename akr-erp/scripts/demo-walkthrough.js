'use strict';
/*
 * A worked example of the trade, written straight into the database.
 *
 * It runs the sequence the company actually works — ask a manufacturer for a
 * price, confirm it, send the LPO, take the goods in, quote the client, take
 * their LPO, deliver, invoice, collect — so a fresh install can be opened and
 * read rather than stared at. Run it once on a demonstration database:
 *
 *   npm run db:reset && npm run demo && npm start
 */
const { db } = require('../src/db');
const app = require('../src/server');

const BASE_PASSWORD = process.env.SEED_PASSWORD || 'akr@2026';
let server;
let base;
let token;

async function call(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} — ${(data && data.error) || res.status}`);
  return data;
}
const get = (p) => call('GET', p);
const post = (p, b) => call('POST', p, b || {});

const say = (step, text) => console.log(`  ${String(step).padStart(2)}. ${text}`);

async function main() {
  if (db.prepare('SELECT COUNT(*) AS c FROM sales_invoices').get().c > 0) {
    console.log('There is already trading data here — the walkthrough was not run again.');
    return;
  }

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await post('/api/auth/login', { username: 'admin@akr365.com', password: BASE_PASSWORD });
  token = login.token;

  const masters = await get('/api/masters/bootstrap');
  const app_ = (code) => masters.applications.find((a) => a.code === code);
  const terms = (code) => masters.paymentTerms.find((t) => t.code === code);

  const client = (await get('/api/partners?type=client&limit=5')).rows[0];
  const supplier = (await get('/api/partners?type=supplier&limit=5')).rows
    .find((s) => /Valve/i.test(s.name)) || (await get('/api/partners?type=supplier&limit=1')).rows[0];
  const valves = (await get('/api/items?q=Gate%20Valve&limit=6')).rows
    .filter((i) => i.category_code === 'VLP');
  const [v100, v150] = valves;

  console.log('\n  AKR GENERAL TRADING — a worked example\n');

  const enquiry = await post('/api/sales/enquiries', {
    partner_id: client.id, application_id: app_('PW').id,
    project: 'Al Barsha Water Network — Phase 2',
    subject: 'Supply of DI resilient seated gate valves',
    requirement: 'DN100 × 24 nos and DN150 × 12 nos, PN16, to BS EN 1171, with mill certificates.',
  });
  say(1, `The client enquires — ${enquiry.enquiry_no}`);

  const rfq = await post('/api/purchase/enquiries', {
    partner_id: supplier.id, application_id: app_('PW').id,
    project: enquiry.project, subject: 'DI resilient seated gate valves',
    requirement: 'DN100 × 24 nos and DN150 × 12 nos, PN16, to BS EN 1171, with mill certificates.',
  });
  say(2, `We ask the manufacturer to price it — ${rfq.enquiry_no}`);

  const sq = await post('/api/purchase/quotations', {
    enquiry_id: rfq.id, payment_terms_id: terms('NET60').id, supplier_ref: 'GVM/Q/26/1188',
    items: [
      { item_id: v100.id, qty: 24, unit_price: 545, lead_days: 35 },
      { item_id: v150.id, qty: 12, unit_price: 865, lead_days: 35 },
    ],
  });
  say(3, `Their price comes back — ${sq.quote_no} (${sq.total.toFixed(2)} AED)`);

  await post(`/api/purchase/quotations/${sq.id}/approve`);
  say(4, 'The price is confirmed. Only now can an LPO be raised from it.');

  const quote = await post('/api/sales/quotations', {
    partner_id: client.id, enquiry_id: enquiry.id, application_id: app_('PW').id,
    payment_terms_id: terms('CHQD').id, project: enquiry.project,
    subject: 'Supply of DI resilient seated gate valves', delivery_days: 35,
    items: [
      { item_id: v100.id, qty: 24, unit_price: 720, cost_price: 545 },
      { item_id: v150.id, qty: 12, unit_price: 1120, cost_price: 865, discount_percent: 5 },
    ],
  });
  await post(`/api/sales/quotations/${quote.id}/send`);
  say(5, `We quote the client — ${quote.quote_no} (${quote.total.toFixed(2)} AED incl. VAT)`);

  const lpo = await post('/api/purchase/orders', {
    partner_id: supplier.id, quotation_id: sq.id, application_id: app_('PW').id,
    payment_terms_id: terms('NET60').id, project: enquiry.project,
    delivery_date: new Date(Date.now() + 35 * 86400000).toISOString().slice(0, 10),
    items: [
      { item_id: v100.id, qty: 24, unit_price: 545 },
      { item_id: v150.id, qty: 12, unit_price: 865 },
    ],
  });
  await post(`/api/purchase/orders/${lpo.id}/send`);
  say(6, `Our LPO goes to the manufacturer — ${lpo.lpo_no}. The material is now ON ORDER in stock.`);

  const order = await post('/api/sales/orders', {
    partner_id: client.id, quotation_id: quote.id, client_lpo_no: 'ASC/LPO/2026/0912',
    client_lpo_date: new Date().toISOString().slice(0, 10),
    application_id: app_('PW').id, payment_terms_id: terms('CHQD').id, project: enquiry.project,
    delivery_address: 'Site store, Al Barsha South, Dubai',
    items: [
      { item_id: v100.id, qty: 24, unit_price: 720, cost_price: 545 },
      { item_id: v150.id, qty: 12, unit_price: 1120, cost_price: 865, discount_percent: 5 },
    ],
  });
  say(7, `The client's LPO arrives — ${order.so_no}. The material is now COMMITTED.`);

  const poFull = await get(`/api/purchase/orders/${lpo.id}`);
  const grn = await post('/api/purchase/grns', {
    partner_id: supplier.id, po_id: lpo.id, supplier_dn_ref: 'GVM-DN-7742',
    vehicle_no: 'SHJ 44120',
    items: poFull.items.map((i) => ({ po_item_id: i.id, qty: i.qty, rate: i.unit_price })),
  });
  say(8, `The goods arrive — ${grn.grn_no}. Off "on order", into the yard.`);

  const bill = await post('/api/purchase/invoices', {
    partner_id: supplier.id, po_id: lpo.id, grn_id: grn.id,
    supplier_inv_no: 'GVM-2026-8842',
    items: poFull.items.map((i) => ({ item_id: i.item_id, qty: i.qty, unit_price: i.unit_price })),
  });
  say(9, `Their invoice is booked — ${bill.bill_no}, due ${bill.due_date} on 60-day terms.`);

  const soFull = await get(`/api/sales/orders/${order.id}`);
  const dn = await post('/api/sales/deliveries', {
    partner_id: client.id, so_id: order.id, vehicle_no: 'DXB 61204', driver_name: 'Rashid Khan',
    items: soFull.items.map((i) => ({ so_item_id: i.id, qty: i.qty })),
  });
  say(10, `Delivered — ${dn.dn_no}. Out of the yard, and off the committed list.`);

  const invoice = await post('/api/sales/invoices', {
    partner_id: client.id, so_id: order.id, dn_id: dn.id });
  say(11, `Tax invoice ${invoice.invoice_no} — ${invoice.vat_amount.toFixed(2)} VAT on `
    + `${(invoice.subtotal - invoice.discount).toFixed(2)}, total ${invoice.total.toFixed(2)} AED.`);

  const receipt = await post('/api/accounts/payments', {
    direction: 'in', partner_id: client.id, amount: invoice.total, mode: 'cheque',
    cheque_no: '004521', cheque_date: new Date().toISOString().slice(0, 10),
    bank_name: 'Emirates NBD',
  });
  say(12, `The cheque is collected against the delivery note — ${receipt.payment_no}.`);

  await post('/api/accounts/expenses', {
    description: 'Transport — Al Barsha site delivery', amount: 850, vat_amount: 42.5,
    mode: 'cash', project: enquiry.project,
  });
  say(13, 'The transport that got it there is booked as an expense.');

  const stock = await get(`/api/stock/items/${v100.id}`);
  const vat = await get('/api/accounts/vat-return?from=2000-01-01&to=2100-01-01');
  const pl = await get('/api/accounts/profit-and-loss?from=2000-01-01&to=2100-01-01');

  console.log(`\n  ${v100.item_code} — on order ${stock.balance.on_order}, in the yard `
    + `${stock.balance.on_hand}, delivered ${stock.balance.delivered_total}`);
  console.log(`  VAT: ${vat.output_tax.toFixed(2)} charged, ${vat.input_tax.toFixed(2)} paid — `
    + `${vat.net >= 0 ? 'payable' : 'recoverable'} ${Math.abs(vat.net).toFixed(2)}`);
  console.log(`  Gross profit on the job: ${pl.group.gross_profit.toFixed(2)} AED `
    + `(${pl.group.gross_margin_percent}%), net after overheads ${pl.group.net_profit.toFixed(2)}`);
  console.log('\n  Start the app with `npm start` and sign in to see all of it.\n');
}

main()
  .catch((err) => { console.error('\nThe walkthrough stopped:', err.message, '\n'); process.exitCode = 1; })
  .finally(() => { if (server) server.close(); db.close(); });
