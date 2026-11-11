'use strict';
/**
 * MySQL Connection Pool and Query Helper for SAMIHA POLYCLINIC & DIAGNOSTICS.
 * Uses mysql2/promise for connection pooling and transaction handling.
 */
const mysql = require('mysql2/promise');
const config = require('../config');

let pool = null;

function getPool() {
  if (pool) return pool;

  pool = mysql.createPool({
    host: config.mysql?.host || process.env.DB_HOST || 'localhost',
    port: Number(config.mysql?.port || process.env.DB_PORT || 3306),
    user: config.mysql?.user || process.env.DB_USER || 'root',
    password: config.mysql?.password || process.env.DB_PASSWORD || '',
    database: config.mysql?.database || process.env.DB_NAME || 'samiha-polyclinic',
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0,
    charset: 'utf8mb4',
    namedPlaceholders: false,
    dateStrings: true,
    decimalNumbers: true,
  });

  // Enable PIPES_AS_CONCAT so SQLite-style string concatenations ('a' || ' ' || 'b') work seamlessly in MySQL
  pool.on('connection', (connection) => {
    connection.query("SET sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT')");
  });

  return pool;
}

/** Execute a parameterized query against the pool. */
async function query(sql, params = []) {
  const p = getPool();
  const [results] = await p.query(sql, params);
  return results;
}

/** Fetch a single row (similar to SQLite .get()). Returns null if not found. */
async function get(sql, params = []) {
  const p = getPool();
  const [rows] = await p.query(sql, params);
  return (Array.isArray(rows) && rows.length > 0) ? rows[0] : null;
}

/** Fetch all rows (similar to SQLite .all()). */
async function all(sql, params = []) {
  const p = getPool();
  const [rows] = await p.query(sql, params);
  return Array.isArray(rows) ? rows : [];
}

/** Execute an INSERT/UPDATE/DELETE statement (similar to SQLite .run()). */
async function run(sql, params = []) {
  const p = getPool();
  const [result] = await p.execute(sql, params);
  return {
    changes: result.affectedRows,
    lastInsertRowid: result.insertId,
  };
}

/** Run an async callback inside an ACID transaction on a dedicated connection. */
async function tx(fn) {
  const p = getPool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Quick health check */
async function health() {
  const start = Date.now();
  await query('SELECT 1 AS ok');
  return {
    ok: true,
    latencyMs: Date.now() - start,
    engine: 'mysql',
    database: config.mysql?.database || process.env.DB_NAME || 'samiha-polyclinic',
  };
}

/** Close the pool on server shutdown */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  getPool,
  query,
  get,
  all,
  run,
  tx,
  health,
  close,
};
