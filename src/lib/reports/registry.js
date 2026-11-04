'use strict';
/**
 * The owner's report shelf.
 *
 * Thirty-odd reports, one shape. Each declares what it is called, what it
 * needs, what its columns are and how to run it; the screen that shows them
 * is written once rather than thirty-odd times, and a report added later
 * needs no new screen at all.
 *
 * Two rules hold throughout, and they are the reason this file is longer
 * than the SQL in it:
 *
 *   A report says what it cannot know. Where the clinic does not record
 *   something, the report declares `needs` and the shelf shows it greyed
 *   with what is missing, instead of rendering an empty table that reads as
 *   "nothing went wrong this month". An empty complaints register and a
 *   clinic with no complaints look identical on screen and are not remotely
 *   the same thing.
 *
 *   A count is not a judgement. Several of these — waiting times, no-shows,
 *   wastage, incidents — are the sort of number that gets somebody blamed.
 *   Each carries the denominator it came from and a note on what would make
 *   it misleading, because a ward that reports more incidents is usually
 *   the ward that is reporting them.
 */
const { db } = require('../../db');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const today = () => new Date().toISOString().slice(0, 10);
const has = (table) => Boolean(
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table)
);
const count = (sql, ...args) => db.prepare(sql).get(...args).c;

/** Column kinds the viewer knows how to render. */
const T = {
  text: 'text', money: 'money', num: 'num', pct: 'pct', date: 'date',
  datetime: 'datetime', badge: 'badge', hours: 'hours',
};

const GROUPS = [
  { key: 'operations', label: 'Operations' },
  { key: 'clinical', label: 'Clinical & quality' },
  { key: 'stock', label: 'Stock, assets & supply' },
  { key: 'people', label: 'People' },
  { key: 'money', label: 'Money' },
  { key: 'accounts', label: 'Accounts & position' },
];

/* ======================================================= operations */

const registrationSummary = {
  key: 'registration',
  group: 'operations',
  title: 'Patient registration and visit summary',
  subtitle: 'Who came, who was new, and how the visits ended',
  run({ from, to }) {
    const daily = db.prepare(
      `SELECT date(v.arrived_at) AS day,
              COUNT(*) AS visits,
              SUM(CASE WHEN v.is_new_patient = 1 THEN 1 ELSE 0 END) AS new_patients,
              COUNT(DISTINCT v.patient_id) AS unique_patients,
              SUM(CASE WHEN v.status = 'checked_out' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN v.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN v.visit_type = 'emergency' THEN 1 ELSE 0 END) AS emergency
         FROM visits v
        WHERE date(v.arrived_at) BETWEEN date(?) AND date(?)
        GROUP BY day ORDER BY day DESC`).all(from, to);

    const registered = count(
      `SELECT COUNT(*) AS c FROM patients
        WHERE registered_at IS NOT NULL AND stage = 'registered'
          AND date(registered_at) BETWEEN date(?) AND date(?)`, from, to);
    const visits = daily.reduce((t, d) => t + d.visits, 0);
    const returning = visits - daily.reduce((t, d) => t + d.new_patients, 0);

    return {
      columns: [
        { key: 'day', label: 'Date', type: T.date },
        { key: 'visits', label: 'Visits', type: T.num },
        { key: 'unique_patients', label: 'Distinct patients', type: T.num },
        { key: 'new_patients', label: 'First visit', type: T.num },
        { key: 'emergency', label: 'Emergency', type: T.num },
        { key: 'completed', label: 'Checked out', type: T.num },
        { key: 'cancelled', label: 'Cancelled', type: T.num },
      ],
      rows: daily,
      tiles: [
        { label: 'Visits', value: visits },
        { label: 'Newly registered', value: registered, foot: 'Full registrations in the period' },
        { label: 'Return visits', value: returning, foot: `${pct(returning, visits) ?? 0}% of visits` },
        { label: 'Busiest day', value: daily.length
          ? daily.slice().sort((a, b) => b.visits - a.visits)[0].visits : 0,
        foot: daily.length ? daily.slice().sort((a, b) => b.visits - a.visits)[0].day : '—' },
      ],
      notes: ['A patient seen twice in the period is two visits and one distinct patient.'],
    };
  },
};

