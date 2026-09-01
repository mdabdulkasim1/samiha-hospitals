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
  { staff_code: 'DOC01', name: 'Dr. Imran Sheikh', email: 'imran@samiha.local', dept: 'IM',
    qualification: 'MBBS, MD (General Medicine)', specialization: 'Diabetes, hypertension & thyroid',
    reg_no: 'TN/45231', consult_fee: 500, follow_up_fee: 300, slot_minutes: 15, room_no: 'OPD-1' },
  { staff_code: 'DOC02', name: 'Dr. Sara Ahmed', email: 'sara@samiha.local', dept: 'PED',
    qualification: 'MBBS, DCH', specialization: 'Neonatal & child health',
    reg_no: 'TN/51122', consult_fee: 450, follow_up_fee: 250, slot_minutes: 15, room_no: 'OPD-2' },
  { staff_code: 'DOC03', name: 'Dr. Nafisa Rahman', email: 'nafisa@samiha.local', dept: 'GYN',
    qualification: 'MBBS, MS (OBG)', specialization: 'High-risk pregnancy & infertility',
    reg_no: 'TN/48890', consult_fee: 600, follow_up_fee: 350, slot_minutes: 20, room_no: 'OPD-3' },
  { staff_code: 'DOC06', name: 'Dr. Arif Hussain', email: 'arif@samiha.local', dept: 'CAR',
    qualification: 'MBBS, MD, DM (Cardiology)', specialization: 'Interventional cardiology & echo',
    reg_no: 'TN/53412', consult_fee: 800, follow_up_fee: 450, slot_minutes: 20, room_no: 'OPD-6' },
  { staff_code: 'DOC07', name: 'Dr. Neha Kulkarni', email: 'neha@samiha.local', dept: 'DEN',
    qualification: 'BDS, MDS', specialization: 'Conservative dentistry & endodontics',
    reg_no: 'TN/DEN/2201', consult_fee: 400, follow_up_fee: 250, slot_minutes: 30, room_no: 'DENTAL-1' },
  { staff_code: 'DOC05', name: 'Dr. Priya Menon', email: 'priya@samiha.local', dept: 'DER',
    qualification: 'MBBS, MD (Dermatology)', specialization: 'Clinical & cosmetic dermatology',
    reg_no: 'TN/49775', consult_fee: 550, follow_up_fee: 300, slot_minutes: 15, room_no: 'OPD-5' },
  { staff_code: 'DOC04', name: 'Dr. Vikram Rao', email: 'vikram@samiha.local', dept: 'ORT',
    qualification: 'MBBS, MS (Ortho)', specialization: 'Joint replacement & spine',
    reg_no: 'TN/52310', consult_fee: 600, follow_up_fee: 350, slot_minutes: 20, room_no: 'OPD-4' },
];

