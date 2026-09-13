'use strict';
const { db } = require('../db');
const { round } = require('./pricing');

/*
 * The stock register.
 *
 * Three buckets, and every movement is a signed quantity in one of them:
 *
 *   ordered    on an LPO placed with a manufacturer and not yet received.
 *              The company counts this as stock — it is bought, it is coming,
 *              and it can be promised to a client — so placing an LPO writes
 *              it in, and receiving the goods takes it out again.
 *   onhand     in the yard. A goods receipt puts it in, a delivery note takes
 *              it out.
 *   committed  spoken for by a client's LPO and not yet delivered.
 *
 * Free stock is on hand less committed. Nothing keeps a running total: the
 * balance is the sum of the movements, so the register can always show its
 * working — every receipt and every delivery with the document behind it.
 */

const BUCKETS = ['ordered', 'onhand', 'committed'];

/** Write one movement. Callers wrap several of these in a transaction. */
function post({
  companyId, itemId, locationId = null, bucket, kind, qty, rate = 0,
  refType = null, refId = null, refNo = null, partnerId = null, movedOn = null,
  notes = null, userId = null,
}) {
  if (!BUCKETS.includes(bucket)) throw new Error(`Unknown stock bucket: ${bucket}`);
  if (!itemId) return null;               // a free-text line holds no stock
  const amount = Number(qty) || 0;
  if (!amount) return null;
  return db.prepare(
    `INSERT INTO stock_movements
       (company_id, item_id, location_id, bucket, kind, qty, rate, ref_type, ref_id, ref_no,
        partner_id, moved_on, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, date('now')), ?, ?)`
  ).run(companyId, itemId, locationId, bucket, kind, amount, round(rate), refType, refId, refNo,
    partnerId, movedOn, notes, userId).lastInsertRowid;
}

/** Undo every movement a document caused — used when one is cancelled. */
function reverse({ refType, refId, kind, userId = null, notes = 'Document cancelled' }) {
  const rows = db.prepare(
    'SELECT * FROM stock_movements WHERE ref_type = ? AND ref_id = ?'
  ).all(refType, refId);
  for (const m of rows) {
    // A reversal already posted must not be reversed again.
    if (m.notes === notes) continue;
    post({
      companyId: m.company_id, itemId: m.item_id, locationId: m.location_id, bucket: m.bucket,
      kind, qty: -m.qty, rate: m.rate, refType, refId, refNo: m.ref_no,
      partnerId: m.partner_id, notes, userId,
    });
  }
  return rows.length;
}

const BALANCE_SQL = `
  SELECT
    COALESCE(SUM(CASE WHEN bucket = 'ordered'   THEN qty END), 0) AS on_order,
    COALESCE(SUM(CASE WHEN bucket = 'onhand'    THEN qty END), 0) AS on_hand,
    COALESCE(SUM(CASE WHEN bucket = 'committed' THEN qty END), 0) AS committed,
    COALESCE(SUM(CASE WHEN bucket = 'onhand' AND qty > 0 THEN qty END), 0) AS received_total,
    COALESCE(SUM(CASE WHEN bucket = 'onhand' AND qty < 0 THEN -qty END), 0) AS delivered_total
  FROM stock_movements WHERE item_id = ?`;

/** Where one item stands. */
function balance(itemId, { companyId = null } = {}) {
  const sql = companyId ? `${BALANCE_SQL} AND company_id = ?` : BALANCE_SQL;
  const row = companyId
    ? db.prepare(sql).get(itemId, companyId)
    : db.prepare(sql).get(itemId);
  const b = {
    on_order: round(row.on_order),
    on_hand: round(row.on_hand),
    committed: round(row.committed),
    received_total: round(row.received_total),
    delivered_total: round(row.delivered_total),
  };
  b.free = round(b.on_hand - b.committed);
  // What can be promised today: what is free, plus what is already bought and
  // on its way.
  b.available = round(b.free + b.on_order);
  return b;
}

