'use strict';
/*
 * The conditions printed at the foot of an LPO.
 *
 * The point of the exercise: an order's conditions must name the supplier the
 * order is addressed to. A real LPO went out naming a manufacturer who was not
 * the one being ordered from, because the block had been copied from another
 * order — so the clauses hold placeholders and the document fills them.
 */
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv, start, askForPrice } = require('./helpers');

freshEnv('terms');
require('../src/db/seed');

let h;
let kam;
let admin;
let logistics;
let ctx = {};

test.before(async () => {
  h = await start();
  admin = await h.signIn('admin@akr365.com');
  kam = await h.signIn('kam@akr365.com');
  logistics = await h.signIn('logistics@akr365.com');
  const suppliers = (await admin.get('/api/partners?type=supplier&limit=6')).rows;
  ctx.supplier = suppliers[0];
  ctx.otherSupplier = suppliers[1];
  ctx.item = (await admin.get('/api/items?limit=1')).rows[0];
});

test.after(async () => { if (h) await h.stop(); });

/** Raise an LPO and hand back its detail — sent, if the caller wants it sent. */
async function raiseLpo(client, extra = {}) {
  const supplier = extra.supplier || ctx.supplier;
  const quote = await askForPrice(client, {
    partner_id: supplier.id, items: [{ item_id: ctx.item.id, qty: 4, unit_price: 250 }],
  });
  await client.post(`/api/purchase/quotations/${quote.id}/approve`);
  const lpo = await client.post('/api/purchase/orders', {
    partner_id: supplier.id, quotation_id: quote.id,
    items: [{ item_id: ctx.item.id, qty: 4, unit_price: 250 }],
    ...extra.body,
  });
  if (extra.send) await client.post(`/api/purchase/orders/${lpo.id}/send`);
  return client.get(`/api/purchase/orders/${lpo.id}`);
}

test('the standard conditions are there, and the company\'s own points among them', async () => {
  const lib = await kam.get('/api/masters/terms?doc_type=purchase_order');
  assert.ok(lib.rows.length >= 30, 'a full set of conditions');
  const all = lib.rows.map((r) => r.text).join(' | ');
  // The points lifted from the company's own LPO.
  assert.match(all, /approved drawing and requirement/);
  assert.match(all, /SAT \/ FAT inspection/);
  assert.match(all, /300 microns/);
  assert.match(all, /Mill test certificates/);
  assert.match(all, /wooden pallet/);
  assert.match(all, /individually packed/);
  // And the ones added to cover what that block left open.
  assert.match(all, /liquidated damages or back-charges/);
  assert.match(all, /warranted against defects/);
  assert.match(all, /laws of the United Arab Emirates/);
  assert.match(all, /firm for the duration of this order/);
});

test('a clause that applies only sometimes is not ticked by default', async () => {
  const lib = await kam.get('/api/masters/terms?doc_type=purchase_order');
  const coating = lib.rows.find((r) => /300 microns/.test(r.text));
  assert.equal(coating.is_default, 0, 'coating thickness is not on every order');
  const drawing = lib.rows.find((r) => /approved drawing/.test(r.text));
  assert.equal(drawing.is_default, 1);
});

test('an LPO\'s conditions name the supplier it is addressed to', async () => {
  const first = await raiseLpo(kam, { body: { authority: 'DEWA' } });
  const second = await raiseLpo(kam, { supplier: ctx.otherSupplier, body: { authority: 'Dubai Municipality' } });

  const firstText = first.conditions.join(' ');
  const secondText = second.conditions.join(' ');

  assert.ok(firstText.includes(ctx.supplier.name), 'the first names its own supplier');
  assert.ok(!firstText.includes(ctx.otherSupplier.name), 'and nobody else');
  assert.ok(secondText.includes(ctx.otherSupplier.name));
  assert.ok(!secondText.includes(ctx.supplier.name));

  assert.ok(firstText.includes('DEWA'), 'and its own approving authority');
  assert.ok(secondText.includes('Dubai Municipality'));
  // No placeholder is ever left showing on a document.
  assert.ok(!/\{\{\w+\}\}/.test(firstText), 'every placeholder was filled in');
  assert.ok(!/\{\{\w+\}\}/.test(secondText));
  ctx.lpo = first.order;
});

