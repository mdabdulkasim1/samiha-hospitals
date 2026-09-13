'use strict';
const { db } = require('../db');
const { seesMoney, seesPrices } = require('../lib/auth');

/**
 * The clinic's data, as a spreadsheet a department can actually work with.
 *
 * Two things this is not. It is not the backup — that is the database file
 * itself, taken nightly, and it is what you restore from. A workbook is for
 * reading, sorting and totting up outside the system, and restoring a clinic
 * from one would lose every relationship between its sheets.
 *
 * And it is not a way round the rules about money. A department's workbook
 * carries exactly what its screens carry: the lab's has no prices in it and a
 * doctor's has no takings, because a rule that holds on screen and not in the
 * download is not a rule, it is a decoration. Each sheet below names the
 * columns it withholds and from whom, and `sheetsFor` applies it.
 *
 * Queries are written out in full rather than generated from the table list.
 * A raw dump of `invoices` is a wall of foreign keys; what the cashier wants
 * is the patient's name beside the amount, which only the query knows.
 */

/*
 * A query, run for its columns as much as for its rows. SQLite can name the
 * columns of a SELECT that matched nothing, and a department downloading its
 * book on a quiet morning should still get a sheet with headings on it rather
 * than an empty tab — the headings are half of what makes the file usable.
 */
const q = (sql) => () => {
  const stmt = db.prepare(sql);
  const rows = stmt.all();
  // A repeated name would collide in the row object, which keeps only the last.
  const columns = [...new Set(stmt.columns().map((c) => c.name))];
  return { columns, rows };
};

/** A sheet, with the columns each kind of role may not have. */
const sheet = (name, sql, { money = [], prices = [] } = {}) => ({
  name, read: q(sql), money, prices,
});

/*
 * The patient's name, twice over: once as a bare expression for wrapping in a
 * COALESCE — a walk-in with no file has only the name they gave at the counter
 * — and once ready-aliased for the common case.
 */
const NAME = "(p.first_name || ' ' || COALESCE(p.last_name, ''))";
const PATIENT = `${NAME} AS patient`;

// --------------------------------------------------------------- front desk
const RECEPTION = [
  sheet('Patients', `
    SELECT p.uhid, p.first_name, p.last_name, p.gender, p.age_years, p.dob,
           p.phone, p.whatsapp, p.email, p.address, p.city, p.pincode, p.blood_group,
           p.stage, p.is_uninsured, p.insurance_provider, p.insurance_policy_no,
           p.allergies, p.chronic_conditions, p.enquiry_at, p.registered_at
      FROM patients p ORDER BY p.id`),
  sheet('Appointments', `
    SELECT a.appt_no, a.scheduled_at, a.status, a.visit_kind, a.source, a.token_no,
           COALESCE(${NAME}, a.guest_name) AS patient, p.uhid,
           COALESCE(p.phone, a.guest_phone) AS phone,
           u.name AS doctor, d.name AS department, a.reason, a.cancel_reason, a.created_at
      FROM appointments a
      LEFT JOIN patients p ON p.id = a.patient_id
      LEFT JOIN users u ON u.id = a.doctor_id
      LEFT JOIN departments d ON d.id = a.department_id
     ORDER BY a.scheduled_at DESC`),
  sheet('Visits', `
    SELECT v.visit_no, v.arrived_at, v.status, v.visit_type, v.token_no,
           ${PATIENT}, p.uhid, u.name AS doctor, v.reason_for_visit,
           v.is_new_patient, v.checked_in_at, v.vitals_at, v.consult_end_at,
           v.checked_out_at, v.exit_pass_no
      FROM visits v JOIN patients p ON p.id = v.patient_id
      LEFT JOIN users u ON u.id = v.doctor_id
     ORDER BY v.id DESC`),
  sheet('Enquiries', `
    SELECT e.ref_no, e.created_at, e.name, e.phone, e.source, e.subject, e.status,
           e.notes, u.name AS handled_by
      FROM enquiries e LEFT JOIN users u ON u.id = e.assigned_to
     ORDER BY e.id DESC`),
];

