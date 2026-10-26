'use strict';
/**
 * The clinic's own money: what it spends, and what it takes in that no patient
 * was billed for.
 *
 * Two jobs, and deliberately two different sets of people.
 *
 * Writing the book down is the cashier's, the counsellor's and the
 * administrator's. Somebody has to enter the rent, the salaries, the
 * electricity bill and the cash paid to a supplier at the door, and the person
 * who handles the money is usually the person who knows what left the drawer.
 *
 * Reading the book as a whole is not. The overview — day by day, week by week,
 * what came in against what went out, which category is eating the month — is
 * the administrator's and the financial counsellor's, because that is the
 * picture a clinic is run from, and it answers questions ("can we afford
 * this", "are we losing money") that are not a counter's to be handed.
 *
 * The split is enforced here, on the server, not by leaving a chart off a
 * screen: the summary endpoint refuses the cashier outright.
 */
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, badRequest, conflict } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, money, oneOf, paging } = require('../lib/validate');
const { generate } = require('../lib/ids');
const audit = require('../lib/audit');

const router = express.Router();

/** Who may write the book down. */
const entryRoles = requireRole('cashier', 'counselor');
/** Who may read it as a whole. */
const overviewRoles = requireRole('counselor');

const today = () => new Date().toISOString().slice(0, 10);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/*
 * The headings a clinic's money actually falls under.
 *
 * A fixed list rather than a free-text box, because the whole point of the
 * overview is to total by heading, and "Electricity", "electricity bill" and
 * "EB" typed on three different days are three headings that add up to
 * nothing. "Other" is there so that nothing has to be forced into a box it
 * does not fit, and a note explains the one-off.
 */
const CATEGORIES = {
  out: [
    'Salaries & wages',
    'Doctor fees & honorarium',
    'Rent',
    'Electricity & water',
    'Medicines & consumables',
    'Lab reagents & kits',
    'Equipment purchase',
    'Equipment maintenance',
    'Housekeeping & security',
    'Printing & stationery',
    'Telephone & internet',
    'Marketing & camps',
    'Travel & conveyance',
    'Professional & audit fees',
    'Licences, taxes & insurance',
    'Bank charges & interest',
    'Loan repayment',
    'Refund to patient',
    'Other expense',
  ],
  in: [
    'Other clinical income',
    'Health camp collection',
    'Rent received',
    'Interest received',
    'Grant or donation',
    'Owner capital introduced',
    'Insurance or TPA settlement',
    'Sale of scrap or asset',
    'Other income',
  ],
};

const MODES = ['cash', 'card', 'upi', 'netbanking', 'cheque', 'other'];

const SELECT = `
  SELECT c.*, u.name AS entered_by_name, v.name AS voided_by_name, s.name AS supplier_name
    FROM cash_book c
    LEFT JOIN users u ON u.id = c.created_by
    LEFT JOIN users v ON v.id = c.voided_by
    LEFT JOIN suppliers s ON s.id = c.supplier_id`;

const one = (id) => db.prepare(`${SELECT} WHERE c.id = ?`).get(id);

/** The headings and payment modes the entry form offers. */
router.get('/categories', entryRoles, wrap((req, res) => {
  res.json({ categories: CATEGORIES, modes: MODES });
}));

