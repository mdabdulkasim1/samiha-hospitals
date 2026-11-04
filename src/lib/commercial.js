'use strict';
/**
 * The commercial eye: what each part of the clinic earns, what it costs to
 * run, and whether the month covered itself.
 *
 * Everything above this file answers "how much came in". This file answers
 * the harder question — whether it was worth doing — and that needs three
 * distinctions kept straight. Getting any of them wrong produces a report
 * that is confidently, specifically wrong, which is worse than no report.
 *
 *   BILLED is not COLLECTED. The owner's headline board counts money that
 *   arrived, because that is what pays the staff. This file counts what was
 *   earned, net of discounts, because a department's margin cannot be judged
 *   by how fast its patients happen to pay. Both are true; they are not the
 *   same number, and every screen built on this file says which it is using.
 *
 *   PURCHASED is not CONSUMED. Buying six months of stock is not a cost of
 *   this month. The cost of medicines is taken from the packs that actually
 *   went out of the door, priced at the batch they came from — the clinic
 *   records enough to know this exactly. What was bought belongs in the cash
 *   flow, and is deliberately kept out of the profit below.
 *
 *   DIRECT is not OVERHEAD. A reagent is spent because a test was run; rent
 *   is spent whether or not anybody walks in. Only the first can be charged
 *   to a department honestly. The second is allocated — by revenue share,
 *   which is a convention and not a measurement, and the screen says so.
 *
 * Where the clinic does not record something, this file does not invent it.
 * Reagent consumption is not inventoried, so the reagent ratio is built from
 * what was bought and is flagged as such. Depreciation needs a life that
 * nobody has typed in yet, so it is defaulted by category and the count of
 * guesses is reported. An honest gap is a finding; a plausible number in its
 * place is a lie the owner cannot see.
 */
const { db } = require('../db');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/* ------------------------------------------------------------- departments
 *
 * The five the owner asked for, and the SQL that decides what belongs to
 * each. Revenue is recognised on the bill, so every line of it is traced to
 * the thing that was sold:
 *
 *   consultation  — a doctor was seen
 *   lab           — ref_id is a lab_order_items row, whose test carries the
 *                   category that separates a blood test from a scan from an
 *                   ECG from a day-care procedure
 *   pharmacy      — medicines, whether billed to a visit or sold at the
 *                   counter to somebody who is not our patient at all
 *   room/ip_charge— a bed and what was done in it
 *   service       — the rate card, which carries its own category
 */
const DEPARTMENTS = [
  {
    key: 'consultation',
    label: 'Consultations',
    unit: 'consultation',
    unitPlural: 'consultations',
    // What the doctor was paid for seeing them, and what the room cost to staff.
    directCategories: ['Doctor fees & honorarium'],
  },
  {
    key: 'laboratory',
    label: 'Laboratory',
    unit: 'test',
    unitPlural: 'tests',
    directCategories: ['Lab reagents & kits'],
  },
  {
    key: 'imaging',
    label: 'X-ray / Scans / ECG',
    unit: 'examination',
    unitPlural: 'examinations',
    directCategories: [],
  },
  {
    key: 'pharmacy',
    label: 'Pharmacy',
    unit: 'line',
    unitPlural: 'lines',
    // Nothing from the cash book: the cost of a medicine sold is known
    // exactly from the batch it left, and adding the purchase invoice on top
    // would count the same rupee twice.
    directCategories: [],
  },
  {
    key: 'procedures',
    label: 'Procedures / Day care',
    unit: 'case',
    unitPlural: 'cases',
    directCategories: [],
  },
];

const DEPT_KEYS = DEPARTMENTS.map((d) => d.key);

/**
 * Which department an invoice line belongs to, as a SQL expression.
 *
 * Written once, here, because the revenue table, the count of units and the
 * margin trend all have to agree about what a scan is. A line nobody has
 * taught us about reports as 'other' rather than being quietly dropped into
 * the biggest department.
 */
const DEPT_OF_LINE = `
  CASE
    WHEN ii.ref_type = 'consultation' THEN 'consultation'
    WHEN ii.ref_type = 'pharmacy' THEN 'pharmacy'
    WHEN ii.ref_type IN ('room','ip_charge') THEN 'procedures'
    WHEN ii.ref_type = 'lab' THEN
      CASE COALESCE((SELECT t.category FROM lab_order_items loi
                       JOIN lab_tests t ON t.id = loi.test_id
                      WHERE loi.id = ii.ref_id), 'lab')
        WHEN 'radiology'  THEN 'imaging'
        WHEN 'cardiology' THEN 'imaging'
        WHEN 'procedure'  THEN 'procedures'
        ELSE 'laboratory'
      END
    WHEN ii.ref_type = 'service' THEN
      CASE COALESCE((SELECT s.category FROM services s WHERE s.id = ii.ref_id), 'other')
        WHEN 'consultation' THEN 'consultation'
        WHEN 'lab'          THEN 'laboratory'
        WHEN 'radiology'    THEN 'imaging'
        WHEN 'procedure'    THEN 'procedures'
        WHEN 'nursing'      THEN 'procedures'
        WHEN 'room'         THEN 'procedures'
        WHEN 'pharmacy'     THEN 'pharmacy'
        ELSE 'other'
      END
    ELSE 'other'
  END`;

