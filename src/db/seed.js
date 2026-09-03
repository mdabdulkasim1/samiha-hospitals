'use strict';
/**
 * Demo / starter data for SAMIHA POLYCLINIC & DIAGNOSTICS.
 * Idempotent: safe to run more than once — existing rows are left alone.
 */
const { db } = require('./index');
const { hashPassword } = require('../lib/auth');
const { generate } = require('../lib/ids');

const upsert = (table, uniqueCol, row) => {
  const existing = db.prepare(`SELECT id FROM ${table} WHERE ${uniqueCol} = ?`).get(row[uniqueCol]);
  if (existing) return existing.id;
  const cols = Object.keys(row);
  const info = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...cols.map((c) => row[c]));
  return info.lastInsertRowid;
};

// ------------------------------------------------------------- departments
// These mirror the clinic's own service board.
const departments = [
  // Specialist categories — these take consultations and appear in booking.
  ['IM',  'Internal Medicine',  'specialist', 1],
  ['PED', 'Pediatrics',         'specialist', 2],
  ['GYN', 'Gynecology',         'specialist', 3],
  ['CAR', 'Cardiology',         'specialist', 4],
  ['DEN', 'Dentist',            'specialist', 5],
  ['DER', 'Dermatology',        'specialist', 6],
  ['ORT', 'Orthopedics',        'specialist', 7],
  // Diagnostic categories — service counters rather than consulting rooms.
  ['LAB', 'Diagnostics / Lab',  'diagnostic', 11],
  ['PHA', 'Pharmacy',           'diagnostic', 12],
  ['DAY', 'Day Care / Ward',    'diagnostic', 13],
  ['XRY', 'X-Ray',              'diagnostic', 14],
  ['USG', 'USG (Ultrasound)',   'diagnostic', 15],
];
const deptId = {};
for (const [code, name, kind, sort_order] of departments) {
  deptId[code] = upsert('departments', 'code', { code, name, kind, sort_order });
  // Keep an existing row in step with the canonical list.
  db.prepare('UPDATE departments SET name = ?, kind = ?, sort_order = ?, active = 1 WHERE code = ?')
    .run(name, kind, sort_order, code);
}
// Retire anything left over from an earlier seed.
db.prepare(
  `UPDATE departments SET active = 0 WHERE code NOT IN (${departments.map(() => '?').join(',')})`
).run(...departments.map((d) => d[0]));

// -------------------------------------------------------------------- staff
const staff = [
  { staff_code: 'ADMIN01', name: 'System Administrator', email: 'admin@samiha.local', role: 'admin' },
  { staff_code: 'REC01', name: 'Fathima Reception', email: 'reception@samiha.local', role: 'reception' },
  { staff_code: 'CNS01', name: 'Anita Counselor', email: 'counselor@samiha.local', role: 'counselor' },
  { staff_code: 'NUR01', name: 'Sister Mary (M.A.)', email: 'nurse@samiha.local', role: 'nurse' },
  { staff_code: 'LAB01', name: 'Ravi Lab Technician', email: 'lab@samiha.local', role: 'lab', department_id: deptId.LAB },
  { staff_code: 'PHR01', name: 'Suresh Pharmacist', email: 'pharmacy@samiha.local', role: 'pharmacy', department_id: deptId.PHA },
  { staff_code: 'CSH01', name: 'Kavitha Cashier', email: 'cashier@samiha.local', role: 'cashier' },
  { staff_code: 'WRD01', name: 'Ward Sister Leela', email: 'ward@samiha.local', role: 'ward', department_id: deptId.DAY },
];
for (const s of staff) upsert('users', 'staff_code', { ...s, password_hash: hashPassword('samiha@123') });

