'use strict';
/**
 * The month's expenses, as the accounts office asked for them.
 *
 * Four things this has to get right, and they are the four a spreadsheet
 * kept by hand usually gets wrong.
 *
 * Setup is not running cost. What it took to build the clinic is an
 * investment the owner expects back; the cost of being open this month is
 * something else. They are totalled apart, and the operating subtotal is the
 * one the clinic is judged on.
 *
 * Interest and depreciation sit below that subtotal. Interest is the price
 * of the borrowed money, not of the month's work, and depreciation is not a
 * payment at all — it is last year's machine being used up this month, and
 * it comes from the asset register rather than from anything anyone types.
 *
 * Buying stock is not a cost. A rupee of medicine becomes a cost when it is
 * sold, and the pharmacy already knows exactly which batch left and what it
 * had cost. Counting the purchase invoice as well would charge the same
 * rupee twice, so purchases are reported on a schedule of their own.
 *
 * And a bill that has not been paid is still a cost of the month it belongs
 * to. That is the whole reason the expense book records invoices rather than
 * only payments — so "what did October cost" has an answer on the 1st of
 * November rather than whenever the last supplier happens to be settled.
 */
const { db } = require('../db');
const book = require('../db/expenseBook');
const commercial = require('../lib/commercial');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const monthStart = (period) => `${period}-01`;
const monthEnd = (period) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
/** The financial year an Indian clinic reports in: April to March. */
function yearStart(period) {
  const [y, m] = period.split('-').map(Number);
  return m >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
}

const SUMS = `
  COALESCE(SUM(e.total), 0) AS billed,
  COALESCE(SUM(e.paid), 0) AS paid,
  COALESCE(SUM(e.total - e.paid), 0) AS outstanding,
  COALESCE(SUM(e.tax), 0) AS tax,
  COUNT(*) AS entries`;

const shape = (row) => ({
  billed: r2(row && row.billed), paid: r2(row && row.paid),
  outstanding: r2(row && row.outstanding), tax: r2(row && row.tax),
  entries: (row && row.entries) || 0,
});

/** One window of the book, totalled by heading. */
function byCategory(from, to) {
  return db.prepare(
    `SELECT e.category_id AS id, ${SUMS}
       FROM expenses e
      WHERE e.voided_at IS NULL AND date(e.invoice_date) BETWEEN date(?) AND date(?)
      GROUP BY e.category_id`).all(from, to);
}

function byDepartment(from, to) {
  return db.prepare(
    `SELECT e.department AS dept, c.nature AS nature, ${SUMS}
       FROM expenses e JOIN expense_categories c ON c.id = e.category_id
      WHERE e.voided_at IS NULL AND date(e.invoice_date) BETWEEN date(?) AND date(?)
      GROUP BY e.department, c.nature`).all(from, to);
}

function byItem(from, to) {
  return db.prepare(
    `SELECT e.category_id AS category_id, e.item_id AS item_id,
            COALESCE(i.name, 'Not itemised') AS item_name, ${SUMS}
       FROM expenses e LEFT JOIN expense_items i ON i.id = e.item_id
      WHERE e.voided_at IS NULL AND date(e.invoice_date) BETWEEN date(?) AND date(?)
      GROUP BY e.category_id, e.item_id
      ORDER BY billed DESC`).all(from, to);
}

const add = (a, b) => ({
  billed: r2(a.billed + b.billed), paid: r2(a.paid + b.paid),
  outstanding: r2(a.outstanding + b.outstanding), tax: r2(a.tax + b.tax),
  entries: a.entries + b.entries,
});
const ZERO = { billed: 0, paid: 0, outstanding: 0, tax: 0, entries: 0 };

/**
 * The report for one month, with the year to date beside every figure.
 *
 * `period` is YYYY-MM. The year runs from April, which is the year an Indian
 * clinic files in — a report that quietly used January would disagree with
 * every other paper the accountant handles.
 */
