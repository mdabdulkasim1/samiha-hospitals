'use strict';
/**
 * Flagging a result, and issuing the report that carries it.
 *
 * The bug worth the test: a good part of the catalogue publishes its range as
 * the clinical cut-off rather than as a pair of numbers — "< 150 normal ·
 * 150-199 borderline high" — because that is how the guideline reads. Nothing
 * numeric was stored against those tests, and the flagging compares numbers,
 * so every value came back normal. A triglyceride of 500 printed with "Normal"
 * beside it, which is worse than printing no flag at all.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-reports-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');
const refrange = require('../src/lib/refrange');

let server;
let base;
const tokens = {};
let patientId;

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

async function orderAndRelease(codes) {
  const tests = codes.map((c) => ({
    testId: db.prepare('SELECT id FROM lab_tests WHERE code = ?').get(c).id,
  }));
  const order = await api('POST', '/api/lab/orders', { patientId, tests }, 'doctor');
  assert.strictEqual(order.status, 201, JSON.stringify(order.body));
  const tech = db.prepare("SELECT id FROM users WHERE role = 'lab' LIMIT 1").get().id;
  db.prepare(
    `UPDATE lab_orders SET billing_status = 'paid', released_at = datetime('now'), released_by = ?
      WHERE id = ?`
  ).run(tech, order.body.id);
  await api('POST', `/api/lab/orders/${order.body.id}/collect`, { sampleType: 'blood' }, 'lab');
  await api('POST', `/api/lab/orders/${order.body.id}/start`, {}, 'lab');
  return order.body.id;
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['doctor', 'imran@samiha.local'],
    ['lab', 'lab@samiha.local'], ['reception', 'reception@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  patientId = db.prepare('SELECT id FROM patients ORDER BY id LIMIT 1').get().id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------- reading the range
test('a written range yields the bounds it states', () => {
  const cases = [
    ['< 55', null, 55],
    ['≤ 0.5', null, 0.5],
    ['> 90 · CKD-EPI formula', 90, null],
    ['INR 0.9 – 1.2', 0.9, 1.2],
    ['< 150 normal · 150–199 borderline high · 200–499 high', null, 150],
    ['Desirable < 200 · Borderline 200–239 · High ≥ 240', null, 200],
  ];
  for (const [text, low, high] of cases) {
    assert.deepStrictEqual(refrange.parse(text), { low, high }, text);
  }
});

test('the direction of a cut-off comes from the words, not the operator', () => {
  /*
   * For cholesterol "< 200" is the desirable end. For HDL the same operator
   * marks the dangerous one, because it is low HDL that is the problem — so
   * 34.7 is a floor here and 200 is a ceiling there.
   */
  assert.deepStrictEqual(
    refrange.parse('< 34.7 undesirable, high risk · > 77.3 desirable, low risk'),
    { low: 34.7, high: null });
  assert.deepStrictEqual(refrange.parse('Total cholesterol < 200'), { low: null, high: 200 });
});

test('a range that is a word, not a number, yields nothing', () => {
  for (const text of ['Negative', 'Clear and transparent', 'Radiologist report', '', null]) {
    assert.deepStrictEqual(refrange.parse(text), { low: null, high: null }, String(text));
  }
});

test('no test ends up with a floor above its ceiling', () => {
  // 0 - 0 is allowed and meant: "none expected", for what a urine should not
  // contain at all. A floor genuinely above its ceiling would flag everything.
  const bad = db.prepare(
    `SELECT code, ref_low, ref_high FROM lab_tests
      WHERE ref_low IS NOT NULL AND ref_high IS NOT NULL AND ref_low > ref_high`
  ).all();
  assert.deepStrictEqual(bad, [], 'a range read backwards would flag every result');
});

test('a trace of something that should be absent is abnormal, not critical', async () => {
  /*
   * "None expected" is stored as 0 - 0. Grading how far out a result is uses a
   * proportion of the bound, and a proportion of zero is zero — so one hyaline
   * cast, which is common and not news, used to come back critical.
   */
  const none = db.prepare(
    "SELECT id FROM lab_tests WHERE ref_low = 0 AND ref_high = 0 AND active = 1 LIMIT 1"
  ).get();
  assert.ok(none, 'the catalogue has a "none expected" test');

  const order = await api('POST', '/api/lab/orders',
    { patientId, tests: [{ testId: none.id }] }, 'doctor');
  const tech = db.prepare("SELECT id FROM users WHERE role = 'lab' LIMIT 1").get().id;
  db.prepare(
    `UPDATE lab_orders SET billing_status = 'paid', released_at = datetime('now'), released_by = ?
      WHERE id = ?`
  ).run(tech, order.body.id);
  await api('POST', `/api/lab/orders/${order.body.id}/collect`, { sampleType: 'urine' }, 'lab');
  await api('POST', `/api/lab/orders/${order.body.id}/start`, {}, 'lab');

  const { items } = (await api('GET', `/api/lab/orders/${order.body.id}`, undefined, 'lab')).body;
  const saved = await api('POST', `/api/lab/orders/${order.body.id}/results`,
    { results: [{ itemId: items[0].id, value: '1' }] }, 'lab');
  assert.strictEqual(saved.body[0].abnormal_flag, 'high', 'present, but not an emergency');

  const clear = await api('POST', `/api/lab/orders/${order.body.id}/results`,
    { results: [{ itemId: items[0].id, value: '0' }] }, 'lab');
  assert.strictEqual(clear.body[0].abnormal_flag, 'normal', 'and none is normal');
});

