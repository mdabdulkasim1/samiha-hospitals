'use strict';
const express = require('express');
const { db, tx } = require('../db');
const config = require('../config');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const ids = require('../lib/ids');
const v = require('../lib/validate');
const { wrap, badRequest, notFound } = require('../lib/http');
const stock = require('../services/stock');
const docs = require('../services/documents');

const router = express.Router();
// The catalogue is the company's own reference data: everybody reads it, and
// the desks that negotiate and buy keep it.
const maintainer = auth.requireRole('kam', 'accounts');

const SELECT = `
  SELECT i.*, c.name AS category_name, c.code AS category_code, c.product_group,
         a.name AS application_name, a.code AS application_code,
         g.name AS subgroup_name, g.code AS subgroup_code,
         m.name AS manufacturer_name
    FROM items i
    LEFT JOIN item_categories c ON c.id = i.category_id
    LEFT JOIN applications a ON a.id = i.application_id
    LEFT JOIN item_subgroups g ON g.id = i.subgroup_id
    LEFT JOIN partners m ON m.id = i.manufacturer_id`;

/** Hide what a role may not see, without hiding the item itself. */
function screen(user, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  for (const r of list) {
    if (!r) continue;
    if (!auth.seesCost(user)) r.cost_price = null;
    if (!auth.seesPrices(user)) r.sell_price = null;
  }
  return rows;
}

