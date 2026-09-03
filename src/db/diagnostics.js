'use strict';
/*
 * The clinic's own diagnostic catalogue, taken from a full health-checkup
 * report the clinic sent in — panel by panel, with the units and reference
 * ranges the report was issued against.
 *
 * Two kinds of row.
 *
 * A PANEL is what a patient buys and is billed for: a lipid profile, a renal
 * function test, a complete blood count. It carries a rate.
 *
 * A COMPONENT is one analyte inside a panel — MCHC, direct bilirubin, the
 * urine deposits. It is reported, not sold, so it carries no rate and stays
 * off the cashier's charge board and the doctor's order list, where a hundred
 * unsellable buttons would only get in the way. Give a component a rate and it
 * becomes orderable and billable in its own right: pricing a test is how the
 * clinic says it offers that test on its own.
 *
 * No rate is set on anything new here. A tariff is the clinic's to set, and a
 * guessed one would put a wrong figure on a real patient's bill; every one of
 * these shows under Services & Rates as "no rate set" until somebody prices it.
 *
 * Columns: code, name, panel (null for a panel itself), sample, unit,
 *          ref low, ref high, ref text.
 */

/** The panels this catalogue adds. Existing panels are referenced, not redefined. */
const PANELS = [
  // code, name, bill group, sample, ref text, TAT hours
  ['IRONPROF', 'Iron Deficiency Profile', 'Blood tests', 'Serum', 'See individual parameters', 24],
  ['LFT-ADV', 'Liver Function Test (Advanced)', 'Blood tests', 'Serum', 'See individual parameters', 12],
  ['RFT-GFR', 'Renal Function Test with eGFR', 'Blood tests', 'Serum', 'See individual parameters', 12],
];

/** Tests the report gave on their own, billable in their own right. */
const SINGLES = [
  // code, name, bill group, sample, unit, low, high, ref text, TAT hours
  ['NA', 'Sodium, serum', 'Blood tests', 'Serum', 'mmol/L', 135, 150, null, 6],
  ['CL', 'Chloride, serum', 'Blood tests', 'Serum', 'mmol/L', 92, 110, null, 6],
  ['TESTO', 'Testosterone, total', 'Blood tests', 'Serum', 'ng/dL', 171, 789, null, 24],
];

/*
 * The analytes, panel by panel, in the order the report prints them.
 *
 * A range the report states in words rather than as two numbers — the lipid
 * bands, the HbA1c cut-offs — is kept as words. Flattening "desirable under
 * 200, borderline to 239, high above that" into a pair of numbers would throw
 * away what the range is for.
 */
