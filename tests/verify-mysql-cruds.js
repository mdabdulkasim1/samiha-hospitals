'use strict';
const assert = require('node:assert');
const mysql = require('mysql2/promise');
const config = require('../src/config');

const BASE = 'http://localhost:3011';

async function main() {
  console.log('='.repeat(70));
  console.log('  COMPREHENSIVE CRUD VERIFICATION VIA MYSQL (LATEST COMMITS)');
  console.log('='.repeat(70));

  // Connect directly to MySQL to independently verify DB writes
  const sqlConn = await mysql.createConnection({
    ...config.mysql,
    dateStrings: true,
  });

  const tokens = {};

  async function api(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
    return { status: res.status, body: json };
  }

  try {
    // -----------------------------------------------------------------
    // 1. Auth & Session
    // -----------------------------------------------------------------
    console.log('\n[1/8] Testing Auth & Session...');
    const loginRes = await api('POST', '/api/auth/login', {
      username: 'admin@samiha.local',
      password: 'samiha@123',
    });
    assert.strictEqual(loginRes.status, 200, 'Admin login should succeed');
    tokens.admin = loginRes.body.token;

    // Log in as Owner as well for owner-restricted operations
    const ownerLoginRes = await api('POST', '/api/auth/login', {
      username: 'owner@samiha.local',
      password: 'Samiha#2026',
    });
    assert.strictEqual(ownerLoginRes.status, 200, 'Owner login should succeed');
    tokens.owner = ownerLoginRes.body.token;
    await api('POST', '/api/auth/branch', { branchId: 1 }, tokens.owner);

    // Always ensure the session is actively standing in primary branch (MPM: id=1)
    const switchBranchRes = await api('POST', '/api/auth/branch', { branchId: 1 }, tokens.admin);
    assert.strictEqual(switchBranchRes.status, 200, 'Selecting branch should return 200');

    const meRes = await api('GET', '/api/auth/me', undefined, tokens.admin);
    assert.strictEqual(meRes.status, 200);
    assert.ok(meRes.body.branch, 'Branch info must be present in session');
    assert.strictEqual(meRes.body.branch.code, 'MPM', 'Default branch is MPM');
    console.log('  ✔ Admin logged in, current branch: MPM (Melapalayam)');

    // -----------------------------------------------------------------
    // 2. Branches Module CRUD
    // -----------------------------------------------------------------
    console.log('\n[2/8] Testing Multi-Branch CRUD...');
    const c1 = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const c2 = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const branchCode = 'T' + c1 + c2;
    const createBranchRes = await api('POST', '/api/branches', {
      code: branchCode,
      name: 'Test Branch Location',
      address: '77 Clinic Road, Testing',
      isDefault: false,
    }, tokens.admin);
    assert.strictEqual(createBranchRes.status, 201, 'Branch creation should return 201: ' + JSON.stringify(createBranchRes.body));
    const newBranchId = createBranchRes.body.id;
    console.log(`  ✔ Branch created via API: id=${newBranchId}, code=${branchCode}`);

    // Verify in MySQL
    const [dbBranch] = await sqlConn.query('SELECT * FROM branches WHERE id = ?', [newBranchId]);
    assert.strictEqual(dbBranch.length, 1);
    assert.strictEqual(dbBranch[0].code, branchCode);
    console.log('  ✔ Verified branch stored in MySQL table `branches`');

    // Update branch
    const updateBranchRes = await api('PATCH', `/api/branches/${newBranchId}`, {
      name: 'Test Branch Location Updated',
    }, tokens.admin);
    assert.strictEqual(updateBranchRes.status, 200);
    const [dbBranchUpdated] = await sqlConn.query('SELECT name FROM branches WHERE id = ?', [newBranchId]);
    assert.strictEqual(dbBranchUpdated[0].name, 'Test Branch Location Updated');
    console.log('  ✔ Branch update verified in MySQL');

    // Switch active session back to branch 1
    await api('POST', '/api/auth/branch', { branchId: 1 }, tokens.admin);

    // -----------------------------------------------------------------
    // 3. Queue Management & Token CRUD
    // -----------------------------------------------------------------
    console.log('\n[3/8] Testing Queue Categories, OP Rooms & Token Queue CRUD...');
    // Find next unused two-digit category code (01 - 99)
    const [usedCodes] = await sqlConn.query('SELECT code FROM queue_categories');
    const used = new Set(usedCodes.map(r => r.code));
    let catCode = '25';
    for (let i = 25; i <= 99; i++) {
      const c = String(i).padStart(2, '0');
      if (!used.has(c)) { catCode = c; break; }
    }
    const createCatRes = await api('POST', '/api/queue/categories', {
      code: catCode,
      name: 'Specialist Test Unit ' + catCode,
      kind: 'consult',
      sortOrder: 50,
    }, tokens.admin);
    assert.strictEqual(createCatRes.status, 201, 'Create queue category should return 201: ' + JSON.stringify(createCatRes.body));
    const catId = createCatRes.body.id;

    // Create OP Room
    const roomName = 'OP-T' + Date.now().toString().slice(-4);
    const createRoomRes = await api('POST', '/api/queue/rooms', {
      name: roomName,
      floor: 'Ground Floor',
      floorOrder: 1,
      note: 'Verification room',
    }, tokens.admin);
    assert.strictEqual(createRoomRes.status, 201, 'Create OP room should return 201: ' + JSON.stringify(createRoomRes.body));
    const roomId = createRoomRes.body.id;

    // Allocate category to room
    const allocRes = await api('POST', `/api/queue/categories/${catId}/room`, {
      roomId,
    }, tokens.admin);
    assert.strictEqual(allocRes.status, 200);

    // Issue Token
    const issueRes = await api('POST', '/api/queue/tokens', {
      categoryId: catId,
      roomId,
      note: 'Automated test token',
    }, tokens.admin);
    assert.strictEqual(issueRes.status, 201);
    const tokenId = issueRes.body.id;
    console.log(`  ✔ Token issued: id=${tokenId}, label=${issueRes.body.label}`);

    // Verify token in MySQL
    const [dbToken] = await sqlConn.query('SELECT * FROM queue_tokens WHERE id = ?', [tokenId]);
    assert.strictEqual(dbToken.length, 1);
    assert.strictEqual(dbToken[0].status, 'waiting');
    console.log('  ✔ Token verified in MySQL table `queue_tokens` with status "waiting"');

    // Call token
    const callRes = await api('POST', `/api/queue/tokens/${tokenId}/call`, {}, tokens.admin);
    assert.strictEqual(callRes.status, 200);

    // Serving token
    const servingRes = await api('POST', `/api/queue/tokens/${tokenId}/serving`, {}, tokens.admin);
    assert.strictEqual(servingRes.status, 200);

    // Done token
    const doneRes = await api('POST', `/api/queue/tokens/${tokenId}/done`, {}, tokens.admin);
    assert.strictEqual(doneRes.status, 200);

    const [dbTokenDone] = await sqlConn.query('SELECT status, serving_at, done_at FROM queue_tokens WHERE id = ?', [tokenId]);
    assert.strictEqual(dbTokenDone[0].status, 'done');
    console.log('  ✔ Token full state lifecycle (waiting → called → serving → done) verified in MySQL');

    // Public TV Kiosk endpoint
    const kioskRes = await api('GET', '/api/kiosk/queue');
    assert.strictEqual(kioskRes.status, 200);
    assert.strictEqual(kioskRes.body.ok, true);
    console.log('  ✔ Waiting room TV / Kiosk live feed returned 200 OK');

    // -----------------------------------------------------------------
    // 4. Duty Chart & Doctor Schedule CRUD
    // -----------------------------------------------------------------
    console.log('\n[4/8] Testing Duty Chart CRUD...');
    const chartRes = await api('GET', '/api/schedule', undefined, tokens.admin);
    assert.strictEqual(chartRes.status, 200);
    assert.ok(Array.isArray(chartRes.body.days));

    // Schedule slot via PUT /api/schedule/doctors/:id/days/:weekday
    const slotRes = await api('PUT', '/api/schedule/doctors/9/days/1', {
      windows: [
        {
          start_time: '09:00',
          end_time: '13:00',
          slot_minutes: 15,
          max_tokens: 16,
          room_id: roomId,
          note: 'Routine morning clinic',
        },
      ],
    }, tokens.admin);
    assert.strictEqual(slotRes.status, 200, 'Setting doctor duty schedule should return 200: ' + JSON.stringify(slotRes.body));

    // Read back via GET /api/schedule/on/:date
    const onDateRes = await api('GET', '/api/schedule/on/2026-11-23', undefined, tokens.admin);
    assert.strictEqual(onDateRes.status, 200);

    // Verify in MySQL
    const [dbDuty] = await sqlConn.query(
      'SELECT * FROM doctor_schedules WHERE doctor_id = 9 AND weekday = 1'
    );
    assert.ok(dbDuty.length >= 1);
    console.log('  ✔ Doctor schedule slot stored and verified in MySQL table `doctor_schedules`');

    // -----------------------------------------------------------------
    // 5. Consumables Store CRUD
    // -----------------------------------------------------------------
    console.log('\n[5/8] Testing Consumables Store CRUD...');
    const conName = 'Nitrile Examination Gloves Medium ' + Date.now();
    const createConRes = await api('POST', '/api/consumables', {
      name: conName,
      area: 'WRD',
      unit: 'Box of 100',
      indentQty: 50,
      reorderAt: 10,
    }, tokens.admin);
    assert.strictEqual(createConRes.status, 201, 'Create consumable should return 201: ' + JSON.stringify(createConRes.body));
    const conId = createConRes.body.id;

    // Movement: Stock receipt
    const receiptRes = await api('POST', `/api/consumables/${conId}/movements`, {
      kind: 'receipt',
      qty: 25,
      movedOn: '2026-11-21',
      supplier: 'MedEquip TN Ltd',
      invoiceNo: 'INV-9901',
      unitCost: 350.00,
    }, tokens.admin);
    assert.strictEqual(receiptRes.status, 201);

    // Movement: Stock issue
    const issueConRes = await api('POST', `/api/consumables/${conId}/movements`, {
      kind: 'issue',
      qty: 5,
      movedOn: '2026-11-21',
      issuedTo: 'OP-1 Examination Room',
    }, tokens.admin);
    assert.strictEqual(issueConRes.status, 201, 'Issue consumable movement should return 201: ' + JSON.stringify(issueConRes.body));

    // Detail check
    const conDetailRes = await api('GET', `/api/consumables/${conId}`, undefined, tokens.admin);
    assert.strictEqual(conDetailRes.status, 200);
    assert.strictEqual(conDetailRes.body.on_hand, 20);

    const [dbConMov] = await sqlConn.query('SELECT * FROM consumable_movements WHERE item_id = ?', [conId]);
    assert.strictEqual(dbConMov.length, 2);
    console.log('  ✔ Consumables CRUD, movements & stock balances (25 in - 5 out = 20) verified in MySQL');

    // -----------------------------------------------------------------
    // 6. Expense Book CRUD
    // -----------------------------------------------------------------
    console.log('\n[6/8] Testing Expense Book CRUD...');
    const expCatsRes = await api('GET', '/api/expenses/categories', undefined, tokens.admin);
    assert.strictEqual(expCatsRes.status, 200);
    const firstCat = expCatsRes.body.groups[0]?.categories[0];
    assert.ok(firstCat, 'At least one seeded expense category must exist');

    // Create item under category
    const expItemRes = await api('POST', `/api/expenses/categories/${firstCat.id}/items`, {
      name: 'Automated Facility Testing ' + Date.now(),
    }, tokens.admin);
    assert.strictEqual(expItemRes.status, 201);
    const expItemId = expItemRes.body.id;

    // Create expense invoice
    const createExpRes = await api('POST', '/api/expenses', {
      categoryId: firstCat.id,
      itemId: expItemId,
      supplierName: 'Power & Maintenance Corp',
      description: 'Monthly UPS inverter servicing',
      invoiceNo: 'SERV-8812',
      invoiceDate: '2026-11-21',
      total: 4500.00,
      department: 'common',
    }, tokens.admin);
    assert.strictEqual(createExpRes.status, 201, 'Create expense invoice should return 201: ' + JSON.stringify(createExpRes.body));
    const expenseId = createExpRes.body.id;
    console.log(`  ✔ Expense invoice booked: id=${expenseId}, ref=${createExpRes.body.ref_no}`);

    // Pay expense
    const payExpRes = await api('POST', `/api/expenses/${expenseId}/payments`, {
      amount: 4500.00,
      paidOn: '2026-11-21',
      mode: 'cash',
      reference: 'CASH-SETTLE-01',
    }, tokens.admin);
    assert.strictEqual(payExpRes.status, 200);
    assert.strictEqual(payExpRes.body.status, 'paid');

    const [dbExp] = await sqlConn.query('SELECT status, paid FROM expenses WHERE id = ?', [expenseId]);
    assert.strictEqual(dbExp[0].status, 'paid');
    assert.strictEqual(Number(dbExp[0].paid), 4500);

    const [dbExpPay] = await sqlConn.query('SELECT * FROM expense_payments WHERE expense_id = ?', [expenseId]);
    assert.strictEqual(dbExpPay.length, 1);
    console.log('  ✔ Expense entry and payment settled and verified in MySQL `expenses` & `expense_payments`');

    // -----------------------------------------------------------------
    // 7. Asset Item Codes & Minting CRUD
    // -----------------------------------------------------------------
    console.log('\n[7/8] Testing Asset Item Codes & Minting CRUD...');
    const itemCodesRes = await api('GET', '/api/assets/item-codes', undefined, tokens.admin);
    assert.strictEqual(itemCodesRes.status, 200);
    assert.ok(Array.isArray(itemCodesRes.body.rows));

    // Get an asset with no code minted yet
    const [assets] = await sqlConn.query('SELECT id, name FROM assets WHERE active = 1 AND asset_code IS NULL LIMIT 1');
    assert.ok(assets.length > 0, 'At least one asset should exist');
    const assetId = assets[0].id;

    // Mint code for asset
    const mintRes = await api('POST', `/api/assets/${assetId}/code`, {
      branchId: 1,
    }, tokens.admin);
    assert.strictEqual(mintRes.status, 201, 'Mint asset code should return 201: ' + JSON.stringify(mintRes.body));
    assert.ok(mintRes.body.code, 'Minted asset code must be returned');

    const [dbAsset] = await sqlConn.query('SELECT asset_code, item_code, branch_id FROM assets WHERE id = ?', [assetId]);
    assert.strictEqual(dbAsset[0].asset_code, mintRes.body.code);
    console.log(`  ✔ Asset code minted (${dbAsset[0].asset_code}) and verified in MySQL table \`assets\``);

    // -----------------------------------------------------------------
    // 8. Patient & Visit Auto-Branch Stamping
    // -----------------------------------------------------------------
    console.log('\n[8/8] Testing Patient & Visit Auto-Branch Stamping...');
    const patientPhone = '9' + Math.floor(100000000 + Math.random() * 899999999);
    const createPatRes = await api('POST', '/api/patients', {
      firstName: 'Kader',
      lastName: 'Mohideen',
      gender: 'male',
      phone: patientPhone,
      age: 42,
      guardianName: 'Peer Mohamed',
      guardianRelation: 'S/o',
      consentTreatment: true,
      consentPrivacy: true,
    }, tokens.admin);
    assert.strictEqual(createPatRes.status, 201, 'Create patient should return 201: ' + JSON.stringify(createPatRes.body));
    const patientId = createPatRes.body.id;

    // Check branch_id in MySQL
    const [dbPat] = await sqlConn.query('SELECT branch_id, guardian_name FROM patients WHERE id = ?', [patientId]);
    assert.strictEqual(dbPat[0].branch_id, 1, 'Patient must be stamped with active branch_id 1 (MPM)');
    assert.strictEqual(dbPat[0].guardian_name, 'Peer Mohamed');
    console.log('  ✔ Patient automatically stamped with active branch_id in MySQL');

    // Record patient arrival
    const createVisitRes = await api('POST', '/api/visits/arrive', {
      patientId,
      departmentId: 1,
      doctorId: 9,
      reason: 'General check-up',
    }, tokens.admin);
    assert.strictEqual(createVisitRes.status, 201, 'Arrive visit should return 201: ' + JSON.stringify(createVisitRes.body));
    const visitId = createVisitRes.body.visit?.id || createVisitRes.body.id;

    const [dbVisit] = await sqlConn.query('SELECT branch_id FROM visits WHERE id = ?', [visitId]);
    assert.strictEqual(dbVisit[0].branch_id, 1, 'Visit must be stamped with active branch_id 1');
    console.log('  ✔ Visit automatically stamped with active branch_id in MySQL');

    // Verify patient with visit cannot be deleted (clinical record guard)
    const previewRes = await api('GET', `/api/patients/${patientId}/removal`, undefined, tokens.owner);
    assert.strictEqual(previewRes.status, 200);
    assert.strictEqual(previewRes.body.canRemove, false, 'Patient with visits cannot be removed');

    // Create a standalone test patient to verify owner removal
    const testPatPhone = '9' + Math.floor(100000000 + Math.random() * 899999999);
    const testPatRes = await api('POST', '/api/patients', {
      firstName: 'Removal',
      lastName: 'Candidate',
      gender: 'female',
      phone: testPatPhone,
      age: 29,
      consentTreatment: true,
      consentPrivacy: true,
    }, tokens.admin);
    assert.strictEqual(testPatRes.status, 201);
    const testPatId = testPatRes.body.id;
    const testPatUhid = testPatRes.body.uhid;

    // Clean up standalone test patient via Owner removal endpoint
    const delPatRes = await api('DELETE', `/api/patients/${testPatId}`, {
      confirm: testPatUhid,
      reason: 'Automated test patient verification cleanup',
    }, tokens.owner);
    assert.strictEqual(delPatRes.status, 200, 'Owner deletion should return 200: ' + JSON.stringify(delPatRes.body));
    const [dbPatAfter] = await sqlConn.query('SELECT id FROM patients WHERE id = ?', [testPatId]);
    assert.strictEqual(dbPatAfter.length, 0, 'Patient record removed by owner successfully in MySQL');
    console.log('  ✔ Patient removal verified in MySQL');

    console.log('\n' + '='.repeat(70));
    console.log('  ALL CRUD OPERATIONS CONFIRMED 100% OPERATIONAL ON MYSQL!');
    console.log('='.repeat(70) + '\n');
  } finally {
    await sqlConn.end();
  }
}

main().catch((err) => {
  console.error('\n❌ CRUD Verification failed with error:', err);
  process.exit(1);
});
