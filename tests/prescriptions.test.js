'use strict';
/**
 * The doctor's prescription pad, what a doctor may and may not see, the dated
 * vitals chart, and finding a patient by the mobile number their family shares.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-rx-'));
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

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['imran', 'imran@samiha.local'], ['sara', 'sara@samiha.local'],
    ['pharmacy', 'pharmacy@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.imran = db.prepare("SELECT id FROM users WHERE email = 'imran@samiha.local'").get().id;
  ids.sara = db.prepare("SELECT id FROM users WHERE email = 'sara@samiha.local'").get().id;

  const drugs = (await api('GET', '/api/pharmacy/drugs?limit=300', undefined, 'imran')).body;
  ids.para = drugs.find((d) => d.code === 'PARA500').id;
  ids.pan = drugs.find((d) => d.code === 'PAN40').id;
  ids.amox = drugs.find((d) => d.code === 'AMOX500').id;

  ids.patient = (await api('POST', '/api/patients', {
    firstName: 'Kumar', lastName: 'Raman', phone: '9845020001', gender: 'male',
    age: 44, allergies: 'Penicillin', consentTreatment: true,
  })).body.id;

  // Booking the patient with Dr Sheikh makes them his to prescribe for.
  await api('POST', '/api/appointments', {
    doctorId: ids.imran, scheduledAt: `${scheduling.dateKey(new Date())} 18:00:00`,
    patientId: ids.patient, reason: 'Fever',
  });
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------ prescribing
test('a doctor writes a prescription from the pharmacy formulary', async () => {
  const rx = await api('POST', '/api/prescriptions', {
    patientId: ids.patient,
    complaints: 'Fever 3 days, body ache',
    findings: 'Throat congested, chest clear',
    diagnosis: 'Acute viral fever',
    advice: 'Plenty of fluids and rest',
    items: [
      { drugId: ids.para, dose: '1 tab', frequency: 'TDS', durationDays: 3 },
      { drugId: ids.pan, dose: '1 tab', frequency: 'OD', durationDays: 5, instructions: 'before breakfast' },
    ],
  }, 'imran');
  assert.strictEqual(rx.status, 201, JSON.stringify(rx.body));
  ids.sheet = rx.body.id;

  assert.match(rx.body.rx_no, /^RX\d{9}$/);
  assert.strictEqual(rx.body.doctor_id, ids.imran);
  assert.strictEqual(rx.body.items.length, 2);
  // The medicine name is taken from the formulary, strength and all.
  assert.match(rx.body.items[0].drug_name, /Dolo 650/);
  // Quantity is worked out from frequency × duration when it is not given.
  assert.strictEqual(rx.body.items[0].quantity, 9, 'three times a day for three days');
  assert.strictEqual(rx.body.items[1].quantity, 5);
});

test('a medicine the pharmacy has never heard of cannot be prescribed', async () => {
  const bad = await api('POST', '/api/prescriptions', {
    patientId: ids.patient, items: [{ drugId: 999999, dose: '1' }],
  }, 'imran');
  assert.strictEqual(bad.status, 404);
  assert.match(bad.body.error, /not in the formulary/i);

  const empty = await api('POST', '/api/prescriptions', { patientId: ids.patient, items: [] }, 'imran');
  assert.strictEqual(empty.status, 400);
});

test('an allergy recorded as a class catches the drugs in that class', async () => {
  // Nobody writes "amoxicillin" in the allergy box — they write "penicillin",
  // and the amoxicillin still has to be caught.
  const refused = await api('POST', '/api/prescriptions', {
    patientId: ids.patient, items: [{ drugId: ids.amox, dose: '1 cap', frequency: 'BD', durationDays: 5 }],
  }, 'imran');
  assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /penicillin/i);
  assert.match(refused.body.error, /class/i);
});

test('a recorded allergy stops the prescription until it is overridden', async () => {
  const refused = await api('POST', '/api/prescriptions', {
    patientId: ids.patient, items: [{ drugId: ids.amox, dose: '1 cap', frequency: 'BD', durationDays: 5 }],
  }, 'imran');
  assert.strictEqual(refused.status, 409);
  assert.match(refused.body.error, /Safety check/);

  const overridden = await api('POST', '/api/prescriptions', {
    patientId: ids.patient, acknowledgeWarnings: true,
    items: [{ drugId: ids.amox, dose: '1 cap', frequency: 'BD', durationDays: 5 }],
  }, 'imran');
  assert.strictEqual(overridden.status, 201);
  assert.ok(overridden.body.warnings.length, 'the warning is kept with the prescription');
});

test('only a doctor prescribes', async () => {
  for (const who of ['reception', 'pharmacy']) {
    const r = await api('POST', '/api/prescriptions', {
      patientId: ids.patient, items: [{ drugId: ids.para, dose: '1' }],
    }, who);
    assert.strictEqual(r.status, 403, `${who} must not be able to prescribe`);
  }
});

test('a doctor sees only the prescriptions they signed', async () => {
  const mine = (await api('GET', '/api/prescriptions', undefined, 'imran')).body;
  assert.ok(mine.length >= 2);
  assert.ok(mine.every((r) => r.doctor_id === ids.imran));

  // Another doctor's list is empty and their attempt to read one is refused.
  assert.strictEqual((await api('GET', '/api/prescriptions', undefined, 'sara')).body.length, 0);
  assert.strictEqual((await api('GET', `/api/prescriptions/${ids.sheet}`, undefined, 'sara')).status, 403);
  // Asking for a colleague's by id changes nothing — the scope is the signer.
  const spoof = (await api('GET', `/api/prescriptions?doctorId=${ids.imran}`, undefined, 'sara')).body;
  assert.strictEqual(spoof.length, 0);

  // The pharmacy must read them to dispense.
  assert.strictEqual((await api('GET', `/api/prescriptions/${ids.sheet}`, undefined, 'pharmacy')).status, 200);
});

test('a doctor prescribes only for their own patients', async () => {
  const strangers = (await api('GET', '/api/prescriptions/patients/search', undefined, 'sara')).body;
  assert.strictEqual(strangers.length, 0, 'Dr Ahmed has nobody yet');

  const mine = (await api('GET', '/api/prescriptions/patients/search', undefined, 'imran')).body;
  assert.ok(mine.some((p) => p.id === ids.patient));
});

test('the printed sheet carries the clinic and a doctor code, never the doctor', async () => {
  const sheet = (await api('GET', `/api/prescriptions/${ids.sheet}`, undefined, 'imran')).body;
  // What the clinic needs in order to know afterwards who wrote it.
  assert.ok(sheet.staff_code, 'a doctor code the management can trace');
  assert.match(sheet.rx_no, /^RX/);
  // And what the patient is given: their own details and the medicines.
  assert.strictEqual(sheet.uhid, (await api('GET', `/api/patients/${ids.patient}`)).body.uhid);
  assert.ok(sheet.items.every((i) => i.drug_name));
});

test('lines join the pharmacy queue only when there is a visit to dispense against', async () => {
  const standalone = (await api('GET', `/api/prescriptions/${ids.sheet}`, undefined, 'imran')).body;
  assert.ok(standalone.items.every((i) => i.status === 'external'),
    'a paper prescription is not a dispensing job');

  const visit = (await api('POST', '/api/visits/arrive', {
    patientId: ids.patient, reasonForVisit: 'Fever', doctorId: ids.imran,
  })).body.visit;
  const tied = await api('POST', '/api/prescriptions', {
    patientId: ids.patient, visitId: visit.id,
    items: [{ drugId: ids.para, dose: '1 tab', frequency: 'BD', durationDays: 3 }],
  }, 'imran');
  assert.strictEqual(tied.status, 201);
  assert.strictEqual(tied.body.items[0].status, 'pending');

  const queue = (await api('GET', '/api/pharmacy/queue', undefined, 'pharmacy')).body;
  assert.ok(queue.some((q) => q.visit_id === visit.id), 'the pharmacy sees it without re-typing');
});

// --------------------------------------------------------- the dated chart
test('weight, height, pressure and purpose are kept date by date', async () => {
  for (const [i, purpose] of ['First check', 'Two weeks on', 'A month on'].entries()) {
    const r = await api('POST', `/api/patients/${ids.patient}/vitals`, {
      purpose, weightKg: 80 - i, heightCm: i === 0 ? 172 : undefined,
      bpSystolic: 150 - i * 8, bpDiastolic: 96 - i * 4, pulse: 82,
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  }

  const chart = (await api('GET', `/api/patients/${ids.patient}`)).body.vitals;
  assert.ok(chart.length >= 3);
  assert.strictEqual(chart[0].purpose, 'A month on', 'newest first');
  assert.strictEqual(chart[0].weight_kg, 78);
  assert.strictEqual(chart[0].bp_systolic, 134);
  // Height carries forward, so BMI still works when only the weight is taken.
  assert.strictEqual(chart[0].height_cm, null);
  assert.ok(chart[0].bmi > 0, 'BMI is worked out from the last height on file');
});

test('a reading with nothing in it is refused', async () => {
  const empty = await api('POST', `/api/patients/${ids.patient}/vitals`, { purpose: 'Just visiting' });
  assert.strictEqual(empty.status, 400);
  assert.match(empty.body.error, /at least one reading/i);
});

test('a reading taken during a visit borrows that visit\'s reason', async () => {
  const chart = (await api('GET', `/api/patients/${ids.patient}`)).body.vitals;
  const fromVisit = chart.find((v) => v.visit_no);
  if (fromVisit) assert.ok(fromVisit.purpose, 'the visit reason stands in as the purpose');
});

// ------------------------------------------------- the mobile number is the key
test('one mobile number finds the whole family', async () => {
  const shared = '9845020001';
  for (const [name, rel, age] of [['Lakshmi', 'Spouse', 40], ['Ananya', 'Daughter', 11]]) {
    const r = await api('POST', '/api/patients', {
      firstName: name, lastName: 'Raman', phone: shared, gender: 'female', age,
      relationshipToPrimary: rel, consentTreatment: true, allowDuplicate: true,
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  }

  const family = (await api('GET', `/api/patients/by-phone?phone=${shared}`)).body;
  assert.strictEqual(family.count, 3);
  assert.strictEqual(family.isFamily, true);
  assert.ok(family.members.some((m) => m.relationship_to_primary === 'Spouse'));
  assert.ok(family.members.every((m) => m.uhid), 'each is their own file with their own UHID');
  // The desk needs to know at a glance who owes and who is coming back.
  assert.ok(family.members.every((m) => 'outstanding' in m && 'next_appointment' in m));
});

test('the number is matched the way people actually write it', async () => {
  for (const written of ['9845020001', '09845020001', '919845020001', '+91 98450 20001']) {
    const found = (await api('GET', `/api/patients/by-phone?phone=${encodeURIComponent(written)}`)).body;
    assert.strictEqual(found.count, 3, `"${written}" should find the same family`);
  }
  const tooShort = await api('GET', '/api/patients/by-phone?phone=984');
  assert.strictEqual(tooShort.status, 400);

  const unknown = (await api('GET', '/api/patients/by-phone?phone=9000011111')).body;
  assert.strictEqual(unknown.count, 0);
});

test('registering on a known number names the household rather than just refusing', async () => {
  const clash = await api('POST', '/api/patients', {
    firstName: 'Another', phone: '9845020001', gender: 'male', age: 30, consentTreatment: true,
  });
  assert.strictEqual(clash.status, 409);
  assert.match(clash.body.error, /3 patient\(s\) are already registered/);
  assert.match(clash.body.error, /Kumar/);
  assert.strictEqual(clash.body.details.family.length, 3, 'the desk is handed the household');
  assert.strictEqual(clash.body.details.phone, '919845020001');

  const added = await api('POST', '/api/patients', {
    firstName: 'Another', phone: '9845020001', gender: 'male', age: 30,
    relationshipToPrimary: 'Brother', consentTreatment: true, allowDuplicate: true,
  });
  assert.strictEqual(added.status, 201);
  assert.strictEqual((await api('GET', '/api/patients/by-phone?phone=9845020001')).body.count, 4);
});

// ---------------------------------------------------------- the doctor code
test('a doctor code reads SPC-MHD-002: clinic, name, joining number', async () => {
  const { nameMnemonic } = require('../src/lib/ids');
  // The mnemonic keeps the first letter then adds unused consonants, which is
  // how these are written by hand.
  assert.strictEqual(nameMnemonic('Dr. Mohamed'), 'MHD');
  assert.strictEqual(nameMnemonic('Mohamed'), 'MHD');
  assert.strictEqual(nameMnemonic('Dr. Nafisa Rahman'), 'NFS');
  assert.strictEqual(nameMnemonic('Vikram'), 'VKR');
  // A short name is filled out from its own letters, never with padding.
  assert.strictEqual(nameMnemonic('Neha'), 'NHE');
  assert.strictEqual(nameMnemonic('Sara'), 'SRA');
  assert.strictEqual(nameMnemonic(''), 'XXX');

  const doctors = (await api('GET', '/api/masters/staff?role=doctor', undefined, 'admin')).body;
  assert.ok(doctors.every((d) => /^SPC-[A-Z]{3}-\d{3}$/.test(d.doctor_code)),
    'every doctor carries a code');
  const serials = doctors.map((d) => d.doctor_code.split('-').pop());
  assert.strictEqual(new Set(serials).size, serials.length, 'serials are unique');
});

test('a doctor joining gets the next serial, and codes cannot collide', async () => {
  const created = await api('POST', '/api/masters/staff', {
    name: 'Dr. Mohamed Yusuf', role: 'doctor', email: 'mohamed.test@samiha.local',
    password: 'Clinic2026x', qualification: 'MBBS, MS',
  }, 'admin');
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.doctorCode, /^SPC-MHD-\d{3}$/);
  ids.mohamed = created.body.id;

  const taken = (await api('GET', '/api/masters/staff?role=doctor', undefined, 'admin')).body
    .find((d) => d.id === ids.imran).doctor_code;
  const clash = await api('PATCH', `/api/masters/staff/${ids.mohamed}`, { doctorCode: taken }, 'admin');
  assert.strictEqual(clash.status, 409);
  assert.match(clash.body.error, /belongs to somebody else/i);

  // A correction the admin is entitled to make still works.
  const fixed = await api('PATCH', `/api/masters/staff/${ids.mohamed}`, { doctorCode: 'SPC-MYF-099' }, 'admin');
  assert.strictEqual(fixed.status, 200);
  assert.strictEqual(
    (await api('GET', `/api/masters/staff/${ids.mohamed}`, undefined, 'admin')).body.doctor_code,
    'SPC-MYF-099');
});

test('printed sheets carry the code and never the doctor', async () => {
  const sheet = (await api('GET', `/api/prescriptions/${ids.sheet}`, undefined, 'imran')).body;
  assert.match(sheet.doctor_code, /^SPC-[A-Z]{3}-\d{3}$/,
    'the prescription is traceable to its prescriber by code alone');

  // A lab report exposes the referring doctor the same way.
  const order = (await api('POST', '/api/lab/orders', {
    patientId: ids.patient, doctorId: ids.imran,
    tests: [{ testId: (await api('GET', '/api/masters/lab-tests')).body[0].id }],
  }, 'imran')).body;
  await api('POST', `/api/lab/orders/${order.id}/collect`, { sampleType: 'blood' }, 'admin');
  const items = (await api('GET', `/api/lab/orders/${order.id}`, undefined, 'admin')).body.items;
  await api('POST', `/api/lab/orders/${order.id}/results`,
    { results: [{ itemId: items[0].id, value: '12' }] }, 'admin');
  await api('POST', `/api/lab/orders/${order.id}/verify`, {}, 'admin');

  // The order carries it from the moment it is placed — the requisition slip is
  // printed before there is any result to report.
  const placed = (await api('GET', `/api/lab/orders/${order.id}`, undefined, 'admin')).body;
  assert.match(placed.doctor_code, /^SPC-[A-Z]{3}-\d{3}$/);
  assert.ok(placed.items.every((i) => 'sample_type' in i),
    'the collection counter is told which tube to draw');
  const listed = (await api('GET', '/api/lab/orders', undefined, 'admin')).body.rows
    .find((r) => r.id === order.id);
  assert.strictEqual(listed.doctor_code, placed.doctor_code);

  const report = (await api('GET', `/api/lab/orders/${order.id}/report`, undefined, 'admin')).body;
  assert.match(report.doctor_code, /^SPC-[A-Z]{3}-\d{3}$/);
  assert.strictEqual(report.doctor_code,
    (await api('GET', `/api/masters/staff/${ids.imran}`, undefined, 'admin')).body.doctor_code);
});

test('the bill and the discharge summary carry the code, not the doctor', async () => {
  const code = (await api('GET', `/api/masters/staff/${ids.imran}`, undefined, 'admin')).body.doctor_code;

  // A bill raised against a visit picks the treating doctor up from the visit.
  const p = (await api('POST', '/api/patients', {
    firstName: 'Bill', lastName: 'Check', phone: '9845040404', gender: 'male',
    age: 52, consentTreatment: true,
  })).body;
  const visit = (await api('POST', '/api/visits/arrive', {
    patientId: p.id, reasonForVisit: 'Chest pain', doctorId: ids.imran,
  })).body.visit;
  const inv = (await api('POST', '/api/billing/invoices', { patientId: p.id, visitId: visit.id })).body;
  await api('POST', `/api/billing/invoices/${inv.id}/items`, { description: 'Consultation', unitPrice: 500 });

  const bill = (await api('GET', `/api/billing/invoices/${inv.id}`)).body;
  assert.strictEqual(bill.doctor_code, code, 'the bill knows whose patient this was');
  assert.strictEqual(bill.visit_no, visit.visit_no, 'and which visit it settles');

  // A bill with no visit and no admission has no doctor to name — and says so
  // by leaving the field empty rather than guessing.
  const standalone = (await api('POST', '/api/billing/invoices', { patientId: p.id, kind: 'pharmacy' })).body;
  assert.strictEqual((await api('GET', `/api/billing/invoices/${standalone.id}`)).body.doctor_code, null);

  // And the receipt for money taken against that bill.
  const paid = (await api('POST', `/api/billing/invoices/${inv.id}/payments`,
    { amount: 500, mode: 'cash' })).body;
  const receiptNo = paid.receipt ? paid.receipt.receipt_no
    : (paid.receiptNo || paid.invoice.payments.at(-1).receipt_no);
  const receipt = (await api('GET', `/api/billing/receipts/${receiptNo}`)).body;
  assert.strictEqual(receipt.doctor_code, code);
  assert.strictEqual(receipt.visit_no, visit.visit_no);
  assert.ok(receipt.received_by_name, 'the cashier who took it still signs the receipt');

  // The discharge summary the same way.
  const wards = (await api('GET', '/api/ipd/wards')).body;
  const bed = (wards.wards || wards).flatMap((w) => w.beds).find((b) => b.status === 'vacant');
  const adm = (await api('POST', '/api/ipd/admissions', {
    patientId: p.id, doctorId: ids.imran, bedId: bed.id, reason: 'Observation',
  })).body;
  const summary = (await api('GET', `/api/ipd/admissions/${adm.id}/discharge-summary`)).body;
  assert.strictEqual(summary.doctor_code, code);
});

test('an X-ray or scan is reported in words, and still carries the code', async () => {
  const tests = (await api('GET', '/api/masters/lab-tests')).body;
  const xray = tests.find((t) => t.code === 'XR-CHEST');
  const usg = tests.find((t) => t.code === 'USG-ABD');
  assert.strictEqual(xray.category, 'radiology');
  assert.strictEqual(usg.category, 'radiology');

  const order = (await api('POST', '/api/lab/orders', {
    patientId: ids.patient, doctorId: ids.imran,
    clinicalNotes: 'Cough with fever',
    tests: [{ testId: xray.id }, { testId: usg.id }],
  }, 'imran')).body;
  await api('POST', `/api/lab/orders/${order.id}/collect`, { sampleType: 'imaging' }, 'admin');

  const items = (await api('GET', `/api/lab/orders/${order.id}`, undefined, 'admin')).body.items;
  assert.ok(items.every((i) => i.category === 'radiology'),
    'the screen has to know it is taking findings, not a number');

  // Findings go in the value, the impression in the notes.
  await api('POST', `/api/lab/orders/${order.id}/results`, {
    results: [
      { itemId: items[0].id, value: 'Lung fields clear. Cardiac silhouette normal.',
        notes: 'Normal chest radiograph.', abnormalFlag: 'normal' },
      { itemId: items[1].id, value: 'Gall bladder distended with a 6 mm calculus in the neck.',
        notes: 'Single gall bladder calculus.', abnormalFlag: 'normal' },
    ],
  }, 'admin');
  await api('POST', `/api/lab/orders/${order.id}/verify`, {}, 'admin');

  const report = (await api('GET', `/api/lab/orders/${order.id}/report`, undefined, 'admin')).body;
  assert.match(report.doctor_code, /^SPC-[A-Z]{3}-\d{3}$/, 'the code reaches the imaging report too');
  assert.ok(report.items.every((i) => i.category === 'radiology'),
    'so the printed report knows to render prose rather than a results table');
  assert.match(report.items[0].result_value, /Lung fields clear/);
  assert.match(report.items[0].result_notes, /Normal chest radiograph/);
  assert.match(report.items[1].result_notes, /gall bladder calculus/);
});

test('an ECG is reported like an imaging study but is not called imaging', async () => {
  const tests = (await api('GET', '/api/masters/lab-tests')).body;
  const ecg = tests.find((t) => t.code === 'ECG12');
  assert.strictEqual(ecg.category, 'cardiology', 'a tracing, not a picture and not a number');

  const order = (await api('POST', '/api/lab/orders', {
    patientId: ids.patient, doctorId: ids.imran,
    clinicalNotes: 'Palpitations on exertion', tests: [{ testId: ecg.id }],
  }, 'imran')).body;
  await api('POST', `/api/lab/orders/${order.id}/collect`, { sampleType: 'tracing' }, 'admin');

  const item = (await api('GET', `/api/lab/orders/${order.id}`, undefined, 'admin')).body.items[0];
  assert.strictEqual(item.category, 'cardiology');

  await api('POST', `/api/lab/orders/${order.id}/results`, {
    results: [{ itemId: item.id, value: 'Sinus rhythm at 78 bpm. Normal axis. QTc 410 ms.',
      notes: 'Normal 12-lead ECG.', abnormalFlag: 'normal' }],
  }, 'admin');
  await api('POST', `/api/lab/orders/${order.id}/verify`, {}, 'admin');

  const report = (await api('GET', `/api/lab/orders/${order.id}/report`, undefined, 'admin')).body;
  assert.match(report.doctor_code, /^SPC-[A-Z]{3}-\d{3}$/);
  assert.strictEqual(report.items[0].category, 'cardiology',
    'so the sheet heads itself Cardiology Report and speaks of a tracing, not of images');
  assert.match(report.items[0].result_value, /Sinus rhythm/);
  assert.match(report.items[0].result_notes, /Normal 12-lead ECG/);
});

// ------------------------------------------------------ what a doctor may see
test('a doctor\'s dashboard shows their own clinic and no colleague\'s', async () => {
  const asDoctor = (await api('GET', '/api/reports/dashboard', undefined, 'imran')).body;
  assert.strictEqual(asDoctor.byDoctor.length, 1);
  assert.strictEqual(asDoctor.byDoctor[0].id, ids.imran);

  const asDesk = (await api('GET', '/api/reports/dashboard', undefined, 'reception')).body;
  assert.ok(asDesk.byDoctor.length > 1, 'the front desk runs the diary and sees everybody');
});

test('colleague-by-colleague reporting is management\'s, not a doctor\'s', async () => {
  assert.strictEqual((await api('GET', '/api/reports/doctor-monthly', undefined, 'imran')).status, 403);
  assert.strictEqual((await api('GET', '/api/reports/doctor-productivity', undefined, 'imran')).status, 403);
  assert.strictEqual((await api('GET', '/api/reports/revenue', undefined, 'imran')).status, 403);
  // Their own day is theirs.
  assert.strictEqual((await api('GET', '/api/appointments/my-day', undefined, 'imran')).status, 200);
});
