'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, conflict, badRequest } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, num, money } = require('../lib/validate');
const { generate } = require('../lib/ids');
const billing = require('../services/billing');
const whatsapp = require('../services/whatsapp');
const audit = require('../lib/audit');

const router = express.Router();
const wardRoles = requireRole('ward', 'nurse', 'doctor', 'reception');
const viewRoles = requireRole('ward', 'nurse', 'doctor', 'reception', 'cashier', 'pharmacy', 'lab');

/**
 * In-patient records: admission → bed occupancy → daily rounds and nursing
 * notes → medication administration → accrued charges → discharge summary and
 * final settlement.
 */

// ------------------------------------------------------------ wards and beds
router.get('/wards', viewRoles, wrap((_req, res) => {
  const wards = db.prepare('SELECT * FROM wards WHERE active = 1 ORDER BY name').all();
  for (const w of wards) {
    w.beds = db.prepare(
      `SELECT b.*, a.id AS admission_id, a.ip_no, p.uhid,
              (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name, a.admitted_at
         FROM beds b
         LEFT JOIN admissions a ON a.bed_id = b.id AND a.status = 'admitted'
         LEFT JOIN patients p ON p.id = a.patient_id
        WHERE b.ward_id = ? AND b.active = 1
        ORDER BY b.bed_no`
    ).all(w.id);
    w.total = w.beds.length;
    w.occupied = w.beds.filter((b) => b.status === 'occupied').length;
    w.vacant = w.beds.filter((b) => b.status === 'vacant').length;
  }
  const total = wards.reduce((s, w) => s + w.total, 0);
  const occupied = wards.reduce((s, w) => s + w.occupied, 0);
  res.json({
    wards,
    summary: { total, occupied, vacant: total - occupied,
      occupancyPct: total ? Math.round((occupied / total) * 1000) / 10 : 0 },
  });
}));

router.post('/wards', requireRole('admin', 'ward'), wrap((req, res) => {
  required(req.body, ['code', 'name']);
  const info = db.prepare('INSERT INTO wards (code, name, kind, floor) VALUES (?, ?, ?, ?)')
    .run(str(req.body.code).toUpperCase(), str(req.body.name), str(req.body.kind, 'general'), str(req.body.floor));
  res.status(201).json(db.prepare('SELECT * FROM wards WHERE id = ?').get(info.lastInsertRowid));
}));