/*
 * An invoice-level discount belongs to the lines that earned it.
 *
 * A sliding-scale concession or an assistance grant is given against the
 * whole bill, not against the consultation on line one. Charging it all to
 * whichever department happens to be billed first would make that department
 * look unprofitable and the others look better than they are, so it is
 * apportioned across the lines in proportion to what each one came to. The
 * clinic's own write-offs are handled the same way.
 */
const NET_LINE = `
  ii.amount - (ii.amount / NULLIF(gross.total, 0)) *
    (i.discount + i.sliding_discount + i.assistance_covered)`;

/* ----------------------------------------------------------- the cost book
 *
 * Every cash-book category, told where it belongs. Four things are decided
 * here and they are separate questions:
 *
 *   line     which row of the owner's monthly comparison it lands on
 *   nature   direct to a department, shared overhead, capital, financing, or
 *            a refund that is not a cost at all but a reduction of revenue
 *   fixed    whether it is there whatever the clinic does this month, which
 *            is the only thing that makes a break-even calculation mean
 *            anything
 *
 * Capital and financing are deliberately NOT costs. Buying a machine is not
 * an expense, it is a swap of cash for a machine, and its cost reaches the
 * profit as depreciation spread over the years it works. Counting both would
 * charge the clinic twice for the same scanner. Repaying a loan is the same
 * trade in reverse; only its interest is a cost.
 */
const COST_BOOK = {
  'Salaries & wages': { line: 'payroll', nature: 'overhead', fixed: true },
  'Doctor fees & honorarium': { line: 'doctorPayout', nature: 'direct', department: 'consultation', fixed: false },
  Rent: { line: 'rentUtilities', nature: 'overhead', fixed: true },
  'Electricity & water': { line: 'rentUtilities', nature: 'overhead', fixed: true },
  // Bought, not used. The cost of medicines in the profit comes from the
  // packs dispensed; this is the purchase invoice and belongs to cash flow.
  'Medicines & consumables': { line: null, nature: 'stock', fixed: false },
  // Reagents are not inventoried, so purchases are the only figure there is.
  // Reported as a direct cost of the laboratory with the caveat attached.
  'Lab reagents & kits': { line: 'medicinesConsumed', nature: 'direct', department: 'laboratory', fixed: false, estimated: true },
  'Equipment purchase': { line: null, nature: 'capital', fixed: false },
  'Equipment maintenance': { line: 'maintenanceAdmin', nature: 'overhead', fixed: true },
  'Housekeeping & security': { line: 'maintenanceAdmin', nature: 'overhead', fixed: true },
  'Printing & stationery': { line: 'maintenanceAdmin', nature: 'overhead', fixed: false },
  'Telephone & internet': { line: 'maintenanceAdmin', nature: 'overhead', fixed: true },
  'Marketing & camps': { line: 'marketing', nature: 'overhead', fixed: false },
  'Travel & conveyance': { line: 'maintenanceAdmin', nature: 'overhead', fixed: false },
  'Professional & audit fees': { line: 'maintenanceAdmin', nature: 'overhead', fixed: true },
  'Licences, taxes & insurance': { line: 'maintenanceAdmin', nature: 'overhead', fixed: true },
  'Bank charges & interest': { line: 'interest', nature: 'financing', fixed: true },
  'Loan repayment': { line: null, nature: 'financing_capital', fixed: false },
  'Refund to patient': { line: null, nature: 'contra_revenue', fixed: false },
  'Other expense': { line: 'maintenanceAdmin', nature: 'overhead', fixed: false },
};
const costRule = (category) => COST_BOOK[category]
  || { line: 'maintenanceAdmin', nature: 'overhead', fixed: false, unmapped: true };

/*
 * Outsourced diagnostics have their own line in the owner's report but no
 * category of their own in the cash book. Rather than invent one and leave
 * every historic entry outside it, entries whose payee or note says the work
 * went outside are picked out of the reagent and other-expense headings.
 */
const OUTSOURCED = "(LOWER(COALESCE(payee,'') || ' ' || COALESCE(notes,'')) LIKE '%outsourc%'"
  + " OR LOWER(COALESCE(payee,'') || ' ' || COALESCE(notes,'')) LIKE '%referral lab%'"
  + " OR LOWER(COALESCE(payee,'') || ' ' || COALESCE(notes,'')) LIKE '%outside lab%')";

