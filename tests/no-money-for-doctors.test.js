'use strict';
/**
 * What a doctor is not shown.
 *
 * A rate on the screen while a treatment is being chosen is a thumb on the
 * scale, so the prescribing roles are sent no figures at all: not a bed
 * tariff, not a test's price, not a patient's balance, not the day's takings.
 * The desks that quote, book and collect — front office, nurse station, ward,
 * pharmacy, cashier — still get everything they need to do the job.
 *
 * Every assertion here is against the API rather than the screen. Hiding a
 * column in the browser hides nothing: the figure is still one network tab
 * away. The server has to be the one that withholds it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-money-'));
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

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['cashier', 'cashier@samiha.local'], ['nurse', 'nurse@samiha.local'],
    ['ward', 'ward@samiha.local'], ['lab', 'lab@samiha.local'],
    ['pharmacy', 'pharmacy@samiha.local'],
    ['doctor', 'imran@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.doctor = db.prepare("SELECT id FROM users WHERE email = 'imran@samiha.local'").get().id;

  // One patient, admitted, with a bed charge and a part payment against the
  // running bill — so there is real money on the record to be hidden.
  ids.patient = (await api('POST', '/api/patients', {
    firstName: 'Money', lastName: 'Test', phone: '9846000111',
    gender: 'male', age: 52, consentTreatment: true,
  }, 'reception')).body.id;

  const bed = db.prepare("SELECT id FROM beds WHERE status = 'vacant' AND tariff_per_day > 0 LIMIT 1").get();
  assert.ok(bed, 'the seed has a priced vacant bed');
  const admit = await api('POST', '/api/ipd/admissions', {
    patientId: ids.patient, doctorId: ids.doctor, bedId: bed.id,
    reason: 'Uncontrolled sugars',
  }, 'ward');
  assert.strictEqual(admit.status, 201, JSON.stringify(admit.body));
  ids.admission = admit.body.id;
  ids.invoice = admit.body.invoice_id;

  const charge = await api('POST', `/api/ipd/admissions/${ids.admission}/charges`, {
    description: 'Dressing', qty: 1, unitPrice: 150,
  }, 'ward');
  assert.strictEqual(charge.status, 201, JSON.stringify(charge.body));
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the ward
test('the ward board reaches a doctor without a tariff on it', async () => {
  const forWard = (await api('GET', '/api/ipd/wards', undefined, 'ward')).body;
  const wardBeds = forWard.wards.flatMap((w) => w.beds);
  assert.ok(wardBeds.some((b) => b.tariff_per_day > 0), 'the ward books beds and sees the rate');

  const forDoctor = (await api('GET', '/api/ipd/wards', undefined, 'doctor')).body;
  const docBeds = forDoctor.wards.flatMap((w) => w.beds);
  assert.ok(docBeds.length, 'a doctor still sees every bed');
  assert.ok(docBeds.every((b) => b.tariff_per_day === null), 'but never what one costs');

  // The count is the point of the board, and it survives.
  assert.strictEqual(forDoctor.summary.total, forWard.summary.total);
  assert.strictEqual(forDoctor.summary.vacant, forWard.summary.vacant);
});

test('the in-patient list carries a balance to the ward and not to the doctor', async () => {
  const ward = (await api('GET', '/api/ipd/admissions', undefined, 'ward')).body;
  const mine = ward.find((a) => a.id === ids.admission);
  assert.ok(mine.tariff_per_day > 0);

  const doc = (await api('GET', '/api/ipd/admissions', undefined, 'doctor')).body;
  const same = doc.find((a) => a.id === ids.admission);
  assert.strictEqual(same.patient_name, mine.patient_name, 'the same patient, the same chart');
  assert.strictEqual(same.tariff_per_day, null);
  assert.strictEqual(same.balance, null);
});

test('an admission opened by a doctor has no bill, no rate and no priced charges', async () => {
  const ward = (await api('GET', `/api/ipd/admissions/${ids.admission}`, undefined, 'ward')).body;
  assert.ok(ward.invoice, 'the ward sees the running bill');
  assert.ok(ward.tariff_per_day > 0);
  assert.strictEqual(ward.charges[0].amount, 150);

  const doc = (await api('GET', `/api/ipd/admissions/${ids.admission}`, undefined, 'doctor')).body;
  assert.strictEqual(doc.invoice, null);
  assert.strictEqual(doc.tariff_per_day, null);
  assert.ok(doc.charges.length, 'the doctor still sees what was done');
  assert.ok(doc.charges.every((c) => c.amount === null && c.unit_price === null),
    'but not what any of it was charged at');

  // The clinical half of the record is untouched.
  assert.strictEqual(doc.ip_no, ward.ip_no);
  assert.strictEqual(doc.reason, 'Uncontrolled sugars');
  assert.ok(Array.isArray(doc.medicationOrders) && Array.isArray(doc.notes));
});

test('a doctor may not admit, move or discharge into a bed — that is the desk', async () => {
  const bed = db.prepare("SELECT id FROM beds WHERE status = 'vacant' LIMIT 1").get();
  const r = await api('POST', '/api/ipd/admissions', {
    patientId: ids.patient, doctorId: ids.doctor, bedId: bed.id, reason: 'x',
  }, 'doctor');
  assert.strictEqual(r.status, 403, 'a doctor says a patient needs a bed; they do not allocate one');
});

// -------------------------------------------------------------- the tariff
test('the rate card is priced for the desks and blank for the bench', async () => {
  const forCashier = (await api('GET', '/api/masters/lab-tests', undefined, 'cashier')).body;
  assert.ok(forCashier.some((t) => t.price > 0));

  for (const as of ['doctor', 'lab']) {
    const rows = (await api('GET', '/api/masters/lab-tests', undefined, as)).body;
    assert.ok(rows.length, `${as} still sees the whole formulary`);
    assert.ok(rows.every((t) => t.price === null), `${as} is sent no price`);
    assert.ok(rows.every((t) => t.name), `${as} is sent every name`);
  }

  const cat = (await api('GET', '/api/masters/catalogue', undefined, 'doctor')).body;
  assert.ok(cat.flatMap((g) => g.items).every((i) => i.price === null));
});

test("a consultation fee is a rate, so it is not on a doctor's staff list", async () => {
  const desk = (await api('GET', '/api/masters/staff?role=doctor', undefined, 'reception')).body;
  assert.ok(desk.some((d) => d.consult_fee > 0), 'the front desk is asked the fee all day');

  const doc = (await api('GET', '/api/masters/staff?role=doctor', undefined, 'doctor')).body;
  assert.ok(doc.length === desk.length, 'the same colleagues');
  assert.ok(doc.every((d) => d.consult_fee === null && d.follow_up_fee === null));
});

// ------------------------------------------------------------ round the clinic
test('the queue board flags a balance only to the desk that would collect it', async () => {
  const cashier = (await api('GET', '/api/visits/board', undefined, 'cashier')).body;
  assert.ok(cashier.rows.every((r) => r.invoice_balance === null || typeof r.invoice_balance === 'number'));

  const doc = (await api('GET', '/api/visits/board', undefined, 'doctor')).body;
  assert.ok(doc.rows.every((r) => r.invoice_balance === null));
  assert.strictEqual(doc.stages.length, cashier.stages.length, 'the same lanes either way');
});

test('billing is closed to a doctor outright', async () => {
  for (const [method, p] of [['GET', '/api/billing/invoices'], ['GET', `/api/billing/invoices/${ids.invoice}`]]) {
    const r = await api(method, p, undefined, 'doctor');
    assert.strictEqual(r.status, 403, `${method} ${p} should be closed to a doctor`);
  }
});

test("the dashboard sends a doctor the day's work and none of its takings", async () => {
  const cashier = (await api('GET', '/api/reports/dashboard', undefined, 'cashier')).body;
  assert.ok(cashier.revenue && typeof cashier.revenue.collected === 'number');

  const doc = (await api('GET', '/api/reports/dashboard', undefined, 'doctor')).body;
  assert.strictEqual(doc.revenue, null);
  assert.strictEqual(doc.pharmacy.salesToday, null);
  // What is running out is still worth knowing before writing for it.
  assert.strictEqual(typeof doc.pharmacy.lowStockCount, 'number');
  assert.strictEqual(typeof doc.ipd.beds.total, 'number', 'and how many beds there are');
  assert.strictEqual(typeof doc.ipd.beds.occupied, 'number', 'and how many are full');
});

test('the bed drill-down loses its per-day column on the way to a doctor', async () => {
  const ward = (await api('GET', '/api/reports/dashboard/detail?metric=beds', undefined, 'ward')).body;
  assert.ok(ward.rows.some((r) => r.tariff > 0));

  const doc = (await api('GET', '/api/reports/dashboard/detail?metric=beds', undefined, 'doctor')).body;
  assert.strictEqual(doc.total, ward.total, 'the same beds');
  assert.ok(doc.rows.every((r) => r.tariff === null));
});

test('the pharmacy shelf reaches a doctor as names and counts, never an MRP', async () => {
  const shelf = await api('GET', '/api/pharmacy/drugs', undefined, 'pharmacy');
  assert.strictEqual(shelf.status, 200, JSON.stringify(shelf.body));
  const rows = shelf.body;
  assert.ok(rows.some((d) => d.mrp > 0), 'the pharmacist reads an MRP off every pack');

  const forDoc = await api('GET', '/api/pharmacy/drugs', undefined, 'doctor');
  assert.strictEqual(forDoc.status, 200, JSON.stringify(forDoc.body));
  const docRows = forDoc.body;
  assert.strictEqual(docRows.length, rows.length, 'the same formulary');
  assert.ok(docRows.every((d) => d.mrp === null && d.purchase_price === null));
  assert.ok(docRows.some((d) => typeof d.on_hand === 'number'), 'with what is on the shelf');
});
