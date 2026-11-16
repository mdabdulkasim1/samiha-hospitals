'use strict';
/**
 * The consumables store.
 *
 * Three hundred and twenty-three lines off the clinic's purchase order —
 * gloves, cannulas, vacutainers, bin liners — and the plumbing that keeps
 * the figure against each one honest.
 *
 * One rule runs through all of it: what is on the shelf is never a number
 * anybody types. It is the sum of the movements, every one of which says
 * who and when. A quantity that can be typed over is a quantity nobody can
 * account for, and "the system says 40 and there are 12" is the
 * conversation this store exists to prevent.
 *
 * The other thing worth testing is the honesty of the opening figure. The
 * list came off an order, not a count, and a store that quietly presents
 * ordered quantities as stock on hand is worse than one that admits it does
 * not know.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-cons-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');

let server;
let base;
const tokens = {};
const ids = {};
const today = new Date().toISOString().slice(0, 10);

async function api(method, p, body, as = 'nurse') {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tokens[as] ? { Authorization: `Bearer ${tokens[as]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const find = (rows, name) => rows.find((r) => r.name === name);

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['admin', 'nurse', 'reception', 'pharmacy', 'cashier']) {
    const r = await api('POST', '/api/auth/login',
      { username: `${who}@samiha.local`, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, who);
    tokens[who] = r.body.token;
  }
  const owner = await api('POST', '/api/masters/staff',
    { name: 'Mohamed Kasim', role: 'owner', password: 'Samiha#Owner1' }, 'admin');
  const code = db.prepare('SELECT staff_code FROM users WHERE id = ?').get(owner.body.id).staff_code;
  tokens.owner = (await api('POST', '/api/auth/login',
    { username: code, password: 'Samiha#Owner1' }, null)).body.token;

  const all = await api('GET', '/api/consumables');
  ids.list = all.body;
  ids.gauze = find(all.body.rows, 'Gauze swab, sterile').id;
  ids.micropore = find(all.body.rows, 'Micropore surgical tape').id;
  ids.yellowBag = find(all.body.rows, 'Yellow bag, non-chlorinated').id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the list
test('the whole purchase order is on the shelf list, in its own areas', () => {
  const data = ids.list;
  assert.strictEqual(data.totals.items, 323, 'every line of the order');
  assert.strictEqual(data.areas.length, 17, 'and the seventeen places things are kept');

  // The areas read as places in the clinic, not as codes.
  const labels = data.areas.map((a) => a.label);
  for (const want of ['Injection room and dressing', 'Laboratory / sample collection',
    'Minor OT / procedure room', 'Biomedical waste area', 'Housekeeping and sanitation']) {
    assert.ok(labels.includes(want), `the store knows about ${want}`);
  }

  /*
   * The unit is the part that makes a count mean anything: twelve of
   * something is twelve boxes or twelve pieces, and the difference is a
   * thousand swabs. It comes off the order, not from a default.
   */
  const gloves = find(data.rows, 'Examination gloves, nitrile');
  assert.strictEqual(gloves.unit, 'Box of 100');
  assert.strictEqual(gloves.indent_qty, 13);
  assert.strictEqual(find(data.rows, 'Micropore surgical tape').unit, 'Roll');
  assert.strictEqual(find(data.rows, 'Sterile gloves').unit, 'Pair');

  // A line the order left open still reads as what it is.
  const toConfirm = data.rows.find((r) => /rate to be confirmed/.test(r.name + r.description));
  assert.ok(toConfirm, 'the lines the order left to be confirmed are carried as written');
});

test('a store that has never been counted says so rather than inventing a figure', () => {
  const data = ids.list;
  assert.strictEqual(data.totals.unknown, 323,
    'the list came off an order, so nothing is known to be on the shelf yet');
  assert.strictEqual(data.rows[0].on_hand, 0);
  assert.strictEqual(data.rows[0].movements, 0, 'and nothing claims otherwise');
});

test('a restart does not undo what the clinic changed', () => {
  const row = db.prepare("SELECT * FROM consumables WHERE code = 'HK-319'").get();
  db.prepare("UPDATE consumables SET name = 'Toilet roll', active = 0 WHERE id = ?").run(row.id);

  require('../src/db/catalogue').sync({ quiet: true });

  const after = db.prepare("SELECT * FROM consumables WHERE code = 'HK-319'").get();
  assert.strictEqual(after.name, 'Toilet roll', 'the rename stands');
  assert.strictEqual(after.active, 0, 'and so does switching it off');
  db.prepare('UPDATE consumables SET name = ?, active = 1 WHERE id = ?').run(row.name, row.id);
});

