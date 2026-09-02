'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, conflict, badRequest } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, num, money, bool, paging } = require('../lib/validate');
const { generate } = require('../lib/ids');
const insurance = require('../services/insurance');
const billing = require('../services/billing');
const whatsapp = require('../services/whatsapp');
const audit = require('../lib/audit');

const router = express.Router();

// The TPA desk in a polyclinic is the billing counter; doctors write the
// clinical justification on a pre-auth, so they can read and edit that part.
const deskRoles = requireRole('cashier', 'reception', 'counselor');
const viewRoles = requireRole('cashier', 'reception', 'counselor', 'doctor', 'ward', 'nurse');

// ============================================================ insurers / TPAs
router.get('/insurers', viewRoles, wrap((req, res) => {
  const kind = str(req.query.kind);
  res.json(db.prepare(
    `SELECT i.*, adm.name AS administered_by_name,
            (SELECT COUNT(*) FROM patient_policies pp WHERE pp.insurer_id = i.id) AS policy_count,
            (SELECT COUNT(*) FROM claims c WHERE c.insurer_id = i.id
              AND c.status NOT IN ('settled','rejected','closed','cancelled')) AS open_claims,
            (SELECT COALESCE(SUM(c.approved_amount - c.settled_amount), 0) FROM claims c
              WHERE c.insurer_id = i.id AND c.status IN ('approved','partially_settled','submitted','under_process')) AS receivable
       FROM insurers i
       LEFT JOIN insurers adm ON adm.id = i.administered_by
      WHERE i.active = 1 AND (? IS NULL OR i.kind = ?)
      ORDER BY i.kind, i.name`
  ).all(kind, kind));
}));

