'use strict';
const express = require('express');
const { db } = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const ids = require('../lib/ids');
const v = require('../lib/validate');
const { wrap, notFound, badRequest } = require('../lib/http');
const ledger = require('../services/ledger');
const terms = require('../services/terms');

const router = express.Router();
// Sales officers open client accounts; the KAM and accounts keep both sides.
const editor = auth.requireRole('kam', 'accounts', 'sales');

const SELECT = `
  SELECT p.*, t.name AS terms_name, t.kind AS terms_kind, t.credit_days,
         u.name AS account_manager
    FROM partners p
    LEFT JOIN payment_terms t ON t.id = p.payment_terms_id
    LEFT JOIN users u ON u.id = p.account_manager_id`;

router.get('/', wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 100, 1000);
  const where = [];
  const params = {};
  if (!v.bool(req.query.includeInactive)) where.push('p.active = 1');
  if (req.query.type) {
    // 'both' partners are a supplier and a client at once, so they belong in
    // either list.
    where.push("(p.type = @type OR p.type = 'both')");
    params.type = req.query.type;
  }
  if (req.query.q) {
    where.push('(p.name LIKE @q OR p.code LIKE @q OR p.trade_name LIKE @q OR p.trn LIKE @q OR p.contact_person LIKE @q)');
    params.q = `%${String(req.query.q).trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`${SELECT} ${clause} ORDER BY p.name LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });

  if (auth.seesMoney(req.user) && v.bool(req.query.withBalance)) {
    for (const r of rows) Object.assign(r, ledger.partnerBalance(r.id) || {});
  }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM partners p ${clause}`).get(params).c;
  res.json({ rows, total, page, limit });
}));

router.get('/:id', wrap(async (req, res) => {
  const row = db.prepare(`${SELECT} WHERE p.id = ?`).get(req.params.id);
  if (!row) throw notFound('No such account.');

  const out = {
    partner: row,
    terms: row.payment_terms_id ? {
      ...terms.get(row.payment_terms_id),
      description: terms.describe(row.payment_terms_id),
    } : null,
    contacts: db.prepare('SELECT * FROM partner_contacts WHERE partner_id = ? ORDER BY is_primary DESC, name')
      .all(row.id),
  };

  // What has passed between us, on whichever side of the trade applies.
  out.sales = {
    quotations: db.prepare(
      `SELECT id, quote_no, quote_date, total, status FROM sales_quotations
        WHERE partner_id = ? ORDER BY quote_date DESC, id DESC LIMIT 10`).all(row.id),
    orders: db.prepare(
      `SELECT id, so_no, client_lpo_no, order_date, total, status FROM sales_orders
        WHERE partner_id = ? ORDER BY order_date DESC, id DESC LIMIT 10`).all(row.id),
    invoices: db.prepare(
      `SELECT id, invoice_no, invoice_date, due_date, total, paid_amount, status FROM sales_invoices
        WHERE partner_id = ? ORDER BY invoice_date DESC, id DESC LIMIT 10`).all(row.id),
  };
  out.purchase = {
    quotations: db.prepare(
      `SELECT id, quote_no, quote_date, total, status FROM supplier_quotations
        WHERE partner_id = ? ORDER BY quote_date DESC, id DESC LIMIT 10`).all(row.id),
    orders: db.prepare(
      `SELECT id, lpo_no, lpo_date, total, status FROM purchase_orders
        WHERE partner_id = ? ORDER BY lpo_date DESC, id DESC LIMIT 10`).all(row.id),
    invoices: db.prepare(
      `SELECT id, bill_no, supplier_inv_no, invoice_date, due_date, total, paid_amount, status
         FROM supplier_invoices WHERE partner_id = ? ORDER BY invoice_date DESC, id DESC LIMIT 10`).all(row.id),
  };

  if (auth.seesMoney(req.user)) out.balance = ledger.partnerBalance(row.id);
  res.json(out);
}));

function payload(b, existing = null) {
  return {
    type: v.oneOf(b.type, ['supplier', 'client', 'both'], 'type') || (existing ? existing.type : 'client'),
    name: v.str(b.name, existing && existing.name),
    trade_name: v.str(b.trade_name, existing ? existing.trade_name : null),
    trn: b.trn === undefined ? (existing ? existing.trn : null) : v.trn(b.trn),
    contact_person: v.str(b.contact_person, existing ? existing.contact_person : null),
    designation: v.str(b.designation, existing ? existing.designation : null),
    phone: v.str(b.phone, existing ? existing.phone : null),
    mobile: v.str(b.mobile, existing ? existing.mobile : null),
    email: v.str(b.email, existing ? existing.email : null),
    address: v.str(b.address, existing ? existing.address : null),
    city: v.str(b.city, existing ? existing.city : null),
    emirate: v.str(b.emirate, existing ? existing.emirate : null),
    country: v.str(b.country, existing ? existing.country : 'United Arab Emirates'),
    payment_terms_id: b.payment_terms_id === undefined
      ? (existing ? existing.payment_terms_id : null) : (b.payment_terms_id || null),
    credit_limit: v.money(b.credit_limit, existing ? existing.credit_limit : 0),
    currency: v.str(b.currency, existing ? existing.currency : 'AED'),
    bank_name: v.str(b.bank_name, existing ? existing.bank_name : null),
    iban: v.str(b.iban, existing ? existing.iban : null),
    account_manager_id: b.account_manager_id === undefined
      ? (existing ? existing.account_manager_id : null) : (b.account_manager_id || null),
    opening_balance: v.money(b.opening_balance, existing ? existing.opening_balance : 0),
    notes: v.str(b.notes, existing ? existing.notes : null),
    active: b.active === undefined ? (existing ? existing.active : 1) : (v.bool(b.active) ? 1 : 0),
  };
}

router.post('/', editor, wrap(async (req, res) => {
  v.required(req.body, ['name', 'type']);
  const p = payload(req.body);
  const code = v.str(req.body.code) || ids.partnerCode(p.type);
  const info = db.prepare(`
    INSERT INTO partners (code, type, name, trade_name, trn, contact_person, designation, phone,
      mobile, email, address, city, emirate, country, payment_terms_id, credit_limit, currency,
      bank_name, iban, account_manager_id, opening_balance, notes, active)
    VALUES (@code, @type, @name, @trade_name, @trn, @contact_person, @designation, @phone,
      @mobile, @email, @address, @city, @emirate, @country, @payment_terms_id, @credit_limit,
      @currency, @bank_name, @iban, @account_manager_id, @opening_balance, @notes, @active)`)
    .run({ ...p, code });
  audit.log(req, 'partner.created', 'partner', info.lastInsertRowid, { code, type: p.type });
  res.status(201).json(db.prepare(`${SELECT} WHERE p.id = ?`).get(info.lastInsertRowid));
}));

router.patch('/:id', editor, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such account.');
  const p = payload(req.body, row);
  db.prepare(`UPDATE partners SET type = @type, name = @name, trade_name = @trade_name, trn = @trn,
      contact_person = @contact_person, designation = @designation, phone = @phone, mobile = @mobile,
      email = @email, address = @address, city = @city, emirate = @emirate, country = @country,
      payment_terms_id = @payment_terms_id, credit_limit = @credit_limit, currency = @currency,
      bank_name = @bank_name, iban = @iban, account_manager_id = @account_manager_id,
      opening_balance = @opening_balance, notes = @notes, active = @active
    WHERE id = @id`).run({ ...p, id: row.id });
  audit.log(req, 'partner.updated', 'partner', row.id, { code: row.code });
  res.json(db.prepare(`${SELECT} WHERE p.id = ?`).get(row.id));
}));

router.post('/:id/contacts', editor, wrap(async (req, res) => {
  const row = db.prepare('SELECT id FROM partners WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such account.');
  v.required(req.body, ['name']);
  const info = db.prepare(
    'INSERT INTO partner_contacts (partner_id, name, designation, phone, email, is_primary) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(row.id, v.str(req.body.name), v.str(req.body.designation), v.str(req.body.phone),
    v.str(req.body.email), v.bool(req.body.is_primary) ? 1 : 0);
  res.status(201).json(db.prepare('SELECT * FROM partner_contacts WHERE id = ?').get(info.lastInsertRowid));
}));

// ------------------------------------------------------------------- the books
router.get('/:id/ledger', auth.requireRole('kam', 'accounts'), wrap(async (req, res) => {
  const result = ledger.partnerLedger(req.params.id, {
    companyId: req.query.company_id || null,
    from: v.date(req.query.from),
    to: v.date(req.query.to),
  });
  if (!result) throw notFound('No such account.');
  res.json(result);
}));

/** The statement of account that gets emailed to a client who is chasing. */
router.get('/:id/statement', auth.requireRole('kam', 'accounts'), wrap(async (req, res) => {
  const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
  if (!partner) throw notFound('No such account.');
  const side = partner.type === 'supplier' ? 'payable' : 'receivable';
  res.json({
    partner,
    ledger: ledger.partnerLedger(partner.id, { from: v.date(req.query.from), to: v.date(req.query.to) }),
    ageing: ledger.ageing(side, { partnerId: partner.id, asOf: v.date(req.query.asOf) }),
    company: require('../services/documents').defaultCompany(),
    as_of: v.date(req.query.asOf) || v.today(),
  });
}));

/** Whether this order would take the client past their credit limit. */
router.get('/:id/credit-check', auth.requireRole('kam', 'accounts', 'sales'), wrap(async (req, res) => {
  const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
  if (!partner) throw notFound('No such account.');
  const amount = v.money(req.query.amount, 0);
  const balance = ledger.partnerBalance(partner.id);
  const exposure = (balance ? balance.receivable : 0) + amount;
  const limit = partner.credit_limit || 0;
  res.json({
    limit,
    outstanding: balance ? balance.receivable : 0,
    this_order: amount,
    exposure,
    // No limit set means nobody has decided yet, which is not the same as
    // approval — say so rather than quietly waving it through.
    ok: limit === 0 ? true : exposure <= limit + 0.005,
    unset: limit === 0,
    over_by: limit === 0 ? 0 : Math.max(0, Math.round((exposure - limit) * 100) / 100),
  });
}));

module.exports = router;
