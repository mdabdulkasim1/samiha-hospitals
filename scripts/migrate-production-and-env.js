'use strict';
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function parseEnv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  }
  return env;
}

async function ensureJulianday(conn) {
  try {
    await conn.query('DROP FUNCTION IF EXISTS julianday');
    await conn.query(`
      CREATE FUNCTION julianday(d VARCHAR(255))
      RETURNS DOUBLE
      DETERMINISTIC
      NO SQL
      BEGIN
        IF d IS NULL THEN RETURN NULL; END IF;
        IF d = 'now' THEN RETURN UNIX_TIMESTAMP(NOW()) / 86400.0 + 2440587.5; END IF;
        RETURN UNIX_TIMESTAMP(d) / 86400.0 + 2440587.5;
      END
    `);
    console.log('    ✔ julianday() function verified/created');
  } catch (err) {
    console.warn('    ⚠ Note creating julianday():', err.message);
  }
}

async function migrateTarget(name, dbConfig) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  MIGRATING DATABASE: ${name} (${dbConfig.database})`);
  console.log(`${'='.repeat(70)}`);

  const conn = await mysql.createConnection({
    host: dbConfig.host || 'localhost',
    port: Number(dbConfig.port || 3306),
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    multipleStatements: true,
    dateStrings: true,
  });

  try {
    // 1. Check if base tables exist
    const [userTable] = await conn.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'",
      [dbConfig.database]
    );

    if (userTable.length === 0) {
      console.log(`  [1/4] Initializing base schema from mysql-schema.sql...`);
      const schemaSql = fs.readFileSync(path.join(__dirname, '../src/db/mysql-schema.sql'), 'utf8');
      await conn.query(schemaSql);
      console.log(`    ✔ Base tables created successfully`);
    } else {
      console.log(`  [1/4] Base schema already present.`);
    }

    // 2. Run incremental migrations (19 missing tables + columns + indexes)
    console.log(`  [2/4] Applying latest schema migrations (tables, columns, indexes)...`);
    const { run: runLatest } = require('./migrate-mysql-latest');
    
    // Temporarily point config.mysql to target
    const config = require('../src/config');
    const oldMysql = { ...config.mysql };
    config.mysql = {
      host: dbConfig.host || 'localhost',
      port: Number(dbConfig.port || 3306),
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
    };

    await runLatest();
    config.mysql = oldMysql; // restore
    console.log(`    ✔ Incremental migrations applied`);

    // 3. Ensure julianday function
    console.log(`  [3/4] Verifying SQL functions...`);
    await ensureJulianday(conn);

    // 4. Audit target
    console.log(`  [4/4] Auditing target schema completeness...`);
    const [tblRows] = await conn.query(
      "SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
      [dbConfig.database]
    );
    const [trgRows] = await conn.query(
      "SELECT COUNT(*) AS c FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?",
      [dbConfig.database]
    );
    const [ownerRows] = await conn.query(
      "SELECT id, name, email, role, active FROM users WHERE role = 'owner'"
    );

    console.log(`    ✔ Tables present: ${tblRows[0].c}`);
    console.log(`    ✔ Active Triggers: ${trgRows[0].c}`);
    console.log(`    ✔ Active Owner: ${ownerRows.length > 0 ? ownerRows[0].name + ' (' + ownerRows[0].email + ')' : 'None'}`);

  } finally {
    await conn.end();
  }
}

async function copyMasterCatalogueIfEmpty(rootConn, sourceDb, targetDb) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  CHECKING MASTER CATALOGUE SYNC: \`${sourceDb}\` -> \`${targetDb}\``);
  console.log(`${'='.repeat(70)}`);

  const MASTER_TABLES = [
    'users',
    'branches',
    'settings',
    'counters',
    'departments',
    'doctor_profiles',
    'doctor_availability',
    'doctor_schedules',
    'queue_categories',
    'op_rooms',
    'op_room_categories',
    'services',
    'lab_tests',
    'lab_package_items',
    'drugs',
    'suppliers',
    'insurers',
    'wards',
    'beds',
    'sliding_scale_bands',
    'poverty_guidelines',
    'icd_codes',
    'expense_categories',
    'expense_items',
    'consumable_areas',
    'consumables',
    'asset_item_codes',
  ];

  await rootConn.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    // Check if target users has only 1 row or missing doctor IDs
    const [targetUsersCount] = await rootConn.query(`SELECT COUNT(*) AS c FROM \`${targetDb}\`.users`);
    const [sourceUsersCount] = await rootConn.query(`SELECT COUNT(*) AS c FROM \`${sourceDb}\`.users`);
    if (targetUsersCount[0].c < sourceUsersCount[0].c) {
      await rootConn.query(`DELETE FROM \`${targetDb}\`.users`);
      await rootConn.query(`INSERT INTO \`${targetDb}\`.users SELECT * FROM \`${sourceDb}\`.users`);
      console.log(`  ✔ Synced all ${sourceUsersCount[0].c} users to \`${targetDb}\`.users with identical IDs`);
    }

    for (const table of MASTER_TABLES) {
      if (table === 'users') continue;
      const [targetCount] = await rootConn.query(`SELECT COUNT(*) AS c FROM \`${targetDb}\`.\`${table}\``);
      if (targetCount[0].c === 0) {
        const [sourceCount] = await rootConn.query(`SELECT COUNT(*) AS c FROM \`${sourceDb}\`.\`${table}\``);
        if (sourceCount[0].c > 0) {
          // Get common columns
          const [targetCols] = await rootConn.query(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            [targetDb, table]
          );
          const [sourceCols] = await rootConn.query(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            [sourceDb, table]
          );
          const sourceColSet = new Set(sourceCols.map(c => c.COLUMN_NAME));
          const common = targetCols.map(c => c.COLUMN_NAME).filter(c => sourceColSet.has(c));
          const colList = common.map(c => `\`${c}\``).join(', ');

          await rootConn.query(`INSERT INTO \`${targetDb}\`.\`${table}\` (${colList}) SELECT ${colList} FROM \`${sourceDb}\`.\`${table}\``);
          console.log(`  ✔ Copied ${sourceCount[0].c} rows to \`${targetDb}\`.\`${table}\``);
        }
      } else {
        console.log(`  ✔ \`${targetDb}\`.\`${table}\` already populated (${targetCount[0].c} rows)`);
      }
    }
  } finally {
    await rootConn.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

async function verifyProductionConnection(prodDb) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  VERIFYING PRODUCTION USER LOGIN & PERMISSIONS`);
  console.log(`${'='.repeat(70)}`);

  const conn = await mysql.createConnection({
    host: prodDb.host,
    port: Number(prodDb.port),
    user: prodDb.user,
    password: prodDb.password,
    database: prodDb.database,
  });

  try {
    const [testQuery] = await conn.query('SELECT DATABASE() AS db, USER() AS u, NOW() AS ts');
    console.log(`  ✔ Connected as ${testQuery[0].u} to database \`${testQuery[0].db}\``);

    const [tables] = await conn.query("SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [prodDb.database]);
    console.log(`  ✔ Total tables accessible: ${tables[0].c}`);

    const [owner] = await conn.query("SELECT id, name, email, role, active FROM users WHERE role = 'owner'");
    console.log(`  ✔ Owner account verified: ${owner[0]?.name} (${owner[0]?.email}) - active: ${owner[0]?.active}`);

    const [branch] = await conn.query("SELECT id, code, name, is_default, active FROM branches WHERE is_default = 1");
    console.log(`  ✔ Default branch verified: ${branch[0]?.code} (${branch[0]?.name})`);

    const [depts] = await conn.query("SELECT COUNT(*) AS c FROM departments");
    const [services] = await conn.query("SELECT COUNT(*) AS c FROM services");
    const [labTests] = await conn.query("SELECT COUNT(*) AS c FROM lab_tests");
    const [drugs] = await conn.query("SELECT COUNT(*) AS c FROM drugs");
    const [expCat] = await conn.query("SELECT COUNT(*) AS c FROM expense_categories");
    const [consumables] = await conn.query("SELECT COUNT(*) AS c FROM consumables");

    console.log(`  ✔ Master data counts in \`${prodDb.database}\`:`);
    console.log(`     - Departments: ${depts[0].c}`);
    console.log(`     - Services: ${services[0].c}`);
    console.log(`     - Diagnostic Tests: ${labTests[0].c}`);
    console.log(`     - Formularies / Drugs: ${drugs[0].c}`);
    console.log(`     - Expense Headings: ${expCat[0].c}`);
    console.log(`     - Consumable Items: ${consumables[0].c}`);
  } finally {
    await conn.end();
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('  DUAL DATABASE MIGRATION: DEVELOPMENT (.env) & PRODUCTION (.env.production)');
  console.log('='.repeat(70));

  // 1. Read .env and .env.production
  const devEnv = parseEnv(path.join(__dirname, '../.env'));
  const prodEnv = parseEnv(path.join(__dirname, '../.env.production'));

  const devDb = {
    host: devEnv.DB_HOST || 'localhost',
    port: devEnv.DB_PORT || 3306,
    user: devEnv.DB_USER || 'root',
    password: devEnv.DB_PASSWORD || '',
    database: devEnv.DB_NAME || 'samiha-polyclinic',
  };

  const prodDb = {
    host: prodEnv.DB_HOST || 'localhost',
    port: prodEnv.DB_PORT || 3306,
    user: prodEnv.DB_USER || 'samihahospitals_app_user',
    password: prodEnv.DB_PASSWORD || '',
    database: prodEnv.DB_NAME || 'samihahospitals_app_db',
  };

  // 2. Administrative setup of database & user
  console.log('\n[Setup] Verifying MySQL databases and user accounts via administrative connection...');
  const rootConn = await mysql.createConnection({
    host: devDb.host,
    port: Number(devDb.port),
    user: 'root',
    password: '',
    multipleStatements: true,
  });

  try {
    await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${devDb.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${prodDb.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    if (prodDb.user !== 'root') {
      await rootConn.query(`
        CREATE USER IF NOT EXISTS '${prodDb.user}'@'localhost' IDENTIFIED BY '${prodDb.password}';
        ALTER USER '${prodDb.user}'@'localhost' IDENTIFIED BY '${prodDb.password}';
        GRANT ALL PRIVILEGES ON \`${prodDb.database}\`.* TO '${prodDb.user}'@'localhost';
        FLUSH PRIVILEGES;
      `);
      console.log(`  ✔ User '${prodDb.user}'@'localhost' verified with access to \`${prodDb.database}\``);
    }

    // 3. Migrate Development Database (.env)
    await migrateTarget('Development Environment (.env)', devDb);

    // 4. Migrate Production Database (.env.production)
    await migrateTarget('Production Environment (.env.production)', prodDb);

    // 5. Copy master catalogue data to production database if empty
    await copyMasterCatalogueIfEmpty(rootConn, devDb.database, prodDb.database);

    // 6. Verify production user connection and privileges
    await verifyProductionConnection(prodDb);

  } finally {
    await rootConn.end();
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('  ALL MIGRATIONS SUCCESSFULLY APPLIED TO BOTH DATABASES!');
  console.log(`${'='.repeat(70)}\n`);
}

main().catch((err) => {
  console.error('\n❌ Migration failed:', err);
  process.exit(1);
});
