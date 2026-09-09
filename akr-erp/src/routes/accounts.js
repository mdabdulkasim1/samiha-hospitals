'use strict';
const express = require('express');
const { db, tx } = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const ids = require('../lib/ids');
const v = require('../lib/validate');
const { wrap, badRequest, notFound, conflict } = require('../lib/http');
const docs = require('../services/documents');
const pricing = require('../services/pricing');
const settlement = require('../services/settlement');
const enquiries = require('../services/enquiries');
const ledger = require('../services/ledger');
const notify = require('../services/notify');

const router = express.Router();
const bookkeeper = auth.requireRole('accounts');
const reader = auth.requireRole('accounts', 'kam');

/*
 * The money desk: what came in, what went out, what the group spent, and the
 * cheque book. One set of records for six companies, each entry owned by the
 * company that made it, so the group's position and each company's own can be
 * read off the same books.
 */

// ================================================================== payments
const PAY_SELECT = `
  SELECT p.*, pt.name AS partner_name, pt.code AS partner_code, c.code AS company_code,
         c.name AS company_name, u.name AS created_by_name,
         (p.amount - p.allocated) AS unapplied,
         pe.enquiry_no AS enquiry_no,
         ${enquiries.PAYMENT_ENQUIRIES_SQL} AS allocated_enquiries
    FROM payments p
    LEFT JOIN partners pt ON pt.id = p.partner_id
    LEFT JOIN enquiries pe ON pe.id = p.enquiry_id
    LEFT JOIN companies c ON c.id = p.company_id
    LEFT JOIN users u ON u.id = p.created_by`;