// ------------------------------------------------------------ nurse station
const NURSE = [
  sheet('Vitals', `
    SELECT v.recorded_at, ${PATIENT}, p.uhid, vis.visit_no, a.ip_no,
           v.height_cm, v.weight_kg, v.bmi, v.temp_c, v.pulse, v.resp_rate,
           v.bp_systolic, v.bp_diastolic, v.spo2, v.blood_sugar, v.pain_score,
           v.notes, u.name AS recorded_by, v.amended_at
      FROM vitals v JOIN patients p ON p.id = v.patient_id
      LEFT JOIN visits vis ON vis.id = v.visit_id
      LEFT JOIN admissions a ON a.id = v.admission_id
      LEFT JOIN users u ON u.id = v.recorded_by
     ORDER BY v.id DESC`),
  sheet('Today at the clinic', `
    SELECT v.visit_no, v.arrived_at, v.status, ${PATIENT}, p.uhid,
           p.age_years, p.gender, p.allergies, u.name AS doctor, v.reason_for_visit
      FROM visits v JOIN patients p ON p.id = v.patient_id
      LEFT JOIN users u ON u.id = v.doctor_id
     WHERE date(v.arrived_at) >= date('now', '-30 day')
     ORDER BY v.id DESC`),
];

// ------------------------------------------------------------------- doctor
const DOCTOR = [
  sheet('Consultations', `
    SELECT c.created_at, ${PATIENT}, p.uhid, v.visit_no, u.name AS doctor,
           c.chief_complaint, c.subjective, c.objective, c.assessment, c.plan,
           c.advice, c.follow_up_date, c.signed_at,
           (SELECT GROUP_CONCAT(title, '; ') FROM consultation_diagnoses
             WHERE consultation_id = c.id) AS diagnoses
      FROM consultations c JOIN patients p ON p.id = c.patient_id
      LEFT JOIN visits v ON v.id = c.visit_id
      LEFT JOIN users u ON u.id = c.doctor_id
     ORDER BY c.id DESC`),
  sheet('Prescriptions', `
    SELECT rx.created_at, ${PATIENT}, p.uhid, v.visit_no, u.name AS prescriber,
           rx.drug_name, rx.dose, rx.frequency, rx.duration_days, rx.quantity,
           rx.instructions, rx.status
      FROM prescriptions rx JOIN patients p ON p.id = rx.patient_id
      LEFT JOIN visits v ON v.id = rx.visit_id
      LEFT JOIN users u ON u.id = rx.doctor_id
     ORDER BY rx.id DESC`),
  sheet('Notes on file', `
    SELECT n.created_at, ${PATIENT}, p.uhid, v.visit_no, n.note, u.name AS by
      FROM patient_notes n JOIN patients p ON p.id = n.patient_id
      LEFT JOIN visits v ON v.id = n.visit_id
      LEFT JOIN users u ON u.id = n.created_by
     ORDER BY n.id DESC`),
];

// -------------------------------------------------------------- diagnostics
const LAB = [
  sheet('Orders', `
    SELECT o.order_no, o.ordered_at, o.status, o.priority, o.billing_status, o.released_at,
           ${PATIENT}, p.uhid, p.age_years, p.gender, v.visit_no, a.ip_no,
           u.name AS referred_by, o.clinical_notes, o.reported_at,
           (SELECT COUNT(*) FROM lab_order_items WHERE order_id = o.id) AS tests,
           (SELECT COALESCE(SUM(price), 0) FROM lab_order_items WHERE order_id = o.id) AS amount
      FROM lab_orders o JOIN patients p ON p.id = o.patient_id
      LEFT JOIN visits v ON v.id = o.visit_id
      LEFT JOIN admissions a ON a.id = o.admission_id
      LEFT JOIN users u ON u.id = o.doctor_id
     ORDER BY o.id DESC`, { prices: ['amount'] }),
  sheet('Results', `
    SELECT o.order_no, o.ordered_at, ${PATIENT}, p.uhid,
           i.test_name, i.result_value, i.unit, i.ref_range, i.abnormal_flag, i.status,
           i.result_at, ru.name AS result_by, vu.name AS verified_by, i.price
      FROM lab_order_items i
      JOIN lab_orders o ON o.id = i.order_id
      JOIN patients p ON p.id = o.patient_id
      LEFT JOIN users ru ON ru.id = i.result_by
      LEFT JOIN users vu ON vu.id = i.verified_by
     ORDER BY i.id DESC`, { prices: ['price'] }),
  sheet('Test catalogue', `
    SELECT code, name, category, bill_group, sample_type, unit, ref_low, ref_high,
           ref_text, tat_hours, component_of, active, price
      FROM lab_tests ORDER BY bill_group, sort_order, name`, { prices: ['price'] }),
];

