'use strict';
const Database = require('better-sqlite3');
const mysql = require('mysql2/promise');
const config = require('../src/config');

async function main() {
  const sqlite = new Database('./data/samiha.db', { readonly: true });
  const pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    multipleStatements: true,
  });

  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  console.log(`Inspecting defaults across ${tables.length} tables...`);

  let applied = 0;
  for (const { name: table } of tables) {
    const cols = sqlite.prepare(`PRAGMA table_info("${table}")`).all();
    // Get existing MySQL column types
    const [myCols] = await pool.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]
    );
    const myColMap = new Map(myCols.map(c => [c.COLUMN_NAME, c]));

    for (const c of cols) {
      if (c.dflt_value === null || c.dflt_value === undefined) continue;
      const myCol = myColMap.get(c.name);
      if (!myCol) continue;

      let defVal = c.dflt_value.trim();
      // Unwrap parentheses e.g. (datetime('now')) or (date('now'))
      if (defVal.startsWith('(') && defVal.endsWith(')')) {
        defVal = defVal.slice(1, -1).trim();
      }

      let mysqlDefault = '';
      if (/datetime\(\s*'now'\s*\)/i.test(defVal) || /CURRENT_TIMESTAMP/i.test(defVal)) {
        mysqlDefault = 'DEFAULT CURRENT_TIMESTAMP';
      } else if (/date\(\s*'now'\s*\)/i.test(defVal) || /CURRENT_DATE/i.test(defVal)) {
        mysqlDefault = 'DEFAULT (CURDATE())';
      } else if (/^-?\d+(\.\d+)?$/.test(defVal)) {
        mysqlDefault = `DEFAULT ${defVal}`;
      } else if (defVal.startsWith("'") && defVal.endsWith("'")) {
        mysqlDefault = `DEFAULT ${defVal}`;
      } else if (defVal.toUpperCase() === 'NULL') {
        mysqlDefault = 'DEFAULT NULL';
      } else {
        // Other expression
        mysqlDefault = `DEFAULT (${defVal})`;
      }

      const nullability = c.notnull ? 'NOT NULL' : 'NULL';
      const colType = myCol.COLUMN_TYPE;

      const alterSql = `ALTER TABLE \`${table}\` MODIFY COLUMN \`${c.name}\` ${colType} ${nullability} ${mysqlDefault}`;
      try {
        await pool.query(alterSql);
        applied++;
      } catch (err) {
        console.warn(`Could not apply default for ${table}.${c.name}: ${err.message} (SQL: ${alterSql})`);
      }
    }
  }

  console.log(`Successfully applied ${applied} column defaults to MySQL!`);
  await pool.end();
  sqlite.close();
}

main().catch(console.error);

