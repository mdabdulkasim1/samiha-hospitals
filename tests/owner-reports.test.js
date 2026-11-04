'use strict';
/**
 * The report shelf, and the two things it must never do.
 *
 * It must never show an empty table where it means "nothing recorded". A
 * blank complaints report and a clinic with no complaints look identical on
 * screen, and only one of them is good news. Every report with no data
 * behind it declares what is missing instead, and the tests below hold each
 * of them to that and then watch it flip once a record exists.
 *
 * And it must never be reachable by anyone but the owner. The shelf carries
 * payroll, the balance sheet and what every doctor brings in; the gate is
 * requireOwner, which an administrator does not pass. The registers behind
 * it are the opposite and deliberately so — a safety register only a
 * director can write to is a safety register with nothing in it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-rep-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');
const reports = require('../src/lib/reports');

let server;
let base;
const tokens = {};

async function api(method, p, body, as = 'owner') {
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

const today = () => new Date().toISOString().slice(0, 10);
const shift = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const WINDOW = `?from=${shift(-40)}&to=${today()}`;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['counselor', 'counselor@samiha.local'],
    ['cashier', 'cashier@samiha.local'], ['nurse', 'nurse@samiha.local'],
    ['reception', 'reception@samiha.local'], ['lab', 'lab@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, email);
    tokens[as] = r.body.token;
  }
  const made = await api('POST', '/api/masters/staff',
    { name: 'The owner', role: 'owner', email: 'owner@samiha.local', password: 'Samiha#2026' }, 'admin');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  tokens.owner = (await api('POST', '/api/auth/login',
    { username: 'owner@samiha.local', password: 'Samiha#2026' }, null)).body.token;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// -------------------------------------------------------------------- the door
test('the shelf is the owner\'s, and the administrator does not pass', async () => {
  assert.strictEqual((await api('GET', '/api/owner/reports')).status, 200);
  for (const who of ['admin', 'counselor', 'cashier', 'nurse']) {
    assert.strictEqual((await api('GET', '/api/owner/reports', undefined, who)).status, 403, who);
    assert.strictEqual((await api('GET', '/api/owner/reports/payroll', undefined, who)).status, 403, who);
    assert.strictEqual((await api('GET', '/api/owner/position', undefined, who)).status, 403, who);
  }
  assert.strictEqual((await api('GET', '/api/owner/reports', undefined, null)).status, 401);
  assert.strictEqual((await api('GET', '/api/owner/reports/not-a-report')).status, 404);
});

test('the registers are the clinic\'s to write, not the owner\'s alone', async () => {
  /*
   * The point of the split. If a nurse cannot log the near miss she just saw,
   * the register fills up with nothing and the report built on it is a lie
   * of omission.
   */
  for (const who of ['nurse', 'lab', 'reception', 'cashier']) {
    assert.strictEqual((await api('GET', '/api/registers/incidents/meta', undefined, who)).status, 200, who);
    const made = await api('POST', '/api/registers/incidents', {
      detail: `Seen by ${who}`, kind: 'other', harm: 'near_miss',
    }, who);
    assert.strictEqual(made.status, 201, `${who} must be able to report an incident`);
  }
  // Payroll is the exception: it says what people are paid.
  for (const who of ['nurse', 'reception', 'cashier', 'counselor']) {
    assert.strictEqual((await api('GET', '/api/registers/payroll', undefined, who)).status, 403, who);
  }
  assert.strictEqual((await api('GET', '/api/registers/payroll', undefined, 'admin')).status, 200);
});

// ------------------------------------------------------- the shelf as a whole
test('every report on the shelf runs, or says what it needs', async () => {
  const { groups } = (await api('GET', '/api/owner/reports')).body;
  const all = groups.flatMap((g) => g.reports);
  assert.ok(all.length >= 36, `the shelf carries ${all.length} reports`);

  for (const card of all) {
    // Six are pointers to reports built on another tab — deliberately not
    // duplicated, because a report in two places drifts into two answers.
    if (card.at) continue;
    const r = await api('GET', `/api/owner/reports/${card.key}${WINDOW}`);
    assert.strictEqual(r.status, 200, `${card.key} returned ${r.status}`);
    if (r.body.needs) {
      assert.ok(r.body.needs.length > 20, `${card.key} explains what is missing`);
      assert.deepStrictEqual(r.body.rows, [], `${card.key} shows no table when it has no data`);
    } else {
      assert.ok(Array.isArray(r.body.columns), `${card.key} declares its columns`);
      assert.ok(Array.isArray(r.body.rows), `${card.key} returns rows`);
    }
  }
});