router.post('/wards/:id/beds', requireRole('admin', 'ward'), wrap((req, res) => {
  required(req.body, ['bedNo']);
  const info = db.prepare('INSERT INTO beds (ward_id, bed_no, tariff_per_day) VALUES (?, ?, ?)')
    .run(int(req.params.id), str(req.body.bedNo), num(req.body.tariffPerDay, 0));
  res.status(201).json(db.prepare('SELECT * FROM beds WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/beds/:id', wardRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const bed = db.prepare('SELECT * FROM beds WHERE id = ?').get(id);
  if (!bed) throw notFound('Bed not found');
  if (bed.status === 'occupied' && str(req.body.status) && str(req.body.status) !== 'occupied') {
    throw conflict('This bed is occupied — discharge or transfer the patient first.');
  }
  db.prepare('UPDATE beds SET status = COALESCE(?, status), tariff_per_day = COALESCE(?, tariff_per_day) WHERE id = ?')
    .run(str(req.body.status), req.body.tariffPerDay === undefined ? null : num(req.body.tariffPerDay), id);
  res.json(db.prepare('SELECT * FROM beds WHERE id = ?').get(id));
}));

// ------------------------------------------------------------------ admission
router.get('/admissions', viewRoles, wrap((req, res) => {
  const status = str(req.query.status, 'admitted');
  const rows = db.prepare(
    `SELECT a.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            p.age_years, p.gender, p.phone, p.whatsapp, p.allergies,
            w.name AS ward_name, w.kind AS ward_kind, b.bed_no, b.tariff_per_day, u.name AS doctor_name,
            CAST(julianday('now') - julianday(a.admitted_at) AS INTEGER) + 1 AS days,
            (SELECT i.balance FROM invoices i WHERE i.admission_id = a.id ORDER BY i.id DESC LIMIT 1) AS balance
       FROM admissions a
       JOIN patients p ON p.id = a.patient_id
       JOIN wards w ON w.id = a.ward_id
       JOIN beds b ON b.id = a.bed_id
       LEFT JOIN users u ON u.id = a.doctor_id
      WHERE (? = 'all' OR a.status = ?)
      ORDER BY a.id DESC LIMIT 200`
  ).all(status, status);
  res.json(rows);
}));

/** Admit a patient and occupy the bed in one transaction. */
router.post('/admissions', wardRoles, wrap((req, res) => {
  required(req.body, ['patientId', 'doctorId', 'bedId']);
  const patientId = int(req.body.patientId);
  const bedId = int(req.body.bedId);

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  if (!patient) throw notFound('Patient not found');
  const openAdmission = db.prepare("SELECT ip_no FROM admissions WHERE patient_id = ? AND status = 'admitted'").get(patientId);
  if (openAdmission) throw conflict(`This patient is already admitted (${openAdmission.ip_no}).`);

  const bed = db.prepare('SELECT b.*, w.name AS ward_name FROM beds b JOIN wards w ON w.id = b.ward_id WHERE b.id = ?').get(bedId);
  if (!bed) throw notFound('Bed not found');
  if (bed.status !== 'vacant') throw conflict(`Bed ${bed.bed_no} is ${bed.status}.`);

  const ipNo = generate('admission');
  const admissionId = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO admissions (ip_no, patient_id, visit_id, doctor_id, ward_id, bed_id, admission_type,
                               reason, provisional_diagnosis, attendant_name, attendant_phone, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(ipNo, patientId, int(req.body.visitId) || null, int(req.body.doctorId), bed.ward_id, bedId,
          str(req.body.admissionType, 'planned'), str(req.body.reason), str(req.body.provisionalDiagnosis),
          str(req.body.attendantName), str(req.body.attendantPhone), req.user.id);

    const updated = db.prepare("UPDATE beds SET status = 'occupied' WHERE id = ? AND status = 'vacant'").run(bedId);
    if (updated.changes === 0) throw conflict('That bed was taken while admitting — pick another.');
    return info.lastInsertRowid;
  })();

  // Open the IP invoice up front so charges accrue against it from day one.
  const invoice = billing.createInvoice({ patientId, admissionId, kind: 'ipd', createdBy: req.user.id });
  db.prepare('UPDATE admissions SET invoice_id = ? WHERE id = ?').run(invoice.id, admissionId);

  const doctor = db.prepare('SELECT name FROM users WHERE id = ?').get(int(req.body.doctorId));
  const to = patient.whatsapp || patient.phone;
  if (to) {
    whatsapp.notify({ to, template: 'admission_confirmed', refType: 'admission', refId: admissionId,
      data: { ipNo, patientName: `${patient.first_name} ${patient.last_name || ''}`.trim(),
              ward: bed.ward_name, bed: bed.bed_no, doctorName: doctor ? doctor.name : '—' } });
  }
  audit.log(req, 'admit', 'admission', admissionId, { ipNo, bedId });
  res.status(201).json(db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId));
}));

