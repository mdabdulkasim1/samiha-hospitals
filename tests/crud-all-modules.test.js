'use strict';
/**
 * Comprehensive CRUD & Workflow Verification across ALL 14 Hospital ERP Modules:
 *  1. Auth & Session Management
 *  2. Patients (Create, Read, Update, Search)
 *  3. Enquiries (Create, Read, Update status)
 *  4. Appointments (Book, Read, Reschedule, Cancel)
 *  5. Visits & Token Queue (Arrive, Check-in, Pay fee, Vitals, Call)
 *  6. Clinical & Prescriptions (Consultation note, Diagnoses, Rx, Read)
 *  7. Lab & Diagnostics (Test catalogue, Order, Sample, Result entry, Verify)
 *  8. Pharmacy (Drugs formulary, Batches, Counter sale, Invoices)
 *  9. Stock & Inventory (Supplier create, Purchase inward, Ledger read)
 * 10. Billing & Payments (Invoice creation, Add items, Payments, Settle)
 * 11. Accounts & Cash Book (Cash entry, Ledger read)
 * 12. IPD / In-Patient (Admission, Bed allocation, Rounds, Charges, Discharge)
 * 13. Insurance / TPA (Insurers, Policy create, Claim creation, Read)
 * 14. TV Kiosk Queue (Live 3x2 queue read, Ring/Recall patient)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Ensure SQLite temp database for isolated, repeatable testing
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-all-modules-'));
const tmpDb = path.join(tmpDir, 'test.db');
process.env.DB_ENGINE = 'sqlite';
process.env.DB_FILE = tmpDb;
process.env.SESSION_SECRET = 'crud-test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');

let server;
let base;
const tokens = {};
const testState = {};

async function api(method, route, body, role = 'admin') {
  const headers = { 'Content-Type': 'application/json' };
  if (tokens[role]) headers.Authorization = `Bearer ${tokens[role]}`;

  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // Login all relevant staff roles
  const roles = [
    { role: 'admin', email: 'admin@samiha.local' },
    { role: 'reception', email: 'reception@samiha.local' },
    { role: 'nurse', email: 'nurse@samiha.local' },
    { role: 'doctor', email: 'imran@samiha.local' },
    { role: 'lab', email: 'lab@samiha.local' },
    { role: 'pharmacy', email: 'pharmacy@samiha.local' },
    { role: 'cashier', email: 'cashier@samiha.local' },
    { role: 'ward', email: 'ward@samiha.local' },
    { role: 'counselor', email: 'counselor@samiha.local' },
  ];

  for (const { role, email } of roles) {
    const res = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' });
    assert.strictEqual(res.status, 200, `Login failed for ${email}`);
    tokens[role] = res.body.token;
  }
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// =====================================================================
// 1. AUTH & SESSION
// =====================================================================
test('Module 1: Auth & User Profile CRUD', async () => {
  // Read current user
  const me = await api('GET', '/api/auth/me', undefined, 'admin');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.user.role, 'admin');
  assert.ok(me.body.clinic && me.body.clinic.name);

  // Test invalid login
  const badLogin = await api('POST', '/api/auth/login', { username: 'admin@samiha.local', password: 'wrongpassword' });
  assert.strictEqual(badLogin.status, 401);
});

// =====================================================================
// 2. PATIENTS CRUD
// =====================================================================
test('Module 2: Patients CRUD', async () => {
  // CREATE
  const createRes = await api('POST', '/api/patients', {
    firstName: 'Zainab',
    lastName: 'Khatoon',
    phone: '9840199999',
    gender: 'female',
    age: 34,
    bloodGroup: 'B+',
    address: '74 Market Street, Melapalayam',
    allergies: 'Penicillin',
    consentTreatment: true,
  }, 'reception');
  assert.strictEqual(createRes.status, 201);
  assert.ok(createRes.body.id);
  assert.ok(createRes.body.uhid);
  testState.patientId = createRes.body.id;
  testState.uhid = createRes.body.uhid;

  // READ (by ID)
  const readRes = await api('GET', `/api/patients/${testState.patientId}`, undefined, 'reception');
  assert.strictEqual(readRes.status, 200);
  assert.strictEqual(readRes.body.first_name, 'Zainab');
  assert.strictEqual(readRes.body.allergies, 'Penicillin');

  // READ (search query)
  const searchRes = await api('GET', `/api/patients?q=${testState.uhid}`, undefined, 'reception');
  assert.strictEqual(searchRes.status, 200);
  assert.ok(searchRes.body.rows.length >= 1);

  // UPDATE (PATCH)
  const updateRes = await api('PATCH', `/api/patients/${testState.patientId}`, {
    firstName: 'Zainab',
    lastName: 'Begum',
    allergies: 'Penicillin, Sulfa drugs',
  }, 'reception');
  assert.strictEqual(updateRes.status, 200);
  assert.strictEqual(updateRes.body.last_name, 'Begum');
  assert.strictEqual(updateRes.body.allergies, 'Penicillin, Sulfa drugs');
});

// =====================================================================
// 3. ENQUIRIES CRUD
// =====================================================================
test('Module 3: Enquiries CRUD', async () => {
  // CREATE
  const createRes = await api('POST', '/api/enquiries', {
    name: 'Rahim Khan',
    phone: '9840212345',
    source: 'walk_in',
    departmentId: 1,
    notes: 'Inquiring about knee pain treatment',
  }, 'reception');
  assert.strictEqual(createRes.status, 201);
  assert.ok(createRes.body.id);
  testState.enquiryId = createRes.body.id;

  // READ
  const listRes = await api('GET', '/api/enquiries', undefined, 'reception');
  assert.strictEqual(listRes.status, 200);
  assert.ok(listRes.body.rows.some((e) => e.id === testState.enquiryId));

  // UPDATE (PATCH)
  const updateRes = await api('PATCH', `/api/enquiries/${testState.enquiryId}`, {
    notes: 'Followed up via phone. Interested in consultation on Friday.',
    status: 'contacted',
  }, 'reception');
  assert.strictEqual(updateRes.status, 200);
  assert.strictEqual(updateRes.body.status, 'contacted');
});

// =====================================================================
// 4. APPOINTMENTS CRUD
// =====================================================================
test('Module 4: Appointments CRUD', async () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const doctor = db.prepare("SELECT id, department_id FROM users WHERE role = 'doctor' LIMIT 1").get();
  testState.doctorId = doctor.id;

  // CREATE (Book appointment)
  const bookRes = await api('POST', '/api/appointments', {
    patientId: testState.patientId,
    doctorId: testState.doctorId,
    departmentId: doctor.department_id,
    scheduledAt: `${tomorrow} 10:00:00`,
    reason: 'Follow-up consultation',
    visitKind: 'new',
  }, 'reception');
  assert.strictEqual(bookRes.status, 201);
  assert.ok(bookRes.body.id);
  assert.ok(bookRes.body.token_no);
  testState.appointmentId = bookRes.body.id;

  // READ
  const readRes = await api('GET', `/api/appointments?date=${tomorrow}`, undefined, 'reception');
  assert.strictEqual(readRes.status, 200);
  assert.ok(readRes.body.rows.some((a) => a.id === testState.appointmentId));

  // UPDATE (Reschedule)
  const reschedRes = await api('PATCH', `/api/appointments/${testState.appointmentId}`, {
    scheduledAt: `${tomorrow} 11:00:00`,
    reason: 'Rescheduled to 11 AM upon patient request',
  }, 'reception');
  assert.strictEqual(reschedRes.status, 200);

  // CANCEL
  const cancelRes = await api('PATCH', `/api/appointments/${testState.appointmentId}`, {
    status: 'cancelled',
    cancelReason: 'Patient called to cancel appointment',
  }, 'reception');
  assert.strictEqual(cancelRes.status, 200);
  assert.strictEqual(cancelRes.body.status, 'cancelled');
});

// =====================================================================
// 5. VISITS & QUEUE FLOW
// =====================================================================
test('Module 5: Patient Visit & Flow (Arrival -> Checkin -> Pay fee -> Vitals -> Call)', async () => {
  // CREATE VISIT (Arrival at front desk)
  const arriveRes = await api('POST', '/api/visits/arrive', {
    patientId: testState.patientId,
    doctorId: testState.doctorId,
    departmentId: 1,
    visitType: 'opd',
    reasonForVisit: 'General checkup',
  }, 'reception');
  assert.strictEqual(arriveRes.status, 201);
  assert.ok(arriveRes.body.visit.id);
  assert.ok(arriveRes.body.visit.token_no);
  testState.visitId = arriveRes.body.visit.id;
  testState.tokenNo = arriveRes.body.visit.token_no;

  // READ (Queue board)
  const visitDate = (arriveRes.body.visit.arrived_at || '').slice(0, 10);
  const boardRes = await api('GET', `/api/visits/board${visitDate ? `?date=${visitDate}` : ''}`, undefined, 'reception');
  assert.strictEqual(boardRes.status, 200);
  assert.ok(boardRes.body.rows.some((v) => v.id === testState.visitId));

  // CHECK-IN
  const checkinRes = await api('POST', `/api/visits/${testState.visitId}/check-in`, {
    reasonForVisit: 'General checkup verified',
  }, 'reception');
  assert.strictEqual(checkinRes.status, 200);

  // PAY CONSULTATION FEE
  const feeRes = await api('POST', `/api/visits/${testState.visitId}/consultation-fee`, {
    mode: 'cash',
  }, 'cashier');
  assert.strictEqual(feeRes.status, 201);

  // RECORD VITALS (Nurse)
  const vitalsRes = await api('POST', `/api/visits/${testState.visitId}/vitals`, {
    temperature: 98.6,
    pulse: 72,
    bpSystolic: 120,
    bpDiastolic: 80,
    spo2: 99,
    weightKg: 65,
    heightCm: 165,
    painScore: 0,
  }, 'nurse');
  assert.strictEqual(vitalsRes.status, 201);

  // CALL TOKEN TO CONSULTATION ROOM
  const callRes = await api('POST', `/api/visits/${testState.visitId}/call`, {}, 'doctor');
  assert.strictEqual(callRes.status, 200);
  assert.strictEqual(callRes.body.status, 'with_provider');
});

// =====================================================================
// 6. CLINICAL & PRESCRIPTIONS CRUD
// =====================================================================
test('Module 6: Clinical Consultation & Prescription CRUD', async () => {
  // Find a drug for prescription
  const drug = db.prepare("SELECT id, name FROM drugs WHERE active = 1 LIMIT 1").get();
  assert.ok(drug);

  // CREATE CONSULTATION & PRESCRIPTION
  const consultRes = await api('POST', `/api/visits/${testState.visitId}/consultation`, {
    chiefComplaint: 'Mild headache and tiredness',
    objective: 'BP normal, clear chest',
    assessment: 'Tension headache',
    plan: 'Hydration and rest',
    diagnoses: [{ icdCode: 'G44.2', title: 'Tension-type headache' }],
    prescriptions: [{
      drugId: drug.id,
      drugName: drug.name,
      dose: '1 tablet',
      frequency: 'twice_daily',
      durationDays: 3,
      instructions: 'After food',
    }],
  }, 'doctor');
  assert.strictEqual(consultRes.status, 201);
  assert.ok(consultRes.body.id);
  assert.ok(consultRes.body.prescriptions.length >= 1);
  testState.consultationId = consultRes.body.id;

  // READ PRESCRIPTIONS
  const rxRes = await api('GET', `/api/prescriptions?patientId=${testState.patientId}`, undefined, 'doctor');
  assert.strictEqual(rxRes.status, 200);
  assert.ok(Array.isArray(rxRes.body));
});

// =====================================================================
// 7. LAB & DIAGNOSTICS CRUD
// =====================================================================
test('Module 7: Lab Diagnostics CRUD (Catalogue, Order, Sample, Result, Verify)', async () => {
  // READ (Catalogue)
  const catalogueRes = await api('GET', '/api/masters/lab-tests', undefined, 'lab');
  assert.strictEqual(catalogueRes.status, 200);
  assert.ok(catalogueRes.body.length > 0);
  const testItem = catalogueRes.body[0];

  // CREATE LAB ORDER
  const orderRes = await api('POST', '/api/lab/orders', {
    visitId: testState.visitId,
    patientId: testState.patientId,
    doctorId: testState.doctorId,
    tests: [testItem.id],
    clinicalNotes: 'Check baseline parameters',
  }, 'doctor');
  assert.strictEqual(orderRes.status, 201);
  assert.ok(orderRes.body.id);
  testState.labOrderId = orderRes.body.id;

  // CASHIER RELEASES LAB ORDER
  const releaseRes = await api('POST', `/api/billing/diagnostics/${testState.labOrderId}/release`, {
    reason: 'Routine physician referral',
  }, 'cashier');
  assert.strictEqual(releaseRes.status, 200);

  // COLLECT SAMPLE
  const sampleRes = await api('POST', `/api/lab/orders/${testState.labOrderId}/collect`, {
    sampleType: 'blood',
  }, 'lab');
  assert.strictEqual(sampleRes.status, 200);
  assert.ok(sampleRes.body.barcode);

  // FETCH ORDER ITEMS
  const orderDetail = await api('GET', `/api/lab/orders/${testState.labOrderId}`, undefined, 'lab');
  assert.strictEqual(orderDetail.status, 200);
  const items = orderDetail.body.items || [];
  assert.ok(items.length >= 1);

  // ENTER RESULTS
  const enterRes = await api('POST', `/api/lab/orders/${testState.labOrderId}/results`, {
    results: items.map((it) => ({
      itemId: it.id,
      value: '13.5',
      notes: 'Normal findings',
    })),
  }, 'lab');
  assert.strictEqual(enterRes.status, 200);

  // VERIFY & SIGN OFF
  const verifyRes = await api('POST', `/api/lab/orders/${testState.labOrderId}/verify`, {}, 'lab');
  assert.strictEqual(verifyRes.status, 200);
  assert.strictEqual(verifyRes.body.ok, true);
  assert.strictEqual(verifyRes.body.order.status, 'reported');
});

// =====================================================================
// 8. PHARMACY & DISPENSING CRUD
// =====================================================================
test('Module 8: Pharmacy Formulary & Dispensing CRUD', async () => {
  // READ formulary
  const drugsRes = await api('GET', '/api/pharmacy/drugs', undefined, 'pharmacy');
  assert.strictEqual(drugsRes.status, 200);

  // Find a drug with available batch stock and MRP
  const batch = db.prepare(`
    SELECT id AS batch_id, drug_id, qty_available, mrp
      FROM drug_batches
     WHERE qty_available > 5 AND mrp > 0
     LIMIT 1
  `).get();
  assert.ok(batch, 'Must have at least one drug batch with stock and MRP');

  // CREATE PHARMACY COUNTER SALE
  const saleRes = await api('POST', '/api/pharmacy/counter-sale', {
    customerName: 'Zainab Begum',
    customerPhone: '9840199999',
    rxReference: 'Dr. Imran Sheikh / Op-1',
    items: [{
      drugId: batch.drug_id,
      qty: 2,
    }],
    paymentMode: 'cash',
  }, 'pharmacy');
  assert.strictEqual(saleRes.status, 201);
  assert.ok(saleRes.body.sale.id);
  assert.ok(saleRes.body.sale.bill_no);
  testState.saleId = saleRes.body.sale.id;

  // READ SALE DETAIL
  const getSale = await api('GET', `/api/pharmacy/sales/${testState.saleId}`, undefined, 'pharmacy');
  assert.strictEqual(getSale.status, 200);
  assert.strictEqual(getSale.body.id, testState.saleId);
});

// =====================================================================
// 9. STOCK & INVENTORY CRUD
// =====================================================================
test('Module 9: Stock & Inventory CRUD (Supplier, Purchase, Stock Take)', async () => {
  // CREATE SUPPLIER
  const supRes = await api('POST', '/api/stock/suppliers', {
    name: 'Al-Madina Pharma Distributors',
    phone: '9840911223',
    contactPerson: 'Mr. Siddiq',
    email: 'contact@almadina.local',
    address: 'High Road, Tirunelveli',
    gstin: '33AAAAA0000A1Z5',
  }, 'pharmacy');
  assert.strictEqual(supRes.status, 201);
  assert.ok(supRes.body.id);
  testState.supplierId = supRes.body.id;

  // READ SUPPLIERS
  const supList = await api('GET', '/api/stock/suppliers', undefined, 'pharmacy');
  assert.strictEqual(supList.status, 200);
  assert.ok(supList.body.some((s) => s.id === testState.supplierId));

  // CREATE PURCHASE INWARD
  const drug = db.prepare("SELECT id FROM drugs LIMIT 1").get();
  const purchaseRes = await api('POST', '/api/stock/purchases', {
    supplierId: testState.supplierId,
    invoiceNo: 'AMP-2026-901',
    invoiceDate: new Date().toISOString().slice(0, 10),
    items: [{
      drugId: drug.id,
      batchNo: 'BAT-2026-X',
      expiryDate: '2028-12-31',
      qty: 100,
      purchasePrice: 10.00,
      mrp: 18.00,
      taxPercent: 12,
    }],
  }, 'pharmacy');
  assert.strictEqual(purchaseRes.status, 201);
  assert.ok(purchaseRes.body.purchase.id);

  // READ STOCK REGISTER
  const ledgerRes = await api('GET', '/api/stock/register', undefined, 'pharmacy');
  assert.strictEqual(ledgerRes.status, 200);
});

// =====================================================================
// 10. BILLING & INVOICES CRUD
// =====================================================================
test('Module 10: Billing & Invoices CRUD', async () => {
  // CREATE BILL / INVOICE
  const invoiceRes = await api('POST', '/api/billing/invoices', {
    patientId: testState.patientId,
    visitId: testState.visitId,
    kind: 'opd',
  }, 'cashier');
  assert.strictEqual(invoiceRes.status, 201);
  assert.ok(invoiceRes.body.id);
  testState.invoiceId = invoiceRes.body.id;

  // ADD BILL ITEMS
  await api('POST', `/api/billing/invoices/${testState.invoiceId}/items`, {
    description: 'Nursing Observation',
    unitPrice: 150.00,
    qty: 1,
  }, 'cashier');

  await api('POST', `/api/billing/invoices/${testState.invoiceId}/items`, {
    description: 'ECG Recording',
    unitPrice: 250.00,
    qty: 1,
  }, 'cashier');

  // READ INVOICE
  const getInvoice = await api('GET', `/api/billing/invoices/${testState.invoiceId}`, undefined, 'cashier');
  assert.strictEqual(getInvoice.status, 200);
  assert.strictEqual(Number(getInvoice.body.net), 400.00);

  // RECORD PAYMENT (UPDATE INVOICE BALANCE)
  const payRes = await api('POST', `/api/billing/invoices/${testState.invoiceId}/payments`, {
    amount: 400.00,
    mode: 'upi',
    reference: 'UPI984000112233',
  }, 'cashier');
  assert.strictEqual(payRes.status, 201);
  assert.strictEqual(Number(payRes.body.invoice.balance), 0);
});

// =====================================================================
// 11. ACCOUNTS & CASH BOOK CRUD
// =====================================================================
test('Module 11: Accounts & Cash Book CRUD', async () => {
  // CREATE CASH BOOK EXPENSE
  const cashRes = await api('POST', '/api/accounts/entries', {
    direction: 'out',
    category: 'Electricity & water',
    amount: 75.00,
    payee: 'Tamil Nadu Electricity Board',
    notes: 'Clinic daytime meter billing',
  }, 'cashier');
  assert.strictEqual(cashRes.status, 201);
  assert.ok(cashRes.body.id);

  // READ CASH BOOK
  const bookRes = await api('GET', '/api/accounts/entries', undefined, 'cashier');
  assert.strictEqual(bookRes.status, 200);
  assert.ok(bookRes.body.rows.length >= 1);
});

// =====================================================================
// 12. IN-PATIENT (IPD) CRUD
// =====================================================================
test('Module 12: IPD In-Patient CRUD (Admission, Bed, Rounds, Discharge)', async () => {
  // Find an available vacant bed
  const bed = db.prepare("SELECT id, ward_id, bed_no FROM beds WHERE status = 'vacant' LIMIT 1").get();
  assert.ok(bed, 'Must have at least one vacant bed');

  // CREATE ADMISSION
  const admitRes = await api('POST', '/api/ipd/admissions', {
    patientId: testState.patientId,
    doctorId: testState.doctorId,
    bedId: bed.id,
    admissionType: 'planned',
    reason: 'Observation for severe migraine',
    attendantName: 'Brother',
    attendantPhone: '9840199999',
  }, 'ward');
  assert.strictEqual(admitRes.status, 201);
  assert.ok(admitRes.body.id);
  testState.admissionId = admitRes.body.id;

  // RECORD CLINICAL NOTE
  const noteRes = await api('POST', `/api/ipd/admissions/${testState.admissionId}/notes`, {
    note: 'Patient stable, vitals normal. Continue IV fluids.',
    noteType: 'doctor_round',
  }, 'doctor');
  assert.strictEqual(noteRes.status, 201);

  // ADD IP CHARGE
  const chargeRes = await api('POST', `/api/ipd/admissions/${testState.admissionId}/charges`, {
    description: 'Specialist Round Charge',
    unitPrice: 350.00,
    qty: 1,
  }, 'ward');
  assert.strictEqual(chargeRes.status, 201);

  // DISCHARGE PATIENT
  const dischargeRes = await api('POST', `/api/ipd/admissions/${testState.admissionId}/discharge`, {
    dischargeType: 'recovered',
    finalDiagnosis: 'Acute migraine with aura - resolved',
    advice: 'Adequate rest and follow-up in 1 week',
    force: true,
  }, 'doctor');
  assert.strictEqual(dischargeRes.status, 200);
  assert.strictEqual(dischargeRes.body.admission.status, 'discharged');
});

// =====================================================================
// 13. INSURANCE & TPA CRUD
// =====================================================================
test('Module 13: Insurance & Claims CRUD', async () => {
  // Find an insurer
  const insurer = db.prepare("SELECT id, name FROM insurers LIMIT 1").get();
  assert.ok(insurer);

  // CREATE PATIENT POLICY
  const polRes = await api('POST', '/api/insurance/policies', {
    patientId: testState.patientId,
    insurerId: insurer.id,
    policyNo: 'STAR-HEALTH-2026-99',
    memberId: 'MEM-00129',
    sumInsured: 300000,
  }, 'reception');
  assert.strictEqual(polRes.status, 201);
  assert.ok(polRes.body.id);
  const policyId = polRes.body.id;

  // CREATE INSURANCE CLAIM
  const claimRes = await api('POST', '/api/insurance/claims', {
    policyId,
    invoiceId: testState.invoiceId,
    claimType: 'reimbursement',
    remarks: 'Reimbursement claim submitted with hospital bill',
  }, 'cashier');
  assert.strictEqual(claimRes.status, 201);
  assert.ok(claimRes.body.id);
  testState.claimId = claimRes.body.id;

  // READ CLAIMS
  const claimList = await api('GET', '/api/insurance/claims', undefined, 'cashier');
  assert.strictEqual(claimList.status, 200);
  assert.ok(claimList.body.rows.some((c) => c.id === testState.claimId));
});

// =====================================================================
// 14. TV KIOSK QUEUE & RE-CALL
// =====================================================================
test('Module 14: TV Kiosk Queue Display & Patient Calling', async () => {
  // READ PUBLIC KIOSK QUEUE
  const queueRes = await fetch(`${base}/api/kiosk/queue`);
  assert.strictEqual(queueRes.status, 200);
  const queue = await queueRes.json();
  assert.strictEqual(queue.ok, true);
  assert.ok(Array.isArray(queue.rooms));

  // CHECK KIOSK PAGE HTML SERVED
  const kioskPage = await fetch(`${base}/kiosk`);
  assert.strictEqual(kioskPage.status, 200);
  const html = await kioskPage.text();
  assert.ok(html.includes('kiosk-grid'));
  assert.ok(html.includes('Now Serving'));

  // RE-CALL / RING PATIENT TO TV
  const ringRes = await api('POST', `/api/visits/${testState.visitId}/call`, {}, 'doctor');
  assert.strictEqual(ringRes.status, 200);
  assert.strictEqual(ringRes.body.ok, true);
});