// ------------------------------------------------------------- the movements
test('receiving puts it on the shelf, with a name and a date against it', async () => {
  const r = await api('POST', `/api/consumables/${ids.gauze}/movements`, {
    kind: 'receipt', qty: 40, supplier: 'Royal International',
    invoiceNo: 'RI/2026/118', unitCost: 22, movedOn: today,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.on_hand, 40);
  assert.strictEqual(r.body.history[0].kind, 'receipt');
  assert.match(r.body.history[0].by_name, /Mary|Sister/i, 'the nurse who took it in');
  assert.strictEqual(r.body.history[0].supplier, 'Royal International');
});

test('issuing takes it off, and has to say where it went', async () => {
  const nowhere = await api('POST', `/api/consumables/${ids.gauze}/movements`,
    { kind: 'issue', qty: 5 });
  assert.strictEqual(nowhere.status, 400);
  assert.match(nowhere.body.error, /where did it go/i);

  const out = await api('POST', `/api/consumables/${ids.gauze}/movements`,
    { kind: 'issue', qty: 5, issuedTo: 'Injection room' });
  assert.strictEqual(out.status, 201);
  assert.strictEqual(out.body.on_hand, 35, '40 in, 5 out');
});

test('nothing can be issued that is not there', async () => {
  const r = await api('POST', `/api/consumables/${ids.micropore}/movements`,
    { kind: 'issue', qty: 3, issuedTo: 'Ward' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /only 0/i, 'the shelf is empty and says so');
});

test('something damaged needs an explanation, because otherwise it walked', async () => {
  const bare = await api('POST', `/api/consumables/${ids.gauze}/movements`,
    { kind: 'wastage', qty: 2 });
  assert.strictEqual(bare.status, 400);
  assert.match(bare.body.error, /what happened/i);

  const said = await api('POST', `/api/consumables/${ids.gauze}/movements`,
    { kind: 'wastage', qty: 2, reason: 'Packet torn in the trolley' });
  assert.strictEqual(said.status, 201);
  assert.strictEqual(said.body.on_hand, 33);
});

test('a count says what is there, and the book is corrected to match', async () => {
  // The book says 33. The shelf has 28.
  const r = await api('POST', `/api/consumables/${ids.gauze}/movements`,
    { kind: 'count', counted: 28 });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.on_hand, 28);
  assert.strictEqual(r.body.applied, -5, 'written as the correction it is, not as a mystery issue');
  assert.strictEqual(r.body.history[0].kind, 'count');

  // A count that agrees changes nothing, and says so rather than writing a zero.
  const same = await api('POST', `/api/consumables/${ids.gauze}/movements`,
    { kind: 'count', counted: 28 });
  assert.strictEqual(same.body.unchanged, true);
  assert.match(same.body.message, /agrees/i);
  assert.strictEqual(same.body.history.filter((h) => h.kind === 'count').length, 1);
});

test('stock cannot be typed in, only moved', async () => {
  const r = await api('PATCH', `/api/consumables/${ids.gauze}`, { onHand: 500 });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /not typed in/i);
  assert.strictEqual((await api('GET', `/api/consumables/${ids.gauze}`)).body.on_hand, 28,
    'and the shelf is unchanged');
});

test('a movement cannot be dated into next week', async () => {
  const soon = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
  const r = await api('POST', `/api/consumables/${ids.gauze}/movements`,
    { kind: 'receipt', qty: 5, movedOn: soon });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /future/i);
});

// -------------------------------------------------------------- a delivery
test('a delivery goes in as one thing, because that is what it is', async () => {
  const r = await api('POST', '/api/consumables/deliveries', {
    supplier: 'Royal International', invoiceNo: 'RI/2026/204', movedOn: today,
    lines: [
      { itemId: ids.micropore, qty: 50, unitCost: 18 },
      { itemId: ids.yellowBag, qty: 300, unitCost: 2.5 },
    ],
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.received, 2);
  assert.strictEqual(r.body.invoiceNo, 'RI/2026/204');

  const tape = await api('GET', `/api/consumables/${ids.micropore}`);
  assert.strictEqual(tape.body.on_hand, 50);
  assert.strictEqual(tape.body.history[0].invoice_no, 'RI/2026/204',
    'every line carries the invoice it came on');

  const empty = await api('POST', '/api/consumables/deliveries', { supplier: 'X', lines: [] });
  assert.strictEqual(empty.status, 400);
});

test('a delivery is all or nothing', async () => {
  /*
   * One bad line must not leave half a delivery on the shelf, because the
   * half that landed is invisible — nobody knows to enter the rest.
   */
  const before = (await api('GET', `/api/consumables/${ids.micropore}`)).body.on_hand;
  const r = await api('POST', '/api/consumables/deliveries', {
    supplier: 'Royal International', invoiceNo: 'RI/2026/205',
    lines: [{ itemId: ids.micropore, qty: 10 }, { itemId: 999999, qty: 5 }],
  });
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await api('GET', `/api/consumables/${ids.micropore}`)).body.on_hand, before,
    'nothing of it landed');
});

