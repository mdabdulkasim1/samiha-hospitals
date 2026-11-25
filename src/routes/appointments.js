'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, conflict, forbidden } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, paging, phone } = require('../lib/validate');
const { generate } = require('../lib/ids');
const scheduling = require('../services/scheduling');
const whatsapp = require('../services/whatsapp');
const staffAlerts = require('../services/staffAlerts');
const audit = require('../lib/audit');

const router = express.Router();
const deskRoles = requireRole('reception', 'nurse', 'doctor', 'counselor', 'cashier');

const patientLabel = (a) => a.patient_name || a.guest_name || 'Unknown';

// ------------------------------------------------------------- availability
router.get('/availability', deskRoles, wrap((req, res) => {
  required(req.query, ['doctorId']);
  const doctorId = int(req.query.doctorId);
  const date = str(req.query.date);
  if (date) {
    return res.json({ date, slots: scheduling.availableSlots(doctorId, date).map((t) => ({ time: t, label: scheduling.to12h(t) })) });
  }
  res.json({ dates: scheduling.nextAvailableDates(doctorId, int(req.query.count, 7) || 7) });
}));

// ---------------------------------------------------------------- upcoming
/**
 * Upcoming appointment list based on the service list.
 * Supports filtering by service, department, doctor, status, date window, weekly/monthly diary ranges, and patient search.
 */