router.get('/admissions/:id', viewRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const a = db.prepare(
    `SELECT a.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            p.age_years, p.gender, p.phone, p.whatsapp, p.blood_group, p.allergies, p.chronic_conditions,
            w.name AS ward_name, w.kind AS ward_kind, b.bed_no, b.tariff_per_day, u.name AS doctor_name,
            CAST(julianday(COALESCE(a.discharged_at, 'now')) - julianday(a.admitted_at) AS INTEGER) + 1 AS days
       FROM admissions a JOIN patients p ON p.id = a.patient_id
       JOIN wards w ON w.id = a.ward_id JOIN beds b ON b.id = a.bed_id
       LEFT JOIN users u ON u.id = a.doctor_id
      WHERE a.id = ?`
  ).get(id);
  if (!a) throw notFound('Admission not found');

  a.notes = db.prepare(
    `SELECT n.*, u.name AS by_name FROM ip_notes n LEFT JOIN users u ON u.id = n.created_by
      WHERE n.admission_id = ? ORDER BY n.id DESC`
  ).all(id);
  a.vitals = db.prepare('SELECT * FROM vitals WHERE admission_id = ? ORDER BY id DESC').all(id);
  a.medicationOrders = db.prepare(
    `SELECT m.*, u.name AS ordered_by_name FROM ip_medication_orders m LEFT JOIN users u ON u.id = m.ordered_by
      WHERE m.admission_id = ? ORDER BY m.id DESC`
  ).all(id);
  for (const m of a.medicationOrders) {
    m.administrations = db.prepare(
      `SELECT ma.*, u.name AS by_name FROM ip_medication_admin ma LEFT JOIN users u ON u.id = ma.administered_by
        WHERE ma.order_id = ? ORDER BY ma.due_at DESC LIMIT 20`
    ).all(m.id);
  }
  a.charges = db.prepare('SELECT * FROM ip_charges WHERE admission_id = ? ORDER BY charge_date, id').all(id);
  a.labOrders = db.prepare(
    `SELECT o.*, (SELECT GROUP_CONCAT(test_name, ', ') FROM lab_order_items WHERE order_id = o.id) AS tests
       FROM lab_orders o WHERE o.admission_id = ? ORDER BY o.id DESC`
  ).all(id);
  a.transfers = db.prepare(
    `SELECT t.*, fb.bed_no AS from_bed, tb.bed_no AS to_bed, u.name AS by_name
       FROM bed_transfers t LEFT JOIN beds fb ON fb.id = t.from_bed_id
       LEFT JOIN beds tb ON tb.id = t.to_bed_id LEFT JOIN users u ON u.id = t.transferred_by
      WHERE t.admission_id = ? ORDER BY t.id`
  ).all(id);
  a.invoice = a.invoice_id ? billing.fullInvoice(a.invoice_id) : null;
  res.json(a);
}));

