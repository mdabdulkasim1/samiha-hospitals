'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, phone, paging } = require('../lib/validate');
const { generate } = require('../lib/ids');
const audit = require('../lib/audit');

/**
 * Everyone who makes contact becomes a patient record straight away, at the
 * 'enquiry' stage. If they already exist we link to them rather than creating a
 * second record, so a returning caller does not fork into two files.
 */
function linkOrCreateEnquiryPatient(req, { name, phoneNumber }) {
  if (!name) return null;

  if (phoneNumber) {
    const existing = db.prepare(
      'SELECT * FROM patients WHERE (phone = ? OR whatsapp = ?) AND active = 1 ORDER BY id LIMIT 1'
    ).get(phoneNumber, phoneNumber);
    if (existing) return existing;
  }

  const parts = String(name).trim().split(/\s+/);
  const info = db.prepare(
    `INSERT INTO patients (stage, enquiry_at, uhid, first_name, last_name, phone, whatsapp, created_by)
     VALUES ('enquiry', datetime('now'), ?, ?, ?, ?, ?, ?)`
  ).run(generate('uhid'), parts[0], parts.slice(1).join(' ') || null,
        phoneNumber, phoneNumber, req.user ? req.user.id : null);
  return db.prepare('SELECT * FROM patients WHERE id = ?').get(info.lastInsertRowid);
}

const router = express.Router();
const deskRoles = requireRole('reception', 'counselor', 'nurse', 'cashier');

/**
 * The first box of the workflow. Every contact — walk-in, phone, WhatsApp, web
 * form or camp — lands here, and is either converted to an appointment or closed.
 */
router.get('/', deskRoles, wrap((req, res) => {
  const status = str(req.query.status);
  const source = str(req.query.source);
  const { limit, offset, page } = paging(req.query, 50);
  const rows = db.prepare(
    `SELECT e.*, d.name AS department_name, u.name AS doctor_name, a.appt_no,
            p.uhid, p.stage AS patient_stage,
            (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            s.name AS assigned_to_name
       FROM enquiries e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN users u ON u.id = e.doctor_id
       LEFT JOIN users s ON s.id = e.assigned_to
       LEFT JOIN appointments a ON a.id = e.appointment_id
       LEFT JOIN patients p ON p.id = e.patient_id
      WHERE (? IS NULL OR e.status = ?) AND (? IS NULL OR e.source = ?)
      ORDER BY e.id DESC LIMIT ? OFFSET ?`
  ).all(status, status, source, source, limit, offset);
  const total = db.prepare(
    'SELECT COUNT(*) AS c FROM enquiries WHERE (? IS NULL OR status = ?) AND (? IS NULL OR source = ?)'
  ).get(status, status, source, source).c;
  res.json({ rows, total, page, limit });
}));

router.get('/stats', deskRoles, wrap((_req, res) => {
  res.json({
    byStatus: db.prepare('SELECT status, COUNT(*) AS c FROM enquiries GROUP BY status').all(),
    bySource: db.prepare('SELECT source, COUNT(*) AS c FROM enquiries GROUP BY source').all(),
    dueFollowUps: db.prepare(
      `SELECT COUNT(*) AS c FROM enquiries
        WHERE status IN ('new','contacted') AND follow_up_at IS NOT NULL AND follow_up_at <= datetime('now')`
    ).get().c,
  });
}));

router.post('/', deskRoles, wrap((req, res) => {
  required(req.body, ['name', 'source']);
  const refNo = generate('enquiry');
  const phoneNumber = phone(req.body.phone);

  // Link to an existing file, or open an enquiry-stage one.
  const patient = int(req.body.patientId)
    ? db.prepare('SELECT * FROM patients WHERE id = ?').get(int(req.body.patientId))
    : linkOrCreateEnquiryPatient(req, { name: str(req.body.name), phoneNumber });

  const info = db.prepare(
    `INSERT INTO enquiries (ref_no, source, name, phone, patient_id, department_id, doctor_id,
                            subject, notes, assigned_to, follow_up_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(refNo, str(req.body.source), str(req.body.name), phoneNumber,
        patient ? patient.id : null, int(req.body.departmentId) || null, int(req.body.doctorId) || null,
        str(req.body.subject), str(req.body.notes),
        int(req.body.assignedTo) || req.user.id, str(req.body.followUpAt), req.user.id);
  audit.log(req, 'create', 'enquiry', info.lastInsertRowid, { refNo, patientId: patient ? patient.id : null });
  res.status(201).json({
    ...db.prepare('SELECT * FROM enquiries WHERE id = ?').get(info.lastInsertRowid),
    patient: patient || null,
    patientStage: patient ? patient.stage : null,
  });
}));

router.patch('/:id', deskRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const enq = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id);
  if (!enq) throw notFound('Enquiry not found');
  db.prepare(
    `UPDATE enquiries
        SET status = COALESCE(?, status), notes = COALESCE(?, notes),
            assigned_to = COALESCE(?, assigned_to), follow_up_at = COALESCE(?, follow_up_at),
            patient_id = COALESCE(?, patient_id), department_id = COALESCE(?, department_id),
            doctor_id = COALESCE(?, doctor_id),
            closed_at = CASE WHEN ? IN ('converted','closed','lost') THEN datetime('now') ELSE closed_at END
      WHERE id = ?`
  ).run(str(req.body.status), str(req.body.notes),
        req.body.assignedTo === undefined ? null : int(req.body.assignedTo),
        str(req.body.followUpAt),
        req.body.patientId === undefined ? null : int(req.body.patientId),
        req.body.departmentId === undefined ? null : int(req.body.departmentId),
        req.body.doctorId === undefined ? null : int(req.body.doctorId),
        str(req.body.status), id);
  audit.log(req, 'update', 'enquiry', id, { status: req.body.status });
  res.json(db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id));
}));

module.exports = router;
