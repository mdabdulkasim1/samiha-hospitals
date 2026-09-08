'use strict';
const express = require('express');
const { db } = require('../db');
const auth = require('../lib/auth');
const v = require('../lib/validate');
const { wrap } = require('../lib/http');
const stock = require('../services/stock');
const ledger = require('../services/ledger');
const pricing = require('../services/pricing');

const router = express.Router();

/*
 * What each desk needs to see when they sign in, and the handful of reports
 * the company actually runs. Every figure is filtered by what the person
 * looking at it is allowed to see — the logistics desk gets quantities and
 * documents, the money desks get money.
 */

router.get('/dashboard', wrap(async (req, res) => {
  const companyId = req.query.company_id || null;
  const money = auth.seesMoney(req.user);
  const today = v.today();

  const one = (sql, params = []) => db.prepare(sql).get(...params);

  const sell = {
    enquiries_open: one("SELECT COUNT(*) AS c FROM enquiries WHERE status IN ('open','quoted')").c,
    quotations_open: one("SELECT COUNT(*) AS c FROM sales_quotations WHERE status IN ('draft','sent','under_review')").c,
    quotations_value: money
      ? one("SELECT COALESCE(SUM(total), 0) AS t FROM sales_quotations WHERE status IN ('sent','under_review')").t
      : null,
    orders_open: one("SELECT COUNT(*) AS c FROM sales_orders WHERE status IN ('confirmed','partial')").c,
    orders_value: money
      ? one("SELECT COALESCE(SUM(total), 0) AS t FROM sales_orders WHERE status IN ('confirmed','partial')").t
      : null,
    awaiting_delivery: one(`
      SELECT COUNT(DISTINCT o.id) AS c FROM sales_orders o
        JOIN sales_order_items i ON i.so_id = o.id
       WHERE o.status IN ('confirmed','partial') AND i.qty > i.delivered_qty`).c,
    awaiting_invoice: one(`
      SELECT COUNT(*) AS c FROM delivery_notes d
       WHERE NOT EXISTS (SELECT 1 FROM sales_invoices i WHERE i.dn_id = d.id)
         AND d.status != 'cancelled'`).c,
    advances_due: money ? one(
      `SELECT COALESCE(SUM(advance_required - advance_received), 0) AS t FROM sales_orders
        WHERE status IN ('confirmed','partial') AND advance_required > advance_received`).t : null,
  };

  const buy = {
    quotations_awaiting: one("SELECT COUNT(*) AS c FROM supplier_quotations WHERE status = 'requested'").c,
    quotations_to_approve: one("SELECT COUNT(*) AS c FROM supplier_quotations WHERE status = 'received'").c,
    lpos_draft: one("SELECT COUNT(*) AS c FROM purchase_orders WHERE status = 'draft'").c,
    lpos_open: one("SELECT COUNT(*) AS c FROM purchase_orders WHERE status IN ('sent','acknowledged','partial')").c,
    lpos_value: money
      ? one("SELECT COALESCE(SUM(total), 0) AS t FROM purchase_orders WHERE status IN ('sent','acknowledged','partial')").t
      : null,
    overdue_deliveries: one(
      `SELECT COUNT(*) AS c FROM purchase_orders
        WHERE status IN ('sent','acknowledged','partial') AND delivery_date < date('now')`).c,
    bills_unbooked: one(`
      SELECT COUNT(*) AS c FROM grns g
       WHERE NOT EXISTS (SELECT 1 FROM supplier_invoices i WHERE i.grn_id = g.id)
         AND g.status = 'received'`).c,
  };

  const yard = stock.valuation({ companyId });
  const stockSummary = {
    items: db.prepare('SELECT COUNT(*) AS c FROM items WHERE active = 1').get().c,
    on_hand_value: auth.seesCost(req.user) ? yard.on_hand_value : null,
    on_order_value: auth.seesCost(req.user) ? yard.on_order_value : null,
    below_reorder: yard.below_reorder,
    received_today: one("SELECT COUNT(*) AS c FROM grns WHERE received_date = ?", [today]).c,
    delivered_today: one("SELECT COUNT(*) AS c FROM delivery_notes WHERE delivery_date = ?", [today]).c,
  };

  const cash = money ? {
    receivable: pricing.round(one(
      "SELECT COALESCE(SUM(total - paid_amount), 0) AS t FROM sales_invoices WHERE status NOT IN ('cancelled','paid')").t),
    overdue_receivable: pricing.round(one(
      `SELECT COALESCE(SUM(total - paid_amount), 0) AS t FROM sales_invoices
        WHERE status NOT IN ('cancelled','paid') AND due_date < date('now')`).t),
    payable: pricing.round(one(
      "SELECT COALESCE(SUM(total - paid_amount), 0) AS t FROM supplier_invoices WHERE status NOT IN ('cancelled','paid')").t),
    overdue_payable: pricing.round(one(
      `SELECT COALESCE(SUM(total - paid_amount), 0) AS t FROM supplier_invoices
        WHERE status NOT IN ('cancelled','paid') AND due_date < date('now')`).t),
    cheques_pending: one("SELECT COUNT(*) AS c FROM payments WHERE mode = 'cheque' AND status = 'pending'").c,
    cheques_bounced: one("SELECT COUNT(*) AS c FROM payments WHERE status = 'bounced'").c,
    collected_this_month: pricing.round(one(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM payments
        WHERE direction = 'in' AND status IN ('cleared','deposited')
          AND payment_date >= date('now','start of month')`).t),
    paid_this_month: pricing.round(one(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM payments
        WHERE direction = 'out' AND status IN ('cleared','deposited')
          AND payment_date >= date('now','start of month')`).t),
  } : null;

  const trading = money ? {
    invoiced_this_month: pricing.round(one(
      `SELECT COALESCE(SUM(total), 0) AS t FROM sales_invoices
        WHERE status != 'cancelled' AND invoice_date >= date('now','start of month')`).t),
    purchased_this_month: pricing.round(one(
      `SELECT COALESCE(SUM(total), 0) AS t FROM supplier_invoices
        WHERE status != 'cancelled' AND invoice_date >= date('now','start of month')`).t),
    expenses_this_month: pricing.round(one(
      `SELECT COALESCE(SUM(total), 0) AS t FROM expenses
        WHERE kind = 'expense' AND expense_date >= date('now','start of month')`).t),
  } : null;

  res.json({ sell, buy, stock: stockSummary, cash, trading, as_of: new Date().toISOString() });
}));

