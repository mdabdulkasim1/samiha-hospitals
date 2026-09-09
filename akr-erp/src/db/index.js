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
    'sales_orders', 'delivery_notes', 'sales_invoices']) {
    ensureColumn(table, 'enquiry_id', 'INTEGER REFERENCES enquiries(id)');
  }
  // Indexed here rather than in the schema: on a database created before the
  // column existed, the schema runs before the column is added.
  db.exec('CREATE INDEX IF NOT EXISTS idx_enquiries_side ON enquiries(side, status)');
  // The working behind a quoted rate, on the line it belongs to.
  ensureColumn('sales_quotation_items', 'cost_build', 'TEXT');
  return db;
}

/** Wrap a function in a transaction. */
const tx = (fn) => db.transaction(fn);

// Apply the schema on load. Every statement is idempotent, which removes any
// module-ordering hazard around prepared statements.
migrate();

module.exports = { db, migrate, tx, ensureColumn };
