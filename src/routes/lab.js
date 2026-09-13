'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, badRequest, conflict } = require('../lib/http');
const { requireRole, seesPrices } = require('../lib/auth');
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

/*
 * The counter gate.
 *
 * A doctor orders a test because the patient needs it, and says nothing about
 * money. The cashier prices what was ordered, takes payment, and only then
 * does the order reach the bench. `released_at` is the whole of that rule:
 * every hands-on step checks it, so there is one place to be wrong.
 *
 * Two things pass without paying first. An in-patient's tests go on the
 * running bill that is settled at discharge, so making a ward patient walk to
 * the cash counter mid-stay would be nonsense. And the cashier can release an
 * order deliberately — a STAT troponin does not wait behind a queue at the
 * till — which is recorded as a waiver with a reason against their name.
 */
function assertReleased(order) {
  if (order.released_at) return;
  throw conflict(
    `${order.order_no} has not been paid for yet — the cashier releases it once the bill is settled.`
  );
}

function refRangeText(test) {
  if (test.ref_text) return test.ref_text;
  if (test.ref_low !== null && test.ref_high !== null) return `${test.ref_low} – ${test.ref_high}`;
  if (test.ref_low !== null) return `> ${test.ref_low}`;
  if (test.ref_high !== null) return `< ${test.ref_high}`;
  return null;
}

/**
 * How far outside its range a result is.
 *
 * "Critical" is a long way out — well under the floor or well over the
 * ceiling — and the margin is taken as a proportion of the bound itself,
 * which works for every range that is a measurement.
 *
 * It does not work where the bound is zero. "None expected" is written as
 * 0 – 0 for the things a urine should not contain at all, and a proportion of
 * zero is zero, so a single hyaline cast — common, and not news — came out
 * critical. Where the bound is zero the result is simply outside the range:
 * present when it should be absent, which the bench reads as abnormal and
 * grades itself.
 */
function flagFor(test, value) {
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  if (test.ref_low !== null && test.ref_low !== undefined && n < test.ref_low) {
    return test.ref_low !== 0 && n < test.ref_low * 0.6 ? 'critical' : 'low';
  }
  if (test.ref_high !== null && test.ref_high !== undefined && n > test.ref_high) {
    return test.ref_high !== 0 && n > test.ref_high * 1.6 ? 'critical' : 'high';
  }
  return 'normal';
}

