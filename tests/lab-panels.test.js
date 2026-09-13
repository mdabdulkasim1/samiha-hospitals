'use strict';
/**
 * Panels, and the parameters they are reported in.
 *
 * The clinic's ask: "showing the parameter of each test, so that lab
 * technician will enter based on parameter". A Complete Blood Count is one
 * line on the order and twenty-three figures on the report, and the bench was
 * being given a single box for all of them.
 *
 * So a panel is expanded into its parameters when it is ordered. That is the
 * right moment rather than at the bench, because it makes each parameter a row
 * of the record: its own value, its own reference range, its own flag, and its
 * own history on the patient's file. What must not change is the money — the
 * panel is the charge, and the parameters are free.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-panels-'));
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
let cbcId;
let singleId;

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

/** Order the tests, then put them on the bench with the counter satisfied. */
async function orderAndRelease(tests) {
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
    ['lab', 'lab@samiha.local'], ['cashier', 'cashier@samiha.local'],
    ['reception', 'reception@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  patientId = db.prepare('SELECT id FROM patients ORDER BY id LIMIT 1').get().id;
  cbcId = db.prepare("SELECT id FROM lab_tests WHERE code = 'CBC'").get().id;
  // A test with no parameters of its own, to prove the plain case still works.
  singleId = db.prepare(
    `SELECT id FROM lab_tests
      WHERE (component_of IS NULL OR component_of = '') AND category = 'lab' AND price > 0
        AND id NOT IN (SELECT DISTINCT t.id FROM lab_tests t
                        JOIN lab_tests c ON c.component_of = t.code)
      LIMIT 1`
  ).get().id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('ordering a panel brings its parameters down with it', async () => {
  const id = await orderAndRelease([{ testId: cbcId }]);
  const { items } = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;

  const panel = items.filter((i) => !i.parent_item_id);
  const params = items.filter((i) => i.parent_item_id);
  assert.strictEqual(panel.length, 1, 'one test was ordered');
  assert.ok(params.length > 10, `and it is reported in many, got ${params.length}`);
  assert.ok(params.every((i) => i.parent_item_id === panel[0].id), 'all under the panel');

  // The part that makes the job quick: each parameter arrives knowing what it
  // is measured in and what counts as normal.
  const hb = params.find((i) => /^haemoglobin/i.test(i.test_name));
  assert.ok(hb, 'haemoglobin is one of them');
  assert.strictEqual(hb.unit, 'g/dL');
  assert.ok(hb.ref_range, 'with the range it is read against');
});

test('a test with no parameters is still a single line', async () => {
  const id = await orderAndRelease([{ testId: singleId }]);
  const { items } = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
  assert.strictEqual(items.length, 1, 'nothing was invented for it');
  assert.strictEqual(items[0].parent_item_id, null);
});

test('the parameters are free — the panel is the charge', async () => {
  const id = await orderAndRelease([{ testId: cbcId }]);
  const { items } = (await api('GET', `/api/lab/orders/${id}`, undefined, 'admin')).body;
  const panel = items.find((i) => !i.parent_item_id);
  const params = items.filter((i) => i.parent_item_id);

  assert.ok(panel.price > 0, 'the blood count is charged');
  assert.ok(params.every((i) => i.price === 0),
    'and not one parameter is, or the patient pays twenty-three times for one test');

  const total = items.reduce((t, i) => t + Number(i.price || 0), 0);
  assert.strictEqual(total, panel.price, 'the order totals the panel and nothing more');
});

test('the cashier prices what was ordered, not what it expands into', async () => {
  const order = await api('POST', '/api/lab/orders', {
    patientId, tests: [{ testId: cbcId }],
  }, 'doctor');
  const pending = await api('GET', '/api/billing/diagnostics/pending', undefined, 'cashier');
  const mine = pending.body.rows.find((r) => r.id === order.body.id);
  assert.ok(mine, 'the order is at the counter');
  assert.strictEqual(mine.items.length, 1,
    'one line to price — a counter asked to rate twenty-three parameters is unusable');
  assert.match(mine.items[0].test_name, /blood count/i);
});

test('the bench enters a parameter at a time, and each is flagged on its own', async () => {
  const id = await orderAndRelease([{ testId: cbcId }]);
  const { items } = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
  const hb = items.find((i) => /^haemoglobin/i.test(i.test_name));

  const saved = await api('POST', `/api/lab/orders/${id}/results`,
    { results: [{ itemId: hb.id, value: '9.1' }] }, 'lab');
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.body.find((i) => i.id === hb.id).abnormal_flag, 'low',
    'read against the parameter\'s own range, not the panel\'s');

  // One parameter in is not a finished blood count.
  const mid = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
  assert.strictEqual(mid.status, 'in_process', 'the order is not done on one figure');
});

test('a panel completes and releases without anybody typing into the panel itself', async () => {
  const id = await orderAndRelease([{ testId: cbcId }]);
  const { items } = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
  const params = items.filter((i) => i.parent_item_id);

  await api('POST', `/api/lab/orders/${id}/results`, {
    results: params.map((i) => ({ itemId: i.id, value: '5' })),
  }, 'lab');

  const done = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
  assert.strictEqual(done.status, 'result_entered',
    'the panel row holds no result and must not hold the order open');

  const verified = await api('POST', `/api/lab/orders/${id}/verify`, {}, 'lab');
  assert.strictEqual(verified.status, 200, JSON.stringify(verified.body));
  assert.strictEqual(verified.body.order.status, 'reported');

  // And the panel row is signed off with the rest of them.
  const after = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
  assert.ok(after.items.every((i) => i.status === 'verified'), 'nothing left unsigned');
});

test('a worklist names the test that was ordered, not its parameters', async () => {
  const id = await orderAndRelease([{ testId: cbcId }]);
  const list = await api('GET', '/api/lab/orders', undefined, 'lab');
  const mine = list.body.rows.find((r) => r.id === id);
  assert.ok(mine, 'the order is on the worklist');
  assert.strictEqual(mine.item_count, 1);
  assert.doesNotMatch(mine.tests, /haemoglobin/i,
    'a worklist listing every parameter of every panel is unreadable');
});

test('each parameter earns its own history on the patient\'s file', async () => {
  // Two blood counts, so haemoglobin has somewhere to trend.
  for (const hb of ['9.1', '11.4']) {
    const id = await orderAndRelease([{ testId: cbcId }]);
    const { items } = (await api('GET', `/api/lab/orders/${id}`, undefined, 'lab')).body;
    const target = items.find((i) => /^haemoglobin/i.test(i.test_name));
    await api('POST', `/api/lab/orders/${id}/results`,
      { results: [{ itemId: target.id, value: hb }] }, 'lab');
  }

  const record = (await api('GET', `/api/patients/${patientId}`, undefined, 'doctor')).body;
  const trend = record.labTrends.find((t) => /^haemoglobin/i.test(t.test_name));
  assert.ok(trend, 'haemoglobin trends in its own right, not buried in a blood count');
  assert.ok(trend.points.length >= 2);
  assert.strictEqual(trend.unit, 'g/dL');

  // The panel itself never trends — it has no value of its own to trend.
  assert.ok(!record.labTrends.some((t) => /complete blood count/i.test(t.test_name)));
});