// --------------------------------------------------------------- the flags
test('a result is flagged against a range that was only ever written out', async () => {
  const id = await orderAndRelease(['LIP-LDL']);
  const { items } = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
  const ldl = items.find((i) => /LDL cholesterol/i.test(i.test_name));
  assert.ok(ldl, 'the LDL is on the order');

  // Its published range is "< 100 optimal · ... · > 190 very high" — prose.
  assert.match(ldl.ref_range, /optimal/);

  const saved = await api('POST', `/api/lab/orders/${id}/results`,
    { results: [{ itemId: ldl.id, value: '250' }] }, 'lab');
  const flag = saved.body.find((i) => i.id === ldl.id).abnormal_flag;
  assert.notStrictEqual(flag, 'normal',
    'an LDL of 250 must never print as normal');
  assert.strictEqual(flag, 'critical');
});

test('and a value inside that range is still normal', async () => {
  const id = await orderAndRelease(['LIP-LDL']);
  const { items } = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
  const ldl = items.find((i) => /LDL cholesterol/i.test(i.test_name));
  const saved = await api('POST', `/api/lab/orders/${id}/results`,
    { results: [{ itemId: ldl.id, value: '82' }] }, 'lab');
  assert.strictEqual(saved.body.find((i) => i.id === ldl.id).abnormal_flag, 'normal');
});

test('a low result is low even where low is the dangerous end', async () => {
  const id = await orderAndRelease(['LIP-HDL']);
  const { items } = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
  const hdl = items.find((i) => /HDL cholesterol/i.test(i.test_name));
  const saved = await api('POST', `/api/lab/orders/${id}/results`,
    { results: [{ itemId: hdl.id, value: '22' }] }, 'lab');
  const flag = saved.body.find((i) => i.id === hdl.id).abnormal_flag;
  assert.ok(['low', 'critical'].includes(flag), `an HDL of 22 should be low, got ${flag}`);
});

// -------------------------------------------------------------- the report
test('the report names who ran the sample and who released it', async () => {
  const id = await orderAndRelease(['CBC']);
  const { items } = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
  await api('POST', `/api/lab/orders/${id}/results`, {
    results: items.filter((i) => i.parent_item_id).map((i) => ({ itemId: i.id, value: '5' })),
  }, 'lab');
  await api('POST', `/api/lab/orders/${id}/verify`, {}, 'lab');

  const report = (await api('GET', `/api/lab/orders/${id}/report`, undefined, 'lab')).body;
  assert.ok(report.performed_by && report.performed_by.name,
    'a report leaving the building must say who ran it');
  assert.ok(report.verified_by && report.verified_by.name, 'and who released it');
  assert.strictEqual(report.verified_by.role, 'lab');
});

test('the report carries every parameter, its range and the result entered', async () => {
  const id = await orderAndRelease(['CBC']);
  const { items } = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
  const hb = items.find((i) => /^haemoglobin/i.test(i.test_name));
  await api('POST', `/api/lab/orders/${id}/results`, {
    results: items.filter((i) => i.parent_item_id)
      .map((i) => ({ itemId: i.id, value: i.id === hb.id ? '9.1' : '5' })),
  }, 'lab');
  await api('POST', `/api/lab/orders/${id}/verify`, {}, 'lab');

  const report = (await api('GET', `/api/lab/orders/${id}/report`, undefined, 'lab')).body;
  const params = report.items.filter((i) => i.parent_item_id);
  assert.ok(params.length > 10, 'every parameter is on the sheet');
  assert.ok(params.every((i) => i.ref_range), 'each with the range it is read against');
  assert.ok(params.every((i) => i.result_value !== null), 'and the value the bench entered');

  const printed = report.items.find((i) => i.id === hb.id);
  assert.strictEqual(printed.result_value, '9.1', 'the actual reading, not a rounding of it');
  assert.strictEqual(printed.abnormal_flag, 'low');

  // A panel's parameters follow it, so the sheet reads as the laboratory's.
  const order = report.items.map((i) => i.parent_item_id || i.id);
  assert.deepStrictEqual(order, order.slice().sort((a, b) => a - b),
    'parameters stay under the panel they belong to');
});

