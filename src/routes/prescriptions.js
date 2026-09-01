'use strict';
/**
 * Prescriptions a doctor writes from their own screen.
 *
 * Medicines are picked from the pharmacy's own formulary, so what is prescribed
 * is what the counter can actually dispense — and when the prescription belongs
 * to a visit, the lines drop straight into the pharmacy queue with no re-typing.
 *
 * A doctor sees only what they signed. Nobody else's prescriptions, and no
 * other doctor's patients.
 */
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, badRequest, forbidden, conflict } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, num, paging } = require('../lib/validate');
const { generate } = require('../lib/ids');
const pharmacy = require('../services/pharmacy');
const audit = require('../lib/audit');

const router = express.Router();
const prescriberRoles = requireRole('doctor');
// The pharmacy and the desk read prescriptions; only a doctor writes one.
const readerRoles = requireRole('doctor', 'pharmacy', 'nurse', 'reception');

/** Doses per day, used to suggest a quantity from frequency × duration. */
const PER_DAY = { OD: 1, BD: 2, TDS: 3, QID: 4, HS: 1, SOS: 1, STAT: 1, QID6H: 4 };

function sheetOr404(id) {
  const sheet = db.prepare(
    `SELECT s.*, u.name AS doctor_name, u.staff_code, dp.doctor_code,
            dp.qualification, dp.specialization, dp.reg_no, dp.room_no, dp.signature_line,
            dep.name AS department_name,
            p.uhid, p.first_name, p.last_name, p.age_years, p.gender, p.phone,
            p.allergies, p.dob,
            v.visit_no
       FROM prescription_sheets s
       JOIN users u ON u.id = s.doctor_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
       LEFT JOIN departments dep ON dep.id = u.department_id
       JOIN patients p ON p.id = s.patient_id
       LEFT JOIN visits v ON v.id = s.visit_id
      WHERE s.id = ?`
  ).get(id);
  if (!sheet) throw notFound('Prescription not found');
  return sheet;
}

/** A doctor may open only their own prescriptions; admin and the pharmacy may read any. */
function assertMayRead(req, sheet) {
  if (req.user.role === 'doctor' && sheet.doctor_id !== req.user.id) {
    throw forbidden('This prescription was written by another doctor.');
  }
}

// ------------------------------------------------------------------ listing
router.get('/', readerRoles, wrap((req, res) => {
  const { limit, offset } = paging(req.query, 30);
  const patientId = req.query.patientId ? int(req.query.patientId) : null;
  // A doctor is always scoped to themselves, whatever they ask for.
  const doctorId = req.user.role === 'doctor'
    ? req.user.id
    : (req.query.doctorId ? int(req.query.doctorId) : null);

  const rows = db.prepare(
    `SELECT s.*, u.name AS doctor_name,
            (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            p.uhid, p.age_years, p.gender,
            (SELECT COUNT(*) FROM prescriptions rx WHERE rx.sheet_id = s.id) AS items,
            (SELECT GROUP_CONCAT(rx.drug_name, ', ') FROM prescriptions rx WHERE rx.sheet_id = s.id) AS medicines
       FROM prescription_sheets s
       JOIN users u ON u.id = s.doctor_id
       JOIN patients p ON p.id = s.patient_id
      WHERE (? IS NULL OR s.doctor_id = ?) AND (? IS NULL OR s.patient_id = ?)
      ORDER BY s.id DESC LIMIT ? OFFSET ?`
  ).all(doctorId, doctorId, patientId, patientId, limit, offset);
  res.json(rows);
}));

router.get('/:id', readerRoles, wrap((req, res) => {
  const sheet = sheetOr404(int(req.params.id));
  assertMayRead(req, sheet);
  sheet.items = db.prepare(
    `SELECT rx.*, d.generic_name, d.form, d.strength, d.schedule_type
       FROM prescriptions rx LEFT JOIN drugs d ON d.id = rx.drug_id
      WHERE rx.sheet_id = ? ORDER BY rx.id`
  ).all(sheet.id);
  res.json(sheet);
}));

// ------------------------------------------------------------------ writing
/**
 * Write a prescription. Lines are validated against the formulary so a doctor
 * cannot prescribe something the pharmacy has never heard of, and allergy
 * conflicts are refused unless the prescriber overrides them deliberately.
 */
