'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, badRequest, conflict } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, num, money, paging } = require('../lib/validate');
const { generate } = require('../lib/ids');
const billing = require('../services/billing');
const whatsapp = require('../services/whatsapp');
const audit = require('../lib/audit');

const router = express.Router();
const cashRoles = requireRole('cashier', 'reception');
const viewRoles = requireRole('cashier', 'reception', 'doctor', 'counselor', 'ward');

router.get('/invoices', viewRoles, wrap((req, res) => {
  const status = str(req.query.status);
  const patientId = req.query.patientId ? int(req.query.patientId) : null;
  const { limit, offset, page } = paging(req.query, 50);
  const rows = db.prepare(
    `SELECT i.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name, p.phone,
            v.visit_no, a.ip_no
       FROM invoices i JOIN patients p ON p.id = i.patient_id
       LEFT JOIN visits v ON v.id = i.visit_id LEFT JOIN admissions a ON a.id = i.admission_id
      WHERE (? IS NULL OR i.status = ?) AND (? IS NULL OR i.patient_id = ?)
      ORDER BY i.id DESC LIMIT ? OFFSET ?`
  ).all(status, status, patientId, patientId, limit, offset);
  const totals = db.prepare(
    `SELECT COALESCE(SUM(net),0) AS billed, COALESCE(SUM(paid),0) AS collected,
            COALESCE(SUM(CASE WHEN status IN ('unpaid','partial') THEN balance ELSE 0 END),0) AS outstanding
       FROM invoices WHERE status != 'cancelled'`
  ).get();
  res.json({ rows, totals, page, limit });
}));

router.get('/invoices/:id', viewRoles, wrap((req, res) => {
  const inv = billing.fullInvoice(int(req.params.id));
  if (!inv) throw notFound('Invoice not found');
  res.json(inv);
}));

router.post('/invoices', cashRoles, wrap((req, res) => {
  required(req.body, ['patientId']);
  const inv = billing.createInvoice({
    patientId: int(req.body.patientId), visitId: int(req.body.visitId) || null,
    admissionId: int(req.body.admissionId) || null, kind: str(req.body.kind, 'opd'),
    createdBy: req.user.id, notes: str(req.body.notes),
  });
  audit.log(req, 'create', 'invoice', inv.id, { invoiceNo: inv.invoice_no });
  res.status(201).json(billing.fullInvoice(inv.id));
}));

router.post('/invoices/:id/items', cashRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw notFound('Invoice not found');
  if (['paid', 'cancelled'].includes(inv.status)) throw conflict(`Cannot add items to a ${inv.status} invoice.`);
  required(req.body, ['description', 'unitPrice']);
  billing.addItem(id, {
    refType: str(req.body.refType, 'service'), refId: int(req.body.refId) || null,
    description: str(req.body.description), qty: num(req.body.qty, 1) || 1,
    unitPrice: money(req.body.unitPrice), discount: money(req.body.discount, 0), taxPct: num(req.body.taxPct, 0),
  });
  audit.log(req, 'add_item', 'invoice', id);
  res.status(201).json(billing.fullInvoice(id));
}));

router.delete('/invoices/:id/items/:itemId', cashRoles, wrap((req, res) => {
  const id = int(req.params.id);
  db.prepare('DELETE FROM invoice_items WHERE id = ? AND invoice_id = ?').run(int(req.params.itemId), id);
  billing.recalc(id);
  res.json(billing.fullInvoice(id));
}));

router.post('/invoices/:id/discount', cashRoles, wrap((req, res) => {
  const id = int(req.params.id);
  if (req.body.slidingScalePct !== undefined) billing.applySlidingScale(id, num(req.body.slidingScalePct));
  if (req.body.assistanceAmount !== undefined) billing.applyAssistance(id, money(req.body.assistanceAmount));
  if (req.body.insuranceAmount !== undefined) {
    db.prepare('UPDATE invoices SET insurance_covered = ? WHERE id = ?').run(money(req.body.insuranceAmount), id);
    billing.recalc(id);
  }
  audit.log(req, 'discount', 'invoice', id, req.body);
  res.json(billing.fullInvoice(id));
}));

