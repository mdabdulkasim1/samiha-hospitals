'use strict';
/**
 * A diagnostic order does not reach the bench until it has been paid for.
 *
 * The order of the clinic is: the doctor decides what the patient needs and
 * says nothing about money; the cashier prices what was ordered and takes it;
 * the lab runs what has been paid for. Each of those three sees exactly its
 * own part — which is what this file checks, at the API rather than on the
 * screen, because a gate the browser enforces is not a gate.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-dxgate-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');

let server;
let base;
const tokens = {};
const ids = {};

async function api(method, p, body, as = 'admin') {
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

/** A registered patient who has walked in and been seen. */
async function newVisit(tag) {
  const patientId = (await api('POST', '/api/patients', {
    firstName: tag, lastName: 'Testcase', phone: `9847${String(Date.now()).slice(-6)}`,
    gender: 'male', age: 44, consentTreatment: true,
  }, 'reception')).body.id;
  const arrive = await api('POST', '/api/visits/arrive', {
    patientId, doctorId: ids.doctor, reasonForVisit: 'Fever, two days',
  }, 'reception');
  assert.strictEqual(arrive.status, 201, JSON.stringify(arrive.body));
  const visit = arrive.body.visit || arrive.body;
  return { patientId, visitId: visit.id };
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['cashier', 'cashier@samiha.local'], ['lab', 'lab@samiha.local'],
    ['ward', 'ward@samiha.local'], ['doctor', 'imran@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.doctor = db.prepare("SELECT id FROM users WHERE email = 'imran@samiha.local'").get().id;
  // Two tests: one the tariff has priced, and one the department has started
  // doing since, which nobody has put a rate to yet. Both reach the counter;
  // the difference is whether the cashier is offered a figure or types one.
  ids.priced = db.prepare('SELECT id, name, price FROM lab_tests WHERE active = 1 AND price > 0 ORDER BY id LIMIT 1').get();
  assert.ok(ids.priced, 'the tariff prices the catalogue');

  const made = await api('POST', '/api/masters/lab-tests', {
    code: 'GATE-NEW', name: 'A test with no rate yet', category: 'lab',
    billGroup: 'Blood tests', sampleType: 'Serum', price: 0, tatHours: 24,
  }, 'admin');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  ids.unpriced = { id: made.body.id, name: 'A test with no rate yet' };
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an order the doctor places is held at the counter, not sent to the bench', async () => {
  const { patientId, visitId } = await newVisit('Gate');
  const order = await api('POST', '/api/lab/orders', {
    patientId, visitId, tests: [{ testId: ids.priced.id }], clinicalNotes: 'Rule out infection',
  }, 'doctor');
  assert.strictEqual(order.status, 201, JSON.stringify(order.body));
  assert.strictEqual(order.body.released_at, null, 'not released on the doctor\'s say-so');
  assert.strictEqual(order.body.billing_status, 'pending');

  // The bench can see it exists but cannot lay a hand on it.
  const collect = await api('POST', `/api/lab/orders/${order.body.id}/collect`, { sampleType: 'blood' }, 'lab');
  assert.strictEqual(collect.status, 409, JSON.stringify(collect.body));
  assert.match(collect.body.error, /has not been paid for yet/);

  const results = await api('POST', `/api/lab/orders/${order.body.id}/results`, {
    results: [{ itemId: 1, value: '5' }],
  }, 'lab');
  assert.strictEqual(results.status, 409, 'nor can it skip ahead and enter a result');
});