// -------------------------------------------------------------------- browse
router.get('/', wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 100, 1000);
  const where = [];
  const params = {};
  if (!v.bool(req.query.includeInactive)) where.push('i.active = 1');
  if (req.query.category_id) { where.push('i.category_id = @category_id'); params.category_id = req.query.category_id; }
  if (req.query.application_id) { where.push('i.application_id = @application_id'); params.application_id = req.query.application_id; }
  if (req.query.manufacturer_id) { where.push('i.manufacturer_id = @manufacturer_id'); params.manufacturer_id = req.query.manufacturer_id; }
  if (req.query.product_group) { where.push('c.product_group = @product_group'); params.product_group = req.query.product_group; }
  if (req.query.subgroup_id) { where.push('i.subgroup_id = @subgroup_id'); params.subgroup_id = req.query.subgroup_id; }
  if (req.query.q) {
    where.push(`(i.name LIKE @q OR i.item_code LIKE @q OR i.brand LIKE @q OR i.size LIKE @q
                 OR i.mfr_part_no LIKE @q OR i.description LIKE @q)`);
    params.q = `%${String(req.query.q).trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`${SELECT} ${clause} ORDER BY i.item_code LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });
  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM items i LEFT JOIN item_categories c ON c.id = i.category_id ${clause}`
  ).get(params).c;

  // A price is a great deal more useful next to what is actually in the yard.
  if (v.bool(req.query.withStock)) {
    for (const r of rows) Object.assign(r, stock.balance(r.id));
  }
  res.json({ rows: screen(req.user, rows), total, page, limit });
}));

router.get('/:id', wrap(async (req, res) => {
  const row = db.prepare(`${SELECT} WHERE i.id = ?`).get(req.params.id);
  if (!row) throw notFound('No such item.');
  const suppliers = db.prepare(`
    SELECT s.*, p.name AS partner_name, p.code AS partner_code
      FROM item_suppliers s JOIN partners p ON p.id = s.partner_id
     WHERE s.item_id = ? ORDER BY s.last_price`).all(row.id);
  res.json({
    item: screen(req.user, row),
    stock: stock.balance(row.id),
    movements: stock.ledger(row.id, { limit: 50 }),
    suppliers: auth.seesCost(req.user) ? suppliers : suppliers.map((s) => ({ ...s, last_price: null })),
  });
}));

// --------------------------------------------------------------------- write
function itemPayload(b, existing = null) {
  const category = db.prepare('SELECT * FROM item_categories WHERE id = ?')
    .get(b.category_id || (existing && existing.category_id));
  if (!category) throw badRequest('Choose the product line this item belongs to.');

  return {
    name: v.str(b.name, existing && existing.name),
    description: v.str(b.description, existing ? existing.description : null),
    category_id: category.id,
    // The type within the line: a strap, a grating, a C clamp. Kept as its own
    // field so the catalogue can be sorted and counted by it.
    subgroup_id: b.subgroup_id !== undefined
      ? (b.subgroup_id || null) : (existing ? existing.subgroup_id : null),
    // An item's application defaults to its product line's — a potable-water
    // valve is a potable-water item — but may be set on its own, because a
    // fastener or a GRP ladder is sold into whichever job needs it.
    application_id: b.application_id !== undefined
      ? (b.application_id || null)
      : (existing ? existing.application_id : category.application_id),
    brand: v.str(b.brand, existing ? existing.brand : null),
    manufacturer_id: b.manufacturer_id !== undefined
      ? (b.manufacturer_id || null) : (existing ? existing.manufacturer_id : null),
    mfr_part_no: v.str(b.mfr_part_no, existing ? existing.mfr_part_no : null),
    material: v.str(b.material, existing ? existing.material : null),
    size: v.str(b.size, existing ? existing.size : null),
    pressure_class: v.str(b.pressure_class, existing ? existing.pressure_class : null),
    standard: v.str(b.standard, existing ? existing.standard : null),
    uom: (v.str(b.uom, existing ? existing.uom : 'NOS') || 'NOS').toUpperCase(),
    hs_code: v.str(b.hs_code, existing ? existing.hs_code : null),
    cost_price: v.money(b.cost_price, existing ? existing.cost_price : 0),
    sell_price: v.money(b.sell_price, existing ? existing.sell_price : 0),
    vat_percent: v.num(b.vat_percent, existing ? existing.vat_percent : config.vat.percent),
    reorder_level: v.qty(b.reorder_level, existing ? existing.reorder_level : 0),
    lead_time_days: v.int(b.lead_time_days, existing ? existing.lead_time_days : 0),
    notes: v.str(b.notes, existing ? existing.notes : null),
    active: b.active === undefined ? (existing ? existing.active : 1) : (v.bool(b.active) ? 1 : 0),
  };
}

router.post('/', maintainer, wrap(async (req, res) => {
  v.required(req.body, ['name', 'category_id']);
  const payload = itemPayload(req.body);
  const category = db.prepare('SELECT code FROM item_categories WHERE id = ?').get(payload.category_id);

  // The code may be given — importing a list the company already uses — or
  // minted from the product line.
  const code = v.str(req.body.item_code) || ids.itemCode(category.code, config.itemCodePrefix);
  const info = db.prepare(`
    INSERT INTO items (item_code, name, description, category_id, subgroup_id, application_id, brand,
      manufacturer_id, mfr_part_no, material, size, pressure_class, standard, uom, hs_code,
      cost_price, sell_price, vat_percent, reorder_level, lead_time_days, notes, active)
    VALUES (@item_code, @name, @description, @category_id, @subgroup_id, @application_id, @brand,
      @manufacturer_id, @mfr_part_no, @material, @size, @pressure_class, @standard, @uom, @hs_code,
      @cost_price, @sell_price, @vat_percent, @reorder_level, @lead_time_days, @notes, @active)`)
    .run({ ...payload, item_code: code });

  audit.log(req, 'item.created', 'item', info.lastInsertRowid, { code });
  res.status(201).json(db.prepare(`${SELECT} WHERE i.id = ?`).get(info.lastInsertRowid));
}));

router.patch('/:id', maintainer, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such item.');
  const payload = itemPayload(req.body, row);
  db.prepare(`
    UPDATE items SET name = @name, description = @description, category_id = @category_id,
      subgroup_id = @subgroup_id, application_id = @application_id, brand = @brand, manufacturer_id = @manufacturer_id,
      mfr_part_no = @mfr_part_no, material = @material, size = @size, pressure_class = @pressure_class,
      standard = @standard, uom = @uom, hs_code = @hs_code, cost_price = @cost_price,
      sell_price = @sell_price, vat_percent = @vat_percent, reorder_level = @reorder_level,
      lead_time_days = @lead_time_days, notes = @notes, active = @active
    WHERE id = @id`).run({ ...payload, id: row.id });
  audit.log(req, 'item.updated', 'item', row.id, { code: row.item_code });
  res.json(db.prepare(`${SELECT} WHERE i.id = ?`).get(row.id));
}));

// ------------------------------------------------------- who makes this item
router.post('/:id/suppliers', maintainer, wrap(async (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) throw notFound('No such item.');
  v.required(req.body, ['partner_id']);
  db.prepare(`
    INSERT INTO item_suppliers (item_id, partner_id, supplier_ref, last_price, last_quoted, lead_days)
    VALUES (@item_id, @partner_id, @supplier_ref, @last_price, @last_quoted, @lead_days)
    ON CONFLICT(item_id, partner_id) DO UPDATE SET
      supplier_ref = excluded.supplier_ref, last_price = excluded.last_price,
      last_quoted = excluded.last_quoted, lead_days = excluded.lead_days`).run({
    item_id: item.id,
    partner_id: req.body.partner_id,
    supplier_ref: v.str(req.body.supplier_ref),
    last_price: v.money(req.body.last_price, 0),
    last_quoted: v.date(req.body.last_quoted) || v.today(),
    lead_days: v.int(req.body.lead_days, 0),
  });
  res.json({ ok: true });
}));

// -------------------------------------------------------------- import/export
/*
 * The catalogue as a spreadsheet, in and out.
 *
 * A trading company's item list already exists — on the website, in a price
 * list, in somebody's workbook — and typing it in again is how a list gets
 * two codes for the same valve. So the same columns go out as come in, and an
 * import that names an existing code updates it rather than duplicating it.
 */
const CSV_COLUMNS = ['item_code', 'name', 'description', 'category_code', 'application_code',
  'product_group', 'subgroup', 'brand', 'mfr_part_no', 'material', 'size', 'pressure_class',
  'standard', 'uom', 'hs_code', 'cost_price', 'sell_price', 'vat_percent', 'reorder_level',
  'lead_time_days'];

const csvCell = (value) => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** A small RFC-4180 reader: quoted fields, embedded commas, doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

router.get('/export/csv', wrap(async (req, res) => {
  const rows = db.prepare(`
    SELECT i.item_code, i.name, i.description, c.code AS category_code, a.code AS application_code,
           c.product_group, g.name AS subgroup, i.brand, i.mfr_part_no, i.material, i.size,
           i.pressure_class, i.standard, i.uom, i.hs_code, i.cost_price, i.sell_price,
           i.vat_percent, i.reorder_level, i.lead_time_days
      FROM items i
      LEFT JOIN item_categories c ON c.id = i.category_id
      LEFT JOIN applications a ON a.id = i.application_id
      LEFT JOIN item_subgroups g ON g.id = i.subgroup_id
     WHERE i.active = 1 ORDER BY i.item_code`).all();

  const seesCost = auth.seesCost(req.user);
  const body = rows.map((r) => CSV_COLUMNS
    .map((c) => csvCell(c === 'cost_price' && !seesCost ? '' : r[c])).join(','));
  res.type('text/csv').attachment('akr-item-master.csv')
    .send([CSV_COLUMNS.join(','), ...body].join('\n'));
}));

router.post('/import/csv', maintainer, wrap(async (req, res) => {
  const text = typeof req.body === 'string' ? req.body : v.str(req.body.csv);
  if (!text) throw badRequest('Send the spreadsheet as CSV text in a "csv" field.');
  const rows = parseCsv(text);
  if (rows.length < 2) throw badRequest('That CSV has a header but no rows.');

  const header = rows[0].map((h) => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
  const needed = ['name'];
  const missing = needed.filter((c) => !header.includes(c));
  if (missing.length) throw badRequest(`The CSV needs a "${missing.join('", "')}" column.`);

  const categories = new Map(db.prepare('SELECT id, code FROM item_categories').all()
    .map((c) => [c.code.toUpperCase(), c.id]));
  const applications = new Map(db.prepare('SELECT id, code FROM applications').all()
    .map((a) => [a.code.toUpperCase(), a.id]));
  // Sub-groups are matched by name as well as by code, because a spreadsheet
  // says "Chequered plate", not "CHQ".
  const subgroups = new Map();
  for (const g of db.prepare('SELECT id, code, name FROM item_subgroups').all()) {
    subgroups.set(g.code.toUpperCase(), g.id);
    subgroups.set(g.name.toUpperCase(), g.id);
  }

  const dryRun = v.bool(req.body.dryRun);
  const report = { created: 0, updated: 0, skipped: [], rows: rows.length - 1 };

  const run = tx(() => {
    for (let r = 1; r < rows.length; r += 1) {
      const cells = rows[r];
      const get = (col) => {
        const i = header.indexOf(col);
        return i === -1 ? '' : String(cells[i] === undefined ? '' : cells[i]).trim();
      };
      const name = get('name');
      if (!name) { report.skipped.push({ line: r + 1, reason: 'no name' }); continue; }

      const catCode = get('category_code').toUpperCase();
      const categoryId = categories.get(catCode);
      if (!categoryId) {
        report.skipped.push({ line: r + 1, reason: `product line "${catCode || '(blank)'}" is not set up` });
        continue;
      }
      const appCode = get('application_code').toUpperCase();
      const subgroupKey = get('subgroup').toUpperCase();
      const body = {
        name,
        description: get('description'),
        category_id: categoryId,
        subgroup_id: subgroupKey ? (subgroups.get(subgroupKey) || null) : undefined,
        application_id: appCode ? (applications.get(appCode) || null) : undefined,
        brand: get('brand'),
        mfr_part_no: get('mfr_part_no'),
        material: get('material'),
        size: get('size'),
        pressure_class: get('pressure_class'),
        standard: get('standard'),
        uom: get('uom') || 'NOS',
        hs_code: get('hs_code'),
        cost_price: get('cost_price'),
        sell_price: get('sell_price'),
        vat_percent: get('vat_percent') || config.vat.percent,
        reorder_level: get('reorder_level'),
        lead_time_days: get('lead_time_days'),
      };

      const code = get('item_code');
      const existing = code ? db.prepare('SELECT * FROM items WHERE item_code = ?').get(code) : null;
      const payload = itemPayload(body, existing);

      if (existing) {
        if (!dryRun) {
          db.prepare(`UPDATE items SET name = @name, description = @description,
            category_id = @category_id, subgroup_id = @subgroup_id,
            application_id = @application_id, brand = @brand,
            manufacturer_id = @manufacturer_id, mfr_part_no = @mfr_part_no, material = @material,
            size = @size, pressure_class = @pressure_class, standard = @standard, uom = @uom,
            hs_code = @hs_code, cost_price = @cost_price, sell_price = @sell_price,
            vat_percent = @vat_percent, reorder_level = @reorder_level,
            lead_time_days = @lead_time_days, notes = @notes, active = @active
            WHERE id = @id`).run({ ...payload, id: existing.id });
        }
        report.updated += 1;
      } else {
        if (!dryRun) {
          db.prepare(`INSERT INTO items (item_code, name, description, category_id, subgroup_id,
            application_id, brand, manufacturer_id, mfr_part_no, material, size, pressure_class,
            standard, uom, hs_code, cost_price, sell_price, vat_percent, reorder_level,
            lead_time_days, notes, active)
            VALUES (@item_code, @name, @description, @category_id, @subgroup_id, @application_id,
            @brand, @manufacturer_id, @mfr_part_no, @material, @size, @pressure_class, @standard,
            @uom, @hs_code, @cost_price, @sell_price, @vat_percent, @reorder_level,
            @lead_time_days, @notes, @active)`).run({
            ...payload,
            item_code: code || ids.itemCode(catCode, config.itemCodePrefix),
          });
        }
        report.created += 1;
      }
    }
  });
  run();

  audit.log(req, dryRun ? 'items.import.checked' : 'items.imported', 'item', null, report);
  res.json({ ...report, dryRun });
}));

/** A blank sheet with the right columns and one worked example. */
router.get('/import/template', wrap(async (_req, res) => {
  const example = ['', 'Resilient Seated Gate Valve', 'Flanged, non-rising stem', 'VLP', 'PW',
    'Valves', 'Gate Valve', 'AVK', 'AVK-06/30', 'Ductile Iron', 'DN150', 'PN16', 'BS EN 1171',
    'NOS', '84818090', '850.00', '1120.00', '5', '4', '45'];
  res.type('text/csv').attachment('akr-item-import-template.csv')
    .send([CSV_COLUMNS.join(','), example.map(csvCell).join(',')].join('\n'));
}));

/** What an item is called on a document, so the screens agree with the print. */
router.get('/:id/description', wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such item.');
  res.json({ description: docs.itemDescription(row) });
}));

module.exports = router;
module.exports.parseCsv = parseCsv;