router.get('/upcoming', deskRoles, wrap((req, res) => {
  const serviceId = req.query.serviceId ? int(req.query.serviceId) : null;
  const departmentId = req.query.departmentId ? int(req.query.departmentId) : null;
  const doctorId = req.query.doctorId ? int(req.query.doctorId) : null;
  const status = str(req.query.status);
  const days = req.query.days ? int(req.query.days) : null;
  const fromDate = str(req.query.fromDate);
  const toDate = str(req.query.toDate);
  const month = str(req.query.month);
  const q = str(req.query.q);
  const maxLimit = (req.query.diary === '1' || req.query.view === 'weekly' || req.query.view === 'monthly') ? 1000 : 100;
  const { limit, offset, page } = paging(req.query, maxLimit);

  // Active services for the service list dropdown & categorization
  const services = db.prepare(
    'SELECT id, code, name, category, bill_group, price FROM services WHERE active = 1 ORDER BY category, name'
  ).all();

  // Active clinical departments
  const departments = db.prepare(
    'SELECT id, code, name, kind FROM departments WHERE active = 1 ORDER BY name'
  ).all();

  // Active consulting doctors
  const doctors = db.prepare(
    `SELECT u.id, u.name, d.name AS department_name, dp.specialization, dp.room_no
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
      WHERE u.role = 'doctor' AND u.active = 1
      ORDER BY u.name`
  ).all();

  // Date constraints: from today onwards or specific diary window
  const today = new Date().toISOString().slice(0, 10);
  const conditions = [];
  const params = [];

  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    const startOfMonth = `${month}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const endOfMonth = `${month}-${String(lastDay).padStart(2, '0')}`;
    conditions.push('date(a.scheduled_at) >= ?');
    params.push(startOfMonth);
    conditions.push('date(a.scheduled_at) <= ?');
    params.push(endOfMonth);
  } else if (fromDate && toDate) {
    conditions.push('date(a.scheduled_at) >= ?');
    params.push(fromDate);
    conditions.push('date(a.scheduled_at) <= ?');
    params.push(toDate);
  } else if (fromDate) {
    conditions.push('date(a.scheduled_at) >= ?');
    params.push(fromDate);
  } else {
    // Default: from today onwards
    conditions.push('date(a.scheduled_at) >= ?');
    params.push(today);
    if (days && days > 0) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      conditions.push('date(a.scheduled_at) <= ?');
      params.push(d.toISOString().slice(0, 10));
    }
  }

  if (serviceId) {
    conditions.push('a.service_id = ?');
    params.push(serviceId);
  }

  if (departmentId) {
    conditions.push('a.department_id = ?');
    params.push(departmentId);
  }

  if (doctorId) {
    conditions.push('a.doctor_id = ?');
    params.push(doctorId);
  }

  if (status) {
    conditions.push('a.status = ?');
    params.push(status);
  } else if (!req.query.allStatus) {
    // By default, upcoming appointments exclude cancelled and no-show
    conditions.push("a.status NOT IN ('cancelled', 'no_show')");
  }

  if (q) {
    conditions.push(`(
      p.first_name LIKE ? OR p.last_name LIKE ? OR p.uhid LIKE ? OR p.phone LIKE ?
      OR a.guest_name LIKE ? OR a.guest_phone LIKE ? OR a.appt_no LIKE ?
    )`);
    const term = `%${q}%`;
    params.push(term, term, term, term, term, term, term);
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const sql = `
    SELECT a.*,
           u.name AS doctor_name,
           d.name AS department_name,
           s.name AS service_name,
           s.code AS service_code,
           s.price AS service_price,
           s.category AS service_category,
           p.uhid,
           TRIM(CONCAT(p.first_name, ' ', COALESCE(p.last_name, ''))) AS patient_name,
           p.phone AS patient_phone,
           (SELECT v.id FROM visits v WHERE v.appointment_id = a.id ORDER BY v.id DESC LIMIT 1) AS visit_id
      FROM appointments a
      LEFT JOIN users u ON u.id = a.doctor_id
      LEFT JOIN departments d ON d.id = a.department_id
      LEFT JOIN services s ON s.id = a.service_id
      LEFT JOIN patients p ON p.id = a.patient_id
      ${whereClause}
      ORDER BY a.scheduled_at ASC
      LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(...params, limit, offset);

  // Compute summary stats across upcoming appointments
  const allUpcoming = db.prepare(`
    SELECT a.id, a.scheduled_at, a.status, a.service_id, a.department_id,
           COALESCE(s.name, CASE WHEN a.visit_kind = 'follow_up' THEN 'Consultation — follow-up' ELSE 'Consultation — new patient' END) AS service_name,
           COALESCE(d.name, 'General') AS department_name
      FROM appointments a
      LEFT JOIN services s ON s.id = a.service_id
      LEFT JOIN departments d ON d.id = a.department_id
     WHERE date(a.scheduled_at) >= ?
       AND a.status NOT IN ('cancelled', 'no_show')
  `).all(today);

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const next7Days = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  const summary = {
    total: allUpcoming.length,
    today: allUpcoming.filter(r => (r.scheduled_at || '').slice(0, 10) === today).length,
    tomorrow: allUpcoming.filter(r => (r.scheduled_at || '').slice(0, 10) === tomorrow).length,
    thisWeek: allUpcoming.filter(r => (r.scheduled_at || '').slice(0, 10) <= next7Days).length,
    byService: {},
    byDepartment: {},
  };

  for (const r of allUpcoming) {
    summary.byService[r.service_name] = (summary.byService[r.service_name] || 0) + 1;
    summary.byDepartment[r.department_name] = (summary.byDepartment[r.department_name] || 0) + 1;
  }

  res.json({
    rows: rows.map(r => ({
      ...r,
      display_name: patientLabel(r),
      when: scheduling.humanDateTime(r.scheduled_at),
      time: r.scheduled_at ? r.scheduled_at.slice(11, 16) : '',
      service_label: r.service_name || (r.visit_kind === 'follow_up' ? 'Consultation — follow-up' : 'Consultation — new patient'),
    })),
    services,
    departments,
    doctors,
    summary,
    today,
    page,
    limit,
  });
}));

