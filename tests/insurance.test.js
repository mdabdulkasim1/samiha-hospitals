'use strict';
/**
 * Insurance / TPA lifecycle:
 *   policy → eligibility → pre-authorisation → query → approval → enhancement
 *   → claim from the invoice → submission → approval → settlement
 * with the accounting checked at every step: the patient must only ever owe
 * their own share, and any shortfall at settlement must return to them.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-ins-')), 'test.db');
process.env.DB_FILE = tmpDb;
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
    ['cashier', 'cashier@samiha.local'], ['doctor', 'imran@samiha.local'],
    ['ward', 'ward@samiha.local'], ['nurse', 'nurse@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }

  ids.drImran = (await api('GET', '/api/masters/staff?role=doctor', undefined, 'admin')).body
    .find((d) => d.email === 'imran@samiha.local').id;
  const insurers = (await api('GET', '/api/insurance/insurers', undefined, 'cashier')).body;
  ids.star = insurers.find((i) => i.code === 'STAR').id;
  ids.icici = insurers.find((i) => i.code === 'ICICILOM').id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
});

test('insurer directory separates insurers, TPAs and government schemes', async () => {
  const all = (await api('GET', '/api/insurance/insurers', undefined, 'cashier')).body;
  assert.ok(all.some((i) => i.kind === 'tpa'));
  assert.ok(all.some((i) => i.kind === 'government_scheme'));
  // ICICI Lombard is administered by Medi Assist in the seed data.
  const icici = all.find((i) => i.code === 'ICICILOM');
  assert.match(icici.administered_by_name, /Medi Assist/);

  const onlyTpas = (await api('GET', '/api/insurance/insurers?kind=tpa', undefined, 'cashier')).body;
  assert.ok(onlyTpas.length > 0 && onlyTpas.every((i) => i.kind === 'tpa'));
});

test('eligibility applies room-rent cap, co-pay and the sum-insured balance', async () => {
  const patient = (await api('POST', '/api/patients', {
      consentTreatment: true, consentPrivacy: true,
    firstName: 'Eligibility', lastName: 'Case', gender: 'male', age: 50, phone: '9700000001',
  }, 'reception')).body;

  const policy = (await api('POST', '/api/insurance/policies', {
    patientId: patient.id, insurerId: ids.star, policyNo: 'STAR/ELIG/1',
    memberId: 'M-1', sumInsured: 100000, sumUtilised: 20000, copayPct: 10,
    roomRentLimit: 2000, validFrom: '2020-01-01', validTo: '2099-12-31',
  }, 'cashier')).body;
  ids.eligPolicy = policy.id;

  // Registering a policy clears the "uninsured" flag used by the screening lane.
  const refreshed = (await api('GET', `/api/patients/${patient.id}`, undefined, 'reception')).body;
  assert.strictEqual(refreshed.is_uninsured, 0);

  // Room within the cap: no proportionate deduction, only co-pay.
  const within = (await api('GET',
    `/api/insurance/policies/${policy.id}/eligibility?estimate=50000&roomTariff=1800&stayDays=3`,
    undefined, 'cashier')).body;
  assert.strictEqual(within.balance, 80000);
  assert.strictEqual(within.roomRent.withinLimit, true);
  assert.strictEqual(within.copayAmount, 5000);        // 10% of 50000
  assert.strictEqual(within.maxCashless, 45000);
  assert.strictEqual(within.patientBears, 5000);
  assert.strictEqual(within.eligible, true);

  // Room above the cap: proportionate deduction across the whole bill first.
  const over = (await api('GET',
    `/api/insurance/policies/${policy.id}/eligibility?estimate=50000&roomTariff=3200&stayDays=3`,
    undefined, 'cashier')).body;
  assert.strictEqual(over.roomRent.withinLimit, false);
  assert.strictEqual(over.roomRent.excessPerDay, 1200);
  assert.strictEqual(over.roomRent.excessOverStay, 3600);
  // 2000/3200 = 0.625 eligible → 31250, less 10% co-pay → 28125
  assert.strictEqual(over.maxCashless, 28125);
  assert.ok(over.warnings.some((w) => /proportionate deduction/.test(w)));

  // Cashless is capped by the remaining sum insured, not the estimate.
  const big = (await api('GET',
    `/api/insurance/policies/${policy.id}/eligibility?estimate=500000`, undefined, 'cashier')).body;
  assert.strictEqual(big.maxCashless, 80000);
});

test('an expired or exhausted policy blocks a pre-authorisation', async () => {
  const patient = (await api('POST', '/api/patients', {
      consentTreatment: true, consentPrivacy: true,
    firstName: 'Expired', lastName: 'Policy', gender: 'female', age: 40, phone: '9700000002',
  }, 'reception')).body;

  const expired = (await api('POST', '/api/insurance/policies', {
    patientId: patient.id, insurerId: ids.star, policyNo: 'STAR/EXP/1',
    sumInsured: 200000, validFrom: '2019-01-01', validTo: '2020-01-01',
  }, 'cashier')).body;

  const check = (await api('GET', `/api/insurance/policies/${expired.id}/eligibility`, undefined, 'cashier')).body;
  assert.strictEqual(check.eligible, false);
  assert.ok(check.blockers.some((b) => /expired/i.test(b)));

  const attempt = await api('POST', '/api/insurance/preauths', {
    policyId: expired.id, requestedAmount: 10000, diagnosis: 'Anything',
  }, 'cashier');
  assert.strictEqual(attempt.status, 409);
  assert.match(attempt.body.error, /expired/i);

  const exhausted = (await api('POST', '/api/insurance/policies', {
    patientId: patient.id, insurerId: ids.icici, policyNo: 'ICICI/EXH/1',
    sumInsured: 50000, sumUtilised: 50000, validTo: '2099-12-31',
  }, 'cashier')).body;
  const exCheck = (await api('GET', `/api/insurance/policies/${exhausted.id}/eligibility`, undefined, 'cashier')).body;
  assert.strictEqual(exCheck.eligible, false);
  assert.ok(exCheck.blockers.some((b) => /fully utilised/i.test(b)));
});

test('cashless admission: pre-auth → query → approval → enhancement → claim → settlement', async () => {
  // ---- patient and policy -----------------------------------------------
  const patient = (await api('POST', '/api/patients', {
      consentTreatment: true, consentPrivacy: true,
    firstName: 'Cashless', lastName: 'Journey', gender: 'male', age: 58, phone: '9700000003',
  }, 'reception')).body;

  const policy = (await api('POST', '/api/insurance/policies', {
    patientId: patient.id, insurerId: ids.icici, policyNo: 'ICICI/CASH/9001',
    memberId: 'MA-778812', sumInsured: 300000, copayPct: 10,
    roomRentLimit: 5000, validFrom: '2024-01-01', validTo: '2099-12-31',
  }, 'cashier')).body;
  await api('POST', `/api/insurance/policies/${policy.id}/verify`, { notes: 'Card seen at the desk' }, 'cashier');

  // ---- admit -------------------------------------------------------------
  const wards = (await api('GET', '/api/ipd/wards', undefined, 'ward')).body;
  const bed = wards.wards.flatMap((w) => w.beds).find((b) => b.status === 'vacant');
  const admission = (await api('POST', '/api/ipd/admissions', {
    patientId: patient.id, doctorId: ids.drImran, bedId: bed.id,
    admissionType: 'planned', reason: 'Elective cholecystectomy',
    provisionalDiagnosis: 'Symptomatic cholelithiasis',
  }, 'ward')).body;

  // ---- pre-authorisation -------------------------------------------------
  const raised = await api('POST', '/api/insurance/preauths', {
    policyId: policy.id, admissionId: admission.id, doctorId: ids.drImran,
    kind: 'planned', icdCode: 'K21.9', diagnosis: 'Symptomatic cholelithiasis',
    procedureName: 'Laparoscopic cholecystectomy',
    treatmentPlan: 'Lap chole under GA, 3-day stay',
    estimatedStayDays: 3, roomCategory: 'Semi-private', requestedAmount: 80000,
    roomTariffPerDay: 1800,
  }, 'cashier');
  assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
  const preauthId = raised.body.preauth.id;
  assert.match(raised.body.preauth.preauth_no, /^PA/);
  assert.strictEqual(raised.body.preauth.status, 'draft');
  // The document checklist is seeded unticked.
  assert.ok(raised.body.preauth.documents.length >= 6);
  assert.ok(raised.body.preauth.documents.every((d) => d.provided === 0));

  // Submitting with papers outstanding is refused …
  const early = await api('POST', `/api/insurance/preauths/${preauthId}/submit`, {}, 'cashier');
  assert.strictEqual(early.status, 409);
  assert.match(early.body.error, /document\(s\) still not collected/);

  // … until they are ticked off.
  for (const doc of raised.body.preauth.documents) {
    await api('PATCH', `/api/insurance/documents/${doc.id}`, { provided: true }, 'cashier');
  }
  const submitted = await api('POST', `/api/insurance/preauths/${preauthId}/submit`,
    { referenceNo: 'MA/REQ/55120' }, 'cashier');
  assert.strictEqual(submitted.status, 200);
  assert.strictEqual(submitted.body.status, 'submitted');

  // ---- the TPA raises a query -------------------------------------------
  const queried = await api('POST', `/api/insurance/preauths/${preauthId}/query`, {
    query: 'Send previous ultrasound report and duration of symptoms.',
    documentsRequested: ['Previous USG report'],
  }, 'cashier');
  assert.strictEqual(queried.status, 200);
  assert.strictEqual(queried.body.status, 'query_raised');
  assert.ok(queried.body.documents.some((d) => d.doc_type === 'Previous USG report'));

  // No decision is possible while a query stands unanswered.
  const premature = await api('POST', `/api/insurance/preauths/${preauthId}/decision`, {
    decision: 'approved', approvedAmount: 60000,
  }, 'cashier');
  assert.strictEqual(premature.status, 200, 'answering by decision is allowed from query_raised');

  // ---- approval ----------------------------------------------------------
  const approvedPreauth = premature.body.preauth;
  assert.strictEqual(approvedPreauth.status, 'approved');
  assert.strictEqual(approvedPreauth.approved_amount, 60000);
  assert.strictEqual(approvedPreauth.copay_amount, 6000);   // 10% co-pay

  // The approval, net of co-pay, is already sitting on the IP invoice.
  const invoiceId = (await api('GET', `/api/ipd/admissions/${admission.id}`, undefined, 'ward')).body.invoice.id;
  let invoice = (await api('GET', `/api/billing/invoices/${invoiceId}`, undefined, 'cashier')).body;
  assert.strictEqual(invoice.insurance_covered, 54000);

  // Over-approving beyond what was asked is refused.
  const over = await api('POST', `/api/insurance/preauths/${preauthId}/decision`, {
    decision: 'approved', approvedAmount: 999999,
  }, 'cashier');
  assert.strictEqual(over.status, 409, 'a decided pre-auth has no decision pending');

  // ---- the stay overruns → enhancement -----------------------------------
  const enhancement = await api('POST', `/api/insurance/preauths/${preauthId}/enhance`, {
    requestedAmount: 25000, reason: 'Converted to open procedure; two extra days in the ward.',
    estimatedStayDays: 2,
  }, 'cashier');
  assert.strictEqual(enhancement.status, 201, JSON.stringify(enhancement.body));
  assert.strictEqual(enhancement.body.kind, 'enhancement');
  assert.strictEqual(enhancement.body.parent_no, approvedPreauth.preauth_no);

  const enhId = enhancement.body.id;
  for (const doc of enhancement.body.documents) {
    await api('PATCH', `/api/insurance/documents/${doc.id}`, { provided: true }, 'cashier');
  }
  await api('POST', `/api/insurance/preauths/${enhId}/submit`, {}, 'cashier');
  const enhDecision = await api('POST', `/api/insurance/preauths/${enhId}/decision`, {
    decision: 'partially_approved', approvedAmount: 18000, approvalNo: 'MA/ENH/9912',
  }, 'cashier');
  assert.strictEqual(enhDecision.status, 200);
  assert.strictEqual(enhDecision.body.preauth.approved_amount, 18000);

  // ---- charges accrue and the patient is discharged ----------------------
  await api('POST', `/api/ipd/admissions/${admission.id}/charges`, {
    description: 'Laparoscopic cholecystectomy — surgeon and theatre', qty: 1, unitPrice: 65000,
  }, 'ward');
  await api('POST', `/api/ipd/admissions/${admission.id}/charges`, {
    description: 'Registration / record card', qty: 1, unitPrice: 50,
  }, 'ward');
  await api('POST', `/api/ipd/admissions/${admission.id}/charges`, {
    description: 'Nursing charges', qty: 3, unitPrice: 400,
  }, 'ward');

  // The root approval and the enhancement both sit on the invoice: 54000 + 16200.
  invoice = (await api('GET', `/api/billing/invoices/${invoiceId}`, undefined, 'cashier')).body;
  assert.strictEqual(invoice.insurance_covered, 70200,
    'an enhancement must add to the cover, not replace it');

  let discharge = await api('POST', `/api/ipd/admissions/${admission.id}/discharge`, {
    finalDiagnosis: 'Cholelithiasis — post lap cholecystectomy',
    dischargeType: 'recovered', courseInHospital: 'Uneventful recovery.',
  }, 'ward');

  // Whatever the insurer does not carry has to be settled before the patient leaves.
  if (discharge.status === 409) {
    invoice = discharge.body.invoice;
    assert.ok(invoice.balance < invoice.gross, 'the insurer is carrying most of the bill');
    await api('POST', `/api/billing/invoices/${invoiceId}/payments`, {
      amount: invoice.balance, mode: 'upi', reference: 'copay-upi-1',
    }, 'cashier');
    discharge = await api('POST', `/api/ipd/admissions/${admission.id}/discharge`, {
      finalDiagnosis: 'Cholelithiasis — post lap cholecystectomy', dischargeType: 'recovered',
    }, 'ward');
  }
  assert.strictEqual(discharge.status, 200, JSON.stringify(discharge.body));

  // ---- claim -------------------------------------------------------------
  const claimRes = await api('POST', '/api/insurance/claims', {
    policyId: policy.id, invoiceId, preauthId, claimType: 'cashless',
  }, 'cashier');
  assert.strictEqual(claimRes.status, 201, JSON.stringify(claimRes.body));
  const claim = claimRes.body;
  ids.claim = claim.id;
  assert.match(claim.claim_no, /^CLM/);
  assert.ok(claim.items.length >= 3);

  // The registration charge is pre-marked as non-admissible.
  const regLine = claim.items.find((i) => /registration/i.test(i.description));
  assert.ok(regLine, 'the registration line should be on the claim');
  assert.strictEqual(regLine.admissible, 0);
  assert.strictEqual(regLine.claimed, 0);
  assert.ok(claim.claimed_amount < claim.billed_amount, 'exclusions reduce what is claimed');

  // A second claim on the same invoice is refused.
  const dup = await api('POST', '/api/insurance/claims', { policyId: policy.id, invoiceId }, 'cashier');
  assert.strictEqual(dup.status, 409);

  // ---- submit, query, approve -------------------------------------------
  for (const doc of claim.documents) {
    await api('PATCH', `/api/insurance/documents/${doc.id}`, { provided: true }, 'cashier');
  }
  const claimSubmitted = await api('POST', `/api/insurance/claims/${claim.id}/submit`, {}, 'cashier');
  assert.strictEqual(claimSubmitted.status, 200);
  assert.strictEqual(claimSubmitted.body.status, 'submitted');
  assert.ok(claimSubmitted.body.due_at, 'a settlement due date is set from the insurer TAT');

  // Settling before approval is refused.
  const earlySettle = await api('POST', `/api/insurance/claims/${claim.id}/settle`,
    { settledAmount: 1000 }, 'cashier');
  assert.strictEqual(earlySettle.status, 409);

  const claimApproved = await api('POST', `/api/insurance/claims/${claim.id}/decision`, {
    decision: 'approved', approvedAmount: 60000, disallowReason: 'Consumables partly disallowed',
  }, 'cashier');
  assert.strictEqual(claimApproved.status, 200, JSON.stringify(claimApproved.body));
  assert.strictEqual(claimApproved.body.claim.status, 'approved');
  assert.strictEqual(claimApproved.body.claim.approved_amount, 60000);
  assert.strictEqual(claimApproved.body.claim.copay_amount, 6000);
  // Settling the claim re-points the invoice at the claim's own approval.
  assert.strictEqual(claimApproved.body.invoice.insurance_covered, 54000);

  // ---- settlement, short of the approval --------------------------------
  const settled = await api('POST', `/api/insurance/claims/${claim.id}/settle`, {
    settledAmount: 50000, tdsAmount: 1000, utrNo: 'UTR-77219931',
    disallowReason: 'Two consumable lines deducted on audit',
  }, 'cashier');
  assert.strictEqual(settled.status, 200, JSON.stringify(settled.body));
  assert.strictEqual(settled.body.claim.status, 'partially_settled');
  assert.strictEqual(settled.body.claim.settled_amount, 50000);
  // Approved 60000, received 50000 + 1000 TDS → 9000 short.
  assert.strictEqual(settled.body.shortfall, 9000);
  assert.match(settled.body.note, /sits on the patient's balance/);

  // The shortfall really did move back onto the patient.
  assert.strictEqual(settled.body.invoice.insurance_covered, 51000);
  const before = 54000;
  assert.strictEqual(
    Math.round((settled.body.invoice.net - (before - 51000)) * 100) / 100,
    Math.round((settled.body.invoice.gross + settled.body.invoice.tax
      - settled.body.invoice.discount - settled.body.invoice.sliding_discount
      - settled.body.invoice.assistance_covered - before) * 100) / 100,
    'the invoice net rose by exactly the shortfall'
  );

  // And the policy's utilisation went up by what was actually paid.
  const policies = (await api('GET', `/api/insurance/policies?patientId=${patient.id}`, undefined, 'cashier')).body;
  const used = policies.find((p) => p.id === policy.id);
  assert.strictEqual(used.sum_utilised, 51000);
  assert.strictEqual(used.balance, 249000);

  // Over-recovering beyond the approval is refused.
  const tooMuch = await api('POST', `/api/insurance/claims/${claim.id}/settle`,
    { settledAmount: 50000 }, 'cashier');
  assert.strictEqual(tooMuch.status, 409);
  assert.match(tooMuch.body.error, /more than the approved/);
});

test('settlements arriving in tranches accumulate and close the claim', async () => {
  const patient = (await api('POST', '/api/patients', {
      consentTreatment: true, consentPrivacy: true,
    firstName: 'Tranche', lastName: 'Payer', gender: 'male', age: 47, phone: '9700000006',
  }, 'reception')).body;
  const policy = (await api('POST', '/api/insurance/policies', {
    patientId: patient.id, insurerId: ids.icici, policyNo: 'ICICI/TRN/1',
    sumInsured: 200000, validTo: '2099-12-31',
  }, 'cashier')).body;

  const invoice = (await api('POST', '/api/billing/invoices', { patientId: patient.id }, 'cashier')).body;
  await api('POST', `/api/billing/invoices/${invoice.id}/items`, {
    description: 'Angiography', qty: 1, unitPrice: 40000,
  }, 'cashier');

  const claim = (await api('POST', '/api/insurance/claims', {
    policyId: policy.id, invoiceId: invoice.id, claimType: 'cashless',
  }, 'cashier')).body;
  for (const doc of claim.documents) {
    await api('PATCH', `/api/insurance/documents/${doc.id}`, { provided: true }, 'cashier');
  }
  await api('POST', `/api/insurance/claims/${claim.id}/submit`, {}, 'cashier');
  await api('POST', `/api/insurance/claims/${claim.id}/decision`,
    { decision: 'approved', approvedAmount: 40000 }, 'cashier');

  // First tranche — the claim stays open and the rest is still awaited.
  const first = await api('POST', `/api/insurance/claims/${claim.id}/settle`,
    { settledAmount: 25000, utrNo: 'UTR-A' }, 'cashier');
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));
  assert.strictEqual(first.body.claim.status, 'partially_settled');
  assert.strictEqual(first.body.claim.settled_amount, 25000);
  assert.strictEqual(first.body.awaited, 15000);
  assert.strictEqual(first.body.shortfall, 0, 'an open tranche is not a shortfall');
  assert.strictEqual(first.body.invoice.insurance_covered, 25000);

  // Second tranche clears it — the receipts add up rather than overwrite.
  const second = await api('POST', `/api/insurance/claims/${claim.id}/settle`,
    { settledAmount: 15000, utrNo: 'UTR-B' }, 'cashier');
  assert.strictEqual(second.status, 200, JSON.stringify(second.body));
  assert.strictEqual(second.body.claim.status, 'settled');
  assert.strictEqual(second.body.claim.settled_amount, 40000);
  assert.strictEqual(second.body.invoice.insurance_covered, 40000);
  assert.strictEqual(second.body.invoice.balance, 0);

  // The policy was drawn down once per receipt, not once per call.
  const policies = (await api('GET', `/api/insurance/policies?patientId=${patient.id}`, undefined, 'cashier')).body;
  assert.strictEqual(policies[0].sum_utilised, 40000);
});

test('a rejected claim puts the whole bill back on the patient', async () => {
  const patient = (await api('POST', '/api/patients', {
      consentTreatment: true, consentPrivacy: true,
    firstName: 'Rejected', lastName: 'Claim', gender: 'female', age: 44, phone: '9700000004',
  }, 'reception')).body;
  const policy = (await api('POST', '/api/insurance/policies', {
    patientId: patient.id, insurerId: ids.star, policyNo: 'STAR/REJ/1',
    sumInsured: 100000, validTo: '2099-12-31',
  }, 'cashier')).body;

  const invoice = (await api('POST', '/api/billing/invoices', {
    patientId: patient.id, kind: 'opd',
  }, 'cashier')).body;
  await api('POST', `/api/billing/invoices/${invoice.id}/items`, {
    description: 'Day-care procedure', qty: 1, unitPrice: 20000,
  }, 'cashier');

  const claim = (await api('POST', '/api/insurance/claims', {
    policyId: policy.id, invoiceId: invoice.id, claimType: 'cashless',
  }, 'cashier')).body;
  for (const doc of claim.documents) {
    await api('PATCH', `/api/insurance/documents/${doc.id}`, { provided: true }, 'cashier');
  }
  await api('POST', `/api/insurance/claims/${claim.id}/submit`, {}, 'cashier');
  await api('POST', `/api/insurance/claims/${claim.id}/decision`, {
    decision: 'approved', approvedAmount: 18000,
  }, 'cashier');

  let inv = (await api('GET', `/api/billing/invoices/${invoice.id}`, undefined, 'cashier')).body;
  assert.strictEqual(inv.insurance_covered, 18000);
  assert.strictEqual(inv.balance, 2000);

  // A later rejection on appeal hands the full amount back to the patient.
  const rejected = await api('POST', `/api/insurance/claims/${claim.id}/cancel`,
    { reason: 'Withdrawn — patient opted for reimbursement' }, 'cashier');
  assert.strictEqual(rejected.status, 200);
  inv = (await api('GET', `/api/billing/invoices/${invoice.id}`, undefined, 'cashier')).body;
  assert.strictEqual(inv.insurance_covered, 0);
  assert.strictEqual(inv.balance, 20000);
});

test('reimbursement claims do not touch the invoice', async () => {
  const patient = (await api('POST', '/api/patients', {
      consentTreatment: true, consentPrivacy: true,
    firstName: 'Reimburse', lastName: 'Case', gender: 'male', age: 36, phone: '9700000005',
  }, 'reception')).body;
  const policy = (await api('POST', '/api/insurance/policies', {
    patientId: patient.id, insurerId: ids.star, policyNo: 'STAR/REIMB/1',
    sumInsured: 100000, validTo: '2099-12-31',
  }, 'cashier')).body;

  const invoice = (await api('POST', '/api/billing/invoices', { patientId: patient.id }, 'cashier')).body;
  await api('POST', `/api/billing/invoices/${invoice.id}/items`, {
    description: 'Consultation and investigations', qty: 1, unitPrice: 8000,
  }, 'cashier');
  // The patient pays the hospital in full and claims from the insurer themselves.
  await api('POST', `/api/billing/invoices/${invoice.id}/payments`, { amount: 8000, mode: 'cash' }, 'cashier');

  const claim = (await api('POST', '/api/insurance/claims', {
    policyId: policy.id, invoiceId: invoice.id, claimType: 'reimbursement',
  }, 'cashier')).body;
  for (const doc of claim.documents) {
    await api('PATCH', `/api/insurance/documents/${doc.id}`, { provided: true }, 'cashier');
  }
  await api('POST', `/api/insurance/claims/${claim.id}/submit`, {}, 'cashier');
  await api('POST', `/api/insurance/claims/${claim.id}/decision`,
    { decision: 'approved', approvedAmount: 7000 }, 'cashier');
  await api('POST', `/api/insurance/claims/${claim.id}/settle`,
    { settledAmount: 7000, utrNo: 'UTR-REIMB-1' }, 'cashier');

  const inv = (await api('GET', `/api/billing/invoices/${invoice.id}`, undefined, 'cashier')).body;
  assert.strictEqual(inv.insurance_covered, 0, 'reimbursement pays the patient, not the hospital');
  assert.strictEqual(inv.status, 'paid');
  assert.strictEqual(inv.balance, 0);

  const policies = (await api('GET', `/api/insurance/policies?patientId=${patient.id}`, undefined, 'cashier')).body;
  assert.strictEqual(policies[0].sum_utilised, 7000, 'the policy is still drawn down');
});

test('receivables ageing reports what is stuck with each insurer', async () => {
  const r = await api('GET', '/api/insurance/receivables', undefined, 'cashier');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.byInsurer));
  assert.ok(r.body.ageing);
  assert.ok(Array.isArray(r.body.overdue));
});

test('a nurse cannot register a policy or settle a claim', async () => {
  const policy = await api('POST', '/api/insurance/policies', {
    patientId: 1, insurerId: ids.star, policyNo: 'X', sumInsured: 1000,
  }, 'nurse');
  assert.strictEqual(policy.status, 403);

  const settle = await api('POST', `/api/insurance/claims/${ids.claim}/settle`,
    { settledAmount: 1 }, 'nurse');
  assert.strictEqual(settle.status, 403);
});
