'use strict';
/**
 * The six books the owner's reports read from, and the people who write them.
 *
 * These are deliberately not owner-only. The owner reads the reports; the
 * clinic writes the registers, and it has to be the person who was there —
 * the nurse who saw the near miss, the housekeeper who did the round, the
 * administrator who marks the roster. A safety register that only a director
 * can write to is a safety register with nothing in it.
 *
 * Two of the six are more guarded than the rest. Payroll says what each
 * person is paid, which is nobody's business but the owner's and the
 * administrator's. The opening position behind the balance sheet is the
 * owner's alone and lives on the owner route, not here.
 *
 * One rule applies across all of them: a record of something that went wrong
 * is never deleted. It is closed, withdrawn or superseded. A register that
 * can be tidied up is not evidence of anything.
 */
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, badRequest, forbidden } = require('../lib/http');
const { requireAuth, requireRole, hasFullAccess } = require('../lib/auth');
const { required, str, int, num, oneOf, paging } = require('../lib/validate');
const { generate } = require('../lib/ids');
const audit = require('../lib/audit');

const router = express.Router();
const today = () => new Date().toISOString().slice(0, 10);

/*
 * Anybody on the floor may raise a complaint or an incident. That is the
 * point: the person who saw it is the person who should write it down, and
 * a form that first asks whether you are senior enough gets nothing.
 */
const anyStaff = requireAuth;
const quality = requireRole('reception', 'nurse', 'counselor', 'lab', 'pharmacy', 'ward', 'doctor', 'cashier');
const rostering = requireRole('reception', 'nurse', 'ward');
const payrollRoles = requireRole();   // owner and admin only — see FULL_ACCESS

/** Only the owner and an administrator see what anybody is paid. */
function requirePay(req, _res, next) {
  if (hasFullAccess(req.user)) return next();
  next(forbidden('Payroll is the owner\'s and the administrator\'s.'));
}

const list = (sql, params = []) => db.prepare(sql).all(...params);

/* =============================================================== complaints */

const COMPLAINT_CATEGORIES = ['waiting_time', 'staff_conduct', 'clinical_care', 'billing',
  'cleanliness', 'facilities', 'pharmacy', 'diagnostics', 'other'];
const COMPLAINT_CHANNELS = ['in_person', 'phone', 'whatsapp', 'email', 'letter', 'online', 'box'];
const COMPLAINT_STATUS = ['open', 'investigating', 'resolved', 'closed', 'withdrawn'];
const SEVERITY = ['minor', 'moderate', 'serious'];

router.get('/complaints/meta', anyStaff, wrap((req, res) => res.json({
  categories: COMPLAINT_CATEGORIES, channels: COMPLAINT_CHANNELS,
  statuses: COMPLAINT_STATUS, severities: SEVERITY,
  departments: list('SELECT id, name FROM departments WHERE active = 1 ORDER BY sort_order, name'),
})));

router.get('/complaints', anyStaff, wrap((req, res) => {
  const status = oneOf(req.query.status, COMPLAINT_STATUS, 'status');
  const { limit, offset } = paging(req.query, 200);
  res.json(list(
    `SELECT c.*, d.name AS department,
            p.first_name || ' ' || COALESCE(p.last_name, '') AS patient
       FROM complaints c
       LEFT JOIN departments d ON d.id = c.department_id
       LEFT JOIN patients p ON p.id = c.patient_id
      ${status ? 'WHERE c.status = ?' : ''}
      ORDER BY c.received_on DESC, c.id DESC LIMIT ? OFFSET ?`,
    status ? [status, limit, offset] : [limit, offset]));
}));