// ------------------------------------------------------------- the cash book
router.get('/entries', entryRoles, wrap((req, res) => {
  const from = str(req.query.from) || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const to = str(req.query.to) || today();
  const direction = oneOf(req.query.direction, ['in', 'out'], 'direction');
  const category = str(req.query.category);
  const q = str(req.query.q, '');
  const { limit, offset, page } = paging(req.query, 50);

  const clauses = ['date(c.entry_date) BETWEEN date(?) AND date(?)'];
  const params = [from, to];
  if (direction) { clauses.push('c.direction = ?'); params.push(direction); }
  if (category) { clauses.push('c.category = ?'); params.push(category); }
  if (q) {
    clauses.push(`(c.ref_no LIKE ? OR c.payee LIKE ? OR c.reference LIKE ? OR c.notes LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const rows = db.prepare(
    `${SELECT} ${where} ORDER BY date(c.entry_date) DESC, c.id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  // A voided line is shown struck through rather than hidden, and counts for
  // nothing — including in these totals.
  const totals = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN c.direction = 'in' THEN c.amount END), 0) AS money_in,
            COALESCE(SUM(CASE WHEN c.direction = 'out' THEN c.amount END), 0) AS money_out,
            COUNT(*) AS entries
       FROM cash_book c ${where} AND c.voided_at IS NULL`
  ).get(...params);

  res.json({
    from, to, page, limit, rows,
    total: db.prepare(`SELECT COUNT(*) AS c FROM cash_book c ${where}`).get(...params).c,
    totals: { ...totals, net: round2(totals.money_in - totals.money_out) },
  });
}));

router.post('/entries', entryRoles, wrap((req, res) => {
  required(req.body, ['direction', 'category', 'amount']);
  const direction = oneOf(req.body.direction, ['in', 'out'], 'direction');
  const amount = money(req.body.amount);
  if (!(amount > 0)) throw badRequest('An amount has to be more than nothing.');

  const category = str(req.body.category);
  if (!CATEGORIES[direction].includes(category)) {
    throw badRequest(`"${category}" is not one of the headings for money ${direction === 'in' ? 'in' : 'out'}.`,
      { categories: CATEGORIES[direction] });
  }

  /*
   * A date is allowed to be in the past — a bill paid last Tuesday is entered
   * on Thursday and belongs to Tuesday — but never in the future. Money that
   * has not moved yet is not a cash book entry, and a figure dated forward
   * quietly distorts every total it lands in until that day arrives.
   */
  const entryDate = str(req.body.entryDate) || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw badRequest('Give the date as YYYY-MM-DD.');
  if (entryDate > today()) throw badRequest('A cash book entry cannot be dated in the future.');

  const refNo = generate('cashEntry');
  const info = db.prepare(
    `INSERT INTO cash_book (ref_no, direction, category, amount, entry_date, mode,
                            payee, reference, notes, supplier_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(refNo, direction, category, amount, entryDate,
        oneOf(req.body.mode, MODES, 'mode') || 'cash',
        str(req.body.payee), str(req.body.reference), str(req.body.notes),
        req.body.supplierId ? int(req.body.supplierId) : null, req.user.id);

  audit.log(req, 'cash_entry', 'cash_book', info.lastInsertRowid,
    { refNo, direction, category, amount, entryDate });
  res.status(201).json(one(info.lastInsertRowid));
}));

/** Correcting an entry — the figures and the headings, never who wrote it. */
router.patch('/entries/:id', entryRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const row = db.prepare('SELECT * FROM cash_book WHERE id = ?').get(id);
  if (!row) throw notFound('Cash book entry not found');
  if (row.voided_at) throw conflict('That entry has been voided. Enter a new one instead.');

  const direction = req.body.direction === undefined
    ? row.direction : oneOf(req.body.direction, ['in', 'out'], 'direction');
  const category = req.body.category === undefined ? row.category : str(req.body.category);
  if (!CATEGORIES[direction].includes(category)) {
    throw badRequest(`"${category}" is not one of the headings for money ${direction === 'in' ? 'in' : 'out'}.`);
  }
  const amount = req.body.amount === undefined ? row.amount : money(req.body.amount);
  if (!(amount > 0)) throw badRequest('An amount has to be more than nothing.');
  const entryDate = req.body.entryDate === undefined ? row.entry_date : str(req.body.entryDate);
  if (entryDate > today()) throw badRequest('A cash book entry cannot be dated in the future.');

  db.prepare(
    `UPDATE cash_book SET direction = ?, category = ?, amount = ?, entry_date = ?, mode = ?,
            payee = ?, reference = ?, notes = ?, supplier_id = ?
      WHERE id = ?`
  ).run(direction, category, amount, entryDate,
        req.body.mode === undefined ? row.mode : (oneOf(req.body.mode, MODES, 'mode') || row.mode),
        req.body.payee === undefined ? row.payee : str(req.body.payee),
        req.body.reference === undefined ? row.reference : str(req.body.reference),
        req.body.notes === undefined ? row.notes : str(req.body.notes),
        req.body.supplierId === undefined ? row.supplier_id
          : (req.body.supplierId ? int(req.body.supplierId) : null),
        id);

  // What it was before, so a correction can be read as a correction.
  audit.log(req, 'cash_entry_edit', 'cash_book', id, {
    refNo: row.ref_no,
    was: { direction: row.direction, category: row.category, amount: row.amount, date: row.entry_date },
    now: { direction, category, amount, date: entryDate },
  });
  res.json(one(id));
}));

/**
 * Voiding, which is the only way a line leaves the totals.
 *
 * Not deletion. A cash book that can lose a row cannot be reconciled against
 * anything, and "that one was a mistake" is itself a fact the clinic may need
 * to produce later — with the reason, and the name of whoever decided it.
 */
router.post('/entries/:id/void', entryRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const row = db.prepare('SELECT * FROM cash_book WHERE id = ?').get(id);
  if (!row) throw notFound('Cash book entry not found');
  if (row.voided_at) throw conflict('That entry is already voided.');
  const reason = str(req.body.reason);
  if (!reason) throw badRequest('Say why the entry is being voided.');

  db.prepare(
    "UPDATE cash_book SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ?"
  ).run(req.user.id, reason, id);

  audit.log(req, 'cash_entry_void', 'cash_book', id,
    { refNo: row.ref_no, amount: row.amount, reason });
  res.json(one(id));
}));