// ----------------------------------------------------------------- pharmacy
const PHARMACY = [
  sheet('Formulary', `
    SELECT d.code, d.name, d.generic_name, d.form, d.strength, d.manufacturer,
           d.schedule_type, d.hsn, d.tax_pct, d.reorder_level, d.barcode, d.active,
           COALESCE((SELECT SUM(qty_available) FROM drug_batches b WHERE b.drug_id = d.id), 0) AS on_hand,
           d.mrp, d.purchase_price, d.unit_rate,
           ROUND(COALESCE((SELECT SUM(qty_available) FROM drug_batches b WHERE b.drug_id = d.id), 0)
                 * d.unit_rate, 2) AS stock_value
      FROM drugs d ORDER BY d.name`,
    { prices: ['mrp', 'purchase_price', 'unit_rate', 'stock_value'] }),
  sheet('Batches', `
    SELECT d.code, d.name, b.batch_no, b.expiry_date, b.qty_received, b.qty_available,
           b.barcode, b.received_at, b.mrp, b.purchase_price
      FROM drug_batches b JOIN drugs d ON d.id = b.drug_id
     ORDER BY d.name, date(b.expiry_date)`, { prices: ['mrp', 'purchase_price'] }),
  sheet('Sales', `
    SELECT s.bill_no, s.created_at, s.sale_type, COALESCE(${NAME}, s.customer_name) AS patient,
           p.uhid, v.visit_no, u.name AS billed_by, s.status,
           s.gross, s.discount, s.tax, s.net, s.paid_amount, s.payment_mode, s.payment_reference
      FROM pharmacy_sales s
      LEFT JOIN patients p ON p.id = s.patient_id
      LEFT JOIN visits v ON v.id = s.visit_id
      LEFT JOIN users u ON u.id = s.created_by
     ORDER BY s.id DESC`,
    { money: ['gross', 'discount', 'tax', 'net', 'paid_amount'] }),
  sheet('Stock movements', `
    SELECT l.created_at, d.code, d.name, l.txn_type, l.qty_delta, l.balance_after,
           l.ref_type, l.ref_id, l.notes, u.name AS by
      FROM stock_ledger l JOIN drugs d ON d.id = l.drug_id
      LEFT JOIN users u ON u.id = l.created_by
     ORDER BY l.id DESC`),
  sheet('Purchases', `
    SELECT pu.grn_no, pu.invoice_no, pu.invoice_date, s.name AS supplier, pu.status,
           pu.gross, pu.discount, pu.tax, pu.net, pu.paid, pu.received_at
      FROM stock_purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id
     ORDER BY pu.id DESC`, { money: ['gross', 'discount', 'tax', 'net', 'paid'] }),
];

// ------------------------------------------------------------------ cashier
const CASHIER = [
  sheet('Invoices', `
    SELECT i.invoice_no, i.created_at, i.kind, i.status, ${PATIENT}, p.uhid,
           v.visit_no, a.ip_no, i.gross, i.discount, i.bill_discount,
           i.sliding_discount, i.assistance_covered, i.insurance_covered,
           i.tax, i.net, i.paid, i.balance, i.closed_at
      FROM invoices i JOIN patients p ON p.id = i.patient_id
      LEFT JOIN visits v ON v.id = i.visit_id
      LEFT JOIN admissions a ON a.id = i.admission_id
     ORDER BY i.id DESC`,
    { money: ['gross', 'discount', 'bill_discount', 'sliding_discount',
      'assistance_covered', 'insurance_covered', 'tax', 'net', 'paid', 'balance'] }),
  sheet('Bill lines', `
    SELECT i.invoice_no, i.created_at, ${PATIENT}, p.uhid,
           ii.ref_type, ii.description, ii.qty, ii.unit_price, ii.discount,
           ii.tax_pct, ii.amount
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN patients p ON p.id = i.patient_id
     ORDER BY ii.id DESC`, { money: ['unit_price', 'discount', 'amount'] }),
  sheet('Receipts', `
    SELECT pay.receipt_no, pay.paid_at, i.invoice_no, ${PATIENT}, p.uhid,
           pay.mode, pay.reference, pay.amount, u.name AS received_by, pay.notes
      FROM payments pay
      JOIN invoices i ON i.id = pay.invoice_id
      JOIN patients p ON p.id = pay.patient_id
      LEFT JOIN users u ON u.id = pay.received_by
     ORDER BY pay.id DESC`, { money: ['amount'] }),
  sheet('Payment plans', `
    SELECT pl.agreement_no, pl.created_at, i.invoice_no, ${PATIENT}, p.uhid,
           pl.status, pl.total_amount, pl.down_payment, pl.installments,
           pl.installment_amount, pl.frequency, pl.start_date
      FROM payment_plans pl
      JOIN invoices i ON i.id = pl.invoice_id
      JOIN patients p ON p.id = i.patient_id
     ORDER BY pl.id DESC`,
    { money: ['total_amount', 'down_payment', 'installment_amount'] }),
  sheet('Rate card', `
    SELECT code, name, category, bill_group, price, tax_pct, active
      FROM services ORDER BY bill_group, name`, { prices: ['price'] }),
];

