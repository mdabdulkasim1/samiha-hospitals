'use strict';
const express = require('express');
const { db, tx } = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const ids = require('../lib/ids');
const v = require('../lib/validate');
const { wrap, badRequest, notFound } = require('../lib/http');
const stock = require('../services/stock');
const docs = require('../services/documents');

const router = express.Router();
const keeper = auth.requireRole('logistics', 'kam');

/*
 * The stock register, as the company asked for it: one screen that says, for
 * every item, what is on order with the manufacturer, what has been received
 * into the yard, what has been delivered out of it, what a client's LPO has
 * already spoken for, and what is therefore free to sell.
 */

router.get('/', wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 200, 2000);
  const rows = stock.register({
    companyId: req.query.company_id || null,
    categoryId: req.query.category_id || null,
    applicationId: req.query.application_id || null,
    search: v.str(req.query.q),
    onlyMoved: v.bool(req.query.onlyMoved),
    lowStock: v.bool(req.query.lowStock),
    limit,
    offset,
  });
  const seesCost = auth.seesCost(req.user);
  if (!seesCost) for (const r of rows) { r.cost_price = null; r.stock_value = null; }
  if (!auth.seesPrices(req.user)) for (const r of rows) r.sell_price = null;

  res.json({
    rows,
    page,
    limit,
    summary: seesCost ? stock.valuation({ companyId: req.query.company_id || null }) : null,
  });
}));

/** One item's own register: receiving and delivery, with the document behind each. */
router.get('/items/:id', wrap(async (req, res) => {
  const item = db.prepare(`
    SELECT i.*, c.name AS category_name, a.name AS application_name, g.name AS subgroup_name
      FROM items i
      LEFT JOIN item_categories c ON c.id = i.category_id
      LEFT JOIN applications a ON a.id = i.application_id
      LEFT JOIN item_subgroups g ON g.id = i.subgroup_id
     WHERE i.id = ?`).get(req.params.id);
  if (!item) throw notFound('No such item.');
  if (!auth.seesCost(req.user)) item.cost_price = null;
  if (!auth.seesPrices(req.user)) item.sell_price = null;

  res.json({
    item,
    balance: stock.balance(item.id, { companyId: req.query.company_id || null }),
    movements: stock.ledger(item.id, {
      companyId: req.query.company_id || null,
      from: v.date(req.query.from),
      to: v.date(req.query.to),
      limit: v.paging(req.query, 300, 2000).limit,
    }),
    // What is still due in and still due out, with the documents that owe it.
    onOrder: db.prepare(`
      SELECT o.id, o.lpo_no, o.lpo_date, o.delivery_date, p.name AS supplier_name,
             i.qty, i.received_qty, (i.qty - i.received_qty) AS pending
        FROM purchase_order_items i
        JOIN purchase_orders o ON o.id = i.po_id
        JOIN partners p ON p.id = o.partner_id
       WHERE i.item_id = ? AND o.status IN ('sent','acknowledged','partial') AND i.qty > i.received_qty
       ORDER BY o.delivery_date`).all(item.id),
    committed: db.prepare(`
      SELECT o.id, o.so_no, o.client_lpo_no, o.order_date, o.delivery_date, p.name AS client_name,
             i.qty, i.delivered_qty, (i.qty - i.delivered_qty) AS pending
        FROM sales_order_items i
        JOIN sales_orders o ON o.id = i.so_id
        JOIN partners p ON p.id = o.partner_id
       WHERE i.item_id = ? AND o.status IN ('confirmed','partial') AND i.qty > i.delivered_qty
       ORDER BY o.delivery_date`).all(item.id),
  });
}));

/** Everything that came in over a period — the receiving register. */
router.get('/receipts', wrap(async (req, res) => {
  const from = v.date(req.query.from) || v.addDays(v.today(), -30);
  const to = v.date(req.query.to) || v.today();
  res.json({
    from,
    to,
    rows: db.prepare(`
      SELECT m.moved_on, m.qty, m.rate, m.ref_no, m.notes, i.item_code, i.name AS item_name, i.uom,
             p.name AS partner_name, l.name AS location_name
        FROM stock_movements m
        JOIN items i ON i.id = m.item_id
        LEFT JOIN partners p ON p.id = m.partner_id
        LEFT JOIN locations l ON l.id = m.location_id
       WHERE m.bucket = 'onhand' AND m.qty > 0 AND m.moved_on BETWEEN ? AND ?
       ORDER BY m.moved_on DESC, m.id DESC`).all(from, to),
  });
}));

