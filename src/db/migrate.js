'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { migrate } = require('./index');

async function migrateMysql() {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    multipleStatements: true,
  });

  try {
    // Check if `users` table exists
    const [rows] = await conn.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'",
      [config.mysql.database]
    );

    if (rows.length === 0) {
      console.log(`[migrate] Initializing MySQL tables in '${config.mysql.database}' from mysql-schema.sql...`);
      const schemaPath = path.join(__dirname, 'mysql-schema.sql');
      if (fs.existsSync(schemaPath)) {
        const sql = fs.readFileSync(schemaPath, 'utf8');
        await conn.query(sql);
        console.log('[migrate] MySQL tables created successfully.');
      } else {
        console.error('[migrate] Error: mysql-schema.sql not found at', schemaPath);
      }
    } else {
      console.log(`[migrate] MySQL active (${config.mysql.host}:${config.mysql.port}/${config.mysql.database}). Tables already exist.`);
    }

    // Apply incremental schema updates (new modules, branches, queue, consumables, expenses)
    const latestMigrate = require('../../scripts/migrate-mysql-latest');
    await latestMigrate.run();

    // Ensure julianday helper function exists
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
      console.log('[migrate] MySQL julianday() function verified/created.');
    } catch (fnErr) {
      console.warn('[migrate] Note: Could not register julianday() function:', fnErr.message);
    }
  } finally {
    await conn.end();
  }
}

async function main() {
  if (config.dbEngine === 'mysql') {
    await migrateMysql();
  } else {
    console.warn('[migrate] ⚠ SQLite is deprecated. Applying SQLite schema...');
    migrate();
    console.log('[migrate] SQLite schema applied.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[migrate] Migration error:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
