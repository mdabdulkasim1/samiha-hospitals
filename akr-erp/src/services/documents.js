'use strict';
const { db } = require('../db');
const v = require('../lib/validate');
const { badRequest, notFound } = require('../lib/http');
const pricing = require('./pricing');
const config = require('../config');

/*
 * The parts every document on both sides shares: the lines, the pricing, the
 * application title, and the footer. A quotation, an LPO, a delivery note and
 * a tax invoice differ in what they promise, not in how a line is built, so
 * the line is built once, here.
 */

/** The default company — the one everything falls back to. */
function defaultCompany() {
  return db.prepare('SELECT * FROM companies WHERE is_default = 1 AND active = 1').get()
    || db.prepare('SELECT * FROM companies WHERE active = 1 ORDER BY id').get();
}

function companyFor(req, body = {}) {
  const id = body.company_id || body.companyId || (req.user && req.user.company_id);
  const row = id ? db.prepare('SELECT * FROM companies WHERE id = ?').get(id) : null;
  const company = row || defaultCompany();
  if (!company) throw badRequest('No company is set up yet. Add one under Masters → Companies.');
  return company;
}

/**
 * Turn what the screen sent into a priced line.
 *
 * A line may name an item from the catalogue or stand on its own — a freight
 * charge, a one-off fabrication. When it names an item, the code, the unit and
 * the application come from the item master so that the same valve is
 * described the same way on our LPO to the maker and on the invoice to the
 * client.
 */
function buildLine(raw, index, { side = 'sell', vatPercent = config.vat.percent } = {}) {
  const itemId = raw.item_id || raw.itemId || null;
  const item = itemId ? db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) : null;
  if (itemId && !item) throw notFound(`Item ${itemId} is not in the catalogue.`);

  const description = v.str(raw.description) || (item ? itemDescription(item) : null);
  if (!description) throw badRequest(`Line ${index + 1} needs a description.`);

  const priced = pricing.priceLine({
    qty: raw.qty,
    unit_price: raw.unit_price !== undefined ? raw.unit_price : raw.rate,
    discount: raw.discount,
    discount_percent: raw.discount_percent,
    vat_percent: raw.vat_percent !== undefined ? raw.vat_percent : (item ? item.vat_percent : vatPercent),
  }, { vatPercent });

  if (priced.qty <= 0) throw badRequest(`Line ${index + 1} needs a quantity.`);

  return {
    line_no: index + 1,
    item_id: itemId,
    item_code: item ? item.item_code : v.str(raw.item_code),
    description,
    application_id: raw.application_id || raw.applicationId || (item ? item.application_id : null),
    uom: v.str(raw.uom) || (item ? item.uom : 'NOS'),
    // On the sell side we carry the cost behind the price, so the margin is
    // known while the price is still being decided.
    cost_price: side === 'sell'
      ? v.money(raw.cost_price !== undefined ? raw.cost_price : (item ? item.cost_price : 0))
      : 0,
    lead_days: v.int(raw.lead_days, item ? item.lead_time_days : 0),
    remarks: v.str(raw.remarks),
    ...priced,
  };
}

/** How an item reads on a printed line. */
function itemDescription(item) {
  return [item.name, item.size, item.material, item.pressure_class, item.standard, item.brand]
    .filter(Boolean).join(' · ');
}

/** Build and total a document's lines in one go. */
function buildLines(rawLines, opts = {}) {
  if (!Array.isArray(rawLines) || !rawLines.length) {
    throw badRequest('A document needs at least one line.');
  }
  const lines = rawLines.map((l, i) => buildLine(l, i, opts));
  return { lines, footer: pricing.totals(lines) };
}

/**
 * The application a document belongs to.
 *
 * Every format carries one — potable water, storm water, sewerage, district
 * cooling or irrigation — because that is how the company's work is divided
 * and how a client's project is described back to them. If nobody chose one,
 * the lines decide: if they all belong to the same application, so does the
 * document.
 */
function resolveApplication(chosen, lines) {
  if (chosen) return chosen;
  const ids = [...new Set(lines.map((l) => l.application_id).filter(Boolean))];
  return ids.length === 1 ? ids[0] : null;
}

const listApplications = () =>
  db.prepare('SELECT * FROM applications WHERE active = 1 ORDER BY sort_order, name').all();

/** Insert a document's lines into its own table. */
function insertLines(table, foreignKey, docId, lines, columns) {
  const cols = ['line_no', foreignKey, ...columns];
  const stmt = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c === foreignKey ? 'doc_id' : c}`).join(', ')})`
  );
  lines.forEach((line, i) => {
    const row = { doc_id: docId, line_no: i + 1 };
    for (const c of columns) row[c] = line[c] === undefined ? null : line[c];
    stmt.run(row);
  });
}

/** The columns each side's line tables carry, so callers do not repeat them. */
const LINE_COLUMNS = {
  quotationSell: ['item_id', 'item_code', 'description', 'application_id', 'qty', 'uom',
    'cost_price', 'unit_price', 'discount', 'taxable', 'vat_percent', 'vat_amount', 'total',
    'lead_days', 'remarks'],
  quotationBuy: ['item_id', 'item_code', 'description', 'application_id', 'qty', 'uom',
    'unit_price', 'discount', 'taxable', 'vat_percent', 'vat_amount', 'total', 'lead_days', 'remarks'],
  purchaseOrder: ['item_id', 'item_code', 'description', 'application_id', 'qty', 'uom',
    'unit_price', 'discount', 'taxable', 'vat_percent', 'vat_amount', 'total', 'remarks'],
  salesOrder: ['item_id', 'item_code', 'description', 'application_id', 'qty', 'uom',
    'unit_price', 'cost_price', 'discount', 'taxable', 'vat_percent', 'vat_amount', 'total', 'remarks'],
  salesInvoice: ['item_id', 'item_code', 'description', 'application_id', 'qty', 'uom',
    'unit_price', 'cost_price', 'discount', 'taxable', 'vat_percent', 'vat_amount', 'total'],
  supplierInvoice: ['item_id', 'item_code', 'description', 'qty', 'uom',
    'unit_price', 'discount', 'taxable', 'vat_percent', 'vat_amount', 'total'],
};

/*
 * The conditions a document carries are no longer written here. They live in
 * the clause library (src/services/clauses.js, kept under Masters → Terms &
 * conditions) so the key account manager can change them without a deployment,
 * and so each document's own copy names its own supplier or client.
 */
module.exports = {
  defaultCompany, companyFor, buildLine, buildLines, itemDescription,
  resolveApplication, listApplications, insertLines, LINE_COLUMNS,
};