router.post('/insurers', requireRole('admin', 'cashier'), wrap((req, res) => {
  required(req.body, ['code', 'name']);
  const info = db.prepare(
    `INSERT INTO insurers (code, name, kind, administered_by, contact_person, phone, email, claim_email,
                           portal_url, address, cashless, preauth_tat_hours, settlement_days,
                           tariff_discount_pct, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(str(req.body.code).toUpperCase(), str(req.body.name), str(req.body.kind, 'insurer'),
        int(req.body.administeredBy) || null, str(req.body.contactPerson), str(req.body.phone),
        str(req.body.email), str(req.body.claimEmail), str(req.body.portalUrl), str(req.body.address),
        bool(req.body.cashless, true) ? 1 : 0, int(req.body.preauthTatHours, 24) || 24,
        int(req.body.settlementDays, 30) || 30, num(req.body.tariffDiscountPct, 0), str(req.body.notes));
  audit.log(req, 'create', 'insurer', info.lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM insurers WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/insurers/:id', requireRole('admin', 'cashier'), wrap((req, res) => {
  const id = int(req.params.id);
  if (!db.prepare('SELECT 1 FROM insurers WHERE id = ?').get(id)) throw notFound('Insurer not found');
  db.prepare(
    `UPDATE insurers SET name = COALESCE(?, name), contact_person = COALESCE(?, contact_person),
            phone = COALESCE(?, phone), email = COALESCE(?, email), claim_email = COALESCE(?, claim_email),
            portal_url = COALESCE(?, portal_url), settlement_days = COALESCE(?, settlement_days),
            preauth_tat_hours = COALESCE(?, preauth_tat_hours), notes = COALESCE(?, notes),
            active = COALESCE(?, active)
      WHERE id = ?`
  ).run(str(req.body.name), str(req.body.contactPerson), str(req.body.phone), str(req.body.email),
        str(req.body.claimEmail), str(req.body.portalUrl),
        req.body.settlementDays === undefined ? null : int(req.body.settlementDays),
        req.body.preauthTatHours === undefined ? null : int(req.body.preauthTatHours),
        str(req.body.notes),
        req.body.active === undefined ? null : (bool(req.body.active) ? 1 : 0), id);
  audit.log(req, 'update', 'insurer', id);
  res.json(db.prepare('SELECT * FROM insurers WHERE id = ?').get(id));
}));

// ============================================================ patient policies
router.get('/policies', viewRoles, wrap((req, res) => {
  const patientId = req.query.patientId ? int(req.query.patientId) : null;
  const { limit, offset } = paging(req.query, 100);
  res.json(db.prepare(
    `SELECT pp.*, i.name AS insurer_name, i.kind AS insurer_kind, i.cashless,
            (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name, p.uhid,
            (pp.sum_insured - pp.sum_utilised) AS balance,
            u.name AS verified_by_name
       FROM patient_policies pp
       JOIN insurers i ON i.id = pp.insurer_id
       JOIN patients p ON p.id = pp.patient_id
       LEFT JOIN users u ON u.id = pp.verified_by
      WHERE (? IS NULL OR pp.patient_id = ?)
      ORDER BY pp.id DESC LIMIT ? OFFSET ?`
  ).all(patientId, patientId, limit, offset));
}));

router.post('/policies', deskRoles, wrap((req, res) => {
  required(req.body, ['patientId', 'insurerId', 'policyNo']);
  const patientId = int(req.body.patientId);
  if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(patientId)) throw notFound('Patient not found');

  const info = db.prepare(
    `INSERT INTO patient_policies (patient_id, insurer_id, policy_no, member_id, card_number, scheme,
                                   policy_holder, relationship, sum_insured, sum_utilised, copay_pct,
                                   room_rent_limit, valid_from, valid_to, waiting_till, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(patientId, int(req.body.insurerId), str(req.body.policyNo), str(req.body.memberId),
        str(req.body.cardNumber), str(req.body.scheme, 'retail'), str(req.body.policyHolder),
        str(req.body.relationship, 'self'), money(req.body.sumInsured, 0), money(req.body.sumUtilised, 0),
        num(req.body.copayPct, 0),
        req.body.roomRentLimit === undefined || req.body.roomRentLimit === '' ? null : money(req.body.roomRentLimit),
        str(req.body.validFrom), str(req.body.validTo), str(req.body.waitingTill),
        str(req.body.notes), req.user.id);

  // A patient with a live policy is no longer "uninsured" for the screening lane.
  db.prepare('UPDATE patients SET is_uninsured = 0, insurance_provider = ?, insurance_policy_no = ?, insurance_valid_till = ? WHERE id = ?')
    .run(db.prepare('SELECT name FROM insurers WHERE id = ?').get(int(req.body.insurerId))?.name || null,
         str(req.body.policyNo), str(req.body.validTo), patientId);

  audit.log(req, 'create', 'patient_policy', info.lastInsertRowid, { patientId });
  res.status(201).json(db.prepare('SELECT * FROM patient_policies WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/policies/:id', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  if (!db.prepare('SELECT 1 FROM patient_policies WHERE id = ?').get(id)) throw notFound('Policy not found');
  db.prepare(
    `UPDATE patient_policies
        SET member_id = COALESCE(?, member_id), card_number = COALESCE(?, card_number),
            sum_insured = COALESCE(?, sum_insured), sum_utilised = COALESCE(?, sum_utilised),
            copay_pct = COALESCE(?, copay_pct), room_rent_limit = COALESCE(?, room_rent_limit),
            valid_from = COALESCE(?, valid_from), valid_to = COALESCE(?, valid_to),
            status = COALESCE(?, status), notes = COALESCE(?, notes)
      WHERE id = ?`
  ).run(str(req.body.memberId), str(req.body.cardNumber),
        req.body.sumInsured === undefined ? null : money(req.body.sumInsured),
        req.body.sumUtilised === undefined ? null : money(req.body.sumUtilised),
        req.body.copayPct === undefined ? null : num(req.body.copayPct),
        req.body.roomRentLimit === undefined ? null : money(req.body.roomRentLimit),
        str(req.body.validFrom), str(req.body.validTo), str(req.body.status), str(req.body.notes), id);
  audit.log(req, 'update', 'patient_policy', id);
  res.json(db.prepare('SELECT * FROM patient_policies WHERE id = ?').get(id));
}));

/** Confirms the desk has checked the card or the insurer's portal. */
router.post('/policies/:id/verify', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  db.prepare("UPDATE patient_policies SET verified_at = datetime('now'), verified_by = ?, notes = COALESCE(?, notes) WHERE id = ?")
    .run(req.user.id, str(req.body.notes), id);
  audit.log(req, 'verify', 'patient_policy', id);
  res.json(db.prepare('SELECT * FROM patient_policies WHERE id = ?').get(id));
}));

/** "Will this be covered, and for how much?" — before committing to admission. */
router.get('/policies/:id/eligibility', viewRoles, wrap((req, res) => {
  const result = insurance.eligibility(int(req.params.id), {
    estimatedAmount: num(req.query.estimate, 0),
    roomTariffPerDay: num(req.query.roomTariff, 0),
    stayDays: int(req.query.stayDays, 1) || 1,
  });
  if (!result) throw notFound('Policy not found');
  result.alreadyCommitted = insurance.committedOnPolicy(int(req.params.id));
  res.json(result);
}));

// ========================================================== pre-authorisation
router.get('/preauths', viewRoles, wrap((req, res) => {
  const status = str(req.query.status);
  const patientId = req.query.patientId ? int(req.query.patientId) : null;
  const rows = db.prepare(
    `SELECT pa.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            i.name AS insurer_name, i.kind AS insurer_kind, pp.policy_no,
            u.name AS doctor_name, a.ip_no, v.visit_no,
            CAST((julianday('now') - julianday(pa.submitted_at)) * 24 AS INTEGER) AS hours_pending
       FROM preauths pa
       JOIN patients p ON p.id = pa.patient_id
       JOIN insurers i ON i.id = pa.insurer_id
       JOIN patient_policies pp ON pp.id = pa.policy_id
       LEFT JOIN users u ON u.id = pa.doctor_id
       LEFT JOIN admissions a ON a.id = pa.admission_id
       LEFT JOIN visits v ON v.id = pa.visit_id
      WHERE (? IS NULL OR pa.status = ?) AND (? IS NULL OR pa.patient_id = ?)
      ORDER BY CASE pa.status WHEN 'query_raised' THEN 0 WHEN 'submitted' THEN 1
                              WHEN 'draft' THEN 2 ELSE 3 END, pa.id DESC
      LIMIT 200`
  ).all(status, status, patientId, patientId);

  const counts = db.prepare('SELECT status, COUNT(*) AS c FROM preauths GROUP BY status').all()
    .reduce((a, r) => ({ ...a, [r.status]: r.c }), {});
  res.json({ rows, counts });
}));

router.get('/preauths/:id', viewRoles, wrap((req, res) => {
  const pa = insurance.fullPreauth(int(req.params.id));
  if (!pa) throw notFound('Pre-authorisation not found');
  res.json(pa);
}));

/** Raise a cashless request. Blocked outright if the policy is not usable. */
router.post('/preauths', requireRole('cashier', 'reception', 'counselor', 'doctor', 'ward'), wrap((req, res) => {
  required(req.body, ['policyId', 'requestedAmount', 'diagnosis']);
  const policyId = int(req.body.policyId);
  const policy = insurance.policyWithInsurer(policyId);
  if (!policy) throw notFound('Policy not found');

  const requested = money(req.body.requestedAmount);
  if (requested <= 0) throw badRequest('Requested amount must be greater than zero.');

  const check = insurance.eligibility(policyId, {
    estimatedAmount: requested,
    roomTariffPerDay: num(req.body.roomTariffPerDay, 0),
    stayDays: int(req.body.estimatedStayDays, 1) || 1,
  });
  if (!check.eligible) {
    throw conflict(`Cannot raise a pre-authorisation: ${check.blockers.join(' ')}`);
  }

  const open = db.prepare(
    `SELECT preauth_no FROM preauths WHERE policy_id = ? AND admission_id IS ?
        AND status IN ('draft','submitted','query_raised') AND parent_id IS NULL`
  ).get(policyId, int(req.body.admissionId) || null);
  if (open && !bool(req.body.allowParallel)) {
    throw conflict(`A pre-authorisation is already open for this episode (${open.preauth_no}). ` +
      'Raise an enhancement against it instead, or resend with allowParallel=true.');
  }

  const preauthNo = generate('preauth');
  const id = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO preauths (preauth_no, patient_id, policy_id, insurer_id, admission_id, visit_id, doctor_id,
                             kind, icd_code, diagnosis, procedure_name, treatment_plan, clinical_notes,
                             past_history, estimated_stay_days, room_category, requested_amount, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(preauthNo, policy.patient_id, policyId, policy.insurer_id,
          int(req.body.admissionId) || null, int(req.body.visitId) || null,
          int(req.body.doctorId) || null, str(req.body.kind, 'planned'),
          str(req.body.icdCode), str(req.body.diagnosis), str(req.body.procedureName),
          str(req.body.treatmentPlan), str(req.body.clinicalNotes), str(req.body.pastHistory),
          int(req.body.estimatedStayDays) || null, str(req.body.roomCategory), requested, req.user.id);

    insurance.logPreauth(info.lastInsertRowid, 'created', `Requested ${requested}`, requested, req.user.id);
    insurance.seedDocuments({
      preauthId: info.lastInsertRowid, list: insurance.PREAUTH_DOCUMENTS, userId: req.user.id,
    });
    return info.lastInsertRowid;
  })();

  audit.log(req, 'create', 'preauth', id, { preauthNo, requested });
  res.status(201).json({ preauth: insurance.fullPreauth(id), eligibility: check });
}));

router.patch('/preauths/:id', requireRole('cashier', 'reception', 'counselor', 'doctor'), wrap((req, res) => {
  const id = int(req.params.id);
  const pa = db.prepare('SELECT * FROM preauths WHERE id = ?').get(id);
  if (!pa) throw notFound('Pre-authorisation not found');
  if (['approved', 'partially_approved', 'rejected'].includes(pa.status)) {
    throw conflict('A decided pre-authorisation cannot be edited. Raise an enhancement instead.');
  }
  db.prepare(
    `UPDATE preauths SET icd_code = COALESCE(?, icd_code), diagnosis = COALESCE(?, diagnosis),
            procedure_name = COALESCE(?, procedure_name), treatment_plan = COALESCE(?, treatment_plan),
            clinical_notes = COALESCE(?, clinical_notes), past_history = COALESCE(?, past_history),
            estimated_stay_days = COALESCE(?, estimated_stay_days), room_category = COALESCE(?, room_category),
            requested_amount = COALESCE(?, requested_amount), remarks = COALESCE(?, remarks)
      WHERE id = ?`
  ).run(str(req.body.icdCode), str(req.body.diagnosis), str(req.body.procedureName),
        str(req.body.treatmentPlan), str(req.body.clinicalNotes), str(req.body.pastHistory),
        req.body.estimatedStayDays === undefined ? null : int(req.body.estimatedStayDays),
        str(req.body.roomCategory),
        req.body.requestedAmount === undefined ? null : money(req.body.requestedAmount),
        str(req.body.remarks), id);
  audit.log(req, 'update', 'preauth', id);
  res.json(insurance.fullPreauth(id));
}));

/** Send it to the insurer or TPA. The clock on their turnaround starts here. */
router.post('/preauths/:id/submit', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const pa = db.prepare('SELECT * FROM preauths WHERE id = ?').get(id);
  if (!pa) throw notFound('Pre-authorisation not found');
  if (!['draft', 'query_raised'].includes(pa.status)) {
    throw conflict(`A pre-authorisation in "${pa.status}" cannot be submitted.`);
  }

  const missing = db.prepare(
    'SELECT doc_type FROM insurance_documents WHERE preauth_id = ? AND provided = 0'
  ).all(id).map((d) => d.doc_type);
  if (missing.length && !bool(req.body.submitIncomplete)) {
    throw conflict(
      `${missing.length} document(s) still not collected: ${missing.join('; ')}. ` +
      'Tick them off, or resend with submitIncomplete=true.'
    );
  }

  db.prepare(
    `UPDATE preauths SET status = 'submitted', submitted_at = datetime('now'),
            reference_no = COALESCE(?, reference_no) WHERE id = ?`
  ).run(str(req.body.referenceNo), id);
  insurance.logPreauth(id, pa.status === 'query_raised' ? 'query_answered' : 'submitted',
    str(req.body.notes) || 'Sent to the insurer', null, req.user.id);

  audit.log(req, 'submit', 'preauth', id);
  res.json(insurance.fullPreauth(id));
}));