router.get('/orders', viewRoles, wrap((req, res) => {
  const status = str(req.query.status);
  const visitId = req.query.visitId ? int(req.query.visitId) : null;
  const patientId = req.query.patientId ? int(req.query.patientId) : null;
  /*
   * `gate` splits the list by the counter rather than by the clinical status:
   * "released" is the bench's worklist, "awaiting" is what is still at the
   * cash desk. Left off, the caller gets both and reads the flag per row.
   */
  const gate = str(req.query.gate, '');
  /*
   * Searching the whole history rather than the window.
   *
   * The list is capped, which is right for a worklist — the bench wants what
   * is in front of it. But the reports list is the other case: somebody comes
   * back to the counter for a copy of a report from last year, and filtering
   * the most recent three hundred orders in the browser would never find it.
   * So the search runs in the query, across the patient, their register number
   * and the order number.
   */
  const q = str(req.query.q, '');
  const like = `%${q}%`;
  const rows = db.prepare(
    `SELECT o.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            p.age_years, p.gender, u.name AS doctor_name, dp.doctor_code, v.visit_no, a.ip_no,
            -- What was ordered, not what it expands into: a worklist that named
            -- all twenty-three parameters of a blood count would be unreadable.
            (SELECT COUNT(*) FROM lab_order_items i
              WHERE i.order_id = o.id AND i.parent_item_id IS NULL) AS item_count,
            (SELECT GROUP_CONCAT(test_name, ', ') FROM lab_order_items i
              WHERE i.order_id = o.id AND i.parent_item_id IS NULL) AS tests,
            (SELECT COALESCE(SUM(price),0) FROM lab_order_items i WHERE i.order_id = o.id) AS total_price_raw
       FROM lab_orders o
       JOIN patients p ON p.id = o.patient_id
       LEFT JOIN users u ON u.id = o.doctor_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = o.doctor_id
       LEFT JOIN visits v ON v.id = o.visit_id
       LEFT JOIN admissions a ON a.id = o.admission_id
      WHERE (? IS NULL OR o.status = ?) AND (? IS NULL OR o.visit_id = ?) AND (? IS NULL OR o.patient_id = ?)
        AND (? = '' OR (? = 'released' AND o.released_at IS NOT NULL)
                    OR (? = 'awaiting' AND o.released_at IS NULL AND o.status != 'cancelled'))
        AND (? = '' OR o.order_no LIKE ? OR p.uhid LIKE ?
             OR (p.first_name || ' ' || COALESCE(p.last_name,'')) LIKE ?)
      ORDER BY CASE o.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, o.id DESC
      LIMIT 300`
  ).all(status, status, visitId, visitId, patientId, patientId, gate, gate, gate,
        q, like, like, like);

  // What an order comes to is the counter's business. The bench reads this
  // list to know what to run and who for.
  const prices = seesPrices(req.user);
  for (const r of rows) {
    r.total_price = prices ? r.total_price_raw : null;
    delete r.total_price_raw;
    r.released = Boolean(r.released_at);
  }

  const counts = db.prepare('SELECT status, COUNT(*) AS c FROM lab_orders GROUP BY status').all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});
  // What the bench can actually start on, and what is still at the counter.
  counts.awaiting_payment = db.prepare(
    "SELECT COUNT(*) AS c FROM lab_orders WHERE released_at IS NULL AND status != 'cancelled'"
  ).get().c;
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
    `SELECT i.*, t.code, t.sample_type, t.category, t.tat_hours,
            ru.name AS result_by_name, vu.name AS verified_by_name
       FROM lab_order_items i
       LEFT JOIN lab_tests t ON t.id = i.test_id
       LEFT JOIN users ru ON ru.id = i.result_by
       LEFT JOIN users vu ON vu.id = i.verified_by
      WHERE i.order_id = ? ORDER BY i.id`
  ).all(id);
  order.samples = db.prepare('SELECT * FROM lab_samples WHERE order_id = ?').all(id);
  order.released = Boolean(order.released_at);
  if (!seesPrices(req.user)) for (const it of order.items) it.price = null;
  res.json(order);
}));

