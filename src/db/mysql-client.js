'use strict';
const path = require('path');
const { createSyncFn } = require('synckit');

const workerPath = path.resolve(__dirname, 'mysql-sync-worker.js');
const syncCall = createSyncFn(workerPath);

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

  pragma(_sql) {
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

  close() {
    // Worker pool cleanup if needed
  },
};

module.exports = mysqlDb;

