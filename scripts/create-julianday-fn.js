'use strict';
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    database: 'samiha-polyclinic',
  });

  try {
    await conn.query(`DROP FUNCTION IF EXISTS julianday`);
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
    console.log('julianday function created successfully!');

    const [rows] = await conn.query("SELECT julianday('now') as jnow, CAST(julianday('now') - julianday('2026-11-10 12:00:00') AS INTEGER) as days_diff");
    console.log('Test query result:', rows);
  } catch (err) {
    console.error('Failed:', err.message);
  }

  await conn.end();
}

main().catch(console.error);

