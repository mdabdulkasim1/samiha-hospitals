'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, conflict, badRequest } = require('../lib/http');
const { requireRole, seesMoney } = require('../lib/auth');
const { required, str, int, num, bool, phone, paging, oneOf, aadhaar } = require('../lib/validate');
const { generate } = require('../lib/ids');
const audit = require('../lib/audit');

const vitalsService = require('../services/vitals');

const router = express.Router();
const deskRoles = requireRole('reception', 'nurse', 'doctor', 'counselor', 'cashier', 'lab', 'pharmacy', 'ward');

const fullName = (p) => `${p.first_name} ${p.last_name || ''}`.trim();

/**
 * The full registration dataset, mapped once so a walk-in registration and the
 * promotion of an enquiry can never capture different things.
 */
function registrationMap(body) {
  const dob = str(body.dob);
  return {
    // --- personal and demographic -----------------------------------------
    title: str(body.title), first_name: str(body.firstName), last_name: str(body.lastName),
    dob,
    age_years: body.age !== undefined && body.age !== '' ? int(body.age) : ageFromDob(dob),
    gender: str(body.gender),
    sex_at_birth: oneOf(body.sexAtBirth, ['male', 'female', 'intersex'], 'sexAtBirth'),
    phone: phone(body.phone), whatsapp: phone(body.whatsapp) || phone(body.phone),
    email: str(body.email),
    address: str(body.address), city: str(body.city), state: str(body.state), pincode: str(body.pincode),
    emergency_name: str(body.emergencyName), emergency_phone: phone(body.emergencyPhone),
    emergency_relation: str(body.emergencyRelation),
    id_type: str(body.idType), id_number: str(body.idNumber),
    // Validated, not just stored: a mistyped Aadhaar is somebody else's.
    aadhaar_number: aadhaar(body.aadhaarNumber),
    blood_group: str(body.bloodGroup), marital_status: str(body.maritalStatus),
    // How this person relates to whoever else shares their mobile number.
    relationship_to_primary: str(body.relationshipToPrimary),

    // --- insurance and billing --------------------------------------------
    insurance_provider: str(body.insuranceProvider),
    insurance_policy_no: str(body.insurancePolicyNo),
    insurance_valid_till: str(body.insuranceValidTill),
    // An insurer on file means they are not uninsured, whatever the tick said.
    ...(str(body.insuranceProvider) || str(body.insurancePolicyNo) ? { is_uninsured: 0 } : {}),
    // Falls back to the home address when the desk leaves it blank.
    billing_address: str(body.billingAddress) || str(body.address),

    // --- medical history ---------------------------------------------------
    presenting_complaint: str(body.presentingComplaint),
    allergies: str(body.allergies),
    chronic_conditions: str(body.chronicConditions),
    current_medications: str(body.currentMedications),
    immunisations: str(body.immunisations),

    // --- social history ----------------------------------------------------
    occupation: str(body.occupation),
    smoking_status: oneOf(body.smokingStatus, ['never', 'former', 'current', 'unknown'], 'smokingStatus'),
    alcohol_use: oneOf(body.alcoholUse, ['never', 'occasional', 'regular', 'former', 'unknown'], 'alcoholUse'),

    // --- preferred pharmacy -------------------------------------------------
    pharmacy_name: str(body.pharmacyName), pharmacy_phone: phone(body.pharmacyPhone),
    pharmacy_address: str(body.pharmacyAddress),
    notes: str(body.notes),
  };
}

/**
 * Consent is not optional paperwork — treatment cannot lawfully proceed
 * without it, so registration refuses to complete until it is recorded.
 */
function consentMap(body, userId) {
  const treatment = bool(body.consentTreatment, false);
  if (!treatment) {
    throw badRequest(
      'Consent to treatment has not been recorded. The patient (or their guardian) must agree ' +
      'before registration can be completed.'
    );
  }
  return {
    consent_treatment: 1,
    consent_privacy: bool(body.consentPrivacy, false) ? 1 : 0,
    consent_contact: bool(body.consentContact, false) ? 1 : 0,
    consent_signed_at: new Date().toISOString(),
    consent_signed_by: str(body.consentSignedBy) || str(body.firstName),
    consent_taken_by: userId,
  };
}