/** The whole register, one row per item, with the balances alongside. */
function register({ companyId = null, categoryId = null, applicationId = null, search = null,
  onlyMoved = false, lowStock = false, limit = 500, offset = 0 } = {}) {
  const where = ['i.active = 1'];
  const params = {};
  if (categoryId) { where.push('i.category_id = @categoryId'); params.categoryId = categoryId; }
  if (applicationId) { where.push('i.application_id = @applicationId'); params.applicationId = applicationId; }
  if (search) {
    where.push('(i.name LIKE @search OR i.item_code LIKE @search OR i.brand LIKE @search OR i.size LIKE @search)');
    params.search = `%${search}%`;
  }
  const companyFilter = companyId ? 'AND m.company_id = @companyId' : '';
  if (companyId) params.companyId = companyId;

  const rows = db.prepare(`
    SELECT i.id, i.item_code, i.name, i.uom, i.reorder_level, i.cost_price, i.sell_price,
           c.name AS category, c.code AS category_code, a.name AS application, a.code AS application_code,
           COALESCE(SUM(CASE WHEN m.bucket = 'ordered'   THEN m.qty END), 0) AS on_order,
           COALESCE(SUM(CASE WHEN m.bucket = 'onhand'    THEN m.qty END), 0) AS on_hand,
           COALESCE(SUM(CASE WHEN m.bucket = 'committed' THEN m.qty END), 0) AS committed,
           COALESCE(SUM(CASE WHEN m.bucket = 'onhand' AND m.qty > 0 THEN m.qty END), 0) AS received_total,
           COALESCE(SUM(CASE WHEN m.bucket = 'onhand' AND m.qty < 0 THEN -m.qty END), 0) AS delivered_total,
           MAX(m.moved_on) AS last_movement
      FROM items i
      LEFT JOIN item_categories c ON c.id = i.category_id
      LEFT JOIN applications a ON a.id = i.application_id
      LEFT JOIN stock_movements m ON m.item_id = i.id ${companyFilter}
     WHERE ${where.join(' AND ')}
     GROUP BY i.id
     ORDER BY i.item_code
     LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset });

  return rows
    .map((r) => {
      const free = round(r.on_hand - r.committed);
      return {
        ...r,
        on_order: round(r.on_order),
        on_hand: round(r.on_hand),
        committed: round(r.committed),
        received_total: round(r.received_total),
        delivered_total: round(r.delivered_total),
        free,
        available: round(free + r.on_order),
        stock_value: round(r.on_hand * (r.cost_price || 0)),
        /*
         * Low stock, not "never stocked". A catalogue this size is mostly
         * items bought in against an order; flagging every one of them the day
         * the system is switched on would bury the handful that the company
         * really does keep on the shelf and really has run down.
         */
        below_reorder: r.reorder_level > 0 && Boolean(r.last_movement) && free < r.reorder_level,
      };
    })
    .filter((r) => (!onlyMoved || r.last_movement) && (!lowStock || r.below_reorder));
}

/** Every movement against one item, newest first — receiving and delivery. */
function ledger(itemId, { companyId = null, from = null, to = null, limit = 300 } = {}) {
  const where = ['m.item_id = @itemId'];
  const params = { itemId, limit };
  if (companyId) { where.push('m.company_id = @companyId'); params.companyId = companyId; }
  if (from) { where.push('m.moved_on >= @from'); params.from = from; }
  if (to) { where.push('m.moved_on <= @to'); params.to = to; }

  return db.prepare(`
    SELECT m.*, p.name AS partner_name, l.name AS location_name, u.name AS by_name
      FROM stock_movements m
      LEFT JOIN partners p ON p.id = m.partner_id
      LEFT JOIN locations l ON l.id = m.location_id
      LEFT JOIN users u ON u.id = m.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY m.moved_on DESC, m.id DESC
     LIMIT @limit`).all(params);
}

/** What the yard is worth, at what the goods cost us. */
function valuation({ companyId = null } = {}) {
  const rows = register({ companyId, limit: 100000 });
  const value = rows.reduce((a, r) => a + r.stock_value, 0);
  const onOrderValue = rows.reduce((a, r) => a + r.on_order * (r.cost_price || 0), 0);
  return {
    items: rows.filter((r) => r.on_hand || r.on_order || r.committed).length,
    on_hand_value: round(value),
    on_order_value: round(onOrderValue),
    below_reorder: rows.filter((r) => r.below_reorder).length,
  };
}

module.exports = { BUCKETS, post, reverse, balance, register, ledger, valuation };
