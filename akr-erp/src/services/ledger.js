'use strict';
const { db } = require('../db');
const { round } = require('./pricing');
const v = require('../lib/validate');

/*
 * The books.
 *
 * A partner's ledger is built from the documents themselves rather than from a
 * separate set of journal rows, because in a trading house of this size there
 * is exactly one thing that makes a client owe money — an invoice — and
 * exactly one that reduces it — a payment. Deriving the balance means it can
 * never drift away from the invoices it is supposed to describe.
 */

/** Every entry against a partner, both sides, oldest first, with a running balance. */
function partnerLedger(partnerId, { companyId = null, from = null, to = null } = {}) {
  const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(partnerId);
  if (!partner) return null;

  const companyFilter = companyId ? 'AND company_id = @companyId' : '';
  const fromFilter = (col) => (from ? `AND ${col} >= @from` : '');
  const toFilter = (col) => (to ? `AND ${col} <= @to` : '');
  const params = { partnerId, companyId, from, to };

  const rows = [];

  // What they owe us: our tax invoices.
  for (const r of db.prepare(
    `SELECT id, invoice_no AS doc_no, invoice_date AS doc_date, due_date, total, paid_amount, status
       FROM sales_invoices
      WHERE partner_id = @partnerId AND status != 'cancelled' ${companyFilter}
        ${fromFilter('invoice_date')} ${toFilter('invoice_date')}`).all(params)) {
    rows.push({ date: r.doc_date, kind: 'sales_invoice', doc_no: r.doc_no, ref_id: r.id,
      particulars: `Tax invoice ${r.doc_no}`, debit: round(r.total), credit: 0, due_date: r.due_date });
  }

  // What we owe them: their invoices to us.
  for (const r of db.prepare(
    `SELECT id, bill_no, supplier_inv_no, invoice_date, due_date, total, paid_amount, status
       FROM supplier_invoices
      WHERE partner_id = @partnerId AND status != 'cancelled' ${companyFilter}
        ${fromFilter('invoice_date')} ${toFilter('invoice_date')}`).all(params)) {
    rows.push({ date: r.invoice_date, kind: 'supplier_invoice', doc_no: r.bill_no, ref_id: r.id,
      particulars: `Supplier invoice ${r.supplier_inv_no} (${r.bill_no})`,
      debit: 0, credit: round(r.total), due_date: r.due_date });
  }

  // Money moved. A receipt reduces what they owe; a payment reduces what we do.
  for (const r of db.prepare(
    `SELECT id, payment_no, direction, payment_date, amount, mode, cheque_no, cheque_date, status, kind
       FROM payments
      WHERE partner_id = @partnerId AND status != 'cancelled' ${companyFilter}
        ${fromFilter('payment_date')} ${toFilter('payment_date')}`).all(params)) {
    const label = r.mode === 'cheque'
      ? `${r.direction === 'in' ? 'Receipt' : 'Payment'} ${r.payment_no} — cheque ${r.cheque_no || ''}`.trim()
      : `${r.direction === 'in' ? 'Receipt' : 'Payment'} ${r.payment_no} (${r.mode.replace('_', ' ')})`;
    rows.push({
      date: r.payment_date, kind: r.direction === 'in' ? 'receipt' : 'payment',
      doc_no: r.payment_no, ref_id: r.id,
      particulars: label + (r.kind === 'advance' ? ' — advance' : ''),
      debit: r.direction === 'in' ? 0 : round(r.amount),
      credit: r.direction === 'in' ? round(r.amount) : 0,
      status: r.status,
    });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ref_id - b.ref_id));

  // Opening balance: positive means they owe us.
  let running = round(partner.opening_balance || 0);
  const opening = running;
  for (const r of rows) {
    running = round(running + r.debit - r.credit);
    r.balance = running;
  }

  return {
    partner,
    opening,
    rows,
    closing: running,
    totals: {
      debit: round(rows.reduce((a, r) => a + r.debit, 0)),
      credit: round(rows.reduce((a, r) => a + r.credit, 0)),
    },
  };
}