const doctorActivity = {
  key: 'doctors',
  group: 'operations',
  title: 'Doctor-wise consultation and attendance',
  subtitle: 'Who was seen by whom, and which sessions were kept',
  run({ from, to }) {
    const rows = db.prepare(
      `SELECT u.id, u.name AS doctor, d.name AS department,
              COUNT(DISTINCT v.id) AS visits,
              COUNT(DISTINCT c.id) AS consultations,
              COUNT(DISTINCT CASE WHEN c.signed_at IS NOT NULL THEN c.id END) AS signed,
              COUNT(DISTINCT date(v.arrived_at)) AS days_seen,
              AVG(CASE WHEN v.consult_start_at IS NOT NULL AND v.consult_end_at IS NOT NULL
                  THEN (julianday(v.consult_end_at) - julianday(v.consult_start_at)) * 1440 END) AS avg_minutes
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN visits v ON v.doctor_id = u.id
              AND date(v.arrived_at) BETWEEN date(?) AND date(?)
         LEFT JOIN consultations c ON c.visit_id = v.id
        WHERE u.role = 'doctor' AND u.active = 1
        GROUP BY u.id ORDER BY visits DESC, u.name`).all(from, to);

    // Days off that were booked, so an empty week reads as leave and not as
    // a doctor who stopped turning up.
    const leaves = db.prepare(
      `SELECT doctor_id, COUNT(*) AS c FROM doctor_leaves
        WHERE date(leave_date) BETWEEN date(?) AND date(?)
        GROUP BY doctor_id`).all(from, to);
    const leaveBy = {};
    for (const l of leaves) leaveBy[l.doctor_id] = l.c;

    return {
      columns: [
        { key: 'doctor', label: 'Doctor', type: T.text, strong: true },
        { key: 'department', label: 'Department', type: T.text },
        { key: 'days_seen', label: 'Days with patients', type: T.num },
        { key: 'leaves', label: 'Leave booked', type: T.num },
        { key: 'visits', label: 'Patients seen', type: T.num },
        { key: 'consultations', label: 'Consultations written', type: T.num },
        { key: 'signed', label: 'Signed off', type: T.num },
        { key: 'avg_minutes', label: 'Average consult', type: T.num, suffix: ' min' },
      ],
      rows: rows.map((r) => ({
        ...r,
        leaves: leaveBy[r.id] || 0,
        avg_minutes: r.avg_minutes === null ? null : Math.round(r.avg_minutes),
      })),
      notes: [
        'Attendance here is days on which the doctor saw a patient, not a clocked-in time — the clinic does not record doctors on the attendance register.',
        'A consultation written but never signed is an incomplete record; see the medical records report.',
      ],
    };
  },
};

const appointmentReport = {
  key: 'appointments',
  group: 'operations',
  title: 'Appointment, cancellation and no-show report',
  subtitle: 'What was booked, what was kept, and what was wasted',
  run({ from, to }) {
    const rows = db.prepare(
      `SELECT u.name AS doctor, d.name AS department,
              COUNT(*) AS booked,
              SUM(CASE WHEN a.status IN ('completed','in_consult','checked_in') THEN 1 ELSE 0 END) AS attended,
              SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) AS no_show,
              SUM(CASE WHEN a.reminder_sent = 1 THEN 1 ELSE 0 END) AS reminded,
              SUM(CASE WHEN a.status = 'no_show' AND a.reminder_sent = 1 THEN 1 ELSE 0 END) AS no_show_reminded
         FROM appointments a
         LEFT JOIN users u ON u.id = a.doctor_id
         LEFT JOIN departments d ON d.id = a.department_id
        WHERE date(a.scheduled_at) BETWEEN date(?) AND date(?)
        GROUP BY a.doctor_id ORDER BY booked DESC`).all(from, to);

    const total = rows.reduce((t, r) => t + r.booked, 0);
    const noShow = rows.reduce((t, r) => t + r.no_show, 0);
    const cancelled = rows.reduce((t, r) => t + r.cancelled, 0);
    const reminded = rows.reduce((t, r) => t + r.reminded, 0);
    const noShowReminded = rows.reduce((t, r) => t + r.no_show_reminded, 0);

    const reasons = db.prepare(
      `SELECT COALESCE(NULLIF(TRIM(cancel_reason), ''), 'No reason given') AS reason, COUNT(*) AS c
         FROM appointments
        WHERE status = 'cancelled' AND date(scheduled_at) BETWEEN date(?) AND date(?)
        GROUP BY reason ORDER BY c DESC LIMIT 8`).all(from, to);

    return {
      columns: [
        { key: 'doctor', label: 'Doctor', type: T.text, strong: true },
        { key: 'department', label: 'Department', type: T.text },
        { key: 'booked', label: 'Booked', type: T.num },
        { key: 'attended', label: 'Attended', type: T.num },
        { key: 'cancelled', label: 'Cancelled', type: T.num },
        { key: 'no_show', label: 'No-show', type: T.num },
        { key: 'no_show_pct', label: 'No-show rate', type: T.pct },
      ],
      rows: rows.map((r) => ({ ...r, no_show_pct: pct(r.no_show, r.booked) })),
      tiles: [
        { label: 'Booked', value: total },
        { label: 'No-shows', value: noShow, foot: `${pct(noShow, total) ?? 0}% of bookings`, tone: noShow ? 'warn' : 'ok' },
        { label: 'Cancelled', value: cancelled, foot: `${pct(cancelled, total) ?? 0}% of bookings` },
        {
          label: 'No-show after a reminder',
          value: noShowReminded,
          foot: reminded ? `of ${reminded} reminded — ${pct(noShowReminded, reminded) ?? 0}%`
            : 'no reminders were sent',
        },
      ],
      lists: [{ title: 'Why appointments were cancelled', rows: reasons,
        columns: [{ key: 'reason', label: 'Reason', type: T.text },
          { key: 'c', label: 'Count', type: T.num }] }],
      notes: [
        'A slot that was never marked up stays "booked" and is counted as neither kept nor missed — a high "booked" with a low total elsewhere usually means the front desk is not closing slots off.',
      ],
    };
  },
};

