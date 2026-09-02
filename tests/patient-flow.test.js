'use strict';
/**
 * The lanes a patient passes through, and where the money is taken.
 *
 *   front desk -> vitals (nurse) -> doctor -> lab, if anything was ordered
 *              -> cashier -> pharmacy
 *
 * The pharmacy is last and independent: it raises its own bill and takes its
 * own money, and a patient who does not buy today keeps their prescription on
 * its queue until they do — or until somebody says they filled it elsewhere.
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

async function api(method, p, body, as = 'reception') {
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

const stage = async (visitId) => (await api('GET', `/api/visits/${visitId}`, undefined, 'cashier')).body.status;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['reception', 'reception@samiha.local'], ['nurse', 'nurse@samiha.local'],
    ['imran', 'imran@samiha.local'], ['lab', 'lab@samiha.local'],
    ['cashier', 'cashier@samiha.local'], ['pharmacy', 'pharmacy@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.imran = db.prepare("SELECT id FROM users WHERE email = 'imran@samiha.local'").get().id;
  ids.para = db.prepare("SELECT id FROM drugs WHERE code = 'PARA500'").get().id;

  // Stock, so the counter has something to hand over.
  const supplier = (await api('POST', '/api/stock/suppliers',
    { name: 'Flow Distributors', phone: '9840012345' }, 'pharmacy')).body;
  await api('POST', '/api/stock/purchases', {
    supplierId: supplier.id, invoiceNo: 'FD-1',
    items: [{ drugId: ids.para, batchNo: 'FB-1', expiryDate: '2028-12-31',
      qty: 500, purchasePrice: 1, mrp: 2.2 }],
  }, 'pharmacy');
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a patient walks the lanes in order, and the lab hands them to the cashier', async () => {
  const p = (await api('POST', '/api/patients', {
    firstName: 'Flow', lastName: 'Patient', phone: '9849001122', gender: 'male',
    age: 39, consentTreatment: true,
  })).body;
  ids.patient = p.id;

  const arrived = (await api('POST', '/api/visits/arrive',
    { patientId: p.id, doctorId: ids.imran, visitType: 'opd', reasonForVisit: 'Fever' })).body;
  ids.visit = arrived.id || arrived.visit.id;

  // Nurse.
  const vit = await api('POST', `/api/visits/${ids.visit}/vitals`,
    { bpSystolic: 128, bpDiastolic: 82, pulse: 78, respRate: 16, tempC: 37.4,
      spo2: 98, heightCm: 174, weightKg: 72, painScore: 3 }, 'nurse');
  assert.strictEqual(vit.status, 201, JSON.stringify(vit.body));
  assert.strictEqual(await stage(ids.visit), 'vitals_done');

  // Doctor: consultation, a diagnostic, a prescription.
  await api('POST', `/api/visits/${ids.visit}/consultation`, {
    subjective: 'Fever 3 days', assessment: 'Acute viral fever', plan: 'Rest',
  }, 'imran');
  const tests = (await api('GET', '/api/masters/lab-tests', undefined, 'imran')).body;
  const order = await api('POST', '/api/lab/orders', {
    patientId: p.id, visitId: ids.visit, doctorId: ids.imran, priority: 'routine',
    tests: [{ testId: tests.find((t) => t.category === 'lab').id }],
  }, 'imran');
  assert.strictEqual(order.status, 201, JSON.stringify(order.body));
  ids.order = order.body.id;

  const rx = await api('POST', '/api/prescriptions', {
    patientId: p.id, visitId: ids.visit,
    items: [{ drugId: ids.para, doseMorning: 1, doseNight: 1, durationDays: 3 }],
  }, 'imran');
  assert.strictEqual(rx.status, 201, JSON.stringify(rx.body));
  ids.sheet = rx.body.id;

  await api('POST', `/api/visits/${ids.visit}/consultation/sign`, {}, 'imran');
  assert.strictEqual(await stage(ids.visit), 'labs_pending',
    'diagnostics were ordered, so the lab is next — not the pharmacy');

  // Lab: the last report hands the patient to the cashier.
  await api('POST', `/api/lab/orders/${ids.order}/collect`, { sampleType: 'blood' }, 'lab');
  const full = (await api('GET', `/api/lab/orders/${ids.order}`, undefined, 'lab')).body;
  await api('POST', `/api/lab/orders/${ids.order}/results`,
    { results: full.items.map((i) => ({ itemId: i.id, value: '12' })) }, 'lab');
  await api('POST', `/api/lab/orders/${ids.order}/verify`, {}, 'lab');
  assert.strictEqual(await stage(ids.visit), 'billing_pending',
    'with the report out, the cashier is next');
});

test('the cashier bills the hospital, never the medicines', async () => {
  const bill = await api('POST', `/api/visits/${ids.visit}/prepare-bill`, {}, 'cashier');
  assert.strictEqual(bill.status, 200, JSON.stringify(bill.body));
  assert.strictEqual(bill.body.kind, 'opd');
  ids.invoice = bill.body.id;

  const kinds = bill.body.items.map((i) => i.ref_type);
  assert.ok(kinds.includes('consultation'), 'the consultation is billed here');
  assert.ok(kinds.includes('lab'), 'and so are the diagnostics');
  assert.ok(!kinds.includes('pharmacy'), 'the medicines are not');
});

test('check-out is not held up by a bill the pharmacy will collect itself', async () => {
  // The patient buys nothing yet, but the hospital bill is settled.
  const inv = (await api('GET', `/api/billing/invoices/${ids.invoice}`, undefined, 'cashier')).body;
  if (inv.balance > 0) {
    await api('POST', `/api/billing/invoices/${ids.invoice}/payments`,
      { amount: inv.balance, mode: 'cash' }, 'cashier');
  }

  const out = await api('POST', `/api/visits/${ids.visit}/check-out`, {}, 'cashier');
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(await stage(ids.visit), 'checked_out',
    'the visit closes; the pharmacy is not a gate on it');
  assert.match(out.body.note || '', /pharmacy/i, 'the desk is told what is still to collect');
});

test('the prescription waits at the pharmacy for as long as it takes', async () => {
  const queue = (await api('GET', '/api/pharmacy/queue', undefined, 'pharmacy')).body;
  const row = queue.find((q) => q.sheet_id === ids.sheet);
  assert.ok(row, 'still on the queue after the visit closed');
  assert.strictEqual(row.visit_id, ids.visit, 'and still linked to the visit it came from');
  assert.ok(row.pending_items >= 1);
  assert.ok(row.uhid && row.patient_name, 'the counter knows who it is for');
});

test('the pharmacy bills and collects on its own', async () => {
  const lines = (await api('GET', `/api/pharmacy/prescriptions/${ids.visit}`, undefined, 'pharmacy')).body;
  const line = lines.prescriptions[0];

  const sale = await api('POST', '/api/pharmacy/dispense', {
    patientId: ids.patient, visitId: ids.visit,
    items: [{ prescriptionId: line.id, drugId: ids.para, qty: line.quantity }],
  }, 'pharmacy');
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.body));
  assert.strictEqual(sale.body.invoice.kind, 'pharmacy', 'its own bill, not the hospital one');
  assert.notStrictEqual(sale.body.invoice.id, ids.invoice);

  // The hospital bill is untouched by the sale.
  const hospital = (await api('GET', `/api/billing/invoices/${ids.invoice}`, undefined, 'cashier')).body;
  assert.ok(!hospital.items.some((i) => i.ref_type === 'pharmacy'));

  // Both bills hang off the same visit, so the record runs end to end.
  const kinds = (await api('GET', `/api/visits/${ids.visit}`, undefined, 'cashier')).body
    .invoices.map((i) => i.kind).sort();
  assert.deepStrictEqual(kinds, ['opd', 'pharmacy']);

  // And the queue is clear.
  const queue = (await api('GET', '/api/pharmacy/queue', undefined, 'pharmacy')).body;
  assert.ok(!queue.some((q) => q.sheet_id === ids.sheet));

  // The money was taken at the counter, so nothing is left owing. A bill the
  // patient has already paid must not sit in the ledger as a debt.
  assert.strictEqual(sale.body.invoice.balance, 0, 'settled where it was raised');
  assert.strictEqual(sale.body.invoice.status, 'paid');
  assert.ok(sale.body.receiptNo, 'and the patient gets a receipt for it');
  assert.strictEqual(sale.body.sale.payment_mode, 'cash');
});

test('a part payment at the pharmacy leaves exactly what is still owed', async () => {
  const rx = (await api('POST', '/api/prescriptions', {
    patientId: ids.patient,
    items: [{ drugId: ids.para, doseMorning: 1, durationDays: 5 }],
  }, 'imran')).body;
  const sheet = (await api('GET', `/api/pharmacy/sheet/${rx.id}`, undefined, 'pharmacy')).body;

  const sale = await api('POST', '/api/pharmacy/dispense', {
    patientId: ids.patient,
    items: [{ prescriptionId: sheet.prescriptions[0].id, drugId: ids.para, qty: 5 }],
    paidAmount: 1, paymentMode: 'upi', paymentReference: 'UPI-1',
  }, 'pharmacy');
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.body));
  const net = sale.body.invoice.net;
  assert.ok(net > 1, 'the bill is more than what was handed over');
  assert.strictEqual(sale.body.invoice.paid, 1);
  assert.strictEqual(sale.body.invoice.balance, Math.round((net - 1) * 100) / 100);
  assert.strictEqual(sale.body.invoice.status, 'partial');

  const over = await api('POST', '/api/pharmacy/dispense', {
    patientId: ids.patient,
    items: [{ prescriptionId: sheet.prescriptions[0].id, drugId: ids.para, qty: 1 }],
    paidAmount: 9999,
  }, 'pharmacy');
  assert.strictEqual(over.status, 400, 'more money than the bill is a mistake, not a tip');
});

test('a bill can be built from the tariff for a patient with no visit at all', async () => {
  // The counter bill: somebody walks in for a dressing and pays for it.
  const opened = await api('POST', '/api/billing/invoices',
    { patientId: ids.patient, kind: 'opd' }, 'cashier');
  assert.strictEqual(opened.status, 201, JSON.stringify(opened.body));
  const id = opened.body.id;
  assert.strictEqual(opened.body.visit_id, null);

  // Priced off the catalogue the rates screen sets, not typed in by hand.
  const catalogue = (await api('GET', '/api/masters/catalogue', undefined, 'cashier')).body;
  const item = catalogue.flatMap((g) => g.items).find((i) => i.price > 0);
  const added = await api('POST', `/api/billing/invoices/${id}/items`, {
    refType: item.kind === 'test' ? 'lab' : 'service', refId: item.id,
    description: item.name, qty: 1, unitPrice: item.price, taxPct: item.tax_pct || 0,
  }, 'cashier');
  assert.strictEqual(added.status, 201, JSON.stringify(added.body));
  assert.strictEqual(added.body.items.length, 1);

  // Taken off again, because a cashier presses the wrong button sometimes.
  const line = added.body.items[0];
  const removed = (await api('DELETE', `/api/billing/invoices/${id}/items/${line.id}`,
    undefined, 'cashier')).body;
  assert.strictEqual(removed.items.length, 0);
  assert.strictEqual(removed.gross, 0);

  // Back on, discounted, and settled.
  const back = await api('POST', `/api/billing/invoices/${id}/items`, {
    refType: 'service', description: item.name, qty: 1, unitPrice: item.price,
  }, 'cashier');
  assert.strictEqual(back.status, 201, 'an emptied bill is still open to add to');
  const cut = (await api('POST', `/api/billing/invoices/${id}/bill-discount`,
    { pct: 10, reason: 'Staff concession' }, 'cashier')).body;
  assert.ok(cut.bill_discount > 0);
  assert.strictEqual(cut.net, Math.round((item.price * 0.9) * 100) / 100);

  const paid = await api('POST', `/api/billing/invoices/${id}/payments`,
    { amount: cut.net, mode: 'cash' }, 'cashier');
  assert.strictEqual(paid.status, 201, JSON.stringify(paid.body));
  const done = (await api('GET', `/api/billing/invoices/${id}`, undefined, 'cashier')).body;
  assert.strictEqual(done.balance, 0);
  assert.strictEqual(done.status, 'paid');
});

test('a prescription written with no visit still reaches our counter', async () => {
  const rx = await api('POST', '/api/prescriptions', {
    patientId: ids.patient,
    items: [{ drugId: ids.para, doseMorning: 1, durationDays: 2 }],
  }, 'imran');
  assert.strictEqual(rx.status, 201);
  assert.ok(rx.body.items.every((i) => i.status === 'pending'));

  const queue = (await api('GET', '/api/pharmacy/queue', undefined, 'pharmacy')).body;
  const row = queue.find((q) => q.sheet_id === rx.body.id);
  assert.ok(row, 'on the queue with no visit behind it');
  assert.strictEqual(row.visit_id, null);

  // It can be dispensed from the sheet alone.
  const sheet = (await api('GET', `/api/pharmacy/sheet/${rx.body.id}`, undefined, 'pharmacy')).body;
  assert.strictEqual(sheet.prescriptions.length, 1);
  const sale = await api('POST', '/api/pharmacy/dispense', {
    patientId: ids.patient,
    items: [{ prescriptionId: sheet.prescriptions[0].id, drugId: ids.para, qty: 2 }],
  }, 'pharmacy');
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.body));
  assert.strictEqual(sale.body.invoice.kind, 'pharmacy');
  assert.strictEqual(sale.body.invoice.visit_id, null);
});

test('the pharmacist can say a prescription is being filled elsewhere', async () => {
  const rx = (await api('POST', '/api/prescriptions', {
    patientId: ids.patient,
    items: [{ drugId: ids.para, doseMorning: 1, durationDays: 2 }],
  }, 'imran')).body;

  assert.strictEqual((await api('POST', `/api/pharmacy/prescriptions/${rx.id}/decline`,
    {}, 'pharmacy')).status, 400, 'a reason is the whole record of what happened');

  const done = await api('POST', `/api/pharmacy/prescriptions/${rx.id}/decline`,
    { reason: 'Buying it near home' }, 'pharmacy');
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));

  const queue = (await api('GET', '/api/pharmacy/queue', undefined, 'pharmacy')).body;
  assert.ok(!queue.some((q) => q.sheet_id === rx.id), 'off the queue');

  const after = (await api('GET', `/api/prescriptions/${rx.id}`, undefined, 'imran')).body;
  assert.ok(after.items.every((i) => i.status === 'external'), 'recorded as filled elsewhere');
  assert.strictEqual(after.status, 'issued', 'the prescription itself is untouched');

  // Declining twice is refused rather than silently repeated.
  assert.strictEqual((await api('POST', `/api/pharmacy/prescriptions/${rx.id}/decline`,
    { reason: 'again' }, 'pharmacy')).status, 409);
});
