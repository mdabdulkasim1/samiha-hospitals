'use strict';
/**
 * Opening a dashboard number.
 *
 * The point of these tests is one property: whatever list a figure opens must
 * add up to the figure. A count that nobody can reconcile against its detail
 * is worse than no count at all, so every case here reads the dashboard and
 * the drill-down in the same breath and holds them against each other.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-drill-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');
const scheduling = require('../src/services/scheduling');

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

const board = async (as = 'admin') => (await api('GET', '/api/reports/dashboard', undefined, as)).body;
const detail = (metric, as = 'admin') =>
  api('GET', `/api/reports/dashboard/detail?metric=${metric}`, undefined, as);

const round2 = (n) => Math.round(n * 100) / 100;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['cashier', 'cashier@samiha.local'], ['imran', 'imran@samiha.local'],
    ['arif', 'arif@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.imran = db.prepare("SELECT id FROM users WHERE email = 'imran@samiha.local'").get().id;
  ids.arif = db.prepare("SELECT id FROM users WHERE email = 'arif@samiha.local'").get().id;

  // An enquiry who has not been registered, and one who has.
  ids.enquiry = (await api('POST', '/api/patients', {
    firstName: 'Anand', lastName: 'Raj', phone: '9845030001', gender: 'male',
    age: 31, stage: 'enquiry',
  }, 'reception')).body.id;

  ids.registered = (await api('POST', '/api/patients', {
    firstName: 'Meena', lastName: 'Kumari', phone: '9845030002', gender: 'female',
    age: 38, consentTreatment: true,
  }, 'reception')).body.id;

  // Two doctors seeing patients today, so scoping has something to filter.
  // A patient may only have one visit open at a time, so each needs their own.
  ids.walkIns = [];
  for (const [i, doctorId] of [ids.imran, ids.imran, ids.arif].entries()) {
    const p = await api('POST', '/api/patients', {
      firstName: `Walkin${i}`, lastName: 'Patel', phone: `98450400${10 + i}`,
      gender: 'male', age: 30 + i, consentTreatment: true,
    }, 'reception');
    assert.strictEqual(p.status, 201, JSON.stringify(p.body));
    const v = await api('POST', '/api/visits/arrive', {
      patientId: p.body.id, doctorId, visitType: 'opd', reasonForVisit: 'Fever',
    }, 'reception');
    assert.strictEqual(v.status, 201, JSON.stringify(v.body));
    ids.walkIns.push(p.body.id);
  }

  await api('POST', '/api/appointments', {
    doctorId: ids.imran, scheduledAt: `${scheduling.dateKey(new Date())} 18:30:00`,
    patientId: ids.registered, reason: 'Review',
  }, 'reception');
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------- the counting tiles
test('each patient count opens exactly the rows it was counted from', async () => {
  const d = await board();
  const cases = [
    ['enquiry_patients', d.patients.enquiry],
    ['registered_patients', d.patients.registered],
    ['converted', d.patients.convertedFromEnquiry],
    ['self_paying', d.patients.uninsured],
    ['insured', d.patients.insured],
  ];
  for (const [metric, figure] of cases) {
    const res = await detail(metric);
    assert.strictEqual(res.status, 200, `${metric}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.total, figure,
      `${metric} listed ${res.body.total} rows for a tile reading ${figure}`);
  }
});

test('self-paying and insured together account for every registered patient', async () => {
  const d = await board();
  const self = (await detail('self_paying')).body.total;
  const insured = (await detail('insured')).body.total;
  assert.strictEqual(self + insured, d.patients.registered,
    'a registered patient either has an insurer on file or settles at the counter');
});

test('the day tiles open the day, not the whole register', async () => {
  const d = await board();
  const visits = await detail('opd_visits');
  assert.strictEqual(visits.body.total, d.opd.visits);
  const appts = await detail('appointments');
  assert.strictEqual(appts.body.total, d.appointments.total);

  // Every row really is today's.
  const today = new Date().toISOString().slice(0, 10);
  for (const r of visits.body.rows) assert.ok(String(r.at).startsWith(today), `stale visit ${r.at}`);
  for (const r of appts.body.rows) assert.ok(String(r.at).startsWith(today), `stale appointment ${r.at}`);
});

test('open enquiries lists the ones still unanswered, not every enquiry', async () => {
  await api('POST', '/api/enquiries', {
    name: 'Walk-in caller', phone: '9845030003', source: 'phone', subject: 'Cardiology fees',
  }, 'reception');
  const d = await board();
  const res = await detail('open_enquiries');
  assert.strictEqual(res.body.total, d.enquiries.open);
  assert.ok(res.body.rows.length > 0, 'the enquiry just raised should be in the list');
});

// ----------------------------------------------------------- the money tiles
test('the receipts listed add up to the rupees collected', async () => {
  const d = await board();
  const res = await detail('collections', 'cashier');
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.total, d.revenue.receipts, 'one row per receipt');
  const sum = res.body.rows.reduce((a, r) => a + Number(r.amount), 0);
  assert.strictEqual(round2(sum), round2(d.revenue.collected),
    'the receipts must add up to the figure on the tile');
});

test('the open invoices listed add up to what is still to collect', async () => {
  const d = await board();
  const res = await detail('outstanding', 'cashier');
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const sum = res.body.rows.reduce((a, r) => a + Number(r.balance), 0);
  assert.strictEqual(round2(sum), round2(d.revenue.outstanding));
  for (const r of res.body.rows) {
    assert.ok(['unpaid', 'partial'].includes(r.status), `a settled invoice crept in: ${r.status}`);
    assert.ok(Number(r.balance) > 0, 'nothing with a zero balance is still to collect');
  }
});

test('the bed list accounts for every bed, occupied and free alike', async () => {
  const d = await board();
  const res = await detail('beds');
  assert.strictEqual(res.body.total, d.ipd.beds.total);
  const occupied = res.body.rows.filter((r) => r.status === 'occupied');
  assert.strictEqual(occupied.length, d.ipd.beds.occupied);
  for (const b of occupied) assert.ok(b.name, 'an occupied bed must name who is in it');
});

// ------------------------------------------------------------------- access
test('a doctor drills into their own clinic and nobody else\'s', async () => {
  const all = await detail('opd_visits', 'admin');
  const mine = await detail('opd_visits', 'imran');
  assert.ok(all.body.total > mine.body.total,
    'the whole clinic saw more patients today than this one doctor');
  const doctors = new Set(mine.body.rows.map((r) => r.doctor));
  assert.deepStrictEqual([...doctors], ['Dr. Imran Sheikh']);

  const theirs = await detail('opd_visits', 'arif');
  assert.ok(theirs.body.rows.every((r) => r.doctor === 'Dr. Arif Hussain'));
});

test('a doctor is refused the money detail', async () => {
  for (const metric of ['collections', 'outstanding', 'self_paying', 'insured']) {
    const res = await detail(metric, 'imran');
    assert.strictEqual(res.status, 403, `${metric} should be closed to a doctor`);
  }
});

test('the cashier gets the money detail', async () => {
  for (const metric of ['collections', 'outstanding', 'self_paying', 'insured']) {
    assert.strictEqual((await detail(metric, 'cashier')).status, 200, metric);
  }
});

test('an unknown metric is refused rather than guessed at', async () => {
  for (const bad of ['', 'nonsense', '../../etc/passwd', 'constructor']) {
    const res = await api('GET',
      `/api/reports/dashboard/detail?metric=${encodeURIComponent(bad)}`, undefined, 'admin');
    assert.strictEqual(res.status, 400, `"${bad}" should be refused`);
  }
});

test('signing out closes the detail too', async () => {
  const res = await api('GET', '/api/reports/dashboard/detail?metric=beds', undefined, null);
  assert.strictEqual(res.status, 401);
});