const doctors = [
  { staff_code: 'DOC01', phone: '919840110001', name: 'Dr. Imran Sheikh', email: 'imran@samiha.local', dept: 'IM',
    qualification: 'MBBS, MD (General Medicine)', specialization: 'Diabetes, hypertension & thyroid',
    reg_no: 'TN/45231', consult_fee: 500, follow_up_fee: 300, slot_minutes: 15, room_no: 'OPD-1' },
  { staff_code: 'DOC02', phone: '919840110002', name: 'Dr. Sara Ahmed', email: 'sara@samiha.local', dept: 'PED',
    qualification: 'MBBS, DCH', specialization: 'Neonatal & child health',
    reg_no: 'TN/51122', consult_fee: 450, follow_up_fee: 250, slot_minutes: 15, room_no: 'OPD-2' },
  { staff_code: 'DOC03', phone: '919840110003', name: 'Dr. Nafisa Rahman', email: 'nafisa@samiha.local', dept: 'GYN',
    qualification: 'MBBS, MS (OBG)', specialization: 'High-risk pregnancy & infertility',
    reg_no: 'TN/48890', consult_fee: 600, follow_up_fee: 350, slot_minutes: 20, room_no: 'OPD-3' },
  { staff_code: 'DOC06', phone: '919840110006', name: 'Dr. Arif Hussain', email: 'arif@samiha.local', dept: 'CAR',
    qualification: 'MBBS, MD, DM (Cardiology)', specialization: 'Interventional cardiology & echo',
    reg_no: 'TN/53412', consult_fee: 800, follow_up_fee: 450, slot_minutes: 20, room_no: 'OPD-6' },
  { staff_code: 'DOC07', phone: '919840110007', name: 'Dr. Neha Kulkarni', email: 'neha@samiha.local', dept: 'DEN',
    qualification: 'BDS, MDS', specialization: 'Conservative dentistry & endodontics',
    reg_no: 'TN/DEN/2201', consult_fee: 400, follow_up_fee: 250, slot_minutes: 30, room_no: 'DENTAL-1' },
  { staff_code: 'DOC05', phone: '919840110005', name: 'Dr. Priya Menon', email: 'priya@samiha.local', dept: 'DER',
    qualification: 'MBBS, MD (Dermatology)', specialization: 'Clinical & cosmetic dermatology',
    reg_no: 'TN/49775', consult_fee: 550, follow_up_fee: 300, slot_minutes: 15, room_no: 'OPD-5' },
  { staff_code: 'DOC04', phone: '919840110004', name: 'Dr. Vikram Rao', email: 'vikram@samiha.local', dept: 'ORT',
    qualification: 'MBBS, MS (Ortho)', specialization: 'Joint replacement & spine',
    reg_no: 'TN/52310', consult_fee: 600, follow_up_fee: 350, slot_minutes: 20, room_no: 'OPD-4' },
];

