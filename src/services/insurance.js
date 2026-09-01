'use strict';
const { db } = require('../db');
const { conflict, badRequest } = require('../lib/http');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Insurance / TPA rules.
 *
 * Accounting model, which the whole module depends on:
 *   `invoices.insurance_covered` holds the amount the insurer is standing behind
 *   right now. It reduces the invoice's net, so at discharge a cashless patient
 *   only owes co-pay, disallowances and non-admissible items — which is what
 *   lets them leave. The insurer's actual money is tracked on the claim, not as
 *   a second payment against the invoice, so nothing is counted twice. If the
 *   insurer eventually settles less than it approved, the shortfall is moved
 *   back onto the patient's balance.
 */

// ---------------------------------------------------------------- eligibility
function policyWithInsurer(policyId) {
  return db.prepare(
    `SELECT pp.*, i.name AS insurer_name, i.code AS insurer_code, i.kind AS insurer_kind,
            i.cashless, i.preauth_tat_hours, i.settlement_days, i.tariff_discount_pct,
            adm.name AS administered_by_name,
            (p.first_name || ' ' || COALESCE(p.last_name, '')) AS patient_name, p.uhid
       FROM patient_policies pp
       JOIN insurers i ON i.id = pp.insurer_id
       JOIN patients p ON p.id = pp.patient_id
       LEFT JOIN insurers adm ON adm.id = i.administered_by
      WHERE pp.id = ?`
  ).get(policyId) || null;
}

function balanceSumInsured(policy) {
  return round2(Math.max((policy.sum_insured || 0) - (policy.sum_utilised || 0), 0));
}

/**
 * Everything the desk needs to answer "can we do this cashless, and for how
 * much?" — validity, balance, co-pay, room-rent cap and the resulting ceiling.
 */
function eligibility(policyId, { estimatedAmount = 0, roomTariffPerDay = 0, stayDays = 1 } = {}) {
  const policy = policyWithInsurer(policyId);
  if (!policy) return null;

  const warnings = [];
  const blockers = [];
  const date = today();

  if (policy.status !== 'active') blockers.push(`Policy is marked ${policy.status}.`);
  if (policy.valid_from && policy.valid_from > date) blockers.push(`Policy is not in force until ${policy.valid_from}.`);
  if (policy.valid_to && policy.valid_to < date) blockers.push(`Policy expired on ${policy.valid_to}.`);
  if (!policy.cashless) warnings.push('This insurer does not offer cashless here — process as reimbursement.');
  if (!policy.verified_at) warnings.push('Policy has not been verified against the card or portal yet.');
  if (policy.waiting_till && policy.waiting_till > date) {
    warnings.push(`Initial waiting period runs until ${policy.waiting_till}; planned procedures may be declined.`);
  }
  if (policy.valid_to && policy.valid_to <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)) {
    warnings.push(`Policy expires on ${policy.valid_to} — confirm renewal before a long admission.`);
  }

  const balance = balanceSumInsured(policy);
  if (balance <= 0) blockers.push('Sum insured is fully utilised for this policy year.');

  // Room-rent cap: TPAs apply a proportionate deduction across the whole bill
  // when the room chosen costs more than the policy allows.
  let roomRent = null;
  if (policy.room_rent_limit && roomTariffPerDay > 0) {
    const eligibleRatio = Math.min(policy.room_rent_limit / roomTariffPerDay, 1);
    roomRent = {
      limitPerDay: policy.room_rent_limit,
      chosenPerDay: roomTariffPerDay,
      withinLimit: roomTariffPerDay <= policy.room_rent_limit,
      eligibleRatio: Math.round(eligibleRatio * 1000) / 1000,
      excessPerDay: round2(Math.max(roomTariffPerDay - policy.room_rent_limit, 0)),
      excessOverStay: round2(Math.max(roomTariffPerDay - policy.room_rent_limit, 0) * Math.max(stayDays, 1)),
    };
    if (!roomRent.withinLimit) {
      warnings.push(
        `Room tariff ${roomTariffPerDay}/day exceeds the policy cap of ${policy.room_rent_limit}/day — ` +
        `expect a proportionate deduction of about ${Math.round((1 - eligibleRatio) * 100)}% across the bill.`
      );
    }
  }

  // Ceiling on what the insurer could bear for this episode.
  const estimate = round2(estimatedAmount);
  const afterRoomCap = roomRent && !roomRent.withinLimit
    ? round2(estimate * roomRent.eligibleRatio)
    : estimate;
  const copayAmount = round2(afterRoomCap * ((policy.copay_pct || 0) / 100));
  const maxCashless = round2(Math.min(Math.max(afterRoomCap - copayAmount, 0), balance));
  const patientBears = round2(Math.max(estimate - maxCashless, 0));

  return {
    policy: {
      id: policy.id, policyNo: policy.policy_no, memberId: policy.member_id,
      insurer: policy.insurer_name, insurerKind: policy.insurer_kind,
      administeredBy: policy.administered_by_name, scheme: policy.scheme,
      patientName: policy.patient_name, uhid: policy.uhid,
      status: policy.status, validFrom: policy.valid_from, validTo: policy.valid_to,
      cashless: !!policy.cashless, verified: !!policy.verified_at,
      preauthTatHours: policy.preauth_tat_hours, settlementDays: policy.settlement_days,
    },
    sumInsured: policy.sum_insured,
    utilised: policy.sum_utilised,
    balance,
    copayPct: policy.copay_pct,
    roomRent,
    estimate,
    copayAmount,
    maxCashless,
    patientBears,
    eligible: blockers.length === 0,
    blockers,
    warnings,
  };
}

