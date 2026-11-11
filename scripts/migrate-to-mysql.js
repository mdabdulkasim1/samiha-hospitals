'use strict';
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const Database = require('better-sqlite3');

const SQLITE_DB_PATH = path.resolve(__dirname, '../data/samiha.db');
const MYSQL_CONFIG = {
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: '',
  database: 'samiha-polyclinic',
  multipleStatements: true,
};

// Known type overrides for precise MySQL schema mapping
const TYPE_OVERRIDES = {
  // Long text / Images / Signatures / JSON
  'doctor_profiles.signature_image': 'LONGTEXT',
  'prescription_sheets.signature_image': 'LONGTEXT',
  'whatsapp_messages.payload': 'TEXT',
  'audit_logs.details': 'TEXT',
  'settings.value': 'TEXT',
  'complaints.details': 'TEXT',
  'safety_incidents.description': 'TEXT',
  'patient_notes.note': 'TEXT',
  'consultations.presenting_complaint': 'TEXT',
  'consultations.examination': 'TEXT',
  'consultations.clinical_impression': 'TEXT',
  'consultations.plan': 'TEXT',
  'ip_notes.note': 'TEXT',
  'preauth_events.notes': 'TEXT',
  'claim_events.notes': 'TEXT',
  'insurance_documents.notes': 'TEXT',
  'insurance_documents.file_data': 'LONGBLOB',
  'document_shares.content': 'LONGBLOB',
  'patients.consent_signed_at': 'DATETIME NULL',
  'patients.consent_signed_by': 'VARCHAR(255) NULL',
  'patients.consent_taken_by': 'INT NULL',
};

function inferMysqlType(tableName, col) {
  const fullKey = `${tableName}.${col.name}`;
  if (TYPE_OVERRIDES[fullKey]) return TYPE_OVERRIDES[fullKey];

  const name = col.name.toLowerCase();
  const rawType = (col.type || '').toUpperCase();

  // Dates and Timestamps first
  if (name.endsWith('_at') || name.endsWith('_date') || name === 'happened_on' ||
      name === 'on_date' || name === 'scheduled_at' || name === 'expires_at' ||
      name === 'dob' || name === 'as_on' || name === 'valid_till') {
    if (name.endsWith('_date') || name === 'dob' || name === 'on_date' ||
        name === 'happened_on' || name === 'as_on' || name === 'valid_till') {
      return 'DATE NULL';
    }
    return 'DATETIME NULL';
  }

  // User references / Staff / Taken by
  if (name.endsWith('_by') || name.endsWith('_id') || name === 'user_id' ||
      name === 'patient_id' || name === 'visit_id' || name === 'doctor_id' ||
      name === 'sheet_id' || name === 'order_id' || name === 'sale_id' ||
      name === 'batch_id' || name === 'drug_id' || name === 'test_id' ||
      name === 'admission_id' || name === 'sort_order' || name === 'age_years' ||
      name === 'slot_minutes' || name === 'max_tokens' || name === 'duration_days' ||
      name === 'pulse' || name === 'spo2' || name === 'rr' || name === 'pain_score' ||
      name === 'step' || name === 'count' || (name === 'value' && tableName === 'counters') ||
      name === 'id') {
    return 'INT NULL';
  }

  // Boolean flags
  if (name === 'active' || name.startsWith('is_') || name.startsWith('has_') ||
      name === 'consent_treatment' || name === 'consent_privacy' || name === 'consent_contact' ||
      name.startsWith('notify_') || name === 'mrp_includes_gst') {
    return 'TINYINT(1) NOT NULL DEFAULT ' + (col.dflt !== null && col.dflt !== undefined ? col.dflt : 0);
  }

  // Money, Rates, Taxes, Decimals
  if (name.includes('amount') || name.includes('fee') || name.includes('price') ||
      name.includes('tax') || name.includes('cgst') || name.includes('sgst') ||
      name === 'mrp' || name === 'net' || name === 'gross' || name === 'total' ||
      name === 'balance' || name === 'paid' || name === 'deposit' || name === 'discount' ||
      name === 'concession' || name === 'round_off') {
    return 'DECIMAL(12, 2) NOT NULL DEFAULT 0.00';
  }

  // Quantities & measurements (can be fractional)
  if (name.startsWith('dose_') || name === 'qty' || name.includes('quantity') ||
      name === 'temperature' || name === 'height' || name === 'weight' || name === 'bmi') {
    return 'DOUBLE NULL';
  }

  // Large strings / Text
  if (name.includes('notes') || name.includes('address') || name.includes('comment') ||
      name.includes('description') || name.includes('impression') || name.includes('payload') ||
      name.includes('data') || name.includes('text') || name === 'current_medications' ||
      name === 'immunisations') {
    return 'TEXT NULL';
  }

  // String codes, names, status, phones, emails
  if (name === 'token' || name === 'key' || name === 'uhid' || name === 'email') {
    return 'VARCHAR(255) NULL';
  }
  if (name === 'phone' || name === 'whatsapp' || name === 'staff_code' ||
      name === 'doctor_code' || name === 'code' || name === 'status' ||
      name === 'role' || name === 'gender' || name === 'blood_group') {
    return 'VARCHAR(100) NULL';
  }

  if (rawType.includes('INT')) return 'INT NULL';
  if (rawType.includes('REAL')) return 'DOUBLE NULL';

  return 'VARCHAR(255) NULL';
}