router.post('/complaints', quality, wrap((req, res) => {
  required(req.body, ['detail']);
  const ref = generate('complaint');
  const info = db.prepare(
    `INSERT INTO complaints (ref_no, patient_id, complainant, contact, received_on, channel,
       category, department_id, severity, detail, action_taken, owner_name, due_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ref, req.body.patientId ? int(req.body.patientId) : null,
    str(req.body.complainant), str(req.body.contact),
    str(req.body.receivedOn) || today(),
    oneOf(req.body.channel, COMPLAINT_CHANNELS, 'channel') || 'in_person',
    oneOf(req.body.category, COMPLAINT_CATEGORIES, 'category') || 'other',
    req.body.departmentId ? int(req.body.departmentId) : null,
    oneOf(req.body.severity, SEVERITY, 'severity') || 'minor',
    str(req.body.detail), str(req.body.actionTaken), str(req.body.ownerName),
    str(req.body.dueDate), req.user.id);

  audit.log(req, 'complaint_add', 'complaint', info.lastInsertRowid, { ref });
  res.status(201).json(db.prepare('SELECT * FROM complaints WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/complaints/:id', quality, wrap((req, res) => {
  const id = int(req.params.id);
  const existing = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
  if (!existing) throw notFound('No such complaint.');
  const status = req.body.status === undefined
    ? existing.status : oneOf(req.body.status, COMPLAINT_STATUS, 'status');
  const closed = ['resolved', 'closed', 'withdrawn'].includes(status);

  db.prepare(
    `UPDATE complaints SET
       action_taken = COALESCE(?, action_taken), owner_name = COALESCE(?, owner_name),
       due_date = COALESCE(?, due_date), resolution = COALESCE(?, resolution),
       severity = COALESCE(?, severity), status = ?,
       satisfied = COALESCE(?, satisfied),
       resolved_on = CASE WHEN ? THEN COALESCE(resolved_on, date('now')) ELSE NULL END
     WHERE id = ?`
  ).run(str(req.body.actionTaken), str(req.body.ownerName), str(req.body.dueDate),
    str(req.body.resolution),
    req.body.severity === undefined ? null : oneOf(req.body.severity, SEVERITY, 'severity'),
    status,
    req.body.satisfied === undefined ? null : (req.body.satisfied ? 1 : 0),
    closed ? 1 : 0, id);

  audit.log(req, 'complaint_edit', 'complaint', id, { status });
  res.json(db.prepare('SELECT * FROM complaints WHERE id = ?').get(id));
}));

/* ======================================================== safety incidents */

const INCIDENT_KINDS = ['medication', 'fall', 'identification', 'procedure', 'specimen',
  'equipment', 'infection', 'documentation', 'delay', 'other'];
const HARM = ['near_miss', 'no_harm', 'minor', 'moderate', 'severe', 'death'];
const INCIDENT_STATUS = ['open', 'investigating', 'action_agreed', 'closed'];

router.get('/incidents/meta', anyStaff, wrap((req, res) => res.json({
  kinds: INCIDENT_KINDS, harms: HARM, statuses: INCIDENT_STATUS,
  departments: list('SELECT id, name FROM departments WHERE active = 1 ORDER BY sort_order, name'),
})));

router.get('/incidents', anyStaff, wrap((req, res) => {
  const { limit, offset } = paging(req.query, 200);
  res.json(list(
    `SELECT i.*, d.name AS department, u.name AS reported_by_name
       FROM safety_incidents i
       LEFT JOIN departments d ON d.id = i.department_id
       LEFT JOIN users u ON u.id = i.reported_by
      ORDER BY i.happened_on DESC, i.id DESC LIMIT ? OFFSET ?`, [limit, offset]));
}));

router.post('/incidents', quality, wrap((req, res) => {
  required(req.body, ['detail']);
  const happened = str(req.body.happenedOn) || today();
  if (happened > today()) throw badRequest('That date is in the future.');
  const ref = generate('incident');
  const info = db.prepare(
    `INSERT INTO safety_incidents (ref_no, happened_on, happened_at, patient_id, department_id,
       location, kind, harm, detail, immediate_action, reported_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ref, happened, str(req.body.happenedAt),
    req.body.patientId ? int(req.body.patientId) : null,
    req.body.departmentId ? int(req.body.departmentId) : null,
    str(req.body.location),
    oneOf(req.body.kind, INCIDENT_KINDS, 'kind') || 'other',
    oneOf(req.body.harm, HARM, 'harm') || 'near_miss',
    str(req.body.detail), str(req.body.immediateAction), req.user.id);

  audit.log(req, 'incident_add', 'incident', info.lastInsertRowid, { ref });
  res.status(201).json(db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/incidents/:id', quality, wrap((req, res) => {
  const id = int(req.params.id);
  const existing = db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(id);
  if (!existing) throw notFound('No such incident.');
  const status = req.body.status === undefined
    ? existing.status : oneOf(req.body.status, INCIDENT_STATUS, 'status');

  /*
   * An incident that caused harm cannot be closed with nothing written in
   * the root cause and the corrective action. Closing it is the clinic
   * saying it learned something; if nothing is written, nothing was learned
   * and the record would say otherwise.
   */
  const rootCause = str(req.body.rootCause) || existing.root_cause;
  const corrective = str(req.body.correctiveAction) || existing.corrective_action;
  const harmful = ['minor', 'moderate', 'severe', 'death'].includes(existing.harm);
  if (status === 'closed' && harmful && (!rootCause || !corrective)) {
    throw badRequest('An incident that reached a patient needs a root cause and a corrective action before it can be closed.');
  }

  db.prepare(
    `UPDATE safety_incidents SET
       root_cause = COALESCE(?, root_cause), corrective_action = COALESCE(?, corrective_action),
       immediate_action = COALESCE(?, immediate_action),
       owner_name = COALESCE(?, owner_name), due_date = COALESCE(?, due_date),
       harm = COALESCE(?, harm), status = ?,
       closed_on = CASE WHEN ? THEN COALESCE(closed_on, date('now')) ELSE NULL END
     WHERE id = ?`
  ).run(str(req.body.rootCause), str(req.body.correctiveAction), str(req.body.immediateAction),
    str(req.body.ownerName), str(req.body.dueDate),
    req.body.harm === undefined ? null : oneOf(req.body.harm, HARM, 'harm'),
    status, status === 'closed' ? 1 : 0, id);

  audit.log(req, 'incident_edit', 'incident', id, { status });
  res.json(db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(id));
}));

/* ========================================================== hygiene rounds */

const HYGIENE_KINDS = ['housekeeping', 'disinfection', 'biomedical_waste',
  'hand_hygiene_audit', 'sterilisation', 'water_quality', 'pest_control'];
const SHIFTS = ['morning', 'afternoon', 'evening', 'night'];

router.get('/hygiene/meta', anyStaff, wrap((req, res) => res.json({
  kinds: HYGIENE_KINDS, shifts: SHIFTS,
  // Somewhere to start: the areas a polyclinic actually walks round.
  areas: ['Reception', 'OPD corridor', 'Consultation rooms', 'Nurse station',
    'Laboratory', 'Sample collection', 'X-ray room', 'Pharmacy', 'Day care',
    'Ward', 'Toilets', 'Biomedical waste store', 'Water tank'],
})));

router.get('/hygiene', anyStaff, wrap((req, res) => {
  const { limit, offset } = paging(req.query, 200);
  res.json(list(
    `SELECT h.*, u.name AS verified_by_name FROM hygiene_rounds h
       LEFT JOIN users u ON u.id = h.verified_by
      ORDER BY h.on_date DESC, h.id DESC LIMIT ? OFFSET ?`, [limit, offset]));
}));

router.post('/hygiene', quality, wrap((req, res) => {
  required(req.body, ['area']);
  const onDate = str(req.body.onDate) || today();
  if (onDate > today()) throw badRequest('That date is in the future.');
  const score = req.body.score === undefined || req.body.score === '' ? null : num(req.body.score);
  if (score !== null && (score < 0 || score > 100)) throw badRequest('A score runs from 0 to 100.');

  /*
   * Pass or fail is taken from the score where one is given, so a round
   * cannot be scored 40 and ticked as passed. Where there is no score the
   * person doing the round says, because a hand-hygiene audit and a waste
   * check are not both marked out of a hundred.
   */
  const passed = score !== null ? (score >= 80 ? 1 : 0)
    : (req.body.passed === undefined ? null : (req.body.passed ? 1 : 0));

  const info = db.prepare(
    `INSERT INTO hygiene_rounds (on_date, shift, area, kind, score, passed, issues,
       action_taken, done_by, verified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(onDate, oneOf(req.body.shift, SHIFTS, 'shift') || 'morning',
    str(req.body.area), oneOf(req.body.kind, HYGIENE_KINDS, 'kind') || 'housekeeping',
    score, passed, str(req.body.issues), str(req.body.actionTaken),
    str(req.body.doneBy), req.user.id);

  audit.log(req, 'hygiene_round', 'hygiene', info.lastInsertRowid, { area: str(req.body.area) });
  res.status(201).json(db.prepare('SELECT * FROM hygiene_rounds WHERE id = ?').get(info.lastInsertRowid));
}));

/* ======================================================= compliance register */

const COMPLIANCE_KINDS = ['licence', 'registration', 'insurance', 'contract', 'certification', 'tax', 'other'];
const COMPLIANCE_STATUS = ['active', 'applied', 'lapsed', 'not_required', 'superseded'];

router.get('/compliance/meta', anyStaff, wrap((req, res) => res.json({
  kinds: COMPLIANCE_KINDS, statuses: COMPLIANCE_STATUS,
  /*
   * The paperwork a polyclinic in Tamil Nadu is actually asked for, offered
   * as a starting list. Nothing is created from it — an owner who has no
   * X-ray unit should not be nagged about an AERB registration — but a blank
   * page with no prompts is how a register ends up with three entries and a
   * surprise inspection.
   */
  suggestions: [
    'Clinical Establishment registration', 'Pharmacy / drug licence (Form 20 & 21)',
    'Biomedical waste authorisation', 'AERB registration — X-ray',
    'Fire safety NOC', 'Trade licence', 'Lift licence',
    'Professional indemnity insurance', 'Fire and building insurance',
    'GST registration', 'PCPNDT registration — ultrasound',
    'Lab accreditation', 'Pollution control consent',
  ],
})));

router.get('/compliance', anyStaff, wrap((req, res) => res.json(list(
  `SELECT *, CAST(julianday(valid_till) - julianday('now') AS INTEGER) AS days_left
     FROM compliance_items WHERE active = 1
    ORDER BY valid_till IS NULL, valid_till`))));

router.post('/compliance', requireRole('reception', 'counselor'), wrap((req, res) => {
  required(req.body, ['name']);
  const info = db.prepare(
    `INSERT INTO compliance_items (name, kind, authority, reference_no, issued_on, valid_till,
       renewal_notice_days, owner_name, cost, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(str(req.body.name), oneOf(req.body.kind, COMPLIANCE_KINDS, 'kind') || 'licence',
    str(req.body.authority), str(req.body.referenceNo), str(req.body.issuedOn),
    str(req.body.validTill),
    req.body.renewalNoticeDays ? int(req.body.renewalNoticeDays) : 60,
    str(req.body.ownerName),
    req.body.cost === undefined || req.body.cost === '' ? null : num(req.body.cost),
    oneOf(req.body.status, COMPLIANCE_STATUS, 'status') || 'active',
    str(req.body.notes), req.user.id);

  audit.log(req, 'compliance_add', 'compliance', info.lastInsertRowid, { name: str(req.body.name) });
  res.status(201).json(db.prepare('SELECT * FROM compliance_items WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/compliance/:id', requireRole('reception', 'counselor'), wrap((req, res) => {
  const id = int(req.params.id);
  const existing = db.prepare('SELECT * FROM compliance_items WHERE id = ?').get(id);
  if (!existing) throw notFound('No such item.');
  db.prepare(
    `UPDATE compliance_items SET
       name = COALESCE(?, name), authority = COALESCE(?, authority),
       reference_no = COALESCE(?, reference_no), issued_on = COALESCE(?, issued_on),
       valid_till = COALESCE(?, valid_till), owner_name = COALESCE(?, owner_name),
       renewal_notice_days = COALESCE(?, renewal_notice_days),
       cost = COALESCE(?, cost), status = COALESCE(?, status), notes = COALESCE(?, notes),
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(str(req.body.name), str(req.body.authority), str(req.body.referenceNo),
    str(req.body.issuedOn), str(req.body.validTill), str(req.body.ownerName),
    req.body.renewalNoticeDays ? int(req.body.renewalNoticeDays) : null,
    req.body.cost === undefined || req.body.cost === '' ? null : num(req.body.cost),
    req.body.status === undefined ? null : oneOf(req.body.status, COMPLIANCE_STATUS, 'status'),
    str(req.body.notes), id);

  audit.log(req, 'compliance_edit', 'compliance', id, {});
  res.json(db.prepare('SELECT * FROM compliance_items WHERE id = ?').get(id));
}));

/* ========================================================= staff attendance */

const ATT_SHIFTS = ['general', 'morning', 'evening', 'night', 'on_call'];
const ATT_STATUS = ['present', 'absent', 'leave', 'week_off', 'holiday', 'half_day'];

router.get('/attendance/meta', anyStaff, wrap((req, res) => res.json({
  shifts: ATT_SHIFTS, statuses: ATT_STATUS,
  staff: list(`SELECT id, name, role FROM users WHERE active = 1 ORDER BY name`),
})));

router.get('/attendance', anyStaff, wrap((req, res) => {
  const on = str(req.query.date) || today();
  res.json({
    date: on,
    rows: list(
      `SELECT u.id AS user_id, u.name, u.role, a.id AS attendance_id, a.shift, a.status,
              a.in_at, a.out_at, a.worked_hours, a.overtime_hours, a.notes
         FROM users u
         LEFT JOIN staff_attendance a ON a.user_id = u.id AND a.on_date = ?
        WHERE u.active = 1 ORDER BY u.name`, [on]),
  });
}));

router.put('/attendance', rostering, wrap((req, res) => {
  const on = str(req.body.date) || today();
  if (on > today()) throw badRequest('That date is in the future.');
  const marks = Array.isArray(req.body.marks) ? req.body.marks : null;
  if (!marks) throw badRequest('Send the marks as { date, marks: [...] }.');

  const up = db.prepare(
    `INSERT INTO staff_attendance (user_id, on_date, shift, status, in_at, out_at,
       worked_hours, overtime_hours, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, on_date, shift) DO UPDATE SET
       status = excluded.status, in_at = excluded.in_at, out_at = excluded.out_at,
       worked_hours = excluded.worked_hours, overtime_hours = excluded.overtime_hours,
       notes = excluded.notes, recorded_by = excluded.recorded_by`);

  db.transaction(() => {
    for (const m of marks) {
      if (!m || !m.userId) continue;
      up.run(int(m.userId), on,
        oneOf(m.shift, ATT_SHIFTS, 'shift') || 'general',
        oneOf(m.status, ATT_STATUS, 'status') || 'present',
        str(m.inAt), str(m.outAt),
        m.workedHours === undefined || m.workedHours === '' ? null : num(m.workedHours),
        m.overtimeHours === undefined || m.overtimeHours === '' ? 0 : num(m.overtimeHours),
        str(m.notes), req.user.id);
    }
  })();

  audit.log(req, 'attendance_mark', 'attendance', null, { date: on, marks: marks.length });
  res.json({ date: on, saved: marks.length });
}));

/* ================================================================= payroll */

const PAYROLL_KINDS = ['salary', 'doctor_payout', 'contract', 'stipend'];

router.get('/payroll/meta', requirePay, payrollRoles, wrap((req, res) => res.json({
  kinds: PAYROLL_KINDS,
  staff: list('SELECT id, name, role, department_id FROM users WHERE active = 1 ORDER BY name'),
  departments: list('SELECT id, name FROM departments WHERE active = 1 ORDER BY sort_order, name'),
})));

router.get('/payroll', requirePay, payrollRoles, wrap((req, res) => {
  const period = str(req.query.period) || today().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw badRequest('Give the month as YYYY-MM.');
  res.json({
    period,
    rows: list(
      `SELECT p.*, d.name AS department FROM payroll_lines p
         LEFT JOIN departments d ON d.id = p.department_id
        WHERE p.period = ? ORDER BY p.kind, p.person`, [period]),
  });
}));

router.post('/payroll', requirePay, payrollRoles, wrap((req, res) => {
  required(req.body, ['period', 'person']);
  const period = str(req.body.period);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw badRequest('Give the month as YYYY-MM.');

  const basic = num(req.body.basic, 0);
  const allowances = num(req.body.allowances, 0);
  const overtime = num(req.body.overtime, 0);
  const deductions = num(req.body.deductions, 0);
  // Worked out rather than typed, so the row always adds up. A net pay that
  // disagrees with its own components is the one thing a payroll must never
  // print.
  const net = Math.round((basic + allowances + overtime - deductions) * 100) / 100;
  if (net < 0) throw badRequest('Deductions come to more than the pay.');

  const info = db.prepare(
    `INSERT INTO payroll_lines (period, user_id, person, role, department_id, kind,
       basic, allowances, overtime, deductions, net_pay, paid_on, mode, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (period, person, kind) DO UPDATE SET
       basic = excluded.basic, allowances = excluded.allowances, overtime = excluded.overtime,
       deductions = excluded.deductions, net_pay = excluded.net_pay,
       paid_on = excluded.paid_on, mode = excluded.mode, notes = excluded.notes`
  ).run(period, req.body.userId ? int(req.body.userId) : null,
    str(req.body.person), str(req.body.role),
    req.body.departmentId ? int(req.body.departmentId) : null,
    oneOf(req.body.kind, PAYROLL_KINDS, 'kind') || 'salary',
    basic, allowances, overtime, deductions, net,
    str(req.body.paidOn), str(req.body.mode), str(req.body.notes), req.user.id);

  audit.log(req, 'payroll_line', 'payroll', info.lastInsertRowid, { period });
  res.status(201).json(db.prepare(
    'SELECT * FROM payroll_lines WHERE period = ? AND person = ? AND kind = ?')
    .get(period, str(req.body.person), oneOf(req.body.kind, PAYROLL_KINDS, 'kind') || 'salary'));
}));

router.delete('/payroll/:id', requirePay, payrollRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const row = db.prepare('SELECT * FROM payroll_lines WHERE id = ?').get(id);
  if (!row) throw notFound('No such payroll line.');
  db.prepare('DELETE FROM payroll_lines WHERE id = ?').run(id);
  audit.log(req, 'payroll_delete', 'payroll', id, { period: row.period, person: row.person });
  res.json({ ok: true });
}));

module.exports = router;
