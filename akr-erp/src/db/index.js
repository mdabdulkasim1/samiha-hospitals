'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/** Adds a column if it is missing. Returns true when it actually added it. */
function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (exists) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/** Run the schema file — safe to call repeatedly (everything is IF NOT EXISTS). */
function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  // Columns added after the first release, for databases created before them.
  ensureColumn('items', 'subgroup_id', 'INTEGER REFERENCES item_subgroups(id)');
  for (const col of ['attention', 'incoterms', 'authority']) {
    ensureColumn('purchase_orders', col, 'TEXT');
  }
  for (const col of ['purchase_officer', 'purchase_officer_mobile', 'delivery_contact',
    'delivery_mobile', 'delivery_location']) {
    ensureColumn('sales_orders', col, 'TEXT');
  }
  // Enquiries run on both sides of the trade; everything logged before that
  // was a client's.
  ensureColumn('enquiries', 'side', "TEXT NOT NULL DEFAULT 'client'");
  ensureColumn('supplier_quotations', 'enquiry_id', 'INTEGER REFERENCES enquiries(id)');
  // The enquiry number travels the length of the buy side: onto the order the
  // supplier holds, and onto what we file when the goods and the bill arrive.
  for (const table of ['purchase_orders', 'grns', 'supplier_invoices', 'payments',
    'sales_orders', 'delivery_notes', 'sales_invoices', 'expenses']) {
    ensureColumn(table, 'enquiry_id', 'INTEGER REFERENCES enquiries(id)');
  }
  // Indexed here rather than in the schema: on a database created before the
  // column existed, the schema runs before the column is added.
  db.exec('CREATE INDEX IF NOT EXISTS idx_enquiries_side ON enquiries(side, status)');
  // What an expense was spent against: the LPO, either direction — ours to a
  // manufacturer, or the client's to us.
  ensureColumn('expenses', 'po_id', 'INTEGER REFERENCES purchase_orders(id)');
  ensureColumn('expenses', 'so_id', 'INTEGER REFERENCES sales_orders(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_po ON expenses(po_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_so ON expenses(so_id)');
  ensureCostingHeads();
  // The working behind a quoted rate, on the line it belongs to.
  ensureColumn('sales_quotation_items', 'cost_build', 'TEXT');
  return db;
}

/*
 * The company's own costing heads, on a database that predates them.
 *
 * These are the words the rate builder uses at the quote stage, so an expense
 * can be booked under the head it was quoted under — which is the whole point
 * of them. Added by code, never renamed or removed: an installation that has
 * edited its own heads keeps them, and one that has deleted a head it does not
 * use does not have it put back.
 */
const COSTING_HEADS = [
  ['EXR', 'Exchange risk', 1],
  ['PACK', 'Packing', 2],
  ['SHIP', 'Shipping', 3],
  ['INSC', 'Insurance — consignment', 4],
  ['CUST', 'Custom clearance', 5],
  ['PBG', 'PBG — performance bank guarantee', 6],
  ['RETN', 'Retention', 7],
  ['VMI', 'VMI — vendor managed inventory', 8],
  ['DELC', 'Delivery charges', 9],
  ['COLC', 'Collection charges', 10],
  ['REPR', 'Other expenses — repair', 11],
];

function ensureCostingHeads() {
  const seen = db.prepare('SELECT code FROM expense_categories').all().map((r) => r.code);
  if (!seen.length) return;               // a fresh database is the seed's business
  const add = db.prepare(
    'INSERT INTO expense_categories (code, name, kind, sort_order) VALUES (?, ?, \'expense\', ?)');
  for (const [code, name, order] of COSTING_HEADS) {
    // Sorted ahead of whatever is already there rather than renumbering it:
    // an installation that has ordered its own heads keeps that order.
    if (!seen.includes(code)) add.run(code, name, order - 100);
  }
}

/** Wrap a function in a transaction. */
const tx = (fn) => db.transaction(fn);

// Apply the schema on load. Every statement is idempotent, which removes any
// module-ordering hazard around prepared statements.
migrate();

module.exports = { db, migrate, tx, ensureColumn };