/**
 * Follow a reference.
 *
 * Type in any document number — ours or the client's own LPO number or the
 * supplier's own invoice number — and get the whole chain around it, oldest
 * first. This is what the references are for.
 */
router.get('/trace', wrap(async (req, res) => {
  const trace = require('../services/trace');
  const ref = v.str(req.query.ref);
  if (!ref) throw require('../lib/http').badRequest('Give a reference to look for.');

  const hits = trace.find(ref);
  if (!hits.length) return res.json({ ref, found: [], chain: null });

  const exact = hits.filter((h) => !h.partial);
  // One clear answer: show its chain. Several, or only near-misses: let the
  // person choose rather than guessing for them.
  if (exact.length === 1) {
    const hit = exact[0];
    const result = trace.chain(hit.kind, hit.id);
    if (!auth.seesPrices(req.user)) for (const s of result.steps) s.amount = null;
    return res.json({ ref, found: exact, matched: hit, chain: result });
  }
  res.json({ ref, found: hits, chain: null });
}));

/** What the group sold, by application — the split the company works to. */
router.get('/by-application', auth.requireRole('kam', 'accounts', 'sales'), wrap(async (req, res) => {
  const to = v.date(req.query.to) || v.today();
  const from = v.date(req.query.from) || `${to.slice(0, 4)}-01-01`;
  res.json({
    from,
    to,
    sales: db.prepare(`
      SELECT COALESCE(a.name, 'Not stated') AS application, COUNT(DISTINCT i.id) AS invoices,
             COALESCE(SUM(li.taxable), 0) AS revenue, COALESCE(SUM(li.cost_price * li.qty), 0) AS cost
        FROM sales_invoice_items li
        JOIN sales_invoices i ON i.id = li.invoice_id
        LEFT JOIN applications a ON a.id = COALESCE(li.application_id, i.application_id)
       WHERE i.status != 'cancelled' AND i.invoice_date BETWEEN ? AND ?
       GROUP BY a.id ORDER BY revenue DESC`).all(from, to)
      .map((r) => ({ ...r, ...pricing.margin(r.revenue, auth.seesCost(req.user) ? r.cost : 0),
        cost: auth.seesCost(req.user) ? r.cost : null })),
    purchases: db.prepare(`
      SELECT COALESCE(a.name, 'Not stated') AS application, COUNT(*) AS orders,
             COALESCE(SUM(o.total), 0) AS value
        FROM purchase_orders o
        LEFT JOIN applications a ON a.id = o.application_id
       WHERE o.status != 'cancelled' AND o.lpo_date BETWEEN ? AND ?
       GROUP BY a.id ORDER BY value DESC`).all(from, to),
  });
}));