test('the reports list finds a report by patient, register number or order', async () => {
  const id = await orderAndRelease(['CBC']);
  const { items } = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
  await api('POST', `/api/lab/orders/${id}/results`, {
    results: items.filter((i) => i.parent_item_id).map((i) => ({ itemId: i.id, value: '5' })),
  }, 'lab');
  await api('POST', `/api/lab/orders/${id}/verify`, {}, 'lab');

  const order = db.prepare('SELECT order_no FROM lab_orders WHERE id = ?').get(id);
  const patient = db.prepare('SELECT uhid, first_name FROM patients WHERE id = ?').get(patientId);

  for (const term of [order.order_no, patient.uhid, patient.first_name]) {
    const res = await api('GET',
      `/api/lab/orders?status=reported&q=${encodeURIComponent(term)}`, undefined, 'lab');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.rows.some((r) => r.id === id), `not found by "${term}"`);
  }

  // A search matching nobody returns nothing rather than everything.
  const none = await api('GET', '/api/lab/orders?status=reported&q=zzzznothing', undefined, 'lab');
  assert.strictEqual(none.body.rows.length, 0);
});

// ------------------------------------------------- the range is the lab's
test('the laboratory can correct a reference range, and it sticks', async () => {
  /*
   * NABH asks a laboratory to verify its own intervals against its own
   * analysers and population, so the figures shipped here have to be
   * correctable — and a correction must survive the catalogue sync that runs
   * on every boot, or the pathologist's work would be undone by a restart.
   */
  const hb = db.prepare("SELECT * FROM lab_tests WHERE code = 'CBC-HB'").get();
  assert.ok(hb, 'haemoglobin is a parameter on the catalogue');

  const saved = await api('PATCH', `/api/masters/lab-tests/${hb.id}`, {
    refLow: 12, refHigh: 15, refText: '12 - 15 (adult female, verified in-house)',
  }, 'lab');
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.strictEqual(saved.body.ref_low, 12);
  assert.strictEqual(saved.body.ref_high, 15);
  assert.match(saved.body.ref_text, /verified in-house/);

  require('../src/db/catalogue').sync({ quiet: true });
  const after = db.prepare('SELECT * FROM lab_tests WHERE id = ?').get(hb.id);
  assert.strictEqual(after.ref_low, 12, 'a re-sync must not undo the pathologist');
  assert.match(after.ref_text, /verified in-house/);

  // And the corrected range is what the next result is read against.
  const order = await api('POST', '/api/lab/orders',
    { patientId, tests: [{ testId: hb.id }] }, 'doctor');
  const tech = db.prepare("SELECT id FROM users WHERE role = 'lab' LIMIT 1").get().id;
  db.prepare(
    `UPDATE lab_orders SET billing_status = 'paid', released_at = datetime('now'), released_by = ?
      WHERE id = ?`
  ).run(tech, order.body.id);
  await api('POST', `/api/lab/orders/${order.body.id}/collect`, { sampleType: 'blood' }, 'lab');
  await api('POST', `/api/lab/orders/${order.body.id}/start`, {}, 'lab');
  const { items } = (await api('GET', `/api/lab/orders/${order.body.id}`, undefined, 'lab')).body;
  const res = await api('POST', `/api/lab/orders/${order.body.id}/results`,
    { results: [{ itemId: items[0].id, value: '16' }] }, 'lab');
  assert.strictEqual(res.body[0].abnormal_flag, 'high',
    '16 is high against the clinic\'s 12-15, though it was normal against 13-17');
});

test('a range cannot be saved backwards', async () => {
  const hb = db.prepare("SELECT * FROM lab_tests WHERE code = 'CBC-HB'").get();
  const bad = await api('PATCH', `/api/masters/lab-tests/${hb.id}`,
    { refLow: 20, refHigh: 5 }, 'lab');
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /cannot be above/i);
});

test('setting a rate does not wipe the range beside it', async () => {
  // The two are edited from the same screen and the same endpoint; a field
  // left out of the request must be left alone rather than nulled.
  const t = db.prepare("SELECT * FROM lab_tests WHERE code = 'CBC'").get();
  const saved = await api('PATCH', `/api/masters/lab-tests/${t.id}`, { price: 199 }, 'admin');
  assert.strictEqual(saved.body.price, 199);
  assert.strictEqual(saved.body.ref_text, t.ref_text, 'the range is untouched');
  assert.strictEqual(saved.body.unit, t.unit);
});