// -------------------------------------------------------------------- list
router.get('/', deskRoles, wrap((req, res) => {
  const date = str(req.query.date);
  const status = str(req.query.status);
  const doctorId = req.query.doctorId ? int(req.query.doctorId) : null;
  const serviceId = req.query.serviceId ? int(req.query.serviceId) : null;
  const { limit, offset, page } = paging(req.query, 100);

  const rows = db.prepare(
    `SELECT a.*, u.name AS doctor_name, d.name AS department_name,
            s.name AS service_name, s.code AS service_code, s.price AS service_price,
            p.uhid, TRIM(CONCAT(p.first_name, ' ', COALESCE(p.last_name, ''))) AS patient_name,
            p.phone AS patient_phone,
            (SELECT v.id FROM visits v WHERE v.appointment_id = a.id ORDER BY v.id DESC LIMIT 1) AS visit_id
       FROM appointments a
       LEFT JOIN users u ON u.id = a.doctor_id
       LEFT JOIN departments d ON d.id = a.department_id
       LEFT JOIN services s ON s.id = a.service_id
       LEFT JOIN patients p ON p.id = a.patient_id
      WHERE (? IS NULL OR date(a.scheduled_at) = ?)
        AND (? IS NULL OR a.status = ?)
        AND (? IS NULL OR a.doctor_id = ?)
        AND (? IS NULL OR a.service_id = ?)
      ORDER BY a.scheduled_at LIMIT ? OFFSET ?`
  ).all(date, date, status, status, doctorId, doctorId, serviceId, serviceId, limit, offset);

  res.json({ rows: rows.map((r) => ({ ...r, display_name: patientLabel(r), when: scheduling.humanDateTime(r.scheduled_at) })), page, limit });
}));

// ------------------------------------------------------------------ my day
/**
 * A doctor's own clinic for a day — the screen they open on their phone to see
 * how many patients are booked and who they are. Doctors see themselves; admin
 * and the front desk can look at any doctor by passing `doctorId`.
 */
router.get('/my-day', deskRoles, wrap((req, res) => {
  const asked = req.query.doctorId ? int(req.query.doctorId) : null;
  const doctorId = (req.user.role === 'doctor' && !asked) ? req.user.id : (asked || req.user.id);
  if (req.user.role === 'doctor' && doctorId !== req.user.id) {
    throw forbidden('You can only open your own clinic list.');
  }
  const doctor = db.prepare(
    `SELECT u.id, u.name, u.phone, u.email, d.name AS department_name,
            dp.specialization, dp.room_no, dp.slot_minutes
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
      WHERE u.id = ? AND u.role = 'doctor'`
  ).get(doctorId);
  if (!doctor) throw notFound('Doctor not found');

  const date = str(req.query.date) || scheduling.dateKey(new Date());

  const rows = db.prepare(
    `SELECT a.*, p.uhid, p.phone AS patient_phone, p.age_years, p.gender, p.allergies,
            TRIM(CONCAT(p.first_name, ' ', COALESCE(p.last_name, ''))) AS patient_name,
            (SELECT v.id FROM visits v WHERE v.appointment_id = a.id ORDER BY v.id DESC LIMIT 1) AS visit_id,
            (SELECT v.status FROM visits v WHERE v.appointment_id = a.id ORDER BY v.id DESC LIMIT 1) AS visit_status
       FROM appointments a LEFT JOIN patients p ON p.id = a.patient_id
      WHERE a.doctor_id = ? AND date(a.scheduled_at) = ?
      ORDER BY a.scheduled_at`
  ).all(doctorId, date);

  const counted = rows.filter((r) => !['cancelled', 'no_show'].includes(r.status));
  const summary = {
    booked: counted.length,
    arrived: rows.filter((r) => r.status === 'checked_in' || r.visit_id).length,
    completed: rows.filter((r) => r.status === 'completed').length,
    cancelled: rows.filter((r) => r.status === 'cancelled').length,
    noShow: rows.filter((r) => r.status === 'no_show').length,
    newPatients: counted.filter((r) => r.visit_kind === 'new').length,
  };

  // The next few days they are sitting, so they can see the week at a glance.
  const upcoming = [];
  for (let i = 0; i < 21 && upcoming.length < 7; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const key = scheduling.dateKey(d);
    const hours = scheduling.windowLabel(doctorId, key);
    if (!hours || scheduling.isOnLeave(doctorId, key)) continue;
    upcoming.push({
      date: key,
      label: scheduling.humanDate(key),
      hours,
      booked: db.prepare(
        `SELECT COUNT(*) AS c FROM appointments WHERE doctor_id = ? AND date(scheduled_at) = ?
           AND status NOT IN ('cancelled','no_show')`
      ).get(doctorId, key).c,
      free: scheduling.availableSlots(doctorId, key).length,
    });
  }

  res.json({
    doctor,
    date,
    label: scheduling.humanDate(date),
    hours: scheduling.windowLabel(doctorId, date),
    onLeave: scheduling.isOnLeave(doctorId, date),
    summary,
    upcoming,
    rows: rows.map((r) => ({
      ...r,
      display_name: patientLabel(r),
      time: scheduling.to12h(r.scheduled_at.slice(11, 16)),
    })),
  });
}));

