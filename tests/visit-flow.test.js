'use strict';
/**
 * The two walks through the building.
 *
 * The clinic is paid as the patient goes rather than reckoned up at the end,
 * and that changes the order of the lanes rather than merely adding a step.
 *
 *   front desk -> cashier (consultation fee) -> nurse -> doctor
 *      -> nothing further:  pharmacy -> pay there -> out
 *      -> tests ordered:    cashier (pay for them) -> lab -> pharmacy -> out
 *
 * Each gate here is checked at the API, because a step the browser skips past
 * is not a step. The one that matters most is the nurse station: it is the
 * first place the new order could be quietly undone.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-flow-'));
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

const stage = (id) => db.prepare('SELECT status FROM visits WHERE id = ?').get(id).status;

/** A registered patient, arrived and checked in — standing at the cashier. */
async function atTheCounter(tag) {
  const patientId = (await api('POST', '/api/patients', {
    firstName: tag, lastName: 'Flow', phone: `9846${String(Date.now()).slice(-6)}`,
    gender: 'male', age: 41, consentTreatment: true,
  }, 'reception')).body.id;
  const arrived = await api('POST', '/api/visits/arrive',
    { patientId, doctorId: ids.doctor, reasonForVisit: 'Cough' }, 'reception');
  assert.strictEqual(arrived.status, 201, JSON.stringify(arrived.body));
  const visitId = (arrived.body.visit || arrived.body).id;
  await api('POST', `/api/visits/${visitId}/check-in`, { reasonForVisit: 'Cough' }, 'reception');
  return { patientId, visitId };
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['cashier', 'cashier@samiha.local'], ['nurse', 'nurse@samiha.local'],
    ['lab', 'lab@samiha.local'], ['pharmacy', 'pharmacy@samiha.local'],
    ['doctor', 'imran@samiha.local'], ['counselor', 'counselor@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.doctor = db.prepare("SELECT id FROM users WHERE email = 'imran@samiha.local'").get().id;
  ids.test = db.prepare('SELECT id, price FROM lab_tests WHERE active = 1 AND price > 0 LIMIT 1').get();
  ids.drug = db.prepare("SELECT id FROM drugs WHERE code = 'PARA500'").get();
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the nurse station is after the counter, and that is a rule', async () => {
  const { visitId } = await atTheCounter('Gate');
  assert.strictEqual(stage(visitId), 'checked_in');

  const early = await api('POST', `/api/visits/${visitId}/vitals`,
    { pulse: 78, bpSystolic: 120, bpDiastolic: 80 }, 'nurse');
  assert.strictEqual(early.status, 409, JSON.stringify(early.body));
  assert.match(early.body.error, /cashier/i, 'and it says where to send them');

  const fee = await api('POST', `/api/visits/${visitId}/consultation-fee`, { mode: 'cash' }, 'cashier');
  assert.strictEqual(fee.status, 201, JSON.stringify(fee.body));

  const now = await api('POST', `/api/visits/${visitId}/vitals`,
    { pulse: 78, bpSystolic: 120, bpDiastolic: 80 }, 'nurse');
  assert.strictEqual(now.status, 201, 'and once it is paid, the nurse can work');
  assert.strictEqual(stage(visitId), 'vitals_done');
});

test('the fee is the rate card\'s, taken once, and only by the cashier', async () => {
  const { visitId } = await atTheCounter('Rate');
  const card = db.prepare("SELECT price FROM services WHERE code = 'CONS-NEW'").get().price;

  for (const as of ['reception', 'nurse', 'doctor']) {
    assert.strictEqual(
      (await api('POST', `/api/visits/${visitId}/consultation-fee`, { mode: 'cash' }, as)).status, 403,
      `${as} does not take money`);
  }

  const fee = await api('POST', `/api/visits/${visitId}/consultation-fee`, { mode: 'cash' }, 'cashier');
  assert.strictEqual(fee.body.fee, card, 'charged at the published rate, not a doctor\'s own figure');
  assert.strictEqual(fee.body.invoice.balance, 0, 'and taken in full');
  assert.ok(fee.body.invoice.items.some((i) => i.ref_type === 'consultation'));

  const again = await api('POST', `/api/visits/${visitId}/consultation-fee`, { mode: 'cash' }, 'cashier');
  assert.strictEqual(again.status, 409, 'nobody pays for the same consultation twice');
});

test('a patient on a band pays the discounted fee at the counter, not a refund later', async () => {
  const { patientId, visitId } = await atTheCounter('Band');

  const screening = (await api('POST', '/api/financial/screenings', { patientId, visitId }, 'counselor')).body;
  await api('POST', `/api/financial/screenings/${screening.screening.id}/assess`, {
    householdSize: 4, annualIncome: 300000, hasProofOfIncome: true, proofType: 'pay_stub', uninsured: true,
  }, 'counselor');
  await api('POST', `/api/financial/screenings/${screening.screening.id}/decide`,
    { decision: 'continue' }, 'counselor');

  const fee = await api('POST', `/api/visits/${visitId}/consultation-fee`, { mode: 'cash' }, 'cashier');
  assert.strictEqual(fee.status, 201, JSON.stringify(fee.body));
  assert.ok(fee.body.collected < fee.body.fee,
    'the band comes off before the money is taken');
  assert.strictEqual(fee.body.invoice.balance, 0, 'and what is left is nil, not a debt');
  assert.ok(fee.body.invoice.paid <= fee.body.invoice.net + 0.009,
    'the clinic is not holding money belonging to a patient on a concession');

  // A concession must not read as an unpaid consultation at the nurse station.
  assert.strictEqual(
    (await api('POST', `/api/visits/${visitId}/vitals`, { pulse: 80 }, 'nurse')).status, 201);
});

