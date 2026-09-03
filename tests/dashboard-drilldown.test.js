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
    ['arif', 'arif@samiha.local'], ['lab', 'lab@samiha.local'],
    ['nurse', 'nurse@samiha.local'], ['counselor', 'counselor@samiha.local'],
    ['pharmacy', 'pharmacy@samiha.local'],
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

test('the dashboard carries no money to anyone who does not handle it', async () => {
  // The technician, the nurse, the doctor and the pharmacist read the same
  // board as everybody else. What the clinic took today is not on it.
  for (const as of ['imran', 'lab', 'nurse', 'pharmacy']) {
    const d = (await api('GET', '/api/reports/dashboard', undefined, as)).body;
    assert.strictEqual(d.revenue, null, `${as} is sent no revenue at all`);
    assert.strictEqual(d.pharmacy.salesToday, null, `${as} is sent no counter takings`);
    assert.strictEqual(d.insurance.receivable, null, `${as} is sent no receivable`);
    // Absent, not zeroed: a zero is a figure, and a wrong one.
    assert.notStrictEqual(d.revenue, 0);

    // The patient and department side of the board is untouched.
    assert.ok(d.opd, 'the day’s visits');
    assert.ok(d.lab, 'the day’s diagnostics');
    assert.ok(d.ipd.beds, 'the beds');
    assert.ok(d.patients.registered >= 0, 'the patients');

    const trend = (await api('GET', '/api/reports/trend?days=14', undefined, as)).body;
    assert.ok(trend.length, 'the footfall still comes through');
    assert.ok(trend.every((r) => r.collected === undefined), 'without the takings');
    assert.ok(trend.every((r) => r.visits !== undefined), 'but with the visits');
  }

  // And it is the same three desks everywhere the figure could be reached.
  for (const as of ['cashier', 'counselor', 'admin']) {
    const d = (await api('GET', '/api/reports/dashboard', undefined, as)).body;
    assert.ok(d.revenue, `${as} handles money and is sent it`);
    assert.ok(typeof d.revenue.collected === 'number');
    const trend = (await api('GET', '/api/reports/trend?days=14', undefined, as)).body;
    assert.ok(trend.every((r) => r.collected !== undefined));
  }
});

