'use strict';
const { runAsWorker } = require('synckit');
const mysql = require('mysql2/promise');
const config = require('../config');

let pool = null;

async function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: config.mysql?.host || 'localhost',
    port: Number(config.mysql?.port || 3306),
    user: config.mysql?.user || 'root',
    password: config.mysql?.password || '',
    database: config.mysql?.database || 'samiha-polyclinic',
    connectionLimit: 15,
    charset: 'utf8mb4',
    dateStrings: true,
    decimalNumbers: true,
  });
  pool.on('connection', (c) => {
    c.query("SET sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT,ANSI_QUOTES')");
  });
  return pool;
}

function translateSql(sql) {
  if (!sql || typeof sql !== 'string') return sql;
  let s = sql;
  // INSERT OR IGNORE -> INSERT IGNORE
  s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT IGNORE INTO');
  // INSERT OR REPLACE -> REPLACE
  s = s.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'REPLACE INTO');

  // SQLite GROUP_CONCAT(expr, separator) -> GROUP_CONCAT(expr SEPARATOR separator)
  s = s.replace(/GROUP_CONCAT\(\s*([^,]+?)\s*,\s*('[^']+'|"[^"]+")\s*\)/gi, 'GROUP_CONCAT($1 SEPARATOR $2)');

  // SQLite strftime('%Y-%m', col) -> DATE_FORMAT(col, '%Y-%m')
  s = s.replace(/strftime\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/gi, 'DATE_FORMAT($2, \'$1\')');

  // SQLite dynamic date/datetime interval additions/subtractions:
  s = s.replace(/date\(\s*'now'\s*,\s*'\+'\s*\|\|\s*\?\s*\|\|\s*'\s*days?'\s*\)/gi, 'DATE_ADD(CURDATE(), INTERVAL ? DAY)');
  s = s.replace(/date\(\s*'now'\s*,\s*'-'\s*\|\|\s*\?\s*\|\|\s*'\s*days?'\s*\)/gi, 'DATE_SUB(CURDATE(), INTERVAL ? DAY)');
  s = s.replace(/datetime\(\s*'now'\s*,\s*'-'\s*\|\|\s*\?\s*\|\|\s*'\s*minutes?'\s*\)/gi, 'DATE_SUB(NOW(), INTERVAL ? MINUTE)');

  // SQLite static date/datetime interval additions/subtractions on any expression:
  s = s.replace(/date\(\s*([^,\)]+?)\s*,\s*'\+(\d+)\s+days?'\s*\)/gi, (m, expr, n) => {
    const base = expr.replace(/['"`]/g, '').toLowerCase() === 'now' ? 'CURDATE()' : expr;
    return `DATE_ADD(${base}, INTERVAL ${n} DAY)`;
  });
  s = s.replace(/date\(\s*([^,\)]+?)\s*,\s*'-(\d+)\s+days?'\s*\)/gi, (m, expr, n) => {
    const base = expr.replace(/['"`]/g, '').toLowerCase() === 'now' ? 'CURDATE()' : expr;
    return `DATE_SUB(${base}, INTERVAL ${n} DAY)`;
  });
  s = s.replace(/datetime\(\s*([^,\)]+?)\s*,\s*'\+(\d+)\s+(day|hour|minute|second)s?'\s*\)/gi, (m, expr, n, u) => {
    const base = expr.replace(/['"`]/g, '').toLowerCase() === 'now' ? 'NOW()' : expr;
    return `DATE_ADD(${base}, INTERVAL ${n} ${u.toUpperCase()})`;
  });
  s = s.replace(/datetime\(\s*([^,\)]+?)\s*,\s*'-(\d+)\s+(day|hour|minute|second)s?'\s*\)/gi, (m, expr, n, u) => {
    const base = expr.replace(/['"`]/g, '').toLowerCase() === 'now' ? 'NOW()' : expr;
    return `DATE_SUB(${base}, INTERVAL ${n} ${u.toUpperCase()})`;
  });

  // Current date/datetime:
  s = s.replace(/datetime\(\s*'now'\s*\)/gi, 'NOW()');
  s = s.replace(/date\(\s*'now'\s*\)/gi, 'CURDATE()');

  // SQLite datetime(column) -> CAST(column AS DATETIME)
  s = s.replace(/datetime\(\s*([a-zA-Z0-9_\.]+)\s*\)/gi, 'CAST($1 AS DATETIME)');

  // SQLite scalar MAX(a, b) and MIN(a, b) -> MySQL GREATEST(a, b) and LEAST(a, b)
  s = s.replace(/\bMAX\s*\(\s*([^,\)]+?)\s*,\s*([^,\)]+?)\s*\)/gi, 'GREATEST($1, $2)');
  s = s.replace(/\bMIN\s*\(\s*([^,\)]+?)\s*,\s*([^,\)]+?)\s*\)/gi, 'LEAST($1, $2)');

  // ON CONFLICT (col1, col2) DO UPDATE SET -> ON DUPLICATE KEY UPDATE
  s = s.replace(/ON\s+CONFLICT\s*\([^\)]+\)\s*DO\s+UPDATE\s+SET/gi, 'ON DUPLICATE KEY UPDATE');
  // excluded.col -> VALUES(col)
  s = s.replace(/\bexcluded\.([a-zA-Z0-9_]+)\b/gi, 'VALUES($1)');

  // sqlite_master table lookup
  s = s.replace(/FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'table'\s+AND\s+name\s+NOT\s+LIKE\s*'sqlite_%'/gi,
    "FROM (SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE') AS sqlite_master WHERE 1=1");

  // Escape reserved word `lines` (used as column alias in financial reports)
  s = s.replace(/\bAS\s+lines\b/gi, 'AS `lines`');

  // SQLite weekly and monthly modifiers
  s = s.replace(/date\(\s*([^,\s)]+)\s*,\s*'weekday 1'\s*,\s*'-7 days'\s*\)/gi, 'DATE_SUB(DATE($1), INTERVAL WEEKDAY($1) DAY)');
  s = s.replace(/date\(\s*([^,\s)]+)\s*,\s*'start of month'\s*\)/gi, 'DATE_FORMAT($1, \'%Y-%m-01\')');

  // SQLite IS NOT ? / IS ? with null-safe comparison in MySQL
  s = s.replace(/\b([a-zA-Z0-9_\.]+)\s+IS\s+NOT\s+\?/gi, 'NOT ($1 <=> ?)');
  s = s.replace(/\b([a-zA-Z0-9_\.]+)\s+IS\s+\?/gi, '$1 <=> ?');

  // Escape reserved word `key` on settings & request_context tables
  s = s.replace(/(\bSELECT\s+)key(\s*,\s*value\s+FROM\s+(?:settings|request_context))/gi, '$1`key`$2');
  s = s.replace(/(\b(?:settings|request_context)\s+WHERE\s+)key(\s*(=|IN|\b))/gi, '$1`key`$2');
  s = s.replace(/(\bWHERE\s+)key(\s*(=|IN|\b))/gi, '$1`key`$2');
  s = s.replace(/(\b(?:INSERT(?:\s+IGNORE)?|REPLACE)\s+INTO\s+(?:settings|request_context)\s*\(\s*)key(\s*,)/gi, '$1`key`$2');
  s = s.replace(/(\bON\s+DUPLICATE\s+KEY\s+UPDATE\s+)key(\s*=)/gi, '$1`key`$2');

  // Add alias to naked subqueries in FROM clause e.g. FROM (SELECT ...) -> FROM (SELECT ...) AS _derived
  s = s.replace(/(\bFROM\s*\(\s*SELECT\b[\s\S]+?\))\s*(;|\s*$)/gi, (m, sub, end) => {
    if (/\bAS\s+[a-zA-Z0-9_`"']+\s*$/i.test(sub)) return m;
    return `${sub} AS _derived${end}`;
  });

  // Include reorder_level in SELECT and GROUP BY for drugs low-stock subqueries
  s = s.replace(/SELECT\s+d\.id\s+FROM\s+drugs\s+d([\s\S]+?)GROUP\s+BY\s+d\.id([\s\S]+?d\.reorder_level)/gi,
    'SELECT d.id, d.reorder_level FROM drugs d$1GROUP BY d.id, d.reorder_level$2');

  // Replace SQLite double-quoted identifiers with MySQL backticks: "col" -> `col`
  s = s.replace(/"([a-zA-Z0-9_]+)"/g, '`$1`');

  // SQLite double pipe string concat works with PIPES_AS_CONCAT
  return s;
}

runAsWorker(async ({ action, sql, params = [] }) => {
  const p = await getPool();
  const querySql = translateSql(sql);

  // Normalize ISO datetime parameters (e.g. 2026-11-22T08:00:16.461Z) to MySQL format (2026-11-22 08:00:16)
  const cleanParams = (Array.isArray(params) ? params : []).map((val) => {
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(val)) {
      return val.slice(0, 19).replace('T', ' ');
    }
    return val;
  });

  if (action === 'get') {
    const [rows] = await p.query(querySql, cleanParams);
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }
  if (action === 'all') {
    const [rows] = await p.query(querySql, cleanParams);
    return Array.isArray(rows) ? rows : [];
  }
  if (action === 'run') {
    const [res] = await p.query(querySql, cleanParams);
    return {
      changes: res ? res.affectedRows : 0,
      lastInsertRowid: res ? res.insertId : 0,
    };
  }
  if (action === 'exec') {
    // If multiple statements separated by ';'
    const stmts = querySql.split(';').map(x => x.trim()).filter(Boolean);
    for (const stmt of stmts) {
      await p.query(stmt);
    }
    return true;
  }
  if (action === 'health') {
    const [rows] = await p.query('SELECT 1 as ok');
    return { ok: true, engine: 'mysql' };
  }
  throw new Error('Unknown action: ' + action);
});