for (const d of doctors) {
  const id = upsert('users', 'staff_code', {
    staff_code: d.staff_code, name: d.name, email: d.email, phone: d.phone, role: 'doctor',
    department_id: deptId[d.dept], password_hash: hashPassword('samiha@123'),
  });
  // The mobile is what a booking alert reaches them on, so keep it current.
  db.prepare('UPDATE users SET department_id = ?, name = ?, phone = COALESCE(phone, ?) WHERE id = ?')
    .run(deptId[d.dept], d.name, d.phone, id);
  if (!db.prepare('SELECT 1 FROM doctor_profiles WHERE user_id = ?').get(id)) {
    db.prepare(
      `INSERT INTO doctor_profiles (user_id, qualification, specialization, reg_no, consult_fee,
                                    follow_up_fee, slot_minutes, room_no, signature_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, d.qualification, d.specialization, d.reg_no, d.consult_fee, d.follow_up_fee,
          d.slot_minutes, d.room_no, `${d.name}\n${d.qualification}\nReg. No. ${d.reg_no}`);
  }
  // Mon–Sat morning and evening OPD; Sunday morning only.
  if (!db.prepare('SELECT 1 FROM doctor_schedules WHERE doctor_id = ?').get(id)) {
    const ins = db.prepare(
      'INSERT INTO doctor_schedules (doctor_id, weekday, start_time, end_time, slot_minutes, max_tokens) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (let weekday = 1; weekday <= 6; weekday += 1) {
      ins.run(id, weekday, '09:00', '13:00', d.slot_minutes, 20);
      ins.run(id, weekday, '17:00', '20:00', d.slot_minutes, 15);
    }
    ins.run(id, 0, '09:00', '12:00', d.slot_minutes, 12);
  }
}

// ------------------------------------------------- financial assistance data
const programs = [
  { code: 'UNINS', name: 'Uninsured Care Fund', coverage_pct: 100, max_fpl_pct: 100,
    description: 'Full waiver of consultation and basic diagnostics for uninsured households at or below the poverty line.' },
  { code: 'SLIDE', name: 'Sliding Scale Discount Programme', coverage_pct: 0, max_fpl_pct: 400,
    description: 'Banded discount on all clinic services based on verified household income.' },
  { code: 'CHRON', name: 'Chronic Care Support', coverage_pct: 50, max_fpl_pct: 250,
    description: 'Half the cost of diabetes, hypertension and thyroid follow-up care and routine monitoring tests.' },
  { code: 'MATCARE', name: 'Maternal Care Scheme', coverage_pct: 75, max_fpl_pct: 200,
    description: 'Antenatal visits, routine scans and delivery-related consultations at 75% coverage.' },
  { code: 'CHILD', name: 'Child Health Initiative', coverage_pct: 100, max_fpl_pct: 150,
    description: 'Free paediatric consultation and immunisation for children under five.' },
];
for (const p of programs) upsert('assistance_programs', 'code', p);

const bands = [
  { band: 'A', fpl_min: 0,   fpl_max: 100, discount_pct: 100, flat_consult_fee: 0 },
  { band: 'B', fpl_min: 101, fpl_max: 150, discount_pct: 75,  flat_consult_fee: 100 },
  { band: 'C', fpl_min: 151, fpl_max: 200, discount_pct: 50,  flat_consult_fee: 200 },
  { band: 'D', fpl_min: 201, fpl_max: 250, discount_pct: 30,  flat_consult_fee: 300 },
  { band: 'E', fpl_min: 251, fpl_max: 400, discount_pct: 15,  flat_consult_fee: 400 },
  { band: 'F', fpl_min: 401, fpl_max: 999999, discount_pct: 0, flat_consult_fee: 0 },
];
for (const b of bands) upsert('sliding_scale_bands', 'band', b);

// Annual household income guideline (INR) used to compute FPL%.
const guidelines = [[1, 120000], [2, 168000], [3, 216000], [4, 264000],
  [5, 312000], [6, 360000], [7, 408000], [8, 456000]];
for (const [size, income] of guidelines) {
  db.prepare('INSERT OR IGNORE INTO poverty_guidelines (household_size, annual_income) VALUES (?, ?)').run(size, income);
}

/*
 * The billable catalogue — services, diagnostics and the tariff — lives in
 * catalogue.js and is synced on every boot, not only when seeding. A clinic
 * that has been running for months still receives a test the department has
 * started doing; without that, anything added here after the first install
 * would never reach it.
 */
require('./catalogue').sync({ quiet: true });


const seedToday = new Date();
const openingExpiry = (months) =>
  new Date(seedToday.getFullYear(), seedToday.getMonth() + months, 28).toISOString().slice(0, 10);

/*
 * The clinic's own starter formulary — every item from the pharmacy stock
 * list, loaded so it can be prescribed, ordered, counted and billed.
 *
 * The shelf is stocked from the sheet's own opening quantity, so a new install
 * opens with a working pharmacy rather than a list of medicines it cannot
 * dispense. It is the clinic's number, not an invented one, and it is only
 * ever written where the medicine has no batch at all: a count somebody has
 * since corrected at the shelf is never written over by re-seeding. The
 * reorder level is a quarter of it, so the low-stock warning means something
 * from the first day.
 *
 * Rates are still left alone. An MRP is printed on the pack that arrives and
 * differs between batches and brands, so guessing one here would put a wrong
 * price on a real patient's bill. These medicines go onto the shelf unpriced,
 * and the counter refuses to sell an unpriced medicine by name until a rate is
 * entered — under Pharmacy → Opening stock, where the same sheet lists them.
 */
const openBatchNo = `OPEN-${new Date().toISOString().slice(0, 7).replace('-', '')}`;
for (const [code, name, generic, form, strength, category, sched, pack, opening]
  of require('./formulary')) {
  const id = upsert('drugs', 'code', {
    code, name, generic_name: generic, form, strength, category, pack_size: pack,
    schedule_type: sched || null, hsn: '3004', tax_pct: 12,
    mrp: 0, purchase_price: 0,
    reorder_level: Math.max(1, Math.round((opening || 0) * 0.25)),
  });

  if (opening > 0 && !db.prepare('SELECT 1 FROM drug_batches WHERE drug_id = ?').get(id)) {
    db.prepare(
      `INSERT INTO drug_batches (drug_id, batch_no, expiry_date, qty_received, qty_available,
                                 mrp, purchase_price, supplier)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'Opening stock')`
    ).run(id, openBatchNo, openingExpiry(24), opening, opening);
    db.prepare(
      `INSERT INTO stock_ledger (drug_id, batch_id, txn_type, qty_delta, balance_after, ref_type, notes)
       VALUES (?, (SELECT id FROM drug_batches WHERE drug_id = ? AND batch_no = ?), 'purchase', ?, ?,
               'seed', 'Opening stock from the starter list — verify at the shelf')`
    ).run(id, id, openBatchNo, opening, opening);
  }
}


// -------------------------------------------------------------- drug master
const drugs = [
  ['PARA500', 'Dolo 650', 'Paracetamol', 'tablet', '650 mg', 'Micro Labs', 12, 2.2, 1.5, 'OTC', 200],
  ['AMOX500', 'Mox 500', 'Amoxicillin', 'capsule', '500 mg', 'Cipla', 12, 9.5, 6.5, 'H', 100],
  ['AZI500', 'Azithral 500', 'Azithromycin', 'tablet', '500 mg', 'Alembic', 12, 32, 22, 'H', 60],
  ['PAN40', 'Pan 40', 'Pantoprazole', 'tablet', '40 mg', 'Alkem', 12, 8.5, 5.5, 'H', 120],
  ['MET500', 'Glycomet 500', 'Metformin', 'tablet', '500 mg', 'USV', 12, 3.4, 2.1, 'H', 200],
  ['AMLO5', 'Amlong 5', 'Amlodipine', 'tablet', '5 mg', 'Micro Labs', 12, 4.2, 2.8, 'H', 150],
  ['TELMI40', 'Telma 40', 'Telmisartan', 'tablet', '40 mg', 'Glenmark', 12, 9.8, 6.2, 'H', 120],
  ['ATOR10', 'Atorva 10', 'Atorvastatin', 'tablet', '10 mg', 'Zydus', 12, 7.5, 4.8, 'H', 100],
  ['CETZ10', 'Cetzine', 'Cetirizine', 'tablet', '10 mg', 'GSK', 12, 2.1, 1.2, 'OTC', 150],
  ['ORS', 'ORS Sachet', 'Oral Rehydration Salts', 'sachet', '21.8 g', 'FDC', 5, 22, 14, 'OTC', 100],
  ['IBU400', 'Brufen 400', 'Ibuprofen', 'tablet', '400 mg', 'Abbott', 12, 3.8, 2.4, 'OTC', 120],
  ['SYRPARA', 'Calpol Syrup', 'Paracetamol', 'syrup', '120 mg/5 mL', 'GSK', 12, 48, 32, 'OTC', 40],
  ['SYRAMOX', 'Mox Dry Syrup', 'Amoxicillin', 'syrup', '125 mg/5 mL', 'Cipla', 12, 78, 52, 'H', 30],
  ['INJ-TT', 'Tetanus Toxoid', 'Tetanus Toxoid', 'injection', '0.5 mL', 'Serum Institute', 5, 35, 22, 'H', 40],
  ['INJ-DIC', 'Voveran Injection', 'Diclofenac', 'injection', '75 mg/3 mL', 'Novartis', 12, 26, 17, 'H', 40],
  ['VITD60K', 'Uprise D3 60K', 'Cholecalciferol', 'sachet', '60000 IU', 'Alkem', 12, 32, 21, 'H', 60],
  ['FEFOL', 'Fefol-Z', 'Ferrous + Folic Acid', 'capsule', '—', 'Abbott', 12, 6.5, 4.2, 'OTC', 100],
  ['THYRO50', 'Thyronorm 50', 'Levothyroxine', 'tablet', '50 mcg', 'Abbott', 12, 1.9, 1.2, 'H', 150],
];
const expiry = openingExpiry;

for (const [code, name, generic, form, strength, mfr, tax, mrp, cost, sched, openingQty] of drugs) {
  const id = upsert('drugs', 'code', {
    code, name, generic_name: generic, form, strength, manufacturer: mfr,
    tax_pct: tax, mrp, purchase_price: cost, schedule_type: sched, reorder_level: Math.round(openingQty * 0.2),
  });
  if (!db.prepare('SELECT 1 FROM drug_batches WHERE drug_id = ?').get(id)) {
    const batchNo = `B${String(id).padStart(3, '0')}A`;
    db.prepare(
      `INSERT INTO drug_batches (drug_id, batch_no, expiry_date, qty_received, qty_available, mrp, purchase_price, supplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, batchNo, expiry(18), openingQty, openingQty, mrp, cost, 'Opening stock');
    db.prepare(
      `INSERT INTO stock_ledger (drug_id, batch_id, txn_type, qty_delta, balance_after, ref_type, notes)
       VALUES (?, (SELECT id FROM drug_batches WHERE drug_id = ? AND batch_no = ?), 'purchase', ?, ?, 'seed', 'Opening stock')`
    ).run(id, id, batchNo, openingQty, openingQty);
  }
}