function monthly(period) {
  const from = monthStart(period);
  const to = monthEnd(period);
  const ytdFrom = yearStart(period);

  const categories = db.prepare(
    'SELECT * FROM expense_categories ORDER BY cost_group, sort_order, id').all();
  const monthRows = new Map(byCategory(from, to).map((r) => [r.id, shape(r)]));
  const ytdRows = new Map(byCategory(ytdFrom, to).map((r) => [r.id, shape(r)]));
  const items = byItem(from, to);
  const itemsByCategory = new Map();
  for (const it of items) {
    if (!itemsByCategory.has(it.category_id)) itemsByCategory.set(it.category_id, []);
    itemsByCategory.get(it.category_id).push({ ...shape(it), id: it.item_id, name: it.item_name });
  }

  const groups = book.GROUPS.map((g) => {
    const rows = categories.filter((c) => c.cost_group === g.key).map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      nature: c.nature,
      department: c.default_department,
      note: c.note,
      month: monthRows.get(c.id) || { ...ZERO },
      ytd: ytdRows.get(c.id) || { ...ZERO },
      items: itemsByCategory.get(c.id) || [],
    }));
    return {
      key: g.key,
      label: g.label,
      note: g.note,
      categories: rows,
      month: rows.reduce((t, r) => add(t, r.month), { ...ZERO }),
      ytd: rows.reduce((t, r) => add(t, r.ytd), { ...ZERO }),
    };
  });

  // --------------------------------------------------------- by department
  const deptMonth = byDepartment(from, to);
  const deptYtd = byDepartment(ytdFrom, to);
  const pick = (rows, key, operatingOnly) => rows
    .filter((r) => r.dept === key && (!operatingOnly || r.nature === 'operating'))
    .reduce((t, r) => add(t, shape(r)), { ...ZERO });

  const departments = book.DEPARTMENTS.map((d) => ({
    key: d.key,
    label: d.label,
    month: pick(deptMonth, d.key, true),
    ytd: pick(deptYtd, d.key, true),
    // Everything booked to the department, running costs or not, so a
    // department that bought a machine this month does not look overspent.
    allMonth: pick(deptMonth, d.key, false),
    allYtd: pick(deptYtd, d.key, false),
  }));

  const group = (key) => groups.find((g) => g.key === key) || { month: { ...ZERO }, ytd: { ...ZERO } };
  const natureTotal = (rows, nature) => rows
    .filter((r) => r.nature === nature)
    .reduce((t, r) => add(t, shape(r)), { ...ZERO });

  const operating = {
    month: natureTotal(deptMonth, 'operating'),
    ytd: natureTotal(deptYtd, 'operating'),
  };

  // ----------------------------------------------- below the subtotal
  const dep = commercial.depreciation(from, to);
  const depYtd = commercial.depreciation(ytdFrom, to);
  const belowTheLine = {
    finance: { month: group('finance').month, ytd: group('finance').ytd },
    depreciation: {
      month: { billed: r2(dep.amount), paid: 0, outstanding: 0, tax: 0, entries: dep.assets || 0 },
      ytd: { billed: r2(depYtd.amount), paid: 0, outstanding: 0, tax: 0, entries: depYtd.assets || 0 },
      // Said out loud, because a depreciation figure resting on a guessed
      // life is a figure somebody should know is a guess.
      note: 'From the asset register, straight line. Nothing is paid out for it.',
      guessedLives: dep.guessed || 0,
    },
  };

  /*
   * The schedules. Each is money out that is not a cost of the month, and
   * each is one the accounts letter asked to be kept on its own.
   *
   * Stock is the exception that is worth stating: the medicines schedule is
   * what the pharmacy bought, taken from its own goods-received notes rather
   * than from anything typed here, because that is where the purchase
   * already is and the two should never be able to disagree.
   */
  const purchaseSql = `SELECT COALESCE(SUM(net), 0) AS value, COUNT(*) AS notes
       FROM stock_purchases
      WHERE status != 'cancelled' AND date(received_at) BETWEEN date(?) AND date(?)`;
  const purchases = db.prepare(purchaseSql).get(from, to);
  const purchasesYtd = db.prepare(purchaseSql).get(ytdFrom, to);

  const natureRows = (nature, f, t) => db.prepare(
    `SELECT ${SUMS} FROM expenses e JOIN expense_categories c ON c.id = e.category_id
      WHERE e.voided_at IS NULL AND c.nature = ?
        AND date(e.invoice_date) BETWEEN date(?) AND date(?)`).get(nature, f, t);

  const schedule = (nature) => ({
    month: shape(natureRows(nature, from, to)),
    ytd: shape(natureRows(nature, ytdFrom, to)),
  });

  const schedules = {
    setup: { ...schedule('capital'), label: 'Setup and equipment purchases' },
    stock: {
      label: 'Medicines and consumables purchased',
      month: { billed: r2(purchases.value), paid: 0, outstanding: 0, tax: 0, entries: purchases.notes },
      ytd: { billed: r2(purchasesYtd.value), paid: 0, outstanding: 0, tax: 0, entries: purchasesYtd.notes },
      note: 'From the pharmacy\'s goods-received notes. A purchase becomes a cost when the pack '
        + 'is sold, which the margin already counts — it is not added to the month\'s expenses here.',
      booked: schedule('stock'),
    },
    deposits: { ...schedule('deposit'), label: 'Refundable deposits' },
    advances: { ...schedule('advance'), label: 'Supplier advances' },
    loanPrincipal: { ...schedule('financing_capital'), label: 'Loan principal repayments' },
  };

  /*
   * What the clinic still owes, and what it cannot yet prove it spent.
   *
   * "Flag entries with missing documents" was asked for literally, and it is
   * the figure an auditor opens with: a bill with no invoice number and no
   * scan attached is money the clinic cannot account for to anybody outside
   * it, however honestly it was spent.
   */
  const missing = db.prepare(
    `SELECT COUNT(*) AS entries, COALESCE(SUM(e.total), 0) AS amount
       FROM expenses e
      WHERE e.voided_at IS NULL AND date(e.invoice_date) BETWEEN date(?) AND date(?)
        AND (e.invoice_no IS NULL OR TRIM(e.invoice_no) = ''
             OR NOT EXISTS (SELECT 1 FROM expense_attachments x WHERE x.expense_id = e.id))`
  ).get(from, to);

  const unpaid = db.prepare(
    `SELECT COUNT(*) AS entries, COALESCE(SUM(e.total - e.paid), 0) AS amount
       FROM expenses e
      WHERE e.voided_at IS NULL AND e.status IN ('unpaid','part_paid')
        AND date(e.invoice_date) <= date(?)`).get(to);

  const overdue = db.prepare(
    `SELECT COUNT(*) AS entries, COALESCE(SUM(e.total - e.paid), 0) AS amount
       FROM expenses e
      WHERE e.voided_at IS NULL AND e.status IN ('unpaid','part_paid')
        AND e.due_date IS NOT NULL AND date(e.due_date) < date(?)`).get(to);

  /*
   * Patient discounts and refunds, reported here and counted nowhere near
   * the expenses. A discount is revenue the clinic chose not to earn, and a
   * clinic that lets it into the expense column is one whose cost per
   * patient climbs every time it is generous.
   */
  const given = db.prepare(
    `SELECT COALESCE(SUM(i.discount + i.bill_discount + i.sliding_discount
                         + i.assistance_covered), 0) AS amount,
            COUNT(*) AS invoices
       FROM invoices i
      WHERE i.status NOT IN ('cancelled','draft')
        AND date(i.created_at) BETWEEN date(?) AND date(?)`).get(from, to);
  const refunded = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS entries
       FROM cash_book
      WHERE voided_at IS NULL AND direction = 'out' AND category = 'Refund to patient'
        AND date(entry_date) BETWEEN date(?) AND date(?)`).get(from, to);

  return {
    period,
    from,
    to,
    ytdFrom,
    groups,
    departments,
    operating,
    belowTheLine,
    schedules,
    flags: {
      missingDocuments: { entries: missing.entries, amount: r2(missing.amount) },
      unpaid: { entries: unpaid.entries, amount: r2(unpaid.amount) },
      overdue: { entries: overdue.entries, amount: r2(overdue.amount) },
    },
    patients: {
      discountsGiven: { amount: r2(given.amount), invoices: given.invoices },
      refunds: { amount: r2(refunded.amount), entries: refunded.entries },
      note: 'Reported here, counted nowhere in the costs: a discount is revenue not earned, '
        + 'not money spent.',
    },
    totals: {
      // What the month cost to run, and then the two figures that are not
      // that but are asked about in the same breath.
      operating: operating.month.billed,
      operatingYtd: operating.ytd.billed,
      interest: belowTheLine.finance.month.billed,
      depreciation: belowTheLine.depreciation.month.billed,
      afterTheLine: r2(operating.month.billed + belowTheLine.finance.month.billed
        + belowTheLine.depreciation.month.billed),
    },
  };
}

module.exports = { monthly, yearStart, monthStart, monthEnd };