// ------------------------------------------------------- the opening balance
test('the ordered quantities can be adopted as the opening stock, once', async () => {
  const before = (await api('GET', '/api/consumables')).body.totals;
  assert.ok(before.unknown > 300);

  // Management's decision, not the counter's.
  assert.strictEqual((await api('POST', '/api/consumables/adopt-indent', {}, 'nurse')).status, 403);

  const r = await api('POST', '/api/consumables/adopt-indent', {}, 'owner');
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.opened > 300);
  assert.match(r.body.note, /purchase order was raised for/i,
    'and says what the figure actually is');
  assert.match(r.body.note, /correct each one with a count/i, 'and what to do about it');

  const after = (await api('GET', '/api/consumables')).body;
  assert.strictEqual(after.totals.unknown, 0, 'every item now has a figure');
  const gloves = find(after.rows, 'Examination gloves, nitrile');
  assert.strictEqual(gloves.on_hand, 13, 'at the quantity the order was raised for');

  // The items already counted keep their counted figure.
  assert.strictEqual(find(after.rows, 'Gauze swab, sterile').on_hand, 28,
    'a counted shelf is not overwritten by the order');

  // And it cannot be run twice into double the stock.
  const again = await api('POST', '/api/consumables/adopt-indent', {}, 'admin');
  assert.strictEqual(again.body.opened, 0);
  assert.strictEqual(find((await api('GET', '/api/consumables')).body.rows,
    'Examination gloves, nitrile').on_hand, 13);
});

test('the opening balance is marked as coming from the order, not from a shelf', () => {
  const row = db.prepare(
    "SELECT * FROM consumable_movements WHERE kind = 'opening' ORDER BY id DESC LIMIT 1").get();
  assert.match(row.notes, /purchase order/i);
  assert.match(row.notes, /not from a count/i);
});

// ------------------------------------------------------------------ the rest
test('the clinic can add something the order never had', async () => {
  const r = await api('POST', '/api/consumables', {
    name: 'Spacer device, paediatric', area: 'OPC', unit: 'Pcs',
    description: 'With mask, for the nebuliser trolley', indentQty: 10, openingQty: 4,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.code, /^OPC-C\d{3}$/, 'in its own series, so it cannot collide with the order');
  assert.strictEqual(r.body.on_hand, 4, 'with what is already on the shelf');
  assert.strictEqual(r.body.seeded, 0);

  const dup = await api('POST', '/api/consumables',
    { name: 'Spacer device, paediatric', area: 'OPC' });
  assert.strictEqual(dup.status, 400, 'and not twice');
});

test('running low is the question the store is asked most', async () => {
  const low = await api('GET', '/api/consumables?low=1');
  assert.strictEqual(low.status, 200);
  assert.ok(low.body.rows.every((r) => r.on_hand <= r.reorder_level));

  // Issue almost everything of one item and it appears.
  const spacer = find((await api('GET', '/api/consumables')).body.rows, 'Spacer device, paediatric');
  await api('POST', `/api/consumables/${spacer.id}/movements`,
    { kind: 'issue', qty: 4, issuedTo: 'OP room 1' });
  const after = await api('GET', '/api/consumables?out=1');
  assert.ok(after.body.rows.some((r) => r.id === spacer.id), 'nothing left, and on the list');
});

test('what went where, over a period', async () => {
  const r = await api('GET', '/api/consumables/usage');
  assert.strictEqual(r.status, 200);

  const kinds = Object.fromEntries(r.body.lines.map((l) => [l.kind, l]));
  assert.ok(kinds.receipt.entries > 0);
  assert.ok(kinds.issue.entries > 0);
  assert.ok(r.body.spend > 0, 'what was spent, where a cost was recorded');

  const places = r.body.issuedTo.map((x) => x.place);
  assert.ok(places.includes('Injection room'), 'and which room it went to');
  assert.ok(r.body.busiest.length, 'with what is going fastest');
  assert.match(r.body.note, /not added across items/i,
    'because twelve boxes plus three rolls is fifteen of nothing');
});

// ----------------------------------------------------------------------- who
test('the owner, the administrator and the nurses — and nobody else', async () => {
  for (const who of ['owner', 'admin', 'nurse']) {
    assert.strictEqual((await api('GET', '/api/consumables', undefined, who)).status, 200, who);
  }
  for (const who of ['reception', 'pharmacy', 'cashier']) {
    assert.strictEqual((await api('GET', '/api/consumables', undefined, who)).status, 403, who);
    assert.strictEqual((await api('POST', `/api/consumables/${ids.gauze}/movements`,
      { kind: 'receipt', qty: 1 }, who)).status, 403, who);
  }
});

test('every movement is on the record', () => {
  const row = db.prepare(
    "SELECT * FROM audit_logs WHERE action = 'stock_move' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row, 'movements are audited');
  assert.ok(row.actor && row.actor !== 'system', `and name who made them — got ${row.actor}`);
  const details = JSON.parse(row.details);
  assert.ok(details.code && details.kind !== undefined);
});
