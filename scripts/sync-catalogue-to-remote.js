'use strict';
const mysql = require('mysql2/promise');

async function main() {
  console.log('='.repeat(70));
  console.log('  SYNCING MASTER CATALOGUE TO REMOTE PRODUCTION (76.13.243.217)');
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

  const CATALOGUE_TABLES = [
    'branches',
    'queue_categories',
    'op_rooms',
    'op_room_categories',
    'expense_categories',
    'expense_items',
    'consumable_areas',
    'consumables',
    'asset_item_codes',
    'doctor_availability',
    'doctor_schedules',
  ];

  await remoteConn.query('SET FOREIGN_KEY_CHECKS = 0');

  try {
    for (const table of CATALOGUE_TABLES) {
      const [remoteCount] = await remoteConn.query(`SELECT COUNT(*) AS c FROM \`${table}\``);
      if (remoteCount[0].c === 0) {
        const [rows] = await localConn.query(`SELECT * FROM \`${table}\``);
        if (rows.length > 0) {
          const cols = Object.keys(rows[0]);
          const colList = cols.map(c => `\`${c}\``).join(', ');
          const placeholders = cols.map(() => '?').join(', ');
          const sql = `INSERT INTO \`${table}\` (${colList}) VALUES (${placeholders})`;

          for (const row of rows) {
            const values = cols.map(c => row[c]);
            await remoteConn.query(sql, values);
          }
          console.log(`  ✔ Synced ${rows.length} rows to remote table \`${table}\``);
        }
      } else {
        console.log(`  ✔ Remote table \`${table}\` already has ${remoteCount[0].c} rows`);
      }
    }

    // Backfill branch_id = 1 on existing remote historical rows if null
    const [defBranch] = await remoteConn.query("SELECT id FROM branches WHERE is_default = 1 LIMIT 1");
    if (defBranch.length > 0) {
      const branchId = defBranch[0].id;
      const BRANCHED = ['patients', 'appointments', 'visits', 'invoices',
        'payments', 'pharmacy_sales', 'cash_book', 'expenses', 'lab_orders', 'enquiries', 'admissions'];
      for (const t of BRANCHED) {
        const [res] = await remoteConn.query(`UPDATE \`${t}\` SET branch_id = ? WHERE branch_id IS NULL`, [branchId]);
        if (res.affectedRows > 0) {
          console.log(`  ✔ Stamped branch_id = ${branchId} on ${res.affectedRows} existing rows in \`${t}\``);
        }
      }
    }

  } finally {
    await remoteConn.query('SET FOREIGN_KEY_CHECKS = 1');
    await localConn.end();
    await remoteConn.end();
  }

  console.log('\n' + '='.repeat(70));
  console.log('  REMOTE PRODUCTION DATABASE CATALOGUE IS FULLY POPULATED & READY!');
  console.log('='.repeat(70) + '\n');
}

main().catch((err) => {
  console.error('Catalogue sync failed:', err);
  process.exit(1);
});