// ------------------------------------------------------------- 1. Accept payment
/** "Patient Able To Pay For Labs and Visit?" → Yes → "Accept Payment". */
router.post('/invoices/:id/payments', cashRoles, wrap((req, res) => {
  const id = int(req.params.id);
  required(req.body, ['amount', 'mode']);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw notFound('Invoice not found');
  if (inv.status === 'cancelled') throw conflict('This invoice is cancelled.');

  const amount = money(req.body.amount);
  if (amount <= 0) throw badRequest('Payment amount must be greater than zero.');
  if (amount - inv.balance > 0.009) {
    throw badRequest(`Payment of ${amount} exceeds the outstanding balance of ${inv.balance.toFixed(2)}.`);
  }

  const { receiptNo, invoice } = billing.addPayment(id, {
    patientId: inv.patient_id, amount, mode: str(req.body.mode),
    reference: str(req.body.reference), notes: str(req.body.notes), receivedBy: req.user.id,
  });

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(inv.patient_id);
  const to = patient.whatsapp || patient.phone;
  if (to) {
    whatsapp.notify({
      to, template: 'payment_receipt', refType: 'invoice', refId: id,
      data: { amount: amount.toFixed(2), mode: str(req.body.mode), receiptNo,
              invoiceNo: invoice.invoice_no, balance: invoice.balance.toFixed(2) },
    });
  }
  audit.log(req, 'payment', 'invoice', id, { receiptNo, amount, mode: req.body.mode });
  res.status(201).json({ receiptNo, invoice: billing.fullInvoice(id) });
}));

// -------------------------------------------------- 2. Payment Plan Agreement
/**
 * "No, or Not Completely" → "Payment Plan Agreement Form".
 * Generates the instalment schedule the patient signs against.
 */
router.post('/invoices/:id/payment-plan', cashRoles, wrap((req, res) => {
  const id = int(req.params.id);
  required(req.body, ['installments']);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw notFound('Invoice not found');
  if (inv.balance <= 0) throw conflict('This invoice has no outstanding balance.');

  const existing = db.prepare("SELECT * FROM payment_plans WHERE invoice_id = ? AND status = 'active'").get(id);
  if (existing) throw conflict(`An active payment plan already exists (${existing.agreement_no}).`);

  const installments = int(req.body.installments);
  if (installments < 1 || installments > 60) throw badRequest('Instalments must be between 1 and 60.');

  const downPayment = money(req.body.downPayment, 0);
  if (downPayment > inv.balance) throw badRequest('Down payment cannot exceed the outstanding balance.');
  const financed = billing.round2(inv.balance - downPayment);
  const perInstallment = billing.round2(financed / installments);
  const frequency = str(req.body.frequency, 'monthly');
  const startDate = str(req.body.startDate) || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const agreementNo = generate('paymentPlan');

  const planId = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO payment_plans (agreement_no, invoice_id, patient_id, total_amount, down_payment,
                                  installments, installment_amount, frequency, start_date, notes, agreed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(agreementNo, id, inv.patient_id, financed, downPayment, installments, perInstallment,
          frequency, startDate, str(req.body.notes), req.user.id);

    const stepDays = frequency === 'weekly' ? 7 : frequency === 'fortnightly' ? 14 : 30;
    let allocated = 0;
    for (let i = 0; i < installments; i += 1) {
      const due = new Date(new Date(startDate).getTime() + i * stepDays * 86400000).toISOString().slice(0, 10);
      // The last instalment absorbs any rounding remainder.
      const amount = i === installments - 1 ? billing.round2(financed - allocated) : perInstallment;
      allocated = billing.round2(allocated + amount);
      db.prepare('INSERT INTO payment_plan_installments (plan_id, seq, due_date, amount) VALUES (?, ?, ?, ?)')
        .run(info.lastInsertRowid, i + 1, due, amount);
    }
    return info.lastInsertRowid;
  })();

  if (downPayment > 0) {
    billing.addPayment(id, { patientId: inv.patient_id, amount: downPayment,
      mode: str(req.body.downPaymentMode, 'cash'), notes: `Down payment for plan ${agreementNo}`, receivedBy: req.user.id });
  }

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(inv.patient_id);
  const to = patient.whatsapp || patient.phone;
  if (to) {
    whatsapp.notify({ to, template: 'payment_plan', refType: 'payment_plan', refId: planId,
      data: { agreementNo, installments, installmentAmount: perInstallment.toFixed(2), frequency, startDate } });
  }

  audit.log(req, 'create', 'payment_plan', planId, { agreementNo, financed, installments });
  res.status(201).json({
    plan: db.prepare('SELECT * FROM payment_plans WHERE id = ?').get(planId),
    schedule: db.prepare('SELECT * FROM payment_plan_installments WHERE plan_id = ? ORDER BY seq').all(planId),
    invoice: billing.fullInvoice(id),
  });
}));