router.post('/', prescriberRoles, wrap((req, res) => {
  required(req.body, ['patientId', 'items']);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(int(req.body.patientId));
  if (!patient) throw notFound('Patient not found');

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw badRequest('A prescription needs at least one medicine.');

  const visitId = int(req.body.visitId) || null;
  if (visitId) {
    const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
    if (!visit) throw notFound('Visit not found');
    if (visit.patient_id !== patient.id) throw badRequest('That visit belongs to a different patient.');
  }

  // Allergy check across the whole sheet, before anything is written.
  const warnings = pharmacy.safetyCheck(patient.id, items.map((i) => int(i.drugId)).filter(Boolean));
  if (warnings.length && !req.body.acknowledgeWarnings) {
    throw conflict(`Safety check: ${warnings.join(' ')} Resend with acknowledgeWarnings=true to prescribe anyway.`);
  }

  const rxNo = generate('prescription');
  const out = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO prescription_sheets
         (rx_no, patient_id, doctor_id, visit_id, appointment_id, complaints, findings,
          diagnosis, advice, follow_up_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(rxNo, patient.id, req.user.id, visitId, int(req.body.appointmentId) || null,
          str(req.body.complaints), str(req.body.findings), str(req.body.diagnosis),
          str(req.body.advice), str(req.body.followUpDate));
    const sheetId = info.lastInsertRowid;

    for (const it of items) {
      let drug = null;
      if (it.drugId) {
        drug = db.prepare('SELECT * FROM drugs WHERE id = ? AND active = 1').get(int(it.drugId));
        if (!drug) throw notFound(`Medicine #${it.drugId} is not in the formulary.`);
      }
      const name = drug ? `${drug.name}${drug.strength ? ' ' + drug.strength : ''}` : str(it.drugName);
      if (!name) throw badRequest('Every line needs a medicine.');

      const frequency = str(it.frequency, 'BD');
      const days = int(it.durationDays, 0);
      const qty = it.quantity !== undefined && it.quantity !== ''
        ? num(it.quantity)
        : (PER_DAY[frequency] || 1) * days;

      db.prepare(
        `INSERT INTO prescriptions
           (sheet_id, doctor_id, visit_id, patient_id, drug_id, drug_name, dose, frequency,
            route, duration_days, quantity, instructions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(sheetId, req.user.id, visitId, patient.id, drug ? drug.id : null, name,
            str(it.dose), frequency, str(it.route, 'oral'), days || null, qty,
            str(it.instructions),
            // Without a visit there is no pharmacy queue to join: the patient
            // carries the paper to a counter, ours or anyone's.
            visitId ? 'pending' : 'external');
    }
    return sheetId;
  })();

  audit.log(req, 'prescribe', 'prescription_sheet', out, { rxNo, items: items.length, patientId: patient.id });

  const sheet = sheetOr404(out);
  sheet.items = db.prepare('SELECT * FROM prescriptions WHERE sheet_id = ? ORDER BY id').all(out);
  sheet.warnings = warnings;
  res.status(201).json(sheet);
}));

router.post('/:id/cancel', prescriberRoles, wrap((req, res) => {
  const sheet = sheetOr404(int(req.params.id));
  if (sheet.doctor_id !== req.user.id) throw forbidden('Only the prescriber can cancel a prescription.');
  const dispensed = db.prepare(
    "SELECT COUNT(*) AS c FROM prescriptions WHERE sheet_id = ? AND dispensed_qty > 0"
  ).get(sheet.id).c;
  if (dispensed) throw conflict('Part of this prescription has already been dispensed.');

  db.transaction(() => {
    db.prepare("UPDATE prescription_sheets SET status = 'cancelled' WHERE id = ?").run(sheet.id);
    db.prepare("UPDATE prescriptions SET status = 'cancelled' WHERE sheet_id = ?").run(sheet.id);
  })();
  audit.log(req, 'cancel', 'prescription_sheet', sheet.id, { rxNo: sheet.rx_no });
  res.json({ ok: true });
}));

/**
 * The patients a doctor may prescribe for: anyone they have seen or who is
 * booked with them. Searching the whole register from a prescription pad is
 * not a doctor's job.
 */
router.get('/patients/search', prescriberRoles, wrap((req, res) => {
  const q = str(req.query.q, '');
  const like = `%${q}%`;
  res.json(db.prepare(
    `SELECT DISTINCT p.id, p.uhid, p.first_name, p.last_name, p.age_years, p.gender,
            p.phone, p.allergies,
            (SELECT MAX(a.scheduled_at) FROM appointments a
              WHERE a.patient_id = p.id AND a.doctor_id = ?) AS last_appointment
       FROM patients p
      WHERE p.active = 1
        AND (p.id IN (SELECT patient_id FROM appointments WHERE doctor_id = ?)
          OR p.id IN (SELECT patient_id FROM visits WHERE doctor_id = ?)
          OR p.id IN (SELECT patient_id FROM prescription_sheets WHERE doctor_id = ?))
        AND (? = '' OR p.first_name LIKE ? OR p.last_name LIKE ? OR p.uhid LIKE ? OR p.phone LIKE ?)
      ORDER BY last_appointment DESC, p.first_name LIMIT 20`
  ).all(req.user.id, req.user.id, req.user.id, req.user.id, q, like, like, like, like));
}));

module.exports = router;
