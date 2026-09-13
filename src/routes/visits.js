'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, conflict, badRequest } = require('../lib/http');
const { requireRole, seesMoney, seesPrices } = require('../lib/auth');
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
/*
 * The lanes a patient passes through, in the order the clinic works them.
 *
 *   front desk -> cashier (consultation fee) -> nurse -> doctor
 *      -> nothing further:  pharmacy -> pay there -> out
 *      -> tests ordered:    cashier (pay for them) -> lab -> pharmacy -> out
 *
 * The clinic is paid as the patient goes rather than reckoned up at the end,
 * and that is the whole shape of this list. The consultation is paid for on
 * the way in, which is why `fee_pending` sits before the nurse station: a
 * patient reaches the nurse only once the counter has taken it. Diagnostics
 * are paid for before the bench will touch them, which is why the cashier now
 * sits ahead of the lab rather than after it. Medicines are paid for at the
 * counter that hands them over, which is why the pharmacy is last and takes
 * its own money.
 *
 * `financial_screening` used to be a lane of its own, entered on the way in
 * whenever a patient was uninsured. It is no longer part of anybody's walk
 * through the building: means-testing is a conversation the clinic has when
 * it decides to, not a turnstile every uninsured patient is put through, so
 * it lives on the management side now. The status is still accepted so that
 * visits recorded under it still read.
 */
const STAGES = ['waiting_room', 'checked_in', 'vitals_done', 'with_provider',
  'billing_pending', 'labs_pending', 'pharmacy_pending', 'checked_out'];

/**
 * Has the consultation been paid for?
 *
 * Answered from the visit's own trail rather than by arithmetic on the bill,
 * and both halves of that matter.
 *
 * Arithmetic would have to compare what the consultation line was billed at
 * against what has been paid — and a patient on a sliding-scale band pays less
 * than the line says by design, so they would never satisfy it and would be
 * turned away at the nurse station for having a concession. Then diagnostics
 * land on the same invoice later in the morning, the balance goes positive
 * again, and a visit that was through the counter hours ago would look unpaid.
 *
 * The counter taking the fee is an event, so it is recorded as one, and the
 * question is simply whether it happened.
 */
