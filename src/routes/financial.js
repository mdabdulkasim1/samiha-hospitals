'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, conflict } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, num, bool } = require('../lib/validate');
const { generate } = require('../lib/ids');
const slidingScale = require('../services/slidingScale');
const whatsapp = require('../services/whatsapp');
const audit = require('../lib/audit');

const router = express.Router();
const screeningRoles = requireRole('counselor', 'reception', 'cashier');

/**
 * The "Financial Screening" swimlane of the clinic workflow:
 *
 *   Uninsured / Needs Fin. Assistance?  →  Financial Screening Paperwork
 *     →  Counselor Available?  →  (No) Waiting Room / (Yes) Counselor Calls Patient
 *     →  Has Pay Stub or Valid Proof of Income?
 *     →  Run Eligible Programs Web Form  →  Determine "Sliding Scale" Position
 *     →  Present Financial Assistance Options  →  Patient Decides To Continue?
 */

router.get('/screenings', screeningRoles, wrap((req, res) => {
  const status = str(req.query.status);
  const rows = db.prepare(
    `SELECT fs.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            p.phone, p.whatsapp, u.name AS counselor_name, v.visit_no, ap.name AS program_name
       FROM financial_screenings fs
       JOIN patients p ON p.id = fs.patient_id
       LEFT JOIN users u ON u.id = fs.counselor_id
       LEFT JOIN visits v ON v.id = fs.visit_id
       LEFT JOIN assistance_programs ap ON ap.id = fs.assistance_program_id
      WHERE (? IS NULL OR fs.status = ?)
      ORDER BY CASE fs.status WHEN 'awaiting_counselor' THEN 0 WHEN 'with_counselor' THEN 1
                              WHEN 'docs_pending' THEN 2 ELSE 3 END, fs.id DESC
      LIMIT 200`
  ).all(status, status);
  res.json({ rows, queueLength: rows.filter((r) => r.status === 'awaiting_counselor').length });
}));

