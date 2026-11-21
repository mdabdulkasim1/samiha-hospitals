'use strict';
/**
 * The consumables store.
 *
 * Gloves, swabs, cannulas, bin liners: everything the clinic uses up and
 * nobody bills for. It is kept apart from the pharmacy on purpose. A
 * medicine arrives in a batch with an expiry and an MRP, is sold to a named
 * patient and is taxed; a box of gauze is received, put on a shelf and used
 * until it runs out. Asking a nurse for a batch number and a GST rate before
 * she can write down that she took two rolls of micropore produces one
 * reliable outcome, which is a store nobody updates.
 *
 * So what is on the shelf is never a number anybody types. It is the sum of
 * the movements — opening, received, issued, wasted, returned, counted —
 * and every one of them says who and when. A figure that can be typed over
 * is a figure nobody can account for, and "the system says 40 and there are
 * 12" is the conversation this exists to prevent.
 */
const { db } = require('../db');
const { badRequest, notFound } = require('../lib/http');
const seed = require('../db/consumables');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/**
 * Which way each kind of movement pushes the shelf.
 *
 * A count is the exception: it is neither in nor out but a correction, and
 * the sign depends on what was found, so it is handled where it is written.
 */
const KINDS = {
  opening: { sign: +1, label: 'Opening stock' },
  receipt: { sign: +1, label: 'Received' },
  issue: { sign: -1, label: 'Issued' },
  wastage: { sign: -1, label: 'Damaged or expired' },
  return: { sign: -1, label: 'Returned to supplier' },
  count: { sign: 0, label: 'Physical count' },
};

const ON_HAND = `COALESCE((SELECT SUM(m.qty) FROM consumable_movements m WHERE m.item_id = c.id), 0)`;

/*
 * The row reads as a statement rather than as one number: what came in,
 * what has been used out of it, and what is therefore left.
 *
 * `used` is stock that left for a reason somebody gave — issued to a room,
 * damaged, sent back. A count correction is not usage, however much it
 * looks like it on a spreadsheet: it is the book being brought into line
 * with the shelf, and burying it in the usage figure would tell the owner
 * the clinic got through gauze it never had. It is kept as its own figure
 * so a row that does not add up says why.
 */
const SUM_OF = (clause) => `COALESCE((SELECT SUM(${clause}) FROM consumable_movements m
  WHERE m.item_id = c.id), 0)`;

const SELECT = `
  SELECT c.*, a.label AS area_label, a.sort_order AS area_sort,
         ${ON_HAND} AS on_hand,
         ${SUM_OF("CASE WHEN m.kind IN ('opening','receipt') THEN m.qty END")} AS taken_in,
         ${SUM_OF("CASE WHEN m.kind IN ('issue','wastage','return') THEN -m.qty END")} AS used,
         ${SUM_OF("CASE WHEN m.kind = 'issue' THEN -m.qty END")} AS issued,
         ${SUM_OF("CASE WHEN m.kind = 'wastage' THEN -m.qty END")} AS wasted,
         ${SUM_OF("CASE WHEN m.kind = 'count' THEN m.qty END")} AS counted_adjust,
         COALESCE(c.reorder_at, c.indent_qty * 0.25) AS reorder_level,
         (SELECT MAX(m.moved_on) FROM consumable_movements m WHERE m.item_id = c.id) AS last_moved,
         (SELECT COUNT(*) FROM consumable_movements m WHERE m.item_id = c.id) AS movements
    FROM consumables c
    LEFT JOIN consumable_areas a ON a.code = c.area`;

const one = (id) => db.prepare(`${SELECT} WHERE c.id = ?`).get(id);

/** The areas the clinic keeps things in, with what each is holding. */
function areas() {
  return db.prepare(
    `SELECT a.*,
            (SELECT COUNT(*) FROM consumables c WHERE c.area = a.code AND c.active = 1) AS items
       FROM consumable_areas a WHERE a.active = 1
      ORDER BY a.sort_order, a.code`).all();
}

/**
 * The store, filtered the way somebody standing in it would ask.
 *
 * `low` is the question that gets asked most: what has fallen below the
 * level we are supposed to hold. Below that level, and at nothing at all,
 * are different problems — one is an order to raise, the other is a nurse
 * reaching for a shelf that is empty — so they are counted apart.
 */
