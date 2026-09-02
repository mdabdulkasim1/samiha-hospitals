'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, badRequest, conflict } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, num } = require('../lib/validate');
const { generate } = require('../lib/ids');
const whatsapp = require('../services/whatsapp');
const audit = require('../lib/audit');

const vitals = require('../services/vitals');

const router = express.Router();
const viewRoles = requireRole('lab', 'doctor', 'nurse', 'reception', 'cashier');

/**
 * Diagnostics: "Place Lab Orders Listed on Results Page" through to a verified,
 * reported result. Statuses advance in one direction:
 *   ordered → sample_collected → in_process → result_entered → verified → reported
 */

function refRangeText(test) {
  if (test.ref_text) return test.ref_text;
  if (test.ref_low !== null && test.ref_high !== null) return `${test.ref_low} – ${test.ref_high}`;
  if (test.ref_low !== null) return `> ${test.ref_low}`;
  if (test.ref_high !== null) return `< ${test.ref_high}`;
  return null;
}

function flagFor(test, value) {
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  if (test.ref_low !== null && test.ref_low !== undefined && n < test.ref_low) {
    return n < test.ref_low * 0.6 ? 'critical' : 'low';
  }
  if (test.ref_high !== null && test.ref_high !== undefined && n > test.ref_high) {
    return n > test.ref_high * 1.6 ? 'critical' : 'high';
  }
  return 'normal';
}

router.get('/orders', viewRoles, wrap((req, res) => {
  const status = str(req.query.status);
  const visitId = req.query.visitId ? int(req.query.visitId) : null;
  const patientId = req.query.patientId ? int(req.query.patientId) : null;
  const rows = db.prepare(
    `SELECT o.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            p.age_years, p.gender, u.name AS doctor_name, dp.doctor_code, v.visit_no, a.ip_no,
            (SELECT COUNT(*) FROM lab_order_items i WHERE i.order_id = o.id) AS item_count,
            (SELECT GROUP_CONCAT(test_name, ', ') FROM lab_order_items i WHERE i.order_id = o.id) AS tests,
            (SELECT COALESCE(SUM(price),0) FROM lab_order_items i WHERE i.order_id = o.id) AS total_price
       FROM lab_orders o
       JOIN patients p ON p.id = o.patient_id
       LEFT JOIN users u ON u.id = o.doctor_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = o.doctor_id
       LEFT JOIN visits v ON v.id = o.visit_id
       LEFT JOIN admissions a ON a.id = o.admission_id
      WHERE (? IS NULL OR o.status = ?) AND (? IS NULL OR o.visit_id = ?) AND (? IS NULL OR o.patient_id = ?)
      ORDER BY CASE o.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, o.id DESC
      LIMIT 300`
  ).all(status, status, visitId, visitId, patientId, patientId);

  const counts = db.prepare('SELECT status, COUNT(*) AS c FROM lab_orders GROUP BY status').all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});
  res.json({ rows, counts });
}));

router.get('/orders/:id', viewRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const order = db.prepare(
    `SELECT o.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            p.age_years, p.gender, p.whatsapp, p.phone, p.allergies, p.aadhaar_number,
            u.name AS doctor_name, dp.doctor_code, v.visit_no, a.ip_no
       FROM lab_orders o JOIN patients p ON p.id = o.patient_id
       LEFT JOIN users u ON u.id = o.doctor_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = o.doctor_id
       LEFT JOIN visits v ON v.id = o.visit_id
       LEFT JOIN admissions a ON a.id = o.admission_id
      WHERE o.id = ?`
  ).get(id);
  if (!order) throw notFound('Order not found');
  order.vitals = vitals.asOf(order.patient_id, order.ordered_at);
  // `sample_type` lives on the test, and the collection counter needs it on the
  // requisition to know which tube to draw.
  order.items = db.prepare(
    `SELECT i.*, t.sample_type, t.category, t.tat_hours,
            ru.name AS result_by_name, vu.name AS verified_by_name
       FROM lab_order_items i
       LEFT JOIN lab_tests t ON t.id = i.test_id
       LEFT JOIN users ru ON ru.id = i.result_by
       LEFT JOIN users vu ON vu.id = i.verified_by
      WHERE i.order_id = ? ORDER BY i.id`
  ).all(id);
  order.samples = db.prepare('SELECT * FROM lab_samples WHERE order_id = ?').all(id);
  res.json(order);
}));

