'use strict';
const mysql = require('mysql2/promise');

async function compare() {
  const local = await mysql.createConnection({ host: 'localhost', user: 'root', password: '', database: 'samiha-polyclinic' });
  const remote = await mysql.createConnection({ host: '76.13.243.217', user: 'samihahospitals_app_user', password: 'bka@6202#db', database: 'samihahospitals_app_db' });

  const [tables] = await local.query('SHOW TABLES');
  const tKey = Object.keys(tables[0])[0];

  const diffs = [];
  for (const t of tables) {
    const tableName = t[tKey];
    try {
      const [lCount] = await local.query('SELECT COUNT(*) AS c FROM `' + tableName + '`');
      const [rCount] = await remote.query('SELECT COUNT(*) AS c FROM `' + tableName + '`');
      const lc = lCount[0].c;
      const rc = rCount[0].c;
      if (lc !== rc || lc > 0) {
        diffs.push({ table: tableName, local: lc, remote: rc, match: lc === rc ? 'YES' : 'DIFF' });
      }
    } catch (err) {
      diffs.push({ table: tableName, error: err.message });
    }
  }

  console.log('--- ALL TABLES WITH DATA OR ROW COUNT DIFFERENCES ---');
  console.table(diffs);

  await local.end();
  await remote.end();
}
compare().catch(console.error);
