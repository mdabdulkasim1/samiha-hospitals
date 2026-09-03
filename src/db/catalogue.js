'use strict';
const { db } = require('./index');
const rates = require('./rates');

/*
 * The clinic's billable catalogue: what it does, what it measures, and what
 * each of those costs.
 *
 * This is kept apart from the starter data in seed.js because it has a
 * different life. Staff accounts and sample patients are created once, when an
 * empty install is provisioned, and after that they belong to the clinic. The
 * catalogue keeps growing — a department starts a test, a radiology list is
 * loaded, a tariff is agreed — and a clinic that has been running for months
 * has no way to receive any of it, because seeding never runs again once there
 * are accounts. Tests we added to this file would simply never reach them.
 *
 * So sync() runs on every boot instead. That is safe by construction: every
 * write here is an upsert that inserts a row the catalogue does not have and
 * leaves alone every row it does. A name the clinic corrected, a rate it set,
 * a test it retired — none of it is written over. The only thing that moves an
 * existing rate is the tariff at the end, and that is a three-way merge which
 * moves a rate only while it still sits at the figure it was published with.
 *
 * What this deliberately does NOT touch: staff, patients, wards and beds, the
 * drug shelf, insurers, ICD codes. Some of those carry stock counts and
 * occupancy — state, not reference data — and none of them should change under
 * a clinic because the app restarted.
 */
/* Bump this when a new rate card is published, to revalue against it once. */
const TARIFF_KEY = 'tariff.2026_09';