test('no tests ordered: the doctor sends them to the pharmacy', async () => {
  const { patientId, visitId } = await atTheCounter('Simple');
  await api('POST', `/api/visits/${visitId}/consultation-fee`, { mode: 'cash' }, 'cashier');
  await api('POST', `/api/visits/${visitId}/vitals`, { pulse: 76 }, 'nurse');
  await api('POST', `/api/visits/${visitId}/consultation`,
    { subjective: 'Cough a week', assessment: 'URTI', plan: 'Symptomatic' }, 'doctor');
  await api('POST', '/api/prescriptions', {
    patientId, visitId,
    items: [{ drugId: ids.drug.id, dose: '1 tab', frequency: '1-0-1', durationDays: 3 }],
  }, 'doctor');

  const signed = await api('POST', `/api/visits/${visitId}/consultation/sign`, {}, 'doctor');
  assert.strictEqual(signed.body.nextStep, 'pharmacy', 'nothing to pay for, so straight to the medicines');
  assert.strictEqual(stage(visitId), 'pharmacy_pending');
});

test('tests ordered: back to the cashier, and paying is what reaches the bench', async () => {
  const { patientId, visitId } = await atTheCounter('Tested');
  await api('POST', `/api/visits/${visitId}/consultation-fee`, { mode: 'cash' }, 'cashier');
  await api('POST', `/api/visits/${visitId}/vitals`, { pulse: 76 }, 'nurse');
  await api('POST', `/api/visits/${visitId}/consultation`,
    { subjective: 'Sugars up', assessment: 'Diabetes review', plan: 'Bloods' }, 'doctor');
  const order = (await api('POST', '/api/lab/orders',
    { patientId, visitId, tests: [{ testId: ids.test.id }] }, 'doctor')).body;

  const signed = await api('POST', `/api/visits/${visitId}/consultation/sign`, {}, 'doctor');
  assert.strictEqual(signed.body.nextStep, 'billing', 'the counter, not the bench');
  assert.strictEqual(stage(visitId), 'billing_pending');

  // The bench cannot start, and the visit does not move, until it is paid.
  assert.strictEqual(
    (await api('POST', `/api/lab/orders/${order.id}/collect`, {}, 'lab')).status, 409);
  assert.strictEqual(stage(visitId), 'billing_pending');

  const queued = (await api('GET', '/api/billing/diagnostics/pending', undefined, 'cashier')).body;
  const mine = queued.rows.find((r) => r.id === order.id);
  assert.ok(mine, 'it is waiting at the counter with its tests named');
  const billed = await api('POST', `/api/billing/diagnostics/${order.id}/bill`, {
    prices: mine.items.map((it) => ({ itemId: it.id, unitPrice: it.suggested_price || 200 })),
  }, 'cashier');
  assert.strictEqual(billed.status, 200, JSON.stringify(billed.body));
  assert.strictEqual(stage(visitId), 'billing_pending', 'on the bill is not the same as paid');

  await api('POST', `/api/billing/invoices/${billed.body.invoice.id}/payments`,
    { amount: billed.body.invoice.balance, mode: 'cash' }, 'cashier');
  assert.strictEqual(stage(visitId), 'labs_pending',
    'the receipt is what walks them from the counter to the bench');
  assert.strictEqual(
    (await api('POST', `/api/lab/orders/${order.id}/collect`, {}, 'lab')).status, 200);
});

test('arriving uninsured flags the counsellor and diverts nobody', async () => {
  const patientId = (await api('POST', '/api/patients', {
    firstName: 'Uninsured', lastName: 'Flow', phone: '9846777111',
    gender: 'female', age: 52, consentTreatment: true, isUninsured: true,
  }, 'reception')).body.id;

  const arrived = await api('POST', '/api/visits/arrive',
    { patientId, doctorId: ids.doctor, reasonForVisit: 'Knee pain' }, 'reception');
  assert.strictEqual(arrived.body.nextStep, 'check_in', 'no screening turnstile on the way in');
  assert.strictEqual(arrived.body.flags.mayNeedFinancialHelp, true, 'but the need is noted');

  const visitId = (arrived.body.visit || arrived.body).id;
  assert.strictEqual(stage(visitId), 'waiting_room');
  assert.ok(db.prepare(
    "SELECT 1 FROM visit_events WHERE visit_id = ? AND stage = 'assistance_flagged'"
  ).get(visitId), 'and it is on the trail for the counsellor to pick up');
});

test('the board shows the two sides of the first counter apart', async () => {
  const { visitId } = await atTheCounter('Board');

  let board = (await api('GET', '/api/visits/board', undefined, 'cashier')).body;
  let row = board.rows.find((r) => r.id === visitId);
  assert.strictEqual(row.status, 'checked_in');
  assert.strictEqual(row.consultation_paid, false, 'waiting to pay');

  await api('POST', `/api/visits/${visitId}/consultation-fee`, { mode: 'cash' }, 'cashier');

  board = (await api('GET', '/api/visits/board', undefined, 'nurse')).body;
  row = board.rows.find((r) => r.id === visitId);
  assert.strictEqual(row.status, 'checked_in');
  assert.strictEqual(row.consultation_paid, true, 'waiting for the nurse');

  // The retired screening lane is gone from the board's own list of lanes.
  assert.ok(!board.stages.includes('financial_screening'));
  assert.deepStrictEqual(board.stages, [
    'waiting_room', 'checked_in', 'vitals_done', 'with_provider',
    'billing_pending', 'labs_pending', 'pharmacy_pending', 'checked_out',
  ], 'the cashier sits ahead of the lab now');
});
