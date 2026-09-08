'use strict';
const express = require('express');
const { db } = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const v = require('../lib/validate');
const { wrap, badRequest, notFound } = require('../lib/http');

const router = express.Router();
const admin = auth.requireRole('admin');

/*
 * The master records everything else is built on: the group's companies, the
 * five applications, the product lines, the payment terms, the yards and the
 * expense heads. Everyone may read them — a sales officer picking an
 * application needs the list — and only an administrator may change them.
 */

// ------------------------------------------------------------------ one call
/** Everything a form needs to populate its dropdowns, in a single request. */
router.get('/bootstrap', wrap(async (req, res) => {
  res.json({
    companies: db.prepare('SELECT * FROM companies WHERE active = 1 ORDER BY is_default DESC, code').all(),
    applications: db.prepare('SELECT * FROM applications WHERE active = 1 ORDER BY sort_order, name').all(),
    categories: db.prepare(`
      SELECT c.*, a.name AS application_name, a.code AS application_code,
             (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.active = 1) AS item_count
        FROM item_categories c
        LEFT JOIN applications a ON a.id = c.application_id
       WHERE c.active = 1 ORDER BY c.sort_order, c.name`).all(),
    subgroups: db.prepare('SELECT * FROM item_subgroups WHERE active = 1 ORDER BY product_group, sort_order, name').all(),
    paymentTerms: db.prepare('SELECT * FROM payment_terms WHERE active = 1 ORDER BY sort_order, name').all(),
    locations: db.prepare('SELECT * FROM locations WHERE active = 1 ORDER BY is_default DESC, name').all(),
    expenseCategories: db.prepare('SELECT * FROM expense_categories WHERE active = 1 ORDER BY kind, sort_order, name').all(),
    uoms: ['NOS', 'SET', 'MTR', 'SQM', 'KG', 'TON', 'LTR', 'ROLL', 'BAG', 'BOX', 'LOT', 'PAIR'],
    users: db.prepare('SELECT id, name, role, staff_code FROM users WHERE active = 1 ORDER BY name').all(),
  });
}));

// ----------------------------------------------------------------- companies
router.get('/companies', wrap(async (_req, res) => {
  res.json({ rows: db.prepare('SELECT * FROM companies ORDER BY is_default DESC, code').all() });
}));

router.post('/companies', admin, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['code', 'name']);
  const info = db.prepare(`
    INSERT INTO companies (code, name, legal_name, trn, address, phone, email, website,
      bank_name, bank_account, iban, swift, currency, vat_percent, is_default)
    VALUES (@code, @name, @legal_name, @trn, @address, @phone, @email, @website,
      @bank_name, @bank_account, @iban, @swift, @currency, @vat_percent, @is_default)`).run({
    code: String(b.code).toUpperCase().trim(),
    name: v.str(b.name),
    legal_name: v.str(b.legal_name),
    trn: v.trn(b.trn),
    address: v.str(b.address),
    phone: v.str(b.phone),
    email: v.str(b.email),
    website: v.str(b.website),
    bank_name: v.str(b.bank_name),
    bank_account: v.str(b.bank_account),
    iban: v.str(b.iban),
    swift: v.str(b.swift),
    currency: v.str(b.currency, 'AED'),
    vat_percent: v.num(b.vat_percent, 5),
    is_default: v.bool(b.is_default) ? 1 : 0,
  });
  if (v.bool(b.is_default)) {
    db.prepare('UPDATE companies SET is_default = 0 WHERE id != ?').run(info.lastInsertRowid);
  }
  audit.log(req, 'company.created', 'company', info.lastInsertRowid, { code: b.code });
  res.status(201).json(db.prepare('SELECT * FROM companies WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/companies/:id', admin, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such company.');
  const b = req.body;
  db.prepare(`
    UPDATE companies SET name = @name, legal_name = @legal_name, trn = @trn, address = @address,
      phone = @phone, email = @email, website = @website, bank_name = @bank_name,
      bank_account = @bank_account, iban = @iban, swift = @swift, currency = @currency,
      vat_percent = @vat_percent, active = @active
    WHERE id = @id`).run({
    id: row.id,
    name: v.str(b.name, row.name),
    legal_name: v.str(b.legal_name, row.legal_name),
    trn: b.trn === undefined ? row.trn : v.trn(b.trn),
    address: v.str(b.address, row.address),
    phone: v.str(b.phone, row.phone),
    email: v.str(b.email, row.email),
    website: v.str(b.website, row.website),
    bank_name: v.str(b.bank_name, row.bank_name),
    bank_account: v.str(b.bank_account, row.bank_account),
    iban: v.str(b.iban, row.iban),
    swift: v.str(b.swift, row.swift),
    currency: v.str(b.currency, row.currency),
    vat_percent: v.num(b.vat_percent, row.vat_percent),
    active: b.active === undefined ? row.active : (v.bool(b.active) ? 1 : 0),
  });
  if (b.is_default !== undefined && v.bool(b.is_default)) {
    db.prepare('UPDATE companies SET is_default = 0').run();
    db.prepare('UPDATE companies SET is_default = 1 WHERE id = ?').run(row.id);
  }
  audit.log(req, 'company.updated', 'company', row.id);
  res.json(db.prepare('SELECT * FROM companies WHERE id = ?').get(row.id));
}));