// ------------------------------------------------------------------- create
router.post('/', deskRoles, wrap((req, res) => {
  required(req.body, ['doctorId', 'scheduledAt']);
  const doctorId = int(req.body.doctorId);
  const scheduledAt = str(req.body.scheduledAt).replace('T', ' ').slice(0, 19).padEnd(19, ':00').slice(0, 19);
  const patientId = int(req.body.patientId) || null;

  if (!patientId && !str(req.body.guestName)) {
    throw conflict('Provide either an existing patientId or a guestName for an unregistered caller.');
  }
  if (!scheduling.isSlotFree(doctorId, scheduledAt)) {
    throw conflict('That slot is already booked or the doctor is on leave. Pick another time.');
  }

  const doctor = db.prepare(
    `SELECT u.*, dp.slot_minutes FROM users u LEFT JOIN doctor_profiles dp ON dp.user_id = u.id WHERE u.id = ?`
  ).get(doctorId);
  if (!doctor || doctor.role !== 'doctor') throw notFound('Doctor not found');

  const dateStr = scheduledAt.slice(0, 10);
  const apptNo = generate('appointment');
  const token = scheduling.nextToken(doctorId, dateStr);
  const serviceId = int(req.body.serviceId) || null;

  const info = db.prepare(
    `INSERT INTO appointments
       (appt_no, patient_id, guest_name, guest_phone, doctor_id, department_id, service_id, scheduled_at,
        slot_minutes, token_no, visit_kind, source, status, reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)`
  ).run(apptNo, patientId, str(req.body.guestName), phone(req.body.guestPhone), doctorId,
        int(req.body.departmentId) || doctor.department_id, serviceId, scheduledAt,
        int(req.body.slotMinutes, doctor.slot_minutes || 15) || 15, token,
        str(req.body.visitKind, 'new'), str(req.body.source, 'reception'),
        str(req.body.reason), req.user.id);

  const patient = patientId ? db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId) : null;
  const to = patient ? (patient.whatsapp || patient.phone) : phone(req.body.guestPhone);
  if (to) {
    whatsapp.notify({
      to, template: 'appointment_confirmed', refType: 'appointment', refId: info.lastInsertRowid,
      data: {
        apptNo, patientName: patient ? `${patient.first_name} ${patient.last_name || ''}`.trim() : str(req.body.guestName),
        doctorName: doctor.name, when: scheduling.humanDateTime(scheduledAt), token,
      },
    });
  }

  // The doctor hears about it on their own phone, not only on the desk screen.
  const created = db.prepare('SELECT * FROM appointments WHERE id = ?').get(info.lastInsertRowid);
  staffAlerts.appointmentBooked(created, {
    patientName: patient ? `${patient.first_name} ${patient.last_name || ''}`.trim() : str(req.body.guestName),
    bookedBy: req.user.name,
  });

  audit.log(req, 'create', 'appointment', info.lastInsertRowid, { apptNo, doctorId, scheduledAt });
  res.status(201).json(created);
}));

