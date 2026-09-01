'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, conflict } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, num, bool, phone, paging } = require('../lib/validate');
const { generate } = require('../lib/ids');
const audit = require('../lib/audit');

const router = express.Router();
const deskRoles = requireRole('reception', 'nurse', 'doctor', 'counselor', 'cashier', 'lab', 'pharmacy', 'ward');

const fullName = (p) => `${p.first_name} ${p.last_name || ''}`.trim();

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
  const { limit, offset, page } = paging(req.query, 25);
  const like = `%${q}%`;
  const where = q
    ? `WHERE active = 1 AND (uhid LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR whatsapp LIKE ?
        OR (first_name || ' ' || COALESCE(last_name,'')) LIKE ?)`
    : 'WHERE active = 1';
  const params = q ? [like, like, like, like, like, like] : [];

  const rows = db.prepare(
    `SELECT id, uhid, title, first_name, last_name, gender, age_years, dob, phone, whatsapp, city,
            blood_group, is_uninsured, sliding_scale_band, allergies, registered_at
       FROM patients ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM patients ${where}`).get(...params).c;
  res.json({ rows, total, page, limit });
}));

// --------------------------------------------------------------- registration
router.post('/', requireRole('reception'), wrap((req, res) => {
  required(req.body, ['firstName']);
  const wa = phone(req.body.whatsapp || req.body.phone);
  const ph = phone(req.body.phone);

  if (ph) {
    const dup = db.prepare('SELECT uhid, first_name, last_name FROM patients WHERE phone = ? AND active = 1').get(ph);
    if (dup && !bool(req.body.allowDuplicate)) {
      throw conflict(
        `A patient with this phone already exists: ${dup.uhid} — ${dup.first_name} ${dup.last_name || ''}. ` +
        `Resend with allowDuplicate=true to register anyway (e.g. a family sharing one number).`
      );
    }
  }

  const uhid = generate('uhid');
  const dob = str(req.body.dob);
  const info = db.prepare(
    `INSERT INTO patients
       (uhid, title, first_name, last_name, dob, age_years, gender, phone, whatsapp, email,
        address, city, state, pincode, blood_group, marital_status, occupation,
        emergency_name, emergency_phone, emergency_relation, id_type, id_number,
        is_uninsured, insurance_provider, insurance_policy_no, insurance_valid_till,
        allergies, chronic_conditions, pharmacy_name, pharmacy_phone, pharmacy_address, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uhid, str(req.body.title), str(req.body.firstName), str(req.body.lastName), dob,
    req.body.age !== undefined && req.body.age !== '' ? int(req.body.age) : ageFromDob(dob),
    str(req.body.gender), ph, wa, str(req.body.email),
    str(req.body.address), str(req.body.city), str(req.body.state), str(req.body.pincode),
    str(req.body.bloodGroup), str(req.body.maritalStatus), str(req.body.occupation),
    str(req.body.emergencyName), phone(req.body.emergencyPhone), str(req.body.emergencyRelation),
    str(req.body.idType), str(req.body.idNumber),
    bool(req.body.isUninsured, true) ? 1 : 0,
    str(req.body.insuranceProvider), str(req.body.insurancePolicyNo), str(req.body.insuranceValidTill),
    str(req.body.allergies), str(req.body.chronicConditions),
    str(req.body.pharmacyName), phone(req.body.pharmacyPhone), str(req.body.pharmacyAddress),
    str(req.body.notes), req.user.id
  );

  // "Demographic + Med History Paperwork" — history lines captured at registration.
  const history = Array.isArray(req.body.history) ? req.body.history : [];
  const insHistory = db.prepare(
    'INSERT INTO patient_history (patient_id, kind, detail, since, recorded_by) VALUES (?, ?, ?, ?, ?)'
  );
  for (const h of history) {
    if (h && h.detail) insHistory.run(info.lastInsertRowid, h.kind || 'past_illness', str(h.detail), str(h.since), req.user.id);
  }

  audit.log(req, 'register', 'patient', info.lastInsertRowid, { uhid });
  res.status(201).json(db.prepare('SELECT * FROM patients WHERE id = ?').get(info.lastInsertRowid));
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
  patient.vitals = db.prepare('SELECT * FROM vitals WHERE patient_id = ? ORDER BY id DESC LIMIT 10').all(id);
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
  patient.invoices = db.prepare(
    'SELECT * FROM invoices WHERE patient_id = ? ORDER BY id DESC LIMIT 20'
  ).all(id);
  patient.screenings = db.prepare(
    'SELECT * FROM financial_screenings WHERE patient_id = ? ORDER BY id DESC LIMIT 10'
  ).all(id);
  patient.outstanding = db.prepare(
    "SELECT COALESCE(SUM(balance), 0) AS s FROM invoices WHERE patient_id = ? AND status IN ('unpaid','partial')"
  ).get(id).s;

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
  };
  if (req.body.age !== undefined && req.body.age !== '') map.age_years = int(req.body.age);
  if (req.body.isUninsured !== undefined) map.is_uninsured = bool(req.body.isUninsured) ? 1 : 0;

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

/** Yearly-screening due check — drives the "Time for Yearly Screening?" branch. */
router.get('/:id/screening-status', deskRoles, wrap((req, res) => {
  const p = db.prepare('SELECT last_screening_date FROM patients WHERE id = ?').get(int(req.params.id));
  if (!p) throw notFound('Patient not found');
  const last = p.last_screening_date ? new Date(p.last_screening_date) : null;
  const due = !last || (Date.now() - last.getTime()) > 365 * 24 * 3600 * 1000;
  res.json({ due, lastScreeningDate: p.last_screening_date, dueSince: last ? new Date(last.getTime() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10) : null });
}));

module.exports = router;
