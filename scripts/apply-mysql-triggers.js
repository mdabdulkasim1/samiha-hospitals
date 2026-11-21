'use strict';
const mysql = require('mysql2/promise');
const config = require('../src/config');

const BRANCHED = [
  'patients',
  'appointments',
  'visits',
  'queue_tokens',
  'invoices',
  'payments',
  'pharmacy_sales',
  'cash_book',
  'expenses',
  'lab_orders',
  'enquiries',
  'admissions',
];

async function applyTriggers() {
  console.log('[triggers] Connecting to MySQL...');
  const conn = await mysql.createConnection(config.mysql);

  try {
    for (const table of BRANCHED) {
      console.log(`[triggers] Setting up auto-branch trigger for ${table}...`);
      await conn.query(`DROP TRIGGER IF EXISTS \`trg_${table}_branch\``);
      const sql = `
        CREATE TRIGGER \`trg_${table}_branch\` BEFORE INSERT ON \`${table}\`
        FOR EACH ROW
        BEGIN
          IF NEW.branch_id IS NULL THEN
            SET NEW.branch_id = (SELECT CAST(\`value\` AS UNSIGNED) FROM \`request_context\` WHERE \`key\` = 'branch_id');
          END IF;
        END
      `;
      await conn.query(sql);
    }
    console.log('[triggers] All 12 MySQL branch triggers created successfully.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  applyTriggers().catch((err) => {
    console.error('[triggers] Failed to apply triggers:', err);
    process.exit(1);
  });
}

module.exports = { applyTriggers };