test('a report with nothing behind it says so instead of showing an empty table', async () => {
  /*
   * The whole reason this distinction exists. Before anything is recorded
   * the hygiene report must not render as a clean clinic.
   */
  const blank = await api('GET', `/api/owner/reports/hygiene${WINDOW}`);
  assert.ok(blank.body.needs, 'an unused register declares itself');
  assert.match(blank.body.needs, /never checked/i);

  const logged = await api('POST', '/api/registers/hygiene', {
    area: 'Sample collection', kind: 'disinfection', score: 92, doneBy: 'Housekeeping',
  }, 'nurse');
  assert.strictEqual(logged.status, 201, JSON.stringify(logged.body));

  const now = await api('GET', `/api/owner/reports/hygiene${WINDOW}`);
  assert.ok(!now.body.needs, 'once something is logged the report is real');
  assert.strictEqual(now.body.rows.length, 1);
  assert.strictEqual(now.body.rows[0].area, 'Sample collection');
});

test('a score decides pass or fail, so a round cannot be scored 40 and ticked off', async () => {
  const bad = await api('POST', '/api/registers/hygiene',
    { area: 'Toilets', score: 40, passed: true }, 'nurse');
  assert.strictEqual(bad.status, 201);
  assert.strictEqual(bad.body.passed, 0, 'the score wins over the tick');

  const unscored = await api('POST', '/api/registers/hygiene',
    { area: 'Ward', kind: 'hand_hygiene_audit', passed: true }, 'nurse');
  assert.strictEqual(unscored.body.passed, 1, 'where there is no score, the person doing the round says');

  assert.strictEqual((await api('POST', '/api/registers/hygiene',
    { area: 'Ward', score: 140 }, 'nurse')).status, 400);
});

// --------------------------------------------------------- safety incidents
test('an incident that reached a patient cannot be closed with nothing learned', async () => {
  const made = await api('POST', '/api/registers/incidents', {
    detail: 'Wrong strength dispensed; patient took one dose',
    kind: 'medication', harm: 'minor',
  }, 'nurse');
  assert.strictEqual(made.status, 201);

  /*
   * Closing an incident is the clinic saying it learned something. If the
   * root cause and the corrective action are blank, nothing was learned and
   * the record would say otherwise — so the close is refused.
   */
  const premature = await api('PATCH', `/api/registers/incidents/${made.body.id}`,
    { status: 'closed' }, 'nurse');
  assert.strictEqual(premature.status, 400);
  assert.match(premature.body.error, /root cause and a corrective action/i);

  const proper = await api('PATCH', `/api/registers/incidents/${made.body.id}`, {
    status: 'closed',
    rootCause: 'Two strengths of the same drug stored in one bin',
    correctiveAction: 'Split the bin and relabel; checked at the weekly count',
    ownerName: 'Pharmacy — Nafisa',
  }, 'nurse');
  assert.strictEqual(proper.status, 200);
  assert.ok(proper.body.closed_on);

  // A near miss has nothing to learn from yet and may be closed freely.
  const near = await api('POST', '/api/registers/incidents',
    { detail: 'Label caught before the sample ran', harm: 'near_miss' }, 'lab');
  assert.strictEqual((await api('PATCH', `/api/registers/incidents/${near.body.id}`,
    { status: 'closed' }, 'lab')).status, 200);
});

test('the incident report separates a near miss from harm, and counts both', async () => {
  const r = await api('GET', `/api/owner/reports/incidents${WINDOW}`);
  assert.strictEqual(r.status, 200);
  const tile = (label) => r.body.tiles.find((t) => t.label.toLowerCase().includes(label));
  assert.ok(tile('near misses').value > 0, 'near misses are counted, not discarded');
  assert.ok(tile('harm'), 'harm has its own tile');
  assert.ok(r.body.notes.some((n) => /reporting them/i.test(n)),
    'the report warns that a rising count may be better reporting');
});