/** "Place Lab Orders" — the doctor selects tests during the consultation. */
router.post('/orders', requireRole('doctor', 'lab', 'nurse'), wrap((req, res) => {
  required(req.body, ['patientId', 'tests']);
  const tests = Array.isArray(req.body.tests) ? req.body.tests : [];
  if (!tests.length) throw badRequest('Select at least one test.');

  const orderNo = generate('labOrder');
  const created = db.transaction(() => {
    const admissionId = int(req.body.admissionId) || null;
    const info = db.prepare(
      `INSERT INTO lab_orders (order_no, visit_id, admission_id, patient_id, doctor_id, priority, clinical_notes,
                               billing_status, released_at, release_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(orderNo, int(req.body.visitId) || null, admissionId,
          int(req.body.patientId), int(req.body.doctorId) || req.user.id,
          str(req.body.priority, 'routine'), str(req.body.clinicalNotes),
          // An in-patient's tests are charged to the stay and settled at
          // discharge; an out-patient's wait for the cashier.
          admissionId ? 'billed' : 'pending',
          admissionId ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
          admissionId ? 'In-patient — charged to the running bill and settled at discharge' : null);
    const orderId = info.lastInsertRowid;

    const addItem = db.prepare(
      `INSERT INTO lab_order_items (order_id, test_id, test_name, price, unit, ref_range,
                                    parent_item_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const componentsOf = db.prepare(
      `SELECT * FROM lab_tests
        WHERE component_of = ? AND active = 1
        ORDER BY sort_order, id`
    );

    const membersOf = db.prepare(
      `SELECT t.* FROM lab_package_items pi
         JOIN lab_tests t ON t.code = pi.test_code
        WHERE pi.package_code = ? ORDER BY pi.sort_order`
    );

    /*
     * What was ordered, and everything that has to be done to report it.
     *
     * Three things can be ordered and they nest. A health-check package is one
     * line on the bill and a dozen tests for the bench. A panel is one test and
     * twenty-three parameters. A single test is itself. Expanding all of it
     * here, at the moment of ordering, means the bench never gets one box to
     * write a morning's work into, and every figure ends up a row of the
     * patient's record with its own range and its own flag.
     *
     * Only what was actually ordered carries a rate. Everything underneath is
     * free, because the thing above it is the charge — pricing the parts as
     * well would bill the patient twice for the same test.
     */
    const expand = (test, parentId, depth) => {
      const id = addItem.run(orderId, test.id, test.name, parentId ? 0 : test.price,
        test.unit, refRangeText(test), parentId, 0).lastInsertRowid;
      // A package holds tests; a test holds parameters. Nothing holds both, and
      // the depth guard means a catalogue that ever names itself cannot loop.
      if (depth > 2) return id;
      const under = membersOf.all(test.code).concat(componentsOf.all(test.code));
      under.forEach((child, i) => {
        const kid = expand(child, id, depth + 1);
        db.prepare('UPDATE lab_order_items SET sort_order = ? WHERE id = ?').run(i + 1, kid);
      });
      return id;
    };

    for (const t of tests) {
      const testId = int(t.testId ?? t);
      const test = db.prepare('SELECT * FROM lab_tests WHERE id = ?').get(testId);
      if (!test) continue;
      expand(test, null, 0);
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
  assertReleased(order);

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
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(id);
  if (!order) throw notFound('Order not found');
  assertReleased(order);
  db.prepare("UPDATE lab_orders SET status = 'in_process' WHERE id = ? AND status = 'sample_collected'").run(id);
  db.prepare("UPDATE lab_order_items SET status = 'in_process' WHERE order_id = ? AND status = 'sample_collected'").run(id);
  res.json(db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(id));
}));

/** Result entry, with automatic normal/low/high/critical flagging. */
router.post('/orders/:id/results', requireRole('lab'), wrap((req, res) => {
  const id = int(req.params.id);
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(id);
  if (!order) throw notFound('Order not found');
  assertReleased(order);
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
    /*
     * A panel's own row is a heading once its parameters are on the order —
     * the result lives in them — so it is not counted as outstanding. Without
     * this the order could never complete: nobody is going to type a value
     * into "Complete Blood Count" itself.
     */
    const pending = db.prepare(
      `SELECT COUNT(*) AS c FROM lab_order_items i
        WHERE i.order_id = ?
          AND i.status NOT IN ('result_entered','verified','cancelled')
          AND NOT EXISTS (SELECT 1 FROM lab_order_items c WHERE c.parent_item_id = i.id)`
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

  assertReleased(order);
  // A panel's own row holds no result — its parameters do — so it is not
  // counted as missing one. Counting it would make a panel unreleasable.
  const unentered = db.prepare(
    `SELECT COUNT(*) AS c FROM lab_order_items i
      WHERE i.order_id = ? AND i.result_value IS NULL AND i.status != 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM lab_order_items c WHERE c.parent_item_id = i.id)`
  ).get(id).c;
  if (unentered > 0) throw conflict(`${unentered} test(s) still have no result. Enter all results before verifying.`);

  db.prepare(
    `UPDATE lab_order_items SET status = 'verified', verified_by = ?, verified_at = datetime('now')
      WHERE order_id = ? AND status != 'cancelled'
        AND (status = 'result_entered'
             OR EXISTS (SELECT 1 FROM lab_order_items c WHERE c.parent_item_id = lab_order_items.id))`
  ).run(req.user.id, id);
  db.prepare("UPDATE lab_orders SET status = 'reported', reported_at = datetime('now') WHERE id = ?").run(id);

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(order.patient_id);
  const tests = db.prepare(
    "SELECT GROUP_CONCAT(test_name, ', ') AS t FROM lab_order_items\n       WHERE order_id = ? AND parent_item_id IS NULL"
  ).get(id).t;
  const to = patient.whatsapp || patient.phone;
  if (to) {
    whatsapp.notify({ to, template: 'lab_ready', refType: 'lab_order', refId: id, data: { orderNo: order.order_no, tests } });
  }

  if (order.visit_id) {
    db.prepare("INSERT INTO visit_events (visit_id, stage, detail, actor_id) VALUES (?, 'lab_reported', ?, ?)")
      .run(order.visit_id, `${order.order_no} verified and released`, req.user.id);

    /*
     * With the last report out, the patient is done at the lab and the cashier
     * is who they see next. Without this the visit sat in the diagnostics lane
     * until somebody happened to open its bill, and the queue board showed a
     * patient waiting at a counter that had already finished with them.
     */
    const stillOpen = db.prepare(
      `SELECT COUNT(*) AS c FROM lab_orders
        WHERE visit_id = ? AND status NOT IN ('reported','cancelled')`
    ).get(order.visit_id).c;
    if (!stillOpen) {
      /*
       * The last report is out, so the bench is finished with this patient.
       * The diagnostics were paid for before any of it started, so there is
       * nothing to settle here: they go to the pharmacy if the doctor wrote
       * anything, and otherwise to the desk to be closed.
       */
      const rxPending = db.prepare(
        "SELECT COUNT(*) AS c FROM prescriptions WHERE visit_id = ? AND status = 'pending'"
      ).get(order.visit_id).c;
      db.prepare(
        `UPDATE visits SET status = ?
          WHERE id = ? AND status = 'labs_pending'`
      ).run(rxPending ? 'pharmacy_pending' : 'billing_pending', order.visit_id);
    }
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
   * The referring doctor is named on a report, and named in full.
   *
   * A report travels — to a specialist, to another hospital, back to whoever
   * asked for it — and every one of those readers has to know who ordered it.
   * A code means nothing outside this building. The prescription is the
   * opposite case and still carries the code alone: it goes home with the
   * patient and on to a pharmacist, neither of whom needs a way to reach the
   * doctor directly. Both fields travel; the sheet decides which it prints.
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
    `SELECT i.*, t.category, t.sample_type,
            ru.name AS result_by_name, vu.name AS verified_by_name
       FROM lab_order_items i
       LEFT JOIN lab_tests t ON t.id = i.test_id
       LEFT JOIN users ru ON ru.id = i.result_by
       LEFT JOIN users vu ON vu.id = i.verified_by
      -- A panel keeps its parameters directly beneath it on the printed sheet.
      WHERE i.order_id = ?
      ORDER BY COALESCE(i.parent_item_id, i.id), i.sort_order, i.id`
  ).all(id);

  /*
   * Who is answerable for this sheet.
   *
   * A report leaving the building with an unattributed blank box beside the
   * word "signature" is a report nobody has put their name to. The box stays —
   * the clinic's stamp goes in it by hand — but the names are printed beside
   * it, so a reader elsewhere knows who ran the sample and who released it
   * without having to decipher a signature.
   */
  const signer = (col) => db.prepare(
    `SELECT u.name, u.role FROM lab_order_items i JOIN users u ON u.id = i.${col}
      WHERE i.order_id = ? AND i.${col} IS NOT NULL
      ORDER BY i.${col === 'verified_by' ? 'verified_at' : 'result_at'} DESC LIMIT 1`
  ).get(id) || null;
  order.performed_by = signer('result_by');
  order.verified_by = signer('verified_by');

  res.json(order);
}));

module.exports = router;