// ---------------------------------------------------------------- the picture
/*
 * What the clinic took, against what it spent.
 *
 * Money in is counted from where it already sits rather than from anything
 * retyped here: `payments` is every rupee a billed patient handed over, and a
 * pharmacy counter sale is money taken without an invoice ever being raised,
 * so it is added separately and would otherwise be missed. Entries in the cash
 * book marked "in" are the rest — a camp collection, rent received, a grant —
 * and they are kept as their own line so it is always visible how much of the
 * month was clinical work and how much was not.
 */
const takingsBetween = (from, to) => ({
  billed: db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE date(paid_at) BETWEEN date(?) AND date(?)'
  ).get(from, to).s,
  counter: db.prepare(
    `SELECT COALESCE(SUM(paid_amount), 0) AS s FROM pharmacy_sales
      WHERE sale_type = 'counter' AND status != 'cancelled'
        AND date(created_at) BETWEEN date(?) AND date(?)`
  ).get(from, to).s,
});

/** The day, or the week it falls in, as one label the whole series sorts by. */
const bucketExpr = (by, column) => (by === 'week'
  // Monday-start weeks: a clinic's week runs Monday to Sunday, and a Sunday
  // OPD belongs to the week it finished, not the one about to start.
  ? `date(${column}, 'weekday 1', '-7 days')`
  : `date(${column})`);

router.get('/summary', overviewRoles, wrap((req, res) => {
  const by = oneOf(req.query.by, ['day', 'week'], 'by') || 'day';
  const to = str(req.query.to) || today();
  const from = str(req.query.from)
    || new Date(Date.now() - (by === 'week' ? 83 : 29) * 86400000).toISOString().slice(0, 10);

  const series = new Map();
  const at = (key) => {
    if (!series.has(key)) {
      series.set(key, { at: key, billed: 0, counter: 0, otherIncome: 0, expense: 0 });
    }
    return series.get(key);
  };

  for (const r of db.prepare(
    `SELECT ${bucketExpr(by, 'paid_at')} AS at, COALESCE(SUM(amount), 0) AS s
       FROM payments WHERE date(paid_at) BETWEEN date(?) AND date(?) GROUP BY at`
  ).all(from, to)) at(r.at).billed = round2(r.s);

  for (const r of db.prepare(
    `SELECT ${bucketExpr(by, 'created_at')} AS at, COALESCE(SUM(paid_amount), 0) AS s
       FROM pharmacy_sales
      WHERE sale_type = 'counter' AND status != 'cancelled'
        AND date(created_at) BETWEEN date(?) AND date(?) GROUP BY at`
  ).all(from, to)) at(r.at).counter = round2(r.s);

  for (const r of db.prepare(
    `SELECT ${bucketExpr(by, 'entry_date')} AS at, direction, COALESCE(SUM(amount), 0) AS s
       FROM cash_book
      WHERE voided_at IS NULL AND date(entry_date) BETWEEN date(?) AND date(?)
      GROUP BY at, direction`
  ).all(from, to)) {
    if (r.direction === 'in') at(r.at).otherIncome = round2(r.s);
    else at(r.at).expense = round2(r.s);
  }

  const points = [...series.values()]
    .map((p) => {
      const income = round2(p.billed + p.counter + p.otherIncome);
      return { ...p, income, net: round2(income - p.expense) };
    })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const takings = takingsBetween(from, to);
  const spend = db.prepare(
    `SELECT category, COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS amount
       FROM cash_book
      WHERE direction = 'out' AND voided_at IS NULL
        AND date(entry_date) BETWEEN date(?) AND date(?)
      GROUP BY category ORDER BY amount DESC`
  ).all(from, to);
  const otherIncome = db.prepare(
    `SELECT category, COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS amount
       FROM cash_book
      WHERE direction = 'in' AND voided_at IS NULL
        AND date(entry_date) BETWEEN date(?) AND date(?)
      GROUP BY category ORDER BY amount DESC`
  ).all(from, to);

  const income = round2(takings.billed + takings.counter
    + otherIncome.reduce((t, r) => t + r.amount, 0));
  const expense = round2(spend.reduce((t, r) => t + r.amount, 0));

  res.json({
    from, to, by, points, spend, otherIncome,
    totals: {
      billed: round2(takings.billed),
      counter: round2(takings.counter),
      otherIncome: round2(otherIncome.reduce((t, r) => t + r.amount, 0)),
      income,
      expense,
      net: round2(income - expense),
      // What is still owed is not cash flow, but it is the first thing anybody
      // asks when the net looks thin.
      outstanding: db.prepare(
        "SELECT COALESCE(SUM(balance), 0) AS s FROM invoices WHERE status IN ('unpaid','partial')"
      ).get().s,
    },
  });
}));

module.exports = router;
