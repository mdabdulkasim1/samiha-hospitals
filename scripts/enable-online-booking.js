'use strict';
/**
 * Enable Online Booking Slots for Samiha Polyclinic ERP.
 * Ensures all clinical departments, consulting doctors, and weekly time schedules
 * are actively populated and available for WhatsApp online booking.
 */
const config = require('../src/config');
const { db } = require('../src/db');
const { hashPassword } = require('../src/lib/auth');

console.log('='.repeat(60));
console.log('  SAMIHA POLYCLINIC & DIAGNOSTICS - ENABLE ONLINE BOOKING SLOTS  ');
console.log('='.repeat(60));

try {
  // 1. Ensure clinical departments are active and specialist
  const departments = [
    ['IM', 'Internal Medicine', 'specialist', 1],
    ['PED', 'Pediatrics', 'specialist', 2],
    ['GYN', 'Gynecology', 'specialist', 3],
    ['CAR', 'Cardiology', 'specialist', 4],
    ['DEN', 'Dentist', 'specialist', 5],
    ['DER', 'Dermatology', 'specialist', 6],
    ['ORT', 'Orthopedics', 'specialist', 7],
    ['GS', 'General Surgery', 'specialist', 8],
    ['ENT', 'ENT (Ear, Nose, Throat)', 'specialist', 9],
    ['OPH', 'Ophthalmology', 'specialist', 10],
  ];

  for (const [code, name, kind, sort_order] of departments) {
    const existing = db.prepare('SELECT id FROM departments WHERE code = ?').get(code);
    if (existing) {
      db.prepare('UPDATE departments SET name = ?, kind = ?, sort_order = ?, active = 1 WHERE id = ?')
        .run(name, kind, sort_order, existing.id);
    } else {
      db.prepare('INSERT INTO departments (code, name, kind, sort_order, active) VALUES (?, ?, ?, ?, 1)')
        .run(code, name, kind, sort_order);
    }
  }
  console.log('[✓] Clinical departments enabled & marked active.');

  // 2. Ensure Doctors exist and have schedules
  const doctors = [
    { staff_code: 'DOC01', name: 'Dr. Imran Sheikh', email: 'imran@samiha.local', dept: 'IM',
      qualification: 'MBBS, MD (General Medicine)', specialization: 'Diabetes, hypertension & family health',
      consult_fee: 400, slot_minutes: 15, room_no: 'OPD-1' },
    { staff_code: 'DOC02', name: 'Dr. Sara Ahmed', email: 'sara@samiha.local', dept: 'PED',
      qualification: 'MBBS, DCH', specialization: 'Neonatal & child health',
      consult_fee: 400, slot_minutes: 15, room_no: 'OPD-2' },
    { staff_code: 'DOC03', name: 'Dr. Nafisa Rahman', email: 'nafisa@samiha.local', dept: 'GYN',
      qualification: 'MBBS, MS (OBG)', specialization: 'Women’s health & maternity',
      consult_fee: 500, slot_minutes: 15, room_no: 'OPD-3' },
    { staff_code: 'DOC06', name: 'Dr. Arif Hussain', email: 'arif@samiha.local', dept: 'CAR',
      qualification: 'MBBS, MD, DM', specialization: 'Cardiology & heart care',
      consult_fee: 600, slot_minutes: 15, room_no: 'OPD-4' },
    { staff_code: 'DOC07', name: 'Dr. Ramesh Kumar', email: 'ramesh@samiha.local', dept: 'DEN',
      qualification: 'BDS, MDS', specialization: 'Dental surgery & hygiene',
      consult_fee: 350, slot_minutes: 15, room_no: 'OPD-5' },
    { staff_code: 'DOC08', name: 'Dr. Priya Sundaram', email: 'priya@samiha.local', dept: 'DER',
      qualification: 'MBBS, MD (Derm)', specialization: 'Dermatology & skin care',
      consult_fee: 450, slot_minutes: 15, room_no: 'OPD-6' },
    { staff_code: 'DOC09', name: 'Dr. Tariq Anwar', email: 'tariq@samiha.local', dept: 'ORT',
      qualification: 'MBBS, MS (Ortho)', specialization: 'Joints, bones & spine',
      consult_fee: 500, slot_minutes: 15, room_no: 'OPD-7' },
  ];

  for (const d of doctors) {
    const deptRow = db.prepare('SELECT id FROM departments WHERE code = ?').get(d.dept);
    const deptId = deptRow ? deptRow.id : 2;

    let user = db.prepare("SELECT id FROM users WHERE staff_code = ? OR email = ? OR (role = 'doctor' AND name = ?)").get(d.staff_code, d.email, d.name);
    let doctorId;
    if (user) {
      doctorId = user.id;
      db.prepare("UPDATE users SET department_id = ?, active = 1, role = 'doctor' WHERE id = ?").run(deptId, doctorId);
    } else {
      const hash = hashPassword('samiha@123');
      const info = db.prepare(`
        INSERT INTO users (staff_code, name, email, role, department_id, active, password_hash)
        VALUES (?, ?, ?, 'doctor', ?, 1, ?)
      `).run(d.staff_code, d.name, d.email, deptId, hash);
      doctorId = info.lastInsertRowid;
    }

    // Upsert doctor profile (primary key is user_id)
    const profile = db.prepare('SELECT user_id FROM doctor_profiles WHERE user_id = ?').get(doctorId);
    if (profile) {
      db.prepare('UPDATE doctor_profiles SET consult_fee = ?, slot_minutes = ?, qualification = ?, specialization = ?, room_no = ? WHERE user_id = ?')
        .run(d.consult_fee, d.slot_minutes, d.qualification, d.specialization, d.room_no, doctorId);
    } else {
      db.prepare(`
        INSERT INTO doctor_profiles (user_id, doctor_code, qualification, specialization, consult_fee, slot_minutes, room_no)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(doctorId, d.staff_code, d.qualification, d.specialization, d.consult_fee, d.slot_minutes, d.room_no);
    }

    // Populate doctor_schedules for all 7 days
    db.prepare('DELETE FROM doctor_schedules WHERE doctor_id = ?').run(doctorId);
    const ins = db.prepare(`
      INSERT INTO doctor_schedules (doctor_id, weekday, start_time, end_time, slot_minutes, max_tokens, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    // Mon-Sat: Morning 09:00-13:00, Evening 17:00-20:00
    for (let w = 1; w <= 6; w++) {
      ins.run(doctorId, w, '09:00', '13:00', d.slot_minutes, 20);
      ins.run(doctorId, w, '17:00', '20:00', d.slot_minutes, 15);
    }
    // Sunday: Morning 09:00-12:00
    ins.run(doctorId, 0, '09:00', '12:00', d.slot_minutes, 12);
    console.log(`[✓] Doctor ${d.name} (${d.dept}) enabled with full weekly consulting slots.`);
  }

  console.log('='.repeat(60));
  console.log('  ALL ONLINE BOOKING SLOTS ARE NOW 100% ENABLED AND ACTIVE!  ');
  console.log('='.repeat(60));
} catch (err) {
  console.error('[-] Error enabling online booking slots:', err.message);
  process.exit(1);
}