/** The rows of the monthly comparison, in the order the owner reads them. */
const COMPARISON_LINES = [
  { key: 'netRevenue', label: 'Net revenue', kind: 'revenue' },
  { key: 'medicinesConsumed', label: 'Medicines and consumables used', kind: 'cost' },
  { key: 'doctorPayout', label: 'Doctor / consultant payouts', kind: 'cost' },
  { key: 'payroll', label: 'Employee salaries and overtime', kind: 'cost' },
  { key: 'outsourced', label: 'Outsourced diagnostic costs', kind: 'cost' },
  { key: 'rentUtilities', label: 'Rent and utilities', kind: 'cost' },
  { key: 'maintenanceAdmin', label: 'Maintenance, software and administration', kind: 'cost' },
  { key: 'marketing', label: 'Marketing expenses', kind: 'cost' },
  { key: 'ebitda', label: 'Operating profit before depreciation and interest', kind: 'subtotal' },
  { key: 'depreciation', label: 'Depreciation', kind: 'cost' },
  { key: 'operatingProfit', label: 'Operating profit', kind: 'subtotal' },
  { key: 'interest', label: 'Interest expense', kind: 'cost' },
  { key: 'profitBeforeTax', label: 'Profit before tax', kind: 'total' },
];
/** The lines a budget can be set against — the measured subtotals cannot. */
const BUDGETABLE = COMPARISON_LINES.filter((l) => l.kind !== 'subtotal' && l.kind !== 'total')
  .map((l) => l.key);

/* ------------------------------------------------------------------ pieces */

/** Revenue earned, net of every discount, by department. */
function revenueByDepartment(from, to) {
  const rows = db.prepare(
    `WITH gross AS (
       SELECT ii.invoice_id AS id, SUM(ii.amount) AS total
         FROM invoice_items ii GROUP BY ii.invoice_id)
     SELECT ${DEPT_OF_LINE} AS dept,
            SUM(${NET_LINE}) AS revenue,
            SUM(ii.qty) AS units,
            COUNT(*) AS lines
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       JOIN gross ON gross.id = ii.invoice_id
      WHERE i.status NOT IN ('cancelled','draft')
        AND date(i.created_at) BETWEEN date(?) AND date(?)
      GROUP BY dept`).all(from, to);

  const out = {};
  for (const r of rows) out[r.dept] = { revenue: r2(r.revenue), units: r2(r.units), lines: r.lines };

  /*
   * The counter sale is pharmacy revenue with no invoice behind it — a
   * walk-in who is not our patient. It is real money and it has a real cost
   * of sale, so leaving it out would understate the one department whose
   * margin this system can state exactly.
   */
  const counter = db.prepare(
    `SELECT COALESCE(SUM(i.amount), 0) AS revenue, COALESCE(SUM(i.qty), 0) AS units,
            COUNT(*) AS lines
       FROM pharmacy_sale_items i
       JOIN pharmacy_sales s ON s.id = i.sale_id
      WHERE s.sale_type = 'counter' AND s.status != 'cancelled'
        AND date(s.created_at) BETWEEN date(?) AND date(?)`).get(from, to);
  const ph = out.pharmacy || { revenue: 0, units: 0, lines: 0 };
  out.pharmacy = {
    revenue: r2(ph.revenue + counter.revenue),
    units: r2(ph.units + counter.units),
    lines: ph.lines + counter.lines,
  };
  return out;
}

/**
 * What the medicines that left the shelf had cost to buy.
 *
 * The one cost of sale this system knows exactly, because every pack
 * dispensed names its batch and every batch carries what was paid for it.
 * Lines whose batch predates the stock ledger have no price to join to and
 * contribute nothing, which understates the cost — so they are counted and
 * reported rather than smoothed over with an average.
 */
function medicinesSoldCost(from, to) {
  return db.prepare(
    `SELECT COALESCE(SUM(i.qty * COALESCE(b.purchase_price, 0)), 0) AS cost,
            SUM(CASE WHEN b.purchase_price IS NULL OR b.purchase_price = 0 THEN 1 ELSE 0 END) AS unpriced,
            COUNT(*) AS lines
       FROM pharmacy_sale_items i
       JOIN pharmacy_sales s ON s.id = i.sale_id
       LEFT JOIN drug_batches b ON b.id = i.batch_id
      WHERE s.status != 'cancelled'
        AND date(s.created_at) BETWEEN date(?) AND date(?)`).get(from, to);
}

/** The cash book for the period, already classified. */
function spending(from, to) {
  const rows = db.prepare(
    `SELECT category, direction, SUM(amount) AS amount, COUNT(*) AS entries,
            SUM(CASE WHEN ${OUTSOURCED} THEN amount ELSE 0 END) AS outsourced
       FROM cash_book
      WHERE voided_at IS NULL AND date(entry_date) BETWEEN date(?) AND date(?)
      GROUP BY category, direction`).all(from, to);
  return rows.map((r) => ({ ...r, amount: r2(r.amount), outsourced: r2(r.outsourced),
    rule: r.direction === 'out' ? costRule(r.category) : null }));
}