/** Everything that went out over a period — the delivery register. */
router.get('/deliveries', wrap(async (req, res) => {
  const from = v.date(req.query.from) || v.addDays(v.today(), -30);
  const to = v.date(req.query.to) || v.today();
  res.json({
    from,
    to,
    rows: db.prepare(`
      SELECT m.moved_on, -m.qty AS qty, m.ref_no, m.notes, i.item_code, i.name AS item_name, i.uom,
             p.name AS partner_name, l.name AS location_name
        FROM stock_movements m
        JOIN items i ON i.id = m.item_id
        LEFT JOIN partners p ON p.id = m.partner_id
        LEFT JOIN locations l ON l.id = m.location_id
       WHERE m.bucket = 'onhand' AND m.qty < 0 AND m.moved_on BETWEEN ? AND ?
       ORDER BY m.moved_on DESC, m.id DESC`).all(from, to),
  });
}));

/**
 * A correction, and why.
 *
 * Stock is counted by people, and people find breakages, miscounts and things
 * that were never booked in. A reason is compulsory: an adjustment without one
 * is indistinguishable from a mistake, and it is the only entry in the
 * register that is not backed by a document.
 */
router.post('/adjustments', keeper, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['item_id', 'qty', 'reason']);
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(b.item_id);
  if (!item) throw notFound('No such item.');
  const qty = v.qty(b.qty, 0);
  if (!qty) throw badRequest('An adjustment of zero changes nothing.');

  const company = docs.companyFor(req, b);
  const location = b.location_id
    ? db.prepare('SELECT * FROM locations WHERE id = ?').get(b.location_id)
    : db.prepare('SELECT * FROM locations WHERE is_default = 1 AND active = 1').get();

  const balance = stock.balance(item.id, { companyId: company.id });
  if (qty < 0 && balance.on_hand + qty < -0.005) {
    throw badRequest(`There are only ${balance.on_hand} ${item.uom} of ${item.item_code} on hand.`);
  }

  const refNo = ids.docNo('stockAdjustment', company.code);
  tx(() => {
    stock.post({
      companyId: company.id, itemId: item.id, locationId: location ? location.id : null,
      bucket: v.oneOf(b.bucket, ['onhand', 'ordered', 'committed'], 'bucket') || 'onhand',
      kind: 'adjustment', qty, rate: v.money(b.rate, item.cost_price),
      refType: 'adjustment', refNo, movedOn: v.date(b.moved_on) || v.today(),
      notes: v.str(b.reason), userId: req.user.id,
    });
  })();

  audit.log(req, 'stock.adjusted', 'item', item.id,
    { itemCode: item.item_code, qty, reason: v.str(b.reason), refNo });
  res.status(201).json({ ok: true, ref_no: refNo, balance: stock.balance(item.id, { companyId: company.id }) });
}));

/** Opening stock, when the register is first switched on. */
router.post('/opening', keeper, wrap(async (req, res) => {
  const rows = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rows.length) throw badRequest('Send the opening quantities as an "items" array.');
  const company = docs.companyFor(req, req.body);
  const location = db.prepare('SELECT * FROM locations WHERE is_default = 1 AND active = 1').get();
  const on = v.date(req.body.as_of) || v.today();

  let posted = 0;
  tx(() => {
    for (const raw of rows) {
      const item = db.prepare('SELECT * FROM items WHERE id = ? OR item_code = ?')
        .get(raw.item_id || 0, raw.item_code || '');
      if (!item) continue;
      const qty = v.qty(raw.qty, 0);
      if (!qty) continue;
      stock.post({
        companyId: company.id, itemId: item.id, locationId: location ? location.id : null,
        bucket: 'onhand', kind: 'opening', qty, rate: v.money(raw.rate, item.cost_price),
        refType: 'opening', refNo: `Opening ${on}`, movedOn: on, userId: req.user.id,
        notes: 'Opening stock',
      });
      posted += 1;
    }
  })();

  audit.log(req, 'stock.opening', 'stock', null, { rows: posted, as_of: on });
  res.status(201).json({ ok: true, posted });
}));

/** What has fallen below its reorder level, and what is already on the way. */
router.get('/reorder', wrap(async (req, res) => {
  const rows = stock.register({ companyId: req.query.company_id || null, lowStock: true, limit: 2000 });
  if (!auth.seesCost(req.user)) for (const r of rows) { r.cost_price = null; r.stock_value = null; }
  res.json({ rows });
}));

module.exports = router;
