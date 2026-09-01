'use strict';
/**
 * End-to-end walk of the clinic workflow, in the order of the flowchart:
 *   WhatsApp booking → arrival → financial screening → check-in → vitals
 *   → consultation → lab → pharmacy → billing → check-out
 * plus a full IPD admission-to-discharge cycle.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Run against a throwaway database so the suite is repeatable and never
// touches the working clinic data.
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-test-')), 'test.db');
process.env.DB_FILE = tmpDb;
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
const app = require('../src/server');

let server;
let base;
const tokens = {};
const ids = {};

async function api(method, path, body, as = 'admin') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tokens[as] ? { Authorization: `Bearer ${tokens[as]}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function login(as, email) {
  const res = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
  assert.strictEqual(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
  tokens[as] = res.body.token;
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['counselor', 'counselor@samiha.local'], ['nurse', 'nurse@samiha.local'],
    ['doctor', 'imran@samiha.local'], ['lab', 'lab@samiha.local'],
    ['pharmacy', 'pharmacy@samiha.local'], ['cashier', 'cashier@samiha.local'],
    ['ward', 'ward@samiha.local'],
  ]) await login(as, email);

  const staff = (await api('GET', '/api/masters/staff?role=doctor', undefined, 'admin')).body;
  ids.drImran = staff.find((d) => d.email === 'imran@samiha.local').id;
  ids.drSara = staff.find((d) => d.email === 'sara@samiha.local').id;

  const drugs = (await api('GET', '/api/pharmacy/drugs?q=Pan', undefined, 'pharmacy')).body;
  ids.pan40 = drugs.find((d) => d.code === 'PAN40').id;
  ids.para = (await api('GET', '/api/pharmacy/drugs?q=Dolo', undefined, 'pharmacy')).body[0].id;

  const tests = (await api('GET', '/api/masters/lab-tests', undefined, 'lab')).body;
  ids.cbc = tests.find((t) => t.code === 'CBC').id;
  ids.fbs = tests.find((t) => t.code === 'FBS').id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
});

test('health endpoint is public', async () => {
  const res = await api('GET', '/api/health', undefined, null);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
});

test('unauthenticated API access is rejected', async () => {
  const res = await api('GET', '/api/patients', undefined, null);
  assert.strictEqual(res.status, 401);
});

test('role gate blocks a nurse from registering a patient', async () => {
  const res = await api('POST', '/api/patients', { firstName: 'Test' }, 'nurse');
  assert.strictEqual(res.status, 403);
});

test('WhatsApp bot books an appointment end to end', async () => {
  const from = '919000000111';
  const say = (text) => api('POST', '/api/whatsapp/simulate', { from, text }, 'reception');

  let r = await say('Hi');
  assert.match(r.body.reply, /Book an appointment/);

  r = await say('1');                       // book
  assert.match(r.body.reply, /Which department/);
  r = await say('1');                       // first department
  assert.match(r.body.reply, /choose a doctor/);
  r = await say('1');                       // first doctor
  assert.match(r.body.reply, /pick a day/);
  r = await say('1');                       // first available day
  assert.match(r.body.reply, /pick a time/);
  r = await say('1');                       // first slot
  assert.match(r.body.reply, /full name/);  // unknown number → new patient path
  r = await say('Zainab Hussain');
  assert.match(r.body.reply, /age and gender/);
  r = await say('41 female');
  assert.match(r.body.reply, /reason for your visit/);
  r = await say('Persistent cough for two weeks');
  assert.match(r.body.reply, /Please confirm/);
  r = await say('YES');
  assert.match(r.body.reply, /Appointment confirmed/);
  assert.match(r.body.reply, /APT\d+/);

  // The booking must exist as both an enquiry and a confirmed appointment.
  const list = await api('GET', '/api/appointments?status=confirmed', undefined, 'reception');
  assert.ok(list.body.rows.some((a) => a.source === 'whatsapp' && a.guest_name === 'Zainab Hussain'));

  const enquiries = await api('GET', '/api/enquiries?source=whatsapp', undefined, 'reception');
  assert.ok(enquiries.body.rows.length >= 1);

  // Cancellation by reference works from any state.
  const apptNo = r.body.reply.match(/APT\d+/)[0];
  const cancel = await say(`CANCEL ${apptNo}`);
  assert.match(cancel.body.reply, /has been cancelled/);
});

test('full OPD journey: arrive → screen → check-in → vitals → consult → lab → pharmacy → bill → exit',
  async () => {
    // ---- registration --------------------------------------------------
    const reg = await api('POST', '/api/patients', {
      firstName: 'Imran', lastName: 'Qureshi', gender: 'male', age: 45,
      phone: '9000000222', isUninsured: true, city: 'Chennai',
      history: [{ kind: 'past_illness', detail: 'Gastritis, 2021' }],
    }, 'reception');
    assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
    const patientId = reg.body.id;
    assert.match(reg.body.uhid, /^SPD/);

    // ---- arrival: new patient + uninsured → financial screening lane ----
    const arrive = await api('POST', '/api/visits/arrive', {
      patientId, reasonForVisit: 'Burning epigastric pain', doctorId: ids.drImran,
    }, 'reception');
    assert.strictEqual(arrive.status, 201, JSON.stringify(arrive.body));
    const visitId = arrive.body.visit.id;
    assert.strictEqual(arrive.body.flags.isNewPatient, true);
    assert.strictEqual(arrive.body.nextStep, 'financial_screening');

    // ---- financial screening -------------------------------------------
    const screen = await api('POST', '/api/financial/screenings', { patientId, visitId }, 'counselor');
    assert.strictEqual(screen.status, 201, JSON.stringify(screen.body));
    const screeningId = screen.body.screening.id;

    const assess = await api('POST', `/api/financial/screenings/${screeningId}/assess`, {
      householdSize: 4, annualIncome: 300000, hasProofOfIncome: true, proofType: 'pay_stub', uninsured: true,
    }, 'counselor');
    assert.strictEqual(assess.status, 200, JSON.stringify(assess.body));
    // 300000 / 264000 ≈ 113.6% FPL → band B → 75% discount
    assert.ok(assess.body.assessment.fplPct > 110 && assess.body.assessment.fplPct < 120);
    assert.strictEqual(assess.body.assessment.band, 'B');
    assert.strictEqual(assess.body.assessment.discountPct, 75);
    assert.ok(assess.body.assessment.eligiblePrograms.length > 0);

    const decide = await api('POST', `/api/financial/screenings/${screeningId}/decide`, {
      decision: 'continue',
    }, 'counselor');
    assert.strictEqual(decide.status, 200, JSON.stringify(decide.body));
    assert.strictEqual(decide.body.nextStep, 'waiting_room');

    // ---- check-in -------------------------------------------------------
    const checkIn = await api('POST', `/api/visits/${visitId}/check-in`, {
      reasonForVisit: 'Burning epigastric pain', doctorId: ids.drImran,
    }, 'reception');
    assert.strictEqual(checkIn.status, 200, JSON.stringify(checkIn.body));

    // ---- vitals ---------------------------------------------------------
    const vitals = await api('POST', `/api/visits/${visitId}/vitals`, {
      heightCm: 172, weightKg: 84, tempC: 37.1, pulse: 88, bpSystolic: 148, bpDiastolic: 94, spo2: 97,
    }, 'nurse');
    assert.strictEqual(vitals.status, 201, JSON.stringify(vitals.body));
    assert.strictEqual(vitals.body.vitals.bmi, 28.4);
    assert.ok(vitals.body.alerts.some((a) => /pressure/i.test(a.text)));

    // ---- consultation ---------------------------------------------------
    const consult = await api('POST', `/api/visits/${visitId}/consultation`, {
      chiefComplaint: 'Epigastric burning for 3 weeks',
      subjective: 'Worse at night, relieved by antacids. No haematemesis.',
      objective: 'Epigastric tenderness. No guarding.',
      assessment: 'Gastro-oesophageal reflux disease',
      plan: 'PPI for 4 weeks, lifestyle advice, review with reports',
      diagnoses: [{ icdCode: 'K21.9', title: 'Gastro-oesophageal reflux disease', kind: 'provisional' }],
      prescriptions: [
        { drugId: ids.pan40, drugName: 'Pan 40', dose: '40 mg', frequency: 'OD', durationDays: 28, quantity: 28,
          instructions: 'Before breakfast' },
      ],
      followUpDays: 30,
    }, 'doctor');
    assert.strictEqual(consult.status, 201, JSON.stringify(consult.body));
    assert.strictEqual(consult.body.prescriptions.length, 1);
    assert.ok(consult.body.follow_up_date);

    // ---- lab order ------------------------------------------------------
    const order = await api('POST', '/api/lab/orders', {
      patientId, visitId, tests: [{ testId: ids.cbc }, { testId: ids.fbs }], priority: 'routine',
    }, 'doctor');
    assert.strictEqual(order.status, 201, JSON.stringify(order.body));
    const orderId = order.body.id;

    const sign = await api('POST', `/api/visits/${visitId}/consultation/sign`, {}, 'doctor');
    assert.strictEqual(sign.status, 200);
    assert.strictEqual(sign.body.labsOpen, 1);
    assert.strictEqual(sign.body.nextStep, 'lab');

    // ---- results page the patient carries to check-out -------------------
    const resultsPage = await api('GET', `/api/visits/${visitId}/results-page`, undefined, 'reception');
    assert.strictEqual(resultsPage.status, 200);
    assert.strictEqual(resultsPage.body.medicationList.length, 1);
    assert.strictEqual(resultsPage.body.labOrders.length, 1);
    assert.ok(resultsPage.body.timeline.length >= 4);

    // ---- lab processing --------------------------------------------------
    const collect = await api('POST', `/api/lab/orders/${orderId}/collect`, { sampleType: 'blood' }, 'lab');
    assert.strictEqual(collect.status, 200);
    assert.ok(collect.body.barcode);

    await api('POST', `/api/lab/orders/${orderId}/start`, {}, 'lab');
    const items = (await api('GET', `/api/lab/orders/${orderId}`, undefined, 'lab')).body.items;
    const results = await api('POST', `/api/lab/orders/${orderId}/results`, {
      results: [
        { itemId: items[0].id, value: '13.2' },
        { itemId: items[1].id, value: '142' },   // FBS ref 70–100 → high
      ],
    }, 'lab');
    assert.strictEqual(results.status, 200);
    assert.strictEqual(results.body.find((i) => i.id === items[1].id).abnormal_flag, 'high');

    const verify = await api('POST', `/api/lab/orders/${orderId}/verify`, {}, 'lab');
    assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));
    assert.strictEqual(verify.body.order.status, 'reported');

    // ---- pharmacy --------------------------------------------------------
    const rx = (await api('GET', `/api/pharmacy/prescriptions/${visitId}`, undefined, 'pharmacy')).body;
    assert.strictEqual(rx.prescriptions.length, 1);

    const dispense = await api('POST', '/api/pharmacy/dispense', {
      patientId, visitId,
      items: [{ drugId: ids.pan40, prescriptionId: rx.prescriptions[0].id, qty: 28 }],
    }, 'pharmacy');
    assert.strictEqual(dispense.status, 201, JSON.stringify(dispense.body));
    assert.strictEqual(dispense.body.items[0].qty, 28);
    assert.ok(dispense.body.invoice.net > 0);

    // ---- billing with the sliding-scale discount applied ------------------
    const bill = await api('POST', `/api/visits/${visitId}/prepare-bill`, {}, 'cashier');
    assert.strictEqual(bill.status, 200, JSON.stringify(bill.body));
    const invoiceId = bill.body.id;
    assert.ok(bill.body.items.length >= 3, 'consultation + labs + pharmacy expected');
    assert.ok(bill.body.sliding_discount > 0, 'band B discount should be applied');
    console.log(`      billing: gross ${bill.body.gross}, sliding-scale discount ${bill.body.sliding_discount}, net ${bill.body.net}`);

    // ---- check-out is blocked while a balance stands ---------------------
    const blocked = await api('POST', `/api/visits/${visitId}/check-out`, {}, 'cashier');
    assert.strictEqual(blocked.status, 409);
    assert.match(blocked.body.error, /Outstanding balance/);

    // ---- overpayment is refused ------------------------------------------
    const over = await api('POST', `/api/billing/invoices/${invoiceId}/payments`, {
      amount: bill.body.balance + 500, mode: 'cash',
    }, 'cashier');
    assert.strictEqual(over.status, 400);

    // ---- part payment + payment-plan agreement for the rest --------------
    const part = await api('POST', `/api/billing/invoices/${invoiceId}/payments`, {
      amount: Math.round(bill.body.balance / 2), mode: 'upi', reference: 'UPI-TEST-1',
    }, 'cashier');
    assert.strictEqual(part.status, 201, JSON.stringify(part.body));
    assert.strictEqual(part.body.invoice.status, 'partial');

    const plan = await api('POST', `/api/billing/invoices/${invoiceId}/payment-plan`, {
      installments: 3, frequency: 'monthly',
    }, 'cashier');
    assert.strictEqual(plan.status, 201, JSON.stringify(plan.body));
    assert.strictEqual(plan.body.schedule.length, 3);
    const scheduled = plan.body.schedule.reduce((s, i) => s + i.amount, 0);
    assert.ok(Math.abs(scheduled - plan.body.plan.total_amount) < 0.02, 'instalments must sum to the financed amount');

    // ---- check-out now succeeds, and books the follow-up -----------------
    const tomorrow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const out = await api('POST', `/api/visits/${visitId}/check-out`, {
      followUp: { doctorId: ids.drImran, scheduledAt: `${tomorrow} 10:00:00`, reason: 'Review with reports' },
    }, 'cashier');
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.match(out.body.exitPassNo, /^EX/);
    assert.ok(out.body.followUp, 'follow-up appointment should be created');
    assert.strictEqual(out.body.visit.status, 'checked_out');
  });

test('IPD: admit → round → medication → charge → discharge', async () => {
  const patientId = (await api('GET', '/api/patients?q=Sunita', undefined, 'reception')).body.rows[0].id;
  const wards = (await api('GET', '/api/ipd/wards', undefined, 'ward')).body;
  const bed = wards.wards.flatMap((w) => w.beds).find((b) => b.status === 'vacant');
  assert.ok(bed, 'a vacant bed is required');

  const admit = await api('POST', '/api/ipd/admissions', {
    patientId, doctorId: ids.drImran, bedId: bed.id, admissionType: 'planned',
    reason: 'Uncontrolled knee pain for observation', provisionalDiagnosis: 'Osteoarthritis, acute flare',
    attendantName: 'Ramesh', attendantPhone: '9000000333',
  }, 'ward');
  assert.strictEqual(admit.status, 201, JSON.stringify(admit.body));
  const admissionId = admit.body.id;
  assert.match(admit.body.ip_no, /^IP/);

  // The bed must now read as occupied.
  const after = (await api('GET', '/api/ipd/wards', undefined, 'ward')).body;
  assert.strictEqual(after.wards.flatMap((w) => w.beds).find((b) => b.id === bed.id).status, 'occupied');

  // Double-admitting the same patient is refused.
  const dup = await api('POST', '/api/ipd/admissions', { patientId, doctorId: ids.drImran, bedId: bed.id }, 'ward');
  assert.strictEqual(dup.status, 409);

  await api('POST', `/api/ipd/admissions/${admissionId}/notes`, {
    noteType: 'doctor_round', note: 'Pain better on analgesia. Continue physiotherapy.',
  }, 'doctor');

  const med = await api('POST', `/api/ipd/admissions/${admissionId}/medications`, {
    drugName: 'Voveran Injection', dose: '75 mg', frequency: 'BD', route: 'IM',
    startDate: new Date().toISOString().slice(0, 10),
    endDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
  }, 'doctor');
  assert.strictEqual(med.status, 201, JSON.stringify(med.body));
  assert.strictEqual(med.body.schedule.length, 6, '3 days × BD');

  const mar = await api('GET', `/api/ipd/admissions/${admissionId}/mar`, undefined, 'nurse');
  assert.ok(mar.body.length >= 2);
  const given = await api('POST', `/api/ipd/mar/${mar.body[0].id}`, { status: 'given' }, 'nurse');
  assert.strictEqual(given.body.status, 'given');

  await api('POST', `/api/ipd/admissions/${admissionId}/charges`, {
    description: 'Physiotherapy session', qty: 2, unitPrice: 350,
  }, 'ward');

  // Discharge is refused while the bill stands.
  const early = await api('POST', `/api/ipd/admissions/${admissionId}/discharge`, {
    finalDiagnosis: 'Osteoarthritis of knee', dischargeType: 'recovered',
  }, 'ward');
  assert.strictEqual(early.status, 409);
  assert.ok(early.body.invoice.net > 0);

  // Settle, then discharge.
  const invoiceId = early.body.invoice.id;
  await api('POST', `/api/billing/invoices/${invoiceId}/payments`, {
    amount: early.body.invoice.balance, mode: 'cash',
  }, 'cashier');

  const discharge = await api('POST', `/api/ipd/admissions/${admissionId}/discharge`, {
    finalDiagnosis: 'Osteoarthritis of knee (M17.9)', dischargeType: 'recovered',
    courseInHospital: 'Settled on analgesia and physiotherapy.',
    advice: 'Knee strengthening exercises, weight reduction.',
    followUpDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
  }, 'ward');
  assert.strictEqual(discharge.status, 200, JSON.stringify(discharge.body));
  assert.strictEqual(discharge.body.admission.status, 'discharged');
  assert.strictEqual(discharge.body.invoice.balance, 0);

  // The bed is released for cleaning.
  const released = (await api('GET', '/api/ipd/wards', undefined, 'ward')).body;
  assert.strictEqual(released.wards.flatMap((w) => w.beds).find((b) => b.id === bed.id).status, 'cleaning');

  const summary = await api('GET', `/api/ipd/admissions/${admissionId}/discharge-summary`, undefined, 'doctor');
  assert.strictEqual(summary.status, 200);
  assert.strictEqual(summary.body.medications.length, 1);
});

test('pharmacy refuses to dispense more than stock on hand', async () => {
  const patientId = (await api('GET', '/api/patients?q=Meera', undefined, 'reception')).body.rows[0].id;
  const res = await api('POST', '/api/pharmacy/dispense', {
    patientId, items: [{ drugId: ids.para, qty: 999999 }],
  }, 'pharmacy');
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /Insufficient stock/);
});

test('double booking the same slot is refused', async () => {
  const dates = (await api('GET', `/api/appointments/availability?doctorId=${ids.drSara}`, undefined, 'reception')).body.dates;
  const day = dates[0].date;
  const slots = (await api('GET', `/api/appointments/availability?doctorId=${ids.drSara}&date=${day}`, undefined, 'reception')).body.slots;
  const at = `${day} ${slots[0].time}:00`;

  const first = await api('POST', '/api/appointments', {
    doctorId: ids.drSara, scheduledAt: at, guestName: 'Slot Test', guestPhone: '9000000444',
  }, 'reception');
  assert.strictEqual(first.status, 201, JSON.stringify(first.body));

  const second = await api('POST', '/api/appointments', {
    doctorId: ids.drSara, scheduledAt: at, guestName: 'Clash Test', guestPhone: '9000000555',
  }, 'reception');
  assert.strictEqual(second.status, 409);
});

test('dashboard and turnaround reports respond', async () => {
  const dash = await api('GET', '/api/reports/dashboard', undefined, 'admin');
  assert.strictEqual(dash.status, 200);
  assert.ok(dash.body.opd.visits >= 1);
  assert.ok(dash.body.ipd.beds.total > 0);

  const tat = await api('GET', '/api/reports/turnaround', undefined, 'admin');
  assert.strictEqual(tat.status, 200);
  assert.ok(tat.body.sample >= 1);

  const trend = await api('GET', '/api/reports/trend?days=14', undefined, 'admin');
  assert.strictEqual(trend.status, 200);
  assert.strictEqual(trend.body.length, 14);
});