// ------------------------------------------------------------- attendance
test('attendance can be marked and re-marked without doubling up', async () => {
  const staff = (await api('GET', '/api/registers/attendance/meta', undefined, 'nurse')).body.staff;
  const first = staff[0];

  const save = await api('PUT', '/api/registers/attendance', {
    date: shift(-1),
    marks: [{ userId: first.id, status: 'present', workedHours: 8, overtimeHours: 2 }],
  }, 'nurse');
  assert.strictEqual(save.status, 200, JSON.stringify(save.body));

  // Marking the same person and day again corrects the entry rather than
  // adding a second one — a roster gets corrected all day long.
  await api('PUT', '/api/registers/attendance', {
    date: shift(-1),
    marks: [{ userId: first.id, status: 'present', workedHours: 9, overtimeHours: 3 }],
  }, 'nurse');

  const rows = db.prepare('SELECT * FROM staff_attendance WHERE user_id = ? AND on_date = ?')
    .all(first.id, shift(-1));
  assert.strictEqual(rows.length, 1, 'one row per person per day per shift');
  assert.strictEqual(rows[0].overtime_hours, 3);

  assert.strictEqual((await api('PUT', '/api/registers/attendance',
    { date: shift(5), marks: [] }, 'nurse')).status, 400, 'a day in the future cannot be marked');

  const rep = await api('GET', `/api/owner/reports/attendance${WINDOW}`);
  assert.ok(!rep.body.needs);
  assert.ok(rep.body.notes.some((n) => /unmarked day is not an absence/i.test(n)));
});

// ---------------------------------------------------------------- payroll
test('net pay is worked out from its parts, never typed', async () => {
  const made = await api('POST', '/api/registers/payroll', {
    period: today().slice(0, 7), person: 'A. Nurse', kind: 'salary',
    basic: 20000, allowances: 2500, overtime: 1500, deductions: 1800,
    // A net pay that disagrees with its own components is the one thing a
    // payroll must never print, so what is sent here is ignored.
    netPay: 999999,
  }, 'admin');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.strictEqual(made.body.net_pay, 22200);

  assert.strictEqual((await api('POST', '/api/registers/payroll', {
    period: today().slice(0, 7), person: 'B. Clerk', basic: 1000, deductions: 5000,
  }, 'admin')).status, 400, 'deductions cannot exceed the pay');

  const rep = await api('GET', `/api/owner/reports/payroll?period=${today().slice(0, 7)}`);
  assert.ok(!rep.body.needs);
  const against = rep.body.tiles.find((t) => t.label.includes('cash book'));
  assert.ok(against, 'the payroll is shown against what actually left the bank');
});

// ----------------------------------------------------------- the ageing rule
test('a part payment does not make an old debt new', async () => {
  /*
   * The bug this guards against is bucketing receivables by last activity.
   * A bill raised 200 days ago and part-paid yesterday is not a fresh debt;
   * its unpaid half is 200 days old, and a ledger that says otherwise reports
   * itself healthier than it is.
   */
  const old = shift(-200);
  db.prepare(
    `INSERT INTO invoices (invoice_no, patient_id, kind, status, gross, net, paid, balance, created_at)
     VALUES ('AGE-1', 1, 'opd', 'partial', 5000, 5000, 2000, 3000, ?)`).run(`${old} 10:00:00`);
  db.prepare(
    `INSERT INTO payments (receipt_no, invoice_id, patient_id, amount, mode, paid_at)
     VALUES ('AGE-R1', (SELECT id FROM invoices WHERE invoice_no = 'AGE-1'), 1, 2000, 'cash', datetime('now'))`).run();

  const r = await api('GET', '/api/owner/reports/receivables');
  const over180 = r.body.rows.find((x) => x.age === 'Over 180 days');
  assert.ok(over180.patient >= 3000,
    'the unpaid half is aged from the invoice, not from yesterday\'s receipt');
  assert.ok(r.body.notes.some((n) => /not from the last payment/i.test(n)));
});

