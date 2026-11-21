'use strict';
/**
 * The expense book, over the wire.
 *
 * Who does what, and why it is split this way.
 *
 * The counter books. Whoever handles the money knows what was bought and
 * from whom, and an expense book that only management can write to is one
 * that gets written up from a shoebox at the end of the month — which is
 * exactly the practice this replaces. So the cashier and the counsellor
 * enter bills and pay them.
 *
 * Management reads the whole. The totals by heading and department, what is
 * owed, what has no invoice against it: that is the picture the clinic is
 * run from, and it answers questions a counter is not handed.
 *
 * Management alone changes the headings. The reports total by them, so a
 * heading renamed or moved between groups changes every figure built on it,
 * and that is not a decision to make while a patient is waiting.
 */
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, badRequest } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { str, int, paging } = require('../lib/validate');
const audit = require('../lib/audit');
const expenses = require('../services/expenses');
const report = require('../services/expenseReport');
const book = require('../db/expenseBook');

const router = express.Router();

/** Who writes the book down. */
const entryRoles = requireRole('cashier', 'counselor');
/** Who reads it whole, and who changes its headings: the owner and the admin. */
const management = requireRole();

/*
 * The invoice itself is a photograph, so it arrives far larger than any
 * other request this ERP handles. A parser of its own keeps that allowance
 * on the one route that needs it rather than opening every other route to
 * an eight-megabyte body.
 */
const fileBody = express.json({ limit: '8mb' });
const MAX_FILE = 6 * 1024 * 1024;
const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

// ------------------------------------------------------------- the headings
/**
 * Everything the booking form needs, in one call: the headings with their
 * items, the departments, and the payment modes.
 */
router.get('/categories', requireRole('cashier', 'counselor'), wrap((req, res) => {
  const all = req.query.all === '1' || req.query.all === 'true';
  res.json({
    groups: expenses.categories({ includeInactive: all }),
    departments: book.DEPARTMENTS,
    natures: book.NATURES,
    modes: expenses.MODES,
    reportLines: require('../lib/commercial').COMPARISON_LINES
      .filter((l) => l.kind === 'cost').map((l) => ({ key: l.key, label: l.label })),
  });
}));

router.post('/categories', management, wrap((req, res) => {
  const row = expenses.createCategory(req.body || {}, req.user.id);
  audit.log(req, 'create', 'expense_category', row.id, { code: row.code, name: row.name });
  res.status(201).json(row);
}));

router.patch('/categories/:id', management, wrap((req, res) => {
  const id = int(req.params.id);
  const before = expenses.categoryById(id);
  if (!before) throw notFound('Expense heading not found');
  const row = expenses.updateCategory(id, req.body || {});
  audit.log(req, 'update', 'expense_category', id,
    { code: row.code, was: before.name, now: row.name, active: row.active });
  res.json(row);
}));

router.delete('/categories/:id', management, wrap((req, res) => {
  const id = int(req.params.id);
  const out = expenses.deleteCategory(id);
  audit.log(req, out.removed ? 'delete' : 'disable', 'expense_category', id, { name: out.name });
  res.json(out);
}));

router.post('/categories/:id/items', management, wrap((req, res) => {
  const row = expenses.createItem(int(req.params.id), req.body || {}, req.user.id);
  audit.log(req, 'create', 'expense_item', row.id, { name: row.name, categoryId: row.category_id });
  res.status(201).json(row);
}));

router.patch('/items/:id', management, wrap((req, res) => {
  const row = expenses.updateItem(int(req.params.id), req.body || {});
  audit.log(req, 'update', 'expense_item', row.id, { name: row.name, active: row.active });
  res.json(row);
}));

router.delete('/items/:id', management, wrap((req, res) => {
  const out = expenses.deleteItem(int(req.params.id));
  audit.log(req, out.removed ? 'delete' : 'disable', 'expense_item', int(req.params.id), { name: out.name });
  res.json(out);
}));

// --------------------------------------------------------------- the ledger
router.get('/', entryRoles, wrap((req, res) => {
  const { limit, page } = paging(req.query, 50);
  res.json(expenses.list({
    from: str(req.query.from), to: str(req.query.to),
    categoryId: req.query.categoryId, group: str(req.query.group),
    department: str(req.query.department), status: str(req.query.status),
    supplierId: req.query.supplierId, q: str(req.query.q),
    unpaidOnly: req.query.unpaidOnly === '1' || req.query.unpaidOnly === 'true',
    limit, page,
  }));
}));

/** What the clinic owes, oldest first. The list a Friday afternoon is spent on. */
router.get('/payable', entryRoles, wrap((_req, res) => res.json(expenses.payable())));

/**
 * The month, by heading and by department, with the year to date beside it.
 *
 * Management only: this is the figure the clinic is judged on, and the
 * payroll line alone tells a counter what their colleagues are paid.
 */
router.get('/report', management, wrap((req, res) => {
  const period = str(req.query.period) || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) throw badRequest('Give the month as YYYY-MM.');
  res.json(report.monthly(period));
}));