test('the whole journey: ordered → priced by the cashier → paid → on the bench', async () => {
  const { patientId, visitId } = await newVisit('Journey');
  const order = (await api('POST', '/api/lab/orders', {
    patientId, visitId, tests: [{ testId: ids.priced.id }, { testId: ids.unpriced.id }],
  }, 'doctor')).body;

  // 1. The cashier's queue shows it, with names and rates but no doctor's fee.
  const pending = await api('GET', '/api/billing/diagnostics/pending', undefined, 'cashier');
  assert.strictEqual(pending.status, 200, JSON.stringify(pending.body));
  const mine = pending.body.rows.find((r) => r.id === order.id);
  assert.ok(mine, 'the order is waiting at the counter');
  assert.strictEqual(mine.patient_id, patientId);
  assert.strictEqual(mine.items.length, 2);
  assert.strictEqual(mine.unpriced, 1, 'one line the clinic has never priced');
  assert.ok(mine.items.some((it) => it.suggested_price === ids.priced.price),
    'the tariff rate is offered for the line that has one');

  // 2. The cashier prices both lines — the tariff one as offered, the other by hand.
  const byName = (n) => mine.items.find((it) => it.test_name === n);
  const billed = await api('POST', `/api/billing/diagnostics/${order.id}/bill`, {
    prices: [
      { itemId: byName(ids.priced.name).id, unitPrice: ids.priced.price },
      { itemId: byName(ids.unpriced.name).id, unitPrice: 250 },
    ],
  }, 'cashier');
  assert.strictEqual(billed.status, 200, JSON.stringify(billed.body));
  assert.strictEqual(billed.body.order.billing_status, 'billed');
  assert.strictEqual(billed.body.released, false, 'billed is not paid');

  const invoice = billed.body.invoice;
  const labLines = invoice.items.filter((i) => i.ref_type === 'lab');
  assert.strictEqual(labLines.length, 2, 'both tests reached the bill');
  assert.ok(labLines.some((l) => l.unit_price === 250), 'including the rate the cashier keyed');

  // Still barred.
  assert.strictEqual((await api('POST', `/api/lab/orders/${order.id}/collect`, {}, 'lab')).status, 409);

  // 3. Payment. Settling the bill is what opens the gate.
  const pay = await api('POST', `/api/billing/invoices/${invoice.id}/payments`, {
    amount: invoice.balance, mode: 'upi', reference: 'UPI/TEST/1',
  }, 'cashier');
  assert.strictEqual(pay.status, 201, JSON.stringify(pay.body));

  const after = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(order.id);
  assert.ok(after.released_at, 'paying released it');
  assert.strictEqual(after.billing_status, 'paid');

  // 4. And now the bench can work.
  const collect = await api('POST', `/api/lab/orders/${order.id}/collect`, { sampleType: 'blood' }, 'lab');
  assert.strictEqual(collect.status, 200, JSON.stringify(collect.body));
  assert.ok(collect.body.barcode);
});

test('a part payment does not open the gate', async () => {
  const { patientId, visitId } = await newVisit('Part');
  const order = (await api('POST', '/api/lab/orders', {
    patientId, visitId, tests: [{ testId: ids.priced.id }],
  }, 'doctor')).body;
  const billed = (await api('POST', `/api/billing/diagnostics/${order.id}/bill`, {
    prices: [{ itemId: db.prepare('SELECT id FROM lab_order_items WHERE order_id = ?').get(order.id).id, unitPrice: 400 }],
  }, 'cashier')).body;

  await api('POST', `/api/billing/invoices/${billed.invoice.id}/payments`,
    { amount: 100, mode: 'cash' }, 'cashier');
  assert.strictEqual(db.prepare('SELECT released_at FROM lab_orders WHERE id = ?').get(order.id).released_at, null);

  await api('POST', `/api/billing/invoices/${billed.invoice.id}/payments`,
    { amount: 300, mode: 'cash' }, 'cashier');
  assert.ok(db.prepare('SELECT released_at FROM lab_orders WHERE id = ?').get(order.id).released_at,
    'settling the rest lets it through');
});

