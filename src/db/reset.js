'use strict';
const fs = require('fs');
const config = require('../config');
for (const suffix of ['', '-wal', '-shm']) {
  const f = config.dbFile + suffix;
  if (fs.existsSync(f)) { fs.unlinkSync(f); console.log('removed', f); }
}
console.log('Database reset. Run `npm run setup` to rebuild.');