/** The insurer has come back asking for more. */
router.post('/preauths/:id/query', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  required(req.body, ['query']);
  const pa = db.prepare('SELECT * FROM preauths WHERE id = ?').get(id);
  if (!pa) throw notFound('Pre-authorisation not found');
  if (pa.status !== 'submitted') throw conflict('Only a submitted pre-authorisation can carry a query.');

  db.prepare("UPDATE preauths SET status = 'query_raised' WHERE id = ?").run(id);
  insurance.logPreauth(id, 'query_raised', str(req.body.query), null, req.user.id);

  // Extra papers the insurer asked for become checklist rows of their own.
  for (const doc of (req.body.documentsRequested || [])) {
    if (doc) {
      db.prepare('INSERT INTO insurance_documents (preauth_id, doc_type, recorded_by) VALUES (?, ?, ?)')
        .run(id, str(doc), req.user.id);
    }
  }
  audit.log(req, 'query', 'preauth', id);
  res.json(insurance.fullPreauth(id));
}));

/**
 * Record the decision. On approval the amount is placed on the episode's
 * invoice straight away, so the patient's balance shows only their own share.
 */
router.post('/preauths/:id/decision', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  required(req.body, ['decision']);
  const decision = str(req.body.decision);
  if (!['approved', 'partially_approved', 'rejected'].includes(decision)) {
    throw badRequest('decision must be approved, partially_approved or rejected.');
  }
  const pa = db.prepare('SELECT * FROM preauths WHERE id = ?').get(id);
  if (!pa) throw notFound('Pre-authorisation not found');
  if (!['submitted', 'query_raised'].includes(pa.status)) {
    throw conflict(`A pre-authorisation in "${pa.status}" has no decision pending.`);
  }

  const approved = decision === 'rejected' ? 0 : money(req.body.approvedAmount, pa.requested_amount);
  if (decision !== 'rejected') {
    if (approved <= 0) throw badRequest('Approved amount must be greater than zero.');
    if (approved > pa.requested_amount + 0.009) {
      throw badRequest('Approved amount cannot exceed the amount requested.');
    }
    const balance = insurance.balanceSumInsured(insurance.policyWithInsurer(pa.policy_id));
    const committed = insurance.committedOnPolicy(pa.policy_id, id);
    if (approved > balance - committed + 0.009) {
      throw conflict(
        `Approving ${approved} would exceed the sum insured left on this policy ` +
        `(${balance} balance, ${committed} already committed to other approvals).`
      );
    }
  }

  const policy = insurance.policyWithInsurer(pa.policy_id);
  const copay = decision === 'rejected' ? 0 : insurance.round2(approved * ((policy.copay_pct || 0) / 100));

  db.prepare(
    `UPDATE preauths SET status = ?, approved_amount = ?, copay_amount = ?, approval_no = ?,
            valid_till = ?, rejection_reason = ?, remarks = COALESCE(?, remarks),
            decision_at = datetime('now')
      WHERE id = ?`
  ).run(decision, approved, copay, str(req.body.approvalNo), str(req.body.validTill),
        decision === 'rejected' ? str(req.body.reason) : null, str(req.body.remarks), id);

  insurance.logPreauth(id, decision,
    decision === 'rejected'
      ? `Rejected — ${str(req.body.reason) || 'no reason given'}`
      : `Approved ${approved}${str(req.body.approvalNo) ? ` · approval ${str(req.body.approvalNo)}` : ''}`,
    approved, req.user.id);

  // Put the approval onto the episode's invoice, if one exists yet.
  let invoice = null;
  const invoiceRow = pa.admission_id
    ? db.prepare("SELECT * FROM invoices WHERE admission_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1").get(pa.admission_id)
    : pa.visit_id
      // The hospital bill, not the pharmacy's: an insurer is claimed against
      // what the clinic charged, and the medicines were settled at the counter.
      ? db.prepare(
        `SELECT * FROM invoices
          WHERE visit_id = ? AND status != 'cancelled' AND kind != 'pharmacy'
          ORDER BY id DESC LIMIT 1`
      ).get(pa.visit_id)
      : null;
  if (invoiceRow && decision !== 'rejected') {
    // The root approval plus every approved enhancement, each net of co-pay.
    invoice = insurance.syncInvoiceCover(invoiceRow.id, insurance.episodeCover(id));
  }

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(pa.patient_id);
  const to = patient.whatsapp || patient.phone;
  if (to) {
    whatsapp.notify({
      to, template: 'generic', refType: 'preauth', refId: id,
      data: { body: decision === 'rejected'
        ? `🏥 Cashless request ${pa.preauth_no} was not approved by ${policy.insurer_name}.\n` +
          `Reason: ${str(req.body.reason) || 'not stated'}\n\nOur billing desk will explain your options.`
        : `🏥 Cashless approved by ${policy.insurer_name}.\nRef: ${pa.preauth_no}\n` +
          `Approved: ${approved}${copay ? `\nYour co-pay share: ${copay}` : ''}\n` +
          `\nPlease carry your insurance card and photo ID.` },
    });
  }

  audit.log(req, 'decision', 'preauth', id, { decision, approved });
  res.json({ preauth: insurance.fullPreauth(id), invoice });
}));