function list(query = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (!query.includeInactive) where.push('c.active = 1');
  if (query.area) { where.push('c.area = ?'); params.push(String(query.area)); }
  if (query.q) {
    where.push('(c.name LIKE ? OR c.description LIKE ? OR c.code LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(' AND ')}`;

  let rows = db.prepare(`${SELECT} ${clause} ORDER BY a.sort_order, c.sort_order, c.id`)
    .all(...params);
  const shown = rows.length;

  /*
   * "Nothing left" means the shelf was counted and is empty. An item that
   * has never been counted is not empty, it is unknown — reporting 323
   * unknowns as 323 out of stock would have the storekeeper chasing an
   * emergency that does not exist, and would hide the real empties when
   * they came.
   */
  if (query.low) rows = rows.filter((r) => r.movements > 0 && r.on_hand <= r.reorder_level);
  if (query.out) rows = rows.filter((r) => r.movements > 0 && r.on_hand <= 0);

  /*
   * The tiles describe the whole store, not the search. "Nothing left: 0"
   * is a fact about the clinic; narrowing to one cupboard must not make it
   * read as though the problem went away. What the table is showing is
   * said separately.
   */
  const all = db.prepare(`${SELECT} ${query.includeInactive ? '' : 'WHERE c.active = 1'}`).all();
  return {
    rows,
    shown,
    totals: {
      items: all.length,
      counted: all.filter((r) => r.movements > 0).length,
      low: all.filter((r) => r.movements > 0 && r.on_hand <= r.reorder_level && r.on_hand > 0).length,
      out: all.filter((r) => r.movements > 0 && r.on_hand <= 0).length,
      /*
       * Never counted at all. The honest headline for a store that has just
       * been loaded from a purchase order: the list is right, the shelf is
       * unknown until somebody walks round with it.
       */
      unknown: all.filter((r) => r.movements === 0).length,
    },
  };
}

/** One item, with everything that has moved it. */
function detail(id) {
  const item = one(id);
  if (!item) throw notFound('Item not found');
  item.history = db.prepare(
    `SELECT m.*, u.name AS by_name FROM consumable_movements m
       LEFT JOIN users u ON u.id = m.created_by
      WHERE m.item_id = ? ORDER BY date(m.moved_on) DESC, m.id DESC LIMIT 100`).all(id);
  return item;
}

/**
 * Write a movement.
 *
 * The quantity is always given as a positive number — "we received 12",
 * "we issued 2" — and the sign comes from what kind of movement it is.
 * Asking a nurse to type a minus sign is asking for the day somebody
 * forgets one.
 */
function move(itemId, input, userId) {
  const item = one(itemId);
  if (!item) throw notFound('Item not found');
  if (!item.active) throw badRequest(`${item.name} is switched off and cannot be moved.`);

  const kind = String(input.kind || 'receipt');
  if (!KINDS[kind]) throw badRequest(`"${kind}" is not a kind of movement.`, { kinds: Object.keys(KINDS) });

  const movedOn = String(input.movedOn || today());
  if (!isDate(movedOn)) throw badRequest('Give the date as YYYY-MM-DD.');
  if (movedOn > today()) throw badRequest('A movement cannot be dated in the future.');

  let qty;
  if (kind === 'count') {
    /*
     * A count says what is there, not what moved. The difference is worked
     * out here and written as the movement, so the shelf and the book agree
     * from that moment and the correction is on the record as a correction
     * rather than as a mystery receipt.
     */
    const counted = Number(input.counted);
    if (!(counted >= 0)) throw badRequest('How many are actually on the shelf?');
    qty = r2(counted - item.on_hand);
    if (qty === 0) {
      return { ...detail(itemId), unchanged: true, message: 'The count agrees with the book.' };
    }
  } else {
    const n = Number(input.qty);
    if (!(n > 0)) throw badRequest('How many?');
    qty = r2(n * KINDS[kind].sign);
    if (KINDS[kind].sign < 0 && item.on_hand + qty < -0.001) {
      throw badRequest(`There are only ${item.on_hand} ${item.unit} of ${item.name} on the shelf.`);
    }
  }

  if (kind === 'wastage' && !String(input.reason || '').trim()) {
    throw badRequest('Say what happened to it. Stock written off with no reason given is '
      + 'indistinguishable from stock that walked.');
  }
  if (kind === 'issue' && !String(input.issuedTo || '').trim()) {
    throw badRequest('Where did it go? An issue with nowhere against it cannot be traced back.');
  }

  const info = db.prepare(
    `INSERT INTO consumable_movements
       (item_id, kind, qty, moved_on, supplier, invoice_no, unit_cost, issued_to, reason, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(itemId, kind, qty, movedOn,
    String(input.supplier || '').trim() || null,
    String(input.invoiceNo || '').trim() || null,
    input.unitCost === undefined || input.unitCost === '' ? null : r2(input.unitCost),
    String(input.issuedTo || '').trim() || null,
    String(input.reason || '').trim() || null,
    String(input.notes || '').trim() || null,
    userId || null);

  return { ...detail(itemId), movementId: info.lastInsertRowid, applied: qty };
}

/**
 * A delivery of several items at once, which is how a delivery arrives.
 *
 * One supplier, one invoice, one date, many lines — entered as one thing
 * because that is what the piece of paper in the storekeeper's hand is, and
 * because a delivery typed line by line is a delivery half typed.
 */
function receiveDelivery(input, userId) {
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) throw badRequest('Add at least one item to the delivery.');

  const movedOn = String(input.movedOn || today());
  if (!isDate(movedOn)) throw badRequest('Give the date as YYYY-MM-DD.');
  if (movedOn > today()) throw badRequest('A delivery cannot be dated in the future.');

  const out = db.transaction(() => lines.map((line) => move(Number(line.itemId), {
    kind: 'receipt',
    qty: line.qty,
    movedOn,
    supplier: input.supplier,
    invoiceNo: input.invoiceNo,
    unitCost: line.unitCost,
    notes: line.notes || input.notes,
  }, userId)))();

  return {
    received: out.length,
    movedOn,
    supplier: String(input.supplier || '').trim() || null,
    invoiceNo: String(input.invoiceNo || '').trim() || null,
    items: out.map((r) => ({ id: r.id, code: r.code, name: r.name, onHand: r.on_hand })),
  };
}

/**
 * Take the purchase-order quantities as the opening stock.
 *
 * The list came off LPO AKB-SMC-100826-011: it says what the clinic
 * ordered, which is the best figure anybody has until somebody walks round
 * with a clipboard. Pressed once, it writes that quantity as the opening
 * balance of every item that has never been counted — and writes it as
 * what it is, an opening balance from the order, so that nobody later
 * mistakes it for a count.
 *
 * Items that have already moved are left alone. Adopting the order twice
 * must not double the shelf.
 */
function adoptIndent({ movedOn, userId } = {}) {
  const on = movedOn || today();
  if (!isDate(on)) throw badRequest('Give the date as YYYY-MM-DD.');

  const never = db.prepare(
    `SELECT c.id, c.indent_qty FROM consumables c
      WHERE c.active = 1 AND c.indent_qty > 0
        AND NOT EXISTS (SELECT 1 FROM consumable_movements m WHERE m.item_id = c.id)`).all();

  const insert = db.prepare(
    `INSERT INTO consumable_movements (item_id, kind, qty, moved_on, notes, created_by)
     VALUES (?, 'opening', ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const row of never) {
      insert.run(row.id, row.indent_qty, on,
        'Opening balance taken from the purchase order, not from a count', userId || null);
    }
  })();

  return {
    opened: never.length,
    movedOn: on,
    note: 'These are the quantities the purchase order was raised for. Correct each one with a '
      + 'count as the store is walked.',
  };
}

/** An item the clinic adds for itself — the list is a starting point, not a cage. */
function createItem(input, userId) {
  const name = String(input.name || '').trim();
  if (!name) throw badRequest('Give the item a name.');
  const area = String(input.area || '').trim();
  if (!db.prepare('SELECT 1 FROM consumable_areas WHERE code = ?').get(area)) {
    throw badRequest('Which part of the clinic keeps this?', { areas: areas().map((a) => a.code) });
  }
  if (db.prepare('SELECT 1 FROM consumables WHERE LOWER(name) = LOWER(?) AND area = ?').get(name, area)) {
    throw badRequest(`"${name}" is already on the list for that area.`);
  }

  // A code of the clinic's own, in the area's series, so it can never
  // collide with a line that came off the purchase order.
  const n = db.prepare(
    "SELECT COUNT(*) AS c FROM consumables WHERE area = ? AND code LIKE ?").get(area, `${area}-C%`).c;
  const code = `${area}-C${String(n + 1).padStart(3, '0')}`;
  const last = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS m FROM consumables WHERE area = ?').get(area).m;

  const info = db.prepare(
    `INSERT INTO consumables (code, name, description, area, unit, indent_qty, reorder_at,
                              seeded, active, sort_order, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`
  ).run(code, name, String(input.description || '').trim() || null, area,
    String(input.unit || 'No.').trim(), Number(input.indentQty) || 0,
    input.reorderAt === undefined || input.reorderAt === '' ? null : Number(input.reorderAt),
    last + 10, userId || null);

  const created = one(info.lastInsertRowid);

  // Opening stock, where the clinic already has some on the shelf.
  if (Number(input.openingQty) > 0) {
    move(created.id, {
      kind: 'opening', qty: input.openingQty, movedOn: input.movedOn,
      notes: 'Counted when the item was added',
    }, userId);
    return detail(created.id);
  }
  return created;
}

function updateItem(id, patch) {
  const item = one(id);
  if (!item) throw notFound('Item not found');
  const name = patch.name === undefined ? item.name : String(patch.name).trim();
  if (!name) throw badRequest('An item needs a name.');
  if (patch.area !== undefined
    && !db.prepare('SELECT 1 FROM consumable_areas WHERE code = ?').get(String(patch.area))) {
    throw badRequest('That is not one of the clinic\'s areas.');
  }

  db.prepare(
    `UPDATE consumables SET name = ?, description = ?, area = ?, unit = ?,
            indent_qty = ?, reorder_at = ?, active = ?
      WHERE id = ?`
  ).run(name,
    patch.description === undefined ? item.description : (String(patch.description).trim() || null),
    patch.area === undefined ? item.area : String(patch.area),
    patch.unit === undefined ? item.unit : String(patch.unit).trim(),
    patch.indentQty === undefined ? item.indent_qty : Number(patch.indentQty) || 0,
    patch.reorderAt === undefined || patch.reorderAt === ''
      ? item.reorder_at : Number(patch.reorderAt),
    patch.active === undefined ? item.active : (patch.active ? 1 : 0),
    id);
  return one(id);
}

/**
 * What the store did over a period.
 *
 * The same shape as the pharmacy's reconciliation on purpose: opening, in,
 * out, closing. A storekeeper who has learned to read one can read the
 * other.
 */
function usage(from, to) {
  const start = from || `${today().slice(0, 7)}-01`;
  const end = to || today();

  const opening = db.prepare(
    `SELECT COALESCE(SUM(qty), 0) AS q FROM consumable_movements
      WHERE date(moved_on) < date(?)`).get(start).q;

  const byKind = db.prepare(
    `SELECT kind, COUNT(*) AS entries, SUM(qty) AS qty,
            SUM(CASE WHEN unit_cost IS NOT NULL THEN ABS(qty) * unit_cost END) AS value
       FROM consumable_movements
      WHERE date(moved_on) BETWEEN date(?) AND date(?)
      GROUP BY kind`).all(start, end);

  const issuedTo = db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(issued_to), ''), 'Not said') AS place,
            COUNT(*) AS lines, SUM(-qty) AS qty
       FROM consumable_movements
      WHERE kind = 'issue' AND date(moved_on) BETWEEN date(?) AND date(?)
      GROUP BY place ORDER BY qty DESC`).all(start, end);

  const busiest = db.prepare(
    `SELECT c.name, c.unit, c.code, SUM(-m.qty) AS qty
       FROM consumable_movements m JOIN consumables c ON c.id = m.item_id
      WHERE m.kind IN ('issue','wastage') AND date(m.moved_on) BETWEEN date(?) AND date(?)
      GROUP BY c.id ORDER BY qty DESC LIMIT 15`).all(start, end);

  const kind = (k) => byKind.find((r) => r.kind === k) || { entries: 0, qty: 0, value: null };

  return {
    from: start,
    to: end,
    opening: r2(opening),
    lines: Object.entries(KINDS).map(([key, meta]) => ({
      kind: key, label: meta.label, ...kind(key), qty: r2(kind(key).qty), value: r2(kind(key).value),
    })),
    closing: r2(opening + byKind.reduce((t, r) => t + Number(r.qty || 0), 0)),
    issuedTo,
    busiest,
    /*
     * A total across units is meaningless — twelve boxes plus three rolls
     * is fifteen of nothing — so the count of lines is given instead, and
     * the value only where somebody recorded a cost.
     */
    note: 'Quantities are counted in each item\'s own unit, so they are not added across items. '
      + 'Value is shown only where a cost was recorded against the movement.',
    spend: r2(byKind.filter((r) => r.kind === 'receipt').reduce((t, r) => t + Number(r.value || 0), 0)),
  };
}

module.exports = {
  KINDS, areas, list, detail, move, receiveDelivery, createItem, updateItem, usage,
  adoptIndent,
  seedCount: () => seed.ITEMS.length,
};