/** History lines and any baseline vitals taken at the desk. */
function recordIntake(patientId, body, userId) {
  const insHistory = db.prepare(
    'INSERT INTO patient_history (patient_id, kind, detail, since, recorded_by) VALUES (?, ?, ?, ?, ?)'
  );
  const add = (kind, detail) => { if (detail) insHistory.run(patientId, kind, str(detail), null, userId); };

  add('past_illness', body.pastIllness);
  add('surgery', body.surgeries);
  add('family', body.familyHistory);
  add('social', body.socialHistory);
  add('allergy', body.allergies);
  add('immunisation', body.immunisations);
  for (const h of (Array.isArray(body.history) ? body.history : [])) {
    if (h && h.detail) insHistory.run(patientId, h.kind || 'past_illness', str(h.detail), str(h.since), userId);
  }

  // Baseline observations, if the desk took any. Not tied to a visit.
  const v = body.vitals || {};
  const height = num(v.heightCm, 0);
  const weight = num(v.weightKg, 0);
  const any = [v.tempC, v.pulse, v.bpSystolic, v.bpDiastolic, v.spo2, v.respRate, height, weight]
    .some((x) => x !== undefined && x !== '' && Number(x) > 0);
  if (!any) return null;

  const info = db.prepare(
    `INSERT INTO vitals (patient_id, height_cm, weight_kg, bmi, temp_c, pulse, resp_rate,
                         bp_systolic, bp_diastolic, spo2, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(patientId, height || null, weight || null,
        height > 0 && weight > 0 ? Math.round((weight / ((height / 100) ** 2)) * 10) / 10 : null,
        v.tempC === undefined || v.tempC === '' ? null : num(v.tempC),
        v.pulse === undefined || v.pulse === '' ? null : int(v.pulse),
        v.respRate === undefined || v.respRate === '' ? null : int(v.respRate),
        v.bpSystolic === undefined || v.bpSystolic === '' ? null : int(v.bpSystolic),
        v.bpDiastolic === undefined || v.bpDiastolic === '' ? null : int(v.bpDiastolic),
        v.spo2 === undefined || v.spo2 === '' ? null : int(v.spo2),
        'Baseline taken at registration', userId);
  db.prepare('UPDATE vitals SET purpose = ? WHERE id = ?')
    .run(str(body.presentingComplaint) || 'Registration', info.lastInsertRowid);
  return info.lastInsertRowid;
}

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const diff = Date.now() - d.getTime();
  return Math.floor(diff / (365.25 * 24 * 3600 * 1000));
}

// ------------------------------------------------------------------- search
router.get('/', deskRoles, wrap((req, res) => {
  const q = str(req.query.q, '');
  const stage = oneOf(req.query.stage, ['enquiry', 'registered'], 'stage');
  const { limit, offset, page } = paging(req.query, 25);
  const like = `%${q}%`;

  const clauses = ['p.active = 1'];
  const params = [];
  if (q) {
    clauses.push(`(p.uhid LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ? OR p.phone LIKE ?
      OR p.whatsapp LIKE ? OR (p.first_name || ' ' || COALESCE(p.last_name,'')) LIKE ?)`);
    params.push(like, like, like, like, like, like);
  }
  if (stage) { clauses.push('p.stage = ?'); params.push(stage); }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const rows = db.prepare(
    `SELECT p.id, p.uhid, p.title, p.first_name, p.last_name, p.gender, p.age_years, p.dob,
            p.phone, p.whatsapp, p.city, p.blood_group, p.is_uninsured, p.sliding_scale_band,
            p.allergies, p.stage, p.enquiry_at, p.registered_at,
            (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id) AS visit_count,
            (SELECT e.ref_no FROM enquiries e WHERE e.patient_id = p.id ORDER BY e.id LIMIT 1) AS enquiry_ref,
            (SELECT e.source FROM enquiries e WHERE e.patient_id = p.id ORDER BY e.id LIMIT 1) AS enquiry_source
       FROM patients p ${where}
      ORDER BY p.id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM patients p ${where}`).get(...params).c;
  const counts = db.prepare(
    "SELECT stage, COUNT(*) AS c FROM patients WHERE active = 1 GROUP BY stage"
  ).all().reduce((a, r) => ({ ...a, [r.stage]: r.c }), {});

  res.json({
    rows, total, page, limit,
    counts: { enquiry: counts.enquiry || 0, registered: counts.registered || 0 },
  });
}));

/**
 * The mobile number is how a patient is found at the desk — it is the one thing
 * everybody knows by heart, and it is what they give on the phone and on
 * WhatsApp. One number is often one family, so this returns everybody on it and
 * lets the desk pick the person in front of them.
 */
router.get('/by-phone', deskRoles, wrap((req, res) => {
  const ph = phone(req.query.phone);
  if (!ph || ph.replace(/\D/g, '').length < 6) {
    throw badRequest('Give at least six digits of the mobile number.');
  }
  // Match on the last ten digits, so 9840012345, 09840012345 and +91 98400
  // 12345 all find the same family.
  const tail = ph.slice(-10);
  const like = `%${tail}`;

  const members = db.prepare(
    `SELECT p.id, p.uhid, p.title, p.first_name, p.last_name, p.gender, p.age_years, p.dob,
            p.phone, p.whatsapp, p.stage, p.allergies, p.blood_group, p.address, p.city,
            p.relationship_to_primary, p.registered_at, p.enquiry_at,
            (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id) AS visit_count,
            (SELECT MAX(v.arrived_at) FROM visits v WHERE v.patient_id = p.id) AS last_visit,
            (SELECT COALESCE(SUM(i.balance), 0) FROM invoices i
              WHERE i.patient_id = p.id AND i.status IN ('unpaid','partial')) AS outstanding_raw,
            (SELECT MIN(a.scheduled_at) FROM appointments a
              WHERE a.patient_id = p.id AND a.status IN ('booked','confirmed')
                AND datetime(a.scheduled_at) >= datetime('now')) AS next_appointment
       FROM patients p
      WHERE p.active = 1 AND (p.phone LIKE ? OR p.whatsapp LIKE ?)
      ORDER BY p.stage DESC, COALESCE(p.age_years, 0) DESC, p.first_name`
  ).all(like, like);

  // A household's unpaid balance is the counter's business, not the front
  // desk's, so it leaves unless the person reading may see money.
  const money = seesMoney(req.user);
  for (const m of members) {
    m.outstanding = money ? m.outstanding_raw : null;
    delete m.outstanding_raw;
  }

  res.json({
    phone: ph,
    count: members.length,
    // Everyone on one number is treated as one household at the desk.
    isFamily: members.length > 1,
    members,
  });
}));

// --------------------------------------------------------------- registration
/**
 * "Demographic, Med. History Paperwork" — the full intake. Open to the front
 * desk and to administrators.
 *
 * `stage: 'enquiry'` opens a lightweight lead record instead, which skips the
 * consent and paperwork requirements until the person actually turns up.
 */
router.post('/', requireRole('reception'), wrap((req, res) => {
  required(req.body, ['firstName']);
  const stage = oneOf(req.body.stage, ['enquiry', 'registered'], 'stage') || 'registered';
  const ph = phone(req.body.phone);

  // One number is often one family, so an existing number is not an error — it
  // is a household the desk should see before adding another name to it.
  if (ph && !bool(req.body.allowDuplicate)) {
    const family = db.prepare(
      `SELECT id, uhid, first_name, last_name, age_years, gender FROM patients
        WHERE (phone = ? OR whatsapp = ?) AND active = 1 ORDER BY id`
    ).all(ph, ph);
    if (family.length) {
      throw conflict(
        `${family.length} patient(s) are already registered on ${ph}: ` +
        family.map((f) => `${f.uhid} — ${f.first_name} ${f.last_name || ''}`.trim()).join('; ') +
        '. Open one of them, or resend with allowDuplicate=true to add another person to this number.',
        { family, phone: ph }
      );
    }
  }

  const uhid = generate('uhid');
  const fields = {
    stage,
    enquiry_at: stage === 'enquiry' ? new Date().toISOString() : null,
    uhid,
    is_uninsured: bool(req.body.isUninsured, true) ? 1 : 0,
    created_by: req.user.id,
    ...registrationMap(req.body),
    // A lead is not asked to sign anything yet.
    ...(stage === 'registered' ? consentMap(req.body, req.user.id) : {}),
  };

  const cols = Object.keys(fields);
  const info = db.prepare(
    `INSERT INTO patients (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...cols.map((c) => fields[c]));

  const patientId = info.lastInsertRowid;
  const vitalsId = stage === 'registered' ? recordIntake(patientId, req.body, req.user.id) : null;

  audit.log(req, stage === 'enquiry' ? 'create_enquiry_patient' : 'register', 'patient',
    patientId, { uhid, stage });
  res.status(201).json({
    ...db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId),
    baselineVitalsRecorded: Boolean(vitalsId),
  });
}));

