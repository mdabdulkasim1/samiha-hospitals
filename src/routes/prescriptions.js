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

const vitals = require('../services/vitals');

const router = express.Router();

/**
 * A medicine as it should read on a prescription.
 *
 * A brand name does not carry its strength ("Dolo 650" is a brand, "650 mg" is
 * the dose) but a generic formulary line often does, and appending the
 * strength to a name that already ends in it gives "Dolo 650 650 mg". So it is
 * added only when the name does not already say it.
 */
function drugLabel(drug) {
  const name = String(drug.name || '').trim();
  const strength = String(drug.strength || '').trim();
  if (!strength) return name;
  const squash = (s) => s.toLowerCase().replace(/\s+/g, '');
  return squash(name).endsWith(squash(strength)) ? name : `${name} ${strength}`;
}
const prescriberRoles = requireRole('doctor');
// The pharmacy and the desk read prescriptions; only a doctor writes one.
const readerRoles = requireRole('doctor', 'pharmacy', 'nurse', 'reception');

/** Doses per day, for the frequencies that are not written as a slot pattern. */
const PER_DAY = { OD: 1, BD: 2, TDS: 3, QID: 4, HS: 1, SOS: 1, STAT: 1 };

/**
 * What one dose is measured in. A patient told to take "1" of a syrup has been
 * told nothing; told "5 ml" they know to reach for the cup.
 */
const UNIT_BY_FORM = {
  tablet: 'tablet', capsule: 'capsule', syrup: 'ml', suspension: 'ml', solution: 'ml',
  drops: 'drop', injection: 'dose', ointment: 'application', cream: 'application',
  gel: 'application', sachet: 'sachet', inhaler: 'puff', spray: 'spray',
  lotion: 'application', suppository: 'suppository',
};

const FOOD_RELATIONS = ['before_food', 'after_food', 'with_food', 'empty_stomach', 'bedtime', 'anytime'];

/**
 * Turn the three slots into the shorthand a doctor writes and the words a
 * patient reads. Morning-noon-night is how a prescription is read across India,
 * so it is what the sheet is built on; a medicine taken as needed keeps its
 * SOS or STAT frequency instead.
 */
function doseSchedule(item) {
  const slots = {
    morning: num(item.doseMorning, 0),
    afternoon: num(item.doseAfternoon, 0),
    night: num(item.doseNight, 0),
  };
  const perDay = slots.morning + slots.afternoon + slots.night;
  const timesADay = [slots.morning, slots.afternoon, slots.night].filter((n) => n > 0).length;

  // No slot ticked means the doctor is using a plain frequency — SOS, STAT, or
  // something they have typed themselves.
  if (perDay <= 0) {
    const frequency = str(item.frequency, 'SOS');
    return { slots, perDay: PER_DAY[frequency] || 1, frequency };
  }
  const frequency = { 1: 'OD', 2: 'BD', 3: 'TDS' }[timesADay] || `${timesADay}x`;
  return { slots, perDay, frequency };
}