router.get('/payment-plans', viewRoles, wrap((req, res) => {
  res.json(db.prepare(
    `SELECT pp.*, i.invoice_no, i.balance AS invoice_balance, p.uhid,
            (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name, p.phone,
            (SELECT MIN(due_date) FROM payment_plan_installments WHERE plan_id = pp.id AND status = 'due') AS next_due
       FROM payment_plans pp JOIN invoices i ON i.id = pp.invoice_id JOIN patients p ON p.id = pp.patient_id
      WHERE (? IS NULL OR pp.status = ?)
      ORDER BY pp.id DESC LIMIT 200`
  ).all(str(req.query.status), str(req.query.status)));
}));

/** Record an instalment payment and roll the plan forward. */
router.post('/payment-plans/:id/installments/:seq/pay', cashRoles, wrap((req, res) => {
  const planId = int(req.params.id);
  const plan = db.prepare('SELECT * FROM payment_plans WHERE id = ?').get(planId);
  if (!plan) throw notFound('Payment plan not found');
  const inst = db.prepare('SELECT * FROM payment_plan_installments WHERE plan_id = ? AND seq = ?')
    .get(planId, int(req.params.seq));
  if (!inst) throw notFound('Instalment not found');
  if (inst.status === 'paid') throw conflict('This instalment is already paid.');

  const amount = money(req.body.amount, inst.amount - inst.paid);
  const { receiptNo } = billing.addPayment(plan.invoice_id, {
    patientId: plan.patient_id, amount, mode: str(req.body.mode, 'cash'),
    reference: str(req.body.reference), notes: `Instalment ${inst.seq} of plan ${plan.agreement_no}`,
    receivedBy: req.user.id,
  });

  const paid = billing.round2(inst.paid + amount);
  db.prepare('UPDATE payment_plan_installments SET paid = ?, status = ? WHERE id = ?')
    .run(paid, paid >= inst.amount - 0.009 ? 'paid' : 'due', inst.id);

  const open = db.prepare("SELECT COUNT(*) AS c FROM payment_plan_installments WHERE plan_id = ? AND status = 'due'").get(planId).c;
  if (!open) db.prepare("UPDATE payment_plans SET status = 'completed' WHERE id = ?").run(planId);

  audit.log(req, 'installment_payment', 'payment_plan', planId, { seq: inst.seq, amount });
  res.json({ receiptNo, plan: db.prepare('SELECT * FROM payment_plans WHERE id = ?').get(planId),
    schedule: db.prepare('SELECT * FROM payment_plan_installments WHERE plan_id = ? ORDER BY seq').all(planId) });
}));

// ------------------------------------------------ 3. Document payment exception
/**
 * "Document Payment Exception" — a supervisor writes off or defers a balance
 * the patient genuinely cannot pay. The reason is mandatory and audited.
 */