// ----------------------------------------------------------- reschedule etc.
router.patch('/:id', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  if (!appt) throw notFound('Appointment not found');

  if (req.body.scheduledAt) {
    const newAt = str(req.body.scheduledAt).replace('T', ' ').slice(0, 19).padEnd(19, ':00').slice(0, 19);
    if (newAt !== appt.scheduled_at && !scheduling.isSlotFree(appt.doctor_id, newAt)) {
      throw conflict('That slot is not free.');
    }
    db.prepare('UPDATE appointments SET scheduled_at = ?, token_no = ? WHERE id = ?')
      .run(newAt, scheduling.nextToken(appt.doctor_id, newAt.slice(0, 10)), id);
  }
  if (req.body.status) {
    db.prepare('UPDATE appointments SET status = ?, cancel_reason = COALESCE(?, cancel_reason) WHERE id = ?')
      .run(str(req.body.status), str(req.body.cancelReason), id);
  }
  if (req.body.patientId) {
    db.prepare('UPDATE appointments SET patient_id = ? WHERE id = ?').run(int(req.body.patientId), id);
  }
  if (req.body.serviceId !== undefined) {
    db.prepare('UPDATE appointments SET service_id = ? WHERE id = ?').run(int(req.body.serviceId) || null, id);
  }
  if (req.body.reason !== undefined) {
    db.prepare('UPDATE appointments SET reason = ? WHERE id = ?').run(str(req.body.reason), id);
  }

  const updated = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  if (req.body.status === 'cancelled') {
    const to = updated.guest_phone ||
      (updated.patient_id && db.prepare('SELECT whatsapp, phone FROM patients WHERE id = ?').get(updated.patient_id));
    const dest = typeof to === 'string' ? to : (to && (to.whatsapp || to.phone));
    if (dest) whatsapp.notify({ to: dest, template: 'appointment_cancelled', data: { apptNo: updated.appt_no }, refType: 'appointment', refId: id });
  }
  if (req.body.status === 'cancelled' || (req.body.scheduledAt && updated.scheduled_at !== appt.scheduled_at)) {
    const named = updated.patient_id
      ? db.prepare("SELECT TRIM(CONCAT(first_name, ' ', COALESCE(last_name,''))) AS n FROM patients WHERE id = ?")
          .get(updated.patient_id)
      : null;
    staffAlerts.appointmentChanged(updated, {
      patientName: named ? named.n.trim() : updated.guest_name,
      kind: req.body.status === 'cancelled' ? 'appointment_cancelled' : 'appointment_moved',
      headline: req.body.status === 'cancelled'
        ? `Appointment cancelled — ${named ? named.n.trim() : (updated.guest_name || 'a patient')}`
        : `Appointment moved — ${named ? named.n.trim() : (updated.guest_name || 'a patient')}`,
    });
  }

  audit.log(req, 'update', 'appointment', id, { status: req.body.status });
  res.json(updated);
}));

/** Queue board for the day: who is booked, who has arrived, who is in consult. */
router.get('/board', deskRoles, wrap((req, res) => {
  const date = str(req.query.date) || scheduling.dateKey(new Date());
  const rows = db.prepare(
    `SELECT a.id, a.appt_no, a.scheduled_at, a.token_no, a.status, a.source, a.reason,
            u.name AS doctor_name, p.uhid,
            COALESCE(NULLIF(TRIM(CONCAT(p.first_name, ' ', COALESCE(p.last_name,''))), ''), a.guest_name) AS patient_name
       FROM appointments a
       LEFT JOIN users u ON u.id = a.doctor_id
       LEFT JOIN patients p ON p.id = a.patient_id
      WHERE date(a.scheduled_at) = ?
      ORDER BY a.scheduled_at`
  ).all(date);
  res.json({ date, rows });
}));

// ------------------------------------------------------------- get single appointment
router.get('/:id(\\d+)', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const row = db.prepare(`
    SELECT a.*,
           u.name AS doctor_name,
           d.name AS department_name,
           s.name AS service_name,
           s.code AS service_code,
           s.price AS service_price,
           s.category AS service_category,
           p.uhid,
           TRIM(CONCAT(p.first_name, ' ', COALESCE(p.last_name, ''))) AS patient_name,
           p.phone AS patient_phone,
           (SELECT v.id FROM visits v WHERE v.appointment_id = a.id ORDER BY v.id DESC LIMIT 1) AS visit_id
      FROM appointments a
      LEFT JOIN users u ON u.id = a.doctor_id
      LEFT JOIN departments d ON d.id = a.department_id
      LEFT JOIN services s ON s.id = a.service_id
      LEFT JOIN patients p ON p.id = a.patient_id
     WHERE a.id = ?
  `).get(id);
  if (!row) throw notFound('Appointment not found');

  const formatted = {
    ...row,
    display_name: patientLabel(row),
    when: scheduling.humanDateTime(row.scheduled_at),
    time: row.scheduled_at ? row.scheduled_at.slice(11, 16) : '',
    service_label: row.service_name || (row.visit_kind === 'follow_up' ? 'Consultation — follow-up' : 'Consultation — new patient'),
  };
  res.json({ row: formatted, ...formatted });
}));

module.exports = router;
