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
      net_profit: round(gross - expenses),
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
 * The bottom line, in the order the owner reads it:
 *
 *   selling price − buying price − buying overheads − selling overheads
 *     = gross profit,   then   − VAT   = net profit
 *
 * Each term is exactly one thing:
 *
 *   selling price       what was invoiced to clients, before VAT
 *   buying price        what those particular goods cost — the cost of sales
 *   buying overheads    expenses booked to a manufacturer's account
 *   selling overheads   expenses booked to a client's account
 *   general overheads   AKR's own — rent, salaries, the licence — booked to
 *                       nobody, and the pot spread pro rata across the accounts
 *                       in the tables above. It is its own line because it
 *                       belongs to the business rather than to either side of
 *                       the trade, and folding it into one of them would put a
 *                       cost where it was not incurred.
 *
 * A note on the VAT line, because it is the owner's own reading rather than
 * the FTA's: what is deducted here is the net payable for the period — output
 * tax on our invoices less the input tax we may recover. That money was
 * collected from clients and passed on rather than earned, so it is not a cost
 * of the trade in the accounting sense. It is shown as the owner asks for it,
 * and both figures are on the page so either reading is available.
 */
function statement({ from, to, companyId = null }) {
  const params = { from, to, companyId };
  const invFilter = companyId ? 'AND i.company_id = @companyId' : '';
  const expFilter = companyId ? 'AND e.company_id = @companyId' : '';

  const sales = db.prepare(`
    SELECT COALESCE(SUM(i.subtotal - i.discount), 0) AS revenue FROM sales_invoices i
     WHERE i.status != 'cancelled' AND i.invoice_date BETWEEN @from AND @to ${invFilter}`).get(params);

  const cost = db.prepare(`
    SELECT COALESCE(SUM(li.cost_price * li.qty), 0) AS cost FROM sales_invoice_items li
      JOIN sales_invoices i ON i.id = li.invoice_id
     WHERE i.status != 'cancelled' AND i.invoice_date BETWEEN @from AND @to ${invFilter}`).get(params);

  // Overheads, split by whose account carries them.
  const overheads = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN p.type IN ('supplier','both') THEN e.amount END), 0) AS buying,
      COALESCE(SUM(CASE WHEN p.type = 'client' THEN e.amount END), 0) AS selling,
      COALESCE(SUM(CASE WHEN e.partner_id IS NULL THEN e.amount END), 0) AS general
      FROM expenses e
      LEFT JOIN partners p ON p.id = e.partner_id
     WHERE e.kind = 'expense' AND e.expense_date BETWEEN @from AND @to ${expFilter}`).get(params);

  const otherIncome = round(db.prepare(`
    SELECT COALESCE(SUM(e.amount), 0) AS amount FROM expenses e
     WHERE e.kind = 'income' AND e.expense_date BETWEEN @from AND @to ${expFilter}`).get(params).amount);

  const sellingPrice = round(sales.revenue);
  const buyingPrice = round(cost.cost);
  const buyingOverheads = round(overheads.buying);
  const sellingOverheads = round(overheads.selling);
  const generalOverheads = round(overheads.general);

  const grossProfit = round(sellingPrice - buyingPrice - buyingOverheads - sellingOverheads
    - generalOverheads);
  const vat = vatReturn({ from, to, companyId }).net;

  return {
    from,
    to,
    selling_price: sellingPrice,
    buying_price: buyingPrice,
    buying_overheads: buyingOverheads,
    selling_overheads: sellingOverheads,
    general_overheads: generalOverheads,
    other_income: otherIncome,
    gross_profit: grossProfit,
    gross_margin_percent: sellingPrice ? round((grossProfit / sellingPrice) * 100) : 0,
    vat,
    net_profit: round(grossProfit - vat),
  };
}


/**
 * What one job has cost, and what is left on it.
 *
 * The sales desk asks a plain question — we are selling this at that rate, what
 * are we paying for it and what has gone out on top? — and the answer is in
 * four places: the buying rate carried on the order's own lines, the LPOs
 * raised to fill it, the manufacturers' bills against those LPOs, and the
 * expenses somebody booked to this job or to this client.
 *
 * The goods figure is the order's own cost, not the bills: an order half
 * bought-in would otherwise read as half price. The bills are shown beside it
 * so the two can be compared, which is the point of showing both.
 */
function jobCost({ salesOrderId = null, enquiryId = null, partnerId = null }) {
  const order = salesOrderId
    ? db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(salesOrderId) : null;
  const jobId = enquiryId || (order ? order.enquiry_id : null);

  const goods = order ? round(db.prepare(
    'SELECT COALESCE(SUM(cost_price * qty), 0) AS c FROM sales_order_items WHERE so_id = ?')
    .get(order.id).c) : 0;
  const revenue = order ? round(order.subtotal - order.discount) : 0;

  const orders = order ? db.prepare(`
    SELECT o.id, o.lpo_no, o.lpo_date, o.status, (o.subtotal - o.discount) AS value,
           p.name AS supplier_name
      FROM purchase_orders o JOIN partners p ON p.id = o.partner_id
     WHERE o.sales_order_id = ? AND o.status != 'cancelled'
     ORDER BY o.lpo_date`).all(order.id) : [];

  const bills = orders.length ? db.prepare(`
    SELECT b.id, b.bill_no, b.supplier_inv_no, b.invoice_date, (b.subtotal - b.discount) AS value,
           p.name AS supplier_name
      FROM supplier_invoices b JOIN partners p ON p.id = b.partner_id
     WHERE b.status != 'cancelled' AND b.po_id IN (${orders.map(() => '?').join(',')})
     ORDER BY b.invoice_date`).all(...orders.map((o) => o.id)) : [];

  /*
   * The expenses that belong to this job: the ones booked against it by name,
   * and — where the job is a client's — the ones booked to that client. AKR's
   * own overheads are not here; they belong to the month, not to one order,
   * and are spread on the profit page instead.
   */
  const where = [];
  const params = {};
  if (jobId) { where.push('e.enquiry_id = @jobId'); params.jobId = jobId; }
  const client = partnerId || (order ? order.partner_id : null);
  if (client) { where.push('e.partner_id = @client'); params.client = client; }
  const expenses = where.length ? db.prepare(`
    SELECT e.id, e.voucher_no, e.expense_date, e.description, e.amount, e.partner_id, e.enquiry_id,
           c.name AS category_name, p.name AS partner_name
      FROM expenses e
      LEFT JOIN expense_categories c ON c.id = e.category_id
      LEFT JOIN partners p ON p.id = e.partner_id
     WHERE e.kind = 'expense' AND (${where.join(' OR ')})
     ORDER BY e.expense_date`).all(params) : [];

  const expenseTotal = round(expenses.reduce((a, e) => a + e.amount, 0));
  const billed = round(bills.reduce((a, b) => a + b.value, 0));
  const ordered = round(orders.reduce((a, o) => a + o.value, 0));
  const cost = round(goods + expenseTotal);

  return {
    revenue,
    goods_cost: goods,
    ordered,
    billed,
    expenses,
    expense_total: expenseTotal,
    cost,
    margin: round(revenue - cost),
    margin_percent: revenue ? round(((revenue - cost) / revenue) * 100) : 0,
    purchase_orders: orders,
    bills,
  };
}

/**
 * AKR's own overheads — the rent, the salaries, the trade licence — the ones
 * nobody booked to a supplier's or a client's account, because they do not
 * belong to one.
 */
function unbookedOverheads(params, expFilter) {
  return round(db.prepare(`
    SELECT COALESCE(SUM(e.amount), 0) AS amount FROM expenses e
     WHERE e.partner_id IS NULL AND e.kind = 'expense'
       AND e.expense_date BETWEEN @from AND @to ${expFilter}`).get(params).amount);
}

/**
 * Spread a pot of overheads across accounts, pro rata on `basis`.
 *
 * The accountant's own rule: the accounts that carried the most of the year
 * carry the most of its overheads. Rounding is settled on the largest share so
 * the parts come to the pot exactly — an apportionment that does not add up to
 * what was spent is not an apportionment.
 *
 * Every row gets an `overhead_share`, zero included, so a caller can always
 * read the column. Where there is nothing to apportion on — no revenue, no
 * purchases — nothing is spread, and the pot stays visible as unallocated
 * rather than being shared out on a basis that does not exist.
 */
function apportion(rows, pot, basis) {
  for (const r of rows) r.overhead_share = 0;
  if (!pot) return rows;
  const total = rows.reduce((a, r) => a + (r[basis] || 0), 0);
  if (total <= 0) return rows;

  let spread = 0;
  let largest = null;
  for (const r of rows) {
    const share = round((pot * (r[basis] || 0)) / total);
    r.overhead_share = share;
    spread = round(spread + share);
    if ((r[basis] || 0) > 0 && (!largest || r[basis] > largest[basis])) largest = r;
  }
  if (largest && spread !== pot) {
    largest.overhead_share = round(largest.overhead_share + (pot - spread));
  }
  return rows;
}

/**
 * Who we sold to, and what it made.
 *
 * The group figure says what the business took; this says which clients it
 * came from, with the cost of those particular goods against it — the same
 * cut as the group's gross margin, read one account at a time. Every trading
 * client is listed, including the quiet ones: an account that bought nothing
 * this period is itself worth seeing.
 */
function byClient({ from, to, companyId = null }) {
  const params = { from, to, companyId };
  const filter = companyId ? 'AND i.company_id = @companyId' : '';
  const expFilter = companyId ? 'AND e.company_id = @companyId' : '';

  const rows = db.prepare(`
    SELECT p.id, p.code, p.name,
      (SELECT COUNT(*) FROM sales_invoices i
        WHERE i.partner_id = p.id AND i.status != 'cancelled'
          AND i.invoice_date BETWEEN @from AND @to ${filter}) AS invoices,
      (SELECT COALESCE(SUM(i.subtotal - i.discount), 0) FROM sales_invoices i
        WHERE i.partner_id = p.id AND i.status != 'cancelled'
          AND i.invoice_date BETWEEN @from AND @to ${filter}) AS revenue,
      (SELECT COALESCE(SUM(i.vat_amount), 0) FROM sales_invoices i
        WHERE i.partner_id = p.id AND i.status != 'cancelled'
          AND i.invoice_date BETWEEN @from AND @to ${filter}) AS vat,
      (SELECT COALESCE(SUM(li.cost_price * li.qty), 0) FROM sales_invoice_items li
         JOIN sales_invoices i ON i.id = li.invoice_id
        WHERE i.partner_id = p.id AND i.status != 'cancelled'
          AND i.invoice_date BETWEEN @from AND @to ${filter}) AS cost_of_sales,
      (SELECT COALESCE(SUM(i.total - i.paid_amount), 0) FROM sales_invoices i
        WHERE i.partner_id = p.id AND i.status NOT IN ('cancelled','paid')) AS outstanding,
      (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e
        WHERE e.partner_id = p.id AND e.kind = 'expense'
          AND e.expense_date BETWEEN @from AND @to ${expFilter}) AS expenses,
      (SELECT COUNT(*) FROM expenses e
        WHERE e.partner_id = p.id AND e.kind = 'expense'
          AND e.expense_date BETWEEN @from AND @to ${expFilter}) AS expense_count
     FROM partners p
    WHERE p.active = 1 AND p.type IN ('client', 'both')
    ORDER BY revenue DESC, p.name`).all(params);

  const named = rows.map((r) => {
    const revenue = round(r.revenue);
    const cost = round(r.cost_of_sales);
    const margin = round(revenue - cost);
    const expenses = round(r.expenses);
    return {
      ...r,
      revenue,
      vat: round(r.vat),
      cost_of_sales: cost,
      margin,
      margin_percent: revenue ? round((margin / revenue) * 100) : 0,
      expenses,
      outstanding: round(r.outstanding),
      traded: Boolean(r.invoices || r.expense_count),
    };
  });

  // What the account is left carrying: its margin, less anything booked
  // directly to it, less its share of the group's general overheads.
  apportion(named, unbookedOverheads(params, expFilter), 'revenue');
  for (const r of named) {
    r.contribution = round(r.margin - r.expenses - r.overhead_share);
  }
  return named;
}

/**
 * Where the money went, manufacturer by manufacturer.
 *
 * Two different things are owed to a supplier and both belong here: what they
 * invoiced us for material, and what was booked against their account as an
 * expense — freight, testing, a mobilisation charge. Together they are what
 * that manufacturer cost the group in the period.
 *
 * This is deliberately not the same figure as the cost of sales above it. Cost
 * of sales is what the goods *invoiced to clients* cost, whenever they were
 * bought; this is what the makers billed us *in this period*, whenever those
 * goods are sold. In a month where the yard fills or empties the two differ,
 * and the difference is stock, not an error.
 */
function bySupplier({ from, to, companyId = null }) {
  const params = { from, to, companyId };
  const billFilter = companyId ? 'AND b.company_id = @companyId' : '';
  const expFilter = companyId ? 'AND e.company_id = @companyId' : '';
  const poFilter = companyId ? 'AND o.company_id = @companyId' : '';

  const rows = db.prepare(`
    SELECT p.id, p.code, p.name,
      (SELECT COUNT(*) FROM supplier_invoices b
        WHERE b.partner_id = p.id AND b.status != 'cancelled'
          AND b.invoice_date BETWEEN @from AND @to ${billFilter}) AS bills,
      (SELECT COALESCE(SUM(b.subtotal - b.discount), 0) FROM supplier_invoices b
        WHERE b.partner_id = p.id AND b.status != 'cancelled'
          AND b.invoice_date BETWEEN @from AND @to ${billFilter}) AS billed,
      (SELECT COALESCE(SUM(b.vat_amount), 0) FROM supplier_invoices b
        WHERE b.partner_id = p.id AND b.status != 'cancelled'
          AND b.invoice_date BETWEEN @from AND @to ${billFilter}) AS input_vat,
      (SELECT COALESCE(SUM(b.paid_amount), 0) FROM supplier_invoices b
        WHERE b.partner_id = p.id AND b.status != 'cancelled'
          AND b.invoice_date BETWEEN @from AND @to ${billFilter}) AS paid,
      (SELECT COALESCE(SUM(b.total - b.paid_amount), 0) FROM supplier_invoices b
        WHERE b.partner_id = p.id AND b.status NOT IN ('cancelled','paid')) AS outstanding,
      (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e
        WHERE e.partner_id = p.id AND e.kind = 'expense'
          AND e.expense_date BETWEEN @from AND @to ${expFilter}) AS expenses,
      (SELECT COUNT(*) FROM expenses e
        WHERE e.partner_id = p.id AND e.kind = 'expense'
          AND e.expense_date BETWEEN @from AND @to ${expFilter}) AS expense_count,
      (SELECT COUNT(*) FROM purchase_orders o
        WHERE o.partner_id = p.id AND o.status != 'cancelled'
          AND o.lpo_date BETWEEN @from AND @to ${poFilter}) AS orders,
      (SELECT COALESCE(SUM(o.subtotal - o.discount), 0) FROM purchase_orders o
        WHERE o.partner_id = p.id AND o.status != 'cancelled'
          AND o.lpo_date BETWEEN @from AND @to ${poFilter}) AS ordered
     FROM partners p
    WHERE p.active = 1 AND p.type IN ('supplier', 'both')
    ORDER BY billed DESC, p.name`).all(params);

  const named = rows.map((r) => {
    const billed = round(r.billed);
    const expenses = round(r.expenses);
    return {
      ...r,
      billed,
      input_vat: round(r.input_vat),
      paid: round(r.paid),
      outstanding: round(r.outstanding),
      expenses,
      ordered: round(r.ordered),
      total_cost: round(billed + expenses),
      traded: Boolean(r.bills || r.expense_count || r.orders),
    };
  });

  /*
   * Rent, salaries, the trade licence: overheads nobody booked against a
   * supplier's account, because they do not belong to one. Read as they were
   * entered they are their own row — without it the column would quietly
   * disagree with the group's expenses, and a column that does not add up is
   * worse than no column. Read pro rata they are the share on each row, which
   * is how the accounts desk apportions them.
   */
  const loose = db.prepare(`
    SELECT COALESCE(SUM(e.amount), 0) AS amount, COUNT(*) AS n FROM expenses e
     WHERE e.partner_id IS NULL AND e.kind = 'expense'
       AND e.expense_date BETWEEN @from AND @to ${expFilter}`).get(params);

  apportion(named, round(loose.amount), 'billed');
  for (const r of named) {
    r.cost_with_overheads = round(r.total_cost + r.overhead_share);
  }
  if (loose.n) {
    named.push({
      id: null, code: '—', name: 'Overheads not booked to a supplier',
      bills: 0, billed: 0, input_vat: 0, paid: 0, outstanding: 0,
      expenses: round(loose.amount), expense_count: loose.n,
      orders: 0, ordered: 0, total_cost: round(loose.amount),
      overhead_share: 0, cost_with_overheads: round(loose.amount),
      traded: true, unattributed: true,
    });
  }
  return named;
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
      // AKR's own vocabulary, and the order the owner reads a month in: the
      // margin left on the goods first, then that month's overheads taken off
      // it, and what survives is the month's gross profit. (The group P&L
      // below still uses the accounting sense of gross profit — sales less
      // cost of sales — which is `trading_margin` here.)
      const margin = round(m.revenue - m.cost_of_sales);
      return {
        ...m,
        trading_margin: margin,
        gross_margin_percent: m.revenue ? round((margin / m.revenue) * 100) : 0,
        // Other income — a rebate, a scrap sale — is not part of what the
        // trade made, and the owner reads this page as the trade. It is still
        // counted, in Expenses & Income, and the page says so where there is
        // any.
        gross_profit: round(margin - m.expenses),
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
      trading_margin: sum('trading_margin'),
      other_income: sum('other_income'),
      expenses: sum('expenses'),
      gross_profit: sum('gross_profit'),
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

module.exports = { partnerLedger, ageing, vatReturn, profitAndLoss, statement, byClient,
  bySupplier, unbookedOverheads, jobCost, monthlyProfit, partnerBalance };