router.post('/invoices/:id/exception', requireRole('cashier', 'counselor'), wrap((req, res) => {
  const id = int(req.params.id);
  required(req.body, ['reason']);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw notFound('Invoice not found');
  if (inv.balance <= 0) throw conflict('This invoice has no outstanding balance.');

  const amount = money(req.body.amount, inv.balance);
  if (amount > inv.balance + 0.009) throw badRequest('Exception amount exceeds the outstanding balance.');

  const info = db.prepare(
    `INSERT INTO payment_exceptions (invoice_id, patient_id, amount, reason, approved_by, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, inv.patient_id, amount, str(req.body.reason), int(req.body.approvedBy) || req.user.id, req.user.id);

  // Recorded as an assistance write-off so the invoice closes cleanly.
  billing.applyAssistance(id, billing.round2(inv.assistance_covered + amount));
  const updated = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (updated.balance <= 0.009) {
    db.prepare("UPDATE invoices SET status = 'written_off' WHERE id = ? AND paid = 0").run(id);
  }

  audit.log(req, 'payment_exception', 'invoice', id, { amount, reason: req.body.reason });
  res.status(201).json({
    exception: db.prepare('SELECT * FROM payment_exceptions WHERE id = ?').get(info.lastInsertRowid),
    invoice: billing.fullInvoice(id),
  });
}));

// -------------------------------------------- 4. Covered by assistance program
/** "No Cost, Covered by Assistance Program" — the top branch of check-out. */
router.post('/invoices/:id/assistance-cover', requireRole('cashier', 'counselor'), wrap((req, res) => {
  const id = int(req.params.id);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw notFound('Invoice not found');
  const programId = int(req.body.assistanceProgramId) ||
    db.prepare('SELECT assistance_program_id FROM patients WHERE id = ?').get(inv.patient_id)?.assistance_program_id;
  if (!programId) throw badRequest('No assistance program is linked to this patient. Complete a financial screening first.');

  const program = db.prepare('SELECT * FROM assistance_programs WHERE id = ?').get(programId);
  if (!program) throw notFound('Assistance program not found');

  const base = Math.max(inv.gross - inv.discount - inv.sliding_discount, 0);
  const covered = billing.round2(base * (program.coverage_pct / 100));
  billing.applyAssistance(id, covered);

  audit.log(req, 'assistance_cover', 'invoice', id, { program: program.code, covered });
  res.json({ program, covered, invoice: billing.fullInvoice(id) });
}));

router.get('/receipts/:receiptNo', viewRoles, wrap((req, res) => {
  const receipt = db.prepare(
    `SELECT pay.*, i.invoice_no, i.net, i.balance, p.uhid, p.first_name, p.last_name, p.phone, u.name AS received_by_name
       FROM payments pay JOIN invoices i ON i.id = pay.invoice_id JOIN patients p ON p.id = pay.patient_id
       LEFT JOIN users u ON u.id = pay.received_by
      WHERE pay.receipt_no = ?`
  ).get(str(req.params.receiptNo));
  if (!receipt) throw notFound('Receipt not found');
  res.json(receipt);
}));

/** Day-book: what the cash counter took in, by mode. */
router.get('/daybook', viewRoles, wrap((req, res) => {
  const date = str(req.query.date) || new Date().toISOString().slice(0, 10);
  res.json({
    date,
    byMode: db.prepare(
      `SELECT mode, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
         FROM payments WHERE date(paid_at) = ? GROUP BY mode ORDER BY total DESC`
    ).all(date),
    total: db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE date(paid_at) = ?').get(date).t,
    byUser: db.prepare(
      `SELECT u.name, COUNT(*) AS count, COALESCE(SUM(pay.amount),0) AS total
         FROM payments pay LEFT JOIN users u ON u.id = pay.received_by
        WHERE date(pay.paid_at) = ? GROUP BY pay.received_by ORDER BY total DESC`
    ).all(date),
    payments: db.prepare(
      `SELECT pay.*, i.invoice_no, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name
         FROM payments pay JOIN invoices i ON i.id = pay.invoice_id JOIN patients p ON p.id = pay.patient_id
        WHERE date(pay.paid_at) = ? ORDER BY pay.id DESC`
    ).all(date),
  });
}));

module.exports = router;
