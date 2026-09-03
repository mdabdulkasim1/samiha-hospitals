'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, conflict, badRequest } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, num, int, bool } = require('../lib/validate');
const audit = require('../lib/audit');
const { generate, doctorCode } = require('../lib/ids');
const { hashPassword } = require('../lib/auth');
const scheduling = require('../services/scheduling');
const config = require('../config');

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
            d.name AS department_name, dp.doctor_code, dp.qualification, dp.specialization,
            dp.consult_fee, dp.follow_up_fee, dp.slot_minutes, dp.room_no
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
      WHERE (? IS NULL OR u.role = ?)
      ORDER BY u.role, u.name`
  ).all(role, role);
  res.json(rows);
}));

router.get('/staff/:id', requireRole('admin', 'reception'), wrap((req, res) => {
  const id = int(req.params.id);
  const user = db.prepare(
    `SELECT u.id, u.staff_code, u.name, u.email, u.phone, u.role, u.active, u.department_id,
            u.last_login_at, u.created_at, d.name AS department_name,
            dp.doctor_code, dp.qualification, dp.specialization, dp.reg_no, dp.consult_fee,
            dp.follow_up_fee, dp.slot_minutes, dp.room_no, dp.signature_line
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
      WHERE u.id = ?`
  ).get(id);
  if (!user) throw notFound('Staff member not found');

  if (user.role === 'doctor') {
    user.sessions = db.prepare(
      'SELECT * FROM doctor_schedules WHERE doctor_id = ? ORDER BY weekday, start_time'
    ).all(id);
    user.availability = db.prepare(
      `SELECT * FROM doctor_availability
        WHERE doctor_id = ? AND avail_date >= date('now')
        ORDER BY avail_date, start_time LIMIT 120`
    ).all(id);
    user.leaves = db.prepare(
      "SELECT * FROM doctor_leaves WHERE doctor_id = ? AND leave_date >= date('now') ORDER BY leave_date"
    ).all(id);
    user.stats = db.prepare(
      `SELECT (SELECT COUNT(*) FROM appointments a WHERE a.doctor_id = ? AND a.status NOT IN ('cancelled','no_show')) AS appointments,
              (SELECT COUNT(*) FROM visits v WHERE v.doctor_id = ?) AS visits,
              (SELECT COUNT(*) FROM consultations c WHERE c.doctor_id = ?) AS consultations`
    ).get(id, id, id);
  }
  res.json(user);
}));

router.post('/staff', adminOnly, wrap((req, res) => {
  required(req.body, ['name', 'role', 'password']);
  const staffCode = str(req.body.staffCode) || generate('staff');
  const info = db.prepare(
    `INSERT INTO users (staff_code, name, email, phone, password_hash, role, department_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(staffCode, str(req.body.name), str(req.body.email) ? str(req.body.email).toLowerCase() : null,
        str(req.body.phone), hashPassword(req.body.password), str(req.body.role), int(req.body.departmentId) || null);

  let doctorCodeIssued = null;
  if (req.body.role === 'doctor') {
    // The code they will be known by on every prescription and report. It is
    // issued once, on joining, and never changes — printed sheets outlive edits.
    doctorCodeIssued = str(req.body.doctorCode)
      || doctorCode(str(req.body.name), config.clinic.code);
    const clash = db.prepare('SELECT user_id FROM doctor_profiles WHERE doctor_code = ?').get(doctorCodeIssued);
    if (clash) throw conflict(`Doctor code ${doctorCodeIssued} is already in use.`);

    db.prepare(
      `INSERT INTO doctor_profiles (user_id, doctor_code, qualification, specialization, reg_no,
                                    consult_fee, follow_up_fee, slot_minutes, room_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(info.lastInsertRowid, doctorCodeIssued, str(req.body.qualification), str(req.body.specialization),
          str(req.body.regNo), num(req.body.consultFee, 0), num(req.body.followUpFee, 0),
          int(req.body.slotMinutes, 15) || 15, str(req.body.roomNo));
  }
  audit.log(req, 'create', 'user', info.lastInsertRowid, { role: req.body.role, doctorCode: doctorCodeIssued });
  res.status(201).json({ id: info.lastInsertRowid, staffCode, doctorCode: doctorCodeIssued });
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
    // A profile row may be missing if the account was created as another role.
    db.prepare('INSERT OR IGNORE INTO doctor_profiles (user_id) VALUES (?)').run(id);
    if (req.body.doctorCode !== undefined && str(req.body.doctorCode)) {
      const wanted = str(req.body.doctorCode).toUpperCase();
      const clash = db.prepare(
        'SELECT user_id FROM doctor_profiles WHERE doctor_code = ? AND user_id <> ?'
      ).get(wanted, id);
      if (clash) throw conflict(`Doctor code ${wanted} belongs to somebody else.`);
      db.prepare('UPDATE doctor_profiles SET doctor_code = ? WHERE user_id = ?').run(wanted, id);
    }
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
  const doctorId = int(req.params.id);
  const weekday = int(req.body.weekday);
  const start = str(req.body.startTime);
  const end = str(req.body.endTime);
  if (end <= start) throw badRequest('The session must end after it starts.');

  const clash = db.prepare(
    `SELECT * FROM doctor_schedules
      WHERE doctor_id = ? AND weekday = ? AND active = 1 AND start_time < ? AND end_time > ?`
  ).get(doctorId, weekday, end, start);
  if (clash) {
    throw conflict(`That overlaps an existing session on the same day (${clash.start_time}–${clash.end_time}).`);
  }

  const info = db.prepare(
    `INSERT INTO doctor_schedules (doctor_id, weekday, start_time, end_time, slot_minutes, max_tokens)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(doctorId, weekday, start, end,
        int(req.body.slotMinutes, 15) || 15, int(req.body.maxTokens, 40) || 40);
  audit.log(req, 'create', 'doctor_schedule', info.lastInsertRowid);
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.delete('/schedule/:scheduleId', requireRole('admin', 'reception'), wrap((req, res) => {
  db.prepare('DELETE FROM doctor_schedules WHERE id = ?').run(int(req.params.scheduleId));
  res.json({ ok: true });
}));

// ------------------------------------------------- fixed visiting hours
/**
 * Our consultants sit for two or three hours on days that are agreed, so admin
 * fixes the exact date and window. Anything set here replaces the weekly rota
 * for that date, and is what the appointment screen and the WhatsApp bot offer.
 */
router.get('/doctors/:id/availability', wrap((req, res) => {
  const doctorId = int(req.params.id);
  const from = str(req.query.from) || scheduling.dateKey(new Date());
  const to = str(req.query.to) || scheduling.dateKey(new Date(Date.now() + 60 * 86400000));
  const rows = db.prepare(
    `SELECT a.*, u.name AS set_by FROM doctor_availability a
       LEFT JOIN users u ON u.id = a.created_by
      WHERE a.doctor_id = ? AND a.avail_date BETWEEN ? AND ?
      ORDER BY a.avail_date, a.start_time`
  ).all(doctorId, from, to);

  // Say plainly how many patients each window actually holds, and how many of
  // those are already taken — that is the number the desk needs.
  for (const r of rows) {
    const total = slotsInWindow(r);
    const booked = db.prepare(
      `SELECT COUNT(*) AS c FROM appointments
        WHERE doctor_id = ? AND date(scheduled_at) = ?
          AND time(scheduled_at) >= ? AND time(scheduled_at) < ?
          AND status NOT IN ('cancelled','no_show')`
    ).get(doctorId, r.avail_date, `${r.start_time}:00`, `${r.end_time}:00`).c;
    r.capacity = total;
    r.booked = booked;
    r.free = Math.max(total - booked, 0);
    r.on_leave = scheduling.isOnLeave(doctorId, r.avail_date) ? 1 : 0;
  }
  res.json({ from, to, rows });
}));

/** How many patients a window holds, honouring the doctor's own cap. */
function slotsInWindow(row) {
  const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  const step = row.slot_minutes || 15;
  const fits = Math.max(Math.floor((mins(row.end_time) - mins(row.start_time)) / step), 0);
  return row.max_tokens > 0 ? Math.min(fits, row.max_tokens) : fits;
}

/**
 * Add one window, or repeat it across a date range. `dates` takes an explicit
 * list; `from`/`to` with optional `weekdays` fills a range — which is how a
 * "Tuesdays and Fridays, 6 to 8, for the next month" rota gets entered once.
 */
router.post('/doctors/:id/availability', requireRole('admin', 'reception'), wrap((req, res) => {
  required(req.body, ['startTime', 'endTime']);
  const doctorId = int(req.params.id);
  const doctor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor'").get(doctorId);
  if (!doctor) throw notFound('Doctor not found');

  const start = str(req.body.startTime);
  const end = str(req.body.endTime);
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
    throw badRequest('Give the start and end as HH:MM, e.g. 18:00 and 20:00.');
  }
  if (end <= start) throw badRequest('The visiting window must end after it starts.');

  const slotMinutes = int(req.body.slotMinutes, 15) || 15;
  const maxTokens = int(req.body.maxTokens, 0);
  const note = str(req.body.note);

  // Work out which dates this applies to.
  let dates = [];
  if (Array.isArray(req.body.dates) && req.body.dates.length) {
    dates = req.body.dates.map((d) => str(d)).filter(Boolean);
  } else if (req.body.date) {
    dates = [str(req.body.date)];
  } else if (req.body.from && req.body.to) {
    const weekdays = Array.isArray(req.body.weekdays) ? req.body.weekdays.map(Number) : null;
    const first = scheduling.parseDateKey(str(req.body.from));
    const last = scheduling.parseDateKey(str(req.body.to));
    if (last < first) throw badRequest('The last date is before the first.');
    if ((last - first) / 86400000 > 366) throw badRequest('Set a range of a year or less.');
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
      if (weekdays && weekdays.length && !weekdays.includes(d.getDay())) continue;
      dates.push(scheduling.dateKey(d));
    }
  }
  if (!dates.length) throw badRequest('Give a date, a list of dates, or a from/to range.');
  for (const d of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw badRequest(`"${d}" is not a date (YYYY-MM-DD).`);
  }

  const added = [];
  const skipped = [];
  db.transaction(() => {
    for (const date of dates) {
      const clash = db.prepare(
        `SELECT start_time, end_time FROM doctor_availability
          WHERE doctor_id = ? AND avail_date = ? AND start_time < ? AND end_time > ?`
      ).get(doctorId, date, end, start);
      if (clash) { skipped.push({ date, reason: `overlaps ${clash.start_time}–${clash.end_time}` }); continue; }

      const info = db.prepare(
        `INSERT INTO doctor_availability
           (doctor_id, avail_date, start_time, end_time, slot_minutes, max_tokens, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(doctorId, date, start, end, slotMinutes, maxTokens, note, req.user.id);
      added.push({ id: info.lastInsertRowid, date });
    }
  })();

  audit.log(req, 'set_availability', 'doctor', doctorId, { added: added.length, start, end });
  res.status(201).json({ added: added.length, skipped, dates: added });
}));

router.delete('/availability/:availId', requireRole('admin', 'reception'), wrap((req, res) => {
  const row = db.prepare('SELECT * FROM doctor_availability WHERE id = ?').get(int(req.params.availId));
  if (!row) throw notFound('Visiting window not found');
  const booked = db.prepare(
    `SELECT COUNT(*) AS c FROM appointments
      WHERE doctor_id = ? AND date(scheduled_at) = ?
        AND time(scheduled_at) >= ? AND time(scheduled_at) < ?
        AND status NOT IN ('cancelled','no_show')`
  ).get(row.doctor_id, row.avail_date, `${row.start_time}:00`, `${row.end_time}:00`).c;
  if (booked && !req.query.force) {
    throw conflict(`${booked} patient(s) are already booked in that window. Move or cancel them first.`);
  }
  db.prepare('DELETE FROM doctor_availability WHERE id = ?').run(row.id);
  audit.log(req, 'delete', 'doctor_availability', row.id, { date: row.avail_date });
  res.json({ ok: true });
}));

router.post('/doctors/:id/leave', requireRole('admin', 'reception'), wrap((req, res) => {
  required(req.body, ['date']);
  db.prepare('INSERT OR REPLACE INTO doctor_leaves (doctor_id, leave_date, reason) VALUES (?, ?, ?)')
    .run(int(req.params.id), str(req.body.date), str(req.body.reason));
  res.status(201).json({ ok: true });
}));

// ---------------------------------------------------------------- catalogue
router.delete('/doctors/:id/leave/:date', requireRole('admin', 'reception'), wrap((req, res) => {
  db.prepare('DELETE FROM doctor_leaves WHERE doctor_id = ? AND leave_date = ?')
    .run(int(req.params.id), str(req.params.date));
  audit.log(req, 'delete', 'doctor_leave', int(req.params.id), { date: req.params.date });
  res.json({ ok: true });
}));

router.get('/services', wrap((_req, res) => {
  res.json(db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY category, name').all());
}));

/*
 * The diagnostics a doctor can order and a counter can charge for.
 *
 * A panel's own analytes — MCHC, direct bilirubin, the urine deposits — are
 * reported, not sold, so they are left out: a hundred unsellable buttons on an
 * order form only get in the way of the dozen that matter. Give one a rate and
 * it appears, because pricing a test is how the clinic says it offers that
 * test on its own.
 *
 * `?all=1` returns everything including the unpriced components, which is what
 * the rates screen shows: it is the one place the whole catalogue belongs.
 */
const SELLABLE = "(component_of IS NULL OR component_of = '' OR price > 0)";


/**
 * Everything the clinic can charge for, filed the way a cashier looks for it.
 *
 * Services and diagnostics live in different tables because they are different
 * things — one is done to a patient, the other is reported on — but at the
 * counter they are one list of chargeable items, so this is where they meet.
 * Each carries the kind it came from, because adding a diagnostic to a bill
 * has to raise the order as well as the charge.
 */
router.get('/catalogue', wrap((req, res) => {
  // The rates screen asks for everything, so the clinic can price an analyte
  // it wants to offer on its own; every other screen gets what is sellable.
  const includeComponents = String(req.query.all || '') === '1';
  const items = [
    ...db.prepare(
      `SELECT id, code, name, bill_group, price, tax_pct, 'service' AS kind, category
         FROM services WHERE active = 1`
    ).all(),
    ...db.prepare(
      `SELECT id, code, name, bill_group, price, 0 AS tax_pct, 'test' AS kind, category,
              component_of
         FROM lab_tests WHERE active = 1 ${includeComponents ? '' : `AND ${SELLABLE}`}`
    ).all(),
  ];

  // Group order is the order of a visit, not the alphabet: what a patient is
  // charged for first comes first.
  const ORDER = ['Consultation', 'Procedures & treatment', 'Blood tests', 'Urine & stool',
    'X-ray', 'Ultrasound & Doppler', 'ECG & heart', 'Nursing & ward', 'Ambulance & other'];
  const rank = (g) => { const i = ORDER.indexOf(g); return i === -1 ? ORDER.length : i; };

  const byGroup = new Map();
  for (const it of items) {
    const g = it.bill_group || 'Other';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(it);
  }
  res.json([...byGroup.entries()]
    .map(([group, rows]) => ({ group, items: rows.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => rank(a.group) - rank(b.group) || a.group.localeCompare(b.group)));
}));

/**
 * Set what an item costs. The clinic sets its own tariff, so this exists for
 * the rates screen; the code an item is known by is never editable, because
 * bills already printed refer to it.
 */
router.patch('/services/:id', adminOnly, wrap((req, res) => {
  const id = int(req.params.id);
  const row = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (!row) throw notFound('Service not found');
  const price = req.body.price === undefined ? row.price : num(req.body.price);
  if (price < 0) throw badRequest('A rate cannot be negative.');
  db.prepare('UPDATE services SET name = ?, price = ?, tax_pct = ?, bill_group = ?, active = ? WHERE id = ?')
    .run(str(req.body.name, row.name), price,
         req.body.taxPct === undefined ? row.tax_pct : num(req.body.taxPct),
         str(req.body.billGroup, row.bill_group),
         req.body.active === undefined ? row.active : (req.body.active ? 1 : 0), id);
  audit.log(req, 'update', 'service', id, { from: row.price, to: price });
  res.json(db.prepare('SELECT * FROM services WHERE id = ?').get(id));
}));

router.patch('/lab-tests/:id', requireRole('admin', 'lab'), wrap((req, res) => {
  const id = int(req.params.id);
  const row = db.prepare('SELECT * FROM lab_tests WHERE id = ?').get(id);
  if (!row) throw notFound('Test not found');
  const price = req.body.price === undefined ? row.price : num(req.body.price);
  if (price < 0) throw badRequest('A rate cannot be negative.');
  db.prepare('UPDATE lab_tests SET name = ?, price = ?, bill_group = ?, active = ? WHERE id = ?')
    .run(str(req.body.name, row.name), price, str(req.body.billGroup, row.bill_group),
         req.body.active === undefined ? row.active : (req.body.active ? 1 : 0), id);
  audit.log(req, 'update', 'lab_test', id, { from: row.price, to: price });
  res.json(db.prepare('SELECT * FROM lab_tests WHERE id = ?').get(id));
}));

router.post('/services', adminOnly, wrap((req, res) => {
  required(req.body, ['code', 'name', 'price']);
  const info = db.prepare('INSERT INTO services (code, name, category, price, tax_pct) VALUES (?, ?, ?, ?, ?)')
    .run(str(req.body.code).toUpperCase(), str(req.body.name), str(req.body.category, 'other'),
         num(req.body.price), num(req.body.taxPct, 0));
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.get('/lab-tests', wrap((req, res) => {
  const all = String(req.query.all || '') === '1';
  res.json(db.prepare(
    `SELECT * FROM lab_tests WHERE active = 1 ${all ? '' : `AND ${SELLABLE}`}
      ORDER BY category, bill_group, name`
  ).all());
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
