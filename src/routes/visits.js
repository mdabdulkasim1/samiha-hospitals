'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, conflict, badRequest } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, num, bool, paging } = require('../lib/validate');
const { generate } = require('../lib/ids');
const scheduling = require('../services/scheduling');
const billing = require('../services/billing');
const whatsapp = require('../services/whatsapp');
const audit = require('../lib/audit');

const vitalsService = require('../services/vitals');

const router = express.Router();
const clinicalRoles = requireRole('reception', 'nurse', 'doctor', 'counselor', 'cashier', 'lab', 'pharmacy');

// The workflow stages, in the order a patient moves through them.
const STAGES = ['waiting_room', 'financial_screening', 'checked_in', 'vitals_done', 'with_provider',
  'labs_pending', 'pharmacy_pending', 'billing_pending', 'checked_out'];

function recordEvent(visitId, stage, detail, actorId) {
  db.prepare('INSERT INTO visit_events (visit_id, stage, detail, actor_id) VALUES (?, ?, ?, ?)')
    .run(visitId, stage, detail || null, actorId || null);
}

/** Only ever move a visit forward — a nurse re-saving vitals must not rewind it. */
function advance(visitId, stage) {
  const visit = db.prepare('SELECT status FROM visits WHERE id = ?').get(visitId);
  if (!visit) return;
  const from = STAGES.indexOf(visit.status);
  const to = STAGES.indexOf(stage);
  if (to > from) db.prepare('UPDATE visits SET status = ? WHERE id = ?').run(stage, visitId);
}

function screeningDue(patient) {
  if (!patient.last_screening_date) return true;
  return (Date.now() - new Date(patient.last_screening_date).getTime()) > 365 * 24 * 3600 * 1000;
}

// ------------------------------------------------------------------ live board
/**
 * The waiting-room / queue board. This is the screen the front desk and the
 * vitals station live on, mirroring the workflow lanes left to right.
 */
router.get('/board', clinicalRoles, wrap((req, res) => {
  const date = str(req.query.date) || scheduling.dateKey(new Date());
  const rows = db.prepare(
    `SELECT v.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name, '')) AS patient_name,
            p.age_years, p.gender, p.phone, p.whatsapp, p.allergies,
            u.name AS doctor_name, d.name AS department_name, dp.room_no,
            (SELECT COUNT(*) FROM lab_orders lo WHERE lo.visit_id = v.id AND lo.status NOT IN ('reported','cancelled')) AS labs_open,
            (SELECT COUNT(*) FROM prescriptions rx WHERE rx.visit_id = v.id AND rx.status = 'pending') AS rx_pending,
            (SELECT i.id FROM invoices i WHERE i.visit_id = v.id ORDER BY i.id DESC LIMIT 1) AS invoice_id,
            (SELECT i.balance FROM invoices i WHERE i.visit_id = v.id ORDER BY i.id DESC LIMIT 1) AS invoice_balance,
            (SELECT fs.status FROM financial_screenings fs WHERE fs.visit_id = v.id ORDER BY fs.id DESC LIMIT 1) AS screening_status
       FROM visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN users u ON u.id = v.doctor_id
       LEFT JOIN departments d ON d.id = v.department_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = v.doctor_id
      WHERE date(v.arrived_at) = ?
      ORDER BY CASE v.status WHEN 'checked_out' THEN 1 ELSE 0 END, v.token_no, v.id`
  ).all(date);

  const counts = {};
  for (const s of STAGES) counts[s] = 0;
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

  res.json({ date, stages: STAGES, counts, rows });
}));

router.get('/', clinicalRoles, wrap((req, res) => {
  const { limit, offset, page } = paging(req.query, 50);
  const status = str(req.query.status);
  const patientId = req.query.patientId ? int(req.query.patientId) : null;
  const rows = db.prepare(
    `SELECT v.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name, u.name AS doctor_name
       FROM visits v JOIN patients p ON p.id = v.patient_id LEFT JOIN users u ON u.id = v.doctor_id
      WHERE (? IS NULL OR v.status = ?) AND (? IS NULL OR v.patient_id = ?)
      ORDER BY v.id DESC LIMIT ? OFFSET ?`
  ).all(status, status, patientId, patientId, limit, offset);
  res.json({ rows, page, limit });
}));

