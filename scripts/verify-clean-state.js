'use strict';
const mysql = require('mysql2/promise');

async function verifyDb(name, cfg) {
  console.log('='.repeat(70));
  console.log(`  VERIFYING CLEAN DATABASE STATE: ${name}`);
  console.log('='.repeat(70));

  const conn = await mysql.createConnection(cfg);

  // 1. Branches
  const [branches] = await conn.query('SELECT id, code, name, address, is_default, active FROM branches');
  console.log(`Branches (${branches.length}):`);
  console.table(branches);

  // 2. OP Rooms
  const [rooms] = await conn.query('SELECT id, name, floor FROM op_rooms ORDER BY id');
  console.log(`OP Rooms (${rooms.length}):`);
  console.table(rooms);

  // 3. Queue Categories count and sample
  const [catCount] = await conn.query('SELECT COUNT(*) as c FROM queue_categories');
  const [badCats] = await conn.query("SELECT id, code, name FROM queue_categories WHERE code NOT BETWEEN '01' AND '22'");
  console.log(`Queue Categories Total: ${catCount[0].c}, Non-canonical: ${badCats.length}`);

  // 4. Consumables count and check
  const [conCount] = await conn.query('SELECT COUNT(*) as c FROM consumables');
  const [badCons] = await conn.query("SELECT id, name FROM consumables WHERE id >= 324 OR name LIKE '%1795%'");
  console.log(`Consumables Total: ${conCount[0].c}, Test items: ${badCons.length}`);

  // 5. Expense Items count and check
  const [expCount] = await conn.query('SELECT COUNT(*) as c FROM expense_items');
  const [badExp] = await conn.query("SELECT id, name FROM expense_items WHERE id >= 205 OR name LIKE '%1795%'");
  console.log(`Expense Items Total: ${expCount[0].c}, Test items: ${badExp.length}`);

  // 6. Assets count
  const [assetCount] = await conn.query('SELECT COUNT(*) as c FROM assets');
  console.log(`Assets Total: ${assetCount[0].c}`);

  // 7. Check if any table has branch_id != 1
  const [cols] = await conn.query(`
    SELECT TABLE_NAME 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = 'branch_id'
  `, [cfg.database]);

  let anyBad = false;
  for (const col of cols) {
    if (col.TABLE_NAME === 'branches') continue;
    const [cnt] = await conn.query(`SELECT COUNT(*) as c FROM \`${col.TABLE_NAME}\` WHERE branch_id > 1`);
    if (cnt[0].c > 0) {
      console.log(`  [!] Table ${col.TABLE_NAME} has ${cnt[0].c} records with branch_id > 1`);
      anyBad = true;
    }
  }
  if (!anyBad) {
    console.log('[✓] All tables with branch_id are strictly aligned to Branch ID 1 (Melapalayam)');
  }

  await conn.end();
  console.log('\n');
}

async function main() {
  await verifyDb('REMOTE PRODUCTION (76.13.243.217)', {
    host: '76.13.243.217',
    user: 'samihahospitals_app_user',
    password: 'bka@6202#db',
    database: 'samihahospitals_app_db',
  });

  await verifyDb('LOCAL DEV (localhost)', {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'samiha-polyclinic',
  });
}

main().catch(console.error);