test('the money reports are closed to everyone but those three desks', async () => {
  const win = WINDOW();
  const MONEY = ['trend_collected', 'revenue_sliding', 'revenue_assistance', 'revenue_outstanding'];
  for (const metric of MONEY) {
    for (const as of ['imran', 'reception']) {
      const res = await rdetail(metric, win, as);
      assert.strictEqual(res.status, 403, `${metric} should be closed to ${as}`);
      assert.match(res.body.error, /admin, cashier, counselor/);
    }
    assert.strictEqual((await rdetail(metric, win, 'admin')).status, 200, metric);
  }

  // What is not about money stays open to the desks it always was.
  for (const metric of ['trend_visits', 'trend_lab', 'turnaround_visits']) {
    assert.strictEqual((await rdetail(metric, win, 'imran')).status, 200, metric);
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

// ------------------------------------------------------- the reports screen
const rdetail = (metric, params, as = 'admin') =>
  api('GET', '/api/reports/detail?' + new URLSearchParams({ metric, ...params }), undefined, as);

const WINDOW = () => ({
  from: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
  to: new Date().toISOString().slice(0, 10),
});

test('the footfall figures open exactly what they counted', async () => {
  const w = WINDOW();
  const trend = (await api('GET', '/api/reports/trend?days=31')).body;
  const win = { from: trend[0].day, to: trend[trend.length - 1].day };
  const sum = (k) => trend.reduce((a, r) => a + Number(r[k] || 0), 0);

  for (const [metric, key] of [
    ['trend_visits', 'visits'],
    ['trend_appointments', 'appointments'],
    ['trend_admissions', 'admissions'],
  ]) {
    const res = await rdetail(metric, win);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.total, sum(key), `${metric} does not match the trend total`);
  }

  const receipts = await rdetail('trend_collected', win);
  assert.strictEqual(round2(receipts.body.rows.reduce((a, r) => a + Number(r.amount), 0)),
    round2(sum('collected')), 'the receipts must add up to the collected figure');
  void w;
});

test('the diagnostics a report counts can be opened, and reported ones printed', async () => {
  const win = WINDOW();
  const res = await rdetail('trend_lab', win);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  // It answers for the same window the tile was added up over.
  const trend = (await api('GET', '/api/reports/trend?days=31', undefined, 'cashier')).body;
  const inWindow = trend.filter((r) => r.day >= win.from && r.day <= win.to);
  const counted = inWindow.reduce((a, r) => a + Number(r.lab_orders || 0), 0);
  assert.strictEqual(res.body.total, counted, 'the list adds up to the figure on the tile');

  for (const r of res.body.rows) {
    assert.ok(r.order_no, 'each row names its order');
    assert.ok(Number(r.id) > 0, 'and carries the id the report prints from');
    assert.ok(r.tests, 'and says what was asked for');
    assert.notStrictEqual(r.status, 'cancelled', 'a cancelled order is not a diagnostic performed');
  }

  // A row whose report is out prints that report; the id resolves to it.
  const reported = res.body.rows.find((r) => ['result_entered', 'verified', 'reported'].includes(r.status));
  if (reported) {
    const report = await api('GET', `/api/lab/orders/${reported.id}/report`, undefined, 'cashier');
    assert.strictEqual(report.status, 200, JSON.stringify(report.body));
    assert.strictEqual(report.body.order_no, reported.order_no);
    assert.ok(report.body.items.length, 'with the tests on it');
  }
});

test('a doctor’s diagnostics open to that doctor’s orders and nobody else’s', async () => {
  const win = WINDOW();
  const doctors = (await api('GET',
    '/api/reports/doctor-productivity?' + new URLSearchParams(win), undefined, 'cashier')).body;
  const busiest = doctors.find((d) => d.lab_orders > 0);
  if (!busiest) return;   // nothing ordered in the window; nothing to check

  const res = await rdetail('doctor_lab', { doctorId: busiest.id, ...win }, 'cashier');
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.total, busiest.lab_orders, 'the list matches the number in the table');
  for (const r of res.body.rows) assert.strictEqual(r.doctor, busiest.name);
});

test('a row that names a bill can be printed from where it is read', async () => {
  // Every money list carries the id of the bill it names, so the report can
  // offer the invoice itself rather than sending the reader back to Billing to
  // search for a document already on their screen.
  const win = WINDOW();
  for (const metric of ['revenue_outstanding', 'revenue_sliding', 'revenue_assistance']) {
    const res = await rdetail(metric, win);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    for (const r of res.body.rows) {
      assert.ok(r.invoice_no, `${metric} names the invoice`);
      assert.ok(Number(r.id) > 0, `${metric} carries the invoice id`);
      const inv = await api('GET', `/api/billing/invoices/${r.id}`, undefined, 'cashier');
      assert.strictEqual(inv.status, 200);
      assert.strictEqual(inv.body.invoice_no, r.invoice_no, 'and the id is that invoice');
    }
  }

  // A receipt row prints two documents, so it carries both numbers.
  const receipts = await rdetail('trend_collected', win);
  for (const r of receipts.body.rows) {
    assert.ok(r.receipt_no, 'the receipt');
    assert.ok(Number(r.invoice_id) > 0, 'and the bill it settled');
    const inv = (await api('GET', `/api/billing/invoices/${r.invoice_id}`, undefined, 'cashier')).body;
    assert.strictEqual(inv.invoice_no, r.invoice_no);
  }
});

test('a report answers for the window it was asked about, and no other', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const wide = await rdetail('trend_visits', WINDOW());
  const oneDay = await rdetail('trend_visits', { from: today, to: today });
  assert.ok(oneDay.body.total <= wide.body.total,
    'a single day cannot hold more visits than the month around it');
  for (const r of oneDay.body.rows) assert.ok(String(r.at).startsWith(today));
});

test('the turnaround list is the sample the averages were taken over', async () => {
  const w = WINDOW();
  const t = (await api('GET', `/api/reports/turnaround?from=${w.from}&to=${w.to}`)).body;
  const res = await rdetail('turnaround_visits', { from: t.from, to: t.to });
  assert.strictEqual(res.body.total, t.sample);
  for (const r of res.body.rows) {
    assert.ok(r.door_to_door_minutes !== null, 'a completed visit has a door-to-door time');
  }
});