// -------------------------------------------------------------- 1. arrival
/**
 * "Patient Walk In" / "M.A. Calls Patient".
 * Creates the visit and answers the first two decision diamonds of the chart:
 *   New Patient?  →  Financial Situation Changed?  →  Time for Yearly Screening?
 */
router.post('/arrive', requireRole('reception'), wrap((req, res) => {
  required(req.body, ['patientId']);
  const patientId = int(req.body.patientId);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  if (!patient) throw notFound('Patient not found');
  if (patient.stage === 'enquiry') {
    throw conflict(
      `${patient.first_name} is still an enquiry, not a registered patient. ` +
      'Complete the registration paperwork first — the enquiry record carries over.'
    );
  }

  const open = db.prepare(
    "SELECT * FROM visits WHERE patient_id = ? AND status NOT IN ('checked_out','cancelled')"
  ).get(patientId);
  if (open) throw conflict(`This patient already has an open visit (${open.visit_no}, ${open.status}).`);

  const appointmentId = int(req.body.appointmentId) || null;
  const appt = appointmentId
    ? db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId)
    : null;

  const doctorId = int(req.body.doctorId) || (appt ? appt.doctor_id : null);
  const departmentId = int(req.body.departmentId) ||
    (appt ? appt.department_id : null) ||
    (doctorId ? db.prepare('SELECT department_id FROM users WHERE id = ?').get(doctorId)?.department_id : null);

  const priorVisits = db.prepare('SELECT COUNT(*) AS c FROM visits WHERE patient_id = ?').get(patientId).c;
  const isNew = priorVisits === 0;
  const financialChanged = bool(req.body.financialSituationChanged, false);
  const dueScreening = screeningDue(patient);

  const visitNo = generate('visit');
  const token = appt && appt.token_no
    ? appt.token_no
    : db.prepare("SELECT COALESCE(MAX(token_no),0)+1 AS t FROM visits WHERE date(arrived_at) = date('now')").get().t;

  const info = db.prepare(
    `INSERT INTO visits (visit_no, patient_id, appointment_id, doctor_id, department_id, visit_type,
                         status, token_no, reason_for_visit, is_new_patient, financial_changed, screening_due)
     VALUES (?, ?, ?, ?, ?, ?, 'waiting_room', ?, ?, ?, ?, ?)`
  ).run(visitNo, patientId, appointmentId, doctorId, departmentId, str(req.body.visitType, 'opd'),
        token, str(req.body.reasonForVisit) || (appt ? appt.reason : null),
        isNew ? 1 : 0, financialChanged ? 1 : 0, dueScreening ? 1 : 0);

  const visitId = info.lastInsertRowid;
  if (appointmentId) db.prepare("UPDATE appointments SET status = 'checked_in' WHERE id = ?").run(appointmentId);
  recordEvent(visitId, 'arrived', isNew ? 'New patient — demographic & medical history paperwork required' : 'Returning patient', req.user.id);

  // Decision: uninsured or financial situation changed → financial screening lane.
  const needsScreening = bool(req.body.needsFinancialAssistance,
    Boolean(patient.is_uninsured) || financialChanged);
  if (needsScreening) {
    db.prepare("UPDATE visits SET status = 'financial_screening' WHERE id = ?").run(visitId);
    recordEvent(visitId, 'financial_screening_required',
      patient.is_uninsured ? 'Patient is uninsured' : 'Financial situation changed', req.user.id);
  }

  audit.log(req, 'arrive', 'visit', visitId, { visitNo, isNew, needsScreening });
  res.status(201).json({
    visit: db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId),
    nextStep: needsScreening ? 'financial_screening' : 'check_in',
    flags: { isNewPatient: isNew, needsPaperwork: isNew, screeningDue: dueScreening, needsFinancialScreening: needsScreening },
  });
}));

