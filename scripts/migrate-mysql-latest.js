'use strict';
const mysql = require('mysql2/promise');
const config = require('../src/config');

async function ensureColumn(conn, table, column, definition) {
  const [cols] = await conn.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [config.mysql.database, table, column]
  );
  if (cols.length === 0) {
    console.log(`[migrate] Adding column ${table}.${column}...`);
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    return true;
  }
  return false;
}

async function ensureIndex(conn, table, indexName, createIndexSql) {
  const [indexes] = await conn.query(
    'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?',
    [config.mysql.database, table, indexName]
  );
  if (indexes.length === 0) {
    console.log(`[migrate] Adding index ${indexName} on ${table}...`);
    try {
      await conn.query(createIndexSql);
    } catch (err) {
      console.warn(`[migrate] Index notice (${indexName}):`, err.message);
    }
  }
}

async function run() {
  console.log('[migrate] Connecting to MySQL...');
  const conn = await mysql.createConnection({
    ...config.mysql,
    multipleStatements: true,
  });

  try {
    // 1. Create missing tables
    const tableQueries = [
      `CREATE TABLE IF NOT EXISTS \`branches\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`code\` VARCHAR(50) NOT NULL UNIQUE,
        \`name\` VARCHAR(255) NOT NULL,
        \`address\` TEXT NULL,
        \`is_default\` TINYINT(1) NOT NULL DEFAULT 0,
        \`active\` TINYINT(1) NOT NULL DEFAULT 1,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`user_branches\` (
        \`user_id\` INT NOT NULL,
        \`branch_id\` INT NOT NULL,
        PRIMARY KEY (\`user_id\`, \`branch_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`request_context\` (
        \`key\` VARCHAR(100) NOT NULL PRIMARY KEY,
        \`value\` TEXT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`queue_categories\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`code\` VARCHAR(50) NOT NULL UNIQUE,
        \`name\` VARCHAR(255) NOT NULL,
        \`kind\` VARCHAR(50) NOT NULL DEFAULT 'consult',
        \`location\` TEXT NULL,
        \`sort_order\` INT NOT NULL DEFAULT 0,
        \`active\` TINYINT(1) NOT NULL DEFAULT 1,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`op_rooms\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`name\` VARCHAR(100) NOT NULL,
        \`floor\` VARCHAR(100) NOT NULL,
        \`floor_order\` INT NOT NULL DEFAULT 0,
        \`note\` TEXT NULL,
        \`active\` TINYINT(1) NOT NULL DEFAULT 1,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (\`floor\`, \`name\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`op_room_categories\` (
        \`room_id\` INT NOT NULL,
        \`category_id\` INT NOT NULL,
        \`sort_order\` INT NOT NULL DEFAULT 0,
        PRIMARY KEY (\`room_id\`, \`category_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`queue_tokens\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`category_id\` INT NOT NULL,
        \`issue_date\` DATE NOT NULL,
        \`seq\` INT NOT NULL,
        \`label\` VARCHAR(100) NOT NULL,
        \`patient_id\` INT NULL,
        \`visit_id\` INT NULL,
        \`doctor_id\` INT NULL,
        \`room_id\` INT NULL,
        \`status\` VARCHAR(50) NOT NULL DEFAULT 'waiting',
        \`called_at\` DATETIME NULL,
        \`called_by\` INT NULL,
        \`call_count\` INT NOT NULL DEFAULT 0,
        \`passed_at\` DATETIME NULL,
        \`serving_at\` DATETIME NULL,
        \`done_at\` DATETIME NULL,
        \`note\` TEXT NULL,
        \`issued_by\` INT NULL,
        \`branch_id\` INT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`asset_item_codes\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`code\` VARCHAR(50) NOT NULL UNIQUE,
        \`name\` VARCHAR(255) NOT NULL,
        \`category\` VARCHAR(100) NULL,
        \`active\` TINYINT(1) NOT NULL DEFAULT 1,
        \`created_by\` INT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`display_slides\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`title\` VARCHAR(255) NULL,
        \`mime\` VARCHAR(100) NOT NULL,
        \`bytes\` INT NOT NULL,
        \`content\` LONGBLOB NOT NULL,
        \`seconds\` INT NOT NULL DEFAULT 12,
        \`floor\` VARCHAR(100) NULL,
        \`from_date\` DATE NULL,
        \`to_date\` DATE NULL,
        \`from_time\` VARCHAR(50) NULL,
        \`to_time\` VARCHAR(50) NULL,
        \`sort_order\` INT NOT NULL DEFAULT 0,
        \`active\` TINYINT(1) NOT NULL DEFAULT 1,
        \`uploaded_by\` INT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`expense_categories\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`code\` VARCHAR(100) NOT NULL UNIQUE,
        \`name\` VARCHAR(255) NOT NULL,
        \`cost_group\` VARCHAR(50) NOT NULL DEFAULT 'operating',
        \`nature\` VARCHAR(50) NOT NULL DEFAULT 'operating',
        \`report_line\` VARCHAR(100) NULL,
        \`default_department\` VARCHAR(100) NOT NULL DEFAULT 'common',
        \`cash_category\` VARCHAR(100) NULL,
        \`is_direct\` TINYINT(1) NOT NULL DEFAULT 0,
        \`is_fixed\` TINYINT(1) NOT NULL DEFAULT 0,
        \`note\` TEXT NULL,
        \`seeded\` TINYINT(1) NOT NULL DEFAULT 0,
        \`active\` TINYINT(1) NOT NULL DEFAULT 1,
        \`sort_order\` INT NOT NULL DEFAULT 0,
        \`created_by\` INT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`expense_items\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`category_id\` INT NOT NULL,
        \`name\` VARCHAR(255) NOT NULL,
        \`seeded\` TINYINT(1) NOT NULL DEFAULT 0,
        \`active\` TINYINT(1) NOT NULL DEFAULT 1,
        \`sort_order\` INT NOT NULL DEFAULT 0,
        \`created_by\` INT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (\`category_id\`, \`name\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`expenses\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`ref_no\` VARCHAR(100) NOT NULL UNIQUE,
        \`category_id\` INT NOT NULL,
        \`item_id\` INT NULL,
        \`department\` VARCHAR(100) NOT NULL DEFAULT 'common',
        \`supplier_id\` INT NULL,
        \`supplier_name\` VARCHAR(255) NULL,
        \`description\` TEXT NULL,
        \`invoice_no\` VARCHAR(100) NULL,
        \`invoice_date\` DATE NOT NULL,
        \`period_from\` VARCHAR(50) NULL,
        \`period_to\` VARCHAR(50) NULL,
        \`taxable\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        \`tax\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        \`total\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        \`due_date\` DATE NULL,
        \`status\` VARCHAR(50) NOT NULL DEFAULT 'unpaid',
        \`paid\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        \`approved_by\` INT NULL,
        \`approved_at\` DATETIME NULL,
        \`approval_note\` TEXT NULL,
        \`notes\` TEXT NULL,
        \`voided_at\` DATETIME NULL,
        \`voided_by\` INT NULL,
        \`void_reason\` TEXT NULL,
        \`branch_id\` INT NULL,
        \`created_by\` INT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`expense_payments\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`expense_id\` INT NOT NULL,
        \`amount\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        \`paid_on\` DATE NOT NULL,
        \`mode\` VARCHAR(50) NOT NULL DEFAULT 'cash',
        \`reference\` VARCHAR(100) NULL,
        \`cash_book_id\` INT NULL,
        \`created_by\` INT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`expense_attachments\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`expense_id\` INT NOT NULL,
        \`kind\` VARCHAR(50) NOT NULL DEFAULT 'invoice',
        \`filename\` VARCHAR(255) NOT NULL,
        \`mime\` VARCHAR(100) NOT NULL,
        \`bytes\` INT NOT NULL DEFAULT 0,
        \`content\` LONGBLOB NOT NULL,
        \`uploaded_by\` INT NULL,
        \`uploaded_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`stock_snapshots\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`as_on\` DATE NOT NULL UNIQUE,
        \`units\` DOUBLE NOT NULL DEFAULT 0,
        \`value\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        \`batches\` INT NOT NULL DEFAULT 0,
        \`unpriced\` INT NOT NULL DEFAULT 0,
        \`notes\` TEXT NULL,
        \`taken_by\` INT NULL,
        \`taken_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`stock_snapshot_lines\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`snapshot_id\` INT NOT NULL,
        \`batch_id\` INT NOT NULL,
        \`drug_id\` INT NOT NULL,
        \`qty\` DOUBLE NOT NULL DEFAULT 0,
        \`cost\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        \`value\` DECIMAL(12,2) NOT NULL DEFAULT 0.00
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`consumable_areas\` (
        \`code\` VARCHAR(50) NOT NULL PRIMARY KEY,
        \`label\` VARCHAR(255) NOT NULL,
        \`sort_order\` INT NOT NULL DEFAULT 0,
        \`active\` TINYINT(1) NOT NULL DEFAULT 1
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`consumables\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`code\` VARCHAR(50) NOT NULL UNIQUE,
        \`name\` VARCHAR(255) NOT NULL,
        \`description\` TEXT NULL,
        \`area\` VARCHAR(50) NOT NULL,
        \`unit\` VARCHAR(50) NOT NULL DEFAULT 'No.',
        \`indent_qty\` DOUBLE NOT NULL DEFAULT 0,
        \`reorder_at\` DOUBLE NULL,
        \`seeded\` TINYINT(1) NOT NULL DEFAULT 0,
        \`active\` TINYINT(1) NOT NULL DEFAULT 1,
        \`sort_order\` INT NOT NULL DEFAULT 0,
        \`created_by\` INT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS \`consumable_movements\` (
        \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`item_id\` INT NOT NULL,
        \`kind\` VARCHAR(50) NOT NULL,
        \`qty\` DOUBLE NOT NULL DEFAULT 0,
        \`moved_on\` DATE NOT NULL,
        \`supplier\` VARCHAR(255) NULL,
        \`invoice_no\` VARCHAR(100) NULL,
        \`unit_cost\` DECIMAL(12,2) NULL,
        \`issued_to\` VARCHAR(255) NULL,
        \`reason\` TEXT NULL,
        \`notes\` TEXT NULL,
        \`created_by\` INT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ];

    for (const q of tableQueries) {
      await conn.query(q);
    }
    console.log('[migrate] Verified / created all 19 additional MySQL tables.');

    // 2. Ensure missing columns
    const columns = [
      ['users', 'op_room_id', 'INT NULL'],
      ['users', 'branch_id', 'INT NULL'],
      ['users', 'erased_at', 'DATETIME NULL'],
      ['users', 'erased_by', 'INT NULL'],
      ['users', 'erase_reason', 'TEXT NULL'],
      ['users', 'password_set_at', 'DATETIME NULL'],
      ['users', 'password_set_by', 'INT NULL'],
      ['users', 'whatsapp', 'VARCHAR(100) NULL'],

      ['departments', 'queue_category_id', 'INT NULL'],
      ['departments', 'kind', "VARCHAR(50) NOT NULL DEFAULT 'specialist'"],
      ['departments', 'sort_order', 'INT NOT NULL DEFAULT 0'],

      ['queue_categories', 'location', 'TEXT NULL'],

      ['patients', 'branch_id', 'INT NULL'],
      ['patients', 'relationship_to_primary', 'VARCHAR(100) NULL'],
      ['patients', 'guardian_name', 'VARCHAR(255) NULL'],
      ['patients', 'guardian_relation', 'VARCHAR(100) NULL'],
      ['patients', 'aadhaar_number', 'VARCHAR(50) NULL'],
      ['patients', 'stage', "VARCHAR(50) NOT NULL DEFAULT 'registered'"],
      ['patients', 'enquiry_at', 'DATETIME NULL'],

      ['appointments', 'branch_id', 'INT NULL'],
      ['visits', 'branch_id', 'INT NULL'],
      ['sessions', 'branch_id', 'INT NULL'],

      ['invoices', 'branch_id', 'INT NULL'],
      ['invoices', 'bill_discount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['invoices', 'bill_discount_reason', 'TEXT NULL'],

      ['payments', 'branch_id', 'INT NULL'],

      ['pharmacy_sales', 'branch_id', 'INT NULL'],
      ['pharmacy_sales', 'sale_type', "VARCHAR(50) NOT NULL DEFAULT 'prescription'"],
      ['pharmacy_sales', 'customer_name', 'VARCHAR(255) NULL'],
      ['pharmacy_sales', 'customer_phone', 'VARCHAR(50) NULL'],
      ['pharmacy_sales', 'rx_reference', 'VARCHAR(100) NULL'],
      ['pharmacy_sales', 'paid_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['pharmacy_sales', 'payment_mode', 'VARCHAR(50) NULL'],
      ['pharmacy_sales', 'payment_reference', 'VARCHAR(100) NULL'],
      ['pharmacy_sales', 'round_off', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['pharmacy_sales', 'customer_gstin', 'VARCHAR(50) NULL'],
      ['pharmacy_sales', 'customer_address', 'TEXT NULL'],

      ['cash_book', 'branch_id', 'INT NULL'],

      ['lab_orders', 'branch_id', 'INT NULL'],
      ['lab_orders', 'billing_status', "VARCHAR(50) NOT NULL DEFAULT 'pending'"],
      ['lab_orders', 'invoice_id', 'INT NULL'],
      ['lab_orders', 'released_by', 'INT NULL'],
      ['lab_orders', 'release_note', 'TEXT NULL'],
      ['lab_orders', 'released_at', 'DATETIME NULL'],

      ['enquiries', 'branch_id', 'INT NULL'],
      ['admissions', 'branch_id', 'INT NULL'],

      ['assets', 'asset_code', 'VARCHAR(100) NULL'],
      ['assets', 'item_code', 'VARCHAR(100) NULL'],
      ['assets', 'branch_id', 'INT NULL'],
      ['assets', 'code_serial', 'INT NULL'],
      ['assets', 'code_minted_at', 'DATETIME NULL'],
      ['assets', 'code_minted_by', 'INT NULL'],
      ['assets', 'life_years', 'INT NULL'],

      ['stock_ledger', 'reason', 'TEXT NULL'],
      ['stock_ledger', 'credit_amount', 'DECIMAL(12,2) NULL'],

      ['doctor_profiles', 'signature_image', 'LONGTEXT NULL'],
      ['doctor_profiles', 'notify_whatsapp', 'TINYINT(1) NOT NULL DEFAULT 1'],
      ['doctor_profiles', 'notify_email', 'TINYINT(1) NOT NULL DEFAULT 0'],
      ['doctor_profiles', 'doctor_code', 'VARCHAR(100) NULL'],

      ['doctor_availability', 'op_room_id', 'INT NULL'],

      ['doctor_schedules', 'op_room_id', 'INT NULL'],
      ['doctor_schedules', 'note', 'TEXT NULL'],

      ['display_slides', 'from_date', 'DATE NULL'],
      ['display_slides', 'to_date', 'DATE NULL'],
      ['display_slides', 'from_time', 'VARCHAR(50) NULL'],
      ['display_slides', 'to_time', 'VARCHAR(50) NULL'],

      ['drugs', 'barcode', 'VARCHAR(100) NULL'],
      ['drugs', 'category', 'VARCHAR(100) NULL'],
      ['drugs', 'pack_size', 'VARCHAR(100) NULL'],
      ['drugs', 'unit_rate', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],

      ['drug_batches', 'barcode', 'VARCHAR(100) NULL'],

      ['pharmacy_sale_items', 'hsn', 'VARCHAR(50) NULL'],
      ['pharmacy_sale_items', 'taxable', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['pharmacy_sale_items', 'cgst', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['pharmacy_sale_items', 'sgst', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],
      ['pharmacy_sale_items', 'discount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00'],

      ['prescriptions', 'sheet_id', 'INT NULL'],
      ['prescriptions', 'doctor_id', 'INT NULL'],
      ['prescriptions', 'dose_morning', 'DOUBLE NOT NULL DEFAULT 0'],
      ['prescriptions', 'dose_afternoon', 'DOUBLE NOT NULL DEFAULT 0'],
      ['prescriptions', 'dose_night', 'DOUBLE NOT NULL DEFAULT 0'],
      ['prescriptions', 'dose_unit', 'VARCHAR(50) NULL'],
      ['prescriptions', 'food_relation', 'VARCHAR(50) NULL'],

      ['prescription_sheets', 'signed_at', 'DATETIME NULL'],
      ['prescription_sheets', 'signature_image', 'LONGTEXT NULL'],
      ['prescription_sheets', 'amended_at', 'DATETIME NULL'],
      ['prescription_sheets', 'amended_by', 'INT NULL'],

      ['vitals', 'purpose', 'TEXT NULL'],
      ['vitals', 'amended_at', 'DATETIME NULL'],
      ['vitals', 'amended_by', 'INT NULL'],

      ['appointments', 'service_id', 'INT NULL'],

      ['services', 'bill_group', 'VARCHAR(100) NULL'],

      ['lab_tests', 'bill_group', 'VARCHAR(100) NULL'],
      ['lab_tests', 'component_of', 'VARCHAR(100) NULL'],
      ['lab_tests', 'sort_order', 'INT NOT NULL DEFAULT 0'],

      ['lab_order_items', 'parent_item_id', 'INT NULL'],
      ['lab_order_items', 'sort_order', 'INT NOT NULL DEFAULT 0'],
    ];

    for (const [table, col, def] of columns) {
      await ensureColumn(conn, table, col, def);
    }

    // 3. Ensure indexes
    const indexes = [
      ['queue_tokens', 'idx_queue_tokens_day', 'CREATE INDEX idx_queue_tokens_day ON queue_tokens(issue_date, category_id, seq)'],
      ['queue_tokens', 'idx_queue_tokens_room', 'CREATE INDEX idx_queue_tokens_room ON queue_tokens(issue_date, room_id, status)'],
      ['queue_tokens', 'idx_queue_tokens_visit', 'CREATE INDEX idx_queue_tokens_visit ON queue_tokens(visit_id)'],
      ['display_slides', 'idx_slides_order', 'CREATE INDEX idx_slides_order ON display_slides(active, sort_order)'],
      ['expense_categories', 'idx_exp_cat_group', 'CREATE INDEX idx_exp_cat_group ON expense_categories(cost_group, sort_order)'],
      ['expense_items', 'idx_exp_item_cat', 'CREATE INDEX idx_exp_item_cat ON expense_items(category_id, sort_order)'],
      ['expenses', 'idx_expenses_date', 'CREATE INDEX idx_expenses_date ON expenses(invoice_date)'],
      ['expenses', 'idx_expenses_status', 'CREATE INDEX idx_expenses_status ON expenses(status)'],
      ['asset_item_codes', 'idx_item_codes_name', 'CREATE INDEX idx_item_codes_name ON asset_item_codes(name)'],
      ['assets', 'idx_assets_code', 'CREATE UNIQUE INDEX idx_assets_code ON assets(asset_code)'],
      ['doctor_profiles', 'idx_doctor_code', 'CREATE UNIQUE INDEX idx_doctor_code ON doctor_profiles(doctor_code)'],
    ];

    for (const [table, idxName, sql] of indexes) {
      await ensureIndex(conn, table, idxName, sql);
    }

    // Branch indexes on branched tables
    const BRANCHED = ['patients', 'appointments', 'visits', 'queue_tokens', 'invoices',
      'payments', 'pharmacy_sales', 'cash_book', 'expenses', 'lab_orders', 'enquiries', 'admissions'];
    for (const t of BRANCHED) {
      await ensureIndex(conn, t, `idx_${t}_branch`, `CREATE INDEX idx_${t}_branch ON \`${t}\`(branch_id)`);
    }

    // Apply auto-branch triggers
    const { applyTriggers } = require('./apply-mysql-triggers');
    await applyTriggers();

    // Ensure active owner exists
    const [owners] = await conn.query("SELECT id FROM users WHERE role = 'owner' AND active = 1 LIMIT 1");
    if (owners.length === 0) {
      const { hashPassword } = require('../src/lib/auth');
      const passHash = hashPassword('Samiha#2026');
      const [existing] = await conn.query("SELECT id FROM users WHERE role = 'owner' LIMIT 1");
      if (existing.length > 0) {
        await conn.query("UPDATE users SET active = 1, password_hash = ? WHERE id = ?", [passHash, existing[0].id]);
      } else {
        await conn.query(
          "INSERT INTO users (staff_code, name, email, password_hash, role, active) VALUES (?, ?, ?, ?, ?, 1)",
          ['EMP0003', 'A.B Mohamed Abdul Kasim', 'owner@samiha.local', passHash, 'owner']
        );
      }
      console.log('[migrate] Active owner account verified.');
    }

    console.log('[migrate] All MySQL latest schema migrations applied successfully.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error('[migrate] Error running migration:', err);
    process.exit(1);
  });
}

module.exports = { run };