/** "Financial Screening Paperwork" — opens the case and puts it in the queue. */
router.post('/screenings', screeningRoles, wrap((req, res) => {
  required(req.body, ['patientId']);
  const patientId = int(req.body.patientId);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  if (!patient) throw notFound('Patient not found');

  const open = db.prepare(
    "SELECT * FROM financial_screenings WHERE patient_id = ? AND status NOT IN ('completed','declined')"
  ).get(patientId);
  if (open) throw conflict(`An open screening already exists for this patient (${open.screening_no}).`);

  // "Counselor Available?" — if none is free the case waits, exactly as charted.
  const availableCounselor = db.prepare(
    `SELECT u.id, u.name,
            (SELECT COUNT(*) FROM financial_screenings f
              WHERE f.counselor_id = u.id AND f.status = 'with_counselor') AS load
       FROM users u WHERE u.role = 'counselor' AND u.active = 1
      ORDER BY load ASC LIMIT 1`
  ).get();
  const free = availableCounselor && availableCounselor.load === 0;

  const screeningNo = generate('screening');
  const info = db.prepare(
    `INSERT INTO financial_screenings (screening_no, patient_id, visit_id, status, counselor_id, uninsured, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(screeningNo, patientId, int(req.body.visitId) || null,
        free ? 'with_counselor' : 'awaiting_counselor',
        free ? availableCounselor.id : null,
        bool(req.body.uninsured, Boolean(patient.is_uninsured)) ? 1 : 0,
        str(req.body.notes), req.user.id);

  if (req.body.visitId) {
    db.prepare("INSERT INTO visit_events (visit_id, stage, detail, actor_id) VALUES (?, 'financial_screening_started', ?, ?)")
      .run(int(req.body.visitId), `Screening ${screeningNo}${free ? ` — counselor ${availableCounselor.name}` : ' — waiting for a counselor'}`, req.user.id);
  }

  audit.log(req, 'create', 'financial_screening', info.lastInsertRowid, { screeningNo });
  res.status(201).json({
    screening: db.prepare('SELECT * FROM financial_screenings WHERE id = ?').get(info.lastInsertRowid),
    counselorAvailable: free,
    nextStep: free ? 'counselor_calls_patient' : 'waiting_room',
  });
}));

/** "Counselor Calls Patient" — claims a case from the waiting queue. */
router.post('/screenings/:id/claim', requireRole('counselor'), wrap((req, res) => {
  const id = int(req.params.id);
  const s = db.prepare('SELECT * FROM financial_screenings WHERE id = ?').get(id);
  if (!s) throw notFound('Screening not found');
  if (['completed', 'declined'].includes(s.status)) throw conflict('This screening is already closed.');
  db.prepare("UPDATE financial_screenings SET counselor_id = ?, status = 'with_counselor' WHERE id = ?")
    .run(req.user.id, id);
  audit.log(req, 'claim', 'financial_screening', id);
  res.json(db.prepare('SELECT * FROM financial_screenings WHERE id = ?').get(id));
}));

/**
 * "Run Eligible Programs Web Form" + "Determine Sliding Scale Position".
 * Without proof of income the case is parked at docs_pending rather than
 * being given a band it cannot substantiate.
 */
router.post('/screenings/:id/assess', requireRole('counselor', 'reception', 'cashier'), wrap((req, res) => {
  const id = int(req.params.id);
  const s = db.prepare('SELECT * FROM financial_screenings WHERE id = ?').get(id);
  if (!s) throw notFound('Screening not found');

  const householdSize = int(req.body.householdSize, 1) || 1;
  const annualIncome = num(req.body.annualIncome, 0);
  const hasProof = bool(req.body.hasProofOfIncome, false);
  const uninsured = bool(req.body.uninsured, Boolean(s.uninsured));

  const result = slidingScale.assess({ annualIncome, householdSize, uninsured, hasProof });

  db.prepare(
    `UPDATE financial_screenings
        SET household_size = ?, annual_income = ?, fpl_pct = ?, has_proof_of_income = ?, proof_type = ?,
            uninsured = ?, eligible_programs = ?, sliding_scale_band = ?, discount_pct = ?,
            status = ?, notes = COALESCE(?, notes)
      WHERE id = ?`
  ).run(householdSize, annualIncome, result.fplPct, hasProof ? 1 : 0, str(req.body.proofType),
        uninsured ? 1 : 0, JSON.stringify(result.eligiblePrograms.map((p) => p.code)),
        result.band, result.discountPct,
        hasProof ? 'with_counselor' : 'docs_pending', str(req.body.notes), id);

  audit.log(req, 'assess', 'financial_screening', id, { fplPct: result.fplPct, band: result.band });
  res.json({
    screening: db.prepare('SELECT * FROM financial_screenings WHERE id = ?').get(id),
    assessment: result,
    nextStep: hasProof ? 'present_options' : 'collect_proof_of_income',
    note: hasProof ? null
      : 'No pay stub or valid proof of income on file — collect documents before assigning a sliding-scale band.',
  });
}));

/** Live calculator for the counselor screen — does not persist anything. */
router.post('/sliding-scale/preview', screeningRoles, wrap((req, res) => {
  res.json(slidingScale.assess({
    annualIncome: num(req.body.annualIncome, 0),
    householdSize: int(req.body.householdSize, 1) || 1,
    uninsured: bool(req.body.uninsured, true),
    hasProof: bool(req.body.hasProofOfIncome, true),
  }));
}));

/**
 * "Present Financial Assistance Options" → "Patient Decides To Continue?".
 * Continue  → band and program are written onto the patient record.
 * Decline   → the visit ends here, which the chart routes straight to exit.
 */
router.post('/screenings/:id/decide', screeningRoles, wrap((req, res) => {
  const id = int(req.params.id);
  required(req.body, ['decision']);
  const decision = str(req.body.decision);
  if (!['continue', 'defer', 'decline'].includes(decision)) {
    throw conflict('decision must be one of: continue, defer, decline');
  }
  const s = db.prepare('SELECT * FROM financial_screenings WHERE id = ?').get(id);
  if (!s) throw notFound('Screening not found');

  const programId = int(req.body.assistanceProgramId) || null;
  const status = decision === 'continue' ? 'completed' : decision === 'defer' ? 'deferred' : 'declined';

  db.prepare(
    `UPDATE financial_screenings
        SET patient_decision = ?, assistance_program_id = ?, status = ?, notes = COALESCE(?, notes),
            completed_at = datetime('now')
      WHERE id = ?`
  ).run(decision, programId, status, str(req.body.notes), id);

  if (decision === 'continue') {
    db.prepare('UPDATE patients SET sliding_scale_band = ?, assistance_program_id = ? WHERE id = ?')
      .run(s.sliding_scale_band, programId, s.patient_id);
    if (s.visit_id) {
      db.prepare("UPDATE visits SET status = 'checked_in' WHERE id = ? AND status = 'financial_screening'").run(s.visit_id);
    }
  } else if (s.visit_id) {
    // Patient chose not to proceed — the workflow sends them to the exit.
    db.prepare("UPDATE visits SET status = 'checked_out', checked_out_at = datetime('now') WHERE id = ? AND status = 'financial_screening'")
      .run(s.visit_id);
  }

  if (s.visit_id) {
    db.prepare("INSERT INTO visit_events (visit_id, stage, detail, actor_id) VALUES (?, 'financial_decision', ?, ?)")
      .run(s.visit_id, `Patient decided to ${decision}`, req.user.id);
  }

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(s.patient_id);
  const to = patient.whatsapp || patient.phone;
  if (to && decision === 'continue') {
    const programs = JSON.parse(s.eligible_programs || '[]').join(', ');
    whatsapp.notify({
      to, template: 'financial_assistance', refType: 'financial_screening', refId: id,
      data: { screeningNo: s.screening_no, band: s.sliding_scale_band, discountPct: s.discount_pct, programs },
    });
  }

  audit.log(req, 'decide', 'financial_screening', id, { decision });
  res.json({
    screening: db.prepare('SELECT * FROM financial_screenings WHERE id = ?').get(id),
    nextStep: decision === 'continue' ? 'waiting_room' : 'patient_leaves',
  });
}));

router.get('/screenings/:id', screeningRoles, wrap((req, res) => {
  const s = db.prepare(
    `SELECT fs.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            u.name AS counselor_name, ap.name AS program_name, ap.coverage_pct
       FROM financial_screenings fs JOIN patients p ON p.id = fs.patient_id
       LEFT JOIN users u ON u.id = fs.counselor_id
       LEFT JOIN assistance_programs ap ON ap.id = fs.assistance_program_id
      WHERE fs.id = ?`
  ).get(int(req.params.id));
  if (!s) throw notFound('Screening not found');
  s.eligible_programs_detail = db.prepare(
    `SELECT * FROM assistance_programs WHERE code IN (${
      JSON.parse(s.eligible_programs || '[]').map(() => '?').join(',') || "''"}
    )`
  ).all(...JSON.parse(s.eligible_programs || '[]'));
  res.json(s);
}));

module.exports = router;