// ---------------------------------------------------------- rounds and notes
router.post('/admissions/:id/notes', requireRole('doctor', 'nurse', 'ward'), wrap((req, res) => {
  required(req.body, ['note']);
  const info = db.prepare('INSERT INTO ip_notes (admission_id, note_type, note, created_by) VALUES (?, ?, ?, ?)')
    .run(int(req.params.id), str(req.body.noteType, 'doctor_round'), str(req.body.note), req.user.id);
  audit.log(req, 'create', 'ip_note', info.lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM ip_notes WHERE id = ?').get(info.lastInsertRowid));
}));

router.post('/admissions/:id/vitals', requireRole('nurse', 'doctor', 'ward'), wrap((req, res) => {
  const id = int(req.params.id);
  const a = db.prepare('SELECT * FROM admissions WHERE id = ?').get(id);
  if (!a) throw notFound('Admission not found');
  const height = num(req.body.heightCm, 0);
  const weight = num(req.body.weightKg, 0);
  const info = db.prepare(
    `INSERT INTO vitals (admission_id, patient_id, height_cm, weight_kg, bmi, temp_c, pulse, resp_rate,
                         bp_systolic, bp_diastolic, spo2, blood_sugar, pain_score, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, a.patient_id, height || null, weight || null,
        height > 0 && weight > 0 ? Math.round((weight / ((height / 100) ** 2)) * 10) / 10 : null,
        req.body.tempC === undefined ? null : num(req.body.tempC),
        req.body.pulse === undefined ? null : int(req.body.pulse),
        req.body.respRate === undefined ? null : int(req.body.respRate),
        req.body.bpSystolic === undefined ? null : int(req.body.bpSystolic),
        req.body.bpDiastolic === undefined ? null : int(req.body.bpDiastolic),
        req.body.spo2 === undefined ? null : int(req.body.spo2),
        req.body.bloodSugar === undefined ? null : num(req.body.bloodSugar),
        req.body.painScore === undefined ? null : int(req.body.painScore),
        str(req.body.notes), req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM vitals WHERE id = ?').get(info.lastInsertRowid));
}));

// --------------------------------------------- medication orders and the MAR
const FREQUENCY_TIMES = {
  OD: ['09:00'], BD: ['09:00', '21:00'], TDS: ['08:00', '14:00', '20:00'],
  QID: ['06:00', '12:00', '18:00', '00:00'], HS: ['22:00'], SOS: [],
};

router.post('/admissions/:id/medications', requireRole('doctor'), wrap((req, res) => {
  required(req.body, ['drugName', 'frequency', 'startDate']);
  const id = int(req.params.id);
  const frequency = str(req.body.frequency).toUpperCase();
  const startDate = str(req.body.startDate);
  const endDate = str(req.body.endDate);

  const orderId = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO ip_medication_orders (admission_id, drug_id, drug_name, dose, frequency, route,
                                         start_date, end_date, ordered_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, int(req.body.drugId) || null, str(req.body.drugName), str(req.body.dose), frequency,
          str(req.body.route, 'oral'), startDate, endDate || null, req.user.id);

    // Pre-generate the administration schedule so nursing has a live MAR.
    const times = FREQUENCY_TIMES[frequency] || ['09:00'];
    const last = endDate ? new Date(endDate) : new Date(new Date(startDate).getTime() + 6 * 86400000);
    for (let d = new Date(startDate); d <= last; d.setDate(d.getDate() + 1)) {
      const day = d.toISOString().slice(0, 10);
      for (const t of times) {
        db.prepare('INSERT INTO ip_medication_admin (order_id, admission_id, due_at) VALUES (?, ?, ?)')
          .run(info.lastInsertRowid, id, `${day} ${t}:00`);
      }
    }
    return info.lastInsertRowid;
  })();

  audit.log(req, 'create', 'ip_medication_order', orderId);
  res.status(201).json({
    order: db.prepare('SELECT * FROM ip_medication_orders WHERE id = ?').get(orderId),
    schedule: db.prepare('SELECT * FROM ip_medication_admin WHERE order_id = ? ORDER BY due_at').all(orderId),
  });
}));

/** The nursing medication administration record for a shift. */
router.get('/admissions/:id/mar', requireRole('nurse', 'doctor', 'ward'), wrap((req, res) => {
  const date = str(req.query.date) || new Date().toISOString().slice(0, 10);
  res.json(db.prepare(
    `SELECT ma.*, o.drug_name, o.dose, o.route, o.frequency, u.name AS by_name
       FROM ip_medication_admin ma JOIN ip_medication_orders o ON o.id = ma.order_id
       LEFT JOIN users u ON u.id = ma.administered_by
      WHERE ma.admission_id = ? AND date(ma.due_at) = ?
      ORDER BY ma.due_at`
  ).all(int(req.params.id), date));
}));

router.post('/mar/:id', requireRole('nurse', 'ward'), wrap((req, res) => {
  const id = int(req.params.id);
  const status = str(req.body.status, 'given');
  if (!['given', 'missed', 'held', 'refused'].includes(status)) {
    throw badRequest('status must be one of: given, missed, held, refused');
  }
  db.prepare(
    `UPDATE ip_medication_admin
        SET status = ?, administered_at = datetime('now'), administered_by = ?, notes = ?
      WHERE id = ?`
  ).run(status, req.user.id, str(req.body.notes), id);
  res.json(db.prepare('SELECT * FROM ip_medication_admin WHERE id = ?').get(id));
}));

// ------------------------------------------------------------------ charges
router.post('/admissions/:id/charges', requireRole('ward', 'nurse', 'cashier'), wrap((req, res) => {
  required(req.body, ['description', 'unitPrice']);
  const id = int(req.params.id);
  const qty = num(req.body.qty, 1) || 1;
  const unitPrice = money(req.body.unitPrice);
  const a = db.prepare('SELECT * FROM admissions WHERE id = ?').get(id);
  if (!a) throw notFound('Admission not found');

  const info = db.prepare(
    `INSERT INTO ip_charges (admission_id, service_id, description, qty, unit_price, amount, charge_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, date('now')), ?)`
  ).run(id, int(req.body.serviceId) || null, str(req.body.description), qty, unitPrice,
        billing.round2(qty * unitPrice), str(req.body.chargeDate), req.user.id);
  const chargeId = info.lastInsertRowid;

  /*
   * Onto the bill straight away, rather than waiting for discharge.
   *
   * A bed charge has to wait, because nobody knows how many nights it will be
   * until the patient goes home. A dressing does not: it happened, it costs
   * what it costs, and holding it back only means the family asking what the
   * bill stands at gets an answer that is missing half of it — and the cashier
   * cannot give a discount against a bill that is still empty. The discharge
   * run only picks up charges still marked unbilled, so it will not post this
   * one twice.
   */
  const invoiceId = a.invoice_id || db.prepare(
    "SELECT id FROM invoices WHERE admission_id = ? AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 1"
  ).get(id)?.id || billing.createInvoice({
    patientId: a.patient_id, admissionId: id, kind: 'ipd', createdBy: req.user.id,
  }).id;

  if (!billing.hasItem(invoiceId, 'ip_charge', chargeId)) {
    billing.addItem(invoiceId, {
      refType: 'ip_charge', refId: chargeId,
      description: str(req.body.description), qty, unitPrice,
    });
    db.prepare('UPDATE ip_charges SET billed = 1 WHERE id = ?').run(chargeId);
  }

  audit.log(req, 'create', 'ip_charge', chargeId, { invoiceId });
  res.status(201).json(db.prepare('SELECT * FROM ip_charges WHERE id = ?').get(chargeId));
}));

/** Bed transfer — frees the old bed and occupies the new one atomically. */
router.post('/admissions/:id/transfer', wardRoles, wrap((req, res) => {
  required(req.body, ['toBedId']);
  const id = int(req.params.id);
  const a = db.prepare('SELECT * FROM admissions WHERE id = ?').get(id);
  if (!a) throw notFound('Admission not found');
  if (a.status !== 'admitted') throw conflict('This patient is not currently admitted.');
  const toBedId = int(req.body.toBedId);
  const toBed = db.prepare('SELECT * FROM beds WHERE id = ?').get(toBedId);
  if (!toBed) throw notFound('Target bed not found');
  if (toBed.status !== 'vacant') throw conflict(`Bed ${toBed.bed_no} is ${toBed.status}.`);

  db.transaction(() => {
    const claimed = db.prepare("UPDATE beds SET status = 'occupied' WHERE id = ? AND status = 'vacant'").run(toBedId);
    if (claimed.changes === 0) throw conflict('That bed was taken while transferring.');
    db.prepare("UPDATE beds SET status = 'cleaning' WHERE id = ?").run(a.bed_id);
    db.prepare('UPDATE admissions SET bed_id = ?, ward_id = ? WHERE id = ?').run(toBedId, toBed.ward_id, id);
    db.prepare(
      'INSERT INTO bed_transfers (admission_id, from_bed_id, to_bed_id, reason, transferred_by) VALUES (?, ?, ?, ?, ?)'
    ).run(id, a.bed_id, toBedId, str(req.body.reason), req.user.id);
  })();

  audit.log(req, 'transfer', 'admission', id, { from: a.bed_id, to: toBedId });
  res.json(db.prepare('SELECT * FROM admissions WHERE id = ?').get(id));
}));

// ---------------------------------------------------------------- discharge
/**
 * Discharge: post the bed-day charges and any un-billed IP charges onto the
 * invoice, write the discharge summary, and release the bed for cleaning.
 * The balance must be settled (or carry a plan / documented exception) first.
 */
router.post('/admissions/:id/discharge', requireRole('doctor', 'ward', 'cashier'), wrap((req, res) => {
  const id = int(req.params.id);
  const a = db.prepare(
    `SELECT a.*, b.tariff_per_day, b.bed_no, w.name AS ward_name
       FROM admissions a JOIN beds b ON b.id = a.bed_id JOIN wards w ON w.id = a.ward_id WHERE a.id = ?`
  ).get(id);
  if (!a) throw notFound('Admission not found');
  if (a.status !== 'admitted') throw conflict(`This admission is already ${a.status}.`);

  const invoiceId = a.invoice_id ||
    billing.createInvoice({ patientId: a.patient_id, admissionId: id, kind: 'ipd', createdBy: req.user.id }).id;

  const admittedAt = new Date(a.admitted_at.replace(' ', 'T') + 'Z');
  const days = Math.max(1, Math.ceil((Date.now() - admittedAt.getTime()) / 86400000));

  if (a.tariff_per_day > 0 && !billing.hasItem(invoiceId, 'room', a.bed_id)) {
    billing.addItem(invoiceId, {
      refType: 'room', refId: a.bed_id,
      description: `Bed charges — ${a.ward_name} / ${a.bed_no} (${days} day${days > 1 ? 's' : ''})`,
      qty: days, unitPrice: a.tariff_per_day,
    });
  }
  for (const charge of db.prepare('SELECT * FROM ip_charges WHERE admission_id = ? AND billed = 0').all(id)) {
    billing.addItem(invoiceId, {
      refType: 'ip_charge', refId: charge.id, description: charge.description,
      qty: charge.qty, unitPrice: charge.unit_price,
    });
    db.prepare('UPDATE ip_charges SET billed = 1 WHERE id = ?').run(charge.id);
  }

  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (invoice.balance > 0.009) {
    const hasPlan = db.prepare("SELECT 1 FROM payment_plans WHERE invoice_id = ? AND status = 'active'").get(invoiceId);
    const hasException = db.prepare('SELECT 1 FROM payment_exceptions WHERE invoice_id = ?').get(invoiceId);
    if (!hasPlan && !hasException && !req.body.force) {
      return res.status(409).json({
        error: `Outstanding balance of ${invoice.balance.toFixed(2)} on ${invoice.invoice_no}.`,
        hint: 'Settle the bill, record a payment-plan agreement, or document a payment exception before discharging.',
        invoice: billing.fullInvoice(invoiceId),
      });
    }
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE admissions
          SET status = ?, discharged_at = datetime('now'), discharge_type = ?, final_diagnosis = ?,
              course_in_hospital = ?, discharge_advice = ?, discharge_medication = ?, follow_up_date = ?,
              discharged_by = ?, invoice_id = ?
        WHERE id = ?`
    ).run(str(req.body.status, 'discharged'), str(req.body.dischargeType, 'recovered'),
          str(req.body.finalDiagnosis), str(req.body.courseInHospital), str(req.body.advice),
          str(req.body.dischargeMedication), str(req.body.followUpDate), req.user.id, invoiceId, id);
    db.prepare("UPDATE beds SET status = 'cleaning' WHERE id = ?").run(a.bed_id);
  })();

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(a.patient_id);
  const to = patient.whatsapp || patient.phone;
  if (to) {
    whatsapp.notify({ to, template: 'discharge_summary', refType: 'admission', refId: id,
      data: { ipNo: a.ip_no, diagnosis: str(req.body.finalDiagnosis), followUp: str(req.body.followUpDate) } });
  }
  audit.log(req, 'discharge', 'admission', id, { days });
  res.json({
    admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(id),
    days, invoice: billing.fullInvoice(invoiceId),
  });
}));

