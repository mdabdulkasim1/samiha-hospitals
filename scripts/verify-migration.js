'use strict';
const Database = require('better-sqlite3');
const mysql = require('mysql2/promise');
const path = require('path');

const SQLITE_PATH = path.resolve(__dirname, '../data/samiha.db');

async function main() {
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const conn = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    database: 'samiha-polyclinic',
    dateStrings: true,
  });

  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();

  console.log('='.repeat(78));
  console.log('           100% MIGRATION VERIFICATION & INTEGRITY AUDIT              ');
  console.log('='.repeat(78));

  let totalSqliteRows = 0;
  let verifiedRows = 0;
  let missingRows = 0;
  const tableSummary = [];

  for (const { name: table } of tables) {
    const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
    totalSqliteRows += rows.length;

    let tableVerified = 0;
    let tableMissing = 0;

    for (const row of rows) {
      let query = '';
      let params = [];

      if (table === 'doctor_profiles') {
        query = 'SELECT 1 FROM `doctor_profiles` WHERE user_id = ?';
        params = [row.user_id];
      } else if (table === 'settings') {
        query = 'SELECT 1 FROM `settings` WHERE `key` = ?';
        params = [row.key];
      } else if (table === 'counters') {
        query = 'SELECT 1 FROM `counters` WHERE `name` = ?';
        params = [row.name];
      } else if (table === 'departments') {
        query = 'SELECT 1 FROM `departments` WHERE code = ?';
        params = [row.code];
      } else if (table === 'lab_tests') {
        query = 'SELECT 1 FROM `lab_tests` WHERE code = ?';
        params = [row.code];
      } else if (table === 'lab_package_items') {
        query = 'SELECT 1 FROM `lab_package_items` WHERE package_code = ? AND test_code = ?';
        params = [row.package_code, row.test_code];
      } else if (table === 'users') {
        query = 'SELECT 1 FROM `users` WHERE staff_code = ?';
        params = [row.staff_code];
      } else if (table === 'sessions') {
        query = 'SELECT 1 FROM `sessions` WHERE token = ?';
        params = [row.token];
      } else if (row.id !== undefined) {
        query = `SELECT 1 FROM \`${table}\` WHERE id = ?`;
        params = [row.id];
      } else {
        const keys = Object.keys(row);
        const whereClause = keys.map(k => `\`${k}\` = ?`).join(' AND ');
        query = `SELECT 1 FROM \`${table}\` WHERE ${whereClause}`;
        params = Object.values(row);
      }

      const [myRow] = await conn.query(query, params);
      if (myRow && myRow.length > 0) {
        verifiedRows++;
        tableVerified++;
      } else {
        missingRows++;
        tableMissing++;
      }
    }

    if (rows.length > 0) {
      tableSummary.push({
        table,
        sqliteRows: rows.length,
        verifiedInMysql: tableVerified,
        missing: tableMissing,
        status: tableMissing === 0 ? '✓ 100% PERSISTED' : '❌ INCOMPLETE'
      });
    }
  }

  console.log('Table Name'.padEnd(30) + 'SQLite Records'.padStart(15) + 'Found in MySQL'.padStart(15) + '     Status');
  console.log('-'.repeat(78));
  for (const s of tableSummary) {
    console.log(
      s.table.padEnd(30) +
      String(s.sqliteRows).padStart(15) +
      String(s.verifiedInMysql).padStart(15) +
      '     ' + s.status
    );
  }

  console.log('-'.repeat(78));
  console.log(`Total Tables Audited          : ${tables.length}`);
  console.log(`Populated Tables in SQLite    : ${tableSummary.length}`);
  console.log(`Total SQLite Records Audited  : ${totalSqliteRows}`);
  console.log(`Records Confirmed in MySQL    : ${verifiedRows} / ${totalSqliteRows} (${((verifiedRows/totalSqliteRows)*100).toFixed(2)}%)`);
  console.log(`Missing Records in MySQL      : ${missingRows}`);
  console.log('='.repeat(78));

  sqlite.close();
  await conn.end();
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
