'use strict';
/*
 * The client's own LPO, kept.
 *
 * The point is what somebody needs a year later: the PDF the client actually
 * signed, not our transcription of it. So the file has to go in, come back out
 * byte for byte, and refuse to be something other than what it claims.
 */
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv, start } = require('./helpers');

freshEnv('attachments');
require('../src/db/seed');

let h;
let admin;
let sales;
let logistics;
let ctx = {};

// A real, minimal PDF — the magic bytes matter, so it cannot be a fake string.
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
).toString('base64');

test.before(async () => {
  h = await start();
  admin = await h.signIn('admin@akr365.com');
  sales = await h.signIn('sales@akr365.com');
  logistics = await h.signIn('logistics@akr365.com');

  const client = (await admin.get('/api/partners?type=client&limit=1')).rows[0];
  const item = (await admin.get('/api/items?limit=1')).rows[0];
  ctx.order = await sales.post('/api/sales/orders', {
    partner_id: client.id, client_lpo_no: 'ASC/LPO/2026/4455',
    purchase_officer: 'Mr. Rahman', purchase_officer_mobile: '0501234567',
    delivery_contact: 'Site Storekeeper', delivery_mobile: '0559876543',
    delivery_location: 'Mirdif, Dubai',
    items: [{ item_id: item.id, qty: 2, unit_price: 300 }],
  });
});

test.after(async () => { if (h) await h.stop(); });

test('the order carries who to ring, on both sides', async () => {
  const full = await sales.get(`/api/sales/orders/${ctx.order.id}`);
  const o = full.order;
  assert.equal(o.purchase_officer, 'Mr. Rahman');
  assert.equal(o.purchase_officer_mobile, '971501234567', 'normalised to a UAE number');
  assert.equal(o.delivery_contact, 'Site Storekeeper');
  assert.equal(o.delivery_mobile, '971559876543');
  assert.equal(o.delivery_location, 'Mirdif, Dubai');
});

test("the driver's delivery note carries the site contact, not the buyer's", async () => {
  const full = await sales.get(`/api/sales/orders/${ctx.order.id}`);
  await admin.post('/api/stock/adjustments',
    { item_id: full.items[0].item_id, qty: 5, reason: 'Opening for the delivery test' });
  const dn = await logistics.post('/api/sales/deliveries', {
    partner_id: ctx.order.partner_id, so_id: ctx.order.id,
    items: [{ so_item_id: full.items[0].id, qty: 2 }],
  });
  const note = await logistics.get(`/api/sales/deliveries/${dn.id}`);
  assert.equal(note.delivery.delivery_contact, 'Site Storekeeper');
  assert.equal(note.delivery.delivery_mobile, '971559876543');
  assert.equal(note.delivery.delivery_location, 'Mirdif, Dubai');
  assert.match(note.delivery.delivery_address, /Mirdif, Dubai/, 'and the address it was sent to');
});

test('the client\'s LPO can be attached and read back byte for byte', async () => {
  const saved = await sales.post(`/api/attachments/sales_order/${ctx.order.id}`, {
    data: PDF, filename: 'ASC LPO 4455.pdf', mime: 'application/pdf', kind: "Client's LPO",
  });
  assert.equal(saved.mime, 'application/pdf');
  assert.equal(saved.filename, 'ASC LPO 4455.pdf');
  assert.equal(saved.size_bytes, Buffer.from(PDF, 'base64').length);
  ctx.attachment = saved;

  const listed = await sales.get(`/api/attachments/sales_order/${ctx.order.id}`);
  assert.equal(listed.rows.length, 1);
  assert.equal(listed.entity.ref, ctx.order.so_no, 'filed against the order, by its reference');
  assert.equal(listed.canAttach, true);
});

/*
 * The regression this file exists for: '/:type/:id' will happily match
 * '/file/123' and turn the request away as an unknown entity. The specific
 * route has to be registered above the general one, and this catches it if
 * anybody ever reorders them.
 */
test('the file itself comes back, not a routing error', async () => {
  const res = await sales.raw('GET', `/api/attachments/file/${ctx.attachment.id}`);
  assert.ok(typeof res === 'string' || Buffer.isBuffer(res) || res, 'something came back');
  // The wrapper parses JSON; a PDF comes back as text, so an error object here
  // would mean the route matched the wildcard again.
  assert.ok(!(res && res.error), `expected the file, got ${JSON.stringify(res).slice(0, 120)}`);
  assert.match(String(res), /^%PDF/, 'the bytes are the PDF that went in');
});

test('a file is what its bytes say, not what its name claims', async () => {
  const shell = Buffer.from('#!/bin/sh\nrm -rf /\n').toString('base64');
  await assert.rejects(
    () => sales.post(`/api/attachments/sales_order/${ctx.order.id}`,
      { data: shell, filename: 'client-lpo.pdf', mime: 'application/pdf' }),
    (err) => err.status === 400 && /not one this system stores/.test(err.message),
  );
});

test('an empty or oversized file is refused before anything is written', async () => {
  await assert.rejects(
    () => sales.post(`/api/attachments/sales_order/${ctx.order.id}`,
      { data: '', filename: 'nothing.pdf' }),
    (err) => err.status === 400,
  );
  // Fourteen megabytes of PDF, against a twelve megabyte limit.
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(14 * 1024 * 1024, 0x20)]);
  await assert.rejects(
    () => sales.post(`/api/attachments/sales_order/${ctx.order.id}`,
      { data: big.toString('base64'), filename: 'huge.pdf', mime: 'application/pdf' }),
    (err) => err.status === 400 && /limit is/.test(err.message),
  );
});

test('nothing can be hung on a table that is not on the list', async () => {
  await assert.rejects(
    () => sales.post('/api/attachments/users/1', { data: PDF, filename: 'x.pdf' }),
    (err) => err.status === 400 && /Nothing can be attached/.test(err.message),
  );
  await assert.rejects(
    () => sales.get('/api/attachments/sales_order/999999'),
    (err) => err.status === 404,
  );
});

test('the desk that owns the document is the desk that may attach to it', async () => {
  // Logistics do not file the client's purchase order.
  await assert.rejects(
    () => logistics.post(`/api/attachments/sales_order/${ctx.order.id}`,
      { data: PDF, filename: 'x.pdf' }),
    (err) => err.status === 403,
  );
  // They can see what is filed, because they deliver against it.
  const seen = await logistics.get(`/api/attachments/sales_order/${ctx.order.id}`);
  assert.ok(seen.rows.length);
  assert.equal(seen.canAttach, false);
});

test('removing an attachment takes the file with it', async () => {
  const fs = require('fs');
  const path = require('path');
  const config = require('../src/config');
  const before = fs.readdirSync(config.attachmentsDir).length;

  await sales.del(`/api/attachments/${ctx.attachment.id}`);
  const after = fs.readdirSync(config.attachmentsDir).length;
  assert.equal(after, before - 1, 'the file is gone from disk, not just from the list');

  const listed = await sales.get(`/api/attachments/sales_order/${ctx.order.id}`);
  assert.equal(listed.rows.length, 0);
  assert.ok(path);
});
