'use strict';
/**
 * The owner's board: what the clinic sold, what it cost, and what is left.
 *
 * Nobody else's, including the administrator's. Everywhere else in this
 * system an admin passes every gate, because a small polyclinic running
 * short-staffed needs one account that can work any desk. This is the
 * exception, and it is deliberate: the whole business laid out on one page —
 * margins, what each department earns, what the clinic is worth, where the
 * money leaks — is the owner's to read and theirs to decide who else ever
 * does. requireOwner is the gate an administrator does not bypass.
 *
 * Two words are used carefully throughout, because conflating them is how a
 * clinic convinces itself it is profitable:
 *
 *   SALE is money that actually arrived — a payment taken, a counter sale
 *   settled. Not what was invoiced. An unpaid bill is a hope, not a sale,
 *   and it is reported separately as what is owed.
 *
 *   COST is money that actually left — the cash book — plus the cost of the
 *   medicines that went out of the door, which is the one cost of goods this
 *   system can know exactly, because every pack dispensed names the batch it
 *   came from and every batch carries what it was bought for.
 */
const express = require('express');
const { db } = require('../db');
const { wrap } = require('../lib/http');
const { requireOwner } = require('../lib/auth');
const { str, oneOf } = require('../lib/validate');

const router = express.Router();

const today = () => new Date().toISOString().slice(0, 10);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

const bucket = (by, col) => {
  if (by === 'week') return `date(${col}, 'weekday 1', '-7 days')`;
  if (by === 'month') return `date(${col}, 'start of month')`;
  return `date(${col})`;
};
const SPAN = { day: 29, week: 83, month: 364 };

