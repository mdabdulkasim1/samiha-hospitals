'use strict';
/* Wipe the database and start over. Development only — it destroys everything. */
const fs = require('fs');
const config = require('../config');

for (const suffix of ['', '-wal', '-shm']) {
  const file = config.dbFile + suffix;
  if (fs.existsSync(file)) { fs.unlinkSync(file); console.log('removed', file); }
}
require('./index');
require('./seed');
console.log('Database rebuilt and seeded.');
