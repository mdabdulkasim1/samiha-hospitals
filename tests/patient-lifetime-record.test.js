'use strict';
/**
 * The patient's permanent record.
 *
 * The clinic's ask, in their words: every test result linked to the patient
 * "as a record forever, so in future any further follow up all the doctor can
 * be seen while entering the patient register number".
 *
 * Three things follow from that and are checked here. A result belongs to the
 * patient rather than to the visit that produced it, so it is still on the file
 * years later and is not truncated away by a row limit. The same test done
 * repeatedly is a trend, because that is the question a follow-up actually
 * asks. And the register number opens the file — one patient, one number.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-record-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');

let server;
let base;
const tokens = {};
let patientId;
let uhid;

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

/**
 * A diabetic followed for three years, and one echocardiogram. Written
 * straight to the tables because the point under test is what comes back out
 * of a file that has been accumulating for years, which no amount of clicking
 * through the ordering screens in a test would produce.
 */
function seedHistory() {
  const doctor = db.prepare("SELECT id FROM users WHERE role = 'doctor' LIMIT 1").get().id;
  const tech = db.prepare("SELECT id FROM users WHERE role = 'lab' LIMIT 1").get().id;

  const years = [
    ['2023-04-11', '9.4', '186', 'high'],
    ['2024-01-08', '8.1', '154', 'high'],
    ['2024-11-19', '7.2', '131', 'high'],
    ['2025-08-02', '6.5', '112', 'normal'],
    ['2026-06-14', '6.1', '104', 'normal'],
  ];

  let n = 0;
  for (const [date, a1c, fbs, flag] of years) {
    n += 1;
    const at = `${date} 09:30:00`;
    const order = db.prepare(
      `INSERT INTO lab_orders (order_no, patient_id, doctor_id, status, ordered_at, reported_at,
         billing_status, released_at, released_by) VALUES (?,?,?,'reported',?,?,'paid',?,?)`
    ).run(`LABH${n}`, patientId, doctor, at, at, at, tech);
    const add = db.prepare(
      `INSERT INTO lab_order_items (order_id, test_name, price, unit, ref_range, result_value,
         abnormal_flag, status, result_by, result_at) VALUES (?,?,?,?,?,?,?,'verified',?,?)`
    );
    add.run(order.lastInsertRowid, 'HbA1c', 450, '%', '4.0 - 5.6', a1c, flag, tech, at);
    add.run(order.lastInsertRowid, 'Fasting Blood Sugar', 120, 'mg/dL', '70 - 100', fbs, flag, tech, at);
  }

  // A study reported in prose rather than a number, on a catalogue test so the
  // category is real rather than guessed.
  const echo = db.prepare("SELECT id FROM lab_tests WHERE code = 'ECHO'").get();
  const order = db.prepare(
    `INSERT INTO lab_orders (order_no, patient_id, doctor_id, status, ordered_at, reported_at,
       billing_status, released_at, released_by)
     VALUES (?,?,?,'reported','2026-07-01 10:00:00','2026-07-01 10:00:00','paid','2026-07-01 10:00:00',?)`
  ).run('LABHECHO', patientId, doctor, tech);
  db.prepare(
    `INSERT INTO lab_order_items (order_id, test_id, test_name, price, result_value, result_notes,
       abnormal_flag, status, result_by, result_at)
     VALUES (?,?,?,?,?,?,'normal','verified',?,'2026-07-01 10:00:00')`
  ).run(order.lastInsertRowid, echo.id, '2D Echocardiogram', 1500,
    'All four chambers normal in size. LV systolic function good, LVEF 62%.',
    'Normal study.', tech);
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['doctor', 'imran@samiha.local'],
    ['reception', 'reception@samiha.local'], ['lab', 'lab@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }

  const made = await api('POST', '/api/patients', {
    firstName: 'Lifelong', lastName: 'Patient', gender: 'female', age: 61,
    phone: '9845099001', consentTreatment: true, consentPrivacy: true,
  }, 'reception');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  patientId = made.body.id;
  uhid = made.body.uhid;
  seedHistory();
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a result is on the file with its value, its range and its flag', async () => {
  const { status, body } = await api('GET', `/api/patients/${patientId}`, undefined, 'doctor');
  assert.strictEqual(status, 200);

  assert.strictEqual(body.labOrders.length, 6, 'every order, none dropped');
  const oldest = body.labOrders.find((o) => o.order_no === 'LABH1');
  const a1c = oldest.items.find((i) => i.test_name === 'HbA1c');

  assert.strictEqual(a1c.result_value, '9.4');
  assert.strictEqual(a1c.unit, '%');
  // The range as it was printed beside the value at the time, not today's.
  assert.strictEqual(a1c.ref_range, '4.0 - 5.6');
  assert.strictEqual(a1c.abnormal_flag, 'high');
  assert.ok(a1c.result_by_name, 'and who reported it');
});

