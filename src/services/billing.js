'use strict';
const { db } = require('../db');
const { generate } = require('../lib/ids');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Recompute totals from the line items plus the invoice-level adjustments. */
function recalc(invoiceId) {
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoiceId);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv) return null;

  let gross = 0;
  let lineDiscount = 0;
  let tax = 0;
  for (const it of items) {
    const line = it.qty * it.unit_price;
    const disc = it.discount || 0;
    const taxable = Math.max(line - disc, 0);
    gross += line;
    lineDiscount += disc;
    tax += taxable * ((it.tax_pct || 0) / 100);
  }
  gross = round2(gross);
  tax = round2(tax);

  // sliding_discount / assistance_covered / insurance_covered are stored as
  // absolute amounts set by the cashier or the assistance workflow, and
  // bill_discount is the one the cashier gives on the bill as a whole.
  const discount = round2(lineDiscount);
  const net = round2(Math.max(
    gross - discount - (inv.bill_discount || 0) - inv.sliding_discount
      - inv.assistance_covered - inv.insurance_covered + tax,
    0
  ));

  const paid = round2(
    db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE invoice_id = ?').get(invoiceId).s
  );
  const balance = round2(net - paid);

  let status = inv.status;
  if (status !== 'cancelled' && status !== 'written_off') {
    // A bill with nothing on it is one being made up, not one that has been
    // paid. Calling it paid would close it, and the next charge the cashier
    // pressed would be refused on a bill they are still writing.
    if (!items.length && paid <= 0) status = 'unpaid';
    else if (net <= 0) status = 'paid';
    else if (paid <= 0) status = 'unpaid';
    else if (balance > 0.009) status = 'partial';
    else status = 'paid';
  }

  db.prepare(
    `UPDATE invoices
        SET gross = ?, discount = ?, tax = ?, net = ?, paid = ?, balance = ?, status = ?,
            closed_at = CASE WHEN ? = 'paid' THEN COALESCE(closed_at, datetime('now')) ELSE NULL END
      WHERE id = ?`
  ).run(gross, discount, tax, net, paid, balance, status, status, invoiceId);

  /*
   * Settling the bill is what lets a diagnostic order through to the bench.
   *
   * It happens here rather than in the payment route because a bill reaches
   * zero by more than one road — a payment, a full concession, an insurer
   * carrying it, a write-off — and every one of them lands in this function.
   * Hooking the payment alone would have left a fully-covered patient's tests
   * stuck at a counter with nothing left to pay.
   */
  if (status === 'paid') {
    db.prepare(
      `UPDATE lab_orders
          SET released_at = datetime('now'), billing_status = 'paid'
        WHERE invoice_id = ? AND released_at IS NULL AND status != 'cancelled'`
    ).run(invoiceId);
  }

  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
}

function createInvoice({ patientId, visitId = null, admissionId = null, kind = 'opd', createdBy = null, notes = null }) {
  const info = db.prepare(
    `INSERT INTO invoices (invoice_no, patient_id, visit_id, admission_id, kind, created_by, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(generate('invoice'), patientId, visitId, admissionId, kind, createdBy, notes);
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(info.lastInsertRowid);
}

function addItem(invoiceId, { refType = null, refId = null, description, qty = 1, unitPrice = 0, discount = 0, taxPct = 0 }) {
  const amount = round2(Math.max(qty * unitPrice - discount, 0) * (1 + taxPct / 100));
  db.prepare(
    `INSERT INTO invoice_items (invoice_id, ref_type, ref_id, description, qty, unit_price, discount, tax_pct, amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(invoiceId, refType, refId, description, qty, unitPrice, discount, taxPct, amount);
  return recalc(invoiceId);
}

/** Guard against double-billing the same source line (e.g. re-running check-out). */
function hasItem(invoiceId, refType, refId) {
  return !!db.prepare(
    'SELECT 1 FROM invoice_items WHERE invoice_id = ? AND ref_type = ? AND ref_id = ?'
  ).get(invoiceId, refType, refId);
}

/**
 * Apply the sliding-scale discount from the patient's completed financial
 * screening. Recorded as an absolute amount so the invoice stays auditable
 * even if the band changes later.
 */
function applySlidingScale(invoiceId, discountPct) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv) return null;
  const base = db.prepare(
    'SELECT COALESCE(SUM(qty * unit_price - discount), 0) AS s FROM invoice_items WHERE invoice_id = ?'
  ).get(invoiceId).s;
  const amount = round2(base * (Number(discountPct || 0) / 100));
  db.prepare('UPDATE invoices SET sliding_discount = ? WHERE id = ?').run(amount, invoiceId);
  return recalc(invoiceId);
}

/** Set what the insurer is currently standing behind on this invoice. */
function applyInsurance(invoiceId, amount) {
  db.prepare('UPDATE invoices SET insurance_covered = ? WHERE id = ?').run(round2(amount), invoiceId);
  return recalc(invoiceId);
}

function applyAssistance(invoiceId, amount) {
  db.prepare('UPDATE invoices SET assistance_covered = ? WHERE id = ?').run(round2(amount), invoiceId);
  return recalc(invoiceId);
}

function addPayment(invoiceId, { patientId, amount, mode, reference = null, notes = null, receivedBy = null }) {
  const receiptNo = generate('receipt');
  db.prepare(
    `INSERT INTO payments (receipt_no, invoice_id, patient_id, amount, mode, reference, notes, received_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(receiptNo, invoiceId, patientId, round2(amount), mode, reference, notes, receivedBy);
  const invoice = recalc(invoiceId);
  return { receiptNo, invoice };
}

/** Invoice with its lines, payments, plan and any documented exception. */
function fullInvoice(invoiceId) {
  /*
   * The treating doctor comes through as their code, never their name — a bill
   * goes home with the patient and to their insurer, and the same rule applies
   * to it as to a prescription or a report.
   */
  const invoice = db.prepare(
    `SELECT i.*, p.uhid, p.first_name, p.last_name, p.phone, p.address,
            p.age_years, p.gender, p.aadhaar_number,
            dp.doctor_code, u.name AS doctor_name, v.visit_no, adm.ip_no
       FROM invoices i
       JOIN patients p ON p.id = i.patient_id
       LEFT JOIN visits v ON v.id = i.visit_id
       LEFT JOIN admissions adm ON adm.id = i.admission_id
       LEFT JOIN users u ON u.id = COALESCE(v.doctor_id, adm.doctor_id)
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
      WHERE i.id = ?`
  ).get(invoiceId);
  if (!invoice) return null;
  invoice.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoiceId);
  invoice.payments = db.prepare(
    `SELECT pay.*, u.name AS received_by_name
       FROM payments pay LEFT JOIN users u ON u.id = pay.received_by
      WHERE pay.invoice_id = ? ORDER BY pay.id`
  ).all(invoiceId);
  invoice.plan = db.prepare('SELECT * FROM payment_plans WHERE invoice_id = ? ORDER BY id DESC LIMIT 1').get(invoiceId) || null;
  if (invoice.plan) {
    invoice.plan.installments_list = db.prepare(
      'SELECT * FROM payment_plan_installments WHERE plan_id = ? ORDER BY seq'
    ).all(invoice.plan.id);
  }
  invoice.exceptions = db.prepare('SELECT * FROM payment_exceptions WHERE invoice_id = ? ORDER BY id').all(invoiceId);
  return invoice;
}

module.exports = {
  round2, recalc, createInvoice, addItem, hasItem,
  applySlidingScale, applyAssistance, applyInsurance, addPayment, fullInvoice,
};