// ------------------------------------------------------------- pre-authorisation
function logPreauth(preauthId, event, detail, amount, actorId) {
  db.prepare(
    'INSERT INTO preauth_events (preauth_id, event, detail, amount, actor_id) VALUES (?, ?, ?, ?, ?)'
  ).run(preauthId, event, detail || null, amount === undefined ? null : amount, actorId || null);
}

/** The paperwork every cashless request needs; seeded as an unticked checklist. */
const PREAUTH_DOCUMENTS = [
  'Duly filled pre-authorisation form',
  'Insurance card / e-card copy',
  'Patient photo ID',
  'Doctor\'s clinical notes and treatment plan',
  'Investigation reports supporting the diagnosis',
  'Estimated cost breakdown',
];

const CLAIM_DOCUMENTS = [
  'Final hospital bill with itemised breakdown',
  'Discharge summary',
  'All investigation reports',
  'Pharmacy bills and indent',
  'Pre-authorisation approval letter',
  'Signed claim form',
  'Cancelled cheque / bank details',
];

function seedDocuments({ preauthId = null, claimId = null, list, userId }) {
  const stmt = db.prepare(
    'INSERT INTO insurance_documents (preauth_id, claim_id, doc_type, recorded_by) VALUES (?, ?, ?, ?)'
  );
  for (const doc of list) stmt.run(preauthId, claimId, doc, userId || null);
}

/**
 * What the insurer is standing behind for one episode: the root pre-auth plus
 * every approved enhancement on it, each net of the patient's co-pay share.
 * Enhancements add to the cover — they do not replace it.
 */
function episodeCover(preauthId) {
  const root = db.prepare('SELECT * FROM preauths WHERE id = ?').get(preauthId);
  if (!root) return 0;
  const rootId = root.parent_id || root.id;
  const row = db.prepare(
    `SELECT COALESCE(SUM(approved_amount - copay_amount), 0) AS s
       FROM preauths
      WHERE (id = ? OR parent_id = ?)
        AND status IN ('approved','partially_approved')`
  ).get(rootId, rootId);
  return round2(Math.max(row.s, 0));
}

