'use strict';
const express = require('express');
const { db } = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const ids = require('../lib/ids');
const v = require('../lib/validate');
const { wrap, badRequest, notFound } = require('../lib/http');

const router = express.Router();
router.use(auth.requireRole('admin'));

const ROLES = ['admin', 'kam', 'accounts', 'sales', 'logistics'];

/** What each desk is for, so the screen can explain itself. */
const ROLE_NOTES = {
  admin: 'Everything, plus staff, companies and the audit trail.',
  kam: 'Key account manager — supplier quotations, price confirmation, LPOs, client accounts and margins.',
  accounts: 'Invoices both ways, payments, cheques, expenses, VAT and the ledgers.',
  sales: 'Enquiries, quotations to clients and their LPOs. Prices, but not costs or the books.',
  logistics: 'Goods receipts, deliveries and the stock register. Quantities, not money.',
};

router.get('/users', wrap(async (_req, res) => {
  res.json({
    rows: db.prepare(`
      SELECT u.id, u.staff_code, u.name, u.email, u.phone, u.role, u.designation, u.active,
             u.last_login_at, u.created_at, c.name AS company_name, c.code AS company_code
        FROM users u LEFT JOIN companies c ON c.id = u.company_id
       ORDER BY u.active DESC, u.name`).all(),
    roles: ROLES.map((r) => ({ value: r, note: ROLE_NOTES[r] })),
  });
}));

router.post('/users', wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['name', 'email', 'role', 'password']);
  const role = v.oneOf(b.role, ROLES, 'role');
  const problems = auth.passwordProblems(b.password);
  if (problems.length) throw badRequest(`A password must ${problems.join(', ')}.`);

  const info = db.prepare(`
    INSERT INTO users (staff_code, name, email, phone, password_hash, role, company_id, designation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    v.str(b.staff_code) || ids.staffCode(), v.str(b.name), String(b.email).trim().toLowerCase(),
    v.str(b.phone), auth.hashPassword(b.password), role, b.company_id || null, v.str(b.designation));
  audit.log(req, 'user.created', 'user', info.lastInsertRowid, { email: b.email, role });
  res.status(201).json(db.prepare('SELECT id, staff_code, name, email, role, active FROM users WHERE id = ?')
    .get(info.lastInsertRowid));
}));

router.patch('/users/:id', wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such user.');
  const b = req.body;

  // Locking yourself out of the only administrator account is not recoverable
  // from inside the application.
  if (row.id === req.user.id && b.active !== undefined && !v.bool(b.active)) {
    throw badRequest('You cannot deactivate the account you are signed in with.');
  }
  const nextRole = v.oneOf(b.role, ROLES, 'role') || row.role;
  if (row.role === 'admin' && nextRole !== 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?")
      .get(row.id).c;
    if (!admins) throw badRequest('That is the last administrator — make somebody else an administrator first.');
  }

  db.prepare(`UPDATE users SET name = @name, email = @email, phone = @phone, role = @role,
      company_id = @company_id, designation = @designation, active = @active WHERE id = @id`).run({
    id: row.id,
    name: v.str(b.name, row.name),
    email: b.email ? String(b.email).trim().toLowerCase() : row.email,
    phone: v.str(b.phone, row.phone),
    role: nextRole,
    company_id: b.company_id === undefined ? row.company_id : (b.company_id || null),
    designation: v.str(b.designation, row.designation),
    active: b.active === undefined ? row.active : (v.bool(b.active) ? 1 : 0),
  });

  if (b.password) {
    const problems = auth.passwordProblems(b.password);
    if (problems.length) throw badRequest(`A password must ${problems.join(', ')}.`);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(b.password), row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    audit.log(req, 'user.password_reset', 'user', row.id);
  }
  audit.log(req, 'user.updated', 'user', row.id);
  res.json(db.prepare('SELECT id, staff_code, name, email, role, active FROM users WHERE id = ?').get(row.id));
}));

/** The audit trail: who did what, and when. */
router.get('/audit', wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 100, 500);
  const where = [];
  const params = { limit, offset };
  if (req.query.entity) { where.push('entity = @entity'); params.entity = req.query.entity; }
  if (req.query.action) { where.push('action LIKE @action'); params.action = `${req.query.action}%`; }
  if (req.query.user_id) { where.push('user_id = @user_id'); params.user_id = req.query.user_id; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({
    rows: db.prepare(`SELECT * FROM audit_logs ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`).all(params),
    total: db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${clause}`).get(params).c,
    page, limit,
  });
}));

/** Where the document numbers have got to, per company and series. */
router.get('/counters', wrap(async (_req, res) => {
  res.json({ rows: db.prepare('SELECT * FROM counters ORDER BY name').all() });
}));

module.exports = router;
module.exports.ROLES = ROLES;
