'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, badRequest, forbidden } = require('../lib/http');
const { requireAuth, requireRole } = require('../lib/auth');
const scheduling = require('../services/scheduling');
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

  /**
   * Doctor by doctor, for the day the dashboard is showing: who is booked with
   * whom, how far through their list they are, and how much of their clinic is
   * still open. Doctors with nothing booked and no hours fixed are left out —
   * they are not at the clinic that day and would only be noise.
   */
  const byDoctor = db.prepare(
    `SELECT u.id, u.name, dep.name AS department_name, dp.specialization, dp.room_no,
            COUNT(a.id) AS total,
            SUM(CASE WHEN a.status NOT IN ('cancelled','no_show') THEN 1 ELSE 0 END) AS booked,
            SUM(CASE WHEN a.status = 'checked_in' THEN 1 ELSE 0 END) AS arrived,
            SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) AS no_shows,
            SUM(CASE WHEN a.source = 'whatsapp' THEN 1 ELSE 0 END) AS via_whatsapp,
            SUM(CASE WHEN a.visit_kind = 'new' AND a.status NOT IN ('cancelled','no_show')
                     THEN 1 ELSE 0 END) AS new_patients
       FROM users u
       LEFT JOIN departments dep ON dep.id = u.department_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
       LEFT JOIN appointments a ON a.doctor_id = u.id AND date(a.scheduled_at) = ?
      WHERE u.role = 'doctor' AND u.active = 1
      GROUP BY u.id
      ORDER BY booked DESC, u.name`
  ).all(date);

  for (const d of byDoctor) {
    d.hours = scheduling.windowLabel(d.id, date);
    d.on_leave = scheduling.isOnLeave(d.id, date) ? 1 : 0;
    // Only meaningful for today and later; a past date has no "free" slots.
    d.free = date >= today() ? scheduling.availableSlots(d.id, date).length : 0;
    d.seeing = d.booked - d.completed;
  }

  // A doctor is shown their own clinic and nobody else's — a colleague's
  // patient numbers are not theirs to read.
  const visibleDoctors = req.user.role === 'doctor'
    ? byDoctor.filter((d) => d.id === req.user.id)
    : byDoctor.filter((d) => d.total > 0 || d.hours);

  res.json({
    date,
    opd,
    appointments,
    byDoctor: visibleDoctors,
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
    patients: (() => {
      const byStage = db.prepare(
        "SELECT stage, COUNT(*) AS c FROM patients WHERE active = 1 GROUP BY stage"
      ).all().reduce((a, r) => ({ ...a, [r.stage]: r.c }), {});
      return {
        enquiry: byStage.enquiry || 0,
        registered: byStage.registered || 0,
        enquiryToday: db.prepare(
          "SELECT COUNT(*) AS c FROM patients WHERE active = 1 AND stage = 'enquiry' AND date(enquiry_at) = ?"
        ).get(date).c,
        registeredToday: db.prepare(
          "SELECT COUNT(*) AS c FROM patients WHERE active = 1 AND stage = 'registered' AND date(registered_at) = ?"
        ).get(date).c,
        // Who pays for themselves and who has an insurer behind them. Most of
        // an OPD is self-paying, and the cash counter is sized for that.
        uninsured: db.prepare(
          "SELECT COUNT(*) AS c FROM patients WHERE active = 1 AND stage = 'registered' AND is_uninsured = 1"
        ).get().c,
        insured: db.prepare(
          "SELECT COUNT(*) AS c FROM patients WHERE active = 1 AND stage = 'registered' AND is_uninsured = 0"
        ).get().c,
        // Enquiries that turned into registrations, all time — the conversion rate.
        convertedFromEnquiry: db.prepare(
          `SELECT COUNT(DISTINCT p.id) AS c FROM patients p
             JOIN enquiries e ON e.patient_id = p.id
            WHERE p.active = 1 AND p.stage = 'registered'`
        ).get().c,
      };
    })(),
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

/**
 * Doctor by doctor, month by month: what each consultant brought in and what it
 * billed. Revenue follows the visit or the admission the invoice was raised
 * against, which is the only honest way to attribute it — a pharmacy line on an
 * OPD bill belongs to the doctor whose consultation put it there.
 *
 * `billed` is what was invoiced in the month; `collected` is what has actually
 * been received against those invoices. They differ, and the gap is the point.
 */
router.get('/doctor-monthly', requireRole('admin', 'reception', 'cashier'), wrap((req, res) => {
  const months = Math.min(Math.max(int(req.query.months, 6) || 6, 1), 24);
  const end = str(req.query.to) || today();
  const endDate = new Date(`${end}T00:00:00`);
  const startDate = new Date(endDate.getFullYear(), endDate.getMonth() - (months - 1), 1);
  const from = str(req.query.from) || startDate.toISOString().slice(0, 10);

  const monthKeys = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00`); d <= endDate; d.setMonth(d.getMonth() + 1)) {
    monthKeys.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleString('en-GB', { month: 'short', year: 'numeric' }),
    });
  }

  const blank = () => ({
    appointments: 0, booked: 0, completed: 0, cancelled: 0, no_shows: 0,
    new_patients: 0, via_whatsapp: 0, visits: 0, consultations: 0,
    invoices: 0, billed: 0, collected: 0, outstanding: 0,
  });

  const doctors = db.prepare(
    `SELECT u.id, u.name, d.name AS department, dp.specialization
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
      WHERE u.role = 'doctor' ORDER BY u.name`
  ).all();

  const byId = new Map(doctors.map((d) => [d.id, {
    ...d,
    months: Object.fromEntries(monthKeys.map((m) => [m.key, blank()])),
    total: blank(),
  }]));

  /** Fold one aggregate row into a doctor's month and running total. */
  const fold = (doctorId, ym, values) => {
    const doc = byId.get(doctorId);
    if (!doc || !doc.months[ym]) return;
    for (const [k, v] of Object.entries(values)) {
      doc.months[ym][k] += v || 0;
      doc.total[k] += v || 0;
    }
  };

  for (const r of db.prepare(
    `SELECT doctor_id, strftime('%Y-%m', scheduled_at) AS ym,
            COUNT(*) AS appointments,
            SUM(CASE WHEN status NOT IN ('cancelled','no_show') THEN 1 ELSE 0 END) AS booked,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS no_shows,
            SUM(CASE WHEN source = 'whatsapp' THEN 1 ELSE 0 END) AS via_whatsapp,
            SUM(CASE WHEN visit_kind = 'new' AND status NOT IN ('cancelled','no_show')
                     THEN 1 ELSE 0 END) AS new_patients
       FROM appointments WHERE date(scheduled_at) BETWEEN ? AND ?
      GROUP BY doctor_id, ym`
  ).all(from, end)) {
    fold(r.doctor_id, r.ym, {
      appointments: r.appointments, booked: r.booked, completed: r.completed,
      cancelled: r.cancelled, no_shows: r.no_shows, via_whatsapp: r.via_whatsapp,
      new_patients: r.new_patients,
    });
  }

  for (const r of db.prepare(
    `SELECT doctor_id, strftime('%Y-%m', arrived_at) AS ym, COUNT(*) AS visits
       FROM visits WHERE date(arrived_at) BETWEEN ? AND ? GROUP BY doctor_id, ym`
  ).all(from, end)) fold(r.doctor_id, r.ym, { visits: r.visits });

  for (const r of db.prepare(
    `SELECT doctor_id, strftime('%Y-%m', created_at) AS ym, COUNT(*) AS consultations
       FROM consultations WHERE date(created_at) BETWEEN ? AND ? GROUP BY doctor_id, ym`
  ).all(from, end)) fold(r.doctor_id, r.ym, { consultations: r.consultations });

  for (const r of db.prepare(
    `SELECT COALESCE(v.doctor_id, adm.doctor_id) AS doctor_id,
            strftime('%Y-%m', i.created_at) AS ym,
            COUNT(*) AS invoices,
            COALESCE(SUM(i.net), 0) AS billed,
            COALESCE(SUM(i.paid), 0) AS collected,
            COALESCE(SUM(i.balance), 0) AS outstanding
       FROM invoices i
       LEFT JOIN visits v ON v.id = i.visit_id
       LEFT JOIN admissions adm ON adm.id = i.admission_id
      WHERE i.status != 'cancelled' AND date(i.created_at) BETWEEN ? AND ?
        AND COALESCE(v.doctor_id, adm.doctor_id) IS NOT NULL
      GROUP BY COALESCE(v.doctor_id, adm.doctor_id), ym`
  ).all(from, end)) {
    fold(r.doctor_id, r.ym, {
      invoices: r.invoices, billed: r.billed, collected: r.collected, outstanding: r.outstanding,
    });
  }

  const round2 = (n) => Math.round((n || 0) * 100) / 100;
  const rows = [...byId.values()]
    .filter((d) => d.total.appointments || d.total.visits || d.total.billed)
    .map((d) => {
      for (const m of Object.values(d.months)) {
        m.billed = round2(m.billed); m.collected = round2(m.collected); m.outstanding = round2(m.outstanding);
      }
      d.total.billed = round2(d.total.billed);
      d.total.collected = round2(d.total.collected);
      d.total.outstanding = round2(d.total.outstanding);
      // What an average patient of theirs is worth — the number that makes two
      // doctors with the same headcount comparable.
      d.total.perPatient = d.total.booked ? round2(d.total.billed / d.total.booked) : 0;
      return d;
    })
    .sort((a, b) => b.total.billed - a.total.billed || b.total.booked - a.total.booked);

  // Column totals, so the table foots.
  const byMonth = Object.fromEntries(monthKeys.map((m) => [m.key, blank()]));
  const overall = blank();
  for (const d of rows) {
    for (const m of monthKeys) {
      for (const [k, v] of Object.entries(d.months[m.key])) byMonth[m.key][k] += v;
    }
    for (const [k, v] of Object.entries(d.total)) if (k !== 'perPatient') overall[k] += v;
  }
  for (const m of Object.values(byMonth)) {
    m.billed = round2(m.billed); m.collected = round2(m.collected); m.outstanding = round2(m.outstanding);
  }
  overall.billed = round2(overall.billed);
  overall.collected = round2(overall.collected);
  overall.outstanding = round2(overall.outstanding);
  overall.perPatient = overall.booked ? round2(overall.billed / overall.booked) : 0;

  res.json({ from, to: end, months: monthKeys, rows, totals: { byMonth, overall } });
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

/**
 * The rows behind a dashboard number.
 *
 * Every metric here repeats, word for word, the predicate of the tile it sits
 * under. That duplication is deliberate: if the list were assembled from its
 * own idea of what counts, the two would drift the first time either changed,
 * and a figure whose detail does not add up to it is worse than no figure at
 * all. When a tile's SQL changes, its entry here changes with it.
 *
 * Each entry says who may read it. A tile the user cannot drill into is left
 * unclickable on the dashboard, but that is a courtesy, not the control —
 * the guard here is what actually decides.
 */
const DESK_ROLES = ['reception', 'counselor', 'nurse', 'doctor', 'cashier'];
const MONEY_ROLES = ['cashier', 'reception', 'counselor'];
const WARD_ROLES = ['ward', 'nurse', 'reception', 'doctor'];

const PATIENT_NAME = "TRIM(p.first_name || ' ' || COALESCE(p.last_name, ''))";

const DETAILS = Object.assign(Object.create(null), {
  enquiry_patients: {
    title: 'Enquiry patients',
    caption: 'Asked about us, not registered yet',
    roles: DESK_ROLES,
    route: 'patients', routeParams: { stage: 'enquiry' }, routeLabel: 'Open the patient list',
    rows: () => db.prepare(
      `SELECT p.id, p.uhid, ${PATIENT_NAME} AS name, p.phone, p.enquiry_at AS at,
              (SELECT e.source FROM enquiries e WHERE e.patient_id = p.id ORDER BY e.id LIMIT 1) AS source
         FROM patients p
        WHERE p.active = 1 AND p.stage = 'enquiry'
        ORDER BY p.enquiry_at DESC, p.id DESC`
    ).all(),
  },

  registered_patients: {
    title: 'Registered patients',
    caption: 'Everyone on the register',
    roles: DESK_ROLES,
    route: 'patients', routeParams: { stage: 'registered' }, routeLabel: 'Open the patient list',
    rows: () => db.prepare(
      `SELECT p.id, p.uhid, ${PATIENT_NAME} AS name, p.phone, p.registered_at AS at,
              (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id) AS visits
         FROM patients p
        WHERE p.active = 1 AND p.stage = 'registered'
        ORDER BY p.registered_at DESC, p.id DESC`
    ).all(),
  },

  converted: {
    title: 'Converted from enquiry',
    caption: 'Enquired first, then registered',
    roles: DESK_ROLES,
    route: 'patients', routeParams: { stage: 'registered' }, routeLabel: 'Open the patient list',
    rows: () => db.prepare(
      `SELECT DISTINCT p.id, p.uhid, ${PATIENT_NAME} AS name, p.phone,
              p.registered_at AS at, e.source
         FROM patients p
         JOIN enquiries e ON e.patient_id = p.id
        WHERE p.active = 1 AND p.stage = 'registered'
        ORDER BY p.registered_at DESC, p.id DESC`
    ).all(),
  },

  open_enquiries: {
    title: 'Open enquiries',
    caption: 'Asked today and still unanswered',
    roles: DESK_ROLES,
    route: 'enquiries', routeLabel: 'Open the enquiry desk',
    rows: (date) => db.prepare(
      `SELECT e.id, e.ref_no, e.name, e.phone, e.source, e.subject, e.created_at AS at
         FROM enquiries e
        WHERE date(e.created_at) = ? AND e.status = 'new'
        ORDER BY e.created_at DESC`
    ).all(date),
  },

  opd_visits: {
    title: 'OPD visits today',
    caption: 'Everyone who walked in today',
    roles: DESK_ROLES, scopeToDoctor: true,
    route: 'queue', routeLabel: 'Open the queue board',
    rows: (date, user) => db.prepare(
      `SELECT v.id, v.visit_no, v.token_no, ${PATIENT_NAME} AS name, p.uhid,
              u.name AS doctor, v.status, v.arrived_at AS at
         FROM visits v
         JOIN patients p ON p.id = v.patient_id
         LEFT JOIN users u ON u.id = v.doctor_id
        WHERE date(v.arrived_at) = ?
          AND (? IS NULL OR v.doctor_id = ?)
        ORDER BY v.arrived_at DESC`
    ).all(date, user, user),
  },

  appointments: {
    title: 'Appointments today',
    caption: "Today's diary",
    roles: DESK_ROLES, scopeToDoctor: true,
    route: 'appointments', routeLabel: 'Open the diary',
    rows: (date, user) => db.prepare(
      `SELECT a.id, a.appt_no, a.token_no, a.scheduled_at AS at,
              COALESCE(${PATIENT_NAME}, a.guest_name) AS name,
              COALESCE(p.phone, a.guest_phone) AS phone,
              u.name AS doctor, a.status, a.source
         FROM appointments a
         LEFT JOIN patients p ON p.id = a.patient_id
         LEFT JOIN users u ON u.id = a.doctor_id
        WHERE date(a.scheduled_at) = ?
          AND (? IS NULL OR a.doctor_id = ?)
        ORDER BY a.scheduled_at`
    ).all(date, user, user),
  },

  collections: {
    title: 'Collected today',
    caption: 'Every receipt taken today',
    roles: MONEY_ROLES, money: true,
    route: 'billing', routeLabel: 'Open billing',
    rows: (date) => db.prepare(
      `SELECT pay.id, pay.receipt_no, ${PATIENT_NAME} AS name, p.uhid,
              i.invoice_no, pay.mode, pay.amount, u.name AS taken_by, pay.paid_at AS at
         FROM payments pay
         LEFT JOIN patients p ON p.id = pay.patient_id
         LEFT JOIN invoices i ON i.id = pay.invoice_id
         LEFT JOIN users u ON u.id = pay.received_by
        WHERE date(pay.paid_at) = ?
        ORDER BY pay.paid_at DESC`
    ).all(date),
  },

  outstanding: {
    title: 'Still to collect',
    caption: 'Open invoices across the clinic',
    roles: MONEY_ROLES, money: true,
    route: 'billing', routeParams: { status: 'unpaid' }, routeLabel: 'Open billing',
    rows: () => db.prepare(
      `SELECT i.id, i.invoice_no, ${PATIENT_NAME} AS name, p.uhid, i.kind, i.status,
              i.net, i.paid, i.balance, i.created_at AS at
         FROM invoices i
         LEFT JOIN patients p ON p.id = i.patient_id
        WHERE i.status IN ('unpaid','partial')
        ORDER BY i.balance DESC, i.created_at DESC`
    ).all(),
  },

  beds: {
    title: 'Beds',
    caption: 'Every bed, and who is in it',
    roles: WARD_ROLES,
    route: 'ipd', routeLabel: 'Open wards & beds',
    rows: () => db.prepare(
      `SELECT b.id, b.bed_no, w.name AS ward, b.status, b.tariff_per_day AS tariff,
              ${PATIENT_NAME} AS name, p.uhid, adm.ip_no, adm.admitted_at AS at
         FROM beds b
         LEFT JOIN wards w ON w.id = b.ward_id
         LEFT JOIN admissions adm ON adm.bed_id = b.id AND adm.status = 'admitted'
         LEFT JOIN patients p ON p.id = adm.patient_id
        WHERE b.active = 1
        ORDER BY b.status = 'occupied' DESC, w.name, b.bed_no`
    ).all(),
  },

  self_paying: {
    title: 'Self-paying patients',
    caption: 'No insurance on file — they settle at the counter',
    roles: MONEY_ROLES,
    route: 'patients', routeParams: { stage: 'registered' }, routeLabel: 'Open the patient list',
    rows: () => db.prepare(
      `SELECT p.id, p.uhid, ${PATIENT_NAME} AS name, p.phone, p.registered_at AS at
         FROM patients p
        WHERE p.active = 1 AND p.stage = 'registered' AND p.is_uninsured = 1
        ORDER BY p.registered_at DESC, p.id DESC`
    ).all(),
  },

  insured: {
    title: 'With an insurer',
    caption: 'Cashless and reimbursement',
    roles: MONEY_ROLES,
    route: 'insurance', routeLabel: 'Open insurance & TPA',
    rows: () => db.prepare(
      `SELECT p.id, p.uhid, ${PATIENT_NAME} AS name, p.phone,
              p.insurance_provider AS insurer, p.insurance_policy_no AS policy_no,
              p.insurance_valid_till AS valid_till, p.registered_at AS at
         FROM patients p
        WHERE p.active = 1 AND p.stage = 'registered' AND p.is_uninsured = 0
        ORDER BY p.registered_at DESC, p.id DESC`
    ).all(),
  },
});

/**
 * A number on the dashboard is a question — "which five?" — and this answers
 * it without making anyone hunt through a list on another screen.
 */
router.get('/dashboard/detail', requireAuth, wrap((req, res) => {
  const metric = str(req.query.metric, '');
  // A null-prototype table, checked for an own property: "constructor" and
  // "toString" are not metrics, and a request for one is a bad request rather
  // than a five hundred.
  const spec = Object.prototype.hasOwnProperty.call(DETAILS, metric) ? DETAILS[metric] : null;
  if (!spec) throw badRequest(`Unknown dashboard metric: ${metric || '(none)'}`);

  if (req.user.role !== 'admin' && !spec.roles.includes(req.user.role)) {
    throw forbidden(`These details are restricted to: ${spec.roles.join(', ')}`);
  }

  const date = str(req.query.date) || today();
  // A doctor's dashboard shows their own clinic, so their drill-down does too.
  const scopeTo = spec.scopeToDoctor && req.user.role === 'doctor' ? req.user.id : null;
  const rows = spec.rows(date, scopeTo);

  // A long list is capped for the modal; the full screen is one click away.
  const LIMIT = 200;
  res.json({
    metric, title: spec.title, caption: spec.caption,
    route: spec.route, routeParams: spec.routeParams || null, routeLabel: spec.routeLabel,
    total: rows.length,
    rows: rows.slice(0, LIMIT),
    truncated: rows.length > LIMIT,
  });
}));

router.get('/audit', requireRole('admin'), wrap((req, res) => {
  res.json(db.prepare(
    `SELECT * FROM audit_logs
      WHERE (? IS NULL OR entity = ?) ORDER BY id DESC LIMIT ?`
  ).all(str(req.query.entity), str(req.query.entity), Math.min(int(req.query.limit, 200) || 200, 1000)));
}));

module.exports = router;
