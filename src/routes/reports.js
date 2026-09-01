'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap } = require('../lib/http');
const { requireAuth, requireRole } = require('../lib/auth');
const { str, int } = require('../lib/validate');

const router = express.Router();
const today = () => new Date().toISOString().slice(0, 10);

/** Role-aware landing dashboard. */
router.get('/dashboard', requireAuth, wrap((req, res) => {
  const date = str(req.query.date) || today();

  const opd = db.prepare(
    `SELECT COUNT(*) AS visits,
            SUM(CASE WHEN status = 'checked_out' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status NOT IN ('checked_out','cancelled') THEN 1 ELSE 0 END) AS in_progress,
            SUM(is_new_patient) AS new_patients
       FROM visits WHERE date(arrived_at) = ?`
  ).get(date);

  const appointments = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN source = 'whatsapp' THEN 1 ELSE 0 END) AS via_whatsapp,
            SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS no_shows,
            SUM(CASE WHEN status IN ('booked','confirmed') THEN 1 ELSE 0 END) AS upcoming
       FROM appointments WHERE date(scheduled_at) = ?`
  ).get(date);

  const revenue = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS collected, COUNT(*) AS receipts
       FROM payments WHERE date(paid_at) = ?`
  ).get(date);

  const billed = db.prepare(
    `SELECT COALESCE(SUM(net),0) AS billed, COALESCE(SUM(sliding_discount),0) AS sliding,
            COALESCE(SUM(assistance_covered),0) AS assistance
       FROM invoices WHERE date(created_at) = ? AND status != 'cancelled'`
  ).get(date);

  const beds = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) AS occupied
       FROM beds WHERE active = 1`
  ).get();

  res.json({
    date,
    opd,
    appointments,
    revenue: {
      collected: revenue.collected, receipts: revenue.receipts,
      billed: billed.billed, slidingDiscount: billed.sliding, assistanceCovered: billed.assistance,
      outstanding: db.prepare("SELECT COALESCE(SUM(balance),0) AS s FROM invoices WHERE status IN ('unpaid','partial')").get().s,
    },
    ipd: {
      admittedToday: db.prepare("SELECT COUNT(*) AS c FROM admissions WHERE date(admitted_at) = ?").get(date).c,
      dischargedToday: db.prepare('SELECT COUNT(*) AS c FROM admissions WHERE date(discharged_at) = ?').get(date).c,
      currentInPatients: db.prepare("SELECT COUNT(*) AS c FROM admissions WHERE status = 'admitted'").get().c,
      beds: { ...beds, occupancyPct: beds.total ? Math.round((beds.occupied / beds.total) * 1000) / 10 : 0 },
    },
    lab: db.prepare(
      `SELECT COUNT(*) AS ordered_today,
              SUM(CASE WHEN status IN ('ordered','sample_collected','in_process') THEN 1 ELSE 0 END) AS pending
         FROM lab_orders WHERE date(ordered_at) = ?`
    ).get(date),
    pharmacy: {
      salesToday: db.prepare('SELECT COALESCE(SUM(net),0) AS s FROM pharmacy_sales WHERE date(created_at) = ?').get(date).s,
      lowStockCount: db.prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT d.id FROM drugs d LEFT JOIN drug_batches b ON b.drug_id = d.id
            WHERE d.active = 1 GROUP BY d.id
           HAVING COALESCE(SUM(CASE WHEN date(b.expiry_date) >= date('now') THEN b.qty_available ELSE 0 END),0) <= d.reorder_level)`
      ).get().c,
    },
    enquiries: db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN source = 'whatsapp' THEN 1 ELSE 0 END) AS via_whatsapp
         FROM enquiries WHERE date(created_at) = ?`
    ).get(date),
    insurance: (() => {
      const pa = db.prepare(
        `SELECT SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
                SUM(CASE WHEN status = 'query_raised' THEN 1 ELSE 0 END) AS queries,
                SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS awaiting
           FROM preauths`
      ).get();
      const cl = db.prepare(
        `SELECT SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
                SUM(CASE WHEN status = 'query_raised' THEN 1 ELSE 0 END) AS queries,
                COALESCE(SUM(CASE WHEN status IN ('approved','partially_settled')
                             THEN approved_amount - settled_amount ELSE 0 END), 0) AS receivable,
                SUM(CASE WHEN status IN ('submitted','under_process','query_raised','approved','partially_settled')
                         AND due_at IS NOT NULL AND date(due_at) < date('now') THEN 1 ELSE 0 END) AS overdue
           FROM claims`
      ).get();
      return {
        preauthDraft: pa.draft || 0, preauthQueries: pa.queries || 0, preauthAwaiting: pa.awaiting || 0,
        claimDraft: cl.draft || 0, claimQueries: cl.queries || 0,
        receivable: cl.receivable || 0, overdueClaims: cl.overdue || 0,
        // Everything a human has to act on right now.
        actionable: (pa.draft || 0) + (pa.queries || 0) + (cl.draft || 0) + (cl.queries || 0) + (cl.overdue || 0),
      };
    })(),
    financialScreening: db.prepare(
      `SELECT SUM(CASE WHEN status = 'awaiting_counselor' THEN 1 ELSE 0 END) AS waiting,
              SUM(CASE WHEN status = 'docs_pending' THEN 1 ELSE 0 END) AS docs_pending,
              SUM(CASE WHEN status = 'with_counselor' THEN 1 ELSE 0 END) AS with_counselor
         FROM financial_screenings`
    ).get(),
  });
}));

/** Footfall and revenue over a date range, for the trend chart. */
router.get('/trend', requireAuth, wrap((req, res) => {
  const days = Math.min(Math.max(int(req.query.days, 30) || 30, 7), 180);
  res.json(db.prepare(
    `WITH RECURSIVE d(day) AS (
       SELECT date('now', '-' || ? || ' days')
       UNION ALL SELECT date(day, '+1 day') FROM d WHERE day < date('now')
     )
     SELECT d.day,
            (SELECT COUNT(*) FROM visits v WHERE date(v.arrived_at) = d.day) AS visits,
            (SELECT COUNT(*) FROM appointments a WHERE date(a.scheduled_at) = d.day) AS appointments,
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE date(p.paid_at) = d.day) AS collected,
            (SELECT COUNT(*) FROM admissions ad WHERE date(ad.admitted_at) = d.day) AS admissions
       FROM d ORDER BY d.day`
  ).all(days - 1));
}));

router.get('/doctor-productivity', requireRole('admin', 'reception', 'cashier'), wrap((req, res) => {
  const from = str(req.query.from) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = str(req.query.to) || today();
  res.json(db.prepare(
    `SELECT u.id, u.name, d.name AS department,
            COUNT(DISTINCT v.id) AS visits,
            COUNT(DISTINCT c.id) AS consultations,
            COUNT(DISTINCT a.id) AS admissions,
            COUNT(DISTINCT lo.id) AS lab_orders,
            COALESCE(AVG(CASE WHEN v.consult_end_at IS NOT NULL AND v.consult_start_at IS NOT NULL
                   THEN (julianday(v.consult_end_at) - julianday(v.consult_start_at)) * 24 * 60 END), 0) AS avg_consult_minutes
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN visits v ON v.doctor_id = u.id AND date(v.arrived_at) BETWEEN ? AND ?
       LEFT JOIN consultations c ON c.doctor_id = u.id AND date(c.created_at) BETWEEN ? AND ?
       LEFT JOIN admissions a ON a.doctor_id = u.id AND date(a.admitted_at) BETWEEN ? AND ?
       LEFT JOIN lab_orders lo ON lo.doctor_id = u.id AND date(lo.ordered_at) BETWEEN ? AND ?
      WHERE u.role = 'doctor' AND u.active = 1
      GROUP BY u.id ORDER BY visits DESC`
  ).all(from, to, from, to, from, to, from, to));
}));

/** Average minutes spent in each workflow stage — where the queue actually jams. */
router.get('/turnaround', requireAuth, wrap((req, res) => {
  const from = str(req.query.from) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = str(req.query.to) || today();
  const row = db.prepare(
    `SELECT COUNT(*) AS sample,
            AVG((julianday(checked_in_at) - julianday(arrived_at)) * 1440)      AS arrival_to_checkin,
            AVG((julianday(vitals_at) - julianday(checked_in_at)) * 1440)       AS checkin_to_vitals,
            AVG((julianday(consult_start_at) - julianday(vitals_at)) * 1440)    AS vitals_to_provider,
            AVG((julianday(consult_end_at) - julianday(consult_start_at)) * 1440) AS consultation,
            AVG((julianday(checked_out_at) - julianday(consult_end_at)) * 1440) AS provider_to_exit,
            AVG((julianday(checked_out_at) - julianday(arrived_at)) * 1440)     AS total_door_to_door
       FROM visits
      WHERE status = 'checked_out' AND date(arrived_at) BETWEEN ? AND ?`
  ).get(from, to);
  const round = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
  res.json({
    from, to, sample: row.sample,
    minutes: {
      arrivalToCheckIn: round(row.arrival_to_checkin),
      checkInToVitals: round(row.checkin_to_vitals),
      vitalsToProvider: round(row.vitals_to_provider),
      consultation: round(row.consultation),
      providerToExit: round(row.provider_to_exit),
      totalDoorToDoor: round(row.total_door_to_door),
    },
  });
}));

router.get('/revenue', requireRole('admin', 'cashier', 'reception'), wrap((req, res) => {
  const from = str(req.query.from) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = str(req.query.to) || today();
  res.json({
    from, to,
    byCategory: db.prepare(
      `SELECT ii.ref_type AS category, COUNT(*) AS lines, COALESCE(SUM(ii.amount),0) AS amount
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE date(i.created_at) BETWEEN ? AND ? AND i.status != 'cancelled'
        GROUP BY ii.ref_type ORDER BY amount DESC`
    ).all(from, to),
    byMode: db.prepare(
      `SELECT mode, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
         FROM payments WHERE date(paid_at) BETWEEN ? AND ? GROUP BY mode ORDER BY total DESC`
    ).all(from, to),
    concessions: db.prepare(
      `SELECT COALESCE(SUM(sliding_discount),0) AS sliding_scale,
              COALESCE(SUM(assistance_covered),0) AS assistance,
              COALESCE(SUM(discount),0) AS line_discounts
         FROM invoices WHERE date(created_at) BETWEEN ? AND ? AND status != 'cancelled'`
    ).get(from, to),
    outstanding: db.prepare(
      `SELECT COUNT(*) AS invoices, COALESCE(SUM(balance),0) AS amount
         FROM invoices WHERE status IN ('unpaid','partial')`
    ).get(),
  });
}));

router.get('/audit', requireRole('admin'), wrap((req, res) => {
  res.json(db.prepare(
    `SELECT * FROM audit_logs
      WHERE (? IS NULL OR entity = ?) ORDER BY id DESC LIMIT ?`
  ).all(str(req.query.entity), str(req.query.entity), Math.min(int(req.query.limit, 200) || 200, 1000)));
}));

module.exports = router;