// -------------------------------------------------------------- wards & beds
const wards = [
  { code: 'GW', name: 'General Ward', kind: 'general', floor: '1st', beds: 10, tariff: 900 },
  { code: 'SP', name: 'Semi-Private', kind: 'semi_private', floor: '1st', beds: 6, tariff: 1800 },
  { code: 'PR', name: 'Private Rooms', kind: 'private', floor: '2nd', beds: 4, tariff: 3200 },
  { code: 'MAT', name: 'Maternity Ward', kind: 'maternity', floor: '2nd', beds: 5, tariff: 2200 },
  { code: 'ICU', name: 'Intensive Care Unit', kind: 'icu', floor: '2nd', beds: 4, tariff: 6500 },
  { code: 'DC', name: 'Day Care', kind: 'daycare', floor: 'Ground', beds: 4, tariff: 700 },
];
for (const w of wards) {
  const wardId = upsert('wards', 'code', { code: w.code, name: w.name, kind: w.kind, floor: w.floor });
  const existing = db.prepare('SELECT COUNT(*) AS c FROM beds WHERE ward_id = ?').get(wardId).c;
  for (let i = existing + 1; i <= w.beds; i += 1) {
    db.prepare('INSERT OR IGNORE INTO beds (ward_id, bed_no, tariff_per_day) VALUES (?, ?, ?)')
      .run(wardId, `${w.code}-${String(i).padStart(2, '0')}`, w.tariff);
  }
}