/** Stay ran longer or costs overshot — ask for more against the same episode. */
router.post('/preauths/:id/enhance', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  required(req.body, ['requestedAmount', 'reason']);
  const parent = db.prepare('SELECT * FROM preauths WHERE id = ?').get(id);
  if (!parent) throw notFound('Pre-authorisation not found');
  if (!['approved', 'partially_approved'].includes(parent.status)) {
    throw conflict('Only an approved pre-authorisation can be enhanced.');
  }

  const requested = money(req.body.requestedAmount);
  if (requested <= 0) throw badRequest('Requested amount must be greater than zero.');

  const preauthNo = generate('preauth');
  const info = db.prepare(
    `INSERT INTO preauths (preauth_no, patient_id, policy_id, insurer_id, admission_id, visit_id, doctor_id,
                           kind, parent_id, status, icd_code, diagnosis, procedure_name, treatment_plan,
                           clinical_notes, estimated_stay_days, requested_amount, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'enhancement', ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(preauthNo, parent.patient_id, parent.policy_id, parent.insurer_id, parent.admission_id,
        parent.visit_id, parent.doctor_id, id, parent.icd_code, parent.diagnosis, parent.procedure_name,
        str(req.body.treatmentPlan) || parent.treatment_plan, str(req.body.reason),
        int(req.body.estimatedStayDays) || null, requested, str(req.body.reason), req.user.id);

  insurance.logPreauth(id, 'enhancement_raised', `${preauthNo} for ${requested} — ${str(req.body.reason)}`, requested, req.user.id);
  insurance.logPreauth(info.lastInsertRowid, 'created', `Enhancement on ${parent.preauth_no}`, requested, req.user.id);
  insurance.seedDocuments({
    preauthId: info.lastInsertRowid,
    list: ['Updated clinical notes justifying the extension', 'Interim bill to date', 'Fresh investigation reports'],
    userId: req.user.id,
  });

  audit.log(req, 'enhance', 'preauth', info.lastInsertRowid, { parent: id, requested });
  res.status(201).json(insurance.fullPreauth(info.lastInsertRowid));
}));

router.post('/preauths/:id/withdraw', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const pa = db.prepare('SELECT * FROM preauths WHERE id = ?').get(id);
  if (!pa) throw notFound('Pre-authorisation not found');
  if (['approved', 'partially_approved'].includes(pa.status)) {
    throw conflict('An approved pre-authorisation cannot be withdrawn — cancel the claim instead.');
  }
  db.prepare("UPDATE preauths SET status = 'withdrawn' WHERE id = ?").run(id);
  insurance.logPreauth(id, 'withdrawn', str(req.body.reason), null, req.user.id);
  audit.log(req, 'withdraw', 'preauth', id);
  res.json(insurance.fullPreauth(id));
}));

// ==================================================================== claims
router.get('/claims', viewRoles, wrap((req, res) => {
  const status = str(req.query.status);
  const insurerId = req.query.insurerId ? int(req.query.insurerId) : null;
  const patientId = req.query.patientId ? int(req.query.patientId) : null;
  const rows = db.prepare(
    `SELECT c.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            i.name AS insurer_name, i.kind AS insurer_kind, pp.policy_no,
            inv.invoice_no, a.ip_no, v.visit_no, pa.preauth_no,
            CAST(julianday('now') - julianday(c.submitted_at) AS INTEGER) AS days_pending
       FROM claims c
       JOIN patients p ON p.id = c.patient_id
       JOIN insurers i ON i.id = c.insurer_id
       JOIN patient_policies pp ON pp.id = c.policy_id
       LEFT JOIN invoices inv ON inv.id = c.invoice_id
       LEFT JOIN admissions a ON a.id = c.admission_id
       LEFT JOIN visits v ON v.id = c.visit_id
       LEFT JOIN preauths pa ON pa.id = c.preauth_id
      WHERE (? IS NULL OR c.status = ?) AND (? IS NULL OR c.insurer_id = ?)
        AND (? IS NULL OR c.patient_id = ?)
      ORDER BY CASE c.status WHEN 'query_raised' THEN 0 WHEN 'draft' THEN 1
                             WHEN 'submitted' THEN 2 WHEN 'under_process' THEN 3 ELSE 4 END, c.id DESC
      LIMIT 300`
  ).all(status, status, insurerId, insurerId, patientId, patientId);

  const counts = db.prepare('SELECT status, COUNT(*) AS c FROM claims GROUP BY status').all()
    .reduce((a, r) => ({ ...a, [r.status]: r.c }), {});
  const totals = db.prepare(
    `SELECT COALESCE(SUM(claimed_amount),0) AS claimed, COALESCE(SUM(settled_amount),0) AS settled,
            COALESCE(SUM(CASE WHEN status IN ('submitted','under_process','query_raised','approved','partially_settled')
                         THEN approved_amount - settled_amount ELSE 0 END),0) AS receivable,
            COALESCE(SUM(disallowed_amount),0) AS disallowed
       FROM claims WHERE status != 'cancelled'`
  ).get();
  res.json({ rows, counts, totals });
}));

router.get('/claims/:id', viewRoles, wrap((req, res) => {
  const claim = insurance.fullClaim(int(req.params.id));
  if (!claim) throw notFound('Claim not found');
  res.json(claim);
}));

/** Build the claim from the episode's invoice, pre-marking obvious exclusions. */
router.post('/claims', deskRoles, wrap((req, res) => {
  required(req.body, ['policyId', 'invoiceId']);
  const policyId = int(req.body.policyId);
  const invoiceId = int(req.body.invoiceId);
  const policy = insurance.policyWithInsurer(policyId);
  if (!policy) throw notFound('Policy not found');

  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) throw notFound('Invoice not found');
  if (invoice.patient_id !== policy.patient_id) {
    throw badRequest('That invoice belongs to a different patient.');
  }
  const existing = db.prepare(
    "SELECT claim_no FROM claims WHERE invoice_id = ? AND status != 'cancelled'"
  ).get(invoiceId);
  if (existing) throw conflict(`A claim already exists for this invoice (${existing.claim_no}).`);

  const preauthId = int(req.body.preauthId) || null;
  const claimType = str(req.body.claimType, preauthId ? 'cashless' : 'reimbursement');
  const claimNo = generate('claim');

  const id = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO claims (claim_no, patient_id, policy_id, insurer_id, invoice_id, admission_id, visit_id,
                           preauth_id, claim_type, due_at, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, date('now', '+' || ? || ' days'), ?, ?)`
    ).run(claimNo, policy.patient_id, policyId, policy.insurer_id, invoiceId,
          invoice.admission_id, invoice.visit_id, preauthId, claimType,
          policy.settlement_days || 30, str(req.body.remarks), req.user.id);

    const claimId = info.lastInsertRowid;
    insurance.buildClaimItems(claimId, invoiceId, req.user.id);
    insurance.seedDocuments({ claimId, list: insurance.CLAIM_DOCUMENTS, userId: req.user.id });
    insurance.logClaim(claimId, 'created', `Built from invoice ${invoice.invoice_no}`, invoice.net, req.user.id);
    return claimId;
  })();

  audit.log(req, 'create', 'claim', id, { claimNo, invoiceId });
  res.status(201).json(insurance.fullClaim(id));
}));

