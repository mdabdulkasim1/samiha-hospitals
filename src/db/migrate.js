'use strict';
const config = require('../config');
const { migrate } = require('./index');

if (config.dbEngine === 'mysql') {
  console.log(`[migrate] MySQL active (${config.mysql.host}:${config.mysql.port}/${config.mysql.database}). Schema maintained in MySQL.`);
} else {
  console.warn('[migrate] ⚠ SQLite is deprecated. Applying SQLite schema...');
  migrate();
  console.log('[migrate] SQLite schema applied.');
}