// ---------------------------------------------------------------- counsellor
const COUNSELOR = [
  sheet('Screenings', `
    SELECT fs.screening_no, fs.created_at, ${PATIENT}, p.uhid, fs.status,
           fs.household_size, fs.annual_income, fs.fpl_pct, fs.sliding_scale_band,
           fs.discount_pct, fs.uninsured, fs.has_proof_of_income, fs.proof_type,
           fs.patient_decision, ap.name AS assistance_program, u.name AS counselor,
           fs.notes, fs.completed_at
      FROM financial_screenings fs JOIN patients p ON p.id = fs.patient_id
      LEFT JOIN assistance_programs ap ON ap.id = fs.assistance_program_id
      LEFT JOIN users u ON u.id = fs.counselor_id
     ORDER BY fs.id DESC`,
    { money: ['annual_income'] }),
  sheet('Concessions given', `
    SELECT i.invoice_no, i.created_at, ${PATIENT}, p.uhid,
           i.gross, i.bill_discount, i.sliding_discount, i.assistance_covered, i.net
      FROM invoices i JOIN patients p ON p.id = i.patient_id
     WHERE i.bill_discount > 0 OR i.sliding_discount > 0 OR i.assistance_covered > 0
     ORDER BY i.id DESC`,
    { money: ['gross', 'bill_discount', 'sliding_discount', 'assistance_covered', 'net'] }),
  sheet('Assistance programmes', `
    SELECT code, name, coverage_pct, max_fpl_pct, description, active
      FROM assistance_programs ORDER BY name`),
];

// ---------------------------------------------------------------- in-patient
const WARD = [
  sheet('Admissions', `
    SELECT a.ip_no, a.admitted_at, a.status, ${PATIENT}, p.uhid, p.age_years, p.gender,
           w.name AS ward, b.bed_no, u.name AS consultant, a.admission_type, a.reason,
           a.provisional_diagnosis, a.final_diagnosis, a.discharged_at, a.discharge_type,
           b.tariff_per_day
      FROM admissions a JOIN patients p ON p.id = a.patient_id
      JOIN wards w ON w.id = a.ward_id JOIN beds b ON b.id = a.bed_id
      LEFT JOIN users u ON u.id = a.doctor_id
     ORDER BY a.id DESC`, { prices: ['tariff_per_day'] }),
  sheet('Beds', `
    SELECT w.name AS ward, w.kind, w.floor, b.bed_no, b.status, b.tariff_per_day, b.active
      FROM beds b JOIN wards w ON w.id = b.ward_id ORDER BY w.name, b.bed_no`,
    { prices: ['tariff_per_day'] }),
  sheet('Ward charges', `
    SELECT a.ip_no, ${PATIENT}, p.uhid, c.charge_date, c.description, c.qty,
           c.unit_price, c.amount, c.billed
      FROM ip_charges c JOIN admissions a ON a.id = c.admission_id
      JOIN patients p ON p.id = a.patient_id
     ORDER BY c.id DESC`, { prices: ['unit_price', 'amount'] }),
  sheet('Rounds & notes', `
    SELECT a.ip_no, ${PATIENT}, n.created_at, n.note_type, n.note, u.name AS by
      FROM ip_notes n JOIN admissions a ON a.id = n.admission_id
      JOIN patients p ON p.id = a.patient_id
      LEFT JOIN users u ON u.id = n.created_by
     ORDER BY n.id DESC`),
  sheet('Medication chart', `
    SELECT a.ip_no, ${PATIENT}, m.drug_name, m.dose, m.frequency, m.route,
           m.start_date, m.end_date, m.status, u.name AS ordered_by
      FROM ip_medication_orders m JOIN admissions a ON a.id = m.admission_id
      JOIN patients p ON p.id = a.patient_id
      LEFT JOIN users u ON u.id = m.ordered_by
     ORDER BY m.id DESC`),
];