async function run() {
  console.log('Connecting to SQLite:', SQLITE_DB_PATH);
  const sqlite = new Database(SQLITE_DB_PATH);

  console.log('Connecting to MySQL: localhost / samiha-polyclinic');
  const mysqlConn = await mysql.createConnection(MYSQL_CONFIG);

  const tables = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();

  console.log(`Found ${tables.length} tables in SQLite. Generating MySQL schema...`);

  let schemaSql = `-- SAMIHA POLYCLINIC & DIAGNOSTICS — MySQL Schema\n`
    + `-- Auto-generated from SQLite database definition\n\n`
    + `SET FOREIGN_KEY_CHECKS = 0;\n\n`;

  const ddlStatements = [];

  for (const { name: table } of tables) {
    const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all();
    const pks = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);

    const colDefs = [];
    const hasSingleAutoPk = (pks.length === 1 && (pks[0].name === 'id' || (pks[0].type || '').toUpperCase().includes('INT')));

    for (const col of columns) {
      if (hasSingleAutoPk && col.name === pks[0].name) {
        colDefs.push(`  \`${col.name}\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY`);
      } else {
        let typeDef = inferMysqlType(table, col);
        colDefs.push(`  \`${col.name}\` ${typeDef}`);
      }
    }

    // If single non-auto PK (e.g. string PK like token or key)
    if (pks.length === 1 && !hasSingleAutoPk) {
      colDefs.push(`  PRIMARY KEY (\`${pks[0].name}\`)`);
    } else if (pks.length > 1) {
      colDefs.push(`  PRIMARY KEY (${pks.map((p) => `\`${p.name}\``).join(', ')})`);
    }

    const tableDdl = `DROP TABLE IF EXISTS \`${table}\`;\n`
      + `CREATE TABLE \`${table}\` (\n`
      + colDefs.join(',\n') + '\n'
      + `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`;

    ddlStatements.push(tableDdl);
    schemaSql += tableDdl + '\n\n';
  }

  schemaSql += `SET FOREIGN_KEY_CHECKS = 1;\n`;

  const schemaFile = path.resolve(__dirname, '../src/db/mysql-schema.sql');
  fs.writeFileSync(schemaFile, schemaSql, 'utf8');
  console.log(`Written MySQL schema DDL to: ${schemaFile}`);

  // Execute Schema in MySQL
  console.log('Applying schema to MySQL...');
  await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 0;');

  for (const ddl of ddlStatements) {
    await mysqlConn.query(ddl);
  }
  console.log('Schema applied successfully to MySQL.');

  // Migrate Data
  console.log('\n--- Starting Data Migration ---');
  const reconciliation = [];

  for (const { name: table } of tables) {
    const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
    if (rows.length === 0) {
      reconciliation.push({ table, sqliteCount: 0, mysqlCount: 0, status: 'MATCH (empty)' });
      continue;
    }

    // Prepare columns
    const cols = Object.keys(rows[0]);
    const colList = cols.map((c) => `\`${c}\``).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const insertSql = `INSERT INTO \`${table}\` (${colList}) VALUES (${placeholders})`;

    // Format dates & values for MySQL compatibility
    const normalizeValue = (val) => {
      if (val === undefined || val === null) return null;
      if (typeof val === 'string') {
        // Normalize ISO timestamp string if it ends with Z or has milliseconds
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
          return val.slice(0, 19).replace('T', ' ');
        }
      }
      if (typeof val === 'boolean') return val ? 1 : 0;
      return val;
    };

    // Insert rows
    for (const row of rows) {
      const values = cols.map((c) => normalizeValue(row[c]));
      await mysqlConn.execute(insertSql, values);
    }

    // Verify row count in MySQL
    const [mysqlResult] = await mysqlConn.query(`SELECT COUNT(*) as c FROM \`${table}\``);
    const mysqlCount = mysqlResult[0].c;

    const match = rows.length === mysqlCount;
    reconciliation.push({
      table,
      sqliteCount: rows.length,
      mysqlCount,
      status: match ? 'MATCH' : 'MISMATCH',
    });
    console.log(`Migrated ${table.padEnd(28)} : ${rows.length} rows -> ${mysqlCount} rows [${match ? 'OK' : 'MISMATCH'}]`);
  }

  await mysqlConn.query('SET FOREIGN_KEY_CHECKS = 1;');

  console.log('\n=============================================');
  console.log('         MIGRATION RECONCILIATION SUMMARY     ');
  console.log('=============================================');
  let allMatched = true;
  for (const r of reconciliation) {
    if (r.sqliteCount !== r.mysqlCount) {
      allMatched = false;
      console.error(`❌ ${r.table}: SQLite=${r.sqliteCount}, MySQL=${r.mysqlCount}`);
    }
  }

  if (allMatched) {
    console.log(`\n✅ 100% SUCCESS: All ${tables.length} tables matched perfectly between SQLite and MySQL!`);
  } else {
    console.error(`\n⚠ Some tables had discrepancies. Review above log.`);
  }

  sqlite.close();
  await mysqlConn.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
