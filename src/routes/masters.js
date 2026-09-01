'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, num, int, bool } = require('../lib/validate');
const audit = require('../lib/audit');
const { generate } = require('../lib/ids');
const { hashPassword } = require('../lib/auth');

const router = express.Router();
const adminOnly = requireRole('admin');

// ------------------------------------------------------------- departments
router.get('/departments', wrap((req, res) => {
  const kind = str(req.query.kind);
  res.json(db.prepare(
    `SELECT d.*,
            (SELECT COUNT(*) FROM users u
              WHERE u.department_id = d.id AND u.role = 'doctor' AND u.active = 1) AS doctor_count
       FROM departments d
      WHERE d.active = 1 AND (? IS NULL OR d.kind = ?)
      ORDER BY d.sort_order, d.name`
  ).all(kind, kind));
}));

router.post('/departments', adminOnly, wrap((req, res) => {
  required(req.body, ['code', 'name']);
  const info = db.prepare('INSERT INTO departments (code, name, kind, sort_order) VALUES (?, ?, ?, ?)')
    .run(str(req.body.code).toUpperCase(), str(req.body.name),
         str(req.body.kind, 'specialist'), int(req.body.sortOrder, 50));
  audit.log(req, 'create', 'department', info.lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM departments WHERE id = ?').get(info.lastInsertRowid));
}));

// ------------------------------------------------------------------- staff
router.get('/staff', wrap((req, res) => {
  const role = str(req.query.role);
  const rows = db.prepare(
    `SELECT u.id, u.staff_code, u.name, u.email, u.phone, u.role, u.active, u.department_id,
            d.name AS department_name, dp.qualification, dp.specialization, dp.consult_fee,
            dp.follow_up_fee, dp.slot_minutes, dp.room_no
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
      WHERE (? IS NULL OR u.role = ?)
      ORDER BY u.role, u.name`
  ).all(role, role);
  res.json(rows);
}));

router.post('/staff', adminOnly, wrap((req, res) => {
  required(req.body, ['name', 'role', 'password']);
  const staffCode = str(req.body.staffCode) || generate('staff');
  const info = db.prepare(
    `INSERT INTO users (staff_code, name, email, phone, password_hash, role, department_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(staffCode, str(req.body.name), str(req.body.email) ? str(req.body.email).toLowerCase() : null,
        str(req.body.phone), hashPassword(req.body.password), str(req.body.role), int(req.body.departmentId) || null);

  if (req.body.role === 'doctor') {
    db.prepare(
      `INSERT INTO doctor_profiles (user_id, qualification, specialization, reg_no, consult_fee, follow_up_fee, slot_minutes, room_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(info.lastInsertRowid, str(req.body.qualification), str(req.body.specialization), str(req.body.regNo),
          num(req.body.consultFee, 0), num(req.body.followUpFee, 0), int(req.body.slotMinutes, 15) || 15, str(req.body.roomNo));
  }
  audit.log(req, 'create', 'user', info.lastInsertRowid, { role: req.body.role });
  res.status(201).json({ id: info.lastInsertRowid, staffCode });
}));

router.patch('/staff/:id', adminOnly, wrap((req, res) => {
  const id = int(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw notFound('Staff member not found');
  db.prepare(
    `UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email), phone = COALESCE(?, phone),
            department_id = COALESCE(?, department_id), active = COALESCE(?, active)
      WHERE id = ?`
  ).run(str(req.body.name), str(req.body.email), str(req.body.phone),
        req.body.departmentId === undefined ? null : int(req.body.departmentId),
        req.body.active === undefined ? null : (bool(req.body.active) ? 1 : 0), id);
  if (req.body.password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), id);
  }
  if (user.role === 'doctor') {
    db.prepare(
      `UPDATE doctor_profiles SET qualification = COALESCE(?, qualification),
              specialization = COALESCE(?, specialization), consult_fee = COALESCE(?, consult_fee),
              follow_up_fee = COALESCE(?, follow_up_fee), slot_minutes = COALESCE(?, slot_minutes),
              room_no = COALESCE(?, room_no)
        WHERE user_id = ?`
    ).run(str(req.body.qualification), str(req.body.specialization),
          req.body.consultFee === undefined ? null : num(req.body.consultFee),
          req.body.followUpFee === undefined ? null : num(req.body.followUpFee),
          req.body.slotMinutes === undefined ? null : int(req.body.slotMinutes),
          str(req.body.roomNo), id);
  }
  audit.log(req, 'update', 'user', id);
  res.json({ ok: true });
}));

// --------------------------------------------------------------- schedules
router.get('/doctors/:id/schedule', wrap((req, res) => {
  res.json({
    sessions: db.prepare('SELECT * FROM doctor_schedules WHERE doctor_id = ? ORDER BY weekday, start_time').all(int(req.params.id)),
    leaves: db.prepare("SELECT * FROM doctor_leaves WHERE doctor_id = ? AND leave_date >= date('now') ORDER BY leave_date").all(int(req.params.id)),
  });
}));

router.post('/doctors/:id/schedule', requireRole('admin', 'reception'), wrap((req, res) => {
  required(req.body, ['weekday', 'startTime', 'endTime']);
  const info = db.prepare(
    `INSERT INTO doctor_schedules (doctor_id, weekday, start_time, end_time, slot_minutes, max_tokens)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(int(req.params.id), int(req.body.weekday), str(req.body.startTime), str(req.body.endTime),
        int(req.body.slotMinutes, 15) || 15, int(req.body.maxTokens, 40) || 40);
  audit.log(req, 'create', 'doctor_schedule', info.lastInsertRowid);
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.delete('/schedule/:scheduleId', requireRole('admin', 'reception'), wrap((req, res) => {
  db.prepare('DELETE FROM doctor_schedules WHERE id = ?').run(int(req.params.scheduleId));
  res.json({ ok: true });
}));

router.post('/doctors/:id/leave', requireRole('admin', 'reception'), wrap((req, res) => {
  required(req.body, ['date']);
  db.prepare('INSERT OR REPLACE INTO doctor_leaves (doctor_id, leave_date, reason) VALUES (?, ?, ?)')
    .run(int(req.params.id), str(req.body.date), str(req.body.reason));
  res.status(201).json({ ok: true });
}));

// ---------------------------------------------------------------- catalogue
router.get('/services', wrap((_req, res) => {
  res.json(db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY category, name').all());
}));

router.post('/services', adminOnly, wrap((req, res) => {
  required(req.body, ['code', 'name', 'price']);
  const info = db.prepare('INSERT INTO services (code, name, category, price, tax_pct) VALUES (?, ?, ?, ?, ?)')
    .run(str(req.body.code).toUpperCase(), str(req.body.name), str(req.body.category, 'other'),
         num(req.body.price), num(req.body.taxPct, 0));
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.get('/lab-tests', wrap((_req, res) => {
  res.json(db.prepare('SELECT * FROM lab_tests WHERE active = 1 ORDER BY category, name').all());
}));

router.post('/lab-tests', requireRole('admin', 'lab'), wrap((req, res) => {
  required(req.body, ['code', 'name']);
  const info = db.prepare(
    `INSERT INTO lab_tests (code, name, category, sample_type, unit, ref_low, ref_high, ref_text, price, tat_hours)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(str(req.body.code).toUpperCase(), str(req.body.name), str(req.body.category, 'lab'),
        str(req.body.sampleType), str(req.body.unit),
        req.body.refLow === undefined ? null : num(req.body.refLow),
        req.body.refHigh === undefined ? null : num(req.body.refHigh),
        str(req.body.refText), num(req.body.price, 0), int(req.body.tatHours, 24) || 24);
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.get('/icd', wrap((req, res) => {
  const q = str(req.query.q, '');
  res.json(db.prepare(
    `SELECT * FROM icd_codes WHERE code LIKE ? OR title LIKE ? ORDER BY code LIMIT 40`
  ).all(`%${q}%`, `%${q}%`));
}));

router.get('/assistance-programs', wrap((_req, res) => {
  res.json(db.prepare('SELECT * FROM assistance_programs WHERE active = 1 ORDER BY coverage_pct DESC').all());
}));

router.get('/sliding-scale', wrap((_req, res) => {
  res.json({
    bands: db.prepare('SELECT * FROM sliding_scale_bands WHERE active = 1 ORDER BY fpl_min').all(),
    povertyGuidelines: db.prepare('SELECT * FROM poverty_guidelines ORDER BY household_size').all(),
  });
}));

module.exports = router;