test('an authority nobody stated reads as words, not as a placeholder', async () => {
  const lpo = await raiseLpo(kam);
  const text = lpo.conditions.join(' ');
  assert.ok(!/\{\{/.test(text));
  assert.match(text, /the approving authority/);
});

test('the key account manager can edit an order\'s conditions, and it is audited', async () => {
  const before = await kam.get(`/api/purchase/orders/${ctx.lpo.id}`);
  const edited = before.conditions.slice(0, 3)
    .concat(['Retention of 5% shall be released on final acceptance by the end client.']);

  await kam.patch(`/api/purchase/orders/${ctx.lpo.id}`, { terms: edited, attention: 'Mr. S. Kumar' });
  const after = await kam.get(`/api/purchase/orders/${ctx.lpo.id}`);

  assert.equal(after.conditions.length, 4);
  assert.match(after.conditions[3], /Retention of 5%/);
  assert.equal(after.order.attention, 'Mr. S. Kumar');

  const log = await admin.get('/api/admin/audit?action=purchase_order.terms_changed');
  assert.ok(log.rows.length, 'the change is on the audit trail');
  const details = JSON.parse(log.rows[0].details);
  assert.ok(details.was.includes('approved drawing'), 'with what it said before');
});

test('editing the standard list does not reach into an order already sent', async () => {
  const lpo = await raiseLpo(kam);
  const lib = await kam.get('/api/masters/terms?doc_type=purchase_order');
  const clause = lib.rows.find((r) => /approved drawing/.test(r.text));

  await kam.patch(`/api/masters/terms/${clause.id}`, {
    text: 'All items shall be exactly as per the approved drawing, revision and requirement.',
  });

  const unchanged = await kam.get(`/api/purchase/orders/${lpo.order.id}`);
  assert.match(unchanged.conditions[0], /^All items shall be as per the approved drawing/,
    'the order the supplier has is untouched');

  const next = await raiseLpo(kam);
  assert.match(next.conditions[0], /exactly as per the approved drawing, revision/,
    'the next order picks the change up');
});

test('a retired clause stops appearing but is not destroyed', async () => {
  const lib = await kam.get('/api/masters/terms?doc_type=purchase_order');
  const clause = lib.rows.find((r) => /wooden pallet/.test(r.text));
  await kam.del(`/api/masters/terms/${clause.id}`);

  const next = await raiseLpo(kam);
  assert.ok(!next.conditions.join(' ').includes('wooden pallet'), 'gone from new orders');

  const withRetired = await kam.get('/api/masters/terms?doc_type=purchase_order&includeInactive=1');
  const still = withRetired.rows.find((r) => r.id === clause.id);
  assert.ok(still, 'still on the record');
  assert.equal(still.active, 0);
});

test('a new point can be added to the standard list', async () => {
  const added = await kam.post('/api/masters/terms', {
    doc_type: 'purchase_order',
    clause_group: 'General',
    text: 'All correspondence on this order shall quote {{lpo_no}}.',
  });
  assert.equal(added.is_default, 1);
  const lpo = await raiseLpo(kam);
  const line = lpo.conditions.find((c) => /All correspondence/.test(c));
  assert.ok(line, 'it appears on the next order');
  assert.ok(line.includes(lpo.order.lpo_no), 'with the order number filled in');
  assert.ok(!line.includes('{{'), 'and no placeholder left showing');
});

test('only the desks that own the conditions may change them', async () => {
  const lib = await kam.get('/api/masters/terms?doc_type=purchase_order');
  await assert.rejects(
    () => logistics.patch(`/api/masters/terms/${lib.rows[0].id}`, { text: 'nope' }),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => logistics.post('/api/masters/terms', { doc_type: 'purchase_order', text: 'nope' }),
    (err) => err.status === 403,
  );
  // Reading them is open — a delivery note is checked against them.
  const read = await logistics.get('/api/masters/terms?doc_type=purchase_order');
  assert.ok(read.rows.length);
});

test('conditions cannot be rewritten once the goods are in', async () => {
  const lpo = await raiseLpo(kam, { send: true });
  const po = await kam.get(`/api/purchase/orders/${lpo.order.id}`);
  await kam.post('/api/purchase/grns', {
    partner_id: po.order.partner_id, po_id: po.order.id,
    items: [{ po_item_id: po.items[0].id, qty: 4, rate: 250 }],
  });
  await assert.rejects(
    () => kam.patch(`/api/purchase/orders/${lpo.order.id}`, { terms: ['Anything at all.'] }),
    (err) => err.status === 409 && /received/.test(err.message),
  );
});

test('a quotation to a client carries its own conditions', async () => {
  const client = (await admin.get('/api/partners?type=client&limit=1')).rows[0];
  const quote = await admin.post('/api/sales/quotations', {
    partner_id: client.id, items: [{ item_id: ctx.item.id, qty: 2, unit_price: 400 }],
  });
  const full = await admin.get(`/api/sales/quotations/${quote.id}`);
  assert.match(full.quotation.terms_text, /exclusive of 5% VAT/);
  assert.match(full.quotation.terms_text, /property of/);
  assert.ok(!/\{\{\w+\}\}/.test(full.quotation.terms_text), 'placeholders filled in here too');
});