router.get('/payments', reader, wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 50);
  const where = [];
  const params = { limit, offset };
  if (req.query.direction) { where.push('p.direction = @direction'); params.direction = req.query.direction; }
  if (req.query.partner_id) { where.push('p.partner_id = @partner_id'); params.partner_id = req.query.partner_id; }
  if (req.query.status) { where.push('p.status = @status'); params.status = req.query.status; }
  if (req.query.mode) { where.push('p.mode = @mode'); params.mode = req.query.mode; }
  if (req.query.from) { where.push('p.payment_date >= @from'); params.from = v.date(req.query.from); }
  if (req.query.to) { where.push('p.payment_date <= @to'); params.to = v.date(req.query.to); }
  if (v.bool(req.query.unapplied)) where.push('p.amount - p.allocated > 0.005');
  if (req.query.q) {
    where.push('(p.payment_no LIKE @q OR p.reference LIKE @q OR p.cheque_no LIKE @q OR pt.name LIKE @q)');
    params.q = `%${String(req.query.q).trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({
    rows: db.prepare(`${PAY_SELECT} ${clause} ORDER BY p.payment_date DESC, p.id DESC LIMIT @limit OFFSET @offset`).all(params),
    total: db.prepare(`SELECT COUNT(*) AS c FROM payments p LEFT JOIN partners pt ON pt.id = p.partner_id ${clause}`).get(params).c,
    page, limit,
  });
}));

router.get('/payments/:id', reader, wrap(async (req, res) => {
  const row = db.prepare(`${PAY_SELECT} WHERE p.id = ?`).get(req.params.id);
  if (!row) throw notFound('No such payment.');
  const allocations = db.prepare('SELECT * FROM payment_allocations WHERE payment_id = ?').all(row.id)
    .map((a) => {
      const meta = settlement.TABLES[a.invoice_side];
      const inv = db.prepare(`SELECT * FROM ${meta.table} WHERE id = ?`).get(a.invoice_id);
      return { ...a, doc_no: inv ? inv[meta.noCol] : null, invoice_total: inv ? inv.total : null,
        invoice_date: inv ? inv.invoice_date : null,
        // Which job this part of the money belongs to.
        enquiry_no: enquiries.forInvoice(a.invoice_side, a.invoice_id) };
    });
  res.json({ payment: row, allocations, amountInWords: pricing.inWords(row.amount, row.currency) });
}));

/**
 * Record money moving.
 *
 * `direction: 'in'` is a receipt from a client, `'out'` a payment to a
 * manufacturer. Unless told otherwise it is applied to that partner's oldest
 * open invoices, which is what actually happens at the desk when a round
 * figure arrives "against our account".
 *
 * A cheque is entered on the day it is written and cleared on the day the
 * bank says so — until then it does not reduce anybody's balance, because a
 * cheque that has not cleared has not paid anything.
 */
router.post('/payments', bookkeeper, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['direction', 'amount']);
  const direction = v.oneOf(b.direction, ['in', 'out'], 'direction');
  const company = docs.companyFor(req, b);
  const amount = v.money(b.amount, 0);
  if (amount <= 0) throw badRequest('A payment needs an amount.');

  const partner = b.partner_id ? db.prepare('SELECT * FROM partners WHERE id = ?').get(b.partner_id) : null;
  if (b.partner_id && !partner) throw notFound('No such account.');

  const mode = v.oneOf(b.mode, ['cash', 'cheque', 'bank_transfer', 'card', 'lc', 'adjustment'], 'mode')
    || 'bank_transfer';
  if (mode === 'cheque') v.required(b, ['cheque_no']);

  /*
   * A post-dated cheque is pending until its date comes round. Treating it as
   * cleared on the day it is handed over would show money the company does not
   * have, which is precisely the mistake a cheque register exists to prevent.
   */
  const kind = v.oneOf(b.kind, ['advance', 'settlement', 'refund'], 'kind') || 'settlement';
  const chequeDate = v.date(b.cheque_date);
  const defaultStatus = mode === 'cheque'
    ? (chequeDate && chequeDate > v.today() ? 'pending' : 'deposited')
    : 'cleared';

  /*
   * An advance goes out before there is any invoice to attach it to, so the
   * voucher can be told which enquiry it belongs to. Where it settles invoices,
   * their own enquiries are what the voucher carries and this stays empty.
   */
  let enquiryId = null;
  if (b.enquiry_id) {
    const e = enquiries.get(b.enquiry_id, direction === 'out' ? 'supplier' : 'client');
    if (!e) throw notFound('No such enquiry.');
    enquiryId = e.id;
  }

  const result = tx(() => {
    const paymentNo = ids.docNo(direction === 'in' ? 'receipt' : 'payment', company.code);
    const info = db.prepare(`
      INSERT INTO payments (company_id, payment_no, direction, partner_id, enquiry_id, payment_date,
        mode, amount, currency, reference, bank_name, cheque_no, cheque_date, status, kind, notes,
        created_by)
      VALUES (@company_id, @payment_no, @direction, @partner_id, @enquiry_id, @payment_date, @mode,
        @amount, @currency, @reference, @bank_name, @cheque_no, @cheque_date, @status, @kind, @notes,
        @created_by)`).run({
      company_id: company.id,
      payment_no: paymentNo,
      direction,
      partner_id: partner ? partner.id : null,
      enquiry_id: enquiryId,
      payment_date: v.date(b.payment_date) || v.today(),
      mode,
      amount,
      currency: v.str(b.currency, company.currency || 'AED'),
      reference: v.str(b.reference),
      bank_name: v.str(b.bank_name),
      cheque_no: v.str(b.cheque_no),
      cheque_date: chequeDate,
      status: v.oneOf(b.status, ['pending', 'deposited', 'cleared', 'bounced', 'cancelled'], 'status')
        || defaultStatus,
      kind,
      notes: v.str(b.notes),
      created_by: req.user.id,
    });
    return { id: info.lastInsertRowid, paymentNo };
  })();

  // Apply it: to the invoices named, or to the oldest open ones.
  let applied = null;
  if (Array.isArray(b.allocations) && b.allocations.length) {
    settlement.allocate(result.id, b.allocations);
    applied = { allocated: settlement.refreshForPayment(result.id) };
  } else if (partner && v.bool(b.autoAllocate, kind !== 'advance')) {
    // A round figure "against our account" is applied to the oldest open
    // invoices, which is what the desk means by it. An advance is not that: it
    // is money paid ahead of any invoice, for a job somebody has named, and
    // swallowing it into an older bill is how an advance stops being one.
    applied = settlement.autoAllocate(result.id);
  }

  // An advance against an order is what releases that order for delivery.
  if (b.sales_order_id) {
    const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(b.sales_order_id);
    if (order) {
      db.prepare('UPDATE sales_orders SET advance_received = advance_received + ? WHERE id = ?')
        .run(amount, order.id);
      notify.toRole('logistics', {
        title: `Advance received on ${order.so_no}`,
        body: `${amount.toFixed(2)} received. Check whether the order can now be released.`,
        route: `#/sales-orders?id=${order.id}`,
      });
    }
  }

  audit.log(req, direction === 'in' ? 'receipt.created' : 'payment.created', 'payment', result.id,
    { paymentNo: result.paymentNo, amount, mode, partner: partner ? partner.name : null });
  res.status(201).json({
    ...db.prepare(`${PAY_SELECT} WHERE p.id = ?`).get(result.id),
    applied,
  });
}));

