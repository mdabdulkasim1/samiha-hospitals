'use strict';
const mysql = require('mysql2/promise');

const TARGETS = [
  {
    name: 'REMOTE PRODUCTION (76.13.243.217)',
    config: {
      host: '76.13.243.217',
      user: 'samihahospitals_app_user',
      password: 'bka@6202#db',
      database: 'samihahospitals_app_db',
    },
  },
  {
    name: 'LOCAL DEV (localhost)',
    config: {
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'samiha-polyclinic',
    },
  },
];

async function cleanDatabase(target) {
  console.log('='.repeat(70));
  console.log(`  CLEANING DUMMY & TEST DATA ON: ${target.name}`);
  console.log('='.repeat(70));

  let conn;
  try {
    conn = await mysql.createConnection({
      ...target.config,
      multipleStatements: true,
    });
  } catch (err) {
    console.warn(`[!] Skipping ${target.name} (unable to connect: ${err.message})`);
    return;
  }

  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');

    // 1. Point all references across all tables to Melapalayam branch_id = 1
    const [cols] = await conn.query(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = 'branch_id'
    `, [target.config.database]);

    for (const row of cols) {
      if (row.TABLE_NAME === 'branches') continue;
      const [res] = await conn.query(
        `UPDATE \`${row.TABLE_NAME}\` SET branch_id = 1 WHERE branch_id > 1`
      );
      if (res.affectedRows > 0) {
        console.log(`[✓] Updated ${res.affectedRows} row(s) in \`${row.TABLE_NAME}\` to branch_id = 1`);
      }
    }

    // Also update users.home_branch_id if exists
    try {
      await conn.query('UPDATE users SET home_branch_id = 1 WHERE home_branch_id > 1');
    } catch (_) {}

    // 2. Clean user_branches mapping
    const [delUb] = await conn.query('DELETE FROM user_branches WHERE branch_id > 1');
    if (delUb.affectedRows > 0) {
      console.log(`[✓] Removed ${delUb.affectedRows} stale user_branches records (branch_id > 1)`);
    }
    await conn.query(`
      INSERT IGNORE INTO user_branches (user_id, branch_id)
      SELECT id, 1 FROM users
    `);

    // 3. Remove all dummy branches (retain ONLY ID 1, Melapalayam MPM)
    const [delBranches] = await conn.query("DELETE FROM branches WHERE id > 1 OR code != 'MPM'");
    console.log(`[✓] Deleted dummy branches: ${delBranches.affectedRows}`);

    // Ensure branch 1 is properly titled and marked default
    await conn.query(`
      UPDATE branches 
      SET code = 'MPM', 
          name = 'Melapalayam', 
          address = 'Nethaji Road, Melapalayam - 627 005', 
          is_default = 1, 
          active = 1 
      WHERE id = 1
    `);
    console.log(`[✓] Verified Branch ID 1: 'MPM' (Melapalayam) set as the sole active default branch`);

    // 4. Consumables & movements: delete test entries
    const [delConMov] = await conn.query(`
      DELETE FROM consumable_movements 
      WHERE item_id >= 324 
         OR item_id IN (SELECT id FROM consumables WHERE name LIKE '%1795%' OR name LIKE 'Nitrile Examination Gloves Medium%')
    `);
    console.log(`[✓] Deleted dummy consumable movements: ${delConMov.affectedRows}`);

    const [delCons] = await conn.query(`
      DELETE FROM consumables 
      WHERE id >= 324 
         OR name LIKE '%1795%' 
         OR name LIKE 'Nitrile Examination Gloves Medium%'
    `);
    console.log(`[✓] Deleted dummy consumables: ${delCons.affectedRows}`);

    // 5. Expense payments, expenses & dummy expense items
    const [delExpPay] = await conn.query(`
      DELETE FROM expense_payments 
      WHERE expense_id IN (
        SELECT id FROM expenses 
        WHERE supplier_name LIKE '%Power & Maintenance%' 
           OR supplier_name LIKE '%Automated Facility%'
           OR item_id >= 205
           OR description LIKE '%UPS inverter%'
      )
    `);
    console.log(`[✓] Deleted dummy expense payments: ${delExpPay.affectedRows}`);

    const [delExp] = await conn.query(`
      DELETE FROM expenses 
      WHERE supplier_name LIKE '%Power & Maintenance%' 
         OR supplier_name LIKE '%Automated Facility%'
         OR item_id >= 205
         OR description LIKE '%UPS inverter%'
    `);
    console.log(`[✓] Deleted dummy expenses: ${delExp.affectedRows}`);

    const [delExpItems] = await conn.query(`
      DELETE FROM expense_items 
      WHERE id >= 205 
         OR name LIKE '%1795%' 
         OR name LIKE 'Automated Facility Testing%'
    `);
    console.log(`[✓] Deleted dummy expense items: ${delExpItems.affectedRows}`);

    // 6. Queue tokens (test tokens)
    const [delTokens] = await conn.query(`
      DELETE FROM queue_tokens 
      WHERE note LIKE '%test%' 
         OR note LIKE '%Automated%'
         OR category_id > 22 
         OR room_id NOT IN (1, 2, 3, 4, 5, 6)
    `);
    console.log(`[✓] Deleted test queue tokens: ${delTokens.affectedRows}`);

    // 7. OP Room Categories (dummy mappings)
    const [delRoomCats] = await conn.query(`
      DELETE FROM op_room_categories 
      WHERE room_id NOT IN (1, 2, 3, 4, 5, 6) 
         OR category_id > 22
    `);
    console.log(`[✓] Deleted dummy op_room_categories: ${delRoomCats.affectedRows}`);

    // 8. OP Rooms (keep only the 6 official clinic rooms)
    const [delRooms] = await conn.query(`
      DELETE FROM op_rooms 
      WHERE id > 6 
         OR name LIKE 'OP-T%' 
         OR name NOT IN ('OP-1', 'OP-2', 'OP-3', 'OP-4', 'USG', 'X-Ray')
    `);
    console.log(`[✓] Deleted dummy OP rooms: ${delRooms.affectedRows}`);

    // 9. Queue Categories (keep only official 22 categories)
    const [delCats] = await conn.query(`
      DELETE FROM queue_categories 
      WHERE id > 22 
         OR code NOT BETWEEN '01' AND '22' 
         OR name LIKE 'Specialist Test Unit%'
    `);
    console.log(`[✓] Deleted dummy queue categories: ${delCats.affectedRows}`);

    // 10. Clean test patients and their visits
    const [delVisits] = await conn.query(`
      DELETE FROM visits 
      WHERE patient_id IN (
        SELECT id FROM patients 
        WHERE (first_name = 'Kader' AND last_name = 'Mohideen') 
           OR uhid LIKE '%TEST%'
      )
    `);
    console.log(`[✓] Deleted test visits: ${delVisits.affectedRows}`);

    const [delPatients] = await conn.query(`
      DELETE FROM patients 
      WHERE (first_name = 'Kader' AND last_name = 'Mohideen') 
         OR uhid LIKE '%TEST%'
    `);
    console.log(`[✓] Deleted test patients: ${delPatients.affectedRows}`);

    // 11. Normalize doctor schedules
    const [sched] = await conn.query(
      'UPDATE doctor_schedules SET op_room_id = NULL WHERE op_room_id NOT IN (1, 2, 3, 4, 5, 6)'
    );
    if (sched.affectedRows > 0) {
      console.log(`[✓] Fixed doctor schedules with invalid room references: ${sched.affectedRows}`);
    }

    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log(`\n[SUCCESS] All dummy/test data cleaned successfully for ${target.name}!\n`);
  } catch (err) {
    console.error(`\n[ERROR] Cleanup failed on ${target.name}:`, err);
  } finally {
    await conn.end();
  }
}

async function main() {
  for (const target of TARGETS) {
    await cleanDatabase(target);
  }
}

main().catch(console.error);