test('a bill with a live claim is owed by the insurer, not demanded twice', async () => {
  const insurer = db.prepare('SELECT id FROM insurers LIMIT 1').get();
  db.prepare(
    `INSERT INTO invoices (invoice_no, patient_id, kind, status, gross, net, paid, balance, created_at)
     VALUES ('AGE-2', 1, 'opd', 'unpaid', 8000, 8000, 0, 8000, datetime('now'))`).run();
  const inv = db.prepare("SELECT id FROM invoices WHERE invoice_no = 'AGE-2'").get().id;
  db.prepare(
    `INSERT INTO patient_policies (patient_id, insurer_id, policy_no, sum_insured)
     VALUES (1, ?, 'POL-1', 100000)`).run(insurer.id);
  const policy = db.prepare("SELECT id FROM patient_policies WHERE policy_no = 'POL-1'").get().id;
  db.prepare(
    `INSERT INTO claims (claim_no, patient_id, policy_id, insurer_id, invoice_id, status,
       billed_amount, claimed_amount, submitted_at)
     VALUES ('CLM-1', 1, ?, ?, ?, 'submitted', 8000, 8000, datetime('now'))`)
    .run(policy, insurer.id, inv);

  const r = await api('GET', '/api/owner/reports/receivables');
  const fresh = r.body.rows.find((x) => x.age === '0-30 days');
  assert.ok(fresh.insurance >= 8000, 'the claim is counted as owed by the insurer');
  assert.ok(r.body.notes.some((n) => /not demanded twice/i.test(n)));
});

// ------------------------------------------------------------ balance sheet
test('the balance sheet asks for what the system cannot see, then balances', async () => {
  const before = await api('GET', '/api/owner/reports/balance-sheet');
  assert.ok(before.body.needs, 'it does not invent a bank balance');
  assert.match(before.body.needs, /bank balance/i);

  const set = await api('PUT', '/api/owner/position', {
    asOn: today(),
    values: { bank: 450000, cash_in_hand: 25000, loans: 300000, capital: 1500000,
      accumulated_depreciation: 120000 },
  });
  assert.strictEqual(set.status, 200, JSON.stringify(set.body));

  const r = await api('GET', '/api/owner/reports/balance-sheet');
  assert.ok(!r.body.needs);
  const row = (name) => r.body.rows.find((x) => x.line === name);
  assert.strictEqual(row('Bank balances').amount, 450000);
  assert.strictEqual(row('Less: accumulated depreciation').amount, -120000);

  /*
   * It has to balance. "Retained in the business" is the balancing figure
   * and is labelled as one, so the two totals agree by construction — the
   * test is that the construction is right.
   */
  const assets = row('Total assets').amount;
  const other = row('Total liabilities and owner\'s funds').amount;
  assert.ok(Math.abs(assets - other) < 0.5, `${assets} against ${other}`);
  assert.strictEqual(row('Retained in the business').source, 'Balancing figure');

  assert.strictEqual((await api('PUT', '/api/owner/position',
    { asOn: shift(5), values: { bank: 1 } })).status, 400, 'not a date in the future');
});

// ------------------------------------------------------------------ the rest
test('the live reports ignore the date range, and say they do', async () => {
  for (const key of ['receivables', 'payables', 'pending', 'compliance', 'expiry']) {
    const r = await api('GET', `/api/owner/reports/${key}?from=2099-01-01&to=2099-01-02`);
    assert.strictEqual(r.status, 200, key);
    if (r.body.needs) continue;
    const notes = (r.body.notes || []).join(' ');
    assert.ok(/live|ignores the date range|whichever month/i.test(notes),
      `${key} tells the reader it is not confined to the window`);
  }
});

test('pending actions gathers what is waiting across the whole clinic', async () => {
  const r = await api('GET', '/api/owner/reports/pending');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.rows.length > 0, 'the seeded clinic has something queued');
  for (const row of r.body.rows) {
    assert.ok(row.area && row.what && row.where, 'each line says what, how many and where it lives');
    assert.ok(row.count > 0, 'nothing with a count of zero is listed');
  }
});

test('a report carries its caveats, not just its numbers', () => {
  /*
   * A count without its denominator or its blind spot gets somebody blamed
   * for something the figure does not actually show. Every report that can
   * mislead has to say how.
   */
  const args = { from: shift(-40), to: today(), period: today().slice(0, 7) };
  const mustExplain = ['waiting', 'records', 'incidents', 'diagnostics', 'critical',
    'pharmacy-stock', 'services', 'cashflow', 'inventory'];
  for (const key of mustExplain) {
    const out = reports.run(key, args);
    if (out.needs) continue;
    assert.ok((out.notes || []).length > 0, `${key} explains itself`);
  }
});