/** "Place Lab Orders" — the doctor selects tests during the consultation. */
router.post('/orders', requireRole('doctor', 'lab', 'nurse'), wrap((req, res) => {
  required(req.body, ['patientId', 'tests']);
  const tests = Array.isArray(req.body.tests) ? req.body.tests : [];
  if (!tests.length) throw badRequest('Select at least one test.');

  const orderNo = generate('labOrder');
  const created = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO lab_orders (order_no, visit_id, admission_id, patient_id, doctor_id, priority, clinical_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(orderNo, int(req.body.visitId) || null, int(req.body.admissionId) || null,
          int(req.body.patientId), int(req.body.doctorId) || req.user.id,
          str(req.body.priority, 'routine'), str(req.body.clinicalNotes));
    const orderId = info.lastInsertRowid;

    for (const t of tests) {
      const testId = int(t.testId ?? t);
      const test = db.prepare('SELECT * FROM lab_tests WHERE id = ?').get(testId);
      if (!test) continue;
      db.prepare(
        `INSERT INTO lab_order_items (order_id, test_id, test_name, price, unit, ref_range)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(orderId, test.id, test.name, test.price, test.unit, refRangeText(test));
    }
    return orderId;
  })();

  if (req.body.visitId) {
    db.prepare("INSERT INTO visit_events (visit_id, stage, detail, actor_id) VALUES (?, 'lab_ordered', ?, ?)")
      .run(int(req.body.visitId), `${orderNo} — ${tests.length} test(s)`, req.user.id);
  }
  audit.log(req, 'create', 'lab_order', created, { orderNo });
  res.status(201).json(db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(created));
}));

/** Sample collection — generates the barcode the tube is labelled with. */
router.post('/orders/:id/collect', requireRole('lab', 'nurse'), wrap((req, res) => {
  const id = int(req.params.id);
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(id);
  if (!order) throw notFound('Order not found');
  if (order.status !== 'ordered') throw conflict(`Order is already at "${order.status}".`);

  const barcode = generate('sample');
  db.prepare('INSERT INTO lab_samples (order_id, barcode, sample_type, collected_by) VALUES (?, ?, ?, ?)')
    .run(id, barcode, str(req.body.sampleType, 'blood'), req.user.id);
  db.prepare("UPDATE lab_orders SET status = 'sample_collected' WHERE id = ?").run(id);
  db.prepare("UPDATE lab_order_items SET status = 'sample_collected' WHERE order_id = ?").run(id);
  audit.log(req, 'collect_sample', 'lab_order', id, { barcode });
  res.json({ barcode, order: db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(id) });
}));

router.post('/orders/:id/start', requireRole('lab'), wrap((req, res) => {
  const id = int(req.params.id);
  db.prepare("UPDATE lab_orders SET status = 'in_process' WHERE id = ? AND status = 'sample_collected'").run(id);
  db.prepare("UPDATE lab_order_items SET status = 'in_process' WHERE order_id = ? AND status = 'sample_collected'").run(id);
  res.json(db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(id));
}));

/** Result entry, with automatic normal/low/high/critical flagging. */
router.post('/orders/:id/results', requireRole('lab'), wrap((req, res) => {
  const id = int(req.params.id);
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(id);
  if (!order) throw notFound('Order not found');
  const results = Array.isArray(req.body.results) ? req.body.results : [];
  if (!results.length) throw badRequest('Provide at least one result.');

  db.transaction(() => {
    for (const r of results) {
      const item = db.prepare('SELECT * FROM lab_order_items WHERE id = ? AND order_id = ?').get(int(r.itemId), id);
      if (!item) continue;
      const test = item.test_id ? db.prepare('SELECT * FROM lab_tests WHERE id = ?').get(item.test_id) : {};
      const flag = r.abnormalFlag ? str(r.abnormalFlag) : flagFor(test || {}, r.value);
      db.prepare(
        `UPDATE lab_order_items
            SET result_value = ?, result_notes = ?, abnormal_flag = ?, status = 'result_entered',
                result_by = ?, result_at = datetime('now')
          WHERE id = ?`
      ).run(str(r.value), str(r.notes), flag, req.user.id, item.id);
    }
    const pending = db.prepare(
      "SELECT COUNT(*) AS c FROM lab_order_items WHERE order_id = ? AND status NOT IN ('result_entered','verified','cancelled')"
    ).get(id).c;
    if (pending === 0) db.prepare("UPDATE lab_orders SET status = 'result_entered' WHERE id = ?").run(id);
  })();

  audit.log(req, 'enter_results', 'lab_order', id, { count: results.length });
  res.json(db.prepare('SELECT * FROM lab_order_items WHERE order_id = ? ORDER BY id').all(id));
}));

/**
 * Verification and release. A senior tech signs off, the report becomes
 * available, and the patient is messaged that it is ready for collection.
 */
router.post('/orders/:id/verify', requireRole('lab', 'doctor'), wrap((req, res) => {
  const id = int(req.params.id);
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(id);
  if (!order) throw notFound('Order not found');

  const unentered = db.prepare(
    "SELECT COUNT(*) AS c FROM lab_order_items WHERE order_id = ? AND result_value IS NULL AND status != 'cancelled'"
  ).get(id).c;
  if (unentered > 0) throw conflict(`${unentered} test(s) still have no result. Enter all results before verifying.`);

  db.prepare(
    "UPDATE lab_order_items SET status = 'verified', verified_by = ?, verified_at = datetime('now') WHERE order_id = ? AND status = 'result_entered'"
  ).run(req.user.id, id);
  db.prepare("UPDATE lab_orders SET status = 'reported', reported_at = datetime('now') WHERE id = ?").run(id);

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(order.patient_id);
  const tests = db.prepare(
    "SELECT GROUP_CONCAT(test_name, ', ') AS t FROM lab_order_items WHERE order_id = ?"
  ).get(id).t;
  const to = patient.whatsapp || patient.phone;
  if (to) {
    whatsapp.notify({ to, template: 'lab_ready', refType: 'lab_order', refId: id, data: { orderNo: order.order_no, tests } });
  }

  if (order.visit_id) {
    db.prepare("INSERT INTO visit_events (visit_id, stage, detail, actor_id) VALUES (?, 'lab_reported', ?, ?)")
      .run(order.visit_id, `${order.order_no} verified and released`, req.user.id);
  }
  const critical = db.prepare(
    "SELECT test_name, result_value FROM lab_order_items WHERE order_id = ? AND abnormal_flag = 'critical'"
  ).all(id);

  audit.log(req, 'verify', 'lab_order', id);
  res.json({ ok: true, order: db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(id), criticalResults: critical });
}));

router.post('/orders/:id/cancel', requireRole('lab', 'doctor'), wrap((req, res) => {
  const id = int(req.params.id);
  db.prepare("UPDATE lab_orders SET status = 'cancelled' WHERE id = ?").run(id);
  db.prepare("UPDATE lab_order_items SET status = 'cancelled' WHERE order_id = ?").run(id);
  audit.log(req, 'cancel', 'lab_order', id, { reason: str(req.body.reason) });
  res.json({ ok: true });
}));

/** Printable report payload. */
router.get('/orders/:id/report', viewRoles, wrap((req, res) => {
  const id = int(req.params.id);
  /*
   * A report leaves the building, so the referring doctor appears on it as
   * their code and nothing else. `doctor_name` is kept for the screens inside
   * the ERP; the printed sheet uses only `doctor_code`.
   */
  const order = db.prepare(
    `SELECT o.*, p.uhid, p.first_name, p.last_name, p.age_years, p.gender, p.phone,
            p.aadhaar_number,
            u.name AS doctor_name, dp.doctor_code
       FROM lab_orders o
       JOIN patients p ON p.id = o.patient_id
       LEFT JOIN users u ON u.id = o.doctor_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = o.doctor_id
      WHERE o.id = ?`
  ).get(id);
  if (!order) throw notFound('Order not found');
  if (!['result_entered', 'verified', 'reported'].includes(order.status)) {
    throw conflict('Results are not ready for this order yet.');
  }
  // A report is dated when it was reported, so that is the reading it carries.
  order.vitals = vitals.asOf(order.patient_id, order.reported_at || order.ordered_at);
  // An X-ray or a scan is a narrative, not a number, and the printed report has
  // to know which it is holding.
  order.items = db.prepare(
    `SELECT i.*, t.category, t.sample_type
       FROM lab_order_items i LEFT JOIN lab_tests t ON t.id = i.test_id
      WHERE i.order_id = ? ORDER BY i.id`
  ).all(id);
  res.json(order);
}));

module.exports = router;