function sync({ quiet = false } = {}) {
  const upsert = (table, uniqueCol, row) => {
    const existing = db.prepare(`SELECT id FROM ${table} WHERE ${uniqueCol} = ?`).get(row[uniqueCol]);
    if (existing) return existing.id;
    const cols = Object.keys(row);
    const info = db.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...cols.map((c) => row[c]));
    return info.lastInsertRowid;
  };

  const before = {
    services: db.prepare('SELECT COUNT(*) AS c FROM services').get().c,
    tests: db.prepare('SELECT COUNT(*) AS c FROM lab_tests').get().c,
  };

  // ------------------------------------------------------------------ services
  /*
   * The clinic's billable services, filed under the group a cashier looks in.
   *
   * The rates here are starting figures, not the clinic's tariff. They are
   * deliberately plausible for a Melapalayam polyclinic rather than left at
   * zero, because a zero rate bills nothing and does it silently; a wrong rate
   * is visible on the first bill and gets corrected. Set the real ones under
   * Services & Rates — nothing here is overwritten once it has been edited.
   */
  const services = [
    // code, name, category, bill group, rate, tax %
    ['CONS-NEW', 'Consultation — new patient', 'consultation', 'Consultation', 500, 0],
    ['CONS-FU', 'Consultation — follow-up', 'consultation', 'Consultation', 300, 0],
    ['CONS-EMG', 'Emergency consultation', 'consultation', 'Consultation', 800, 0],
    ['CONS-SPEC', 'Specialist consultation', 'consultation', 'Consultation', 700, 0],
    ['CONS-2OP', 'Second opinion', 'consultation', 'Consultation', 600, 0],
    ['CONS-TELE', 'Teleconsultation', 'consultation', 'Consultation', 300, 0],
    ['CONS-REV', 'Review within 7 days', 'consultation', 'Consultation', 0, 0],

    ['PROC-DRESS', 'Wound dressing — small', 'procedure', 'Procedures & treatment', 250, 0],
    ['PROC-DRESSL', 'Wound dressing — large', 'procedure', 'Procedures & treatment', 450, 0],
    ['PROC-INJ', 'Injection administration', 'procedure', 'Procedures & treatment', 100, 0],
    ['PROC-IVCAN', 'IV cannulation', 'procedure', 'Procedures & treatment', 200, 0],
    ['PROC-IVFL', 'IV fluid administration (per pint)', 'procedure', 'Procedures & treatment', 350, 0],
    ['PROC-NEB', 'Nebulisation', 'procedure', 'Procedures & treatment', 200, 0],
    ['PROC-OXY', 'Oxygen — per hour', 'procedure', 'Procedures & treatment', 250, 0],
    ['PROC-SUT', 'Suturing — minor', 'procedure', 'Procedures & treatment', 900, 0],
    ['PROC-SUTM', 'Suturing — major', 'procedure', 'Procedures & treatment', 1800, 0],
    ['PROC-SUTR', 'Suture removal', 'procedure', 'Procedures & treatment', 200, 0],
    ['PROC-ABS', 'Abscess incision & drainage', 'procedure', 'Procedures & treatment', 1200, 0],
    ['PROC-CATH', 'Urinary catheterisation', 'procedure', 'Procedures & treatment', 700, 0],
    ['PROC-EAR', 'Ear syringing / wax removal', 'procedure', 'Procedures & treatment', 400, 0],
    ['PROC-FB', 'Foreign body removal — minor', 'procedure', 'Procedures & treatment', 800, 0],
    ['PROC-POP', 'Plaster / POP application', 'procedure', 'Procedures & treatment', 1200, 0],
    ['PROC-POPR', 'Plaster removal', 'procedure', 'Procedures & treatment', 300, 0],
    ['PROC-BURN', 'Burn dressing', 'procedure', 'Procedures & treatment', 600, 0],
    ['PROC-BIOP', 'Biopsy — minor', 'procedure', 'Procedures & treatment', 2500, 0],
    ['PROC-IUCD', 'IUCD insertion / removal', 'procedure', 'Procedures & treatment', 900, 0],
    ['PROC-CIRC', 'Circumcision', 'procedure', 'Procedures & treatment', 5000, 0],
    ['PROC-PHYSIO', 'Physiotherapy — per session', 'procedure', 'Procedures & treatment', 400, 0],
    ['PROC-IMMUN', 'Immunisation — administration', 'procedure', 'Procedures & treatment', 150, 0],
    ['PROC-BP', 'Blood pressure & vitals check', 'procedure', 'Procedures & treatment', 50, 0],
    ['PROC-TRANSF', 'Blood transfusion — administration', 'procedure', 'Procedures & treatment', 1500, 0],

    ['NURS-DAY', 'Nursing charges — per day', 'nursing', 'Nursing & ward', 400, 0],
    ['NURS-RMO', 'RMO / duty doctor — per day', 'nursing', 'Nursing & ward', 500, 0],
    ['WARD-GEN', 'Ward — general, per day', 'room', 'Nursing & ward', 700, 0],
    ['WARD-SEMI', 'Ward — semi-private, per day', 'room', 'Nursing & ward', 1200, 0],
    ['WARD-PVT', 'Room — private, per day', 'room', 'Nursing & ward', 2000, 0],
    ['WARD-DAY', 'Day-care bed — per day', 'room', 'Nursing & ward', 700, 0],
    ['WARD-OBS', 'Observation — per hour', 'room', 'Nursing & ward', 200, 0],

    ['REG-CARD', 'Registration / record card', 'other', 'Ambulance & other', 50, 0],
    ['REG-DUP', 'Duplicate report or record', 'other', 'Ambulance & other', 100, 0],
    ['CERT-MED', 'Medical certificate', 'other', 'Ambulance & other', 200, 0],
    ['CERT-FIT', 'Fitness certificate', 'other', 'Ambulance & other', 300, 0],
    ['AMB-LOCAL', 'Ambulance — within town', 'other', 'Ambulance & other', 1200, 0],
    ['AMB-OUT', 'Ambulance — outstation, per km', 'other', 'Ambulance & other', 30, 0],
  ];
  for (const [code, name, category, bill_group, price, tax] of services) {
    upsert('services', 'code', { code, name, category, bill_group, price, tax_pct: tax });
  }

  // ---------------------------------------------------------------- lab tests
  /*
   * Diagnostics carry two labels and they are not the same thing. `category`
   * decides how the report reads — a scan is findings and an impression, a blood
   * test is numbers against a reference range — and `bill_group` decides where
   * the cashier finds it. Rates here are starting figures, as above.
   */
  const tests = [
    // code, name, category, bill group, sample, unit, low, high, ref text, rate, TAT hrs
    ['CBC', 'Complete Blood Count', 'lab', 'Blood tests', 'EDTA blood', null, null, null, 'See individual parameters', 350, 6],
    ['HB', 'Haemoglobin', 'lab', 'Blood tests', 'EDTA blood', 'g/dL', 12, 16, null, 120, 2],
    ['ESR', 'ESR', 'lab', 'Blood tests', 'EDTA blood', 'mm/hr', 0, 20, null, 150, 4],
    ['PLT', 'Platelet count', 'lab', 'Blood tests', 'EDTA blood', '/µL', 150000, 450000, null, 200, 4],
    ['BLGRP', 'Blood group & Rh typing', 'lab', 'Blood tests', 'EDTA blood', null, null, null, 'ABO / Rh', 150, 2],
    ['FBS', 'Fasting Blood Sugar', 'lab', 'Blood tests', 'Fluoride plasma', 'mg/dL', 70, 100, null, 120, 4],
    ['PPBS', 'Post-Prandial Blood Sugar', 'lab', 'Blood tests', 'Fluoride plasma', 'mg/dL', 70, 140, null, 120, 4],
    ['RBS', 'Random Blood Sugar', 'lab', 'Blood tests', 'Fluoride plasma', 'mg/dL', 70, 140, null, 100, 2],
    ['HBA1C', 'Glycated Haemoglobin (HbA1c)', 'lab', 'Blood tests', 'EDTA blood', '%', 4, 5.7, null, 650, 24],
    ['LIPID', 'Lipid Profile', 'lab', 'Blood tests', 'Serum', 'mg/dL', null, null, 'Total cholesterol < 200', 700, 12],
    ['LFT', 'Liver Function Test', 'lab', 'Blood tests', 'Serum', null, null, null, 'See individual parameters', 850, 12],
    ['RFT', 'Renal Function Test', 'lab', 'Blood tests', 'Serum', null, null, null, 'See individual parameters', 800, 12],
    ['UREA', 'Blood urea', 'lab', 'Blood tests', 'Serum', 'mg/dL', 15, 40, null, 200, 6],
    ['CREAT', 'Serum creatinine', 'lab', 'Blood tests', 'Serum', 'mg/dL', 0.6, 1.3, null, 220, 6],
    ['URIC', 'Serum uric acid', 'lab', 'Blood tests', 'Serum', 'mg/dL', 3.5, 7.2, null, 250, 6],
    ['ELEC', 'Serum electrolytes', 'lab', 'Blood tests', 'Serum', null, null, null, 'Na / K / Cl', 450, 6],
    ['CALC', 'Serum calcium', 'lab', 'Blood tests', 'Serum', 'mg/dL', 8.5, 10.5, null, 250, 6],
    ['TSH', 'Thyroid Stimulating Hormone', 'lab', 'Blood tests', 'Serum', 'µIU/mL', 0.4, 4.0, null, 450, 24],
    ['THYP', 'Thyroid profile (T3 T4 TSH)', 'lab', 'Blood tests', 'Serum', null, null, null, 'See individual parameters', 900, 24],
    ['VITD', 'Vitamin D (25-OH)', 'lab', 'Blood tests', 'Serum', 'ng/mL', 30, 100, null, 1600, 48],
    ['VITB12', 'Vitamin B12', 'lab', 'Blood tests', 'Serum', 'pg/mL', 200, 900, null, 1200, 48],
    ['CRP', 'C-Reactive Protein', 'lab', 'Blood tests', 'Serum', 'mg/L', 0, 5, null, 550, 8],
    ['DENGUE', 'Dengue NS1 / IgM / IgG', 'lab', 'Blood tests', 'Serum', null, null, null, 'Non-reactive', 900, 6],
    ['WIDAL', 'Widal Test', 'lab', 'Blood tests', 'Serum', null, null, null, 'Non-reactive', 300, 12],
    ['MP', 'Malaria parasite / antigen', 'lab', 'Blood tests', 'EDTA blood', null, null, null, 'Not detected', 300, 4],
    ['HIV', 'HIV I & II (screening)', 'lab', 'Blood tests', 'Serum', null, null, null, 'Non-reactive', 500, 12],
    ['HBSAG', 'HBsAg (screening)', 'lab', 'Blood tests', 'Serum', null, null, null, 'Non-reactive', 400, 12],
    ['HCV', 'Anti-HCV (screening)', 'lab', 'Blood tests', 'Serum', null, null, null, 'Non-reactive', 600, 12],
    ['PREG', 'Pregnancy test (beta hCG)', 'lab', 'Blood tests', 'Serum', null, null, null, 'Negative', 350, 6],
    ['PT', 'Prothrombin time / INR', 'lab', 'Blood tests', 'Citrate plasma', 'sec', null, null, 'INR 0.9 – 1.2', 450, 6],

    ['URINE', 'Urine Routine', 'lab', 'Urine & stool', 'Urine', null, null, null, 'See report', 200, 4],
    ['URCULT', 'Urine culture & sensitivity', 'lab', 'Urine & stool', 'Urine', null, null, null, 'No growth', 700, 72],
    ['UPREG', 'Urine pregnancy test', 'lab', 'Urine & stool', 'Urine', null, null, null, 'Negative', 150, 1],
    ['STOOL', 'Stool routine', 'lab', 'Urine & stool', 'Stool', null, null, null, 'See report', 250, 6],
    ['STOCC', 'Stool occult blood', 'lab', 'Urine & stool', 'Stool', null, null, null, 'Negative', 300, 6],
    ['SPUTUM', 'Sputum AFB', 'lab', 'Urine & stool', 'Sputum', null, null, null, 'Not detected', 300, 24],

    ['XR-CHEST', 'X-Ray Chest PA', 'radiology', 'X-ray', null, null, null, null, 'Radiologist report', 400, 4],
    ['XR-KNEE', 'X-Ray Knee AP/Lateral', 'radiology', 'X-ray', null, null, null, null, 'Radiologist report', 500, 4],
    ['XR-SPINE', 'X-Ray Lumbar Spine AP/Lateral', 'radiology', 'X-ray', null, null, null, null, 'Radiologist report', 600, 4],
    ['XR-CSPINE', 'X-Ray Cervical Spine', 'radiology', 'X-ray', null, null, null, null, 'Radiologist report', 550, 4],
    ['XR-ABD', 'X-Ray Abdomen erect', 'radiology', 'X-ray', null, null, null, null, 'Radiologist report', 450, 4],
    ['XR-SHOUL', 'X-Ray Shoulder', 'radiology', 'X-ray', null, null, null, null, 'Radiologist report', 500, 4],
    ['XR-PELV', 'X-Ray Pelvis', 'radiology', 'X-ray', null, null, null, null, 'Radiologist report', 550, 4],
    ['XR-SKULL', 'X-Ray Skull', 'radiology', 'X-ray', null, null, null, null, 'Radiologist report', 500, 4],
    ['XR-LIMB', 'X-Ray Limb (per part)', 'radiology', 'X-ray', null, null, null, null, 'Radiologist report', 450, 4],
    ['XR-DENT', 'Dental X-Ray (IOPA)', 'radiology', 'X-ray', null, null, null, null, 'Dental surgeon report', 250, 1],

    ['USG-ABD', 'Ultrasound — Abdomen & Pelvis', 'radiology', 'Ultrasound & Doppler', null, null, null, null, 'Radiologist report', 1200, 6],
    ['USG-OBS', 'Ultrasound — Obstetric', 'radiology', 'Ultrasound & Doppler', null, null, null, null, 'Radiologist report', 1400, 6],
    ['USG-KUB', 'Ultrasound — KUB', 'radiology', 'Ultrasound & Doppler', null, null, null, null, 'Radiologist report', 1100, 6],
    ['USG-THY', 'Ultrasound — Thyroid / Neck', 'radiology', 'Ultrasound & Doppler', null, null, null, null, 'Radiologist report', 1200, 6],
    ['USG-BRE', 'Ultrasound — Breast', 'radiology', 'Ultrasound & Doppler', null, null, null, null, 'Radiologist report', 1200, 6],
    ['USG-SCR', 'Ultrasound — Scrotum', 'radiology', 'Ultrasound & Doppler', null, null, null, null, 'Radiologist report', 1100, 6],
    ['USG-SOFT', 'Ultrasound — Soft tissue', 'radiology', 'Ultrasound & Doppler', null, null, null, null, 'Radiologist report', 1000, 6],
    ['USG-DOP', 'Doppler — Peripheral vascular', 'radiology', 'Ultrasound & Doppler', null, null, null, null, 'Radiologist report', 2400, 12],
    ['USG-DOPO', 'Doppler — Obstetric', 'radiology', 'Ultrasound & Doppler', null, null, null, null, 'Radiologist report', 2200, 12],

    ['ECG12', 'ECG — 12 lead', 'cardiology', 'ECG & heart', null, null, null, null, 'Cardiologist report', 300, 1],
    ['ECHO', '2D Echocardiogram', 'cardiology', 'ECG & heart', null, null, null, null, 'Cardiologist report', 2200, 24],
    ['TMT', 'Treadmill test (TMT)', 'cardiology', 'ECG & heart', null, null, null, null, 'Cardiologist report', 2500, 24],
    ['HOLTER', 'Holter monitoring — 24 hour', 'cardiology', 'ECG & heart', null, null, null, null, 'Cardiologist report', 3500, 48],
  ];
  for (const [code, name, category, bill_group, sample_type, unit, ref_low, ref_high, ref_text, price, tat_hours] of tests) {
    upsert('lab_tests', 'code', {
      code, name, category, bill_group, sample_type, unit, ref_low, ref_high, ref_text, price, tat_hours,
    });
  }

  /*
   * The clinic's own diagnostic catalogue, taken from a health-checkup report it
   * runs — the panels, the tests it reports on their own, and every analyte
   * inside each panel with the units and reference ranges the report is issued
   * against.
   *
   * None of it is priced. A tariff is the clinic's to set and a guessed rate
   * would put a wrong figure on a real patient's bill, so these show under
   * Services & Rates as "no rate set" until somebody prices them — and upsert
   * leaves a price alone once it is set, so re-seeding never undoes that.
   */
  const diagnostics = require('./diagnostics');
  for (const [code, name, bill_group, sample_type, ref_text, tat_hours] of diagnostics.PANELS) {
    upsert('lab_tests', 'code', {
      code, name, category: 'lab', bill_group, sample_type, ref_text, price: 0, tat_hours,
    });
  }
  for (const [code, name, bill_group, sample_type, unit, ref_low, ref_high, ref_text, tat_hours]
    of diagnostics.SINGLES) {
    upsert('lab_tests', 'code', {
      code, name, category: 'lab', bill_group, sample_type, unit, ref_low, ref_high, ref_text,
      price: 0, tat_hours,
    });
  }
  /*
   * Radiology. Every view has to stand on its own, because a request names one:
   * "chest PA and lateral", "left ankle", "PNS". Reported in words, so the ref
   * text says whose opinion the report carries rather than a range.
   */
  /*
   * The screening packages. Their name carries the tests they cover, in
   * brackets, because a package is chosen off a poster and pressed at a counter
   * — and whoever presses it should not have to remember what is in it.
   */
  for (const [code, name, price, covers] of diagnostics.PACKAGES) {
    upsert('lab_tests', 'code', {
      code, name: `${name} (${covers})`, category: 'lab', bill_group: 'Health packages',
      sample_type: 'As per the tests covered', price, tat_hours: 12,
      ref_text: `Covers: ${covers}. Reported as one package.`,
    });
  }

  diagnostics.IMAGING.forEach(([code, name, bill_group, category], i) => {
    const id = upsert('lab_tests', 'code', {
      code, name, category, bill_group, price: 0, tat_hours: 24, sort_order: i + 1,
      ref_text: category === 'cardiology' ? 'Cardiologist report' : 'Radiologist report',
    });
    /*
     * Where a view sits in the list is ours to keep in step, even for one that
     * was already there — the list reads down the body, chest to foot, and not
     * down the alphabet, which would open it on the barium studies. Set once,
     * so nothing is fought over on a later re-seed; the rate stays the clinic's.
     */
    db.prepare('UPDATE lab_tests SET sort_order = ? WHERE id = ? AND sort_order = 0').run(i + 1, id);
  });

  diagnostics.COMPONENTS.forEach(([code, name, panel, sample_type, unit, ref_low, ref_high, ref_text], i) => {
    const parent = db.prepare('SELECT bill_group FROM lab_tests WHERE code = ?').get(panel);
    upsert('lab_tests', 'code', {
      code, name, category: 'lab', bill_group: parent ? parent.bill_group : 'Blood tests',
      sample_type, unit, ref_low, ref_high, ref_text, price: 0, tat_hours: 24,
      component_of: panel, sort_order: i + 1,
    });
  });

  /*
   * The tariff last, because it prices rows the blocks above may have just
   * created.
   *
   * Published once, then lived with. The first boot after a new list lands
   * moves every rate that still stands at the figure it was published with —
   * a revaluation, which is what a new rate card is. After that the list only
   * fills in rows that carry no rate at all, so a test added next month still
   * gets priced while nothing the clinic has decided is ever revisited.
   */
  const published = db.prepare("SELECT value FROM settings WHERE key = ?").get(TARIFF_KEY);
  const tariff = rates.apply(db, { revalue: !published });
  if (!published) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(TARIFF_KEY, new Date().toISOString());
  }
  const added = {
    services: db.prepare('SELECT COUNT(*) AS c FROM services').get().c - before.services,
    tests: db.prepare('SELECT COUNT(*) AS c FROM lab_tests').get().c - before.tests,
  };

  if (!quiet && (added.services || added.tests || tariff.updated || tariff.kept.length)) {
    const bits = [];
    if (added.services) bits.push(`${added.services} service(s) added`);
    if (added.tests) bits.push(`${added.tests} diagnostic(s) added`);
    if (tariff.updated) bits.push(`${tariff.updated} rate(s) set from the tariff`);
    if (tariff.kept.length) bits.push(`${tariff.kept.length} rate(s) left as the clinic set them`);
    console.log(`[catalogue] ${bits.join(', ')}.`);
    for (const k of tariff.kept) {
      console.log(`[catalogue]   kept ${k.code} at ${k.at} — the tariff says ${k.wanted}`);
    }
  }
  return { added, tariff };
}

module.exports = { sync };
