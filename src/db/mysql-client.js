'use strict';
const fs = require('fs');
const path = require('path');
const { createSyncFn } = require('synckit');

const workerPath = path.resolve(__dirname, 'mysql-sync-worker.js');
const syncCall = createSyncFn(workerPath);

let schemaFkCache = null;
function getForeignKeys(tableName) {
  if (!schemaFkCache) {
    schemaFkCache = {};
    try {
      const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      const tableRegex = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?([a-zA-Z0-9_]+)["`]?\s*\(([\s\S]*?)\n\);/g;
      let m;
      while ((m = tableRegex.exec(schemaSql)) !== null) {
        const table = m[1].toLowerCase();
        const body = m[2];
        const lines = body.split('\n');
        for (const line of lines) {
          const colMatch = line.match(/^\s*["`]?([a-zA-Z0-9_]+)["`]?\s+[^,]*?REFERENCES\s+["`]?([a-zA-Z0-9_]+)["`]?\s*\((["`]?([a-zA-Z0-9_]+)["`]?)?\)(?:\s+ON\s+DELETE\s+(CASCADE|SET NULL|RESTRICT|NO ACTION))?/i);
          if (colMatch) {
            if (!schemaFkCache[table]) schemaFkCache[table] = [];
            schemaFkCache[table].push({
              id: schemaFkCache[table].length,
              seq: 0,
              table: colMatch[2],
              from: colMatch[1],
              to: colMatch[4] || 'id',
              on_update: 'NO ACTION',
              on_delete: colMatch[5] ? colMatch[5].toUpperCase() : 'NO ACTION',
              match: 'NONE',
            });
          }
        }
      }
    } catch (_) {}
  }
  return schemaFkCache[tableName.toLowerCase()] || [];
}

class PreparedStatement {
  constructor(sql) {
    this.sql = sql;
  }

  get(...params) {
    const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    return syncCall({ action: 'get', sql: this.sql, params: flatParams });
  }

  all(...params) {
    const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    return syncCall({ action: 'all', sql: this.sql, params: flatParams });
  }

  run(...params) {
    const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    return syncCall({ action: 'run', sql: this.sql, params: flatParams });
  }
}

const mysqlDb = {
  prepare(sql) {
    return new PreparedStatement(sql);
  },

  exec(sql) {
    return syncCall({ action: 'exec', sql });
  },

  pragma(sql) {
    const s = String(sql || '').trim();
    const fkMatch = s.match(/foreign_key_list\(["'`]?([a-zA-Z0-9_]+)["'`]?\)/i);
    if (fkMatch) {
      return getForeignKeys(fkMatch[1]);
    }
    // PRAGMAs like journal_mode or foreign_keys in SQLite are handled by MySQL defaults
    return [];
  },

  transaction(fn) {
    return function (...args) {
      syncCall({ action: 'exec', sql: 'START TRANSACTION' });
      try {
        const result = fn(...args);
        syncCall({ action: 'exec', sql: 'COMMIT' });
        return result;
      } catch (err) {
        syncCall({ action: 'exec', sql: 'ROLLBACK' });
        throw err;
      }
    };
  },

  async backup(targetPath) {
    const { execFile } = require('child_process');
    const config = require('../config');
    const args = [
      `-h${config.mysql.host}`,
      `-P${config.mysql.port}`,
      `-u${config.mysql.user}`,
    ];
    if (config.mysql.password) {
      args.push(`-p${config.mysql.password}`);
    }
    args.push(config.mysql.database);

    return new Promise((resolve, reject) => {
      const outStream = fs.createWriteStream(targetPath);
      const child = execFile('mysqldump', args, { maxBuffer: 100 * 1024 * 1024 });
      child.stdout.pipe(outStream);
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`mysqldump exited with code ${code}: ${stderr}`));
        } else {
          resolve(targetPath);
        }
      });
    });
  },

  close() {
    // Worker pool cleanup if needed
  },
};

module.exports = mysqlDb;

