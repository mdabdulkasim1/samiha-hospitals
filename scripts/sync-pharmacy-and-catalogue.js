'use strict';
const mysql = require('mysql2/promise');

async function main() {
  console.log('='.repeat(70));
  console.log('  SYNCING FULL PHARMACY BARCODES & MASTER CATALOGUE TO 76.13.243.217');
  console.log('='.repeat(70));

  const localConn = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'samiha-polyclinic',
    dateStrings: true,
  });

  const remoteConn = await mysql.createConnection({
    host: '76.13.243.217',
    user: 'samihahospitals_app_user',
    password: 'bka@6202#db',
    database: 'samihahospitals_app_db',
    dateStrings: true,
  });

  await remoteConn.query('SET FOREIGN_KEY_CHECKS = 0');

  const TABLES_TO_SYNC = [
    'drugs',
    'drug_batches',
    'stock_ledger',
    'suppliers',
    'stock_purchases',
    'stock_purchase_items',
    'lab_tests',
    'lab_package_items',
    'doctor_profiles',
    'doctor_schedules',
    'counters',
  ];

  try {
    for (const table of TABLES_TO_SYNC) {
      console.log(`\nSyncing \`${table}\`...`);
      // Delete existing records in target
      await remoteConn.query(`DELETE FROM \`${table}\``);

      // Fetch all records from local
      const [rows] = await localConn.query(`SELECT * FROM \`${table}\``);
      if (rows.length === 0) {
        console.log(`  - 0 rows to sync for \`${table}\``);
        continue;
      }

      const cols = Object.keys(rows[0]);
      const colList = cols.map((c) => `\`${c}\``).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const insertSql = `INSERT INTO \`${table}\` (${colList}) VALUES (${placeholders})`;

      // Batch insert in chunks of 50
      const chunkSize = 50;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        for (const row of chunk) {
          const vals = cols.map((c) => (row[c] === undefined ? null : row[c]));
          await remoteConn.query(insertSql, vals);
        }
      }

      const [verify] = await remoteConn.query(`SELECT COUNT(*) AS c FROM \`${table}\``);
      console.log(`  ✔ \`${table}\`: ${verify[0].c} rows synced successfully to remote`);
    }

    // Verify Pharmacy barcodes specifically
    console.log('\n' + '-'.repeat(70));
    console.log('VERIFYING PHARMACY BARCODE STATUS ON REMOTE:');
    const [stats] = await remoteConn.query(`
      SELECT COUNT(*) AS total_drugs,
             SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_drugs,
             SUM(CASE WHEN barcode IS NOT NULL AND barcode != '' THEN 1 ELSE 0 END) AS barcoded_drugs,
             (SELECT COUNT(*) FROM drug_batches) AS total_batches,
             (SELECT COALESCE(SUM(qty_available), 0) FROM drug_batches) AS total_stock
        FROM drugs
    `);
    console.table(stats);

    const [sample] = await remoteConn.query(
      'SELECT id, name, code, barcode, active FROM drugs WHERE active = 1 LIMIT 5'
    );
    console.log('Sample Active Scannable Drugs:');
    console.table(sample);

    console.log('\n' + '='.repeat(70));
    console.log('  ALL PHARMACY BARCODES AND CATALOGUE DATA 100% SYNCED TO PRODUCTION!');
    console.log('='.repeat(70) + '\n');
  } finally {
    await remoteConn.query('SET FOREIGN_KEY_CHECKS = 1');
    await localConn.end();
    await remoteConn.end();
  }
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