// -------------------------------------------------------------- ICD-10 seed
const icd = [
  // Infections — most of an OPD morning in this part of Tamil Nadu.
  ['A09', 'Infectious gastroenteritis and colitis, unspecified', 'Infectious diseases'],
  ['A49.9', 'Bacterial infection, unspecified', 'Infectious diseases'],
  ['A90', 'Dengue fever', 'Infectious diseases'],
  ['A91', 'Dengue haemorrhagic fever', 'Infectious diseases'],
  ['B54', 'Unspecified malaria', 'Infectious diseases'],
  ['A01.0', 'Typhoid fever', 'Infectious diseases'],
  ['B34.9', 'Viral infection, unspecified', 'Infectious diseases'],
  ['B35.4', 'Tinea corporis', 'Infectious diseases'],
  ['B37.9', 'Candidiasis, unspecified', 'Infectious diseases'],
  ['B86', 'Scabies', 'Infectious diseases'],
  ['A15.0', 'Tuberculosis of lung', 'Infectious diseases'],
  ['B02.9', 'Zoster without complication', 'Infectious diseases'],
  ['B00.9', 'Herpesviral infection, unspecified', 'Infectious diseases'],
  ['E11.9', 'Type 2 diabetes mellitus without complications', 'Endocrine'],
  ['E03.9', 'Hypothyroidism, unspecified', 'Endocrine'],
  ['E66.9', 'Obesity, unspecified', 'Endocrine'],
  ['D50.9', 'Iron deficiency anaemia, unspecified', 'Blood'],
  ['I10', 'Essential (primary) hypertension', 'Circulatory'],
  ['I25.1', 'Atherosclerotic heart disease of native coronary artery', 'Circulatory'],
  ['J06.9', 'Acute upper respiratory infection, unspecified', 'Respiratory'],
  ['J20.9', 'Acute bronchitis, unspecified', 'Respiratory'],
  ['J45.9', 'Asthma, unspecified', 'Respiratory'],
  ['K21.9', 'Gastro-oesophageal reflux disease without oesophagitis', 'Digestive'],
  ['K29.7', 'Gastritis, unspecified', 'Digestive'],
  ['L20.9', 'Atopic dermatitis, unspecified', 'Skin'],
  ['L30.9', 'Dermatitis, unspecified', 'Skin'],
  ['M54.5', 'Low back pain', 'Musculoskeletal'],
  ['M17.9', 'Osteoarthritis of knee, unspecified', 'Musculoskeletal'],
  ['N39.0', 'Urinary tract infection, site not specified', 'Genitourinary'],
  ['O26.9', 'Pregnancy-related condition, unspecified', 'Pregnancy'],
  ['R50.9', 'Fever, unspecified', 'Symptoms'],
  ['R51', 'Headache', 'Symptoms'],
  ['R10.4', 'Other and unspecified abdominal pain', 'Symptoms'],
  ['Z00.0', 'General adult medical examination', 'Health status'],
  ['Z34.9', 'Supervision of normal pregnancy, unspecified', 'Health status'],

  // Endocrine and metabolic
  ['E11.9', 'Type 2 diabetes mellitus without complications', 'Endocrine'],
  ['E11.65', 'Type 2 diabetes mellitus with hyperglycaemia', 'Endocrine'],
  ['E10.9', 'Type 1 diabetes mellitus without complications', 'Endocrine'],
  ['E78.5', 'Hyperlipidaemia, unspecified', 'Endocrine'],
  ['E05.9', 'Thyrotoxicosis, unspecified', 'Endocrine'],
  ['E55.9', 'Vitamin D deficiency, unspecified', 'Endocrine'],
  ['E53.8', 'Deficiency of other specified B group vitamins', 'Endocrine'],

  // Blood
  ['D64.9', 'Anaemia, unspecified', 'Blood'],

  // Circulatory
  ['I10', 'Essential (primary) hypertension', 'Circulatory'],
  ['I48.9', 'Atrial fibrillation and flutter, unspecified', 'Circulatory'],
  ['I83.9', 'Varicose veins of lower extremities without ulcer', 'Circulatory'],

  // Respiratory
  ['J00', 'Acute nasopharyngitis (common cold)', 'Respiratory'],
  ['J02.9', 'Acute pharyngitis, unspecified', 'Respiratory'],
  ['J03.9', 'Acute tonsillitis, unspecified', 'Respiratory'],
  ['J01.9', 'Acute sinusitis, unspecified', 'Respiratory'],
  ['J18.9', 'Pneumonia, unspecified organism', 'Respiratory'],
  ['J44.9', 'Chronic obstructive pulmonary disease, unspecified', 'Respiratory'],
  ['J30.4', 'Allergic rhinitis, unspecified', 'Respiratory'],

  // Digestive
  ['K30', 'Functional dyspepsia', 'Digestive'],
  ['K52.9', 'Non-infective gastroenteritis and colitis, unspecified', 'Digestive'],
  ['K59.0', 'Constipation', 'Digestive'],
  ['K64.9', 'Haemorrhoids, unspecified', 'Digestive'],
  ['K08.8', 'Other specified disorders of teeth and supporting structures', 'Digestive'],
  ['K12.1', 'Other forms of stomatitis', 'Digestive'],

  // Skin
  ['L23.9', 'Allergic contact dermatitis, unspecified cause', 'Skin'],
  ['L50.9', 'Urticaria, unspecified', 'Skin'],
  ['L03.9', 'Cellulitis, unspecified', 'Skin'],
  ['L02.9', 'Cutaneous abscess, furuncle and carbuncle, unspecified', 'Skin'],
  ['L70.9', 'Acne, unspecified', 'Skin'],

  // Musculoskeletal
  ['M25.5', 'Pain in joint', 'Musculoskeletal'],
  ['M79.1', 'Myalgia', 'Musculoskeletal'],
  ['M54.2', 'Cervicalgia', 'Musculoskeletal'],
  ['M06.9', 'Rheumatoid arthritis, unspecified', 'Musculoskeletal'],
  ['M10.9', 'Gout, unspecified', 'Musculoskeletal'],

  // Genitourinary and pregnancy
  ['N30.0', 'Acute cystitis', 'Genitourinary'],
  ['N20.0', 'Calculus of kidney', 'Genitourinary'],
  ['N92.0', 'Excessive and frequent menstruation with regular cycle', 'Genitourinary'],
  ['N94.6', 'Dysmenorrhoea, unspecified', 'Genitourinary'],
  ['O21.0', 'Mild hyperemesis gravidarum', 'Pregnancy'],
  ['Z33.1', 'Pregnant state, incidental', 'Health status'],

  // Eye and ear
  ['H10.9', 'Conjunctivitis, unspecified', 'Eye'],
  ['H66.9', 'Otitis media, unspecified', 'Ear'],
  ['H61.2', 'Impacted cerumen', 'Ear'],

  // Nervous system and mind
  ['G43.9', 'Migraine, unspecified', 'Nervous system'],
  ['F41.9', 'Anxiety disorder, unspecified', 'Mental health'],
  ['F32.9', 'Depressive episode, unspecified', 'Mental health'],
  ['G47.0', 'Insomnia', 'Nervous system'],

  // Symptoms and signs
  ['R11.0', 'Nausea', 'Symptoms'],
  ['R05', 'Cough', 'Symptoms'],
  ['R42', 'Dizziness and giddiness', 'Symptoms'],
  ['R53.83', 'Other fatigue', 'Symptoms'],
  ['R06.0', 'Dyspnoea', 'Symptoms'],

  // Injury
  ['T14.90', 'Injury, unspecified', 'Injury'],
  ['S61.9', 'Open wound of wrist, hand and fingers, unspecified', 'Injury'],
  ['T30.0', 'Burn of unspecified body region, unspecified degree', 'Injury'],
  ['W57', 'Bitten or stung by non-venomous insect and other arthropods', 'Injury'],

  // Health status
  ['Z23', 'Encounter for immunisation', 'Health status'],
  ['Z71.3', 'Dietary counselling and surveillance', 'Health status'],
];
for (const [code, title, chapter] of icd) {
  db.prepare('INSERT OR IGNORE INTO icd_codes (code, title, chapter) VALUES (?, ?, ?)').run(code, title, chapter);
}