/**
 * Stock written off — expired, broken, miscounted.
 *
 * Taken from the ledger rather than from anybody's memory, priced at what the
 * batch cost. Visible on its own because it is the one cost on this page that
 * is entirely avoidable, and a clinic that cannot see it will keep paying it.
 */
function wastage(from, to) {
  const rows = db.prepare(
    `SELECT l.txn_type AS kind,
            COALESCE(SUM(-l.qty_delta * COALESCE(b.purchase_price, 0)), 0) AS value,
            COUNT(*) AS entries
       FROM stock_ledger l
       LEFT JOIN drug_batches b ON b.id = l.batch_id
      WHERE l.txn_type IN ('expiry','adjustment') AND l.qty_delta < 0
        AND date(l.created_at) BETWEEN date(?) AND date(?)
      GROUP BY l.txn_type`).all(from, to);
  const by = (k) => r2((rows.find((r) => r.kind === k) || {}).value || 0);
  return { expired: by('expiry'), adjusted: by('adjustment'),
    total: r2(by('expiry') + by('adjustment')),
    entries: rows.reduce((t, r) => t + r.entries, 0) };
}

/*
 * How long a machine is expected to last, where nobody has said.
 *
 * Straight line, because anything cleverer needs assumptions the clinic has
 * not made. These are conventional lives for the kind of kit a polyclinic
 * buys; any of them can be overridden on the asset itself, and the report
 * says how many assets it had to fall back on a default for.
 */
const DEFAULT_LIFE = {
  'Imaging & laboratory': 10,
  'Medical equipment': 10,
  'Dental equipment': 10,
  'Radiation protection': 15,
  'Hospital furniture': 10,
  'Furniture & fittings': 10,
  'IT & office': 5,
  'Electrical & utility': 10,
  Other: 10,
};

/** Depreciation falling in the period, straight line over each asset's life. */
function depreciation(from, to) {
  const rows = db.prepare(
    `SELECT category, unit_cost, quantity, purchase_date, life_years, name
       FROM assets
      WHERE active = 1 AND unit_cost IS NOT NULL AND unit_cost > 0
        AND purchase_date IS NOT NULL`).all();
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const days = Math.max(Math.round((end - start) / 86400000) + 1, 1);

  let total = 0;
  let guessed = 0;
  let unknown = 0;
  for (const a of rows) {
    const life = Number(a.life_years) || DEFAULT_LIFE[a.category] || 10;
    if (!a.life_years) guessed += 1;
    const bought = new Date(`${a.purchase_date}T00:00:00Z`);
    if (Number.isNaN(bought.getTime())) { unknown += 1; continue; }
    // Nothing depreciates before it was bought, or after it is written down.
    const writtenOff = new Date(bought);
    writtenOff.setUTCFullYear(writtenOff.getUTCFullYear() + life);
    if (bought > end || writtenOff < start) continue;
    const overlapFrom = bought > start ? bought : start;
    const overlapTo = writtenOff < end ? writtenOff : end;
    const overlapDays = Math.max(Math.round((overlapTo - overlapFrom) / 86400000) + 1, 0);
    const value = Number(a.unit_cost) * (Number(a.quantity) || 1);
    total += (value / (life * 365.25)) * overlapDays;
  }
  // The register also holds assets with no price, which simply cannot be
  // depreciated; they are counted so the figure is not read as complete.
  const priceless = db.prepare(
    'SELECT COUNT(*) AS c FROM assets WHERE active = 1 AND (unit_cost IS NULL OR unit_cost = 0)').get().c;
  return { amount: r2(total), days, assets: rows.length, guessedLife: guessed,
    noPrice: priceless, undated: unknown };
}

/* ------------------------------------------------- 1. department by department */

/**
 * Each department's revenue, what it cost directly, and what is left.
 *
 * Contribution first, because that is the number the clinic controls: it is
 * what the department brings in beyond what it spends to do the work, and it
 * is what has to cover the rent. Operating profit comes after, once shared
 * costs are spread over the departments by revenue share — a convention, not
 * a measurement, and labelled as one, because allocating rent by revenue
 * quietly punishes whichever department is having a good month.
 */