const COMPONENTS = [
  // ---------------------------------------------------------- HbA1c
  ['HBA1C-EAG', 'Estimated average glucose (eAG)', 'HBA1C', 'EDTA blood', 'mg/dL', null, null, 'Calculated from HbA1c'],

  // ---------------------------------------------------------- Lipid profile
  ['LIP-CHOL', 'Cholesterol, total', 'LIPID', 'Serum', 'mg/dL', null, null,
    'Desirable < 200 · Borderline 200–239 · High ≥ 240'],
  ['LIP-HDL', 'HDL cholesterol', 'LIPID', 'Serum', 'mg/dL', null, null,
    '< 34.7 undesirable, high risk · > 77.3 desirable, low risk'],
  ['LIP-LDL', 'LDL cholesterol', 'LIPID', 'Serum', 'mg/dL', null, null,
    '< 100 optimal · 100–129 above optimal · 130–159 borderline high · 160–190 high · > 190 very high'],
  ['LIP-TG', 'Triglycerides', 'LIPID', 'Serum', 'mg/dL', null, null,
    '< 150 normal · 150–199 borderline high · 200–499 high · ≥ 500 very high'],
  ['LIP-VLDL', 'VLDL cholesterol', 'LIPID', 'Serum', 'mg/dL', 7, 40, null],
  ['LIP-NONHDL', 'Non-HDL cholesterol', 'LIPID', 'Serum', 'mg/dL', null, null, '< 130'],
  ['LIP-CHDL', 'Cholesterol / HDL ratio', 'LIPID', 'Serum', 'Ratio', null, null,
    '< 4 desirable · 4–6 borderline · > 6 high risk'],
  ['LIP-LHDL', 'LDL / HDL ratio', 'LIPID', 'Serum', 'Ratio', null, null,
    '< 2.5 desirable · 2.5–5.0 borderline · > 5.0 high risk'],

  // ------------------------------------------------- Iron deficiency profile
  ['IRON', 'Iron, total', 'IRONPROF', 'Serum', 'µg/dL', 60, 165, null],
  ['UIBC', 'Unsaturated iron binding capacity (UIBC)', 'IRONPROF', 'Serum', 'µg/dL', 69, 240, null],
  ['TIBC', 'Total iron binding capacity (TIBC)', 'IRONPROF', 'Serum', 'µg/dL', 250, 450, null],
  ['TRFSAT', 'Transferrin saturation', 'IRONPROF', 'Serum', '%', 20, 50, null],
  ['FERRITIN', 'Ferritin', 'IRONPROF', 'Serum', 'ng/mL', 24, 425, null],

  // ----------------------------------------------------- Renal function
  ['RFT-UREA', 'Urea', 'RFT-GFR', 'Serum', 'mg/dL', 18, 48, null],
  ['RFT-CREAT', 'Creatinine, serum', 'RFT-GFR', 'Serum', 'mg/dL', 0.66, 1.18, null],
  ['RFT-URIC', 'Uric acid', 'RFT-GFR', 'Serum', 'mg/dL', 3.7, 7.7, null],
  ['BUN', 'Blood urea nitrogen (BUN)', 'RFT-GFR', 'Serum', 'mg/dL', 9, 23, null],
  ['BUNCR', 'BUN / creatinine ratio', 'RFT-GFR', 'Serum', 'Ratio', 10, 20, null],
  ['EGFR', 'eGFR (estimated glomerular filtration rate)', 'RFT-GFR', 'Serum', 'mL/min/1.73m²',
    null, null, '> 90 · CKD-EPI formula'],

  // ------------------------------------------------------ Liver function
  ['BIL-T', 'Bilirubin, total', 'LFT-ADV', 'Serum', 'mg/dL', 0.2, 1.2, null],
  ['BIL-D', 'Bilirubin, direct (conjugated)', 'LFT-ADV', 'Serum', 'mg/dL', null, null, '≤ 0.5'],
  ['BIL-I', 'Bilirubin, indirect (unconjugated)', 'LFT-ADV', 'Serum', 'mg/dL', null, null, '< 1.10'],
  ['SGOT', 'SGOT — aspartate aminotransferase (AST)', 'LFT-ADV', 'Serum', 'U/L', 15, 40, null],
  ['SGPT', 'SGPT — alanine aminotransferase (ALT)', 'LFT-ADV', 'Serum', 'U/L', 9, 50, null],
  ['GGT', 'Gamma GT (GGT)', 'LFT-ADV', 'Serum', 'U/L', null, null, '< 55'],
  ['PROT-T', 'Protein, total', 'LFT-ADV', 'Serum', 'g/dL', 6.4, 8.3, null],
  ['ALB', 'Albumin', 'LFT-ADV', 'Serum', 'g/dL', 3.5, 5.0, null],
  ['GLOB', 'Globulin', 'LFT-ADV', 'Serum', 'g/dL', 2.0, 3.8, null],
  ['AGRATIO', 'A/G ratio (albumin / globulin)', 'LFT-ADV', 'Serum', 'Ratio', 0.8, 2.5, null],
  ['ALP', 'Alkaline phosphatase (ALP)', 'LFT-ADV', 'Serum', 'U/L', 40, 129, null],

  // ------------------------------------------------------ Thyroid function
  ['T3', 'T3 (triiodothyronine), total', 'THYP', 'Serum', 'ng/mL', 0.75, 2.1, null],
  ['T4', 'T4 (thyroxine), total', 'THYP', 'Serum', 'µg/dL', 5, 13, null],
  ['TFT-TSH', 'TSH (thyroid stimulating hormone)', 'THYP', 'Serum', 'µIU/mL', 0.3, 4.5, null],

  // -------------------------------------------------- Complete blood count
  ['CBC-HB', 'Haemoglobin', 'CBC', 'EDTA blood', 'g/dL', 13, 17, null],
  ['CBC-RBC', 'RBC count', 'CBC', 'EDTA blood', 'million/cumm', 4.5, 5.5, null],
  ['CBC-HCT', 'HCT / PCV', 'CBC', 'EDTA blood', '%', 40, 50, null],
  ['CBC-MCV', 'MCV', 'CBC', 'EDTA blood', 'fL', 80, 100, null],
  ['CBC-MCH', 'MCH', 'CBC', 'EDTA blood', 'pg', 27, 32, null],
  ['CBC-MCHC', 'MCHC', 'CBC', 'EDTA blood', 'g/dL', 31.5, 34.5, null],
  ['CBC-RDWSD', 'RDW-SD', 'CBC', 'EDTA blood', 'fL', 35, 56, null],
  ['CBC-RDWCV', 'RDW-CV', 'CBC', 'EDTA blood', '%', 11.6, 14, null],
  ['CBC-TLC', 'Total leucocyte count (TLC)', 'CBC', 'EDTA blood', 'x1000 cells/cumm', 4, 10, null],
  ['CBC-NEUTP', 'Neutrophils', 'CBC', 'EDTA blood', '%', 40, 70, null],
  ['CBC-LYMPP', 'Lymphocytes', 'CBC', 'EDTA blood', '%', 20, 40, null],
  ['CBC-EOSP', 'Eosinophils', 'CBC', 'EDTA blood', '%', 0, 5, null],
  ['CBC-MONOP', 'Monocytes', 'CBC', 'EDTA blood', '%', 2, 10, null],
  ['CBC-BASOP', 'Basophils', 'CBC', 'EDTA blood', '%', 0, 2, null],
  ['CBC-ANEUT', 'Absolute neutrophil count', 'CBC', 'EDTA blood', '10⁹/L', 1.8, 6.3, null],
  ['CBC-ALYMP', 'Absolute lymphocyte count', 'CBC', 'EDTA blood', '10⁹/L', 1.1, 3.2, null],
  ['CBC-AEOS', 'Absolute eosinophil count', 'CBC', 'EDTA blood', '10⁹/L', 0.02, 0.52, null],
  ['CBC-AMONO', 'Absolute monocyte count', 'CBC', 'EDTA blood', '10⁹/L', 0.1, 0.6, null],
  ['CBC-ABASO', 'Absolute basophil count', 'CBC', 'EDTA blood', '10⁹/L', 0, 0.06, null],
  ['CBC-PLT', 'Platelet count', 'CBC', 'EDTA blood', 'x1000 cells/cumm', 150, 450, null],
  ['CBC-PCT', 'Plateletcrit (PCT)', 'CBC', 'EDTA blood', '%', 0.108, 0.282, null],
  ['CBC-MPV', 'MPV', 'CBC', 'EDTA blood', 'fL', 6.5, 12, null],
  ['CBC-PDW', 'Platelet distribution width (PDW-CV)', 'CBC', 'EDTA blood', '%', 9, 17, null],

  // ------------------------------------------------------- Urine routine
  ['UR-COL', 'Colour', 'URINE', 'Urine', null, null, null, 'Light yellow to dark yellow'],
  ['UR-SG', 'Specific gravity', 'URINE', 'Urine', null, 1.001, 1.035, null],
  ['UR-PH', 'pH', 'URINE', 'Urine', null, 5.0, 8.0, null],
  ['UR-TURB', 'Turbidity', 'URINE', 'Urine', 'NTU', null, null, 'Clear and transparent'],
  ['UR-PROT', 'Protein', 'URINE', 'Urine', 'g/L', null, null, 'Negative'],
  ['UR-GLU', 'Glucose', 'URINE', 'Urine', 'mmol/L', null, null, 'Negative'],
  ['UR-KET', 'Ketone bodies', 'URINE', 'Urine', 'mmol/L', null, null, 'Negative'],
  ['UR-BIL', 'Bilirubin', 'URINE', 'Urine', 'µmol/L', null, null, 'Negative'],
  ['UR-URO', 'Urobilinogen', 'URINE', 'Urine', 'µmol/L', null, null, 'Normal'],
  ['UR-BLD', 'Blood', 'URINE', 'Urine', 'cells/µL', null, null, 'Negative'],
  ['UR-LEU', 'Leucocyte esterase', 'URINE', 'Urine', 'cells/µL', null, null, 'Negative'],
  ['UR-NIT', 'Nitrite', 'URINE', 'Urine', null, null, null, 'Negative'],
  ['UR-PUS', 'Pus cells', 'URINE', 'Urine', '/HPF', 0, 5, null],
  ['UR-EPI', 'Epithelial cells', 'URINE', 'Urine', '/HPF', 0, 5, null],
  ['UR-RBC', 'RBC', 'URINE', 'Urine', '/HPF', 0, 3, null],
  ['UR-HYAL', 'Hyaline casts', 'URINE', 'Urine', '/HPF', 0, 0, null],
  ['UR-GRAN', 'Granular casts', 'URINE', 'Urine', '/HPF', 0, 0, null],
  ['UR-COXM', 'Calcium oxalate monohydrate crystals', 'URINE', 'Urine', '/HPF', 0, 5, null],
  ['UR-COXD', 'Calcium oxalate dihydrate crystals', 'URINE', 'Urine', '/HPF', 0, 5, null],
  ['UR-AMOR', 'Amorphous crystals', 'URINE', 'Urine', '/HPF', 0, 5, null],
  ['UR-URIC', 'Uric acid crystals', 'URINE', 'Urine', '/HPF', 0, 5, null],
  ['UR-BACT', 'Bacteria', 'URINE', 'Urine', '/HPF', 0, 61, null],
  ['UR-YEAST', 'Yeast cells', 'URINE', 'Urine', '/HPF', 0, 0, null],
  ['UR-SPERM', 'Spermatozoa', 'URINE', 'Urine', '/HPF', 0, 0, null],
  ['UR-MUCUS', 'Mucus strands', 'URINE', 'Urine', '/HPF', 0, 8, null],
];


