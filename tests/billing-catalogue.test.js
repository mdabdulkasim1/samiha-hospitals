'use strict';
/**
 * What the clinic charges for, and which bill each charge lands on.
 *
 * The rule that matters here is the one about medicines. An in-patient's go on
 * the hospital's running bill and are settled at discharge with the bed and the
 * nursing. An out-patient's are a counter sale: the pharmacy prints its own
 * bill and takes the money there, because the medicines leave with the patient
 * whether or not they ever get back to the cashier.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-bill-'));
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

const round2 = (n) => Math.round(n * 100) / 100;

const newPatient = async (tag) => (await api('POST', '/api/patients', {
  firstName: tag, lastName: 'Payer', phone: `98460${String(Date.now()).slice(-5)}`,
  gender: 'male', age: 40, consentTreatment: true,
}, 'reception')).body.id;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['cashier', 'cashier@samiha.local'], ['pharmacy', 'pharmacy@samiha.local'],
    ['ward', 'ward@samiha.local'], ['imran', 'imran@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.imran = db.prepare("SELECT id FROM users WHERE email = 'imran@samiha.local'").get().id;
  ids.para = db.prepare("SELECT id FROM drugs WHERE code = 'PARA500'").get().id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------- the catalogue
test('the catalogue offers every billable item, filed where a cashier looks', async () => {
  const groups = (await api('GET', '/api/masters/catalogue', undefined, 'reception')).body;
  const names = groups.map((g) => g.group);
  for (const wanted of ['Consultation', 'Procedures & treatment', 'Blood tests',
    'X-ray', 'Ultrasound & Doppler', 'ECG & heart', 'Nursing & ward']) {
    assert.ok(names.includes(wanted), `no "${wanted}" group — got ${names.join(', ')}`);
  }
  // Consultation comes before ambulance: the order of a visit, not the alphabet.
  assert.ok(names.indexOf('Consultation') < names.indexOf('Ambulance & other'));

  const all = groups.flatMap((g) => g.items);
  assert.ok(all.length >= 90, `expected a real catalogue, got ${all.length} items`);
  assert.ok(all.every((i) => i.kind === 'service' || i.kind === 'test'));
  assert.ok(all.every((i) => i.name && i.code), 'every item is named and coded');

  // Nothing is listed twice under two groups.
  const keys = all.map((i) => `${i.kind}:${i.id}`);
  assert.strictEqual(new Set(keys).size, keys.length);

  // An X-ray is filed under X-ray, not lumped in with the scans.
  const xray = groups.find((g) => g.group === 'X-ray').items;
  assert.ok(xray.some((i) => /X-Ray Chest/.test(i.name)));
  assert.ok(!xray.some((i) => /Ultrasound/.test(i.name)), 'an ultrasound is not an X-ray');
});

test('a bill group is for the cashier and does not disturb the clinical category', async () => {
  // The report's shape depends on the clinical category: a scan reads as
  // findings and an impression, a blood test as numbers. Regrouping the
  // catalogue for billing must not have touched that.
  const rows = db.prepare("SELECT category, bill_group, name FROM lab_tests WHERE active = 1").all();
  assert.ok(rows.every((r) => ['lab', 'radiology', 'cardiology'].includes(r.category)),
    'clinical categories must stay within the set the reports understand');
  assert.ok(rows.every((r) => r.bill_group), 'every test is filed somewhere for billing');

  const usg = rows.find((r) => /Ultrasound — Abdomen/.test(r.name));
  assert.strictEqual(usg.category, 'radiology', 'still reported as imaging');
  assert.strictEqual(usg.bill_group, 'Ultrasound & Doppler', 'but billed under its own heading');
});

test('management sets a rate; the desk may read it but not change it', async () => {
  const svc = db.prepare("SELECT * FROM services WHERE code = 'PROC-NEB'").get();

  const set = await api('PATCH', `/api/masters/services/${svc.id}`, { price: 275 }, 'admin');
  assert.strictEqual(set.status, 200, JSON.stringify(set.body));
  assert.strictEqual(set.body.price, 275);

  const refused = await api('PATCH', `/api/masters/services/${svc.id}`, { price: 5 }, 'reception');
  assert.strictEqual(refused.status, 403, 'the front desk does not set the tariff');
  assert.strictEqual(db.prepare('SELECT price FROM services WHERE id = ?').get(svc.id).price, 275);

  const negative = await api('PATCH', `/api/masters/services/${svc.id}`, { price: -10 }, 'admin');
  assert.strictEqual(negative.status, 400);

  // A test's rate is the lab's and management's.
  const test0 = db.prepare("SELECT * FROM lab_tests WHERE code = 'XR-CHEST'").get();
  assert.strictEqual((await api('PATCH', `/api/masters/lab-tests/${test0.id}`, { price: 450 }, 'admin')).status, 200);
  assert.strictEqual((await api('PATCH', `/api/masters/lab-tests/${test0.id}`, { price: 1 }, 'reception')).status, 403);
});

test('a re-seed never overwrites a rate the clinic has set', async () => {
  const svc = db.prepare("SELECT * FROM services WHERE code = 'PROC-NEB'").get();
  assert.strictEqual(svc.price, 275, 'set by the previous test');
  delete require.cache[require.resolve('../src/db/seed')];
  require('../src/db/seed');
  assert.strictEqual(db.prepare("SELECT price FROM services WHERE code = 'PROC-NEB'").get().price, 275,
    'seeding again must not put the starting figure back');
});

// --------------------------------------------------------------- the discount
test('a discount comes off the bill, as rupees or as a percentage', async () => {
  const patientId = await newPatient('Disc');
  const inv = (await api('POST', '/api/billing/invoices', { patientId, kind: 'opd' }, 'cashier')).body;
  await api('POST', `/api/billing/invoices/${inv.id}/items`,
    { description: 'Consultation', qty: 1, unitPrice: 500 }, 'cashier');
  await api('POST', `/api/billing/invoices/${inv.id}/items`,
    { description: 'X-Ray Chest PA', qty: 1, unitPrice: 500 }, 'cashier');

  const flat = await api('POST', `/api/billing/invoices/${inv.id}/bill-discount`,
    { amount: 150, reason: 'Goodwill' }, 'cashier');
  assert.strictEqual(flat.status, 200, JSON.stringify(flat.body));
  assert.strictEqual(flat.body.bill_discount, 150);
  assert.strictEqual(flat.body.net, 850, '1000 less 150');
  assert.strictEqual(flat.body.bill_discount_reason, 'Goodwill');

  // A percentage is stored as the rupees it came to, not as the percentage.
  const pct = await api('POST', `/api/billing/invoices/${inv.id}/bill-discount`,
    { pct: 10, reason: 'Staff' }, 'cashier');
  assert.strictEqual(pct.body.bill_discount, 100, '10% of 1000');
  assert.strictEqual(pct.body.net, 900);

  // It replaces rather than accumulates: setting it twice is not 250 off.
  assert.strictEqual(pct.body.gross, 1000);

  // Adding a charge afterwards leaves the discount as the rupees it was.
  await api('POST', `/api/billing/invoices/${inv.id}/items`,
    { description: 'Dressing', qty: 1, unitPrice: 200 }, 'cashier');
  const after = (await api('GET', `/api/billing/invoices/${inv.id}`, undefined, 'cashier')).body;
  assert.strictEqual(after.bill_discount, 100, 'still the rupees that were given');
  assert.strictEqual(after.net, 1100, '1200 less 100');
});

test('a discount cannot exceed the bill, or undo money already taken', async () => {
  const patientId = await newPatient('Guard');
  const inv = (await api('POST', '/api/billing/invoices', { patientId, kind: 'opd' }, 'cashier')).body;
  await api('POST', `/api/billing/invoices/${inv.id}/items`,
    { description: 'Consultation', qty: 1, unitPrice: 400 }, 'cashier');

  assert.strictEqual((await api('POST', `/api/billing/invoices/${inv.id}/bill-discount`,
    { amount: 500 }, 'cashier')).status, 400, 'more than the bill');
  assert.strictEqual((await api('POST', `/api/billing/invoices/${inv.id}/bill-discount`,
    { amount: -50 }, 'cashier')).status, 400, 'a negative discount is a charge');
  assert.strictEqual((await api('POST', `/api/billing/invoices/${inv.id}/bill-discount`,
    { pct: 140 }, 'cashier')).status, 400, 'no such percentage');

  // Take 300, then try to discount 200 — that would owe the patient money.
  await api('POST', `/api/billing/invoices/${inv.id}/payments`,
    { amount: 300, mode: 'cash' }, 'cashier');
  const tooLate = await api('POST', `/api/billing/invoices/${inv.id}/bill-discount`,
    { amount: 200 }, 'cashier');
  assert.strictEqual(tooLate.status, 409);
  assert.match(tooLate.body.error || tooLate.body.message || '', /refund/i);

  // Discounting down to exactly what is still owed is fine.
  const ok = await api('POST', `/api/billing/invoices/${inv.id}/bill-discount`,
    { amount: 100 }, 'cashier');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.net, 300);
  assert.strictEqual(ok.body.balance, 0);
  assert.strictEqual(ok.body.status, 'paid');
});

test('a doctor cannot discount a bill', async () => {
  const patientId = await newPatient('NoDisc');
  const inv = (await api('POST', '/api/billing/invoices', { patientId, kind: 'opd' }, 'cashier')).body;
  assert.strictEqual((await api('POST', `/api/billing/invoices/${inv.id}/bill-discount`,
    { amount: 10 }, 'imran')).status, 403);
});

// ------------------------------------------------------- where medicines land
test('an out-patient pays for medicines at the pharmacy, on their own bill', async () => {
  const patientId = await newPatient('Walkin');
  const visit = (await api('POST', '/api/visits/arrive',
    { patientId, doctorId: ids.imran, visitType: 'opd', reasonForVisit: 'Fever' }, 'reception')).body;
  const visitId = visit.id || visit.visit.id;

  const visitInvoice = (await api('POST', `/api/visits/${visitId}/prepare-bill`, {}, 'cashier')).body;
  const netBefore = visitInvoice.net;

  const sale = await api('POST', '/api/pharmacy/dispense',
    { patientId, visitId, items: [{ drugId: ids.para, qty: 10 }] }, 'pharmacy');
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.body));

  // The medicines are on a pharmacy bill of their own...
  const pharmacyInvoice = db.prepare('SELECT * FROM invoices WHERE id = ?')
    .get(db.prepare('SELECT invoice_id FROM pharmacy_sales WHERE id = ?').get(sale.body.sale.id).invoice_id);
  assert.strictEqual(pharmacyInvoice.kind, 'pharmacy');
  assert.notStrictEqual(pharmacyInvoice.id, visitInvoice.id, 'not the visit bill');
  assert.strictEqual(round2(pharmacyInvoice.net), round2(sale.body.sale.net));

  // ...and the hospital bill is untouched by them.
  const after = (await api('GET', `/api/billing/invoices/${visitInvoice.id}`, undefined, 'cashier')).body;
  assert.strictEqual(after.net, netBefore, 'the visit bill did not move');
  assert.ok(!after.items.some((i) => i.ref_type === 'pharmacy'),
    'no medicine line on the hospital bill');
});

test('an in-patient\'s medicines go onto the hospital bill', async () => {
  const patientId = await newPatient('Admitted');
  const wards = (await api('GET', '/api/ipd/wards', undefined, 'ward')).body;
  const bed = wards.wards.flatMap((w) => w.beds).find((b) => b.status === 'vacant');
  assert.ok(bed, 'a vacant bed is required');

  const adm = await api('POST', '/api/ipd/admissions', {
    patientId, doctorId: ids.imran, bedId: bed.id, admissionType: 'planned',
    reason: 'Observation', attendantName: 'Kumar', attendantPhone: '9000000111',
  }, 'ward');
  assert.strictEqual(adm.status, 201, JSON.stringify(adm.body));
  const admissionId = adm.body.id;

  const before = db.prepare(
    "SELECT * FROM invoices WHERE admission_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1"
  ).get(admissionId);

  const sale = await api('POST', '/api/pharmacy/dispense',
    { patientId, admissionId, items: [{ drugId: ids.para, qty: 6 }] }, 'pharmacy');
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.body));

  const invoiceId = db.prepare('SELECT invoice_id FROM pharmacy_sales WHERE id = ?')
    .get(sale.body.sale.id).invoice_id;
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);

  assert.strictEqual(inv.admission_id, admissionId, 'billed to the admission');
  assert.strictEqual(inv.kind, 'ipd', 'it is the hospital bill, not a pharmacy one');
  if (before) assert.strictEqual(inv.id, before.id, 'the admission keeps one running bill');

  const full = (await api('GET', `/api/billing/invoices/${inv.id}`, undefined, 'cashier')).body;
  const line = full.items.find((i) => i.ref_type === 'pharmacy');
  assert.ok(line, 'the medicines are a line on the hospital bill');
  assert.strictEqual(round2(line.amount), round2(sale.body.sale.net));

  // A second issue joins the same bill rather than opening another.
  await api('POST', '/api/pharmacy/dispense',
    { patientId, admissionId, items: [{ drugId: ids.para, qty: 4 }] }, 'pharmacy');
  const count = db.prepare(
    "SELECT COUNT(*) c FROM invoices WHERE admission_id = ? AND status != 'cancelled'"
  ).get(admissionId).c;
  assert.strictEqual(count, 1, 'one running bill for the stay');
  const both = db.prepare(
    "SELECT COUNT(*) c FROM invoice_items WHERE invoice_id = ? AND ref_type = 'pharmacy'"
  ).get(inv.id).c;
  assert.strictEqual(both, 2, 'both issues are on it');
});

test('a walk-in with no visit at all still gets a pharmacy bill', async () => {
  const patientId = await newPatient('Counter');
  const sale = await api('POST', '/api/pharmacy/dispense',
    { patientId, items: [{ drugId: ids.para, qty: 3 }] }, 'pharmacy');
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.body));
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(
    db.prepare('SELECT invoice_id FROM pharmacy_sales WHERE id = ?').get(sale.body.sale.id).invoice_id);
  assert.strictEqual(inv.kind, 'pharmacy');
  assert.strictEqual(inv.visit_id, null);
});

// ------------------------------------------------------- the in-patient bill
test('an in-patient charge reaches the bill as it is made, not at discharge', async () => {
  const patientId = await newPatient('Running');
  const wards = (await api('GET', '/api/ipd/wards', undefined, 'ward')).body;
  const bed = wards.wards.flatMap((w) => w.beds).find((b) => b.status === 'vacant');
  const adm = (await api('POST', '/api/ipd/admissions', {
    patientId, doctorId: ids.imran, bedId: bed.id, admissionType: 'planned',
    reason: 'Observation', attendantName: 'Devi', attendantPhone: '9000000444',
  }, 'ward')).body;

  const charge = await api('POST', `/api/ipd/admissions/${adm.id}/charges`,
    { description: 'Nursing charges — per day', qty: 1, unitPrice: 400 }, 'ward');
  assert.strictEqual(charge.status, 201, JSON.stringify(charge.body));
  assert.strictEqual(charge.body.billed, 1, 'it goes on the bill straight away');

  const full = (await api('GET', `/api/ipd/admissions/${adm.id}`, undefined, 'cashier')).body;
  assert.ok(full.invoice, 'the stay has a running bill');
  assert.strictEqual(full.invoice.gross, 400);
  const line = full.invoice.items.find((i) => i.ref_type === 'ip_charge');
  assert.ok(line, 'the charge is a line on it');
  assert.strictEqual(line.amount, 400);

  ids.runningAdmission = adm.id;
  ids.runningInvoice = full.invoice.id;
  ids.runningBed = bed.id;
});

test('a discount can be given on a stay, against what is on the bill', async () => {
  const id = ids.runningAdmission;
  await api('POST', `/api/ipd/admissions/${id}/charges`,
    { description: 'IV cannulation', qty: 1, unitPrice: 200 }, 'ward');

  const before = (await api('GET', `/api/billing/invoices/${ids.runningInvoice}`, undefined, 'cashier')).body;
  assert.strictEqual(before.gross, 600);

  const disc = await api('POST', `/api/billing/invoices/${ids.runningInvoice}/bill-discount`,
    { amount: 100, reason: 'Goodwill' }, 'cashier');
  assert.strictEqual(disc.status, 200, JSON.stringify(disc.body));
  assert.strictEqual(disc.body.net, 500);

  // A ward nurse may add charges but does not give money away.
  assert.strictEqual((await api('POST', `/api/billing/invoices/${ids.runningInvoice}/bill-discount`,
    { amount: 10 }, 'ward')).status, 403);
});

test('discharge posts the bed and does not bill a charge twice', async () => {
  const id = ids.runningAdmission;
  const before = (await api('GET', `/api/billing/invoices/${ids.runningInvoice}`, undefined, 'cashier')).body;
  const chargeLines = before.items.filter((i) => i.ref_type === 'ip_charge').length;
  assert.strictEqual(chargeLines, 2);

  /*
   * Discharging posts the bed first and only then looks at the balance, so the
   * first attempt is expected to be refused: the bed charge it just added is
   * itself the outstanding amount. The desk settles and discharges again,
   * which is what makes this a real test of the double-post guard — the second
   * run walks the same posting loop over charges already on the bill.
   */
  const body = {
    dischargeType: 'recovered', finalDiagnosis: 'Resolved',
    courseInHospital: 'Uneventful', dischargeAdvice: 'Rest',
  };
  const firstTry = await api('POST', `/api/ipd/admissions/${id}/discharge`, body, 'cashier');
  assert.strictEqual(firstTry.status, 409, 'the bed charge is now outstanding');

  const owed = (await api('GET', `/api/billing/invoices/${ids.runningInvoice}`, undefined, 'cashier')).body;
  await api('POST', `/api/billing/invoices/${ids.runningInvoice}/payments`,
    { amount: owed.balance, mode: 'cash' }, 'cashier');

  const out = await api('POST', `/api/ipd/admissions/${id}/discharge`, body, 'cashier');
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));

  const after = (await api('GET', `/api/billing/invoices/${ids.runningInvoice}`, undefined, 'cashier')).body;
  assert.strictEqual(after.items.filter((i) => i.ref_type === 'ip_charge').length, chargeLines,
    'the charges already posted must not be posted again');
  assert.strictEqual(after.items.filter((i) => i.ref_type === 'room').length, 1,
    'the bed is posted at discharge, and only once across both attempts');

  // The discount survives discharge as the rupee figure it was.
  assert.strictEqual(after.bill_discount, 100);
});