/** The clients and the manufacturers that matter most. */
router.get('/top-partners', auth.requireRole('kam', 'accounts'), wrap(async (req, res) => {
  const to = v.date(req.query.to) || v.today();
  const from = v.date(req.query.from) || `${to.slice(0, 4)}-01-01`;
  res.json({
    from,
    to,
    clients: db.prepare(`
      SELECT p.id, p.name, COUNT(i.id) AS invoices, COALESCE(SUM(i.total), 0) AS value,
             COALESCE(SUM(i.total - i.paid_amount), 0) AS outstanding
        FROM sales_invoices i JOIN partners p ON p.id = i.partner_id
       WHERE i.status != 'cancelled' AND i.invoice_date BETWEEN ? AND ?
       GROUP BY p.id ORDER BY value DESC LIMIT 15`).all(from, to),
    suppliers: db.prepare(`
      SELECT p.id, p.name, COUNT(i.id) AS invoices, COALESCE(SUM(i.total), 0) AS value,
             COALESCE(SUM(i.total - i.paid_amount), 0) AS outstanding
        FROM supplier_invoices i JOIN partners p ON p.id = i.partner_id
       WHERE i.status != 'cancelled' AND i.invoice_date BETWEEN ? AND ?
       GROUP BY p.id ORDER BY value DESC LIMIT 15`).all(from, to),
  });
}));

/** What moved, item by item — the trading report behind the stock register. */
router.get('/item-movement', wrap(async (req, res) => {
  const to = v.date(req.query.to) || v.today();
  const from = v.date(req.query.from) || v.addDays(to, -90);
  const rows = db.prepare(`
    SELECT i.id, i.item_code, i.name, i.uom, c.name AS category_name, a.name AS application_name,
           COALESCE(SUM(CASE WHEN m.bucket = 'onhand' AND m.qty > 0 THEN m.qty END), 0) AS received,
           COALESCE(SUM(CASE WHEN m.bucket = 'onhand' AND m.qty < 0 THEN -m.qty END), 0) AS delivered
      FROM stock_movements m
      JOIN items i ON i.id = m.item_id
      LEFT JOIN item_categories c ON c.id = i.category_id
      LEFT JOIN applications a ON a.id = i.application_id
     WHERE m.moved_on BETWEEN ? AND ?
     GROUP BY i.id
     HAVING received > 0 OR delivered > 0
     ORDER BY delivered DESC, received DESC`).all(from, to);
  res.json({ from, to, rows });
}));

/** How the sales desk is doing: quoted, won, lost. */
router.get('/quotation-conversion', auth.requireRole('kam', 'accounts', 'sales'), wrap(async (req, res) => {
  const to = v.date(req.query.to) || v.today();
  const from = v.date(req.query.from) || `${to.slice(0, 4)}-01-01`;
  const rows = db.prepare(`
    SELECT u.id, u.name,
           COUNT(q.id) AS quoted,
           COALESCE(SUM(q.total), 0) AS quoted_value,
           SUM(CASE WHEN q.status = 'converted' THEN 1 ELSE 0 END) AS won,
           COALESCE(SUM(CASE WHEN q.status = 'converted' THEN q.total ELSE 0 END), 0) AS won_value,
           SUM(CASE WHEN q.status = 'rejected' THEN 1 ELSE 0 END) AS lost
      FROM sales_quotations q JOIN users u ON u.id = q.created_by
     WHERE q.quote_date BETWEEN ? AND ?
     GROUP BY u.id ORDER BY won_value DESC`).all(from, to);
  res.json({
    from,
    to,
    rows: rows.map((r) => ({ ...r, win_rate: r.quoted ? Math.round((r.won / r.quoted) * 100) : 0 })),
  });
}));

module.exports = router;
