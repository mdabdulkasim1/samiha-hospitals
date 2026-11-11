'use strict';
const Database = require('better-sqlite3');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const SQLITE_PATH = path.resolve(__dirname, '../data/samiha.db');

async function applyIndexes() {
  const sqlite = new Database(SQLITE_PATH);
  const mysqlConn = await mysql.createConnection({
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',
    database: 'samiha-polyclinic',
  });

  const indexes = sqlite.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name, name"
  ).all();

  console.log(`Found ${indexes.length} secondary indexes in SQLite.`);

  let created = 0;
  let skipped = 0;
  const sqlStatements = [];

  for (const idx of indexes) {
    // Extract column list from SQLite SQL: "CREATE INDEX idx_name ON tbl(col1, col2)"
    const match = idx.sql.match(/\((.+)\)$/);
    if (!match) continue;

    const rawCols = match[1];
    // Convert SQLite column definitions, e.g. "patient_id, id DESC" -> "`patient_id`, `id` DESC"
    const formattedCols = rawCols.split(',').map((c) => {
      const parts = c.trim().split(/\s+/);
      const colName = parts[0].replace(/['"]/g, '');
      const order = parts[1] ? ` ${parts[1].toUpperCase()}` : '';
      return `\`${colName}\`${order}`;
    }).join(', ');

    const isUnique = idx.sql.toUpperCase().includes('UNIQUE');
    const indexDdl = isUnique
      ? `CREATE UNIQUE INDEX \`${idx.name}\` ON \`${idx.tbl_name}\` (${formattedCols});`
      : `CREATE INDEX \`${idx.name}\` ON \`${idx.tbl_name}\` (${formattedCols});`;

    sqlStatements.push(indexDdl);

    try {
      await mysqlConn.query(indexDdl);
      created++;
      console.log(`✓ Created index: ${idx.name} on ${idx.tbl_name}`);
    } catch (err) {
      if (err.code === 'ER_DUP_KEYNAME') {
        skipped++;
      } else {
        console.error(`✗ Error creating index ${idx.name} on ${idx.tbl_name}:`, err.message);
      }
    }
  }

  // Append indexes to src/db/mysql-schema.sql
  const schemaPath = path.resolve(__dirname, '../src/db/mysql-schema.sql');
  const indexBlock = '\n-- Secondary & Performance Indexes\n' + sqlStatements.join('\n') + '\n';
  fs.appendFileSync(schemaPath, indexBlock, 'utf8');

  console.log(`\nSuccessfully applied ${created} indexes (${skipped} already present). Appended to mysql-schema.sql.`);

  sqlite.close();
  await mysqlConn.end();
}

applyIndexes().catch((err) => {
  console.error('Failed to apply indexes:', err);
  process.exit(1);
});

