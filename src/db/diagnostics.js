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

module.exports = { PANELS, SINGLES, COMPONENTS };