/** Adjust a line — mark it non-admissible, or change what is being claimed. */
router.patch('/claims/:id/items/:itemId', deskRoles, wrap((req, res) => {
  const claimId = int(req.params.id);
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!claim) throw notFound('Claim not found');
  if (['settled', 'rejected', 'closed'].includes(claim.status)) {
    throw conflict(`A ${claim.status} claim cannot be edited.`);
  }
  const item = db.prepare('SELECT * FROM claim_items WHERE id = ? AND claim_id = ?')
    .get(int(req.params.itemId), claimId);
  if (!item) throw notFound('Claim line not found');

  const admissible = req.body.admissible === undefined ? item.admissible : (bool(req.body.admissible) ? 1 : 0);
  const claimed = req.body.claimed === undefined
    ? (admissible ? item.claimed : 0)
    : money(req.body.claimed);
  if (claimed > item.billed + 0.009) throw badRequest('Cannot claim more than was billed for this line.');

  db.prepare(
    `UPDATE claim_items SET admissible = ?, claimed = ?, approved = COALESCE(?, approved),
            disallowed = COALESCE(?, disallowed), disallow_reason = COALESCE(?, disallow_reason)
      WHERE id = ?`
  ).run(admissible, admissible ? claimed : 0,
        req.body.approved === undefined ? null : money(req.body.approved),
        req.body.disallowed === undefined ? null : money(req.body.disallowed),
        str(req.body.disallowReason), item.id);

  res.json(insurance.recalcClaim(claimId) && insurance.fullClaim(claimId));
}));

