'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/** Add a column to an existing table if it is not there yet. */
/**
 * Give every doctor without one a code, in the order they joined, so the serial
 * numbers read as an appointment register. Runs once — a code, once issued, is
 * left alone for ever.
 */
function backfillDoctorCodes() {
  const config = require('../config');
  // Only the pure helper, because this runs while the database module is still
  // being set up and the id generators reach back into it.
  const { nameMnemonic } = require('../lib/ids');

  const pending = db.prepare(
    `SELECT u.id, u.name FROM users u
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
      WHERE u.role = 'doctor' AND (dp.doctor_code IS NULL OR dp.doctor_code = '')
      ORDER BY u.id`
  ).all();
  if (!pending.length) return;

  // Continue the serial from whatever has already been issued, so re-running
  // never reuses a number that is out on a printed sheet.
  const highest = db.prepare(
    "SELECT doctor_code FROM doctor_profiles WHERE doctor_code IS NOT NULL ORDER BY doctor_code DESC"
  ).all().map((r) => Number(String(r.doctor_code).split('-').pop())).filter((n) => !Number.isNaN(n));
  let serial = highest.length ? Math.max(...highest) : 0;

  for (const d of pending) {
    serial += 1;
    const code = `${config.clinic.code}-${nameMnemonic(d.name)}-${String(serial).padStart(3, '0')}`;
    db.prepare('INSERT OR IGNORE INTO doctor_profiles (user_id) VALUES (?)').run(d.id);
    db.prepare('UPDATE doctor_profiles SET doctor_code = ? WHERE user_id = ?').run(code, d.id);
  }

  // Leave the shared counter past what has been issued, so the next doctor to
  // join never lands on a serial already printed on somebody's prescription.
  db.prepare(
    `INSERT INTO counters (name, value) VALUES ('doctor-serial', ?)
     ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)`
  ).run(serial);
}

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Run the schema file — safe to call repeatedly (everything is IF NOT EXISTS). */
function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  // Columns added after the first release, for databases created earlier.
  ensureColumn('departments', 'kind', "TEXT NOT NULL DEFAULT 'specialist'");
  ensureColumn('departments', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('patients', 'stage', "TEXT NOT NULL DEFAULT 'registered'");
  ensureColumn('patients', 'enquiry_at', 'TEXT');
  for (const [col, def] of [
    ['sex_at_birth', 'TEXT'], ['billing_address', 'TEXT'],
    ['smoking_status', 'TEXT'], ['alcohol_use', 'TEXT'],
    ['current_medications', 'TEXT'], ['immunisations', 'TEXT'], ['presenting_complaint', 'TEXT'],
    ['consent_treatment', 'INTEGER NOT NULL DEFAULT 0'],
    ['consent_privacy', 'INTEGER NOT NULL DEFAULT 0'],
    ['consent_contact', 'INTEGER NOT NULL DEFAULT 0'],
    ['consent_signed_at', 'TEXT'], ['consent_signed_by', 'TEXT'],
    ['consent_taken_by', 'INTEGER'],
  ]) ensureColumn('patients', col, def);
  for (const [col, def] of [
    ['sale_type', "TEXT NOT NULL DEFAULT 'prescription'"],
    ['customer_name', 'TEXT'], ['customer_phone', 'TEXT'], ['rx_reference', 'TEXT'],
    ['paid_amount', 'REAL NOT NULL DEFAULT 0'], ['payment_mode', 'TEXT'],
    ['payment_reference', 'TEXT'],
  ]) ensureColumn('pharmacy_sales', col, def);
  // Barcodes: the printed code on the pack, and the label the clinic prints
  // for a specific batch.
  ensureColumn('drugs', 'barcode', 'TEXT');
  ensureColumn('drug_batches', 'barcode', 'TEXT');

  // Doctors get their own sign-in and their own alerts, so the profile carries
  // how each one wants to hear about a booking.
  ensureColumn('doctor_profiles', 'notify_whatsapp', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('doctor_profiles', 'notify_email', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'whatsapp', 'TEXT');

  // A tax invoice must be reproducible exactly as it was issued, so the GST
  // split is stored on the line rather than recomputed from today's rates.
  for (const [col, def] of [
    ['hsn', 'TEXT'],
    ['taxable', 'REAL NOT NULL DEFAULT 0'],
    ['cgst', 'REAL NOT NULL DEFAULT 0'],
    ['sgst', 'REAL NOT NULL DEFAULT 0'],
  ]) ensureColumn('pharmacy_sale_items', col, def);
  ensureColumn('pharmacy_sales', 'round_off', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('pharmacy_sales', 'customer_gstin', 'TEXT');
  ensureColumn('pharmacy_sales', 'customer_address', 'TEXT');

  // A prescription line now knows which sheet it belongs to and who signed it,
  // so a doctor's own prescriptions can be found without walking back through
  // the consultation and the visit.
  ensureColumn('prescriptions', 'sheet_id', 'INTEGER REFERENCES prescription_sheets(id)');
  ensureColumn('prescriptions', 'doctor_id', 'INTEGER REFERENCES users(id)');

  /*
   * How the medicine is actually taken, in the form an Indian patient reads it:
   * a dose per slot (the familiar 1-0-1 pattern), whether it goes before or
   * after food, and what one dose is measured in — a tablet, a spoon, a drop.
   * `frequency` stays as the clinical shorthand, derived from the slots.
   */
  for (const [col, def] of [
    ['dose_morning', 'REAL NOT NULL DEFAULT 0'],
    ['dose_afternoon', 'REAL NOT NULL DEFAULT 0'],
    ['dose_night', 'REAL NOT NULL DEFAULT 0'],
    ['dose_unit', 'TEXT'],
    ['food_relation', 'TEXT'],
  ]) ensureColumn('prescriptions', col, def);

  /*
   * A doctor's signature, stored once and stamped onto what they sign. It is an
   * image and nothing else — no name goes on a printed sheet — and the blank
   * box is still there for a physical stamp when a sheet is not signed here.
   */
  ensureColumn('doctor_profiles', 'signature_image', 'TEXT');
  ensureColumn('prescription_sheets', 'signed_at', 'TEXT');
  ensureColumn('prescription_sheets', 'signature_image', 'TEXT');

  // Why the reading was taken. A reading tied to a visit inherits the visit's
  // reason; one recorded at the desk carries its own.
  ensureColumn('vitals', 'purpose', 'TEXT');

  // One mobile number is often one household, so a patient can say how they
  // relate to the person the number belongs to.
  ensureColumn('patients', 'relationship_to_primary', 'TEXT');

  /*
   * The code a doctor is known by on paper — SPC-MHD-002. It is the only thing
   * about a doctor that appears on a prescription or a report, so every doctor
   * needs one, and it must never change once it has been printed.
   */
  ensureColumn('doctor_profiles', 'doctor_code', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_doctor_code ON doctor_profiles(doctor_code) '
    + 'WHERE doctor_code IS NOT NULL');
  backfillDoctorCodes();

  /*
   * How a billable item is filed on the cashier's screen.
   *
   * This is not the clinical category. A test's category says how its report
   * is laid out — an ultrasound reads as findings and an impression, a blood
   * test as numbers against a reference range — and that must not change to
   * suit a billing screen. The bill group says where the cashier looks for it:
   * "X-ray", "Blood tests", "Procedures & treatment". The two answer different
   * questions and are allowed to disagree.
   */
  /*
   * A discount the cashier gives on the whole bill, as against the per-line
   * discounts that `discount` already totals up. It needs its own column
   * because recalc derives `discount` from the lines every time it runs, and
   * would wipe out anything written there by hand.
   */
  /*
   * What a pharmacy item is filed under on the shelf, and what it comes in.
   * "Analgesics", "Emergency / Crash-cart" — the headings the clinic's own
   * stock list uses, so the register reads the way the pharmacist thinks.
   */
  // A line's share of a discount given on the whole pharmacy bill. It is kept
  // per line because the GST on that line is charged on the discounted value,
  // and the invoice has to be able to show its working.
  ensureColumn('pharmacy_sale_items', 'discount', 'REAL NOT NULL DEFAULT 0');

  /*
   * The patient's Aadhaar. Kept apart from the generic photo-ID fields because
   * it is the number every other record in India is matched on, it has a check
   * digit worth validating, and what may be shown of it is not a matter of
   * taste — see the masking on anything that gets printed.
   */
  ensureColumn('patients', 'aadhaar_number', 'TEXT');

  ensureColumn('drugs', 'category', 'TEXT');
  ensureColumn('drugs', 'pack_size', 'TEXT');

  ensureColumn('invoices', 'bill_discount', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('invoices', 'bill_discount_reason', 'TEXT');

  ensureColumn('services', 'bill_group', 'TEXT');
  ensureColumn('lab_tests', 'bill_group', 'TEXT');
  /*
   * A panel's own analytes. A component is reported, not sold: it stays off
   * the charge board and the order list until the clinic gives it a rate, at
   * which point it is a test the clinic offers on its own.
   */
  /*
   * A reading that was completed or corrected after it was first taken. The
   * original recorder still owns the reading; these say somebody came back to
   * it, and when.
   */
  ensureColumn('vitals', 'amended_at', 'TEXT');
  ensureColumn('vitals', 'amended_by', 'INTEGER');
  // The same for a prescription a doctor went back and corrected.
  ensureColumn('prescription_sheets', 'amended_at', 'TEXT');
  ensureColumn('prescription_sheets', 'amended_by', 'INTEGER');

  ensureColumn('lab_tests', 'component_of', 'TEXT');
  ensureColumn('lab_tests', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  backfillBillGroups();

  // Medicaments sit under HSN 3004 unless the formulary says otherwise; a GST
  // invoice must show a code, so nothing is left without one.
  db.exec("UPDATE drugs SET hsn = '3004' WHERE hsn IS NULL OR hsn = ''");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_drugs_barcode ON drugs(barcode) WHERE barcode IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_barcode ON drug_batches(barcode) WHERE barcode IS NOT NULL');
  return db;
}

/**
 * Give every catalogue item a bill group, without ever overwriting one that
 * has been set. An item added before this existed is filed from what we can
 * tell about it: its clinical category, and for imaging the name, because
 * "radiology" covers both the X-ray room and the ultrasound room and a cashier
 * looking for one does not want to wade through the other.
 */
function backfillBillGroups() {
  const set = (table, group, where, params = []) =>
    db.prepare(`UPDATE ${table} SET bill_group = ? WHERE (bill_group IS NULL OR bill_group = '') AND ${where}`)
      .run(group, ...params);

  set('services', 'Consultation', "category = 'consultation'");
  set('services', 'Procedures & treatment', "category IN ('procedure','treatment')");
  set('services', 'Nursing & ward', "category IN ('nursing','ward','room')");
  set('services', 'Ambulance & other', '1 = 1');

  set('lab_tests', 'ECG & heart', "category = 'cardiology'");
  set('lab_tests', 'Ultrasound & Doppler',
    "category = 'radiology' AND (name LIKE '%ltrasound%' OR name LIKE '%USG%' OR name LIKE '%oppler%')");
  set('lab_tests', 'X-ray', "category = 'radiology'");
  set('lab_tests', 'Urine & stool',
    "category = 'lab' AND (name LIKE '%Urine%' OR name LIKE '%Stool%' OR sample_type LIKE '%Urine%' OR sample_type LIKE '%Stool%')");
  set('lab_tests', 'Blood tests', '1 = 1');
}

/** Wrap a function in a transaction. */
function tx(fn) {
  return db.transaction(fn);
}

// Apply the schema on first load. Every statement is IF NOT EXISTS, so this is
// idempotent and removes any module-ordering hazard around prepared statements.
migrate();

module.exports = { db, migrate, tx, ensureColumn, backfillDoctorCodes, backfillBillGroups };