/*
 * Radiology: the views a department actually shoots, and the studies it
 * scans, rather than the handful a demo needs.
 *
 * Filed the way a request is written — by region, then by view — because that
 * is how a doctor asks for one: "chest, PA and lateral", "left ankle", "PNS".
 * A single "X-ray, per part" cannot carry that, and a radiographer who has to
 * guess which view was meant will shoot the wrong one.
 *
 * Nothing is priced, and nothing here says the clinic does it. A department
 * without fluoroscopy prices no contrast study and switches it off under
 * Services & Rates; what stays priced is what the clinic offers.
 *
 * Columns: code, name, bill group, category, report text.
 */
const IMAGING = [
  // ------------------------------------------------------ chest and thorax
  ['XR-CHEST', 'X-Ray Chest PA', 'X-ray', 'radiology'],
  ['XR-CHEST-AP', 'X-Ray Chest AP (portable)', 'X-ray', 'radiology'],
  ['XR-CHEST-LAT', 'X-Ray Chest lateral', 'X-ray', 'radiology'],
  ['XR-CHEST-BOTH', 'X-Ray Chest PA & lateral', 'X-ray', 'radiology'],
  ['XR-RIBS', 'X-Ray Ribs (one side)', 'X-ray', 'radiology'],
  ['XR-STERN', 'X-Ray Sternum', 'X-ray', 'radiology'],
  ['XR-NECK', 'X-Ray Soft tissue neck', 'X-ray', 'radiology'],

  // ---------------------------------------------------------------- abdomen
  ['XR-ABD', 'X-Ray Abdomen erect', 'X-ray', 'radiology'],
  ['XR-ABD-SUP', 'X-Ray Abdomen supine', 'X-ray', 'radiology'],
  ['XR-ABD-BOTH', 'X-Ray Abdomen erect & supine', 'X-ray', 'radiology'],
  ['XR-KUB', 'X-Ray KUB (plain)', 'X-ray', 'radiology'],

  // ------------------------------------------------------------------ spine
  ['XR-CSPINE', 'X-Ray Cervical Spine', 'X-ray', 'radiology'],
  ['XR-CSPINE-OBL', 'X-Ray Cervical Spine — oblique views', 'X-ray', 'radiology'],
  ['XR-CSPINE-FLEX', 'X-Ray Cervical Spine — flexion & extension', 'X-ray', 'radiology'],
  ['XR-DSPINE', 'X-Ray Dorsal (thoracic) Spine AP/Lateral', 'X-ray', 'radiology'],
  ['XR-SPINE', 'X-Ray Lumbar Spine AP/Lateral', 'X-ray', 'radiology'],
  ['XR-LSPINE-FLEX', 'X-Ray Lumbosacral Spine — flexion & extension', 'X-ray', 'radiology'],
  ['XR-SACRUM', 'X-Ray Sacrum & coccyx', 'X-ray', 'radiology'],
  ['XR-SCOLI', 'X-Ray Whole spine (scoliosis series)', 'X-ray', 'radiology'],

  // ------------------------------------------------------------- upper limb
  ['XR-SHOUL', 'X-Ray Shoulder', 'X-ray', 'radiology'],
  ['XR-CLAV', 'X-Ray Clavicle', 'X-ray', 'radiology'],
  ['XR-SCAP', 'X-Ray Scapula', 'X-ray', 'radiology'],
  ['XR-HUM', 'X-Ray Humerus AP/Lateral', 'X-ray', 'radiology'],
  ['XR-ELBOW', 'X-Ray Elbow AP/Lateral', 'X-ray', 'radiology'],
  ['XR-FOREARM', 'X-Ray Forearm AP/Lateral', 'X-ray', 'radiology'],
  ['XR-WRIST', 'X-Ray Wrist AP/Lateral', 'X-ray', 'radiology'],
  ['XR-HAND', 'X-Ray Hand / fingers', 'X-ray', 'radiology'],

  // ------------------------------------------------------------- lower limb
  ['XR-PELV', 'X-Ray Pelvis', 'X-ray', 'radiology'],
  ['XR-HIP', 'X-Ray Hip AP/Lateral (one side)', 'X-ray', 'radiology'],
  ['XR-HIPS', 'X-Ray Both hips AP', 'X-ray', 'radiology'],
  ['XR-FEMUR', 'X-Ray Femur AP/Lateral', 'X-ray', 'radiology'],
  ['XR-KNEE', 'X-Ray Knee AP/Lateral', 'X-ray', 'radiology'],
  ['XR-PATELLA', 'X-Ray Knee — skyline (patella)', 'X-ray', 'radiology'],
  ['XR-LEG', 'X-Ray Leg — tibia & fibula', 'X-ray', 'radiology'],
  ['XR-ANKLE', 'X-Ray Ankle AP/Lateral', 'X-ray', 'radiology'],
  ['XR-FOOT', 'X-Ray Foot AP/Oblique', 'X-ray', 'radiology'],
  ['XR-CALC', 'X-Ray Calcaneum', 'X-ray', 'radiology'],
  ['XR-LIMB', 'X-Ray Limb (per part)', 'X-ray', 'radiology'],

  // ---------------------------------------------------------- head and face
  ['XR-SKULL', 'X-Ray Skull', 'X-ray', 'radiology'],
  ['XR-PNS', 'X-Ray Paranasal sinuses (Water’s view)', 'X-ray', 'radiology'],
  ['XR-NASAL', 'X-Ray Nasal bone', 'X-ray', 'radiology'],
  ['XR-MAND', 'X-Ray Mandible', 'X-ray', 'radiology'],
  ['XR-TMJ', 'X-Ray Temporomandibular joints', 'X-ray', 'radiology'],
  ['XR-MASTOID', 'X-Ray Mastoids', 'X-ray', 'radiology'],
  ['XR-ORBIT', 'X-Ray Orbit — foreign body', 'X-ray', 'radiology'],
  ['XR-DENT', 'Dental X-Ray (IOPA)', 'X-ray', 'radiology'],
  ['XR-OPG', 'Orthopantomogram (OPG)', 'X-ray', 'radiology'],

  /*
   * Contrast studies, last because they are the rarest. They need fluoroscopy
   * and a radiologist at the table, so a clinic without either leaves them
   * unpriced and switches them off.
   */
  ['XR-BASWA', 'Barium swallow', 'X-ray', 'radiology'],
  ['XR-BAMEAL', 'Barium meal', 'X-ray', 'radiology'],
  ['XR-BAMFT', 'Barium meal follow-through', 'X-ray', 'radiology'],
  ['XR-BAENEMA', 'Barium enema', 'X-ray', 'radiology'],
  ['XR-IVP', 'Intravenous pyelogram (IVP)', 'X-ray', 'radiology'],
  ['XR-MCU', 'Micturating cystourethrogram (MCU)', 'X-ray', 'radiology'],
  ['XR-RGU', 'Retrograde urethrogram (RGU)', 'X-ray', 'radiology'],
  ['XR-HSG', 'Hysterosalpingogram (HSG)', 'X-ray', 'radiology'],
  ['XR-FISTULO', 'Fistulogram', 'X-ray', 'radiology'],
  ['XR-SIALO', 'Sialogram', 'X-ray', 'radiology'],

  // ------------------------------------------------- ultrasound — abdominal
  ['USG-ABD', 'Ultrasound — Abdomen & Pelvis', 'Ultrasound & Doppler', 'radiology'],
  ['USG-ABDW', 'Ultrasound — Whole abdomen', 'Ultrasound & Doppler', 'radiology'],
  ['USG-UAP', 'Ultrasound — Upper abdomen', 'Ultrasound & Doppler', 'radiology'],
  ['USG-KUB', 'Ultrasound — KUB', 'Ultrasound & Doppler', 'radiology'],

  // ------------------------------------------- ultrasound — pelvic and obstetric
  ['USG-PELVF', 'Ultrasound — Pelvis (female)', 'Ultrasound & Doppler', 'radiology'],
  ['USG-TVS', 'Ultrasound — Transvaginal (TVS)', 'Ultrasound & Doppler', 'radiology'],
  ['USG-TRUS', 'Ultrasound — Transrectal prostate (TRUS)', 'Ultrasound & Doppler', 'radiology'],
  ['USG-OBS', 'Ultrasound — Obstetric', 'Ultrasound & Doppler', 'radiology'],
  ['USG-NT', 'Ultrasound — NT / NB scan (11–13 weeks)', 'Ultrasound & Doppler', 'radiology'],
  ['USG-ANOM', 'Ultrasound — Anomaly scan (18–22 weeks)', 'Ultrasound & Doppler', 'radiology'],
  ['USG-GROWTH', 'Ultrasound — Growth scan with Doppler', 'Ultrasound & Doppler', 'radiology'],
  ['USG-FOLLI', 'Ultrasound — Follicular study (per scan)', 'Ultrasound & Doppler', 'radiology'],

  // ------------------------------------------------ ultrasound — small parts
  ['USG-THY', 'Ultrasound — Thyroid / Neck', 'Ultrasound & Doppler', 'radiology'],
  ['USG-BRE', 'Ultrasound — Breast', 'Ultrasound & Doppler', 'radiology'],
  ['USG-SCR', 'Ultrasound — Scrotum', 'Ultrasound & Doppler', 'radiology'],
  ['USG-SOFT', 'Ultrasound — Soft tissue', 'Ultrasound & Doppler', 'radiology'],
  ['USG-LOCAL', 'Ultrasound — Local part / swelling', 'Ultrasound & Doppler', 'radiology'],
  ['USG-MSK', 'Ultrasound — Musculoskeletal joint', 'Ultrasound & Doppler', 'radiology'],
  ['USG-CHEST', 'Ultrasound — Chest / pleural', 'Ultrasound & Doppler', 'radiology'],
  ['USG-NEO', 'Ultrasound — Neonatal cranium', 'Ultrasound & Doppler', 'radiology'],
  ['USG-INFHIP', 'Ultrasound — Infant hip', 'Ultrasound & Doppler', 'radiology'],
  ['USG-GUIDE', 'Ultrasound-guided aspiration / biopsy', 'Ultrasound & Doppler', 'radiology'],

  // ----------------------------------------------------------------- Doppler
  ['USG-DOPCAR', 'Doppler — Carotid & vertebral', 'Ultrasound & Doppler', 'radiology'],
  ['USG-DOP', 'Doppler — Peripheral vascular', 'Ultrasound & Doppler', 'radiology'],
  ['USG-DOPART', 'Doppler — Arterial (one limb)', 'Ultrasound & Doppler', 'radiology'],
  ['USG-DOPVEN', 'Doppler — Venous (one limb)', 'Ultrasound & Doppler', 'radiology'],
  ['USG-DOPREN', 'Doppler — Renal', 'Ultrasound & Doppler', 'radiology'],
  ['USG-DOPSCR', 'Doppler — Scrotal', 'Ultrasound & Doppler', 'radiology'],
  ['USG-DOPO', 'Doppler — Obstetric', 'Ultrasound & Doppler', 'radiology'],
];

module.exports = { PANELS, SINGLES, COMPONENTS, IMAGING };