router.post('/claims/:id/submit', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  if (!claim) throw notFound('Claim not found');
  if (!['draft', 'query_raised'].includes(claim.status)) {
    throw conflict(`A claim in "${claim.status}" cannot be submitted.`);
  }
  if (claim.claimed_amount <= 0) throw badRequest('Nothing is marked admissible on this claim.');

  const missing = db.prepare(
    'SELECT doc_type FROM insurance_documents WHERE claim_id = ? AND provided = 0'
  ).all(id).map((d) => d.doc_type);
  if (missing.length && !bool(req.body.submitIncomplete)) {
    throw conflict(
      `${missing.length} document(s) still not collected: ${missing.join('; ')}. ` +
      'Tick them off, or resend with submitIncomplete=true.'
    );
  }

  db.prepare(
    `UPDATE claims SET status = 'submitted', submitted_at = datetime('now'),
            due_at = date('now', '+' || ? || ' days') WHERE id = ?`
  ).run(int(req.body.settlementDays, 30) || 30, id);
  insurance.logClaim(id, claim.status === 'query_raised' ? 'query_answered' : 'submitted',
    str(req.body.notes) || 'Dispatched to the insurer', claim.claimed_amount, req.user.id);

  audit.log(req, 'submit', 'claim', id);
  res.json(insurance.fullClaim(id));
}));

