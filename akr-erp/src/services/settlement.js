'use strict';
const { db } = require('../db');
const { round } = require('./pricing');
const { badRequest, notFound } = require('../lib/http');

/*
 * Matching money to invoices.
 *
 * A payment is not the same thing as a settled invoice: a client pays four
 * invoices with one transfer, a supplier is paid half of one, and a cheque
 * written today may bounce next week. So money is recorded once, allocated
 * against invoices separately, and an invoice's paid figure is always the sum
 * of what has actually been allocated to it and cleared.
 */

const TABLES = {
  sales: { table: 'sales_invoices', noCol: 'invoice_no', direction: 'in' },
  purchase: { table: 'supplier_invoices', noCol: 'bill_no', direction: 'out' },
};

/** Recompute one invoice's paid amount and status from its allocations. */
function refreshInvoice(side, invoiceId) {
  const meta = TABLES[side];
  if (!meta) throw badRequest(`Unknown invoice side: ${side}`);

  const paid = round(db.prepare(
    `SELECT COALESCE(SUM(a.amount), 0) AS paid
       FROM payment_allocations a
       JOIN payments p ON p.id = a.payment_id
      WHERE a.invoice_side = ? AND a.invoice_id = ?
        AND p.status IN ('cleared','deposited')`).get(side, invoiceId).paid);

  const inv = db.prepare(`SELECT * FROM ${meta.table} WHERE id = ?`).get(invoiceId);
  if (!inv) throw notFound('That invoice no longer exists.');

  let status = inv.status;
  if (status !== 'cancelled' && status !== 'disputed') {
    if (paid + 0.005 >= round(inv.total) && inv.total > 0) status = 'paid';
    else if (paid > 0.005) status = 'partial';
    else if (side === 'sales' && inv.due_date && inv.due_date < new Date().toISOString().slice(0, 10)) {
      status = 'overdue';
    } else status = 'unpaid';
  }

  db.prepare(`UPDATE ${meta.table} SET paid_amount = ?, status = ? WHERE id = ?`)
    .run(paid, status, invoiceId);
  return { paid, status, outstanding: round(inv.total - paid) };
}

/** Refresh every invoice a payment touches — after allocating, or after a bounce. */
function refreshForPayment(paymentId) {
  const rows = db.prepare('SELECT DISTINCT invoice_side, invoice_id FROM payment_allocations WHERE payment_id = ?')
    .all(paymentId);
  for (const r of rows) refreshInvoice(r.invoice_side, r.invoice_id);
  const allocated = round(db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS a FROM payment_allocations WHERE payment_id = ?').get(paymentId).a);
  db.prepare('UPDATE payments SET allocated = ? WHERE id = ?').run(allocated, paymentId);
  return allocated;
}

/** What is still open on an invoice. */
function outstanding(side, invoiceId) {
  const meta = TABLES[side];
  const inv = db.prepare(`SELECT total, paid_amount FROM ${meta.table} WHERE id = ?`).get(invoiceId);
  if (!inv) throw notFound('That invoice no longer exists.');
  return round(inv.total - inv.paid_amount);
}

/**
 * Allocate a payment across invoices.
 *
 * Over-allocating is refused rather than silently capped: a client who has
 * paid more than an invoice is due has either paid an advance or paid the
 * wrong invoice, and both need somebody to say which.
 */
function allocate(paymentId, allocations) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) throw notFound('That payment no longer exists.');

  const total = round(allocations.reduce((a, x) => a + round(x.amount), 0));
  if (total - 0.005 > round(payment.amount)) {
    throw badRequest(`Allocating ${total.toFixed(2)} but the payment is only ${round(payment.amount).toFixed(2)}.`);
  }

  const run = db.transaction(() => {
    db.prepare('DELETE FROM payment_allocations WHERE payment_id = ?').run(paymentId);
    for (const a of allocations) {
      const amount = round(a.amount);
      if (amount <= 0) continue;
      const side = a.invoice_side || a.side;
      if (!TABLES[side]) throw badRequest(`Unknown invoice side: ${side}`);
      const meta = TABLES[side];
      const inv = db.prepare(`SELECT * FROM ${meta.table} WHERE id = ?`).get(a.invoice_id);
      if (!inv) throw notFound(`Invoice ${a.invoice_id} no longer exists.`);
      if (inv.partner_id !== payment.partner_id) {
        throw badRequest('That invoice belongs to a different partner than the payment.');
      }
      // What is open on it, ignoring this payment's own earlier allocation.
      const others = round(db.prepare(
        `SELECT COALESCE(SUM(al.amount), 0) AS a FROM payment_allocations al
           JOIN payments p ON p.id = al.payment_id
          WHERE al.invoice_side = ? AND al.invoice_id = ? AND al.payment_id != ?
            AND p.status IN ('cleared','deposited')`).get(side, a.invoice_id, paymentId).a);
      const open = round(inv.total - others);
      if (amount - 0.005 > open) {
        throw badRequest(
          `${meta.noCol === 'invoice_no' ? inv.invoice_no : inv.bill_no} has only ${open.toFixed(2)} `
          + `outstanding — ${amount.toFixed(2)} was allocated to it.`);
      }
      db.prepare(
        'INSERT INTO payment_allocations (payment_id, invoice_side, invoice_id, amount) VALUES (?, ?, ?, ?)'
      ).run(paymentId, side, a.invoice_id, amount);
    }
    return refreshForPayment(paymentId);
  });

  return run();
}

/**
 * Spread a payment over the partner's open invoices, oldest first.
 *
 * This is what actually happens at the desk: a client transfers a round figure
 * against "our account", and it is applied to the oldest bills until it runs
 * out.
 */
function autoAllocate(paymentId) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) throw notFound('That payment no longer exists.');
  const side = payment.direction === 'in' ? 'sales' : 'purchase';
  const meta = TABLES[side];

  const open = db.prepare(
    `SELECT id, total, paid_amount FROM ${meta.table}
      WHERE partner_id = ? AND status NOT IN ('cancelled','paid') AND total - paid_amount > 0.005
      ORDER BY COALESCE(due_date, invoice_date), id`).all(payment.partner_id);

  let left = round(payment.amount);
  const allocations = [];
  for (const inv of open) {
    if (left <= 0.005) break;
    const due = round(inv.total - inv.paid_amount);
    const amount = Math.min(due, left);
    allocations.push({ invoice_side: side, invoice_id: inv.id, amount: round(amount) });
    left = round(left - amount);
  }
  if (!allocations.length) return { allocated: 0, unapplied: round(payment.amount), allocations: [] };
  allocate(paymentId, allocations);
  return { allocated: round(payment.amount - left), unapplied: left, allocations };
}

module.exports = { TABLES, refreshInvoice, refreshForPayment, outstanding, allocate, autoAllocate };
