'use strict';
const assert = require('node:assert');
const config = require('../src/config');
const { db } = require('../src/db');
const { generate } = require('../src/lib/ids');

async function main() {
  console.log('='.repeat(70));
  console.log('  TESTING UPCOMING APPOINTMENT LIST BASED ON SERVICE LIST');
  console.log('='.repeat(70));

  // 1. Verify services list
  const services = db.prepare('SELECT id, code, name, price FROM services WHERE active = 1 ORDER BY id').all();
  assert.ok(services.length >= 10, 'Services list must contain active services');
  console.log(`[✓] Active services catalogue retrieved (${services.length} services)`);
  const testService = services[0];

  // 2. Insert temporary test appointment for tomorrow
  const apptNo = generate('appointment');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const scheduledAt = `${tomorrow} 10:30:00`;

  const info = db.prepare(`
    INSERT INTO appointments 
      (appt_no, guest_name, guest_phone, doctor_id, department_id, service_id, scheduled_at,
       slot_minutes, token_no, visit_kind, source, status, reason, created_by, branch_id)
    VALUES (?, 'Test Upcoming Patient', '919876543210', 9, 2, ?, ?, 15, 1, 'new', 'reception', 'booked', 'Testing upcoming service filter', 1, 1)
  `).run(apptNo, testService.id, scheduledAt);

  const testApptId = info.lastInsertRowid;
  console.log(`[✓] Created test upcoming appointment (id=${testApptId}, ref=${apptNo}, service=${testService.name})`);

  try {
    // 3. Query upcoming appointments joining services
    const rows = db.prepare(`
      SELECT a.*,
             u.name AS doctor_name,
             d.name AS department_name,
             s.name AS service_name,
             s.code AS service_code,
             s.price AS service_price,
             p.uhid
        FROM appointments a
        LEFT JOIN users u ON u.id = a.doctor_id
        LEFT JOIN departments d ON d.id = a.department_id
        LEFT JOIN services s ON s.id = a.service_id
        LEFT JOIN patients p ON p.id = a.patient_id
       WHERE date(a.scheduled_at) >= ?
         AND a.service_id = ?
       ORDER BY a.scheduled_at ASC
    `).all(new Date().toISOString().slice(0, 10), testService.id);

    assert.ok(rows.length >= 1, 'Upcoming appointment must be retrieved by service filter');
    const matched = rows.find(r => r.id === testApptId);
    assert.ok(matched, 'Inserted appointment must match');
    assert.strictEqual(matched.service_id, testService.id);
    assert.strictEqual(matched.service_name, testService.name);
    console.log(`[✓] Successfully retrieved upcoming appointment filtered by service '${matched.service_name}'`);

    // 4. Test summary statistics calculation
    const allUpcoming = db.prepare(`
      SELECT a.id, a.scheduled_at, a.status, a.service_id,
             COALESCE(s.name, 'Consultation') AS service_name
        FROM appointments a
        LEFT JOIN services s ON s.id = a.service_id
       WHERE date(a.scheduled_at) >= ?
         AND a.status NOT IN ('cancelled', 'no_show')
    `).all(new Date().toISOString().slice(0, 10));

    console.log(`[✓] Summary calculation: ${allUpcoming.length} active upcoming appointment(s)`);
  } finally {
    // Clean up test appointment immediately
    db.prepare('DELETE FROM appointments WHERE id = ?').run(testApptId);
    console.log(`[✓] Test appointment ${testApptId} successfully cleaned up`);
  }

  console.log('\n[SUCCESS] Upcoming appointment list based on service list verified 100% OK!\n');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