function departmentBoard(from, to) {
  const revenue = revenueByDepartment(from, to);
  const cash = spending(from, to);
  const meds = medicinesSoldCost(from, to);

  const directFromCash = (key) => r2(cash
    .filter((c) => c.direction === 'out' && c.rule && c.rule.nature === 'direct' && c.rule.department === key)
    .reduce((t, c) => t + c.amount, 0));

  // Units: what "per unit" means differs by department, so each is counted
  // in the thing the owner would actually say out loud.
  const consultations = db.prepare(
    `SELECT COUNT(*) AS c FROM visits
      WHERE date(arrived_at) BETWEEN date(?) AND date(?)`).get(from, to).c;

  const rows = DEPARTMENTS.map((d) => {
    const rev = revenue[d.key] || { revenue: 0, units: 0, lines: 0 };
    let direct = directFromCash(d.key);
    let exact = true;
    const caveats = [];

    if (d.key === 'pharmacy') {
      direct = r2(meds.cost);
      if (meds.unpriced) {
        caveats.push(`${meds.unpriced} of ${meds.lines} lines came from a batch with no purchase price, so the cost is understated.`);
        exact = false;
      }
    }
    if (d.key === 'laboratory' && direct) {
      caveats.push('Reagents are not stock-counted, so this is what was bought in the period rather than what was used.');
      exact = false;
    }
    if (d.key === 'imaging' || d.key === 'procedures') {
      caveats.push('No direct cost is recorded against this department yet — book reporting fees and consumables to the cash book to see a true contribution.');
      exact = false;
    }

    const units = d.key === 'consultation' ? consultations : Math.round(rev.units);
    const contribution = r2(rev.revenue - direct);
    return {
      key: d.key,
      label: d.label,
      unit: d.unit,
      unitPlural: d.unitPlural,
      revenue: r2(rev.revenue),
      direct: r2(direct),
      contribution,
      margin: pct(contribution, rev.revenue),
      units,
      perUnit: units ? r2(contribution / units) : null,
      revenuePerUnit: units ? r2(rev.revenue / units) : null,
      exact,
      caveats,
    };
  });

  // Anything billed that no department claims. Shown rather than hidden, so
  // the parts add up to the whole and a mis-coded rate card is visible.
  const other = revenue.other;
  if (other && other.revenue) {
    rows.push({
      key: 'other', label: 'Not yet classified', unit: 'line', unitPlural: 'lines',
      revenue: r2(other.revenue), direct: 0, contribution: r2(other.revenue),
      margin: 100, units: other.lines, perUnit: r2(other.revenue / (other.lines || 1)),
      revenuePerUnit: r2(other.revenue / (other.lines || 1)), exact: false,
      caveats: ['These lines carry no category, so they cannot be attributed to a department. Set a category on the rate card entry.'],
    });
  }

  const totalRevenue = r2(rows.reduce((t, r) => t + r.revenue, 0));
  const overheadRows = cash.filter((c) => c.direction === 'out' && c.rule && c.rule.nature === 'overhead');
  const overhead = r2(overheadRows.reduce((t, c) => t + c.amount, 0));
  const dep = depreciation(from, to);
  const shared = r2(overhead + dep.amount);

  for (const r of rows) {
    r.share = totalRevenue > 0 ? r.revenue / totalRevenue : 0;
    r.allocated = r2(shared * r.share);
    r.operatingProfit = r2(r.contribution - r.allocated);
    r.operatingMargin = pct(r.operatingProfit, r.revenue);
  }

  return {
    rows,
    totals: {
      revenue: totalRevenue,
      direct: r2(rows.reduce((t, r) => t + r.direct, 0)),
      contribution: r2(rows.reduce((t, r) => t + r.contribution, 0)),
      allocated: shared,
      operatingProfit: r2(rows.reduce((t, r) => t + r.operatingProfit, 0)),
      margin: pct(rows.reduce((t, r) => t + r.contribution, 0), totalRevenue),
    },
    overhead: {
      total: shared,
      depreciation: dep.amount,
      basis: 'Spread across departments in proportion to revenue.',
      rows: overheadRows.map((c) => ({ category: c.category, amount: c.amount }))
        .sort((a, b) => b.amount - a.amount),
    },
    /*
     * Cash-book headings this file has never been told about. They are
     * treated as shared overhead so nothing vanishes from the totals, but
     * that is a guess and the owner is shown it: a heading that is really a
     * direct cost of one department is distorting that department's margin
     * until somebody says so.
     */
    unmapped: cash.filter((c) => c.direction === 'out' && c.rule && c.rule.unmapped)
      .map((c) => ({ category: c.category, amount: c.amount, entries: c.entries }))
      .sort((a, b) => b.amount - a.amount),
    wastage: wastage(from, to),
  };
}

/* ------------------------------------------------ 2. the monthly comparison */

const monthStart = (period) => `${period}-01`;
const monthEnd = (period) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const prevPeriod = (period) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};