router.get('/overview', requireOwner, wrap((req, res) => {
  const by = oneOf(req.query.by, ['day', 'week', 'month'], 'by') || 'month';
  const to = str(req.query.to) || today();
  const from = str(req.query.from)
    || new Date(Date.now() - SPAN[by] * 86400000).toISOString().slice(0, 10);
  const span = [from, to];

  // ----------------------------------------------------------- the series
  const series = new Map();
  const at = (key) => {
    if (!series.has(key)) {
      series.set(key, {
        at: key, billed: 0, counter: 0, otherIncome: 0, expense: 0, medicineCost: 0,
        patients: 0, visits: 0,
      });
    }
    return series.get(key);
  };
  const fold = (rows, field) => rows.forEach((r) => { at(r.at)[field] = r2(r.v); });

  fold(db.prepare(
    `SELECT ${bucket(by, 'paid_at')} AS at, SUM(amount) AS v FROM payments
      WHERE date(paid_at) BETWEEN date(?) AND date(?) GROUP BY at`).all(...span), 'billed');

  fold(db.prepare(
    `SELECT ${bucket(by, 'created_at')} AS at, SUM(paid_amount) AS v FROM pharmacy_sales
      WHERE sale_type = 'counter' AND status != 'cancelled'
        AND date(created_at) BETWEEN date(?) AND date(?) GROUP BY at`).all(...span), 'counter');

  for (const row of db.prepare(
    `SELECT ${bucket(by, 'entry_date')} AS at, direction, SUM(amount) AS v FROM cash_book
      WHERE voided_at IS NULL AND date(entry_date) BETWEEN date(?) AND date(?)
      GROUP BY at, direction`).all(...span)) {
    if (row.direction === 'in') at(row.at).otherIncome = r2(row.v);
    else at(row.at).expense = r2(row.v);
  }

  /*
   * What the medicines that left the shelf had cost to buy.
   *
   * Joined through the batch each line was dispensed from, so this is the
   * actual purchase price of the actual packs — not an average, and not the
   * MRP discounted by a guess. Lines whose batch predates the stock ledger
   * contribute nothing rather than a made-up figure, which understates the
   * cost; the screen says so rather than quietly reporting a better margin
   * than the clinic earned.
   */
  fold(db.prepare(
    `SELECT ${bucket(by, 's.created_at')} AS at,
            SUM(i.qty * COALESCE(b.purchase_price, 0)) AS v
       FROM pharmacy_sale_items i
       JOIN pharmacy_sales s ON s.id = i.sale_id
       LEFT JOIN drug_batches b ON b.id = i.batch_id
      WHERE s.status != 'cancelled' AND date(s.created_at) BETWEEN date(?) AND date(?)
      GROUP BY at`).all(...span), 'medicineCost');

  fold(db.prepare(
    `SELECT ${bucket(by, 'arrived_at')} AS at, COUNT(*) AS v FROM visits
      WHERE date(arrived_at) BETWEEN date(?) AND date(?) GROUP BY at`).all(...span), 'visits');

  fold(db.prepare(
    `SELECT ${bucket(by, 'registered_at')} AS at, COUNT(*) AS v FROM patients
      WHERE registered_at IS NOT NULL
        AND date(registered_at) BETWEEN date(?) AND date(?) GROUP BY at`).all(...span), 'patients');

  const points = [...series.values()].map((p) => {
    const sale = r2(p.billed + p.counter + p.otherIncome);
    const cost = r2(p.expense + p.medicineCost);
    return {
      ...p,
      sale,
      cost,
      profit: r2(sale - cost),
      margin: pct(sale - cost, sale),
      perVisit: p.visits ? r2(sale / p.visits) : 0,
    };
  }).sort((a, b) => String(a.at).localeCompare(String(b.at)));

  // ------------------------------------------------------------ the totals
  const sum = (k) => r2(points.reduce((t, p) => t + p[k], 0));
  const sale = sum('sale');
  const cost = sum('cost');

  // --------------------------------------------------------- what sells
  const byCategory = db.prepare(
    `SELECT COALESCE(ii.ref_type, 'other') AS category, SUM(ii.amount) AS amount, COUNT(*) AS lines
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE i.status != 'cancelled' AND date(i.created_at) BETWEEN date(?) AND date(?)
      GROUP BY category ORDER BY amount DESC`).all(...span);

  const spend = db.prepare(
    `SELECT category, SUM(amount) AS amount, COUNT(*) AS entries FROM cash_book
      WHERE direction = 'out' AND voided_at IS NULL
        AND date(entry_date) BETWEEN date(?) AND date(?)
      GROUP BY category ORDER BY amount DESC`).all(...span);

  /*
   * Visits counted once, bills added up.
   *
   * The join fans out — a visit with two bills against it is two rows — so
   * the visit count has to be DISTINCT. The money must not be: an invoice
   * belongs to exactly one visit and so appears exactly once here, and
   * SUM(DISTINCT i.net) would have thrown away the second of two bills that
   * happened to come to the same amount, which at a clinic with a standing
   * consultation fee is most of them.
   */
  const byDoctor = db.prepare(
    `SELECT u.name AS doctor, d.name AS department,
            COUNT(DISTINCT v.id) AS visits,
            COALESCE(SUM(i.net), 0) AS billed
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN visits v ON v.doctor_id = u.id
            AND date(v.arrived_at) BETWEEN date(?) AND date(?)
       LEFT JOIN invoices i ON i.visit_id = v.id AND i.status != 'cancelled'
      WHERE u.role = 'doctor' AND u.active = 1
      GROUP BY u.id HAVING visits > 0 ORDER BY billed DESC`).all(...span);

  /*
   * The medicine counter on its own, because it is the one part of the
   * clinic with a cost of sale the system knows exactly — and therefore the
   * one place a real gross margin can be quoted rather than estimated.
   */
  const pharmacy = db.prepare(
    `SELECT COALESCE(SUM(i.amount), 0) AS sold,
            COALESCE(SUM(i.qty * COALESCE(b.purchase_price, 0)), 0) AS cost,
            SUM(CASE WHEN b.purchase_price IS NULL OR b.purchase_price = 0 THEN 1 ELSE 0 END) AS unpriced_lines,
            COUNT(*) AS lines
       FROM pharmacy_sale_items i
       JOIN pharmacy_sales s ON s.id = i.sale_id
       LEFT JOIN drug_batches b ON b.id = i.batch_id
      WHERE s.status != 'cancelled' AND date(s.created_at) BETWEEN date(?) AND date(?)`).get(...span);

  res.json({
    from, to, by, points,
    totals: {
      sale,
      cost,
      profit: r2(sale - cost),
      margin: pct(sale - cost, sale),
      billed: sum('billed'),
      counter: sum('counter'),
      otherIncome: sum('otherIncome'),
      expense: sum('expense'),
      medicineCost: sum('medicineCost'),
      visits: points.reduce((t, p) => t + p.visits, 0),
      newPatients: points.reduce((t, p) => t + p.patients, 0),
      perVisit: points.reduce((t, p) => t + p.visits, 0)
        ? r2(sale / points.reduce((t, p) => t + p.visits, 0)) : 0,
    },
    byCategory,
    spend,
    byDoctor,
    pharmacy: {
      ...pharmacy,
      gross: r2(pharmacy.sold - pharmacy.cost),
      margin: pct(pharmacy.sold - pharmacy.cost, pharmacy.sold),
    },
    /*
     * What the clinic is owed and what it is holding — the two figures that
     * explain a thin month without being part of it. Neither is cash flow:
     * an unpaid bill has not been earned yet and stock is money the clinic
     * has already spent and not yet sold.
     */
    position: {
      outstanding: db.prepare(
        "SELECT COALESCE(SUM(balance), 0) AS s FROM invoices WHERE status IN ('unpaid','partial')").get().s,
      outstandingBills: db.prepare(
        "SELECT COUNT(*) AS c FROM invoices WHERE status IN ('unpaid','partial')").get().c,
      stockValue: db.prepare(
        'SELECT COALESCE(SUM(qty_available * purchase_price), 0) AS s FROM drug_batches').get().s,
      assetValue: db.prepare(
        'SELECT COALESCE(SUM(unit_cost * quantity), 0) AS s FROM assets WHERE active = 1').get().s,
      supplierDue: db.prepare(
        "SELECT COALESCE(SUM(net - paid), 0) AS s FROM stock_purchases WHERE status != 'cancelled'").get().s,
    },
  });
}));

module.exports = router;
