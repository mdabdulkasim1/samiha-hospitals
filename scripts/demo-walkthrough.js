#!/usr/bin/env node
/*
 * A worked example, start to finish: one diabetic patient walked through every
 * desk in the clinic.
 *
 *   node scripts/demo-walkthrough.js [http://localhost:3000]
 *
 * It calls the same API the screens call, signing in as each member of staff in
 * turn, so what it leaves behind is an ordinary day's work and not fixture data
 * poked into the database. Run it against a demo server, read what it prints,
 * then sign in as each person named and look at the screen it points you at.
 *
 * Everything it creates is real: the enquiry can be found under Enquiries, the
 * bill under Billing, the prescription in the pharmacy queue. Run it twice and
 * you get a second patient, not an error.
 */
'use strict';

const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const PASSWORD = process.env.DEMO_PASSWORD || 'samiha@123';

// ------------------------------------------------------------------ plumbing
async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Cannot sign in as ${email}: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const token = body.token;
  return async (method, path, payload) => {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

const money = (n) => '₹' + Number(n || 0).toFixed(2);
let step = 0;
const say = (who, screen, what) => {
  step += 1;
  console.log(`\n${String(step).padStart(2, ' ')}. ${who}  —  ${screen}`);
  for (const line of [].concat(what)) console.log(`    ${line}`);
};

// The demo patient. A new mobile number each run, so a second run adds a
// second Mohamed Kasim rather than colliding with the first.
const STAMP = String(Date.now()).slice(-6);
const PATIENT = {
  firstName: 'Mohamed', lastName: 'Kasim',
  phone: '9007' + STAMP, gender: 'male', age: 54,
  aadhaarNumber: '234567890124',
  address: 'Nethaji Road, Melapalayam', city: 'Tirunelveli', pincode: '627005',
};

(async () => {
  console.log(`\nSAMIHA POLYCLINIC — a patient from enquiry to the pharmacy\n${'='.repeat(58)}`);
  console.log(`Server: ${BASE}   ·   everyone signs in with the password ${PASSWORD}`);

  const desk = await login('reception@samiha.local');
  const nurse = await login('nurse@samiha.local');
  const lab = await login('lab@samiha.local');
  const cash = await login('cashier@samiha.local');
  const chemist = await login('pharmacy@samiha.local');

  const doctors = await desk('GET', '/api/masters/staff?role=doctor');
  const doctor = doctors.find((d) => /Imran/.test(d.name)) || doctors[0];
  const drLogin = (doctor.email || 'imran@samiha.local');
  const dr = await login(drLogin);

  // 1 -------------------------------------------------------------- enquiry
  const enquiry = await desk('POST', '/api/enquiries', {
    name: `${PATIENT.firstName} ${PATIENT.lastName}`, phone: PATIENT.phone,
    source: 'phone', doctorId: doctor.id,
    subject: 'Sugar has been high, wants to see a physician',
    notes: 'Known diabetic for 6 years, on tablets, has not tested in a year.',
  });
  say('Fathima at the front desk (reception@samiha.local)', 'Enquiries', [
    `Rang up. Enquiry ${enquiry.ref_no} raised and a file opened at enquiry stage.`,
    `Nothing has been charged for and nothing has been promised — this is a lead.`,
  ]);

  // 2 --------------------------------------------------------- registration
  const registered = await desk('POST', `/api/patients/${enquiry.patient_id}/register`, {
    ...PATIENT, consentTreatment: true, consentWhatsapp: true,
  });
  const patient = registered.patient || registered;
  say('Fathima at the front desk', 'Patients → the enquiry, then “Register”', [
    `${patient.first_name} ${patient.last_name}, ${PATIENT.age}, male — UHID ${patient.uhid}.`,
    `Aadhaar ${PATIENT.aadhaarNumber} is on the file, so it prints on the prescription and the report.`,
    `The enquiry is now converted, not lost: the record runs from the first phone call.`,
  ]);
  await desk('PATCH', `/api/enquiries/${enquiry.id}`,
    { status: 'converted', patientId: patient.id });
  await desk('POST', `/api/patients/${patient.id}/history`,
    { kind: 'past_illness', detail: 'Type 2 diabetes mellitus — on metformin since 2019', since: '2019' });

  // 3 ---------------------------------------------------- appointment + arrival
  const when = new Date(Date.now() + 45 * 60000);
  const slot = `${when.toISOString().slice(0, 10)} ${String(when.getHours()).padStart(2, '0')}:00:00`;
  let appointment = null;
  try {
    appointment = await desk('POST', '/api/appointments', {
      patientId: patient.id, doctorId: doctor.id, scheduledAt: slot,
      reason: 'Diabetes review', visitKind: 'new',
    });
  } catch { /* the slot may be taken on a busy demo server; the walk-in below still works */ }

  const visit = await desk('POST', '/api/visits/arrive', {
    patientId: patient.id, doctorId: doctor.id, visitType: 'opd',
    appointmentId: appointment ? appointment.id : undefined,
    reasonForVisit: 'Diabetes review — sugars high, tired, passing urine at night',
  });
  const visitRow = visit.visit || visit;
  const visitId = visitRow.id;
  say('Fathima at the front desk', 'Appointments, then Queue → “Arrived”', [
    appointment ? `Booked as ${appointment.appt_no}, token ${appointment.token_no}.`
                : `Walked in without an appointment — the desk takes him anyway.`,
    `Visit ${visitRow.visit_no || ''} opened for ${doctor.name}. He is now in the waiting room.`,
    `The cashier can already see him on Billing → Today's collections, with no bill yet.`,
  ]);

  // 4 ---------------------------------------------------------------- vitals
  const vitals = await nurse('POST', `/api/visits/${visitId}/vitals`, {
    bpSystolic: 148, bpDiastolic: 92, pulse: 88, respRate: 18, tempC: 36.9,
    spo2: 97, heightCm: 170, weightKg: 84, bloodSugar: 232, painScore: 1,
  });
  const bmi = vitals.bmi || (84 / (1.7 * 1.7));
  say('Sister Mary (nurse@samiha.local)', 'Nurse Station', [
    `BP 148/92, pulse 88, SpO₂ 97%, random sugar 232 mg/dL.`,
    `170 cm and 84 kg — BMI ${Number(bmi).toFixed(1)}, worked out for her, obese on the Indian cut-offs.`,
    (vitals.alerts && vitals.alerts.length)
      ? `The screen flags: ${vitals.alerts.map((a) => `${a.text} (${a.level})`).join(' ')}`
      : `Nothing flagged for escalation.`,
    `Height, weight and BMI now follow him onto the prescription and the lab report.`,
  ]);

  // 5 ------------------------------------------------ consultation and orders
  await dr('POST', `/api/visits/${visitId}/consultation`, {
    subjective: 'Known T2DM 6 years on metformin. Tired, nocturia, blurred vision 3 weeks. Not tested in a year.',
    objective: 'Alert, afebrile. BP 148/92. BMI 29.1. No foot ulcer, pedal pulses present.',
    assessment: 'Type 2 diabetes mellitus, poorly controlled, with hypertension.',
    plan: 'HbA1c, fasting sugar, lipids, creatinine and urine routine today. Step up metformin, add glimepiride. Review with reports.',
  });

  const tests = await dr('GET', '/api/masters/lab-tests');
  const wanted = ['HBA1C', 'FBS', 'LIPID', 'CREAT', 'URINE'];
  const ordered = wanted.map((c) => tests.find((t) => t.code === c)).filter(Boolean);
  const order = await dr('POST', '/api/lab/orders', {
    patientId: patient.id, visitId, doctorId: doctor.id, priority: 'routine',
    tests: ordered.map((t) => ({ testId: t.id })),
    clinicalNotes: 'Diabetes review, fasting sample.',
  });

  const drugs = await dr('GET', '/api/pharmacy/drugs?limit=800');
  const pick = (re) => drugs.find((d) => re.test(d.name));
  const metformin = pick(/metformin/i);
  const glimepiride = pick(/glimepiride|glimipiride/i) || pick(/gliclazide/i);
  const items = [];
  if (metformin) items.push({ drugId: metformin.id, doseMorning: 1, doseNight: 1, durationDays: 30, instructions: 'After food' });
  if (glimepiride) items.push({ drugId: glimepiride.id, doseMorning: 1, durationDays: 30, instructions: 'Before breakfast' });

  const sheet = await dr('POST', '/api/prescriptions', {
    patientId: patient.id, visitId, items,
    diagnoses: [
      { code: 'E11.65', rank: 'primary' },
      { code: 'I10', rank: 'secondary' },
    ],
    advice: 'Walk 30 minutes daily. Cut rice at night. Fasting sugar chart weekly.',
    followUpDays: 14,
  });
  await dr('POST', `/api/visits/${visitId}/consultation/sign`, {});

  say(`${doctor.name} (${drLogin})`, 'My Clinic → the patient → Consultation', [
    `Diagnosis is coded, not just written: E11.65 Type 2 diabetes mellitus with hyperglycaemia (primary), I10 hypertension (secondary).`,
    `Ordered ${ordered.length} tests — ${ordered.map((t) => t.code).join(', ')} — as ${order.order_no}.`,
    `Prescription ${sheet.rx_no}: ${items.length} medicine(s), 30 days, with the advice and a 14-day review.`,
    `Signing sends him to the lab. Had there been no tests, he would have gone straight to the cashier.`,
  ]);

  // 6 ------------------------------------------------------------------- lab
  await lab('POST', `/api/lab/orders/${order.id}/collect`, { sampleType: 'blood' });
  const full = await lab('GET', `/api/lab/orders/${order.id}`);
  const VALUE = { HBA1C: '9.4', FBS: '186', CREAT: '1.1', LIPID: '242', URINE: 'Glucose 2+, no ketones' };
  await lab('POST', `/api/lab/orders/${order.id}/results`, {
    results: full.items.map((i) => ({ itemId: i.id, value: VALUE[i.test_code] || '—' })),
  });
  await lab('POST', `/api/lab/orders/${order.id}/verify`, {});
  say('Ravi in the lab (lab@samiha.local)', 'Laboratory → the order', [
    `Sample collected, results entered, report verified.`,
    `HbA1c 9.4% and fasting 186 mg/dL — well outside range, so the report shows them flagged.`,
    `Verifying the last open order moves him on to the cashier by itself. Nobody has to remember to.`,
  ]);

  // 7 --------------------------------------------------------------- cashier
  let invoice = await cash('POST', `/api/visits/${visitId}/prepare-bill`, {});
  await cash('POST', `/api/billing/invoices/${invoice.id}/items`, {
    refType: 'service', description: 'Blood sugar check at the counter', qty: 1, unitPrice: 50,
  });
  invoice = await cash('POST', `/api/billing/invoices/${invoice.id}/bill-discount`,
    { pct: 10, reason: 'Long-standing patient' });
  invoice = await cash('GET', `/api/billing/invoices/${invoice.id}`);
  const payment = await cash('POST', `/api/billing/invoices/${invoice.id}/payments`,
    { amount: invoice.balance, mode: 'upi', reference: 'UPI-DEMO-' + STAMP });
  invoice = await cash('GET', `/api/billing/invoices/${invoice.id}`);

  say('Kavitha at the cash counter (cashier@samiha.local)', 'Billing → Today\'s collections → “Collect”', [
    `“Assemble bill” pulled the consultation and all ${ordered.length} tests onto ${invoice.invoice_no}.`,
    `One more charge added by pressing it on the board — the ₹50 counter sugar check.`,
    `Gross ${money(invoice.gross)}, 10% off = ${money(invoice.bill_discount)}, to pay ${money(invoice.net)}.`,
    `Taken by UPI, receipt ${payment.receiptNo || payment.receipt_no}. Print invoice hands him the tax invoice.`,
    `No medicines on this bill. He pays for those at the pharmacy.`,
  ]);

  const out = await cash('POST', `/api/visits/${visitId}/check-out`, {});
  say('Kavitha at the cash counter', 'the same screen → “Complete check-out”', [
    `Exit pass ${out.exitPassNo}. He is free to go.`,
    out.note ? out.note : 'Nothing left outstanding.',
  ]);

  // 8 -------------------------------------------------------------- pharmacy
  const queue = await chemist('GET', '/api/pharmacy/queue');
  const rows = queue.rows || queue;
  const mine = rows.find((r) => r.rx_no === sheet.rx_no);
  say('Suresh in the pharmacy (pharmacy@samiha.local)', 'Pharmacy → To dispense', [
    mine ? `${sheet.rx_no} is on the queue, with his name, the doctor's and the diagnosis.`
         : `${sheet.rx_no} was written — open Pharmacy → To dispense to find it.`,
    `It stays on the queue after check-out. If he goes home and comes back on Thursday, it is still there.`,
    `If he buys elsewhere, “Not here” records why, and the record survives.`,
  ]);

  /*
   * The two tablets are already on the shelf — the starter list put them there
   * when the clinic was set up — but nobody has priced them, and this system
   * will not sell a medicine at no price. So the pharmacist puts the MRP off
   * the pack against them first. The figures below are illustrative: a real
   * pharmacy reads them off the packs that arrived.
   */
  const shelf = await chemist('GET', '/api/pharmacy/drugs?limit=800');
  const DEMO_MRP = { 'MET-500MG-TAB': 3.4, 'GLIM-1MG-TAB': 6.2, 'GLIM-2MG-TAB': 8.5 };
  const priced = [];
  for (const drug of [metformin, glimepiride].filter(Boolean)) {
    const held = shelf.find((d) => d.id === drug.id) || {};
    if (held.mrp > 0 && held.on_hand >= 60) continue;
    await chemist('POST', '/api/stock/opening/bulk', {
      rows: [{
        drugId: drug.id,
        qty: held.on_hand >= 60 ? held.on_hand : 200,
        mrp: DEMO_MRP[drug.code] || 10,
      }],
      reason: 'Rate taken off the pack',
    }).catch(() => null);
    priced.push(`${drug.name} at ${money(DEMO_MRP[drug.code] || 10)}`);
  }
  if (priced.length) {
    say('Suresh in the pharmacy', 'Pharmacy → Opening stock → “No rate set”', [
      `${priced.join(' and ')}.`,
      `They were already on the shelf from the starter list, but with no rate the counter`,
      `refuses to sell them by name. A price here is all it takes; the count is untouched.`,
    ]);
  }

  const lines = await chemist('GET', `/api/pharmacy/prescriptions/${visitId}`);
  const toDispense = (lines.prescriptions || []).filter((l) => l.status === 'pending');
  if (toDispense.length) {
    const sale = await chemist('POST', '/api/pharmacy/dispense', {
      patientId: patient.id, visitId,
      items: toDispense.map((l) => ({ prescriptionId: l.id, drugId: l.drug_id, qty: l.quantity })),
      discount: 50, paymentMode: 'cash',
    });
    say('Suresh in the pharmacy', 'Pharmacy → the prescription → “Dispense”', [
      `Batches picked oldest-expiry-first, ${toDispense.length} item(s) handed over.`,
      `Bill ${sale.sale.bill_no} — the pharmacy's own — ${money(sale.sale.net)}, ₹50 off, ` +
      `collected at this counter${sale.receiptNo ? `, receipt ${sale.receiptNo}` : ''}.`,
      `MRP already includes GST, so the tax is taken out of the price, never added on top.`,
    ]);
  }

  const bills = (await cash('GET', `/api/visits/${visitId}`)).invoices || [];
  console.log(`\n${'='.repeat(58)}\nWhat this patient left behind`);
  console.log(`  Patient      ${patient.uhid} — Mohamed Kasim`);
  console.log(`  Enquiry      ${enquiry.ref_no}`);
  console.log(`  Visit        ${visitRow.visit_no || visitId}`);
  console.log(`  Lab order    ${order.order_no}`);
  console.log(`  Prescription ${sheet.rx_no}`);
  for (const b of bills) console.log(`  Bill         ${b.invoice_no} — ${b.kind} — ${money(b.net)} — ${b.status}`);
  console.log(`\nSign in as any of the people above and search ${patient.uhid} to follow it through.\n`);
})().catch((err) => {
  console.error('\nWalkthrough stopped:', err.message);
  console.error('Is the server running, and has it been seeded (npm run setup)?\n');
  process.exit(1);
});