function consultationPaid(visitId) {
  return Boolean(db.prepare(
    "SELECT 1 FROM visit_events WHERE visit_id = ? AND stage = 'consultation_fee_paid' LIMIT 1"
  ).get(visitId));
}

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
 * nurse station live on, mirroring the workflow lanes left to right.
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
            (SELECT fs.status FROM financial_screenings fs WHERE fs.visit_id = v.id ORDER BY fs.id DESC LIMIT 1) AS screening_status,
            -- Which side of the first counter they are on: the board shows the
            -- patient waiting to pay apart from the one waiting for the nurse.
            EXISTS (SELECT 1 FROM visit_events ve
                     WHERE ve.visit_id = v.id AND ve.stage = 'consultation_fee_paid') AS consultation_paid
       FROM visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN users u ON u.id = v.doctor_id
       LEFT JOIN departments d ON d.id = v.department_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = v.doctor_id
      WHERE date(v.arrived_at) = ?
      ORDER BY CASE v.status WHEN 'checked_out' THEN 1 ELSE 0 END, v.token_no, v.id`
  ).all(date);

  for (const r of rows) r.consultation_paid = Boolean(r.consultation_paid);
  // The "₹ due" flag on a card belongs to the desks that would collect it.
  if (!seesMoney(req.user)) for (const r of rows) r.invoice_balance = null;

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

  /*
   * Being uninsured no longer diverts anybody. It is still worth knowing and
   * is still flagged, so the counsellor can pick the patient up if the clinic
   * wants to — but somebody who has come in with a fever is not held at a
   * means-testing desk on the way past.
   */
  const mayNeedHelp = bool(req.body.needsFinancialAssistance,
    Boolean(patient.is_uninsured) || financialChanged);
  if (mayNeedHelp) {
    recordEvent(visitId, 'assistance_flagged',
      patient.is_uninsured ? 'Patient is uninsured' : 'Financial situation changed', req.user.id);
  }

  audit.log(req, 'arrive', 'visit', visitId, { visitNo, isNew });
  res.status(201).json({
    visit: db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId),
    nextStep: 'check_in',
    flags: {
      isNewPatient: isNew, needsPaperwork: isNew, screeningDue: dueScreening,
      mayNeedFinancialHelp: mayNeedHelp,
    },
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
  // The cashier, not the nurse: the consultation is paid for on the way in.
  res.json({ visit: updated, nextStep: 'consultation_fee' });
}));

/**
 * The consultation fee, taken on the way in.
 *
 * This is the cashier's step between the front desk and the nurse station. It
 * bills the fee off the published rate card — not the doctor's own profile,
 * which is a figure nobody agreed — and takes it in full, because the counter
 * does not take part of a bill.
 *
 * Everything the patient owes for this visit goes on the one invoice, so a
 * diagnostic priced later in the morning lands beside the consultation rather
 * than on a second bill the patient has to be found again for.
 */
router.post('/:id/consultation-fee', requireRole('cashier'), wrap((req, res) => {
  const id = int(req.params.id);
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  if (!visit) throw notFound('Visit not found');
  if (visit.status === 'checked_out') throw conflict('This visit is already closed.');
  if (consultationPaid(id)) throw conflict('The consultation fee has already been collected for this visit.');

  const card = db.prepare('SELECT price FROM services WHERE code = ? AND active = 1')
    .get(visit.is_new_patient ? 'CONS-NEW' : 'CONS-FU');
  const profile = visit.doctor_id
    ? db.prepare('SELECT * FROM doctor_profiles WHERE user_id = ?').get(visit.doctor_id) : null;
  const fee = card && card.price > 0
    ? card.price
    : (visit.is_new_patient
      ? (profile ? profile.consult_fee : 0)
      : (profile ? (profile.follow_up_fee || profile.consult_fee) : 0));
  if (!(fee > 0)) {
    throw badRequest('No consultation rate is set. Price CONS-NEW and CONS-FU under Services & Rates first.');
  }

  let invoice = db.prepare(
    `SELECT * FROM invoices
      WHERE visit_id = ? AND status NOT IN ('cancelled') AND kind != 'pharmacy'
      ORDER BY id DESC LIMIT 1`
  ).get(id);
  if (!invoice) {
    invoice = billing.createInvoice({
      patientId: visit.patient_id, visitId: id, kind: 'opd', createdBy: req.user.id,
    });
  }

  const doctor = visit.doctor_id
    ? db.prepare('SELECT name FROM users WHERE id = ?').get(visit.doctor_id) : null;
  const consultation = db.prepare('SELECT id FROM consultations WHERE visit_id = ?').get(id);
  if (!billing.hasItem(invoice.id, 'consultation', consultation ? consultation.id : id)) {
    billing.addItem(invoice.id, {
      refType: 'consultation', refId: consultation ? consultation.id : id,
      description: `Consultation — ${doctor ? doctor.name : 'Doctor'}`
        + (visit.is_new_patient ? ' (new patient)' : ' (follow-up)'),
      qty: 1, unitPrice: fee,
    });
  }

  /*
   * The patient's concession, applied before the money is taken rather than
   * after it.
   *
   * The bill used to be reckoned up on the way out, so the band could be
   * applied at the end and still reach the right figure. Now that the fee is
   * collected on the way in, a band applied later would mean a patient who
   * had already handed over the full amount was owed some of it back — the
   * clinic quietly holding money belonging to exactly the people the sliding
   * scale exists for. So it is applied here, and they pay the discounted fee.
   */
  const screening = db.prepare(
    "SELECT * FROM financial_screenings WHERE patient_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1"
  ).get(visit.patient_id);
  if (screening && screening.discount_pct > 0) {
    billing.applySlidingScale(invoice.id, screening.discount_pct);
  }

  const fresh = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id);
  const { receiptNo } = billing.addPayment(invoice.id, {
    patientId: visit.patient_id, amount: fresh.balance,
    mode: str(req.body.mode, 'cash'), reference: str(req.body.reference),
    receivedBy: req.user.id,
  });

  advance(id, 'checked_in');
  recordEvent(id, 'consultation_fee_paid',
    `${fresh.balance.toFixed(2)} collected of ${fee.toFixed(2)} — receipt ${receiptNo}`, req.user.id);
  audit.log(req, 'consultation_fee', 'visit', id, { invoiceId: invoice.id, fee, receiptNo });

  res.status(201).json({
    receiptNo, fee, collected: fresh.balance,
    invoice: billing.fullInvoice(invoice.id), nextStep: 'vitals',
  });
}));

// ---------------------------------------------------------------- 3. vitals
/** "Take Patient to the Nurse Station" → "Check Vitals". */
router.post('/:id/vitals', requireRole('nurse', 'doctor'), wrap((req, res) => {
  const id = int(req.params.id);
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  if (!visit) throw notFound('Visit not found');

  /*
   * The consultation is paid for before the nurse station, so this is where
   * that is actually enforced — a rule in the browser is not a rule. A ward
   * patient's observations are not part of an out-patient walk and are taken
   * on the IPD chart, so they never come through here.
   */
  if (!consultationPaid(id)) {
    throw conflict(
      'The consultation fee has not been collected yet. '
      + 'Send the patient to the cashier — the nurse station is after the counter.'
    );
  }

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

  /*
   * Where the patient goes when the doctor is done, which is the fork the
   * whole flow turns on.
   *
   * Tests ordered — back to the cashier. Nothing reaches the bench until it
   * has been paid for, so sending them to the lab first would only be sending
   * them to a counter that has to turn them away.
   *
   * Nothing ordered — the pharmacy, where the medicines are handed over and
   * paid for at the same counter, and the visit ends. With no prescription
   * either there is nothing left to do but close it at the desk.
   */
  const next = labsOpen ? 'billing_pending' : (rxPending ? 'pharmacy_pending' : 'billing_pending');
  advance(id, next);
  recordEvent(id, 'consultation_signed', `Labs open: ${labsOpen}, prescriptions pending: ${rxPending}`, req.user.id);
  audit.log(req, 'sign', 'consultation', c.id);

  res.json({
    ok: true, labsOpen, rxPending,
    nextStep: labsOpen ? 'billing' : (rxPending ? 'pharmacy' : 'checkout'),
  });
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
  const payload = {
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
    // The hospital bill; the pharmacy's is settled at its own counter.
    invoice: db.prepare(
      "SELECT * FROM invoices WHERE visit_id = ? AND kind != 'pharmacy' ORDER BY id DESC LIMIT 1"
    ).get(id) || null,
    screening: db.prepare('SELECT * FROM financial_screenings WHERE visit_id = ? ORDER BY id DESC LIMIT 1').get(id) || null,
    timeline: db.prepare('SELECT ve.*, u.name AS actor_name FROM visit_events ve LEFT JOIN users u ON u.id = ve.actor_id WHERE ve.visit_id = ? ORDER BY ve.id').all(id),
  };
  if (!seesPrices(req.user)) for (const o of payload.labOrders) o.total_price = null;
  if (!seesMoney(req.user)) payload.invoice = null;
  res.json(payload);
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
  visit.invoices = seesMoney(req.user)
    ? db.prepare('SELECT * FROM invoices WHERE visit_id = ? ORDER BY id').all(id) : [];
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
router.post('/:id/prepare-bill', requireRole('cashier'), wrap((req, res) => {
  const id = int(req.params.id);
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  if (!visit) throw notFound('Visit not found');

  /*
   * The hospital bill for this visit, which is not simply the latest one
   * raised against it: the pharmacy issues its own bill on the same visit and
   * takes its own money, so picking the most recent invoice would pile the
   * consultation and the diagnostics onto the medicine bill the patient has
   * already paid at another counter.
   */
  let invoice = db.prepare(
    `SELECT * FROM invoices
      WHERE visit_id = ? AND status NOT IN ('cancelled') AND kind != 'pharmacy'
      ORDER BY id DESC LIMIT 1`
  ).get(id);
  if (!invoice) {
    invoice = billing.createInvoice({ patientId: visit.patient_id, visitId: id, kind: 'opd', createdBy: req.user.id });
  }

  /*
   * The consultation fee, off the published rate card.
   *
   * This used to come from the doctor's own profile, which quietly put the
   * commonest line on every bill outside the tariff altogether: the clinic
   * published a card saying a new consultation is 150, and bills went on
   * charging whatever figure had been sitting on that doctor's profile since
   * the day they were set up. One rate card, one rate — so the services row
   * decides, and the profile is the fallback for a clinic that has not priced
   * consultations at all.
   */
  const consultation = db.prepare('SELECT * FROM consultations WHERE visit_id = ?').get(id);
  if (consultation && !billing.hasItem(invoice.id, 'consultation', consultation.id)) {
    const profile = db.prepare('SELECT * FROM doctor_profiles WHERE user_id = ?').get(visit.doctor_id);
    const card = db.prepare('SELECT price FROM services WHERE code = ? AND active = 1')
      .get(visit.is_new_patient ? 'CONS-NEW' : 'CONS-FU');
    const fallback = visit.is_new_patient
      ? (profile ? profile.consult_fee : 0)
      : (profile ? (profile.follow_up_fee || profile.consult_fee) : 0);
    const fee = card && card.price > 0 ? card.price : fallback;
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
router.post('/:id/check-out', requireRole('cashier'), wrap((req, res) => {
  const id = int(req.params.id);
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  if (!visit) throw notFound('Visit not found');
  if (visit.status === 'checked_out') throw conflict('This visit is already checked out.');

  /*
   * Every hospital bill on this visit has to be settled, not merely the last
   * one raised — and a pharmacy bill is not the cashier's to hold anybody for.
   * The patient pays for their medicines at the counter that hands them over,
   * so blocking check-out on that bill would stop them at a desk they have
   * already finished with and make them pay twice over in queueing.
   */
  const unsettled = db.prepare(
    `SELECT * FROM invoices
      WHERE visit_id = ? AND status NOT IN ('cancelled') AND kind != 'pharmacy'
        AND balance > 0.009
      ORDER BY id`
  ).all(id);

  for (const invoice of unsettled) {
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

  /*
   * The visit closes here even when medicines are still to be collected.
   *
   * The pharmacy is the last lane but it is not a gate: a patient may take
   * their prescription and come back for it on Friday, or fill it somewhere
   * else entirely. Holding the visit open for that would leave the queue board
   * showing people who went home days ago, and would make the clinic's own
   * day-end depend on a purchase the patient has not decided to make. The
   * prescription stays on the pharmacy's queue for as long as it goes
   * undispensed, which is where that waiting belongs.
   */
  const rxWaiting = db.prepare(
    "SELECT COUNT(*) AS c FROM prescriptions WHERE visit_id = ? AND status = 'pending'"
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
    note: [
      openLabs ? `${openLabs} diagnostic order(s) still pending — the report will be messaged when ready.` : '',
      rxWaiting ? `${rxWaiting} medicine(s) to collect at the pharmacy, paid for there. `
        + 'The prescription stays on their queue if the patient comes back another day.' : '',
    ].filter(Boolean).join(' ') || null,
  });
}));

module.exports = router;