// -------------------------------------------------------------- 2. check in
/** "Check In" + "Ask reason for visit". */
router.post('/:id/check-in', requireRole('reception'), wrap((req, res) => {
  const id = int(req.params.id);
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  if (!visit) throw notFound('Visit not found');
  if (visit.status === 'checked_out') throw conflict('This visit is already closed.');

  const reason = str(req.body.reasonForVisit) || visit.reason_for_visit;
  if (!reason) throw badRequest('Reason for visit is required at check-in.');

  db.prepare(
    `UPDATE visits SET status = 'checked_in', reason_for_visit = ?, checked_in_at = datetime('now'),
            checked_in_by = ?, doctor_id = COALESCE(?, doctor_id)
      WHERE id = ?`
  ).run(reason, req.user.id, int(req.body.doctorId) || null, id);
  recordEvent(id, 'checked_in', reason, req.user.id);

  const updated = db.prepare(
    `SELECT v.*, u.name AS doctor_name, p.whatsapp, p.phone
       FROM visits v LEFT JOIN users u ON u.id = v.doctor_id JOIN patients p ON p.id = v.patient_id
      WHERE v.id = ?`
  ).get(id);

  const to = updated.whatsapp || updated.phone;
  if (to) {
    whatsapp.notify({
      to, template: 'checked_in', refType: 'visit', refId: id,
      data: { visitNo: updated.visit_no, token: updated.token_no, doctorName: updated.doctor_name || 'the duty doctor' },
    });
  }
  audit.log(req, 'check_in', 'visit', id);
  res.json({ visit: updated, nextStep: 'vitals' });
}));