const waitingTime = {
  key: 'waiting',
  group: 'operations',
  title: 'Patient waiting time report',
  subtitle: 'How long people sat, at each step',
  run({ from, to }) {
    /*
     * Medians as well as averages, because waiting times are not symmetric:
     * one four-hour wait on an emergency afternoon drags an average that
     * nobody actually experienced, while the median says what a typical
     * patient sat through. The worst case is given too — it is the one the
     * clinic hears about.
     */
    const rows = db.prepare(
      `SELECT d.name AS department,
              COUNT(*) AS seen,
              AVG((julianday(v.consult_start_at) - julianday(v.arrived_at)) * 1440) AS avg_wait,
              MAX((julianday(v.consult_start_at) - julianday(v.arrived_at)) * 1440) AS worst_wait,
              AVG(CASE WHEN v.vitals_at IS NOT NULL
                  THEN (julianday(v.vitals_at) - julianday(v.arrived_at)) * 1440 END) AS avg_to_vitals,
              AVG(CASE WHEN v.checked_out_at IS NOT NULL
                  THEN (julianday(v.checked_out_at) - julianday(v.arrived_at)) * 1440 END) AS avg_total,
              SUM(CASE WHEN (julianday(v.consult_start_at) - julianday(v.arrived_at)) * 1440 > 60
                  THEN 1 ELSE 0 END) AS over_an_hour
         FROM visits v
         LEFT JOIN departments d ON d.id = v.department_id
        WHERE v.consult_start_at IS NOT NULL
          AND date(v.arrived_at) BETWEEN date(?) AND date(?)
        GROUP BY v.department_id ORDER BY avg_wait DESC`).all(from, to);

    const all = db.prepare(
      `SELECT (julianday(consult_start_at) - julianday(arrived_at)) * 1440 AS w
         FROM visits
        WHERE consult_start_at IS NOT NULL
          AND date(arrived_at) BETWEEN date(?) AND date(?)
        ORDER BY w`).all(from, to).map((r) => r.w);
    const at = (q) => (all.length ? Math.round(all[Math.floor((all.length - 1) * q)]) : null);

    const unmeasured = count(
      `SELECT COUNT(*) AS c FROM visits
        WHERE consult_start_at IS NULL AND status NOT IN ('cancelled')
          AND date(arrived_at) BETWEEN date(?) AND date(?)`, from, to);

    return {
      columns: [
        { key: 'department', label: 'Department', type: T.text, strong: true },
        { key: 'seen', label: 'Patients', type: T.num },
        { key: 'avg_to_vitals', label: 'To vitals', type: T.num, suffix: ' min' },
        { key: 'avg_wait', label: 'To the doctor', type: T.num, suffix: ' min' },
        { key: 'worst_wait', label: 'Longest wait', type: T.num, suffix: ' min' },
        { key: 'over_an_hour', label: 'Waited over an hour', type: T.num },
        { key: 'avg_total', label: 'Door to door', type: T.num, suffix: ' min' },
      ],
      rows: rows.map((r) => ({
        ...r,
        avg_wait: r.avg_wait === null ? null : Math.round(r.avg_wait),
        worst_wait: r.worst_wait === null ? null : Math.round(r.worst_wait),
        avg_to_vitals: r.avg_to_vitals === null ? null : Math.round(r.avg_to_vitals),
        avg_total: r.avg_total === null ? null : Math.round(r.avg_total),
      })),
      tiles: [
        { label: 'Typical wait', value: at(0.5), suffix: ' min', foot: 'The median patient' },
        { label: 'Three in four waited under', value: at(0.75), suffix: ' min' },
        { label: 'The worst one in twenty', value: at(0.95), suffix: ' min',
          foot: 'The 95th percentile — the complaints come from here', tone: 'warn' },
        { label: 'Not measurable', value: unmeasured,
          foot: 'visits with no consultation start time recorded' },
      ],
      notes: [
        'Measured from arrival to the moment the doctor opened the consultation. A visit where that was never marked cannot be timed and is counted separately rather than assumed quick.',
        'The median is the honest headline: one four-hour afternoon moves an average that no patient actually experienced.',
      ],
    };
  },
};

const departmentActivity = {
  key: 'dept-activity',
  group: 'operations',
  title: 'Department-wise service activity',
  subtitle: 'How much work each part of the clinic did',
  run({ from, to }) {
    const { DEPT_OF_LINE } = require('../commercial');
    const rows = db.prepare(
      `SELECT ${DEPT_OF_LINE} AS dept, COUNT(*) AS lines, SUM(ii.qty) AS units,
              SUM(ii.amount) AS billed, COUNT(DISTINCT i.patient_id) AS patients
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.status NOT IN ('cancelled','draft')
          AND date(i.created_at) BETWEEN date(?) AND date(?)
        GROUP BY dept ORDER BY billed DESC`).all(from, to);
    const label = {
      consultation: 'Consultations', laboratory: 'Laboratory', imaging: 'X-ray / Scans / ECG',
      pharmacy: 'Pharmacy', procedures: 'Procedures / Day care', other: 'Not yet classified',
    };
    return {
      columns: [
        { key: 'name', label: 'Department', type: T.text, strong: true },
        { key: 'patients', label: 'Patients served', type: T.num },
        { key: 'lines', label: 'Items', type: T.num },
        { key: 'units', label: 'Units', type: T.num },
        { key: 'billed', label: 'Billed', type: T.money },
        { key: 'per_patient', label: 'Per patient', type: T.money },
      ],
      rows: rows.map((r) => ({
        ...r, name: label[r.dept] || r.dept,
        billed: r2(r.billed),
        per_patient: r.patients ? r2(r.billed / r.patients) : null,
      })),
      notes: ['Billed, gross of bill-level concessions. The commercial eye nets those off; this report is about activity, not margin.'],
    };
  },
};