// -------------------------------------------------------------- applications
router.get('/applications', wrap(async (_req, res) => {
  res.json({ rows: db.prepare('SELECT * FROM applications ORDER BY sort_order, name').all() });
}));

router.post('/applications', admin, wrap(async (req, res) => {
  v.required(req.body, ['code', 'name']);
  const info = db.prepare('INSERT INTO applications (code, name, sort_order) VALUES (?, ?, ?)')
    .run(String(req.body.code).toUpperCase().trim(), v.str(req.body.name), v.int(req.body.sort_order, 99));
  audit.log(req, 'application.created', 'application', info.lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM applications WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/applications/:id', admin, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such application.');
  db.prepare('UPDATE applications SET name = ?, sort_order = ?, active = ? WHERE id = ?').run(
    v.str(req.body.name, row.name), v.int(req.body.sort_order, row.sort_order),
    req.body.active === undefined ? row.active : (v.bool(req.body.active) ? 1 : 0), row.id);
  res.json(db.prepare('SELECT * FROM applications WHERE id = ?').get(row.id));
}));

// ---------------------------------------------------------------- categories
router.get('/categories', wrap(async (_req, res) => {
  res.json({
    rows: db.prepare(`
      SELECT c.*, a.name AS application_name, a.code AS application_code,
             (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id) AS item_count
        FROM item_categories c
        LEFT JOIN applications a ON a.id = c.application_id
       ORDER BY c.sort_order, c.name`).all(),
  });
}));

router.post('/categories', admin, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['code', 'name', 'product_group']);
  const code = String(b.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 2 || code.length > 4) {
    throw badRequest('A product-line code is two to four letters — it becomes part of every item code in that line.');
  }
  const info = db.prepare(
    'INSERT INTO item_categories (code, name, product_group, application_id, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(code, v.str(b.name), v.str(b.product_group), b.application_id || null, v.int(b.sort_order, 99));
  audit.log(req, 'category.created', 'item_category', info.lastInsertRowid, { code });
  res.status(201).json(db.prepare('SELECT * FROM item_categories WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/categories/:id', admin, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM item_categories WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such product line.');
  // The code is left alone on purpose: it is baked into every item code already
  // issued in this line, and changing it would orphan them.
  db.prepare(`UPDATE item_categories SET name = ?, product_group = ?, application_id = ?,
      sort_order = ?, active = ? WHERE id = ?`).run(
    v.str(req.body.name, row.name), v.str(req.body.product_group, row.product_group),
    req.body.application_id === undefined ? row.application_id : (req.body.application_id || null),
    v.int(req.body.sort_order, row.sort_order),
    req.body.active === undefined ? row.active : (v.bool(req.body.active) ? 1 : 0), row.id);
  audit.log(req, 'category.updated', 'item_category', row.id);
  res.json(db.prepare('SELECT * FROM item_categories WHERE id = ?').get(row.id));
}));

// ----------------------------------------------------------------- subgroups
/*
 * The types within a product line — the fabrication list in particular:
 * straps, air vents, handle bars, C clamps, gratings, chequered plates,
 * extension spindles and the rest.
 */
router.get('/subgroups', wrap(async (req, res) => {
  const group = v.str(req.query.product_group);
  const rows = group
    ? db.prepare('SELECT * FROM item_subgroups WHERE product_group = ? ORDER BY sort_order, name').all(group)
    : db.prepare('SELECT * FROM item_subgroups ORDER BY product_group, sort_order, name').all();
  res.json({ rows });
}));

router.post('/subgroups', admin, wrap(async (req, res) => {
  v.required(req.body, ['code', 'name', 'product_group']);
  const info = db.prepare(
    'INSERT INTO item_subgroups (code, name, product_group, sort_order) VALUES (?, ?, ?, ?)'
  ).run(String(req.body.code).toUpperCase().trim(), v.str(req.body.name),
    v.str(req.body.product_group), v.int(req.body.sort_order, 99));
  audit.log(req, 'subgroup.created', 'item_subgroup', info.lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM item_subgroups WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/subgroups/:id', admin, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM item_subgroups WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such type.');
  db.prepare('UPDATE item_subgroups SET name = ?, sort_order = ?, active = ? WHERE id = ?').run(
    v.str(req.body.name, row.name), v.int(req.body.sort_order, row.sort_order),
    req.body.active === undefined ? row.active : (v.bool(req.body.active) ? 1 : 0), row.id);
  res.json(db.prepare('SELECT * FROM item_subgroups WHERE id = ?').get(row.id));
}));