// ------------------------------------------------------------------ 360 view
router.get('/:id', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!patient) throw notFound('Patient not found');

  patient.name = fullName(patient);
  patient.history = db.prepare('SELECT * FROM patient_history WHERE patient_id = ? ORDER BY id DESC').all(id);
  patient.visits = db.prepare(
    `SELECT v.*, u.name AS doctor_name, d.name AS department_name
       FROM visits v LEFT JOIN users u ON u.id = v.doctor_id LEFT JOIN departments d ON d.id = v.department_id
      WHERE v.patient_id = ? ORDER BY v.id DESC LIMIT 30`
  ).all(id);
  patient.appointments = db.prepare(
    `SELECT a.*, u.name AS doctor_name FROM appointments a LEFT JOIN users u ON u.id = a.doctor_id
      WHERE a.patient_id = ? ORDER BY a.scheduled_at DESC LIMIT 20`
  ).all(id);
  patient.admissions = db.prepare(
    `SELECT ad.*, w.name AS ward_name, b.bed_no, u.name AS doctor_name
       FROM admissions ad
       LEFT JOIN wards w ON w.id = ad.ward_id
       LEFT JOIN beds b ON b.id = ad.bed_id
       LEFT JOIN users u ON u.id = ad.doctor_id
      WHERE ad.patient_id = ? ORDER BY ad.id DESC`
  ).all(id);
  /*
   * The dated chart: every weight, height, blood pressure and the reason the
   * patient came that day, newest first. A reading taken during a visit borrows
   * that visit's reason; one taken at the desk carries its own.
   */
  patient.vitals = db.prepare(
    `SELECT v.*, u.name AS recorded_by_name, vis.visit_no,
            COALESCE(v.purpose, vis.reason_for_visit) AS purpose,
            doc.name AS doctor_name
       FROM vitals v
       LEFT JOIN users u ON u.id = v.recorded_by
       LEFT JOIN visits vis ON vis.id = v.visit_id
       LEFT JOIN users doc ON doc.id = vis.doctor_id
      WHERE v.patient_id = ? ORDER BY datetime(v.recorded_at) DESC, v.id DESC LIMIT 100`
  ).all(id);
  patient.consultations = db.prepare(
    `SELECT c.*, u.name AS doctor_name,
            (SELECT GROUP_CONCAT(title, '; ') FROM consultation_diagnoses WHERE consultation_id = c.id) AS diagnoses
       FROM consultations c LEFT JOIN users u ON u.id = c.doctor_id
      WHERE c.patient_id = ? ORDER BY c.id DESC LIMIT 20`
  ).all(id);
  patient.prescriptions = db.prepare(
    'SELECT * FROM prescriptions WHERE patient_id = ? ORDER BY id DESC LIMIT 40'
  ).all(id);
  patient.labOrders = db.prepare(
    `SELECT o.*, (SELECT GROUP_CONCAT(test_name, ', ') FROM lab_order_items WHERE order_id = o.id) AS tests
       FROM lab_orders o WHERE o.patient_id = ? ORDER BY o.id DESC LIMIT 20`
  ).all(id);
  patient.screenings = db.prepare(
    'SELECT * FROM financial_screenings WHERE patient_id = ? ORDER BY id DESC LIMIT 10'
  ).all(id);

  /*
   * What this patient has been billed and what they still owe travels only to
   * the desks that handle money. The rest of the clinic opens the same record
   * for the clinical history in it, and a nurse reading a chart has no reason
   * to know that the family is behind on a bill.
   */
  if (seesMoney(req.user)) {
    patient.invoices = db.prepare(
      'SELECT * FROM invoices WHERE patient_id = ? ORDER BY id DESC LIMIT 20'
    ).all(id);
    patient.outstanding = db.prepare(
      "SELECT COALESCE(SUM(balance), 0) AS s FROM invoices WHERE patient_id = ? AND status IN ('unpaid','partial')"
    ).get(id).s;
  } else {
    patient.invoices = null;
    patient.outstanding = null;
  }

  res.json(patient);
}));

