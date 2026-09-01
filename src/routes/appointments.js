'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, conflict } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, paging, phone } = require('../lib/validate');
const { generate } = require('../lib/ids');
const scheduling = require('../services/scheduling');
const whatsapp = require('../services/whatsapp');
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

// -------------------------------------------------------------------- list
router.get('/', deskRoles, wrap((req, res) => {
  const date = str(req.query.date);
  const status = str(req.query.status);
  const doctorId = req.query.doctorId ? int(req.query.doctorId) : null;
  const { limit, offset, page } = paging(req.query, 100);

  const rows = db.prepare(
    `SELECT a.*, u.name AS doctor_name, d.name AS department_name,
            p.uhid, (p.first_name || ' ' || COALESCE(p.last_name, '')) AS patient_name,
            p.phone AS patient_phone,
            (SELECT v.id FROM visits v WHERE v.appointment_id = a.id) AS visit_id
       FROM appointments a
       LEFT JOIN users u ON u.id = a.doctor_id
       LEFT JOIN departments d ON d.id = a.department_id
       LEFT JOIN patients p ON p.id = a.patient_id
      WHERE (? IS NULL OR date(a.scheduled_at) = ?)
        AND (? IS NULL OR a.status = ?)
        AND (? IS NULL OR a.doctor_id = ?)
      ORDER BY a.scheduled_at LIMIT ? OFFSET ?`
  ).all(date, date, status, status, doctorId, doctorId, limit, offset);

  res.json({ rows: rows.map((r) => ({ ...r, display_name: patientLabel(r), when: scheduling.humanDateTime(r.scheduled_at) })), page, limit });
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

  const info = db.prepare(
    `INSERT INTO appointments
       (appt_no, patient_id, guest_name, guest_phone, doctor_id, department_id, scheduled_at,
        slot_minutes, token_no, visit_kind, source, status, reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)`
  ).run(apptNo, patientId, str(req.body.guestName), phone(req.body.guestPhone), doctorId,
        int(req.body.departmentId) || doctor.department_id, scheduledAt,
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

  audit.log(req, 'create', 'appointment', info.lastInsertRowid, { apptNo, doctorId, scheduledAt });
  res.status(201).json(db.prepare('SELECT * FROM appointments WHERE id = ?').get(info.lastInsertRowid));
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
  audit.log(req, 'update', 'appointment', id, { status: req.body.status });
  res.json(updated);
}));

/** Queue board for the day: who is booked, who has arrived, who is in consult. */
router.get('/board', deskRoles, wrap((req, res) => {
  const date = str(req.query.date) || scheduling.dateKey(new Date());
  const rows = db.prepare(
    `SELECT a.id, a.appt_no, a.scheduled_at, a.token_no, a.status, a.source, a.reason,
            u.name AS doctor_name, p.uhid,
            COALESCE(p.first_name || ' ' || COALESCE(p.last_name,''), a.guest_name) AS patient_name
       FROM appointments a
       LEFT JOIN users u ON u.id = a.doctor_id
       LEFT JOIN patients p ON p.id = a.patient_id
      WHERE date(a.scheduled_at) = ?
      ORDER BY a.scheduled_at`
  ).all(date);
  res.json({ date, rows });
}));

module.exports = router;