// --------------------------------------------------------- insurers & TPAs
const tpas = [
  { code: 'MEDIASSIST', name: 'Medi Assist Insurance TPA', kind: 'tpa', settlement_days: 30, preauth_tat_hours: 6 },
  { code: 'PARAMOUNT', name: 'Paramount Health Services TPA', kind: 'tpa', settlement_days: 45, preauth_tat_hours: 8 },
  { code: 'VIDAL', name: 'Vidal Health TPA', kind: 'tpa', settlement_days: 30, preauth_tat_hours: 6 },
  { code: 'MDINDIA', name: 'MDIndia Health Insurance TPA', kind: 'tpa', settlement_days: 45, preauth_tat_hours: 12 },
];
for (const t of tpas) upsert('insurers', 'code', { ...t, cashless: 1 });

const tpaId = (code) => db.prepare('SELECT id FROM insurers WHERE code = ?').get(code).id;

const insurers = [
  { code: 'STAR', name: 'Star Health & Allied Insurance', kind: 'insurer',
    administered_by: null, settlement_days: 30, preauth_tat_hours: 4, tariff_discount_pct: 10 },
  { code: 'ICICILOM', name: 'ICICI Lombard General Insurance', kind: 'insurer',
    administered_by: tpaId('MEDIASSIST'), settlement_days: 30, preauth_tat_hours: 6, tariff_discount_pct: 12 },
  { code: 'NIVABUPA', name: 'Niva Bupa Health Insurance', kind: 'insurer',
    administered_by: null, settlement_days: 30, preauth_tat_hours: 4, tariff_discount_pct: 10 },
  { code: 'HDFCERGO', name: 'HDFC ERGO General Insurance', kind: 'insurer',
    administered_by: tpaId('VIDAL'), settlement_days: 45, preauth_tat_hours: 8, tariff_discount_pct: 10 },
  { code: 'NIACL', name: 'New India Assurance', kind: 'insurer',
    administered_by: tpaId('MDINDIA'), settlement_days: 60, preauth_tat_hours: 12, tariff_discount_pct: 15 },
  { code: 'ORIENTAL', name: 'Oriental Insurance', kind: 'insurer',
    administered_by: tpaId('PARAMOUNT'), settlement_days: 60, preauth_tat_hours: 12, tariff_discount_pct: 15 },
  { code: 'PMJAY', name: 'Ayushman Bharat PM-JAY', kind: 'government_scheme',
    administered_by: null, settlement_days: 15, preauth_tat_hours: 6, tariff_discount_pct: 30,
    notes: 'Package rates are fixed by the scheme; no co-pay for beneficiaries.' },
  { code: 'CGHS', name: 'CGHS', kind: 'government_scheme',
    administered_by: null, settlement_days: 90, preauth_tat_hours: 48, tariff_discount_pct: 25 },
  { code: 'ESIC', name: 'ESIC', kind: 'government_scheme',
    administered_by: null, settlement_days: 90, preauth_tat_hours: 48, tariff_discount_pct: 25 },
];
for (const i of insurers) upsert('insurers', 'code', { ...i, cashless: 1 });