test('the newest order is first, by when it happened', async () => {
  const { body } = await api('GET', `/api/patients/${patientId}`, undefined, 'doctor');
  const dates = body.labOrders.map((o) => o.ordered_at);
  const sorted = dates.slice().sort().reverse();
  assert.deepStrictEqual(dates, sorted,
    'a back-dated order must not sort above a later one just because it was typed in last');
});

test('the same test over the years is a trend, oldest first', async () => {
  const { body } = await api('GET', `/api/patients/${patientId}`, undefined, 'doctor');
  const a1c = body.labTrends.find((t) => t.test_name === 'HbA1c');
  assert.ok(a1c, 'HbA1c has been done five times and should be trended');

  assert.deepStrictEqual(a1c.points.map((p) => p.value), ['9.4', '8.1', '7.2', '6.5', '6.1'],
    'a history reads left to right');
  assert.deepStrictEqual(a1c.points.map((p) => p.num), [9.4, 8.1, 7.2, 6.5, 6.1],
    'and carries numbers a chart can plot');
  assert.strictEqual(a1c.unit, '%');
  assert.strictEqual(a1c.points[0].flag, 'high');
  assert.strictEqual(a1c.points[4].flag, 'normal', 'the patient got better, and the file shows it');
});

test('a report written in prose is not charted as a number', async () => {
  const { body } = await api('GET', `/api/patients/${patientId}`, undefined, 'doctor');
  assert.ok(!body.labTrends.some((t) => t.test_name === '2D Echocardiogram'),
    'an echocardiogram is a paragraph and has no direction of travel');

  // It is still on the record, which is the point — just not in the chart.
  const echo = body.labOrders.find((o) => o.order_no === 'LABHECHO');
  assert.match(echo.items[0].result_value, /LVEF 62%/);
  assert.strictEqual(echo.items[0].result_notes, 'Normal study.');
});

test('a test done once is not a trend', async () => {
  const { body } = await api('GET', `/api/patients/${patientId}`, undefined, 'doctor');
  for (const t of body.labTrends) {
    assert.ok(t.points.length > 1, `"${t.test_name}" has one reading and is not a trend`);
  }
});

test('the price of a test is not part of the clinical record', async () => {
  const asDoctor = await api('GET', `/api/patients/${patientId}`, undefined, 'doctor');
  for (const o of asDoctor.body.labOrders) {
    for (const i of o.items) assert.strictEqual(i.price, null, 'a doctor reads results, not rates');
  }

  // Withheld from the role rather than missing from the record.
  const asAdmin = await api('GET', `/api/patients/${patientId}`, undefined, 'admin');
  const priced = asAdmin.body.labOrders.flatMap((o) => o.items).filter((i) => i.price > 0);
  assert.ok(priced.length, 'the desks that handle money still see what it cost');
});

test('the register number opens the file, and only the right one', async () => {
  const hit = await api('GET', `/api/patients?q=${encodeURIComponent(uhid)}`, undefined, 'doctor');
  assert.strictEqual(hit.status, 200);
  const exact = hit.body.rows.filter((r) => r.uhid === uhid);
  assert.strictEqual(exact.length, 1, 'one patient, one number');
  assert.strictEqual(exact[0].id, patientId);

  const miss = await api('GET', '/api/patients?q=SPD00000000', undefined, 'doctor');
  assert.strictEqual(miss.body.rows.filter((r) => r.uhid === 'SPD00000000').length, 0,
    'and a number nobody has matches nobody');
});

test('the mobile number finds the household, each with their own number', async () => {
  const res = await api('GET', '/api/patients/by-phone?phone=9845099001', undefined, 'reception');
  assert.strictEqual(res.status, 200);
  const mine = res.body.members.find((m) => m.id === patientId);
  assert.ok(mine, 'the patient is found by the number they gave');
  assert.strictEqual(mine.uhid, uhid, 'and the register number shown is theirs');
});