function sheetOr404(id) {
  const sheet = db.prepare(
    `SELECT s.*, u.name AS doctor_name, u.staff_code, dp.doctor_code,
            dp.qualification, dp.specialization, dp.reg_no, dp.room_no, dp.signature_line,
            dep.name AS department_name,
            p.uhid, p.first_name, p.last_name, p.age_years, p.gender, p.phone,
            p.allergies, p.dob, p.aadhaar_number,
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

  // The measurements as they stood when the prescription was written.
  sheet.vitals = vitals.asOf(sheet.patient_id, sheet.created_at);

  // The coded diagnosis list. Older sheets have only the free-text line, which
  // still prints — a prescription already issued is not rewritten.
  sheet.diagnoses = db.prepare(
    `SELECT code, title, rank FROM prescription_diagnoses
      WHERE sheet_id = ? ORDER BY (rank = 'primary') DESC, sort_order, id`
  ).all(sheet.id);

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
            (SELECT GROUP_CONCAT(rx.drug_name, ', ') FROM prescriptions rx WHERE rx.sheet_id = s.id) AS medicines,
            p.age_years, p.gender
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

    /*
     * The coded diagnoses. The term is copied onto the sheet rather than left
     * to a join: the wording behind a code can be revised, and a prescription
     * already in a patient's hand must not quietly change afterwards.
     *
     * Exactly one is primary. If the doctor marks none, the first is taken as
     * the primary, because a claim and a bill both have to know what the visit
     * was actually for and "none of them" is not an answer.
     */
    const diagnoses = Array.isArray(req.body.diagnoses) ? req.body.diagnoses : [];
    const isPrimary = (d) => String(d.rank || '').toLowerCase() === 'primary';
    // Whichever the doctor marked, or the first if they marked none.
    const primaryAt = diagnoses.findIndex(isPrimary);
    const primaryIdx = primaryAt === -1 ? 0 : primaryAt;

    diagnoses.forEach((d, i) => {
      const code = str(d.code) || null;
      let title = str(d.title);
      if (code && !title) {
        const known = db.prepare('SELECT title FROM icd_codes WHERE code = ?').get(code);
        title = known ? known.title : '';
      }
      if (!title) throw badRequest('A diagnosis needs a term, or a code we know the term for.');
      db.prepare(
        `INSERT INTO prescription_diagnoses (sheet_id, code, title, rank, sort_order)
         VALUES (?, ?, ?, ?, ?)`
      ).run(sheetId, code, title, i === primaryIdx ? 'primary' : 'secondary', i);
    });

    for (const it of items) {
      let drug = null;
      if (it.drugId) {
        drug = db.prepare('SELECT * FROM drugs WHERE id = ? AND active = 1').get(int(it.drugId));
        if (!drug) throw notFound(`Medicine #${it.drugId} is not in the formulary.`);
      }
      const name = drug ? drugLabel(drug) : str(it.drugName);
      if (!name) throw badRequest('Every line needs a medicine.');

      const { slots, perDay, frequency } = doseSchedule(it);
      const days = int(it.durationDays, 0);
      const unit = str(it.doseUnit)
        || (drug && UNIT_BY_FORM[String(drug.form || '').toLowerCase()])
        || 'dose';
      const qty = it.quantity !== undefined && it.quantity !== ''
        ? num(it.quantity)
        : Math.ceil(perDay * (days || 1));
      const food = FOOD_RELATIONS.includes(str(it.foodRelation)) ? str(it.foodRelation) : null;

      // `dose` stays readable on its own, because the pharmacy queue and the
      // ward chart show that single line and nothing else.
      const dose = str(it.dose) || (slots.morning + slots.afternoon + slots.night > 0
        ? `${[slots.morning, slots.afternoon, slots.night].join('-')} ${unit}`
        : `1 ${unit}`);

      db.prepare(
        `INSERT INTO prescriptions
           (sheet_id, doctor_id, visit_id, patient_id, drug_id, drug_name, dose, frequency,
            route, duration_days, quantity, instructions,
            dose_morning, dose_afternoon, dose_night, dose_unit, food_relation, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(sheetId, req.user.id, visitId, patient.id, drug ? drug.id : null, name,
            dose, frequency, str(it.route, 'oral'), days || null, qty,
            str(it.instructions),
            slots.morning, slots.afternoon, slots.night, unit, food,
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

/**
 * Sign a prescription with the doctor's stored signature. Signing is what turns
 * a saved sheet into one the patient can carry, so it stamps the image onto the
 * sheet itself — a signature later changed does not rewrite what is already out
 * in the world.
 */
router.post('/:id/sign', prescriberRoles, wrap((req, res) => {
  const sheet = sheetOr404(int(req.params.id));
  if (sheet.doctor_id !== req.user.id) throw forbidden('Only the prescriber can sign their prescription.');
  if (sheet.status === 'cancelled') throw conflict('This prescription was cancelled.');

  const profile = db.prepare('SELECT signature_image FROM doctor_profiles WHERE user_id = ?').get(req.user.id);
  if (!profile || !profile.signature_image) {
    throw badRequest('No signature on file. Upload one from My Clinic → Alert settings before signing.');
  }
  db.prepare("UPDATE prescription_sheets SET signed_at = datetime('now'), signature_image = ? WHERE id = ?")
    .run(profile.signature_image, sheet.id);

  audit.log(req, 'sign', 'prescription_sheet', sheet.id, { rxNo: sheet.rx_no });
  const signed = sheetOr404(sheet.id);
  signed.items = db.prepare('SELECT * FROM prescriptions WHERE sheet_id = ? ORDER BY id').all(sheet.id);
  res.json(signed);
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