// ---------------------------------------------------------------- settings
for (const [key, value] of [
  ['clinic.tagline', 'Care • Compassion • Commitment'],
  ['opd.morning', '09:00-13:00'],
  ['opd.evening', '17:00-20:00'],
  ['whatsapp.enabled', 'true'],
]) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// -------------------------------------------------------- sample patients
if (db.prepare('SELECT COUNT(*) AS c FROM patients').get().c === 0) {
  const samples = [
    { first: 'Ayesha', last: 'Begum', gender: 'female', age: 34, phone: '919876500001',
      city: 'Chennai', blood: 'O+', uninsured: 1, allergies: 'Sulfa drugs',
      chronic: 'Hypothyroidism' },
    { first: 'Rahul', last: 'Verma', gender: 'male', age: 52, phone: '919876500002',
      city: 'Chennai', blood: 'B+', uninsured: 0, insurer: 'Star Health', policy: 'SH-99201',
      chronic: 'Type 2 diabetes, Hypertension' },
    { first: 'Meera', last: 'Krishnan', gender: 'female', age: 28, phone: '919876500003',
      city: 'Chennai', blood: 'A+', uninsured: 1 },
    { first: 'Arjun', last: 'Nair', gender: 'male', age: 7, phone: '919876500004',
      city: 'Chennai', blood: 'O+', uninsured: 1, allergies: 'Peanuts' },
    { first: 'Sunita', last: 'Devi', gender: 'female', age: 61, phone: '919876500005',
      city: 'Chennai', blood: 'AB+', uninsured: 1, chronic: 'Osteoarthritis' },
  ];
  for (const s of samples) {
    db.prepare(
      `INSERT INTO patients (uhid, first_name, last_name, gender, age_years, phone, whatsapp, city, state,
                             blood_group, is_uninsured, insurance_provider, insurance_policy_no,
                             allergies, chronic_conditions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Tamil Nadu', ?, ?, ?, ?, ?, ?)`
    ).run(generate('uhid'), s.first, s.last, s.gender, s.age, s.phone, s.phone, s.city,
          s.blood, s.uninsured, s.insurer || null, s.policy || null, s.allergies || null, s.chronic || null);
  }
}