/** Allocate, or re-allocate, a payment across invoices by hand. */
router.post('/payments/:id/allocate', bookkeeper, wrap(async (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) throw notFound('No such payment.');
  const allocations = Array.isArray(req.body.allocations) ? req.body.allocations : [];
  if (!allocations.length) {
    const result = settlement.autoAllocate(payment.id);
    audit.log(req, 'payment.auto_allocated', 'payment', payment.id, result);
    return res.json(result);
  }
  const allocated = settlement.allocate(payment.id, allocations);
  audit.log(req, 'payment.allocated', 'payment', payment.id, { allocated });
  res.json({ allocated, unapplied: pricing.round(payment.amount - allocated) });
}));

/**
 * A cheque's life: pending, deposited, cleared — or bounced.
 *
 * A bounce is not a deletion. The cheque was written, it was banked, and it
 * came back; the record stays and its allocations stop counting, so the
 * invoices it was covering go back to being unpaid and the client's balance
 * tells the truth again.
 */
router.post('/payments/:id/status', bookkeeper, wrap(async (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) throw notFound('No such payment.');
  const status = v.oneOf(req.body.status, ['pending', 'deposited', 'cleared', 'bounced', 'cancelled'], 'status');
  if (!status) throw badRequest('Say what has happened to it.');
  if (status === 'bounced' && !v.str(req.body.notes)) {
    throw badRequest('Record why it bounced — the client will ask.');
  }

  tx(() => {
    db.prepare('UPDATE payments SET status = ?, notes = COALESCE(?, notes) WHERE id = ?')
      .run(status, v.str(req.body.notes), payment.id);
    settlement.refreshForPayment(payment.id);
  })();

  if (status === 'bounced' && payment.partner_id) {
    notify.toRole('kam', {
      title: `Cheque returned — ${payment.payment_no}`,
      body: `${payment.cheque_no || ''} for ${pricing.round(payment.amount).toFixed(2)} has bounced.`.trim(),
      route: `#/payments?id=${payment.id}`,
    });
  }
  audit.log(req, 'payment.status', 'payment', payment.id, { from: payment.status, to: status });
  res.json({ ok: true, status });
}));

/**
 * The cheque register — every cheque written or received, with the ones
 * falling due first. Post-dated cheques are the ordinary way business is done
 * here, and a company that loses track of them is a company that bounces one.
 */