/**
 * What is outstanding, bucketed by how long it has been outstanding.
 *
 * `side` is 'receivable' (clients) or 'payable' (suppliers). The buckets are
 * counted from the due date, not the invoice date: an invoice on ninety-day
 * terms is not overdue on day thirty-one, and treating it as such makes the
 * whole report useless for chasing.
 */
function ageing(side, { companyId = null, asOf = null, partnerId = null } = {}) {
  const on = v.date(asOf) || v.today();
  const table = side === 'payable' ? 'supplier_invoices' : 'sales_invoices';
  const noCol = side === 'payable' ? 'bill_no' : 'invoice_no';
  const where = [`i.status NOT IN ('cancelled','paid')`, 'i.total - i.paid_amount > 0.005'];
  const params = { on };
  if (companyId) { where.push('i.company_id = @companyId'); params.companyId = companyId; }
  if (partnerId) { where.push('i.partner_id = @partnerId'); params.partnerId = partnerId; }

  const rows = db.prepare(`
    SELECT i.id, i.${noCol} AS doc_no, i.invoice_date, i.due_date, i.total, i.paid_amount,
           (i.total - i.paid_amount) AS outstanding,
           p.id AS partner_id, p.name AS partner_name, p.code AS partner_code,
           t.name AS terms_name,
           CAST(julianday(@on) - julianday(COALESCE(i.due_date, i.invoice_date)) AS INTEGER) AS days_overdue
      FROM ${table} i
      JOIN partners p ON p.id = i.partner_id
      LEFT JOIN payment_terms t ON t.id = i.payment_terms_id
     WHERE ${where.join(' AND ')}
     ORDER BY days_overdue DESC, p.name`).all(params);

  const bucketOf = (d) => (d <= 0 ? 'not_due' : d <= 30 ? 'd0_30' : d <= 60 ? 'd31_60'
    : d <= 90 ? 'd61_90' : 'd90_plus');

  const buckets = { not_due: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const byPartner = new Map();

  for (const r of rows) {
    r.outstanding = round(r.outstanding);
    r.bucket = bucketOf(r.days_overdue);
    buckets[r.bucket] = round(buckets[r.bucket] + r.outstanding);

    if (!byPartner.has(r.partner_id)) {
      byPartner.set(r.partner_id, {
        partner_id: r.partner_id, partner_name: r.partner_name, partner_code: r.partner_code,
        total: 0, not_due: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, invoices: 0,
      });
    }
    const p = byPartner.get(r.partner_id);
    p.total = round(p.total + r.outstanding);
    p[r.bucket] = round(p[r.bucket] + r.outstanding);
    p.invoices += 1;
  }

  return {
    as_of: on,
    side,
    rows,
    buckets,
    total: round(Object.values(buckets).reduce((a, b) => a + b, 0)),
    by_partner: [...byPartner.values()].sort((a, b) => b.total - a.total),
  };
}

/**
 * The VAT return, in the shape the FTA asks for it: output tax charged on our
 * sales, input tax paid on our purchases and expenses, and the difference —
 * which is what is paid over, or reclaimed.
 */
function vatReturn({ companyId = null, from, to }) {
  const params = { from, to, companyId };
  const companyFilter = companyId ? 'AND company_id = @companyId' : '';

  const sales = db.prepare(
    `SELECT COALESCE(SUM(subtotal - discount), 0) AS taxable, COALESCE(SUM(vat_amount), 0) AS vat,
            COUNT(*) AS count
       FROM sales_invoices
      WHERE status != 'cancelled' AND invoice_date BETWEEN @from AND @to ${companyFilter}`).get(params);

  const purchases = db.prepare(
    `SELECT COALESCE(SUM(subtotal - discount), 0) AS taxable, COALESCE(SUM(vat_amount), 0) AS vat,
            COUNT(*) AS count
       FROM supplier_invoices
      WHERE status != 'cancelled' AND invoice_date BETWEEN @from AND @to ${companyFilter}`).get(params);

  const expenses = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS taxable, COALESCE(SUM(vat_amount), 0) AS vat, COUNT(*) AS count
       FROM expenses
      WHERE kind = 'expense' AND recoverable_vat = 1 AND expense_date BETWEEN @from AND @to ${companyFilter}`)
    .get(params);

  const outputTax = round(sales.vat);
  const inputTax = round(purchases.vat + expenses.vat);

  return {
    from, to,
    sales: { taxable: round(sales.taxable), vat: outputTax, count: sales.count },
    purchases: { taxable: round(purchases.taxable), vat: round(purchases.vat), count: purchases.count },
    expenses: { taxable: round(expenses.taxable), vat: round(expenses.vat), count: expenses.count },
    output_tax: outputTax,
    input_tax: inputTax,
    // Positive: payable to the FTA. Negative: recoverable.
    net: round(outputTax - inputTax),
  };
}

/**
 * What the group earned and spent over a period, per company and in total.
 *
 * Gross profit is invoiced sales less the cost carried on those invoices —
 * the price we actually paid the manufacturer for what went out of the door —
 * and the net is that less the overheads booked to the company.
 */
function profitAndLoss({ from, to, companyId = null }) {
  const params = { from, to, companyId };
  const filter = companyId ? 'AND i.company_id = @companyId' : '';
  const expFilter = companyId ? 'AND e.company_id = @companyId' : '';

  const perCompany = db.prepare(`
    SELECT c.id, c.code, c.name,
      (SELECT COALESCE(SUM(i.subtotal - i.discount), 0) FROM sales_invoices i
        WHERE i.company_id = c.id AND i.status != 'cancelled'
          AND i.invoice_date BETWEEN @from AND @to) AS revenue,
      (SELECT COALESCE(SUM(li.cost_price * li.qty), 0) FROM sales_invoice_items li
         JOIN sales_invoices i ON i.id = li.invoice_id
        WHERE i.company_id = c.id AND i.status != 'cancelled'
          AND i.invoice_date BETWEEN @from AND @to) AS cost_of_sales,
      (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e
        WHERE e.company_id = c.id AND e.kind = 'expense'
          AND e.expense_date BETWEEN @from AND @to) AS expenses,
      (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e
        WHERE e.company_id = c.id AND e.kind = 'income'
          AND e.expense_date BETWEEN @from AND @to) AS other_income
     FROM companies c
    WHERE c.active = 1 ${companyId ? 'AND c.id = @companyId' : ''}
    ORDER BY c.is_default DESC, c.code`).all(params);

  const rows = perCompany.map((c) => {
    const revenue = round(c.revenue);
    const cost = round(c.cost_of_sales);
    const gross = round(revenue - cost);
    const expenses = round(c.expenses);
    const otherIncome = round(c.other_income);
    return {
      ...c, revenue, cost_of_sales: cost, gross_profit: gross,
      gross_margin_percent: revenue ? round((gross / revenue) * 100) : 0,
      expenses, other_income: otherIncome,
      net_profit: round(gross + otherIncome - expenses),
    };
  });

  const sum = (key) => round(rows.reduce((a, r) => a + r[key], 0));
  const revenue = sum('revenue');
  const gross = sum('gross_profit');

  return {
    from, to,
    companies: rows,
    group: {
      revenue,
      cost_of_sales: sum('cost_of_sales'),
      gross_profit: gross,
      gross_margin_percent: revenue ? round((gross / revenue) * 100) : 0,
      expenses: sum('expenses'),
      other_income: sum('other_income'),
      net_profit: sum('net_profit'),
    },
  };
}

/**
 * The same figures, month by month.
 *
 * The company books a month's overheads in one sitting, at the end of it, so
 * the only reading of "what did we make" that means anything is per month:
 * what was invoiced, what those goods cost, and then that month's expenses
 * taken off — in that order, because the expenses are the difference between
 * a gross figure and the one worth acting on.
 *
 * An expense counts in the month it is dated, whichever month the trade it
 * relates to happened in. That is how it is entered and how the bank sees it.
 */
function monthlyProfit({ from, to, companyId = null }) {
  const params = { from, to, companyId };
  const company = companyId ? 'AND i.company_id = @companyId' : '';
  const expCompany = companyId ? 'AND e.company_id = @companyId' : '';

  const revenue = db.prepare(`
    SELECT strftime('%Y-%m', i.invoice_date) AS month,
           COALESCE(SUM(i.subtotal - i.discount), 0) AS revenue,
           COALESCE(SUM(i.vat_amount), 0) AS output_vat,
           COUNT(*) AS invoices
      FROM sales_invoices i
     WHERE i.status != 'cancelled' AND i.invoice_date BETWEEN @from AND @to ${company}
     GROUP BY month`).all(params);

  const cost = db.prepare(`
    SELECT strftime('%Y-%m', i.invoice_date) AS month,
           COALESCE(SUM(li.cost_price * li.qty), 0) AS cost_of_sales
      FROM sales_invoice_items li
      JOIN sales_invoices i ON i.id = li.invoice_id
     WHERE i.status != 'cancelled' AND i.invoice_date BETWEEN @from AND @to ${company}
     GROUP BY month`).all(params);

  const overheads = db.prepare(`
    SELECT strftime('%Y-%m', e.expense_date) AS month,
           COALESCE(SUM(CASE WHEN e.kind = 'expense' THEN e.amount END), 0) AS expenses,
           COALESCE(SUM(CASE WHEN e.kind = 'income'  THEN e.amount END), 0) AS other_income,
           SUM(CASE WHEN e.kind = 'expense' THEN 1 ELSE 0 END) AS expense_count
      FROM expenses e
     WHERE e.expense_date BETWEEN @from AND @to ${expCompany}
     GROUP BY month`).all(params);

  const byMonth = new Map();
  const touch = (month) => {
    if (!byMonth.has(month)) {
      byMonth.set(month, { month, revenue: 0, cost_of_sales: 0, expenses: 0,
        other_income: 0, invoices: 0, expense_count: 0, output_vat: 0 });
    }
    return byMonth.get(month);
  };
  for (const r of revenue) Object.assign(touch(r.month), {
    revenue: round(r.revenue), invoices: r.invoices, output_vat: round(r.output_vat) });
  for (const c of cost) touch(c.month).cost_of_sales = round(c.cost_of_sales);
  for (const o of overheads) Object.assign(touch(o.month), {
    expenses: round(o.expenses), other_income: round(o.other_income),
    expense_count: o.expense_count });

  const rows = [...byMonth.values()]
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((m) => {
      const gross = round(m.revenue - m.cost_of_sales);
      return {
        ...m,
        gross_profit: gross,
        gross_margin_percent: m.revenue ? round((gross / m.revenue) * 100) : 0,
        net_profit: round(gross + m.other_income - m.expenses),
        // A month with sales but no overheads booked is not a very profitable
        // month; it is a month somebody has not finished entering.
        expenses_booked: m.expense_count > 0,
      };
    });

  const sum = (k) => round(rows.reduce((a, r) => a + r[k], 0));
  return {
    from,
    to,
    rows,
    total: {
      revenue: sum('revenue'),
      cost_of_sales: sum('cost_of_sales'),
      gross_profit: sum('gross_profit'),
      other_income: sum('other_income'),
      expenses: sum('expenses'),
      net_profit: sum('net_profit'),
    },
  };
}

/** Where a partner stands right now — the figure a KAM is asked for. */
function partnerBalance(partnerId, { companyId = null } = {}) {
  const l = partnerLedger(partnerId, { companyId });
  if (!l) return null;
  const receivable = round(db.prepare(
    `SELECT COALESCE(SUM(total - paid_amount), 0) AS due FROM sales_invoices
      WHERE partner_id = ? AND status NOT IN ('cancelled','paid')`).get(partnerId).due);
  const payable = round(db.prepare(
    `SELECT COALESCE(SUM(total - paid_amount), 0) AS due FROM supplier_invoices
      WHERE partner_id = ? AND status NOT IN ('cancelled','paid')`).get(partnerId).due);
  return { balance: l.closing, receivable, payable, opening: l.opening };
}

module.exports = { partnerLedger, ageing, vatReturn, profitAndLoss, monthlyProfit, partnerBalance };