router.patch('/:id', requireRole('reception', 'nurse', 'doctor', 'counselor'), wrap((req, res) => {
  const id = int(req.params.id);
  if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(id)) throw notFound('Patient not found');

  const map = {
    title: str(req.body.title), first_name: str(req.body.firstName), last_name: str(req.body.lastName),
    dob: str(req.body.dob), gender: str(req.body.gender), phone: phone(req.body.phone),
    whatsapp: phone(req.body.whatsapp), email: str(req.body.email), address: str(req.body.address),
    city: str(req.body.city), state: str(req.body.state), pincode: str(req.body.pincode),
    blood_group: str(req.body.bloodGroup), marital_status: str(req.body.maritalStatus),
    occupation: str(req.body.occupation), emergency_name: str(req.body.emergencyName),
    emergency_phone: phone(req.body.emergencyPhone), emergency_relation: str(req.body.emergencyRelation),
    id_type: str(req.body.idType), id_number: str(req.body.idNumber),
    insurance_provider: str(req.body.insuranceProvider), insurance_policy_no: str(req.body.insurancePolicyNo),
    insurance_valid_till: str(req.body.insuranceValidTill), allergies: str(req.body.allergies),
    chronic_conditions: str(req.body.chronicConditions), notes: str(req.body.notes),
    // "Update Patient Pharmacy Information" step of the workflow
    pharmacy_name: str(req.body.pharmacyName), pharmacy_phone: phone(req.body.pharmacyPhone),
    pharmacy_address: str(req.body.pharmacyAddress),
    // Fuller dataset, editable after registration
    sex_at_birth: oneOf(req.body.sexAtBirth, ['male', 'female', 'intersex'], 'sexAtBirth'),
    billing_address: str(req.body.billingAddress),
    current_medications: str(req.body.currentMedications),
    immunisations: str(req.body.immunisations),
    presenting_complaint: str(req.body.presentingComplaint),
    smoking_status: oneOf(req.body.smokingStatus, ['never', 'former', 'current', 'unknown'], 'smokingStatus'),
    alcohol_use: oneOf(req.body.alcoholUse, ['never', 'occasional', 'regular', 'former', 'unknown'], 'alcoholUse'),
    id_type: str(req.body.idType), id_number: str(req.body.idNumber),
    marital_status: str(req.body.maritalStatus),
  };
  if (req.body.age !== undefined && req.body.age !== '') map.age_years = int(req.body.age);
  if (req.body.isUninsured !== undefined) map.is_uninsured = bool(req.body.isUninsured) ? 1 : 0;

  // Consent can be captured or corrected later; the signature is re-stamped.
  if (req.body.consentTreatment !== undefined) {
    map.consent_treatment = bool(req.body.consentTreatment) ? 1 : 0;
    map.consent_privacy = bool(req.body.consentPrivacy) ? 1 : 0;
    map.consent_contact = bool(req.body.consentContact) ? 1 : 0;
    map.consent_signed_by = str(req.body.consentSignedBy);
    map.consent_signed_at = new Date().toISOString();
    map.consent_taken_by = req.user.id;
  }

  const entries = Object.entries(map).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length) {
    db.prepare(`UPDATE patients SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, v]) => v), id);
  }
  audit.log(req, 'update', 'patient', id, { fields: entries.map(([k]) => k) });
  res.json(db.prepare('SELECT * FROM patients WHERE id = ?').get(id));
}));

router.post('/:id/history', requireRole('reception', 'nurse', 'doctor'), wrap((req, res) => {
  required(req.body, ['kind', 'detail']);
  const info = db.prepare(
    'INSERT INTO patient_history (patient_id, kind, detail, since, recorded_by) VALUES (?, ?, ?, ?, ?)'
  ).run(int(req.params.id), str(req.body.kind), str(req.body.detail), str(req.body.since), req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM patient_history WHERE id = ?').get(info.lastInsertRowid));
}));

/**
 * "They enquired, and now they have turned up."
 *
 * Completes the demographic and medical-history paperwork on an existing
 * enquiry record and promotes it to a registered patient, keeping the same row
 * so the enquiry, its source and any appointments already booked stay attached.
 */
/**
 * Add a dated reading to a patient's chart without opening a visit — the weight
 * and blood pressure taken when somebody drops in for a check, and why they
 * came. These are the rows the patient page charts date-wise.
 */
router.post('/:id/vitals', requireRole('reception', 'nurse', 'doctor'), wrap((req, res) => {
  const id = int(req.params.id);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!patient) throw notFound('Patient not found');

  const height = num(req.body.heightCm, 0);
  const weight = num(req.body.weightKg, 0);
  const value = (v, cast = num) => (v === undefined || v === '' || v === null ? null : cast(v));

  // A reading counts if it was actually entered. Zero is a real answer for
  // pain — "none" is worth recording — so presence is what is tested, not
  // truthiness, and anything that is not a number is not a reading.
  const given = (x) => x !== undefined && x !== null && String(x).trim() !== ''
    && Number.isFinite(Number(x));
  // The raw body, not the parsed height and weight: those default to zero when
  // absent, and a defaulted zero is not something the nurse measured.
  const any = [req.body.tempC, req.body.pulse, req.body.bpSystolic, req.body.bpDiastolic,
    req.body.spo2, req.body.respRate, req.body.bloodSugar, req.body.painScore,
    req.body.heightCm, req.body.weightKg]
    .some(given);
  if (!any) throw badRequest('Record at least one reading — weight, height, blood pressure or another observation.');

  // Height changes rarely; carry the last one forward so BMI still works when
  // only the weight is taken.
  const lastHeight = db.prepare(
    'SELECT height_cm FROM vitals WHERE patient_id = ? AND height_cm > 0 ORDER BY id DESC LIMIT 1'
  ).get(id);
  const effectiveHeight = height > 0 ? height : (lastHeight ? lastHeight.height_cm : 0);

  const info = db.prepare(
    `INSERT INTO vitals (patient_id, visit_id, height_cm, weight_kg, bmi, temp_c, pulse, resp_rate,
                         bp_systolic, bp_diastolic, spo2, blood_sugar, pain_score, purpose, notes,
                         recorded_by, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
  ).run(id, int(req.body.visitId) || null,
        height > 0 ? height : null, weight > 0 ? weight : null,
        effectiveHeight > 0 && weight > 0
          ? Math.round((weight / ((effectiveHeight / 100) ** 2)) * 10) / 10 : null,
        value(req.body.tempC), value(req.body.pulse, int), value(req.body.respRate, int),
        value(req.body.bpSystolic, int), value(req.body.bpDiastolic, int),
        value(req.body.spo2, int), value(req.body.bloodSugar), value(req.body.painScore, int),
        str(req.body.purpose), str(req.body.notes), req.user.id,
        str(req.body.recordedAt));

  audit.log(req, 'record_vitals', 'patient', id, { vitalsId: info.lastInsertRowid });
  const recorded = db.prepare('SELECT * FROM vitals WHERE id = ?').get(info.lastInsertRowid);
  // The same flags the nurse station raises on a queued patient. A reading
  // that needs a doctor now needs one whether or not there is a visit open.
  res.status(201).json({ ...recorded, alerts: vitalsService.alerts(recorded) });
}));