router.post('/claims/:id/query', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  required(req.body, ['query']);
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  if (!claim) throw notFound('Claim not found');
  if (!['submitted', 'under_process'].includes(claim.status)) {
    throw conflict('Only a submitted claim can carry a query.');
  }
  db.prepare("UPDATE claims SET status = 'query_raised' WHERE id = ?").run(id);
  insurance.logClaim(id, 'query_raised', str(req.body.query), null, req.user.id);
  for (const doc of (req.body.documentsRequested || [])) {
    if (doc) {
      db.prepare('INSERT INTO insurance_documents (claim_id, doc_type, recorded_by) VALUES (?, ?, ?)')
        .run(id, str(doc), req.user.id);
    }
  }
  audit.log(req, 'query', 'claim', id);
  res.json(insurance.fullClaim(id));
}));

/** The insurer has approved a figure — not yet paid it. */
router.post('/claims/:id/decision', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  required(req.body, ['decision']);
  const decision = str(req.body.decision);
  if (!['approved', 'rejected'].includes(decision)) {
    throw badRequest('decision must be approved or rejected.');
  }
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  if (!claim) throw notFound('Claim not found');
  if (!['submitted', 'under_process', 'query_raised'].includes(claim.status)) {
    throw conflict(`A claim in "${claim.status}" has no decision pending.`);
  }

  if (decision === 'rejected') {
    db.prepare(
      "UPDATE claims SET status = 'rejected', rejection_reason = ?, decision_at = datetime('now'), approved_amount = 0 WHERE id = ?"
    ).run(str(req.body.reason), id);
    // The whole bill falls back to the patient.
    if (claim.claim_type === 'cashless' && claim.invoice_id) insurance.syncInvoiceCover(claim.invoice_id, 0);
    insurance.logClaim(id, 'rejected', str(req.body.reason) || 'No reason given', 0, req.user.id);
    audit.log(req, 'decision', 'claim', id, { decision });
    return res.json({ claim: insurance.fullClaim(id), invoice: claim.invoice_id ? billing.fullInvoice(claim.invoice_id) : null });
  }

  const approved = money(req.body.approvedAmount, claim.claimed_amount);
  if (approved <= 0) throw badRequest('Approved amount must be greater than zero.');
  if (approved > claim.claimed_amount + 0.009) throw badRequest('Approved amount cannot exceed the amount claimed.');

  const policy = insurance.policyWithInsurer(claim.policy_id);
  const copay = insurance.round2(approved * ((policy.copay_pct || 0) / 100));
  const netToHospital = insurance.round2(Math.max(approved - copay, 0));

  db.prepare(
    `UPDATE claims SET status = 'approved', approved_amount = ?, copay_amount = ?,
            disallowed_amount = ?, disallow_reason = COALESCE(?, disallow_reason),
            decision_at = datetime('now') WHERE id = ?`
  ).run(approved, copay, insurance.round2(Math.max(claim.claimed_amount - approved, 0)),
        str(req.body.disallowReason), id);

  let invoice = null;
  if (claim.claim_type === 'cashless' && claim.invoice_id) {
    invoice = insurance.syncInvoiceCover(claim.invoice_id, netToHospital);
  }
  insurance.logClaim(id, 'approved',
    `Approved ${approved}${copay ? ` (co-pay ${copay})` : ''}`, approved, req.user.id);

  audit.log(req, 'decision', 'claim', id, { decision, approved });
  res.json({ claim: insurance.fullClaim(id), invoice: invoice ? billing.fullInvoice(claim.invoice_id) : null });
}));

/** Money in the bank. Any shortfall against the approval returns to the patient. */
router.post('/claims/:id/settle', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  required(req.body, ['settledAmount']);
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  if (!claim) throw notFound('Claim not found');
  if (!['approved', 'partially_settled'].includes(claim.status)) {
    throw conflict('Only an approved claim can be settled.');
  }
  const settled = money(req.body.settledAmount);
  if (settled < 0) throw badRequest('Settled amount cannot be negative.');

  const result = insurance.settle(id, {
    settledAmount: settled,
    tdsAmount: money(req.body.tdsAmount, 0),
    utrNo: str(req.body.utrNo),
    // A reason means the desk is closing the claim short — anything still
    // unpaid becomes the patient's. Without one, the balance stays awaited.
    disallowReason: str(req.body.disallowReason),
    actorId: req.user.id,
  });

  audit.log(req, 'settle', 'claim', id, { settled, shortfall: result.shortfall });
  res.json({
    claim: insurance.fullClaim(id),
    receipt: result.receipt,
    recovered: result.recovered,
    shortfall: result.shortfall,
    awaited: result.awaited,
    invoice: claim.invoice_id ? billing.fullInvoice(claim.invoice_id) : null,
    note: result.shortfall > 0
      ? `The insurer paid ${result.shortfall.toFixed(2)} less than it approved — that amount now sits on the patient's balance.`
      : result.awaited > 0
        ? `${result.awaited.toFixed(2)} of the approved amount is still awaited from the insurer.`
        : null,
  });
}));

