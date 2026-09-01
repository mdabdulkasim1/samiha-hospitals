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

/** Add a column to an existing table if it is not there yet. */
function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Run the schema file — safe to call repeatedly (everything is IF NOT EXISTS). */
function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  // Columns added after the first release, for databases created earlier.
  ensureColumn('departments', 'kind', "TEXT NOT NULL DEFAULT 'specialist'");
  ensureColumn('departments', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  return db;
}

/** Wrap a function in a transaction. */
function tx(fn) {
  return db.transaction(fn);
}

// Apply the schema on first load. Every statement is IF NOT EXISTS, so this is
// idempotent and removes any module-ordering hazard around prepared statements.
migrate();

module.exports = { db, migrate, tx, ensureColumn };
