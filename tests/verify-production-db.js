'use strict';
const assert = require('node:assert');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function main() {
  const envContent = fs.readFileSync(path.join(__dirname, '../.env.production'), 'utf8');
  const dbHost = envContent.match(/DB_HOST=([^\r\n]+)/)?.[1]?.trim() || '76.13.243.217';
  const dbPort = Number(envContent.match(/DB_PORT=([^\r\n]+)/)?.[1]?.trim() || 3306);
  const dbUser = envContent.match(/DB_USER=([^\r\n]+)/)?.[1]?.trim() || 'samihahospitals_app_user';
  let dbPass = envContent.match(/DB_PASSWORD=([^\r\n]+)/)?.[1]?.trim() || 'bka@6202#db';
  if ((dbPass.startsWith('"') && dbPass.endsWith('"')) || (dbPass.startsWith("'") && dbPass.endsWith("'"))) {
    dbPass = dbPass.slice(1, -1);
  }
  const dbName = envContent.match(/DB_NAME=([^\r\n]+)/)?.[1]?.trim() || 'samihahospitals_app_db';

  console.log('='.repeat(70));
  console.log(`  TESTING PRODUCTION DATABASE (${dbUser}@${dbHost}:${dbPort}/${dbName})`);
  console.log('='.repeat(70));

  const conn = await mysql.createConnection({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPass,
    database: dbName,
    dateStrings: true,
  });

  try {
    // 1. Check user access & table count
    const [tables] = await conn.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      ['samihahospitals_app_db']
    );
    assert.strictEqual(tables.length, 104, 'Must have exactly 104 tables');
    console.log(`  ✔ All ${tables.length} tables confirmed in production database`);

    // 2. Check active triggers
    const [triggers] = await conn.query(
      'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?',
      ['samihahospitals_app_db']
    );
    assert.strictEqual(triggers.length, 12, 'Must have 12 auto-branch triggers');
    console.log(`  ✔ All ${triggers.length} auto-branch triggers confirmed`);

    // 3. Test julianday function
    const [jd] = await conn.query("SELECT julianday('now') AS jd");
    assert.ok(jd[0].jd > 0, 'julianday function must return a valid timestamp');
    console.log(`  ✔ julianday() function confirmed (${jd[0].jd})`);

    // 4. Test CRUD capability with production user permissions
    const [insert] = await conn.query(
      'INSERT INTO asset_item_codes (name, code, category) VALUES (?, ?, ?)',
      ['Prod Verification Code', 'PVC01', 'medical']
    );
    const newId = insert.insertId;
    assert.ok(newId > 0);

    const [read] = await conn.query('SELECT * FROM asset_item_codes WHERE id = ?', [newId]);
    assert.strictEqual(read[0].code, 'PVC01');

    await conn.query('UPDATE asset_item_codes SET code = ? WHERE id = ?', ['PVD01', newId]);
    const [updated] = await conn.query('SELECT code FROM asset_item_codes WHERE id = ?', [newId]);
    assert.strictEqual(updated[0].code, 'PVD01');

    await conn.query('DELETE FROM asset_item_codes WHERE id = ?', [newId]);
    const [deleted] = await conn.query('SELECT id FROM asset_item_codes WHERE id = ?', [newId]);
    assert.strictEqual(deleted.length, 0);
    console.log('  ✔ Complete INSERT, SELECT, UPDATE, DELETE permissions verified for samihahospitals_app_user');

    // 5. Verify staff and owner
    const [owner] = await conn.query("SELECT id, name, email, role, active FROM users WHERE role = 'owner'");
    assert.strictEqual(owner.length, 1);
    assert.strictEqual(owner[0].active, 1);
    console.log(`  ✔ Owner account verified: ${owner[0].name} (${owner[0].email})`);

    const [admin] = await conn.query("SELECT id, name, email, role, active FROM users WHERE email = 'admin@samiha.local'");
    assert.strictEqual(admin.length, 1);
    assert.strictEqual(admin[0].active, 1);
    console.log(`  ✔ Admin account verified: ${admin[0].name} (${admin[0].email})`);

    console.log('\n' + '='.repeat(70));
    console.log('  PRODUCTION DATABASE IS 100% READY & FULLY OPERATIONAL!');
    console.log('='.repeat(70) + '\n');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Production DB verification failed:', err);
  process.exit(1);
});