router.post('/claims/:id/cancel', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  if (!claim) throw notFound('Claim not found');
  if (claim.settled_amount > 0) throw conflict('A claim that has received money cannot be cancelled.');
  db.prepare("UPDATE claims SET status = 'cancelled' WHERE id = ?").run(id);
  if (claim.claim_type === 'cashless' && claim.invoice_id) insurance.syncInvoiceCover(claim.invoice_id, 0);
  insurance.logClaim(id, 'cancelled', str(req.body.reason), null, req.user.id);
  audit.log(req, 'cancel', 'claim', id);
  res.json(insurance.fullClaim(id));
}));

// ============================================================== document list
router.patch('/documents/:id', viewRoles, wrap((req, res) => {
  const id = int(req.params.id);
  db.prepare(
    'UPDATE insurance_documents SET provided = ?, reference = COALESCE(?, reference), notes = COALESCE(?, notes), recorded_by = ? WHERE id = ?'
  ).run(bool(req.body.provided) ? 1 : 0, str(req.body.reference), str(req.body.notes), req.user.id, id);
  res.json(db.prepare('SELECT * FROM insurance_documents WHERE id = ?').get(id));
}));

router.post('/documents', viewRoles, wrap((req, res) => {
  required(req.body, ['docType']);
  if (!req.body.preauthId && !req.body.claimId) throw badRequest('Provide a preauthId or a claimId.');
  const info = db.prepare(
    'INSERT INTO insurance_documents (preauth_id, claim_id, doc_type, notes, recorded_by) VALUES (?, ?, ?, ?, ?)'
  ).run(int(req.body.preauthId) || null, int(req.body.claimId) || null,
        str(req.body.docType), str(req.body.notes), req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM insurance_documents WHERE id = ?').get(info.lastInsertRowid));
}));

// =================================================================== insight
/** Ageing on outstanding claims — where the clinic's money is stuck. */
router.get('/receivables', viewRoles, wrap((_req, res) => {
  const rows = db.prepare(
    `SELECT i.id, i.name AS insurer_name, i.kind,
            COUNT(c.id) AS open_claims,
            COALESCE(SUM(c.claimed_amount), 0) AS claimed,
            COALESCE(SUM(c.approved_amount - c.settled_amount), 0) AS outstanding,
            COALESCE(AVG(julianday('now') - julianday(c.submitted_at)), 0) AS avg_days_pending
       FROM insurers i
       JOIN claims c ON c.insurer_id = i.id
      WHERE c.status IN ('submitted','under_process','query_raised','approved','partially_settled')
      GROUP BY i.id ORDER BY outstanding DESC`
  ).all();

  const ageing = db.prepare(
    `SELECT
       SUM(CASE WHEN d <= 30 THEN amt ELSE 0 END) AS d0_30,
       SUM(CASE WHEN d > 30 AND d <= 60 THEN amt ELSE 0 END) AS d31_60,
       SUM(CASE WHEN d > 60 AND d <= 90 THEN amt ELSE 0 END) AS d61_90,
       SUM(CASE WHEN d > 90 THEN amt ELSE 0 END) AS d90_plus
     FROM (SELECT COALESCE(julianday('now') - julianday(submitted_at), 0) AS d,
                  (approved_amount - settled_amount) AS amt
             FROM claims
            WHERE status IN ('submitted','under_process','query_raised','approved','partially_settled'))`
  ).get();

  const overdue = db.prepare(
    `SELECT c.claim_no, c.due_at, c.approved_amount - c.settled_amount AS outstanding,
            i.name AS insurer_name, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name
       FROM claims c JOIN insurers i ON i.id = c.insurer_id JOIN patients p ON p.id = c.patient_id
      WHERE c.status IN ('submitted','under_process','query_raised','approved','partially_settled')
        AND c.due_at IS NOT NULL AND date(c.due_at) < date('now')
      ORDER BY c.due_at LIMIT 50`
  ).all();

  res.json({ byInsurer: rows, ageing, overdue });
}));

/** Everything insurance-related for one patient, for the record view. */
router.get('/patient/:patientId', viewRoles, wrap((req, res) => {
  const patientId = int(req.params.patientId);
  const policies = db.prepare(
    `SELECT pp.*, i.name AS insurer_name, i.kind AS insurer_kind, i.cashless,
            (pp.sum_insured - pp.sum_utilised) AS balance
       FROM patient_policies pp JOIN insurers i ON i.id = pp.insurer_id
      WHERE pp.patient_id = ? ORDER BY pp.id DESC`
  ).all(patientId);
  res.json({
    policies,
    preauths: db.prepare(
      `SELECT pa.*, i.name AS insurer_name FROM preauths pa JOIN insurers i ON i.id = pa.insurer_id
        WHERE pa.patient_id = ? ORDER BY pa.id DESC`
    ).all(patientId),
    claims: db.prepare(
      `SELECT c.*, i.name AS insurer_name, inv.invoice_no FROM claims c
         JOIN insurers i ON i.id = c.insurer_id LEFT JOIN invoices inv ON inv.id = c.invoice_id
        WHERE c.patient_id = ? ORDER BY c.id DESC`
    ).all(patientId),
  });
}));

module.exports = router;