for (const d of doctors) {
  const id = upsert('users', 'staff_code', {
    staff_code: d.staff_code, name: d.name, email: d.email, role: 'doctor',
    department_id: deptId[d.dept], password_hash: hashPassword('samiha@123'),
  });
  db.prepare('UPDATE users SET department_id = ?, name = ? WHERE id = ?').run(deptId[d.dept], d.name, id);
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

// ------------------------------------------------------------------ services
const services = [
  ['CONS-NEW', 'Consultation — new patient', 'consultation', 500, 0],
  ['CONS-FU', 'Consultation — follow-up', 'consultation', 300, 0],
  ['CONS-EMG', 'Emergency consultation', 'consultation', 800, 0],
  ['PROC-DRESS', 'Wound dressing', 'procedure', 250, 0],
  ['PROC-INJ', 'Injection administration', 'procedure', 100, 0],
  ['PROC-NEB', 'Nebulisation', 'procedure', 200, 0],
  ['PROC-SUT', 'Suturing (minor)', 'procedure', 900, 0],
  ['PROC-ECG', 'ECG', 'cardiology', 300, 0],
  ['NURS-DAY', 'Nursing charges per day', 'nursing', 400, 0],
  ['REG-CARD', 'Registration / record card', 'other', 50, 0],
  ['AMB-LOCAL', 'Ambulance — local', 'other', 1200, 0],
];
for (const [code, name, category, price, tax] of services) {
  upsert('services', 'code', { code, name, category: category === 'cardiology' ? 'procedure' : category, price, tax_pct: tax });
}

// ---------------------------------------------------------------- lab tests
const tests = [
  ['CBC', 'Complete Blood Count', 'lab', 'EDTA blood', null, null, null, 'See individual parameters', 350, 6],
  ['HB', 'Haemoglobin', 'lab', 'EDTA blood', 'g/dL', 12, 16, null, 120, 2],
  ['FBS', 'Fasting Blood Sugar', 'lab', 'Fluoride plasma', 'mg/dL', 70, 100, null, 120, 4],
  ['PPBS', 'Post-Prandial Blood Sugar', 'lab', 'Fluoride plasma', 'mg/dL', 70, 140, null, 120, 4],
  ['HBA1C', 'Glycated Haemoglobin (HbA1c)', 'lab', 'EDTA blood', '%', 4, 5.7, null, 650, 24],
  ['LIPID', 'Lipid Profile', 'lab', 'Serum', 'mg/dL', null, null, 'Total cholesterol < 200', 700, 12],
  ['LFT', 'Liver Function Test', 'lab', 'Serum', null, null, null, 'See individual parameters', 850, 12],
  ['RFT', 'Renal Function Test', 'lab', 'Serum', null, null, null, 'See individual parameters', 800, 12],
  ['TSH', 'Thyroid Stimulating Hormone', 'lab', 'Serum', 'µIU/mL', 0.4, 4.0, null, 450, 24],
  ['URINE', 'Urine Routine', 'lab', 'Urine', null, null, null, 'See report', 200, 4],
  ['VITD', 'Vitamin D (25-OH)', 'lab', 'Serum', 'ng/mL', 30, 100, null, 1600, 48],
  ['VITB12', 'Vitamin B12', 'lab', 'Serum', 'pg/mL', 200, 900, null, 1200, 48],
  ['CRP', 'C-Reactive Protein', 'lab', 'Serum', 'mg/L', 0, 5, null, 550, 8],
  ['DENGUE', 'Dengue NS1 / IgM / IgG', 'lab', 'Serum', null, null, null, 'Non-reactive', 900, 6],
  ['WIDAL', 'Widal Test', 'lab', 'Serum', null, null, null, 'Non-reactive', 300, 12],
  ['XR-CHEST', 'X-Ray Chest PA', 'radiology', null, null, null, null, 'Radiologist report', 400, 4],
  ['XR-KNEE', 'X-Ray Knee AP/Lateral', 'radiology', null, null, null, null, 'Radiologist report', 500, 4],
  ['USG-ABD', 'Ultrasound — Abdomen & Pelvis', 'radiology', null, null, null, null, 'Radiologist report', 1200, 6],
  ['USG-OBS', 'Ultrasound — Obstetric', 'radiology', null, null, null, null, 'Radiologist report', 1400, 6],
  ['USG-KUB', 'Ultrasound — KUB', 'radiology', null, null, null, null, 'Radiologist report', 1100, 6],
  ['USG-THY', 'Ultrasound — Thyroid / Neck', 'radiology', null, null, null, null, 'Radiologist report', 1200, 6],
  ['USG-DOP', 'Doppler — Peripheral vascular', 'radiology', null, null, null, null, 'Radiologist report', 2400, 12],
  ['XR-SPINE', 'X-Ray Lumbar Spine AP/Lateral', 'radiology', null, null, null, null, 'Radiologist report', 600, 4],
  ['XR-ABD', 'X-Ray Abdomen erect', 'radiology', null, null, null, null, 'Radiologist report', 450, 4],
  ['XR-DENT', 'Dental X-Ray (IOPA)', 'radiology', null, null, null, null, 'Dental surgeon report', 250, 1],
  ['ECHO', '2D Echocardiogram', 'cardiology', null, null, null, null, 'Cardiologist report', 2200, 24],
  ['ECG12', 'ECG — 12 lead', 'cardiology', null, null, null, null, 'Cardiologist report', 300, 1],
];
for (const [code, name, category, sample_type, unit, ref_low, ref_high, ref_text, price, tat_hours] of tests) {
  upsert('lab_tests', 'code', { code, name, category, sample_type, unit, ref_low, ref_high, ref_text, price, tat_hours });
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
const today = new Date();
const expiry = (months) => new Date(today.getFullYear(), today.getMonth() + months, 28).toISOString().slice(0, 10);

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
  ['A09', 'Infectious gastroenteritis and colitis, unspecified', 'Infectious diseases'],
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
console.log('  Lab tests   :', db.prepare('SELECT COUNT(*) AS c FROM lab_tests').get().c);
console.log('  Drugs       :', db.prepare('SELECT COUNT(*) AS c FROM drugs').get().c);
console.log('  Beds        :', db.prepare('SELECT COUNT(*) AS c FROM beds').get().c);
console.log('  Insurers    :', db.prepare("SELECT COUNT(*) AS c FROM insurers WHERE kind != 'tpa'").get().c,
  '+', db.prepare("SELECT COUNT(*) AS c FROM insurers WHERE kind = 'tpa'").get().c, 'TPAs');
console.log('  Patients    :', db.prepare('SELECT COUNT(*) AS c FROM patients').get().c);
console.log('\n  Sign in with any staff email and password  samiha@123');
console.log('  e.g. admin@samiha.local / reception@samiha.local / imran@samiha.local\n');
