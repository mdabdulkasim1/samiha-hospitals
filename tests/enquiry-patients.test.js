'use strict';
/**
 * Enquiry patients: everyone who makes contact gets a record at the 'enquiry'
 * stage, which becomes a registered patient when they turn up. Plus the admin
 * management of doctors and their OPD sessions.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-enq-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
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
    ['nurse', 'nurse@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.gen = (await api('GET', '/api/masters/departments?kind=specialist', undefined, 'admin')).body[0].id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('logging an enquiry opens a patient record at the enquiry stage', async () => {
  const enq = await api('POST', '/api/enquiries', {
    source: 'phone', name: 'Salma Rehman', phone: '9812340001',
    subject: 'Wants a dermatology appointment',
  }, 'reception');
  assert.strictEqual(enq.status, 201, JSON.stringify(enq.body));
  assert.ok(enq.body.patient, 'the enquiry should carry a patient record');
  assert.strictEqual(enq.body.patient.stage, 'enquiry');
  assert.match(enq.body.patient.uhid, /^SPD/);
  assert.strictEqual(enq.body.patient.first_name, 'Salma');
  assert.strictEqual(enq.body.patient.last_name, 'Rehman');
  assert.ok(enq.body.patient.enquiry_at, 'the first-contact time is stamped');
  ids.salma = enq.body.patient.id;

  // It shows under the enquiry filter, not the registered one.
  const enquiries = await api('GET', '/api/patients?stage=enquiry', undefined, 'reception');
  assert.ok(enquiries.body.rows.some((p) => p.id === ids.salma));
  const registered = await api('GET', '/api/patients?stage=registered', undefined, 'reception');
  assert.ok(!registered.body.rows.some((p) => p.id === ids.salma));

  // The two populations are counted separately.
  assert.ok(enquiries.body.counts.enquiry >= 1);
  assert.ok(enquiries.body.counts.registered >= 5, 'the seeded patients are registered');
});

test('a second enquiry from the same number links to the same record', async () => {
  const again = await api('POST', '/api/enquiries', {
    source: 'whatsapp', name: 'Salma R', phone: '9812340001', subject: 'Asking about timings',
  }, 'reception');
  assert.strictEqual(again.status, 201);
  assert.strictEqual(again.body.patient.id, ids.salma, 'no second file for the same person');

  const list = await api('GET', '/api/patients?q=Salma', undefined, 'reception');
  assert.strictEqual(list.body.rows.length, 1, 'exactly one record for this caller');
  assert.strictEqual(list.body.rows[0].enquiry_source, 'phone', 'the first contact channel is kept');
});

test('an enquiry cannot be sent through to the clinic queue', async () => {
  const arrive = await api('POST', '/api/visits/arrive', {
    patientId: ids.salma, reasonForVisit: 'Rash on both arms',
  }, 'reception');
  assert.strictEqual(arrive.status, 409);
  assert.match(arrive.body.error, /still an enquiry/);
  assert.match(arrive.body.error, /registration paperwork/);
});

test('registering an enquiry patient promotes the same record', async () => {
  const before = (await api('GET', `/api/patients/${ids.salma}`, undefined, 'reception')).body;

  // Consent is not optional — registration is refused without it.
  const noConsent = await api('POST', `/api/patients/${ids.salma}/register`, {
    firstName: 'Salma', gender: 'female', age: 29,
  }, 'reception');
  assert.strictEqual(noConsent.status, 400);
  assert.match(noConsent.body.error, /Consent to treatment/);

  const reg = await api('POST', `/api/patients/${ids.salma}/register`, {
    firstName: 'Salma', lastName: 'Rehman', gender: 'female', sexAtBirth: 'female',
    dob: '1996-04-12', phone: '9812340001', email: 'salma@example.test',
    address: '14 Anna Salai', city: 'Chennai', state: 'Tamil Nadu', pincode: '600002',
    emergencyName: 'Nadia Rehman', emergencyPhone: '9812340002', emergencyRelation: 'Sister',
    bloodGroup: 'B+', occupation: 'Teacher', maritalStatus: 'Married',
    insuranceProvider: 'Star Health', insurancePolicyNo: 'SH-4411',
    billingAddress: '14 Anna Salai, Chennai 600002', isUninsured: false,
    presentingComplaint: 'Itchy rash on both arms for two weeks',
    allergies: 'Dust', chronicConditions: 'Eczema',
    currentMedications: 'Cetirizine 10 mg at night, Vitamin D weekly',
    immunisations: 'Childhood schedule complete; Td booster 2021',
    smokingStatus: 'never', alcoholUse: 'never',
    pastIllness: 'Eczema since childhood', surgeries: 'Appendicectomy, 2014',
    familyHistory: 'Mother has asthma', socialHistory: 'Lives with family, non-smoker',
    consentTreatment: true, consentPrivacy: true, consentContact: true,
    consentSignedBy: 'Salma Rehman',
    vitals: { heightCm: 160, weightKg: 58, tempC: 36.9, pulse: 78, bpSystolic: 118, bpDiastolic: 76 },
    history: [{ kind: 'past_illness', detail: 'Eczema, 2019' }],
  }, 'reception');
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
  assert.strictEqual(reg.body.patient.stage, 'registered');
  assert.strictEqual(reg.body.patient.id, ids.salma, 'the same row is promoted, not replaced');
  assert.strictEqual(reg.body.patient.uhid, before.uhid, 'the UHID does not change');
  assert.strictEqual(reg.body.patient.allergies, 'Dust');

  // The full dataset the clinic asked for is on the record.
  const p = reg.body.patient;
  assert.strictEqual(p.sex_at_birth, 'female');
  assert.strictEqual(p.dob, '1996-04-12');
  assert.strictEqual(p.emergency_name, 'Nadia Rehman');
  assert.strictEqual(p.insurance_provider, 'Star Health');
  assert.strictEqual(p.billing_address, '14 Anna Salai, Chennai 600002');
  assert.match(p.presenting_complaint, /Itchy rash/);
  assert.match(p.current_medications, /Cetirizine/);
  assert.match(p.immunisations, /Td booster/);
  assert.strictEqual(p.smoking_status, 'never');
  assert.strictEqual(p.alcohol_use, 'never');
  assert.strictEqual(p.consent_treatment, 1);
  assert.strictEqual(p.consent_privacy, 1);
  assert.strictEqual(p.consent_signed_by, 'Salma Rehman');
  assert.ok(p.consent_signed_at, 'the consent is timestamped');
  // Age is derived from the date of birth when both could apply.
  assert.ok(p.age_years >= 28 && p.age_years <= 31, `age derived from DOB, got ${p.age_years}`);

  // Baseline observations taken at the desk are on file against the patient.
  assert.strictEqual(reg.body.baselineVitalsRecorded, true);

  // The enquiries that brought them in are closed off as converted.
  const enquiries = await api('GET', '/api/enquiries?status=converted', undefined, 'reception');
  const theirs = enquiries.body.rows.filter((e) => e.patient_id === ids.salma);
  assert.strictEqual(theirs.length, 2, 'both enquiries from this caller are converted');

  // The medical history taken at registration is on file, by category.
  const after = (await api('GET', `/api/patients/${ids.salma}`, undefined, 'reception')).body;
  const kinds = after.history.map((h) => h.kind);
  for (const kind of ['past_illness', 'surgery', 'family', 'social', 'allergy', 'immunisation']) {
    assert.ok(kinds.includes(kind), `${kind} history should be recorded`);
  }
  assert.ok(after.vitals.length >= 1, 'the baseline vitals are on the record');
  assert.strictEqual(after.vitals[0].bmi, 22.7, 'BMI is computed from the baseline height and weight');

  // Now they can be sent through.
  const arrive = await api('POST', '/api/visits/arrive', {
    patientId: ids.salma, reasonForVisit: 'Rash on both arms',
  }, 'reception');
  assert.strictEqual(arrive.status, 201, JSON.stringify(arrive.body));
});

test('registering an already-registered patient is refused', async () => {
  const again = await api('POST', `/api/patients/${ids.salma}/register`,
    { firstName: 'Salma', consentTreatment: true }, 'reception');
  assert.strictEqual(again.status, 409);
  assert.match(again.body.error, /already a registered patient/);
});

test('a WhatsApp booking by an unknown caller opens an enquiry record', async () => {
  const scheduling = require('../src/services/scheduling');
  const from = '919812340077';
  const say = async (text) =>
    (await api('POST', '/api/whatsapp/simulate', { from, text }, 'reception')).body;

  const doctors = (await api('GET', '/api/masters/staff?role=doctor', undefined, 'reception')).body;
  const first = doctors.find((d) => d.email === 'imran@samiha.local');
  const open = scheduling.nextAvailableDates(first.id, 1)[0];
  const slot = scheduling.availableSlots(first.id, open.date)[0];

  await say('Hi');
  await say('1');              // book
  await say('1');              // first department (Internal Medicine)
  await say('1');              // first doctor
  await say(open.date);        // typed date
  await say(slot);             // typed time
  await say('NO');             // not registered with us
  await say('9812340077');     // contact number
  await say('Imtiaz Khan');
  await say('38 male');
  const done = await say('YES');
  assert.match(done.reply, /Your appointment is booked/);

  const list = await api('GET', '/api/patients?q=Imtiaz', undefined, 'reception');
  assert.strictEqual(list.body.rows.length, 1);
  const p = list.body.rows[0];
  assert.strictEqual(p.stage, 'enquiry', 'a WhatsApp booking is a lead until they turn up');
  assert.strictEqual(p.age_years, 38);
  assert.strictEqual(p.gender, 'male');
  assert.strictEqual(p.enquiry_source, 'whatsapp');

  // The appointment is attached to the record, not floating on a loose name.
  const appts = await api('GET', '/api/appointments?status=confirmed', undefined, 'reception');
  const theirs = appts.body.rows.find((a) => a.patient_id === p.id);
  assert.ok(theirs, 'the booking is linked to the enquiry record');
  assert.strictEqual(theirs.visit_kind, 'new');
});

test('the dashboard separates enquiry and registered patients', async () => {
  const d = await api('GET', '/api/reports/dashboard', undefined, 'admin');
  assert.strictEqual(d.status, 200);
  assert.ok(d.body.patients, 'the dashboard reports both populations');
  assert.ok(d.body.patients.enquiry >= 1);
  assert.ok(d.body.patients.registered >= 6);
  assert.ok(d.body.patients.convertedFromEnquiry >= 1, 'conversions are counted');
});

test('both the front desk and an administrator can register a patient', async () => {
  for (const [as, name] of [['reception', 'Desk'], ['admin', 'Admin']]) {
    const r = await api('POST', '/api/patients', {
      firstName: `${name}Made`, lastName: 'Patient', gender: 'male', age: 40,
      phone: `95${String(Date.now()).slice(-8)}${as === 'admin' ? '' : ''}`,
      consentTreatment: true, consentPrivacy: true, allowDuplicate: true,
    }, as);
    assert.strictEqual(r.status, 201, `${as} should be able to register: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.stage, 'registered');
  }

  // A nurse still cannot.
  const denied = await api('POST', '/api/patients',
    { firstName: 'Nope', consentTreatment: true }, 'nurse');
  assert.strictEqual(denied.status, 403);
});

test('recording an insurer clears the uninsured flag', async () => {
  const r = await api('POST', '/api/patients', {
    firstName: 'Covered', lastName: 'Person', gender: 'male', age: 44,
    phone: '9812349999', consentTreatment: true,
    // The desk left "uninsured" ticked but filled in the policy anyway.
    isUninsured: true, insuranceProvider: 'Niva Bupa', insurancePolicyNo: 'NB-1234',
  }, 'reception');
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.is_uninsured, 0,
    'an insurer on file must win over a stale uninsured tick');
  assert.strictEqual(r.body.insurance_provider, 'Niva Bupa');

  // With no insurer, the tick stands.
  const selfPay = await api('POST', '/api/patients', {
    firstName: 'Self', lastName: 'Pay', gender: 'female', age: 33,
    phone: '9812349998', consentTreatment: true, isUninsured: true,
  }, 'reception');
  assert.strictEqual(selfPay.body.is_uninsured, 1);
});

test('an administrator can add a doctor with full details', async () => {
  const created = await api('POST', '/api/masters/staff', {
    name: 'Dr. Farah Naaz', email: 'farah@samiha.local', phone: '9812340055',
    role: 'doctor', departmentId: ids.gen, password: 'Doctor2026x',
    qualification: 'MBBS, MD (Medicine)', specialization: 'Rheumatology',
    regNo: 'TN/60011', consultFee: 700, followUpFee: 400, slotMinutes: 20, roomNo: 'OPD-7',
  }, 'admin');
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  ids.farah = created.body.id;

  const detail = await api('GET', `/api/masters/staff/${ids.farah}`, undefined, 'admin');
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.body.consult_fee, 700);
  assert.strictEqual(detail.body.specialization, 'Rheumatology');
  assert.strictEqual(detail.body.slot_minutes, 20);
  assert.ok(Array.isArray(detail.body.sessions));

  // The new doctor is immediately bookable.
  const doctors = await api('GET', '/api/masters/staff?role=doctor', undefined, 'reception');
  assert.ok(doctors.body.some((d) => d.id === ids.farah));

  // A nurse cannot add staff.
  const denied = await api('POST', '/api/masters/staff',
    { name: 'X', role: 'doctor', password: 'Whatever2026' }, 'nurse');
  assert.strictEqual(denied.status, 403);
});

test('OPD sessions can be added, must not overlap, and drive availability', async () => {
  const monday = await api('POST', `/api/masters/doctors/${ids.farah}/schedule`, {
    weekday: 1, startTime: '10:00', endTime: '13:00', slotMinutes: 20, maxTokens: 9,
  }, 'admin');
  assert.strictEqual(monday.status, 201, JSON.stringify(monday.body));

  // Overlapping the same morning is refused.
  const clash = await api('POST', `/api/masters/doctors/${ids.farah}/schedule`, {
    weekday: 1, startTime: '12:00', endTime: '14:00',
  }, 'admin');
  assert.strictEqual(clash.status, 409);
  assert.match(clash.body.error, /overlaps an existing session/);

  // A back-to-back session is fine.
  const evening = await api('POST', `/api/masters/doctors/${ids.farah}/schedule`, {
    weekday: 1, startTime: '17:00', endTime: '19:00',
  }, 'admin');
  assert.strictEqual(evening.status, 201);

  // An end before the start is nonsense.
  const backwards = await api('POST', `/api/masters/doctors/${ids.farah}/schedule`, {
    weekday: 2, startTime: '15:00', endTime: '09:00',
  }, 'admin');
  assert.strictEqual(backwards.status, 400);

  // The sessions produce bookable slots on a Monday.
  const dates = (await api('GET', `/api/appointments/availability?doctorId=${ids.farah}&count=20`,
    undefined, 'reception')).body.dates;
  assert.ok(dates.length > 0, 'the new sessions should open days for booking');
  const monday1 = dates.find((d) => new Date(d.date + 'T00:00:00').getDay() === 1);
  assert.ok(monday1, 'a Monday should be available');

  // Blocking a day removes it.
  await api('POST', `/api/masters/doctors/${ids.farah}/leave`,
    { date: monday1.date, reason: 'Conference' }, 'admin');
  const afterLeave = (await api('GET',
    `/api/appointments/availability?doctorId=${ids.farah}&date=${monday1.date}`, undefined, 'reception')).body;
  assert.strictEqual(afterLeave.slots.length, 0, 'a leave day offers no slots');

  // And releasing it brings the day back.
  await api('DELETE', `/api/masters/doctors/${ids.farah}/leave/${monday1.date}`, undefined, 'admin');
  const released = (await api('GET',
    `/api/appointments/availability?doctorId=${ids.farah}&date=${monday1.date}`, undefined, 'reception')).body;
  assert.ok(released.slots.length > 0, 'the day is bookable again');
});

test('a doctor can be deactivated and disappears from booking', async () => {
  await api('PATCH', `/api/masters/staff/${ids.farah}`, { active: false }, 'admin');
  const doctors = await api('GET', '/api/masters/staff?role=doctor', undefined, 'reception');
  const farah = doctors.body.find((d) => d.id === ids.farah);
  assert.strictEqual(farah.active, 0);

  const login = await api('POST', '/api/auth/login',
    { username: 'farah@samiha.local', password: 'Doctor2026x' }, null);
  assert.strictEqual(login.status, 401, 'a deactivated account cannot sign in');
});