const bedOccupancy = {
  key: 'beds',
  group: 'operations',
  title: 'Admissions, discharges and bed occupancy',
  subtitle: 'In-patient activity, where the clinic admits',
  run({ from, to }) {
    const beds = count('SELECT COUNT(*) AS c FROM beds WHERE active = 1');
    if (!beds) {
      return { empty: 'No beds are set up, so the clinic is not admitting. Nothing to report.', columns: [], rows: [] };
    }
    const rows = db.prepare(
      `SELECT w.name AS ward, w.kind,
              COUNT(DISTINCT b.id) AS beds,
              SUM(CASE WHEN date(a.admitted_at) BETWEEN date(?) AND date(?) THEN 1 ELSE 0 END) AS admissions,
              SUM(CASE WHEN date(a.discharged_at) BETWEEN date(?) AND date(?) THEN 1 ELSE 0 END) AS discharges,
              SUM(CASE WHEN a.status = 'admitted' THEN 1 ELSE 0 END) AS in_house,
              SUM(CASE WHEN a.discharged_at IS NOT NULL
                       AND date(a.discharged_at) BETWEEN date(?) AND date(?)
                  THEN julianday(a.discharged_at) - julianday(a.admitted_at) END) AS stay_days
         FROM wards w
         LEFT JOIN beds b ON b.ward_id = w.id AND b.active = 1
         LEFT JOIN admissions a ON a.ward_id = w.id
        WHERE w.active = 1
        GROUP BY w.id ORDER BY w.name`).all(from, to, from, to, from, to);

    const days = Math.max(Math.round(
      (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1, 1);

    return {
      columns: [
        { key: 'ward', label: 'Ward', type: T.text, strong: true },
        { key: 'beds', label: 'Beds', type: T.num },
        { key: 'admissions', label: 'Admitted', type: T.num },
        { key: 'discharges', label: 'Discharged', type: T.num },
        { key: 'in_house', label: 'In house now', type: T.num },
        { key: 'avg_stay', label: 'Average stay', type: T.num, suffix: ' days' },
        { key: 'occupancy', label: 'Occupancy', type: T.pct },
      ],
      rows: rows.map((r) => ({
        ...r,
        avg_stay: r.discharges ? Math.round((r.stay_days / r.discharges) * 10) / 10 : null,
        occupancy: r.beds ? pct(r.stay_days || 0, r.beds * days) : null,
      })),
      notes: [
        'Occupancy is bed-days used over bed-days available, counted on discharges in the period — a patient still in a bed is in "in house now" and not yet in the occupancy figure.',
      ],
    };
  },
};

/* ======================================================= clinical & quality */

const diagnosticsTAT = {
  key: 'diagnostics',
  group: 'clinical',
  title: 'Diagnostics — completed, pending and delayed',
  subtitle: 'Turnaround against the time each test is promised in',
  run({ from, to }) {
    const rows = db.prepare(
      `SELECT t.category,
              COUNT(*) AS ordered,
              SUM(CASE WHEN i.status IN ('verified') THEN 1 ELSE 0 END) AS reported,
              SUM(CASE WHEN i.status IN ('ordered','sample_collected','in_process') THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN i.status = 'result_entered' THEN 1 ELSE 0 END) AS awaiting_verification,
              AVG(CASE WHEN i.verified_at IS NOT NULL
                  THEN (julianday(i.verified_at) - julianday(o.ordered_at)) * 24 END) AS avg_hours,
              SUM(CASE WHEN i.verified_at IS NOT NULL
                       AND (julianday(i.verified_at) - julianday(o.ordered_at)) * 24 > COALESCE(t.tat_hours, 24)
                  THEN 1 ELSE 0 END) AS late,
              SUM(CASE WHEN i.verified_at IS NULL AND i.status NOT IN ('cancelled')
                       AND (julianday('now') - julianday(o.ordered_at)) * 24 > COALESCE(t.tat_hours, 24)
                  THEN 1 ELSE 0 END) AS overdue_now
         FROM lab_order_items i
         JOIN lab_orders o ON o.id = i.order_id
         LEFT JOIN lab_tests t ON t.id = i.test_id
        WHERE i.parent_item_id IS NULL
          AND date(o.ordered_at) BETWEEN date(?) AND date(?)
        GROUP BY t.category ORDER BY ordered DESC`).all(from, to);

    const label = { lab: 'Laboratory', radiology: 'Radiology', cardiology: 'Cardiology',
      procedure: 'Procedures' };
    const overdue = db.prepare(
      `SELECT o.order_no, p.uhid, p.first_name || ' ' || COALESCE(p.last_name, '') AS patient,
              i.test_name, o.priority, o.ordered_at, i.status,
              ROUND((julianday('now') - julianday(o.ordered_at)) * 24, 1) AS hours_open,
              COALESCE(t.tat_hours, 24) AS promised
         FROM lab_order_items i
         JOIN lab_orders o ON o.id = i.order_id
         JOIN patients p ON p.id = o.patient_id
         LEFT JOIN lab_tests t ON t.id = i.test_id
        WHERE i.verified_at IS NULL AND i.status NOT IN ('cancelled')
          AND i.parent_item_id IS NULL
          AND (julianday('now') - julianday(o.ordered_at)) * 24 > COALESCE(t.tat_hours, 24)
        ORDER BY hours_open DESC LIMIT 50`).all();

    return {
      columns: [
        { key: 'name', label: 'Kind', type: T.text, strong: true },
        { key: 'ordered', label: 'Ordered', type: T.num },
        { key: 'reported', label: 'Reported', type: T.num },
        { key: 'awaiting_verification', label: 'Awaiting sign-off', type: T.num },
        { key: 'pending', label: 'Still in process', type: T.num },
        { key: 'avg_hours', label: 'Average turnaround', type: T.num, suffix: ' h' },
        { key: 'late', label: 'Reported late', type: T.num },
        { key: 'overdue_now', label: 'Overdue now', type: T.num, tone: 'warn' },
      ],
      rows: rows.map((r) => ({
        ...r, name: label[r.category] || r.category || 'Other',
        avg_hours: r.avg_hours === null ? null : Math.round(r.avg_hours * 10) / 10,
      })),
      lists: overdue.length ? [{
        title: 'Open past their promised time, right now',
        rows: overdue,
        columns: [
          { key: 'order_no', label: 'Order', type: T.text },
          { key: 'patient', label: 'Patient', type: T.text },
          { key: 'test_name', label: 'Test', type: T.text },
          { key: 'priority', label: 'Priority', type: T.badge },
          { key: 'ordered_at', label: 'Ordered', type: T.datetime },
          { key: 'hours_open', label: 'Open for', type: T.num, suffix: ' h' },
          { key: 'promised', label: 'Promised in', type: T.num, suffix: ' h' },
        ],
      }] : [],
      notes: [
        'Turnaround runs from the order to the verified result, which is when it can be acted on — not to when a number was typed in.',
        '"Overdue now" is live and ignores the date range: an order from last month that is still open is still open.',
      ],
    };
  },
};

const criticalResults = {
  key: 'critical',
  group: 'clinical',
  title: 'Critical test results and acknowledgement',
  subtitle: 'Results that needed somebody told, and whether they were',
  run({ from, to }) {
    const rows = db.prepare(
      `SELECT i.id, o.order_no, p.uhid,
              p.first_name || ' ' || COALESCE(p.last_name, '') AS patient,
              i.test_name, i.result_value, i.result_at, i.verified_at,
              u.name AS verified_by, du.name AS ordered_by, o.priority,
              ROUND((julianday(COALESCE(i.verified_at, 'now')) - julianday(i.result_at)) * 24, 1) AS hours_to_signoff
         FROM lab_order_items i
         JOIN lab_orders o ON o.id = i.order_id
         JOIN patients p ON p.id = o.patient_id
         LEFT JOIN users u ON u.id = i.verified_by
         LEFT JOIN users du ON du.id = o.doctor_id
        WHERE i.abnormal_flag = 'critical'
          AND date(o.ordered_at) BETWEEN date(?) AND date(?)
        ORDER BY i.verified_at IS NOT NULL, i.result_at DESC`).all(from, to);

    const unsigned = rows.filter((r) => !r.verified_at).length;
    return {
      columns: [
        { key: 'patient', label: 'Patient', type: T.text, strong: true },
        { key: 'uhid', label: 'UHID', type: T.text },
        { key: 'test_name', label: 'Test', type: T.text },
        { key: 'result_value', label: 'Result', type: T.text },
        { key: 'ordered_by', label: 'Ordered by', type: T.text },
        { key: 'result_at', label: 'Resulted', type: T.datetime },
        { key: 'verified_at', label: 'Signed off', type: T.datetime },
        { key: 'hours_to_signoff', label: 'Hours to sign-off', type: T.num },
      ],
      rows,
      tiles: [
        { label: 'Critical results', value: rows.length },
        { label: 'Not yet signed off', value: unsigned, tone: unsigned ? 'danger' : 'ok',
          foot: unsigned ? 'Each one is a result nobody has confirmed seeing' : 'All signed off' },
      ],
      notes: [
        'Sign-off is the nearest thing the system records to an acknowledgement: it is a senior verifying the result, not a confirmation that the treating doctor was reached and told.',
        'If the clinic wants a true read-back record — who was called, when, and who took the call — that needs recording at the bench, and is not in this system yet.',
      ],
      warn: unsigned ? `${unsigned} critical result${unsigned > 1 ? 's have' : ' has'} not been signed off.` : null,
    };
  },
};

const recordsCompletion = {
  key: 'records',
  group: 'clinical',
  title: 'Medical records completion',
  subtitle: 'Visits whose notes are thin, unsigned or missing',
  run({ from, to }) {
    const rows = db.prepare(
      `SELECT u.name AS doctor,
              COUNT(DISTINCT v.id) AS visits,
              COUNT(DISTINCT c.id) AS with_notes,
              SUM(CASE WHEN c.id IS NOT NULL AND c.signed_at IS NULL THEN 1 ELSE 0 END) AS unsigned,
              SUM(CASE WHEN c.id IS NOT NULL AND (c.assessment IS NULL OR TRIM(c.assessment) = '')
                  THEN 1 ELSE 0 END) AS no_assessment,
              SUM(CASE WHEN c.id IS NOT NULL AND (c.plan IS NULL OR TRIM(c.plan) = '')
                  THEN 1 ELSE 0 END) AS no_plan,
              SUM(CASE WHEN vi.visit_id IS NULL THEN 1 ELSE 0 END) AS no_vitals,
              SUM(CASE WHEN dg.consultation_id IS NULL AND c.id IS NOT NULL THEN 1 ELSE 0 END) AS no_diagnosis
         FROM visits v
         LEFT JOIN users u ON u.id = v.doctor_id
         LEFT JOIN consultations c ON c.visit_id = v.id
         LEFT JOIN (SELECT DISTINCT visit_id FROM vitals) vi ON vi.visit_id = v.id
         LEFT JOIN (SELECT DISTINCT consultation_id FROM consultation_diagnoses) dg
                ON dg.consultation_id = c.id
        WHERE v.status NOT IN ('cancelled')
          AND date(v.arrived_at) BETWEEN date(?) AND date(?)
        GROUP BY v.doctor_id ORDER BY visits DESC`).all(from, to);

    const total = rows.reduce((t, r) => t + r.visits, 0);
    const notes = rows.reduce((t, r) => t + r.with_notes, 0);
    return {
      columns: [
        { key: 'doctor', label: 'Doctor', type: T.text, strong: true },
        { key: 'visits', label: 'Visits', type: T.num },
        { key: 'with_notes', label: 'Notes written', type: T.num },
        { key: 'missing_notes', label: 'No notes at all', type: T.num, tone: 'warn' },
        { key: 'unsigned', label: 'Unsigned', type: T.num },
        { key: 'no_assessment', label: 'No assessment', type: T.num },
        { key: 'no_plan', label: 'No plan', type: T.num },
        { key: 'no_diagnosis', label: 'No diagnosis coded', type: T.num },
        { key: 'completion', label: 'Complete', type: T.pct },
      ],
      rows: rows.map((r) => ({
        ...r,
        missing_notes: r.visits - r.with_notes,
        completion: pct(r.with_notes - r.unsigned - r.no_assessment, r.visits),
      })),
      tiles: [
        { label: 'Visits', value: total },
        { label: 'With a consultation note', value: notes,
          foot: `${pct(notes, total) ?? 0}% of visits` },
        { label: 'Missing a note entirely', value: total - notes,
          tone: total - notes ? 'warn' : 'ok' },
      ],
      notes: [
        'A record counts as complete when it has a note, an assessment and a signature. Those are the three a medico-legal request will ask for.',
        'Visits that never reached a doctor — cancelled, or walked out of the queue — are excluded rather than counted as a missing note.',
      ],
    };
  },
};

const followUps = {
  key: 'followups',
  group: 'clinical',
  title: 'Patient follow-up and callback',
  subtitle: 'Who was asked to come back, and who did',
  run({ from, to }) {
    const due = db.prepare(
      `SELECT c.follow_up_date, p.uhid,
              p.first_name || ' ' || COALESCE(p.last_name, '') AS patient,
              p.phone, u.name AS doctor, c.created_at AS seen_on,
              EXISTS (SELECT 1 FROM visits v2
                       WHERE v2.patient_id = c.patient_id
                         AND date(v2.arrived_at) > date(c.created_at)) AS returned,
              EXISTS (SELECT 1 FROM appointments a
                       WHERE a.patient_id = c.patient_id
                         AND date(a.scheduled_at) >= date(c.follow_up_date)
                         AND a.status NOT IN ('cancelled','no_show')) AS booked
         FROM consultations c
         JOIN patients p ON p.id = c.patient_id
         LEFT JOIN users u ON u.id = c.doctor_id
        WHERE c.follow_up_date IS NOT NULL
          AND date(c.follow_up_date) BETWEEN date(?) AND date(?)
        ORDER BY c.follow_up_date`).all(from, to);

    const back = due.filter((r) => r.returned).length;
    const overdue = due.filter((r) => !r.returned && !r.booked && r.follow_up_date < today());
    return {
      columns: [
        { key: 'follow_up_date', label: 'Due back', type: T.date },
        { key: 'patient', label: 'Patient', type: T.text, strong: true },
        { key: 'uhid', label: 'UHID', type: T.text },
        { key: 'phone', label: 'Phone', type: T.text },
        { key: 'doctor', label: 'Asked by', type: T.text },
        { key: 'state', label: 'What happened', type: T.badge },
      ],
      rows: due.map((r) => ({
        ...r,
        state: r.returned ? 'Came back' : r.booked ? 'Booked in'
          : r.follow_up_date < today() ? 'Did not come' : 'Still to come',
      })),
      tiles: [
        { label: 'Asked to come back', value: due.length },
        { label: 'Came back', value: back, foot: `${pct(back, due.length) ?? 0}% returned` },
        { label: 'Overdue, nothing booked', value: overdue.length,
          tone: overdue.length ? 'warn' : 'ok', foot: 'A call list, if anybody makes the calls' },
      ],
      notes: [
        '"Came back" means any visit after the consultation, not necessarily for this problem — the system does not link a return visit to the advice that prompted it.',
      ],
    };
  },
};

const complaintsReport = {
  key: 'complaints',
  group: 'clinical',
  title: 'Patient complaints and resolution',
  subtitle: 'What was said, what was done, and how long it took',
  needs: () => (has('complaints') && count('SELECT COUNT(*) AS c FROM complaints')
    ? null
    : 'No complaint has been recorded yet. The register exists — open "Complaints" from this report to add the first one. Until something is in it, an empty table here means "nothing recorded", not "nothing went wrong".'),
  run({ from, to }) {
    const rows = db.prepare(
      `SELECT c.*, d.name AS department,
              p.first_name || ' ' || COALESCE(p.last_name, '') AS patient,
              CASE WHEN c.resolved_on IS NOT NULL
                   THEN julianday(c.resolved_on) - julianday(c.received_on) END AS days_to_resolve
         FROM complaints c
         LEFT JOIN departments d ON d.id = c.department_id
         LEFT JOIN patients p ON p.id = c.patient_id
        WHERE date(c.received_on) BETWEEN date(?) AND date(?)
        ORDER BY c.received_on DESC`).all(from, to);

    const byCategory = db.prepare(
      `SELECT category, COUNT(*) AS c,
              SUM(CASE WHEN status IN ('resolved','closed') THEN 1 ELSE 0 END) AS closed
         FROM complaints WHERE date(received_on) BETWEEN date(?) AND date(?)
        GROUP BY category ORDER BY c DESC`).all(from, to);

    const open = rows.filter((r) => !['resolved', 'closed', 'withdrawn'].includes(r.status));
    const resolved = rows.filter((r) => r.days_to_resolve !== null);
    const avgDays = resolved.length
      ? Math.round((resolved.reduce((t, r) => t + r.days_to_resolve, 0) / resolved.length) * 10) / 10
      : null;

    return {
      columns: [
        { key: 'ref_no', label: 'Reference', type: T.text },
        { key: 'received_on', label: 'Received', type: T.date },
        { key: 'category', label: 'About', type: T.badge },
        { key: 'severity', label: 'Severity', type: T.badge },
        { key: 'department', label: 'Department', type: T.text },
        { key: 'detail', label: 'What was said', type: T.text, strong: true },
        { key: 'action_taken', label: 'What was done', type: T.text },
        { key: 'owner_name', label: 'Owner', type: T.text },
        { key: 'status', label: 'Status', type: T.badge },
        { key: 'days_to_resolve', label: 'Days to resolve', type: T.num },
      ],
      rows,
      tiles: [
        { label: 'Received', value: rows.length },
        { label: 'Still open', value: open.length, tone: open.length ? 'warn' : 'ok' },
        { label: 'Average time to resolve', value: avgDays, suffix: ' days' },
        { label: 'Serious', value: rows.filter((r) => r.severity === 'serious').length,
          tone: rows.some((r) => r.severity === 'serious') ? 'danger' : 'ok' },
      ],
      lists: [{ title: 'What they were about', rows: byCategory,
        columns: [{ key: 'category', label: 'Category', type: T.badge },
          { key: 'c', label: 'Received', type: T.num },
          { key: 'closed', label: 'Closed', type: T.num }] }],
      notes: [
        'A rising count is not necessarily a worsening clinic: it is often a clinic that has started listening. Read it with the resolution time, which is the part under the clinic\'s control.',
      ],
    };
  },
};

const incidentsReport = {
  key: 'incidents',
  group: 'clinical',
  title: 'Patient safety incidents and corrective actions',
  subtitle: 'What reached a patient, or nearly did',
  needs: () => (has('safety_incidents') && count('SELECT COUNT(*) AS c FROM safety_incidents')
    ? null
    : 'No incident has been recorded yet. The register exists — open "Safety incidents" from this report to add the first one. A blank register is not a safe clinic; it is an unreported one, and near misses are the ones worth having.'),
  run({ from, to }) {
    const rows = db.prepare(
      `SELECT i.*, d.name AS department
         FROM safety_incidents i
         LEFT JOIN departments d ON d.id = i.department_id
        WHERE date(i.happened_on) BETWEEN date(?) AND date(?)
        ORDER BY i.happened_on DESC`).all(from, to);
    const byKind = db.prepare(
      `SELECT kind, harm, COUNT(*) AS c FROM safety_incidents
        WHERE date(happened_on) BETWEEN date(?) AND date(?)
        GROUP BY kind, harm ORDER BY c DESC`).all(from, to);

    const nearMiss = rows.filter((r) => r.harm === 'near_miss').length;
    const harmful = rows.filter((r) => ['moderate', 'severe', 'death'].includes(r.harm));
    const openActions = rows.filter((r) => r.status !== 'closed');

    return {
      columns: [
        { key: 'ref_no', label: 'Reference', type: T.text },
        { key: 'happened_on', label: 'When', type: T.date },
        { key: 'kind', label: 'Kind', type: T.badge },
        { key: 'harm', label: 'Harm', type: T.badge },
        { key: 'department', label: 'Where', type: T.text },
        { key: 'detail', label: 'What happened', type: T.text, strong: true },
        { key: 'root_cause', label: 'Root cause', type: T.text },
        { key: 'corrective_action', label: 'Corrective action', type: T.text },
        { key: 'owner_name', label: 'Owner', type: T.text },
        { key: 'due_date', label: 'Due', type: T.date },
        { key: 'status', label: 'Status', type: T.badge },
      ],
      rows,
      tiles: [
        { label: 'Reported', value: rows.length },
        { label: 'Near misses', value: nearMiss,
          foot: 'The same failure with better luck — worth as much as the rest' },
        { label: 'Reached a patient with harm', value: harmful.length,
          tone: harmful.length ? 'danger' : 'ok' },
        { label: 'Actions still open', value: openActions.length,
          tone: openActions.length ? 'warn' : 'ok' },
      ],
      lists: [{ title: 'By kind and severity', rows: byKind,
        columns: [{ key: 'kind', label: 'Kind', type: T.badge },
          { key: 'harm', label: 'Harm', type: T.badge },
          { key: 'c', label: 'Count', type: T.num }] }],
      notes: [
        'A department that reports more incidents is usually the one that is reporting them. Compare a falling count against the near-miss count before reading it as an improvement.',
        'Every incident with harm should have a root cause and a corrective action with somebody\'s name on it; the blanks in those columns are the finding.',
      ],
    };
  },
};

const hygieneReport = {
  key: 'hygiene',
  group: 'clinical',
  title: 'Housekeeping and infection control',
  subtitle: 'Rounds done, rounds missed, and what failed',
  needs: () => (has('hygiene_rounds') && count('SELECT COUNT(*) AS c FROM hygiene_rounds')
    ? null
    : 'No hygiene round has been logged yet. The register exists — open "Hygiene rounds" from this report to log the first. An area never checked and an area that passed look the same on an empty report, which is exactly the confusion this register exists to prevent.'),
  run({ from, to }) {
    const rows = db.prepare(
      `SELECT area, kind, COUNT(*) AS rounds,
              SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS failed,
              AVG(score) AS avg_score,
              MAX(on_date) AS last_checked
         FROM hygiene_rounds
        WHERE date(on_date) BETWEEN date(?) AND date(?)
        GROUP BY area, kind ORDER BY failed DESC, area`).all(from, to);

    const failures = db.prepare(
      `SELECT on_date, shift, area, kind, score, issues, action_taken, done_by
         FROM hygiene_rounds
        WHERE passed = 0 AND date(on_date) BETWEEN date(?) AND date(?)
        ORDER BY on_date DESC LIMIT 40`).all(from, to);

    return {
      columns: [
        { key: 'area', label: 'Area', type: T.text, strong: true },
        { key: 'kind', label: 'Check', type: T.badge },
        { key: 'rounds', label: 'Rounds', type: T.num },
        { key: 'passed', label: 'Passed', type: T.num },
        { key: 'failed', label: 'Failed', type: T.num, tone: 'warn' },
        { key: 'avg_score', label: 'Average score', type: T.num },
        { key: 'last_checked', label: 'Last checked', type: T.date },
      ],
      rows: rows.map((r) => ({ ...r,
        avg_score: r.avg_score === null ? null : Math.round(r.avg_score * 10) / 10 })),
      lists: failures.length ? [{ title: 'What failed, and what was done', rows: failures,
        columns: [
          { key: 'on_date', label: 'Date', type: T.date },
          { key: 'area', label: 'Area', type: T.text },
          { key: 'kind', label: 'Check', type: T.badge },
          { key: 'issues', label: 'Issue', type: T.text },
          { key: 'action_taken', label: 'Action', type: T.text },
        ] }] : [],
      notes: [
        'This counts rounds that were logged. An area missing from the table was not checked, which is a different problem from an area that failed.',
      ],
    };
  },
};

module.exports = {
  T, GROUPS, r2, pct, today, has, count,
  OPERATIONS: [registrationSummary, doctorActivity, appointmentReport, waitingTime,
    departmentActivity, bedOccupancy],
  CLINICAL: [diagnosticsTAT, criticalResults, recordsCompletion, followUps,
    complaintsReport, incidentsReport, hygieneReport],
};