test('the cashier can wave an urgent order through, and it is recorded as a waiver', async () => {
  const { patientId, visitId } = await newVisit('Stat');
  const order = (await api('POST', '/api/lab/orders', {
    patientId, visitId, tests: [{ testId: ids.priced.id }], priority: 'stat',
  }, 'doctor')).body;

  // Not without saying why.
  assert.strictEqual((await api('POST', `/api/billing/diagnostics/${order.id}/release`, { reason: 'ok' }, 'cashier')).status, 400);
  // Nor by the bench, letting its own work through.
  assert.strictEqual((await api('POST', `/api/billing/diagnostics/${order.id}/release`,
    { reason: 'Chest pain — cardiac emergency' }, 'lab')).status, 403);

  const released = await api('POST', `/api/billing/diagnostics/${order.id}/release`,
    { reason: 'Chest pain — cardiac emergency, settle after' }, 'cashier');
  assert.strictEqual(released.status, 200, JSON.stringify(released.body));
  assert.strictEqual(released.body.billing_status, 'waived');
  assert.match(released.body.release_note, /cardiac emergency/);

  assert.strictEqual((await api('POST', `/api/lab/orders/${order.id}/collect`, {}, 'lab')).status, 200);
});

test("an in-patient's tests go straight through — the stay is settled at discharge", async () => {
  const patientId = (await api('POST', '/api/patients', {
    firstName: 'Admitted', lastName: 'Testcase', phone: '9847112233',
    gender: 'female', age: 61, consentTreatment: true,
  }, 'reception')).body.id;
  const bed = db.prepare("SELECT id FROM beds WHERE status = 'vacant' LIMIT 1").get();
  const admission = (await api('POST', '/api/ipd/admissions', {
    patientId, doctorId: ids.doctor, bedId: bed.id, reason: 'Pneumonia',
  }, 'ward')).body;

  const order = (await api('POST', '/api/lab/orders', {
    patientId, admissionId: admission.id, tests: [{ testId: ids.priced.id }],
  }, 'doctor')).body;
  assert.ok(order.released_at, 'a ward patient does not walk to the cash counter mid-stay');
  assert.strictEqual(order.billing_status, 'billed');
  assert.match(order.release_note, /running bill/);

  assert.strictEqual((await api('POST', `/api/lab/orders/${order.id}/collect`, {}, 'lab')).status, 200);
});

test('the bench worklist separates what is paid for from what is still at the till', async () => {
  const { patientId, visitId } = await newVisit('Split');
  await api('POST', '/api/lab/orders', { patientId, visitId, tests: [{ testId: ids.priced.id }] }, 'doctor');

  const released = await api('GET', '/api/lab/orders?gate=released', undefined, 'lab');
  const awaiting = await api('GET', '/api/lab/orders?gate=awaiting', undefined, 'lab');
  assert.ok(released.body.rows.every((r) => r.released === true));
  assert.ok(awaiting.body.rows.length >= 1);
  assert.ok(awaiting.body.rows.every((r) => r.released === false));
  assert.strictEqual(typeof awaiting.body.counts.awaiting_payment, 'number');

  // The bench is told a rate is waiting, never what it is.
  assert.ok(awaiting.body.rows.every((r) => r.total_price === null));
});

test('a prescription carries medicines only — diagnostics are never on it', async () => {
  const { patientId, visitId } = await newVisit('Rx');
  await api('POST', '/api/lab/orders', { patientId, visitId, tests: [{ testId: ids.priced.id }] }, 'doctor');
  const drug = db.prepare("SELECT id FROM drugs WHERE code = 'PARA500'").get();
  const rx = await api('POST', '/api/prescriptions', {
    patientId, visitId,
    items: [{ drugId: drug.id, dose: '1 tab', frequency: '1-0-1', durationDays: 3 }],
  }, 'doctor');
  assert.strictEqual(rx.status, 201, JSON.stringify(rx.body));

  const sheet = await api('GET', `/api/prescriptions/${rx.body.id}`, undefined, 'doctor');
  const text = JSON.stringify(sheet.body);
  assert.ok(!text.includes(ids.priced.name), 'the test the doctor ordered is not on the prescription');
  assert.ok(!/lab_order|labOrder/.test(text), 'and the sheet knows nothing of diagnostics');
});