router.get('/cheques', reader, wrap(async (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.payment_no, p.direction, p.cheque_no, p.cheque_date, p.bank_name, p.amount,
           p.status, p.payment_date, pt.name AS partner_name, c.code AS company_code
      FROM payments p
      LEFT JOIN partners pt ON pt.id = p.partner_id
      LEFT JOIN companies c ON c.id = p.company_id
     WHERE p.mode = 'cheque' AND p.status != 'cancelled'
     ORDER BY CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END, p.cheque_date, p.id DESC`).all();
  const pending = rows.filter((r) => r.status === 'pending');
  res.json({
    rows,
    summary: {
      incoming_pending: pricing.round(pending.filter((r) => r.direction === 'in')
        .reduce((a, r) => a + r.amount, 0)),
      outgoing_pending: pricing.round(pending.filter((r) => r.direction === 'out')
        .reduce((a, r) => a + r.amount, 0)),
      due_this_week: pending.filter((r) => r.cheque_date && r.cheque_date <= v.addDays(v.today(), 7)).length,
      bounced: rows.filter((r) => r.status === 'bounced').length,
    },
  });
}));

// ============================================== the group's income & expenses
const EXP_SELECT = `
  SELECT e.*, c.code AS company_code, c.name AS company_name, ec.name AS category_name,
         ec.kind AS category_kind, p.name AS partner_name, u.name AS created_by_name
    FROM expenses e
    LEFT JOIN companies c ON c.id = e.company_id
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    LEFT JOIN partners p ON p.id = e.partner_id
    LEFT JOIN users u ON u.id = e.created_by`;

router.get('/expenses', reader, wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 50);
  const where = [];
  const params = { limit, offset };
  if (req.query.kind) { where.push('e.kind = @kind'); params.kind = req.query.kind; }
  if (req.query.company_id) { where.push('e.company_id = @company_id'); params.company_id = req.query.company_id; }
  if (req.query.category_id) { where.push('e.category_id = @category_id'); params.category_id = req.query.category_id; }
  if (req.query.from) { where.push('e.expense_date >= @from'); params.from = v.date(req.query.from); }
  if (req.query.to) { where.push('e.expense_date <= @to'); params.to = v.date(req.query.to); }
  if (req.query.q) {
    where.push('(e.voucher_no LIKE @q OR e.description LIKE @q OR e.payee LIKE @q OR e.project LIKE @q)');
    params.q = `%${String(req.query.q).trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`${EXP_SELECT} ${clause} ORDER BY e.expense_date DESC, e.id DESC LIMIT @limit OFFSET @offset`)
    .all(params);
  const summary = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN e.kind = 'expense' THEN e.total END), 0) AS spent,
           COALESCE(SUM(CASE WHEN e.kind = 'income'  THEN e.total END), 0) AS earned,
           COALESCE(SUM(CASE WHEN e.kind = 'expense' THEN e.vat_amount END), 0) AS input_vat
      FROM expenses e ${clause}`).get(params);
  res.json({ rows, summary, total: rows.length, page, limit });
}));

/**
 * Anything the group spends or takes in that is not a trade invoice — rent,
 * salaries, fuel, the trade licence, transport recharged to a client. Six
 * companies' overheads in one book, each row owned by the company that paid.
 */
router.post('/expenses', bookkeeper, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['description', 'amount']);
  const company = docs.companyFor(req, b);
  const kind = v.oneOf(b.kind, ['expense', 'income'], 'kind') || 'expense';
  const amount = v.money(b.amount, 0);
  if (amount <= 0) throw badRequest('An entry needs an amount.');

  // VAT may be given, or worked out at the standard rate when the entry says
  // it is taxable.
  const vatAmount = b.vat_amount !== undefined
    ? v.money(b.vat_amount, 0)
    : (v.bool(b.taxable) ? pricing.round(amount * (require('../config').vat.percent / 100)) : 0);

  const voucherNo = ids.docNo(kind === 'income' ? 'income' : 'expense', company.code);
  const info = db.prepare(`
    INSERT INTO expenses (company_id, voucher_no, kind, category_id, partner_id, payee, expense_date,
      description, project, amount, vat_amount, total, recoverable_vat, mode, reference,
      attachment_ref, created_by)
    VALUES (@company_id, @voucher_no, @kind, @category_id, @partner_id, @payee, @expense_date,
      @description, @project, @amount, @vat_amount, @total, @recoverable_vat, @mode, @reference,
      @attachment_ref, @created_by)`).run({
    company_id: company.id,
    voucher_no: voucherNo,
    kind,
    category_id: b.category_id || null,
    partner_id: b.partner_id || null,
    payee: v.str(b.payee),
    expense_date: v.date(b.expense_date) || v.today(),
    description: v.str(b.description),
    project: v.str(b.project),
    amount,
    vat_amount: vatAmount,
    total: pricing.round(amount + vatAmount),
    recoverable_vat: v.bool(b.recoverable_vat, true) ? 1 : 0,
    mode: v.oneOf(b.mode, ['cash', 'cheque', 'bank_transfer', 'card', 'petty_cash'], 'mode') || 'cash',
    reference: v.str(b.reference),
    attachment_ref: v.str(b.attachment_ref),
    created_by: req.user.id,
  });

  audit.log(req, `${kind}.created`, 'expense', info.lastInsertRowid, { voucherNo, amount });
  res.status(201).json(db.prepare(`${EXP_SELECT} WHERE e.id = ?`).get(info.lastInsertRowid));
}));

router.patch('/expenses/:id', bookkeeper, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such entry.');
  const amount = v.money(req.body.amount, row.amount);
  const vatAmount = v.money(req.body.vat_amount, row.vat_amount);
  db.prepare(`UPDATE expenses SET category_id = @category_id, partner_id = @partner_id, payee = @payee,
      expense_date = @expense_date, description = @description, project = @project, amount = @amount,
      vat_amount = @vat_amount, total = @total, recoverable_vat = @recoverable_vat, mode = @mode,
      reference = @reference, attachment_ref = @attachment_ref WHERE id = @id`).run({
    id: row.id,
    category_id: req.body.category_id === undefined ? row.category_id : (req.body.category_id || null),
    partner_id: req.body.partner_id === undefined ? row.partner_id : (req.body.partner_id || null),
    payee: v.str(req.body.payee, row.payee),
    expense_date: v.date(req.body.expense_date) || row.expense_date,
    description: v.str(req.body.description, row.description),
    project: v.str(req.body.project, row.project),
    amount,
    vat_amount: vatAmount,
    total: pricing.round(amount + vatAmount),
    recoverable_vat: req.body.recoverable_vat === undefined
      ? row.recoverable_vat : (v.bool(req.body.recoverable_vat) ? 1 : 0),
    mode: v.oneOf(req.body.mode, ['cash', 'cheque', 'bank_transfer', 'card', 'petty_cash'], 'mode') || row.mode,
    reference: v.str(req.body.reference, row.reference),
    attachment_ref: v.str(req.body.attachment_ref, row.attachment_ref),
  });
  audit.log(req, 'expense.updated', 'expense', row.id, { voucherNo: row.voucher_no });
  res.json(db.prepare(`${EXP_SELECT} WHERE e.id = ?`).get(row.id));
}));

router.delete('/expenses/:id', bookkeeper, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such entry.');
  db.prepare('DELETE FROM expenses WHERE id = ?').run(row.id);
  audit.log(req, 'expense.deleted', 'expense', row.id, { voucherNo: row.voucher_no, total: row.total });
  res.json({ ok: true });
}));

// ================================================================== the books
router.get('/ageing/:side', reader, wrap(async (req, res) => {
  const side = v.oneOf(req.params.side, ['receivable', 'payable'], 'side');
  res.json(ledger.ageing(side, {
    companyId: req.query.company_id || null,
    asOf: v.date(req.query.asOf),
    partnerId: req.query.partner_id || null,
  }));
}));

/*
 * The VAT return and the profit are an administrator's, by the company's own
 * decision — they are the two figures that say what the business made and what
 * it owes, and they are not part of running a desk.
 */
const owner = auth.requireRole('admin');

router.get('/vat-return', owner, wrap(async (req, res) => {
  const to = v.date(req.query.to) || v.today();
  const from = v.date(req.query.from) || v.addDays(to, -89);
  res.json(ledger.vatReturn({ companyId: req.query.company_id || null, from, to }));
}));

router.get('/profit-and-loss', owner, wrap(async (req, res) => {
  const to = v.date(req.query.to) || v.today();
  const from = v.date(req.query.from) || `${to.slice(0, 4)}-01-01`;
  const companyId = req.query.company_id || null;
  res.json({
    ...ledger.profitAndLoss({ from, to, companyId }),
    // Month by month, because the overheads are booked a month at a time and
    // the figure that matters is what is left after that month's are in.
    monthly: ledger.monthlyProfit({ from, to, companyId }),
    // And the two sides by name: which clients the revenue came from, and what
    // each manufacturer cost us.
    clients: ledger.byClient({ from, to, companyId }),
    suppliers: ledger.bySupplier({ from, to, companyId }),
  });
}));

/** Open invoices on one side, for a payment or a collection run. */
router.get('/open-invoices', reader, wrap(async (req, res) => {
  const side = v.oneOf(req.query.side, ['sales', 'purchase'], 'side') || 'sales';
  const meta = settlement.TABLES[side];
  const where = ["i.status NOT IN ('cancelled','paid')", 'i.total - i.paid_amount > 0.005'];
  const params = {};
  if (req.query.partner_id) { where.push('i.partner_id = @partner_id'); params.partner_id = req.query.partner_id; }
  res.json({
    side,
    rows: db.prepare(`
      SELECT i.id, i.${meta.noCol} AS doc_no, i.invoice_date, i.due_date, i.total, i.paid_amount,
             (i.total - i.paid_amount) AS outstanding, p.name AS partner_name, i.partner_id
        FROM ${meta.table} i JOIN partners p ON p.id = i.partner_id
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(i.due_date, i.invoice_date), i.id`).all(params),
  });
}));

module.exports = router;