/** Every line of the profit statement for one month, measured. */
function actuals(period) {
  const from = monthStart(period);
  const to = monthEnd(period);
  const cash = spending(from, to);
  const meds = medicinesSoldCost(from, to);
  const dep = depreciation(from, to);

  /*
   * Outsourced work gets a line of its own, so it must leave the heading it
   * was booked under or the month is charged for it twice. Every cash row
   * carries how much of it was outsourced, and that part is netted off here
   * rather than subtracted from one heading afterwards — a referral-lab
   * payment can be booked against reagents or against other expenses, and
   * guessing which would double-count whichever one was guessed wrong.
   */
  const outBy = (line) => r2(cash
    .filter((c) => c.direction === 'out' && c.rule && c.rule.line === line)
    .reduce((t, c) => t + c.amount - c.outsourced, 0));

  const outsourced = r2(cash.filter((c) => c.direction === 'out')
    .reduce((t, c) => t + c.outsourced, 0));
  const refunds = r2(cash.filter((c) => c.direction === 'out' && c.category === 'Refund to patient')
    .reduce((t, c) => t + c.amount, 0));

  const billed = r2(Object.values(revenueByDepartment(from, to))
    .reduce((t, d) => t + d.revenue, 0));
  // Income that was never billed to a patient — a camp, rent received — is
  // still the clinic's revenue for the month.
  const otherIncome = r2(cash.filter((c) => c.direction === 'in'
    && !['Owner capital introduced', 'Sale of scrap or asset'].includes(c.category))
    .reduce((t, c) => t + c.amount, 0));

  const v = {
    netRevenue: r2(billed + otherIncome - refunds),
    medicinesConsumed: r2(meds.cost + outBy('medicinesConsumed')),
    doctorPayout: outBy('doctorPayout'),
    payroll: outBy('payroll'),
    outsourced,
    rentUtilities: outBy('rentUtilities'),
    maintenanceAdmin: outBy('maintenanceAdmin'),
    marketing: outBy('marketing'),
    depreciation: dep.amount,
    interest: outBy('interest'),
  };
  v.ebitda = r2(v.netRevenue - v.medicinesConsumed - v.doctorPayout - v.payroll
    - v.outsourced - v.rentUtilities - v.maintenanceAdmin - v.marketing);
  v.operatingProfit = r2(v.ebitda - v.depreciation);
  v.profitBeforeTax = r2(v.operatingProfit - v.interest);

  return { values: v, refunds, billed, otherIncome, meds, depreciation: dep,
    capital: r2(cash.filter((c) => c.direction === 'out'
      && c.rule && ['capital', 'stock', 'financing_capital'].includes(c.rule.nature))
      .reduce((t, c) => t + c.amount, 0)) };
}

/** Budget beside actual beside last month, line by line. */
function comparison(period) {
  const now = actuals(period);
  const before = actuals(prevPeriod(period));
  const budget = {};
  for (const b of db.prepare('SELECT line, amount FROM budgets WHERE period = ?').all(period)) {
    budget[b.line] = b.amount;
  }
  // A subtotal's budget is the arithmetic of the lines above it, not a
  // separate number somebody types — otherwise the statement can be made to
  // add up to whatever was hoped for.
  const budgeted = (k) => (budget[k] === undefined ? null : r2(budget[k]));
  const sumBudget = (keys) => {
    const vals = keys.map(budgeted);
    return vals.every((x) => x === null) ? null
      : r2(vals.reduce((t, x) => t + (x || 0), 0));
  };
  const costKeys = ['medicinesConsumed', 'doctorPayout', 'payroll', 'outsourced',
    'rentUtilities', 'maintenanceAdmin', 'marketing'];
  const bEbitda = budgeted('netRevenue') === null && sumBudget(costKeys) === null ? null
    : r2((budgeted('netRevenue') || 0) - (sumBudget(costKeys) || 0));
  const bOperating = bEbitda === null ? null : r2(bEbitda - (budgeted('depreciation') || 0));
  const bPbt = bOperating === null ? null : r2(bOperating - (budgeted('interest') || 0));
  const budgetOf = { ebitda: bEbitda, operatingProfit: bOperating, profitBeforeTax: bPbt };

  const rows = COMPARISON_LINES.map((l) => {
    const actual = now.values[l.key];
    const b = l.kind === 'subtotal' || l.kind === 'total' ? budgetOf[l.key] : budgeted(l.key);
    const previous = before.values[l.key];
    /*
     * "Difference" has to know which way is good. Spending less than budget
     * is favourable; earning less than budget is not, and a single signed
     * subtraction would colour half the table backwards.
     */
    const diff = b === null ? null : r2(actual - b);
    const favourable = diff === null ? null : (l.kind === 'cost' ? diff <= 0 : diff >= 0);
    return {
      key: l.key,
      label: l.label,
      kind: l.kind,
      budget: b,
      actual,
      difference: diff,
      differencePct: b ? pct(Math.abs(diff), Math.abs(b)) : null,
      previous,
      change: r2(actual - previous),
      favourable,
    };
  });

  return {
    period,
    previousPeriod: prevPeriod(period),
    rows,
    basis: {
      /*
       * Said out loud on the report, because the single most common way a
       * clinic's own profit statement misleads it is by charging the month
       * with what was bought instead of what was used.
       */
      medicines: 'Medicines are charged at the cost of the packs actually dispensed, from the batch each came from — not at what was purchased.',
      purchases: now.capital,
      purchasesNote: 'Stock and equipment bought in the period. Not a cost of the period; it belongs to the cash-flow report.',
      refunds: now.refunds,
      revenue: 'Revenue is what was earned and billed, net of discounts and refunds — not what was collected.',
      unpricedLines: now.meds.unpriced,
      depreciation: now.depreciation,
    },
  };
}