// ---------------------------------------------------------------- 3. vitals
/** "Take Patient to Vitals Station" → "Check Vitals". */
router.post('/:id/vitals', requireRole('nurse', 'doctor'), wrap((req, res) => {
  const id = int(req.params.id);
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  if (!visit) throw notFound('Visit not found');

  const height = num(req.body.heightCm, 0);
  const weight = num(req.body.weightKg, 0);
  const bmi = height > 0 && weight > 0
    ? Math.round((weight / ((height / 100) ** 2)) * 10) / 10
    : null;

  const info = db.prepare(
    `INSERT INTO vitals (visit_id, patient_id, height_cm, weight_kg, bmi, temp_c, pulse, resp_rate,
                         bp_systolic, bp_diastolic, spo2, blood_sugar, pain_score, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, visit.patient_id, height || null, weight || null, bmi,
        req.body.tempC === undefined ? null : num(req.body.tempC),
        req.body.pulse === undefined ? null : int(req.body.pulse),
        req.body.respRate === undefined ? null : int(req.body.respRate),
        req.body.bpSystolic === undefined ? null : int(req.body.bpSystolic),
        req.body.bpDiastolic === undefined ? null : int(req.body.bpDiastolic),
        req.body.spo2 === undefined ? null : int(req.body.spo2),
        req.body.bloodSugar === undefined ? null : num(req.body.bloodSugar),
        req.body.painScore === undefined ? null : int(req.body.painScore),
        str(req.body.notes), req.user.id);

  db.prepare("UPDATE visits SET vitals_at = datetime('now') WHERE id = ?").run(id);
  advance(id, 'vitals_done');
  recordEvent(id, 'vitals_recorded', `BP ${req.body.bpSystolic || '—'}/${req.body.bpDiastolic || '—'}, pulse ${req.body.pulse || '—'}`, req.user.id);

  const vitals = db.prepare('SELECT * FROM vitals WHERE id = ?').get(info.lastInsertRowid);
  audit.log(req, 'record_vitals', 'visit', id);
  res.status(201).json({ vitals, alerts: vitalsService.alerts(vitals), nextStep: 'consultation' });
}));

// ---------------------------------------------------------- 4. consultation
/**
 * "Provider Gives Clinical Care" — the SOAP note, diagnoses, prescriptions and
 * lab orders are all saved in one transaction so the encounter is never
 * half-recorded.
 */
router.post('/:id/consultation', requireRole('doctor'), wrap((req, res) => {
  const id = int(req.params.id);
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  if (!visit) throw notFound('Visit not found');

  const existing = db.prepare('SELECT * FROM consultations WHERE visit_id = ?').get(id);
  const followUpDays = req.body.followUpDays === undefined || req.body.followUpDays === ''
    ? null : int(req.body.followUpDays);
  const followUpDate = followUpDays
    ? new Date(Date.now() + followUpDays * 86400000).toISOString().slice(0, 10)
    : str(req.body.followUpDate);

  const result = db.transaction(() => {
    let consultationId;
    if (existing) {
      db.prepare(
        `UPDATE consultations SET chief_complaint = ?, subjective = ?, objective = ?, assessment = ?,
                plan = ?, advice = ?, screening_done = ?, referred_to = ?, follow_up_days = ?, follow_up_date = ?
          WHERE id = ?`
      ).run(str(req.body.chiefComplaint), str(req.body.subjective), str(req.body.objective),
            str(req.body.assessment), str(req.body.plan), str(req.body.advice),
            bool(req.body.screeningDone) ? 1 : 0, str(req.body.referredTo),
            followUpDays, followUpDate, existing.id);
      consultationId = existing.id;
      db.prepare('DELETE FROM consultation_diagnoses WHERE consultation_id = ?').run(consultationId);
    } else {
      const info = db.prepare(
        `INSERT INTO consultations (visit_id, patient_id, doctor_id, chief_complaint, subjective, objective,
                                    assessment, plan, advice, screening_done, referred_to, follow_up_days, follow_up_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, visit.patient_id, req.user.id, str(req.body.chiefComplaint), str(req.body.subjective),
            str(req.body.objective), str(req.body.assessment), str(req.body.plan), str(req.body.advice),
            bool(req.body.screeningDone) ? 1 : 0, str(req.body.referredTo), followUpDays, followUpDate);
      consultationId = info.lastInsertRowid;
      db.prepare("UPDATE visits SET consult_start_at = COALESCE(consult_start_at, datetime('now')) WHERE id = ?").run(id);
    }

    for (const d of (req.body.diagnoses || [])) {
      if (!d || !d.title) continue;
      db.prepare('INSERT INTO consultation_diagnoses (consultation_id, icd_code, title, kind) VALUES (?, ?, ?, ?)')
        .run(consultationId, str(d.icdCode), str(d.title), str(d.kind, 'provisional'));
    }

    // Prescriptions — replace the pending set so an edited plan stays consistent.
    if (Array.isArray(req.body.prescriptions)) {
      db.prepare("DELETE FROM prescriptions WHERE consultation_id = ? AND status = 'pending'").run(consultationId);
      for (const rx of req.body.prescriptions) {
        if (!rx || !rx.drugName) continue;
        db.prepare(
          `INSERT INTO prescriptions (consultation_id, visit_id, patient_id, drug_id, drug_name, dose,
                                      frequency, route, duration_days, quantity, instructions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(consultationId, id, visit.patient_id, int(rx.drugId) || null, str(rx.drugName),
              str(rx.dose), str(rx.frequency), str(rx.route, 'oral'),
              rx.durationDays === undefined ? null : int(rx.durationDays),
              num(rx.quantity, 0), str(rx.instructions));
      }
    }

    if (bool(req.body.screeningDone)) {
      db.prepare("UPDATE patients SET last_screening_date = date('now') WHERE id = ?").run(visit.patient_id);
    }
    return consultationId;
  })();

  advance(id, 'with_provider');
  recordEvent(id, 'consultation_saved', str(req.body.assessment) || 'Clinical care given', req.user.id);
  audit.log(req, existing ? 'update' : 'create', 'consultation', result, { visitId: id });

  res.status(existing ? 200 : 201).json(consultationPayload(result));
}));

function consultationPayload(consultationId) {
  const c = db.prepare(
    `SELECT c.*, u.name AS doctor_name FROM consultations c LEFT JOIN users u ON u.id = c.doctor_id WHERE c.id = ?`
  ).get(consultationId);
  if (!c) return null;
  c.diagnoses = db.prepare('SELECT * FROM consultation_diagnoses WHERE consultation_id = ?').all(consultationId);
  c.prescriptions = db.prepare('SELECT * FROM prescriptions WHERE consultation_id = ? ORDER BY id').all(consultationId);
  return c;
}

/** "Provider Signs / Logs Out of NextGen" — locks the note. */
router.post('/:id/consultation/sign', requireRole('doctor'), wrap((req, res) => {
  const id = int(req.params.id);
  const c = db.prepare('SELECT * FROM consultations WHERE visit_id = ?').get(id);
  if (!c) throw notFound('No consultation recorded for this visit yet.');
  db.prepare("UPDATE consultations SET signed_at = datetime('now') WHERE id = ?").run(c.id);
  db.prepare("UPDATE visits SET consult_end_at = datetime('now') WHERE id = ?").run(id);

  const labsOpen = db.prepare(
    "SELECT COUNT(*) AS c FROM lab_orders WHERE visit_id = ? AND status NOT IN ('reported','cancelled')"
  ).get(id).c;
  const rxPending = db.prepare("SELECT COUNT(*) AS c FROM prescriptions WHERE visit_id = ? AND status = 'pending'").get(id).c;

  advance(id, labsOpen ? 'labs_pending' : rxPending ? 'pharmacy_pending' : 'billing_pending');
  recordEvent(id, 'consultation_signed', `Labs open: ${labsOpen}, prescriptions pending: ${rxPending}`, req.user.id);
  audit.log(req, 'sign', 'consultation', c.id);

  res.json({ ok: true, labsOpen, rxPending, nextStep: labsOpen ? 'lab' : rxPending ? 'pharmacy' : 'billing' });
}));

// ---------------------------------------------------------- 5. results page
/**
 * "Provider Gives Results Page to Patient" — the single sheet the patient
 * carries to the check-out desk: orders placed, medication list, follow-up.
 */
router.get('/:id/results-page', clinicalRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const visit = db.prepare(
    `SELECT v.*, p.uhid, p.first_name, p.last_name, p.age_years, p.gender, p.phone, p.allergies,
            p.pharmacy_name, p.pharmacy_phone, u.name AS doctor_name, d.name AS department_name
       FROM visits v JOIN patients p ON p.id = v.patient_id
       LEFT JOIN users u ON u.id = v.doctor_id LEFT JOIN departments d ON d.id = v.department_id
      WHERE v.id = ?`
  ).get(id);
  if (!visit) throw notFound('Visit not found');

  const consultation = db.prepare('SELECT * FROM consultations WHERE visit_id = ?').get(id);
  res.json({
    visit,
    vitals: db.prepare('SELECT * FROM vitals WHERE visit_id = ? ORDER BY id DESC LIMIT 1').get(id) || null,
    consultation: consultation ? consultationPayload(consultation.id) : null,
    labOrders: db.prepare(
      `SELECT o.*, (SELECT GROUP_CONCAT(test_name, ', ') FROM lab_order_items WHERE order_id = o.id) AS tests,
              (SELECT COALESCE(SUM(price),0) FROM lab_order_items WHERE order_id = o.id) AS total_price
         FROM lab_orders o WHERE o.visit_id = ? ORDER BY o.id`
    ).all(id),
    // "M.A. Prints Medication List"
    medicationList: db.prepare('SELECT * FROM prescriptions WHERE visit_id = ? ORDER BY id').all(id),
    invoice: db.prepare('SELECT * FROM invoices WHERE visit_id = ? ORDER BY id DESC LIMIT 1').get(id) || null,
    screening: db.prepare('SELECT * FROM financial_screenings WHERE visit_id = ? ORDER BY id DESC LIMIT 1').get(id) || null,
    timeline: db.prepare('SELECT ve.*, u.name AS actor_name FROM visit_events ve LEFT JOIN users u ON u.id = ve.actor_id WHERE ve.visit_id = ? ORDER BY ve.id').all(id),
  });
}));

router.get('/:id', clinicalRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const visit = db.prepare(
    `SELECT v.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            p.age_years, p.gender, p.phone, p.whatsapp, p.allergies, p.chronic_conditions,
            p.is_uninsured, p.sliding_scale_band, p.pharmacy_name, p.pharmacy_phone,
            u.name AS doctor_name, d.name AS department_name
       FROM visits v JOIN patients p ON p.id = v.patient_id
       LEFT JOIN users u ON u.id = v.doctor_id LEFT JOIN departments d ON d.id = v.department_id
      WHERE v.id = ?`
  ).get(id);
  if (!visit) throw notFound('Visit not found');

  const consultation = db.prepare('SELECT * FROM consultations WHERE visit_id = ?').get(id);
  visit.vitals = db.prepare('SELECT * FROM vitals WHERE visit_id = ? ORDER BY id DESC').all(id);
  visit.consultation = consultation ? consultationPayload(consultation.id) : null;
  visit.labOrders = db.prepare(
    `SELECT o.*, (SELECT GROUP_CONCAT(test_name, ', ') FROM lab_order_items WHERE order_id = o.id) AS tests
       FROM lab_orders o WHERE o.visit_id = ? ORDER BY o.id`
  ).all(id);
  visit.prescriptions = db.prepare('SELECT * FROM prescriptions WHERE visit_id = ? ORDER BY id').all(id);
  visit.invoices = db.prepare('SELECT * FROM invoices WHERE visit_id = ? ORDER BY id').all(id);
  visit.screening = db.prepare('SELECT * FROM financial_screenings WHERE visit_id = ? ORDER BY id DESC LIMIT 1').get(id) || null;
  visit.timeline = db.prepare(
    'SELECT ve.*, u.name AS actor_name FROM visit_events ve LEFT JOIN users u ON u.id = ve.actor_id WHERE ve.visit_id = ? ORDER BY ve.id'
  ).all(id);
  res.json(visit);
}));

// ------------------------------------------------------------- 6. check out
/**
 * "Patient Gives Results Page To Check Out Desk" → assemble the bill.
 * Consultation fee, lab orders and any un-billed services are pulled onto one
 * invoice, then the sliding-scale discount and assistance coverage are applied.
 */
router.post('/:id/prepare-bill', requireRole('cashier', 'reception'), wrap((req, res) => {
  const id = int(req.params.id);
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  if (!visit) throw notFound('Visit not found');

  let invoice = db.prepare("SELECT * FROM invoices WHERE visit_id = ? AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 1").get(id);
  if (!invoice) {
    invoice = billing.createInvoice({ patientId: visit.patient_id, visitId: id, kind: 'opd', createdBy: req.user.id });
  }

  // Consultation fee
  const consultation = db.prepare('SELECT * FROM consultations WHERE visit_id = ?').get(id);
  if (consultation && !billing.hasItem(invoice.id, 'consultation', consultation.id)) {
    const profile = db.prepare('SELECT * FROM doctor_profiles WHERE user_id = ?').get(visit.doctor_id);
    const fee = visit.is_new_patient
      ? (profile ? profile.consult_fee : 0)
      : (profile ? (profile.follow_up_fee || profile.consult_fee) : 0);
    const doctor = db.prepare('SELECT name FROM users WHERE id = ?').get(visit.doctor_id);
    if (fee > 0) {
      billing.addItem(invoice.id, {
        refType: 'consultation', refId: consultation.id,
        description: `Consultation — ${doctor ? doctor.name : 'Doctor'}${visit.is_new_patient ? ' (new patient)' : ' (follow-up)'}`,
        qty: 1, unitPrice: fee,
      });
    }
  }

  // Lab / radiology orders placed during the visit
  for (const item of db.prepare(
    `SELECT i.* FROM lab_order_items i JOIN lab_orders o ON o.id = i.order_id
      WHERE o.visit_id = ? AND i.status != 'cancelled'`
  ).all(id)) {
    if (!billing.hasItem(invoice.id, 'lab', item.id) && item.price > 0) {
      billing.addItem(invoice.id, { refType: 'lab', refId: item.id, description: `Diagnostic — ${item.test_name}`, qty: 1, unitPrice: item.price });
    }
  }

  // Any extra services keyed in by the desk
  for (const s of (req.body.services || [])) {
    const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(int(s.serviceId));
    if (!svc) continue;
    billing.addItem(invoice.id, {
      refType: 'service', refId: svc.id, description: svc.name,
      qty: num(s.qty, 1) || 1, unitPrice: num(s.unitPrice, svc.price), taxPct: svc.tax_pct,
    });
  }

  // Apply the sliding-scale band from a completed financial screening.
  const screening = db.prepare(
    "SELECT * FROM financial_screenings WHERE patient_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1"
  ).get(visit.patient_id);
  if (screening && screening.discount_pct > 0) {
    billing.applySlidingScale(invoice.id, screening.discount_pct);
  }
  if (screening && screening.assistance_program_id) {
    const program = db.prepare('SELECT * FROM assistance_programs WHERE id = ?').get(screening.assistance_program_id);
    if (program && program.coverage_pct > 0) {
      const fresh = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id);
      const base = Math.max(fresh.gross - fresh.discount - fresh.sliding_discount, 0);
      billing.applyAssistance(invoice.id, base * (program.coverage_pct / 100));
    }
  }

  db.prepare("UPDATE visits SET billing_at = datetime('now') WHERE id = ?").run(id);
  advance(id, 'billing_pending');
  recordEvent(id, 'bill_prepared', `Invoice ${invoice.invoice_no}`, req.user.id);
  audit.log(req, 'prepare_bill', 'invoice', invoice.id, { visitId: id });

  res.json(billing.fullInvoice(invoice.id));
}));

/**
 * "Patient Leaves" — the final gate. Refuses to close a visit that still has an
 * unsettled balance unless a payment plan or a documented exception exists,
 * which is exactly the No / "No, or Not Completely" branch of the chart.
 */
router.post('/:id/check-out', requireRole('cashier', 'reception'), wrap((req, res) => {
  const id = int(req.params.id);
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  if (!visit) throw notFound('Visit not found');
  if (visit.status === 'checked_out') throw conflict('This visit is already checked out.');

  const invoice = db.prepare("SELECT * FROM invoices WHERE visit_id = ? AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 1").get(id);
  if (invoice && invoice.balance > 0.009) {
    const hasPlan = db.prepare('SELECT 1 FROM payment_plans WHERE invoice_id = ? AND status = ?').get(invoice.id, 'active');
    const hasException = db.prepare('SELECT 1 FROM payment_exceptions WHERE invoice_id = ?').get(invoice.id);
    if (!hasPlan && !hasException && !bool(req.body.force)) {
      throw conflict(
        `Outstanding balance of ${invoice.balance.toFixed(2)} on ${invoice.invoice_no}. ` +
        `Record a payment, a payment-plan agreement, or a documented payment exception before check-out.`
      );
    }
  }

  const openLabs = db.prepare(
    "SELECT COUNT(*) AS c FROM lab_orders WHERE visit_id = ? AND status IN ('ordered','sample_collected')"
  ).get(id).c;

  const exitPass = generate('exitPass');
  db.prepare(
    `UPDATE visits SET status = 'checked_out', checked_out_at = datetime('now'),
            checked_out_by = ?, exit_pass_no = ? WHERE id = ?`
  ).run(req.user.id, exitPass, id);
  if (visit.appointment_id) {
    db.prepare("UPDATE appointments SET status = 'completed' WHERE id = ?").run(visit.appointment_id);
  }
  recordEvent(id, 'checked_out', `Exit pass ${exitPass}`, req.user.id);

  // "Schedule Future Appointments" — book the follow-up in the same action.
  let followUp = null;
  if (req.body.followUp && req.body.followUp.doctorId && req.body.followUp.scheduledAt) {
    const fu = req.body.followUp;
    const at = str(fu.scheduledAt).replace('T', ' ').slice(0, 19).padEnd(19, ':00').slice(0, 19);
    if (scheduling.isSlotFree(int(fu.doctorId), at)) {
      const apptNo = generate('appointment');
      const token = scheduling.nextToken(int(fu.doctorId), at.slice(0, 10));
      const info = db.prepare(
        `INSERT INTO appointments (appt_no, patient_id, doctor_id, department_id, scheduled_at, token_no,
                                   visit_kind, source, status, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'follow_up', 'reception', 'booked', ?, ?)`
      ).run(apptNo, visit.patient_id, int(fu.doctorId), visit.department_id, at, token,
            str(fu.reason, 'Review after this visit'), req.user.id);
      followUp = db.prepare('SELECT * FROM appointments WHERE id = ?').get(info.lastInsertRowid);
      recordEvent(id, 'follow_up_scheduled', `${apptNo} — ${scheduling.humanDateTime(at)}`, req.user.id);
    }
  }

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(visit.patient_id);
  const to = patient.whatsapp || patient.phone;
  if (to) {
    const doctor = db.prepare('SELECT name FROM users WHERE id = ?').get(visit.doctor_id);
    whatsapp.notify({
      to, template: 'visit_summary', refType: 'visit', refId: id,
      data: {
        visitNo: visit.visit_no, doctorName: doctor ? doctor.name : 'our team',
        followUp: followUp ? scheduling.humanDateTime(followUp.scheduled_at) : null,
      },
    });
  }

  audit.log(req, 'check_out', 'visit', id, { exitPass });
  res.json({
    ok: true, exitPassNo: exitPass,
    visit: db.prepare('SELECT * FROM visits WHERE id = ?').get(id),
    followUp,
    pendingReports: openLabs,
    note: openLabs ? `${openLabs} diagnostic order(s) still pending — the report will be messaged when ready.` : null,
  });
}));

module.exports = router;