// ------------------------------------------------------------- payment terms
router.get('/payment-terms', wrap(async (req, res) => {
  const side = v.str(req.query.side);            // 'supplier' | 'client'
  const rows = side
    ? db.prepare("SELECT * FROM payment_terms WHERE active = 1 AND applies_to IN (?, 'both') ORDER BY sort_order, name").all(side)
    : db.prepare('SELECT * FROM payment_terms ORDER BY sort_order, name').all();
  res.json({ rows });
}));

router.post('/payment-terms', admin, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['code', 'name']);
  const info = db.prepare(`
    INSERT INTO payment_terms (code, name, kind, credit_days, advance_percent, on_delivery_percent,
      retention_percent, applies_to, description, sort_order)
    VALUES (@code, @name, @kind, @credit_days, @advance_percent, @on_delivery_percent,
      @retention_percent, @applies_to, @description, @sort_order)`).run({
    code: String(b.code).toUpperCase().trim(),
    name: v.str(b.name),
    kind: v.oneOf(b.kind, ['advance', 'on_delivery', 'credit', 'pdc', 'milestone', 'lc'], 'kind') || 'credit',
    credit_days: v.int(b.credit_days, 0),
    advance_percent: v.num(b.advance_percent, 0),
    on_delivery_percent: v.num(b.on_delivery_percent, 0),
    retention_percent: v.num(b.retention_percent, 0),
    applies_to: v.oneOf(b.applies_to, ['supplier', 'client', 'both'], 'applies_to') || 'both',
    description: v.str(b.description),
    sort_order: v.int(b.sort_order, 99),
  });
  audit.log(req, 'payment_terms.created', 'payment_terms', info.lastInsertRowid, { code: b.code });
  res.status(201).json(db.prepare('SELECT * FROM payment_terms WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/payment-terms/:id', admin, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM payment_terms WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such payment terms.');
  const b = req.body;
  db.prepare(`UPDATE payment_terms SET name = @name, kind = @kind, credit_days = @credit_days,
      advance_percent = @advance_percent, on_delivery_percent = @on_delivery_percent,
      retention_percent = @retention_percent, applies_to = @applies_to, description = @description,
      sort_order = @sort_order, active = @active WHERE id = @id`).run({
    id: row.id,
    name: v.str(b.name, row.name),
    kind: v.oneOf(b.kind, ['advance', 'on_delivery', 'credit', 'pdc', 'milestone', 'lc'], 'kind') || row.kind,
    credit_days: v.int(b.credit_days, row.credit_days),
    advance_percent: v.num(b.advance_percent, row.advance_percent),
    on_delivery_percent: v.num(b.on_delivery_percent, row.on_delivery_percent),
    retention_percent: v.num(b.retention_percent, row.retention_percent),
    applies_to: v.oneOf(b.applies_to, ['supplier', 'client', 'both'], 'applies_to') || row.applies_to,
    description: v.str(b.description, row.description),
    sort_order: v.int(b.sort_order, row.sort_order),
    active: b.active === undefined ? row.active : (v.bool(b.active) ? 1 : 0),
  });
  audit.log(req, 'payment_terms.updated', 'payment_terms', row.id);
  res.json(db.prepare('SELECT * FROM payment_terms WHERE id = ?').get(row.id));
}));

// ----------------------------------------------------------------- locations
router.get('/locations', wrap(async (_req, res) => {
  res.json({ rows: db.prepare('SELECT * FROM locations ORDER BY is_default DESC, name').all() });
}));

router.post('/locations', admin, wrap(async (req, res) => {
  v.required(req.body, ['code', 'name']);
  const info = db.prepare('INSERT INTO locations (code, name, address, is_default) VALUES (?, ?, ?, ?)')
    .run(String(req.body.code).toUpperCase().trim(), v.str(req.body.name), v.str(req.body.address),
      v.bool(req.body.is_default) ? 1 : 0);
  if (v.bool(req.body.is_default)) {
    db.prepare('UPDATE locations SET is_default = 0 WHERE id != ?').run(info.lastInsertRowid);
  }
  res.status(201).json(db.prepare('SELECT * FROM locations WHERE id = ?').get(info.lastInsertRowid));
}));

// -------------------------------------------------------- expense categories
router.get('/expense-categories', wrap(async (_req, res) => {
  res.json({ rows: db.prepare('SELECT * FROM expense_categories ORDER BY kind, sort_order, name').all() });
}));

router.post('/expense-categories', auth.requireRole('accounts'), wrap(async (req, res) => {
  v.required(req.body, ['code', 'name']);
  const info = db.prepare('INSERT INTO expense_categories (code, name, kind, sort_order) VALUES (?, ?, ?, ?)')
    .run(String(req.body.code).toUpperCase().trim(), v.str(req.body.name),
      v.oneOf(req.body.kind, ['expense', 'income'], 'kind') || 'expense', v.int(req.body.sort_order, 99));
  res.status(201).json(db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(info.lastInsertRowid));
}));

module.exports = router;