test('the concession and outstanding figures open the invoices behind them', async () => {
  const w = WINDOW();
  const r = (await api('GET', `/api/reports/revenue?from=${w.from}&to=${w.to}`, undefined, 'cashier')).body;

  const sliding = await rdetail('revenue_sliding', w, 'cashier');
  assert.strictEqual(round2(sliding.body.rows.reduce((a, x) => a + Number(x.amount), 0)),
    round2(r.concessions.sliding_scale));
  for (const x of sliding.body.rows) assert.ok(Number(x.amount) > 0, 'a zero concession is not a concession');

  const assist = await rdetail('revenue_assistance', w, 'cashier');
  assert.strictEqual(round2(assist.body.rows.reduce((a, x) => a + Number(x.amount), 0)),
    round2(r.concessions.assistance));

  const out = await rdetail('revenue_outstanding', w, 'cashier');
  assert.strictEqual(out.body.total, r.outstanding.invoices);
  assert.strictEqual(round2(out.body.rows.reduce((a, x) => a + Number(x.balance), 0)),
    round2(r.outstanding.amount));
});

test('a doctor-monthly cell opens that doctor\'s month, clamped to the report window', async () => {
  const data = (await api('GET', '/api/reports/doctor-monthly?months=6')).body;
  assert.ok(data.rows.length, 'expected at least one doctor with activity');
  const doc = data.rows[0];

  for (const m of data.months) {
    const last = new Date(Number(m.key.slice(0, 4)), Number(m.key.slice(5, 7)), 0)
      .toISOString().slice(0, 10);
    const win = {
      doctorId: doc.id,
      from: `${m.key}-01` < data.from ? data.from : `${m.key}-01`,
      to: last > data.to ? data.to : last,
    };
    for (const [metric, key] of [
      ['doctor_month_booked', 'booked'],
      ['doctor_month_visits', 'visits'],
    ]) {
      const res = await rdetail(metric, win);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.total, doc.months[m.key][key],
        `${metric} for ${m.key} does not match the cell`);
    }
    const billed = await rdetail('doctor_month_billed', win);
    assert.strictEqual(round2(billed.body.rows.reduce((a, r) => a + Number(r.amount), 0)),
      round2(doc.months[m.key].billed), `billed for ${m.key} does not match the cell`);
  }
});

test('a doctor-monthly total opens the whole window', async () => {
  const data = (await api('GET', '/api/reports/doctor-monthly?months=6')).body;
  const doc = data.rows[0];
  const res = await rdetail('doctor_month_visits',
    { doctorId: doc.id, from: data.from, to: data.to });
  assert.strictEqual(res.body.total, doc.total.visits);
});

test('a report detail insists on a sensible window', async () => {
  const bad = [
    { from: 'yesterday', to: '2026-01-01' },
    { from: '2026-01-01', to: 'soon' },
    { from: '2026-06-01', to: '2026-01-01' },   // ends before it starts
    { to: '2026-01-01' },                        // no start
  ];
  for (const params of bad) {
    const res = await rdetail('trend_visits', params);
    assert.strictEqual(res.status, 400, `${JSON.stringify(params)} should be refused`);
  }
});

test('a per-doctor report will not answer without a doctor', async () => {
  const res = await rdetail('doctor_visits', WINDOW());
  assert.strictEqual(res.status, 400);
  const bogus = await rdetail('doctor_visits', { ...WINDOW(), doctorId: 999999 });
  assert.strictEqual(bogus.status, 400);
});

test('report money is management\'s, and an unknown report metric is refused', async () => {
  for (const metric of ['trend_collected', 'revenue_sliding', 'revenue_outstanding',
    'doctor_month_billed']) {
    const res = await rdetail(metric, { ...WINDOW(), doctorId: ids.imran }, 'imran');
    assert.strictEqual(res.status, 403, `${metric} should be closed to a doctor`);
  }
  // Footfall and turnaround are not money and stay open to everyone.
  assert.strictEqual((await rdetail('trend_visits', WINDOW(), 'imran')).status, 200);

  for (const bad of ['', 'nonsense', 'constructor', 'toString']) {
    assert.strictEqual((await rdetail(bad, WINDOW())).status, 400, `"${bad}" should be refused`);
  }
});