router.post('/:id/register', requireRole('reception'), wrap((req, res) => {
  const id = int(req.params.id);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!patient) throw notFound('Patient not found');
  if (patient.stage === 'registered') {
    throw conflict(`${patient.first_name} is already a registered patient (${patient.uhid}).`);
  }
  required(req.body, ['firstName']);

  const fields = { stage: 'registered', ...registrationMap(req.body), ...consentMap(req.body, req.user.id) };
  if (req.body.isUninsured !== undefined) fields.is_uninsured = bool(req.body.isUninsured) ? 1 : 0;

  // Keep whatever the enquiry already had where the form left a blank.
  const entries = Object.entries(fields).filter(([, v]) => v !== null && v !== undefined && v !== '');
  db.prepare(
    `UPDATE patients SET ${entries.map(([k]) => `${k} = ?`).join(', ')},
            registered_at = datetime('now'), created_by = COALESCE(created_by, ?)
      WHERE id = ?`
  ).run(...entries.map(([, v]) => v), req.user.id, id);

  const vitalsId = recordIntake(id, req.body, req.user.id);

  // Close off the enquiries that brought them in.
  db.prepare(
    `UPDATE enquiries SET status = 'converted', closed_at = datetime('now')
      WHERE patient_id = ? AND status IN ('new','contacted')`
  ).run(id);

  audit.log(req, 'convert_to_registered', 'patient', id, { uhid: patient.uhid });
  res.json({
    patient: db.prepare('SELECT * FROM patients WHERE id = ?').get(id),
    baselineVitalsRecorded: Boolean(vitalsId),
    message: `${fields.first_name || patient.first_name} is now a registered patient (${patient.uhid}).`,
  });
}));

/** Yearly-screening due check — drives the "Time for Yearly Screening?" branch. */
router.get('/:id/screening-status', deskRoles, wrap((req, res) => {
  const p = db.prepare('SELECT last_screening_date FROM patients WHERE id = ?').get(int(req.params.id));
  if (!p) throw notFound('Patient not found');
  const last = p.last_screening_date ? new Date(p.last_screening_date) : null;
  const due = !last || (Date.now() - last.getTime()) > 365 * 24 * 3600 * 1000;
  res.json({ due, lastScreeningDate: p.last_screening_date, dueSince: last ? new Date(last.getTime() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10) : null });
}));

module.exports = router;