/** Total already approved against a policy but not yet closed out by a claim. */
function committedOnPolicy(policyId, excludePreauthId = null) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(approved_amount), 0) AS s FROM preauths
      WHERE policy_id = ? AND status IN ('approved','partially_approved')
        AND (? IS NULL OR id != ?)`
  ).get(policyId, excludePreauthId, excludePreauthId);
  return round2(row.s);
}

// --------------------------------------------------------------------- claims
function logClaim(claimId, event, detail, amount, actorId) {
  db.prepare(
    'INSERT INTO claim_events (claim_id, event, detail, amount, actor_id) VALUES (?, ?, ?, ?, ?)'
  ).run(claimId, event, detail || null, amount === undefined ? null : amount, actorId || null);
}

function recalcClaim(claimId) {
  const items = db.prepare('SELECT * FROM claim_items WHERE claim_id = ?').all(claimId);
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!claim) return null;

  const billed = round2(items.reduce((s, i) => s + i.billed, 0));
  const claimed = round2(items.reduce((s, i) => s + (i.admissible ? i.claimed : 0), 0));
  const approved = round2(items.reduce((s, i) => s + i.approved, 0));
  const disallowed = round2(items.reduce((s, i) => s + i.disallowed, 0));

  db.prepare(
    `UPDATE claims SET billed_amount = ?, claimed_amount = ?,
            approved_amount = CASE WHEN ? > 0 THEN ? ELSE approved_amount END,
            disallowed_amount = CASE WHEN ? > 0 THEN ? ELSE disallowed_amount END
      WHERE id = ?`
  ).run(billed, claimed, approved, approved, disallowed, disallowed, claimId);

  return db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
}

/**
 * Re-point the invoice at whatever the insurer is currently standing behind.
 * Called when a pre-auth is approved, when a claim is approved, and again when
 * it settles — so the patient's balance always reflects the live position.
 */
function syncInvoiceCover(invoiceId, coveredAmount) {
  if (!invoiceId) return null;
  const billing = require('./billing');
  return billing.applyInsurance(invoiceId, round2(Math.max(coveredAmount, 0)));
}

/** Non-admissible consumables most policies exclude outright. */
const NON_ADMISSIBLE_HINTS = [
  'registration', 'record card', 'attendant', 'telephone', 'toiletries', 'food',
  'admission kit', 'documentation charge',
];

function looksNonAdmissible(description) {
  const text = String(description || '').toLowerCase();
  return NON_ADMISSIBLE_HINTS.some((h) => text.includes(h));
}

/** Build claim lines from the invoice, pre-marking obvious exclusions. */
function buildClaimItems(claimId, invoiceId, userId) {
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoiceId);
  if (!items.length) throw badRequest('The invoice has no charges to claim.');
  const stmt = db.prepare(
    `INSERT INTO claim_items (claim_id, invoice_item_id, description, category, billed, claimed, admissible, disallow_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const it of items) {
    const admissible = looksNonAdmissible(it.description) ? 0 : 1;
    stmt.run(claimId, it.id, it.description, it.ref_type, it.amount,
             admissible ? it.amount : 0, admissible,
             admissible ? null : 'Non-admissible under most policies — confirm with the insurer.');
  }
  void userId;
  return recalcClaim(claimId);
}

/**
 * Record what the insurer actually paid.
 * Any shortfall against the approved amount moves back onto the patient, which
 * is the whole point of reconciling a cashless claim.
 */
function settle(claimId, { settledAmount, tdsAmount = 0, utrNo = null, disallowReason = null, actorId }) {
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!claim) throw badRequest('Claim not found.');
  if (['settled', 'rejected', 'cancelled', 'closed'].includes(claim.status)) {
    throw conflict(`This claim is already ${claim.status}.`);
  }

  // Insurers often pay in tranches, so receipts accumulate rather than replace.
  const receipt = round2(settledAmount);
  const tds = round2(tdsAmount);
  const settledTotal = round2(claim.settled_amount + receipt);
  const tdsTotal = round2(claim.tds_amount + tds);
  const recovered = round2(settledTotal + tdsTotal);

  if (recovered > claim.approved_amount + 0.009) {
    throw conflict(
      `Received ${recovered} in total, which is more than the approved ${claim.approved_amount}.`
    );
  }

  const shortfall = round2(Math.max(claim.approved_amount - recovered, 0));
  const fullyPaid = shortfall <= 0.009;
  // A tranche short of the approval only closes the claim when the desk says
  // this was the final payment; otherwise it stays open for the next one.
  const closing = fullyPaid || disallowReason !== null;
  const status = fullyPaid ? 'settled' : 'partially_settled';

  db.prepare(
    `UPDATE claims
        SET settled_amount = ?, tds_amount = ?, utr_no = COALESCE(?, utr_no), status = ?,
            disallowed_amount = ?, disallow_reason = COALESCE(?, disallow_reason),
            settled_at = datetime('now')
      WHERE id = ?`
  ).run(settledTotal, tdsTotal, utrNo, status,
        round2(claim.disallowed_amount + (closing ? shortfall : 0)),
        disallowReason, claimId);

  // Cashless: the invoice was carrying the approval — bring it down to what has
  // actually been recovered, pushing any shortfall back onto the patient.
  if (claim.claim_type === 'cashless' && claim.invoice_id) {
    syncInvoiceCover(claim.invoice_id, recovered);
  }

  // Reimbursement pays the patient, not us, so only the policy balance moves.
  db.prepare('UPDATE patient_policies SET sum_utilised = sum_utilised + ? WHERE id = ?')
    .run(receipt + tds, claim.policy_id);
  db.prepare(
    "UPDATE patient_policies SET status = 'exhausted' WHERE id = ? AND sum_utilised >= sum_insured AND sum_insured > 0"
  ).run(claim.policy_id);

  logClaim(claimId, fullyPaid ? 'settled' : 'part_settled',
    `Received ${receipt}${tds ? ` (TDS ${tds})` : ''}${utrNo ? ` · UTR ${utrNo}` : ''}` +
    (closing && shortfall ? ` · shortfall ${shortfall} moved to the patient` : '') +
    (!closing && shortfall ? ` · ${shortfall} still awaited` : ''),
    receipt, actorId);

  return {
    claim: db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId),
    receipt,
    recovered,
    shortfall: closing ? shortfall : 0,
    awaited: closing ? 0 : shortfall,
  };
}