/* --------------------------------------------------------- 3. the indicators */

/** The ratios, each with the figures it was built from so it can be argued with. */
function indicators(from, to, period) {
  const board = departmentBoard(from, to);
  const cash = spending(from, to);
  const meds = medicinesSoldCost(from, to);
  // Net of outsourced work, for the same reason the comparison report is:
  // sending a biopsy to a referral lab is not reagent consumption.
  const out = (cat) => r2(cash.filter((c) => c.direction === 'out' && c.category === cat)
    .reduce((t, c) => t + c.amount - c.outsourced, 0));
  const outsourced = r2(cash.filter((c) => c.direction === 'out')
    .reduce((t, c) => t + c.outsourced, 0));

  const revenue = board.totals.revenue;
  const direct = board.totals.direct;
  const contribution = board.totals.contribution;
  const operating = board.totals.operatingProfit;

  const consultRevenue = (board.rows.find((r) => r.key === 'consultation') || {}).revenue || 0;
  const labRevenue = (board.rows.find((r) => r.key === 'laboratory') || {}).revenue || 0;
  const pharmRow = board.rows.find((r) => r.key === 'pharmacy') || { revenue: 0 };

  const list = [
    {
      key: 'directCost', label: 'Direct cost percentage',
      value: pct(direct, revenue), unit: '%',
      formula: 'Direct costs ÷ net revenue × 100',
      why: 'Catches treatment and service costs rising faster than the work.',
      of: [['Direct costs', direct], ['Net revenue', revenue]],
      good: 'lower',
    },
    {
      key: 'contribution', label: 'Contribution margin',
      value: pct(contribution, revenue), unit: '%',
      formula: '(Net revenue − direct costs) ÷ net revenue × 100',
      why: 'What is left to cover the rent, the salaries and everything else.',
      of: [['Contribution', contribution], ['Net revenue', revenue]],
      good: 'higher',
    },
    {
      key: 'operating', label: 'Operating profit margin',
      value: pct(operating, revenue), unit: '%',
      formula: 'Operating profit ÷ net revenue × 100',
      why: 'Whether the clinic as a whole is making money.',
      of: [['Operating profit', operating], ['Net revenue', revenue]],
      good: 'higher',
    },
    {
      key: 'payroll', label: 'Payroll-to-revenue ratio',
      value: pct(out('Salaries & wages'), revenue), unit: '%',
      formula: 'Employee payroll ÷ net revenue × 100',
      why: 'Whether the clinic can afford the people it has.',
      of: [['Payroll', out('Salaries & wages')], ['Net revenue', revenue]],
      good: 'lower',
    },
    {
      key: 'doctorPayout', label: 'Doctor payout ratio',
      value: pct(out('Doctor fees & honorarium'), consultRevenue), unit: '%',
      formula: 'Consultant payouts ÷ consultation revenue × 100',
      why: 'Whether the payout terms still work at the fees being charged.',
      of: [['Payouts', out('Doctor fees & honorarium')], ['Consultation revenue', consultRevenue]],
      good: 'lower',
    },
    {
      key: 'reagents', label: 'Lab reagent cost ratio',
      value: pct(out('Lab reagents & kits'), labRevenue), unit: '%',
      formula: 'Reagents ÷ net laboratory revenue × 100',
      why: 'Wastage, over-ordering, or tests priced below what they cost to run.',
      of: [['Reagents bought', out('Lab reagents & kits')], ['Lab revenue', labRevenue]],
      good: 'lower',
      caveat: 'Reagents are not stock-counted, so this is what was bought in the period, not what was used. In a month with a big delivery it will read high.'
        + (outsourced ? ` ${outsourced.toFixed(0)} of referral-lab work is counted on its own line, not here.` : ''),
    },
    {
      key: 'pharmacyMargin', label: 'Pharmacy gross margin',
      value: pct(pharmRow.revenue - meds.cost, pharmRow.revenue), unit: '%',
      formula: '(Net medicine sales − cost of medicines sold) ÷ net medicine sales × 100',
      why: 'The one margin in the clinic that is measured rather than estimated.',
      of: [['Medicine sales', pharmRow.revenue], ['Cost of those packs', r2(meds.cost)]],
      good: 'higher',
      caveat: meds.unpriced
        ? `${meds.unpriced} of ${meds.lines} lines came from a batch with no purchase price, so this margin reads better than it was.`
        : null,
    },
    {
      key: 'wastage', label: 'Expiry and wastage loss',
      value: board.wastage.total, unit: '₹',
      formula: 'Stock written off, at what it cost',
      why: 'The one cost here that is entirely avoidable.',
      of: [['Expired', board.wastage.expired], ['Written off or miscounted', board.wastage.adjusted]],
      good: 'lower',
      ofRevenue: pct(board.wastage.total, revenue),
    },
  ];

  if (period) {
    const c = comparison(period);
    const rev = c.rows.find((r) => r.key === 'netRevenue');
    const pbt = c.rows.find((r) => r.key === 'profitBeforeTax');
    list.push({
      key: 'variance', label: 'Budget variance',
      value: rev && rev.difference !== null ? rev.difference : null, unit: '₹',
      formula: 'Actual minus budget',
      why: 'Where the month went differently from the plan, and by how much.',
      of: [['Revenue against budget', rev ? rev.difference : null],
        ['Profit against budget', pbt ? pbt.difference : null]],
      good: 'higher',
      caveat: rev && rev.budget === null ? 'No budget has been set for this month yet.' : null,
    });
  }

  return list;
}