router.get('/:id', entryRoles, wrap((req, res) => res.json(expenses.detail(int(req.params.id)))));

router.post('/', entryRoles, wrap((req, res) => {
  const row = expenses.create(req.body || {}, req.user.id);
  audit.log(req, 'create', 'expense', row.id, {
    refNo: row.ref_no, category: row.category_code, department: row.department,
    total: row.total, paid: row.paid,
  });
  res.status(201).json(row);
}));

router.patch('/:id', entryRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const before = expenses.detail(id);
  const row = expenses.update(id, req.body || {});
  audit.log(req, 'update', 'expense', id, {
    refNo: row.ref_no,
    was: { category: before.category_code, total: before.total, department: before.department },
    now: { category: row.category_code, total: row.total, department: row.department },
  });
  res.json(row);
}));

router.post('/:id/payments', entryRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const row = expenses.pay(id, req.body || {}, req.user.id);
  audit.log(req, 'pay', 'expense', id,
    { refNo: row.ref_no, amount: req.body.amount, paid: row.paid, outstanding: row.outstanding });
  res.json(row);
}));

router.post('/payments/:id/void', entryRoles, wrap((req, res) => {
  const row = expenses.voidPayment(int(req.params.id), str(req.body.reason), req.user.id);
  audit.log(req, 'void_payment', 'expense', row.id,
    { refNo: row.ref_no, reason: str(req.body.reason) });
  res.json(row);
}));

/** Management signing a bill off. The counter books it; somebody approves it. */
router.post('/:id/approve', management, wrap((req, res) => {
  const row = expenses.approve(int(req.params.id), str(req.body.note), req.user.id);
  audit.log(req, 'approve', 'expense', row.id, { refNo: row.ref_no, total: row.total });
  res.json(row);
}));

router.post('/:id/void', entryRoles, wrap((req, res) => {
  const row = expenses.voidExpense(int(req.params.id), str(req.body.reason), req.user.id);
  audit.log(req, 'void', 'expense', row.id,
    { refNo: row.ref_no, total: row.total, reason: str(req.body.reason) });
  res.json(row);
}));

// ----------------------------------------------------------- the paperwork
/**
 * The invoice, photographed at the counter.
 *
 * Sent as a data URL because that is what a browser hands back from a file
 * input or a phone camera without a file-upload library, and this ERP has
 * four dependencies. The bytes are stored in the database: the container is
 * rebuilt on every deploy, so anything written beside the code is gone by
 * the next release, and a bill nobody can produce was never filed.
 */
router.post('/:id/attachments', entryRoles, fileBody, wrap((req, res) => {
  const id = int(req.params.id);
  const expense = expenses.detail(id);

  const data = String(req.body.data || '');
  const match = data.match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!match) throw badRequest('Attach the file itself — the photograph or the PDF of the bill.');
  const mime = match[1].toLowerCase();
  if (!FILE_TYPES.includes(mime)) {
    throw badRequest(`A ${mime} cannot be filed here. Attach a photograph or a PDF.`);
  }
  const content = Buffer.from(match[2], 'base64');
  if (!content.length) throw badRequest('That file is empty.');
  if (content.length > MAX_FILE) {
    throw badRequest(`That file is ${(content.length / 1048576).toFixed(1)} MB. `
      + `Photograph the bill again at a smaller size — up to ${MAX_FILE / 1048576} MB.`);
  }

  const kind = ['invoice', 'receipt', 'approval', 'other'].includes(str(req.body.kind))
    ? str(req.body.kind) : 'invoice';
  const filename = str(req.body.filename)
    || `${expense.ref_no}-${kind}.${mime === 'application/pdf' ? 'pdf' : mime.split('/')[1]}`;

  const info = db.prepare(
    `INSERT INTO expense_attachments (expense_id, kind, filename, mime, bytes, content, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, kind, filename, mime, content.length, content, req.user.id);

  audit.log(req, 'attach', 'expense', id, { refNo: expense.ref_no, kind, filename, bytes: content.length });
  res.status(201).json({ id: info.lastInsertRowid, kind, filename, mime, bytes: content.length });
}));

router.get('/attachments/:id', entryRoles, wrap((req, res) => {
  const row = db.prepare('SELECT * FROM expense_attachments WHERE id = ?').get(int(req.params.id));
  if (!row) throw notFound('Attachment not found');
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Content-Disposition', `inline; filename="${row.filename.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.end(row.content);
}));

router.delete('/attachments/:id', entryRoles, wrap((req, res) => {
  const row = db.prepare('SELECT * FROM expense_attachments WHERE id = ?').get(int(req.params.id));
  if (!row) throw notFound('Attachment not found');
  db.prepare('DELETE FROM expense_attachments WHERE id = ?').run(row.id);
  audit.log(req, 'detach', 'expense', row.expense_id, { filename: row.filename });
  res.json({ removed: true });
}));

module.exports = router;
