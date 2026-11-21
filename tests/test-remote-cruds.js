'use strict';
const assert = require('node:assert');
const mysql = require('mysql2/promise');

async function main() {
  console.log('='.repeat(70));
  console.log('  TESTING LIVE CRUD OPERATIONS ON REMOTE PRODUCTION (76.13.243.217)');
  console.log('='.repeat(70));

  const conn = await mysql.createConnection({
    host: '76.13.243.217',
    user: 'samihahospitals_app_user',
    password: 'bka@6202#db',
    database: 'samihahospitals_app_db',
    dateStrings: true,
  });

  try {
    // 1. Multi-Branch CRUD
    console.log('\n[1/5] Testing Branch CRUD on remote host...');
    const branchCode = 'T' + String.fromCharCode(65 + Math.floor(Math.random() * 26)) + String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const [bInsert] = await conn.query(
      'INSERT INTO branches (code, name, address, is_default, active) VALUES (?, ?, ?, 0, 1)',
      [branchCode, 'Remote Test Branch', '77 Testing Road']
    );
    const branchId = bInsert.insertId;
    assert.ok(branchId > 0);

    const [bRead] = await conn.query('SELECT * FROM branches WHERE id = ?', [branchId]);
    assert.strictEqual(bRead[0].code, branchCode);

    await conn.query('UPDATE branches SET name = ? WHERE id = ?', ['Remote Branch Updated', branchId]);
    const [bUpdated] = await conn.query('SELECT name FROM branches WHERE id = ?', [branchId]);
    assert.strictEqual(bUpdated[0].name, 'Remote Branch Updated');

    await conn.query('DELETE FROM branches WHERE id = ?', [branchId]);
    const [bDeleted] = await conn.query('SELECT id FROM branches WHERE id = ?', [branchId]);
    assert.strictEqual(bDeleted.length, 0);
    console.log('  ✔ Branch CRUD verified on remote host');

    // 2. Queue & Token CRUD
    console.log('\n[2/5] Testing Queue Token CRUD on remote host...');
    const [tokInsert] = await conn.query(
      `INSERT INTO queue_tokens (category_id, room_id, issue_date, seq, label, status, branch_id)
       VALUES (1, 1, CURDATE(), 999, '01-999', 'waiting', 1)`
    );
    const tokId = tokInsert.insertId;
    assert.ok(tokId > 0);

    await conn.query("UPDATE queue_tokens SET status = 'called', called_at = NOW() WHERE id = ?", [tokId]);
    const [tokRead] = await conn.query('SELECT status FROM queue_tokens WHERE id = ?', [tokId]);
    assert.strictEqual(tokRead[0].status, 'called');

    await conn.query('DELETE FROM queue_tokens WHERE id = ?', [tokId]);
    console.log('  ✔ Queue Token lifecycle verified on remote host');

    // 3. Consumable Movement & Stock Balance
    console.log('\n[3/5] Testing Consumable Movement on remote host...');
    const [cons] = await conn.query('SELECT id, code FROM consumables LIMIT 1');
    assert.ok(cons.length > 0);
    const consId = cons[0].id;

    const [movInsert] = await conn.query(
      `INSERT INTO consumable_movements (item_id, moved_on, kind, qty, reason)
       VALUES (?, CURDATE(), 'in', 50, 'Remote Test Receipt')`,
      [consId]
    );
    assert.ok(movInsert.insertId > 0);
    await conn.query('DELETE FROM consumable_movements WHERE id = ?', [movInsert.insertId]);
    console.log('  ✔ Consumable movement verified on remote host');

    // 4. Expense Book
    console.log('\n[4/5] Testing Expense Book on remote host...');
    const [cat] = await conn.query('SELECT id FROM expense_categories LIMIT 1');
    const [expInsert] = await conn.query(
      `INSERT INTO expenses (ref_no, category_id, invoice_no, invoice_date, supplier_name, taxable, tax, total, paid, status, branch_id)
       VALUES ('EXP-TEST-RMT-01', ?, 'EXP-RMT-001', CURDATE(), 'Remote Supplier Ltd', 1000, 180, 1180, 0, 'recorded', 1)`,
      [cat[0].id]
    );
    const expId = expInsert.insertId;
    assert.ok(expId > 0);
    await conn.query('DELETE FROM expenses WHERE id = ?', [expId]);
    console.log('  ✔ Expense entry verified on remote host');

    // 5. Patient & Auto-Branch Trigger Check
    console.log('\n[5/5] Testing Auto-Branch Trigger on remote host...');
    // Set request_context
    await conn.query("REPLACE INTO request_context (`key`, `value`) VALUES ('branch_id', '1')");
    const [patInsert] = await conn.query(
      `INSERT INTO patients (uhid, first_name, last_name, gender, phone, active)
       VALUES ('TEST-RMT-99', 'Remote', 'Patient', 'male', '9999988888', 1)`
    );
    const patId = patInsert.insertId;
    const [patCheck] = await conn.query('SELECT branch_id FROM patients WHERE id = ?', [patId]);
    assert.strictEqual(patCheck[0].branch_id, 1, 'BEFORE INSERT trigger must stamp branch_id = 1');
    await conn.query('DELETE FROM patients WHERE id = ?', [patId]);
    console.log('  ✔ BEFORE INSERT branch auto-stamping trigger verified on remote host');

    console.log('\n' + '='.repeat(70));
    console.log('  ALL CRUD TESTS CONFIRMED 100% OPERATIONAL ON REMOTE PRODUCTION (76.13.243.217)!');
    console.log('='.repeat(70) + '\n');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('\n❌ Remote CRUD test failed:', err);
  process.exit(1);
});