/* ---------------------------------------------------------- 4. break-even */

/**
 * The revenue the month has to reach before the clinic earns anything.
 *
 * Fixed costs divided by the contribution margin ratio — the share of every
 * rupee that survives the direct cost of earning it. A clinic below this line
 * is working for nothing, and the figure moves every time the margin does, so
 * it is worth recomputing rather than remembering.
 */
function breakEven(from, to) {
  const board = departmentBoard(from, to);
  const cash = spending(from, to);
  const dep = depreciation(from, to);

  const fixedRows = cash.filter((c) => c.direction === 'out' && c.rule
    && c.rule.nature === 'overhead' && c.rule.fixed);
  const fixed = r2(fixedRows.reduce((t, c) => t + c.amount, 0) + dep.amount);
  const variableOverhead = r2(cash.filter((c) => c.direction === 'out' && c.rule
    && c.rule.nature === 'overhead' && !c.rule.fixed)
    .reduce((t, c) => t + c.amount, 0));

  const revenue = board.totals.revenue;
  const ratio = revenue > 0 ? board.totals.contribution / revenue : 0;
  const required = ratio > 0 ? r2(fixed / ratio) : null;

  return {
    fixed,
    variableOverhead,
    depreciation: dep.amount,
    contributionRatio: pct(board.totals.contribution, revenue),
    revenue,
    required,
    surplus: required === null ? null : r2(revenue - required),
    coverage: required ? pct(revenue, required) : null,
    fixedRows: fixedRows.map((c) => ({ category: c.category, amount: c.amount }))
      .concat(dep.amount ? [{ category: 'Depreciation', amount: dep.amount }] : [])
      .sort((a, b) => b.amount - a.amount),
    note: 'Fixed costs are the headings that are there whether or not anybody walks in — rent, salaries, utilities, maintenance, licences and depreciation.',
  };
}

/**
 * Which departments are going the wrong way.
 *
 * Margin this period against margin last period, same length of window, so a
 * part-month is not compared against a whole one. Only a real move is
 * reported: a margin that wobbles by half a point is noise, and a dashboard
 * that cries about noise stops being read.
 */
const SLIP = 2;
function slipping(from, to) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const days = Math.max(Math.round((end - start) / 86400000) + 1, 1);
  const prevTo = new Date(start.getTime() - 86400000).toISOString().slice(0, 10);
  const prevFrom = new Date(start.getTime() - days * 86400000).toISOString().slice(0, 10);

  const now = departmentBoard(from, to).rows;
  const before = departmentBoard(prevFrom, prevTo).rows;
  return now.map((r) => {
    const was = before.find((b) => b.key === r.key);
    const previous = was ? was.margin : null;
    const move = r.margin !== null && previous !== null ? Math.round((r.margin - previous) * 10) / 10 : null;
    return { key: r.key, label: r.label, margin: r.margin, previous, move,
      revenue: r.revenue, previousRevenue: was ? was.revenue : null };
  }).filter((r) => r.move !== null && r.move <= -SLIP)
    .sort((a, b) => a.move - b.move);
}

module.exports = {
  DEPARTMENTS, DEPT_KEYS, COMPARISON_LINES, BUDGETABLE, COST_BOOK, DEFAULT_LIFE,
  revenueByDepartment, medicinesSoldCost, spending, wastage, depreciation,
  departmentBoard, actuals, comparison, indicators, breakEven, slipping,
  monthStart, monthEnd, prevPeriod,
};
