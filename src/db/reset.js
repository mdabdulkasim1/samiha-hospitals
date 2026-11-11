'use strict';
const fs = require('fs');
const config = require('../config');

if (config.dbEngine === 'mysql') {
  console.log(`[reset] MySQL database engine active (database: "${config.mysql.database}").`);
  console.log('[reset] To re-migrate or re-seed data from SQLite, run: node scripts/migrate-to-mysql.js');
} else {
  console.warn('[reset] ⚠ SQLite is deprecated.');
  for (const suffix of ['', '-wal', '-shm']) {
    const f = config.dbFile + suffix;
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log('removed', f); }
  }
  console.log('Database reset. Run `npm run setup` to rebuild.');
}