/** Printable discharge summary. */
router.get('/admissions/:id/discharge-summary', viewRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const a = db.prepare(
    `SELECT a.*, p.uhid, p.first_name, p.last_name, p.age_years, p.gender, p.blood_group, p.address, p.phone,
            w.name AS ward_name, b.bed_no, u.name AS doctor_name, dp.doctor_code
       FROM admissions a JOIN patients p ON p.id = a.patient_id
       JOIN wards w ON w.id = a.ward_id JOIN beds b ON b.id = a.bed_id
       LEFT JOIN users u ON u.id = a.doctor_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = a.doctor_id
      WHERE a.id = ?`
  ).get(id);
  if (!a) throw notFound('Admission not found');
  a.investigations = db.prepare(
    `SELECT o.order_no, o.reported_at,
            (SELECT GROUP_CONCAT(test_name || ': ' || COALESCE(result_value,'pending'), '; ')
               FROM lab_order_items WHERE order_id = o.id) AS results
       FROM lab_orders o WHERE o.admission_id = ? ORDER BY o.id`
  ).all(id);
  a.medications = db.prepare('SELECT * FROM ip_medication_orders WHERE admission_id = ? ORDER BY id').all(id);
  a.progressNotes = db.prepare(
    `SELECT n.*, u.name AS by_name FROM ip_notes n LEFT JOIN users u ON u.id = n.created_by
      WHERE n.admission_id = ? ORDER BY n.id`
  ).all(id);
  a.invoice = a.invoice_id ? billing.fullInvoice(a.invoice_id) : null;
  res.json(a);
}));

module.exports = router;