/**
 * Who may download what.
 *
 * A department is offered its own workbook and nothing else. The admin is
 * offered every one of them, plus the whole-clinic book — and that is the only
 * place the audit log and the staff list appear, because who did what and who
 * works here are not a department's to take home.
 */
const DEPARTMENTS = {
  reception: { label: 'Front office', roles: ['reception'], sheets: RECEPTION },
  nurse: { label: 'Nurse station', roles: ['nurse'], sheets: NURSE },
  doctor: { label: 'Consultations', roles: ['doctor'], sheets: DOCTOR },
  lab: { label: 'Diagnostics', roles: ['lab'], sheets: LAB },
  pharmacy: { label: 'Pharmacy', roles: ['pharmacy'], sheets: PHARMACY },
  cashier: { label: 'Billing', roles: ['cashier'], sheets: CASHIER },
  counselor: { label: 'Financial assistance', roles: ['counselor'], sheets: COUNSELOR },
  ward: { label: 'In-patient', roles: ['ward'], sheets: WARD },
};

/** Everything, for the administrator's weekly book. */
const ADMIN_EXTRA = [
  sheet('Staff', `
    SELECT u.staff_code, u.name, u.email, u.phone, u.role, u.active,
           d.name AS department, dp.doctor_code, dp.qualification, dp.specialization,
           dp.reg_no, dp.room_no, u.last_login_at, u.created_at
      FROM users u LEFT JOIN departments d ON d.id = u.department_id
      LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
     ORDER BY u.role, u.name`),
  sheet('Audit log', `
    SELECT a.created_at, COALESCE(u.name, a.actor) AS actor, u.role, a.action,
           a.entity, a.entity_id, a.details, a.ip
      FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.id DESC LIMIT 20000`),
  sheet('Messages sent', `
    SELECT created_at, channel, to_addr, template, status, attempts, ref_type, ref_id,
           sent_at, error
      FROM notifications ORDER BY id DESC LIMIT 20000`),
];

const canOpen = (key, user) => {
  const dept = DEPARTMENTS[key];
  if (!dept || !user) return false;
  return user.role === 'admin' || dept.roles.includes(user.role);
};

/** What this user is offered on their own screen. */
function menuFor(user) {
  return Object.entries(DEPARTMENTS)
    .filter(([key]) => canOpen(key, user))
    .map(([key, d]) => ({ key, label: d.label, sheets: d.sheets.length }));
}

/**
 * Run a department's queries into sheets, withholding the columns this user
 * may not see. A withheld column is dropped rather than blanked: a spreadsheet
 * of empty money cells invites somebody to fill them in.
 */
function sheetsFor(list, user) {
  const money = seesMoney(user);
  const prices = seesPrices(user);
  return list.map((s) => {
    const { columns: all, rows } = s.read();
    const hidden = new Set([
      ...(money ? [] : s.money || []),
      ...(prices ? [] : s.prices || []),
    ]);
    const columns = all.filter((c) => !hidden.has(c));
    return {
      name: s.name,
      columns,
      rows: rows.map((r) => columns.map((c) => r[c])),
    };
  });
}

/** One department's workbook. */
function department(key, user) {
  const dept = DEPARTMENTS[key];
  if (!dept) return null;
  return { label: dept.label, sheets: sheetsFor(dept.sheets, user) };
}

/**
 * The whole clinic in one book — every department's sheets, then the three
 * that are the administrator's alone. Sheet names are prefixed so that forty
 * tabs can still be navigated.
 */
function everything(user) {
  const out = [];
  for (const [, dept] of Object.entries(DEPARTMENTS)) {
    for (const s of sheetsFor(dept.sheets, user)) {
      out.push({ ...s, name: `${dept.label} — ${s.name}` });
    }
  }
  for (const s of sheetsFor(ADMIN_EXTRA, user)) out.push(s);
  return out;
}

module.exports = { DEPARTMENTS, menuFor, department, everything, canOpen };