function fullClaim(claimId) {
  const claim = db.prepare(
    `SELECT c.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name, p.phone,
            i.name AS insurer_name, i.kind AS insurer_kind, i.settlement_days,
            pp.policy_no, pp.member_id, pp.copay_pct, pp.sum_insured, pp.sum_utilised,
            inv.invoice_no, inv.net AS invoice_net, inv.balance AS invoice_balance,
            a.ip_no, v.visit_no, pa.preauth_no, pa.approval_no
       FROM claims c
       JOIN patients p ON p.id = c.patient_id
       JOIN insurers i ON i.id = c.insurer_id
       JOIN patient_policies pp ON pp.id = c.policy_id
       LEFT JOIN invoices inv ON inv.id = c.invoice_id
       LEFT JOIN admissions a ON a.id = c.admission_id
       LEFT JOIN visits v ON v.id = c.visit_id
       LEFT JOIN preauths pa ON pa.id = c.preauth_id
      WHERE c.id = ?`
  ).get(claimId);
  if (!claim) return null;
  claim.items = db.prepare('SELECT * FROM claim_items WHERE claim_id = ? ORDER BY id').all(claimId);
  claim.events = db.prepare(
    `SELECT e.*, u.name AS actor_name FROM claim_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.claim_id = ? ORDER BY e.id`
  ).all(claimId);
  claim.documents = db.prepare('SELECT * FROM insurance_documents WHERE claim_id = ? ORDER BY id').all(claimId);
  return claim;
}

function fullPreauth(preauthId) {
  const pa = db.prepare(
    `SELECT pa.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            p.age_years, p.gender, p.phone,
            i.name AS insurer_name, i.kind AS insurer_kind, i.preauth_tat_hours,
            pp.policy_no, pp.member_id, pp.sum_insured, pp.sum_utilised, pp.copay_pct, pp.room_rent_limit,
            u.name AS doctor_name, a.ip_no, v.visit_no,
            parent.preauth_no AS parent_no
       FROM preauths pa
       JOIN patients p ON p.id = pa.patient_id
       JOIN insurers i ON i.id = pa.insurer_id
       JOIN patient_policies pp ON pp.id = pa.policy_id
       LEFT JOIN users u ON u.id = pa.doctor_id
       LEFT JOIN admissions a ON a.id = pa.admission_id
       LEFT JOIN visits v ON v.id = pa.visit_id
       LEFT JOIN preauths parent ON parent.id = pa.parent_id
      WHERE pa.id = ?`
  ).get(preauthId);
  if (!pa) return null;
  pa.events = db.prepare(
    `SELECT e.*, u.name AS actor_name FROM preauth_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.preauth_id = ? ORDER BY e.id`
  ).all(preauthId);
  pa.documents = db.prepare('SELECT * FROM insurance_documents WHERE preauth_id = ? ORDER BY id').all(preauthId);
  pa.enhancements = db.prepare(
    "SELECT id, preauth_no, status, requested_amount, approved_amount FROM preauths WHERE parent_id = ? ORDER BY id"
  ).all(preauthId);
  return pa;
}

module.exports = {
  round2, policyWithInsurer, balanceSumInsured, eligibility,
  logPreauth, logClaim, recalcClaim, buildClaimItems, settle, episodeCover,
  syncInvoiceCover, committedOnPolicy, seedDocuments, fullClaim, fullPreauth,
  PREAUTH_DOCUMENTS, CLAIM_DOCUMENTS, looksNonAdmissible,
};