console.log('Seed complete.');
console.log('  Departments :', db.prepare("SELECT COUNT(*) AS c FROM departments WHERE active = 1").get().c,
  '(' + db.prepare("SELECT COUNT(*) AS c FROM departments WHERE active = 1 AND kind = 'specialist'").get().c + ' specialist)');
console.log('  Staff       :', db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
// Doctors are created above, after the migration has already run, so their
// codes are issued here — every doctor must have one before anything prints.
require('./index').backfillDoctorCodes();

// Every item gets its own barcode, so the pharmacist can print a shelf label
// the day the formulary is loaded rather than having to ask for one first.
for (const d of db.prepare(
  "SELECT id FROM drugs WHERE active = 1 AND (barcode IS NULL OR barcode = '')"
).all()) {
  db.prepare('UPDATE drugs SET barcode = ? WHERE id = ?').run(generate('drugBarcode'), d.id);
}

console.log('  Lab tests   :', db.prepare('SELECT COUNT(*) AS c FROM lab_tests').get().c);
console.log('  Drugs       :', db.prepare('SELECT COUNT(*) AS c FROM drugs').get().c,
  '·', db.prepare(
    'SELECT COUNT(DISTINCT drug_id) AS c FROM drug_batches WHERE qty_available > 0'
  ).get().c, 'on the shelf');
{
  const unpriced = db.prepare(
    `SELECT COUNT(*) AS c FROM drugs d
      WHERE d.active = 1 AND COALESCE(d.mrp, 0) = 0
        AND EXISTS (SELECT 1 FROM drug_batches b WHERE b.drug_id = d.id AND b.qty_available > 0)`
  ).get().c;
  if (unpriced) {
    console.log(`  Rates       : ${unpriced} medicine(s) are on the shelf with no MRP and cannot be`);
    console.log('                sold until one is set — Pharmacy → Opening stock → "No rate set"');
  }
}
console.log('  Beds        :', db.prepare('SELECT COUNT(*) AS c FROM beds').get().c);
console.log('  Insurers    :', db.prepare("SELECT COUNT(*) AS c FROM insurers WHERE kind != 'tpa'").get().c,
  '+', db.prepare("SELECT COUNT(*) AS c FROM insurers WHERE kind = 'tpa'").get().c, 'TPAs');
console.log('  Patients    :', db.prepare('SELECT COUNT(*) AS c FROM patients').get().c);
console.log('\n  Sign in with any staff email and password  samiha@123');
console.log('  e.g. admin@samiha.local / reception@samiha.local / imran@samiha.local\n');
