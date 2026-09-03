'use strict';
/*
 * The clinic's tariff — SAMIHA rate list, September 2026.
 *
 * One row per item in the catalogue, all 261 of them, as
 *
 *     [code, what it used to be, what it is now]
 *
 * The old rate is not history for its own sake: it is what makes this safe to
 * re-run. Applying the list is a three-way merge — a rate is moved on only if
 * it is still sitting at the old figure, meaning nobody has touched it since.
 * A rate an administrator has since set by hand is left exactly where they put
 * it, and reported as kept rather than silently overwritten.
 *
 * Where the figures came from, per the list's own Basis column:
 *   OWNER   — set by the clinic's owner outright.
 *   AARTHI  — benchmarked against Aarthi Scans & Labs, Tiruvallur, MRP.
 *   SINGLE  — a panel analyte priced for ordering on its own.
 *   DERIVED — computed from a panel or from the item it belongs with.
 *   FAIR    — priced to sit fairly against the rest of the list.
 *
 * 156 of these had no rate at all before: the catalogue was loaded with the
 * tests the clinic runs and left deliberately unpriced. This is the list that
 * prices them.
 */

const TARIFF = [
  // ---- Consultation (7 items, 3200 -> 1200)
  ['CONS-NEW',    500,   150],  // Consultation - new patient
  ['CONS-FU',     300,   100],  // Consultation - follow-up
  ['CONS-REV',      0,    50],  // Review within 7 days
  ['CONS-SPEC',   700,   250],  // Specialist consultation
  ['CONS-EMG',    800,   300],  // Emergency consultation
  ['CONS-2OP',    600,   250],  // Second opinion
  ['CONS-TELE',   300,   100],  // Teleconsultation

  // ---- Health packages (3 items, 1500 -> 1197)
  ['PKG-MAN',     500,   299],  // Common Man Package - Basic Health Screening
  ['PKG-WOMAN',   500,   349],  // Common Woman Package - Basic Health Screening
  ['PKG-DIAB',    500,   549],  // Diabetic Package - Diabetes Health Check

  // ---- Procedures & treatment (24 items, 20400 -> 15010)
  ['PROC-BP',        50,    30],  // Blood pressure & vitals check
  ['PROC-INJ',      100,    60],  // Injection administration
  ['PROC-IMMUN',    150,   100],  // Immunisation - administration
  ['PROC-IVCAN',    200,   150],  // IV cannulation
  ['PROC-IVFL',     350,   250],  // IV fluid administration (per pint)
  ['PROC-NEB',      200,   120],  // Nebulisation
  ['PROC-OXY',      250,   150],  // Oxygen - per hour
  ['PROC-DRESS',    250,   150],  // Wound dressing - small
  ['PROC-DRESSL',   450,   300],  // Wound dressing - large
  ['PROC-BURN',     600,   400],  // Burn dressing
  ['PROC-SUT',      900,   600],  // Suturing - minor
  ['PROC-SUTM',    1800,  1500],  // Suturing - major
  ['PROC-SUTR',     200,   150],  // Suture removal
  ['PROC-ABS',     1200,   800],  // Abscess incision & drainage
  ['PROC-FB',       800,   500],  // Foreign body removal - minor
  ['PROC-EAR',      400,   250],  // Ear syringing / wax removal
  ['PROC-CATH',     700,   450],  // Urinary catheterisation
  ['PROC-IUCD',     900,   700],  // IUCD insertion / removal
  ['PROC-CIRC',    5000,  4000],  // Circumcision
  ['PROC-BIOP',    2500,  2000],  // Biopsy - minor
  ['PROC-TRANSF',  1500,  1000],  // Blood transfusion - administration
  ['PROC-POP',     1200,   900],  // Plaster / POP application
  ['PROC-POPR',     300,   200],  // Plaster removal
  ['PROC-PHYSIO',   400,   250],  // Physiotherapy - per session

  // ---- Blood tests (93 items, 14180 -> 16510)
  ['CBC',          350,   110],  // Complete Blood Count
  ['ESR',          150,    35],  // ESR
  ['HB',           120,    60],  // Haemoglobin
  ['PLT',          200,    80],  // Platelet count
  ['BLGRP',        150,    90],  // Blood group & Rh typing
  ['FBS',          120,    60],  // Fasting Blood Sugar
  ['PPBS',         120,    60],  // Post-Prandial Blood Sugar
  ['RBS',          100,    50],  // Random Blood Sugar
  ['HBA1C',        650,   400],  // Glycated Haemoglobin (HbA1c)
  ['LIPID',        700,   145],  // Lipid Profile
  ['LFT',          850,   200],  // Liver Function Test
  ['LFT-ADV',        0,   350],  // Liver Function Test (Advanced)
  ['RFT',          800,   135],  // Renal Function Test
  ['RFT-GFR',        0,   250],  // Renal Function Test with eGFR
  ['UREA',         200,    55],  // Blood urea
  ['CREAT',        220,   110],  // Serum creatinine
  ['URIC',         250,    90],  // Serum uric acid
  ['CALC',         250,    90],  // Serum calcium
  ['ELEC',         450,   300],  // Serum electrolytes
  ['NA',             0,   120],  // Sodium, serum
  ['CL',             0,   120],  // Chloride, serum
  ['TSH',          450,    90],  // Thyroid Stimulating Hormone
  ['THYP',         900,   135],  // Thyroid profile (T3 T4 TSH)
  ['TESTO',          0,   550],  // Testosterone, total
  ['VITD',        1600,   720],  // Vitamin D (25-OH)
  ['VITB12',      1200,   675],  // Vitamin B12
  ['IRONPROF',       0,   650],  // Iron Deficiency Profile
  ['CRP',          550,   225],  // C-Reactive Protein
  ['PT',           450,   300],  // Prothrombin time / INR
  ['WIDAL',        300,   180],  // Widal Test
  ['MP',           300,   200],  // Malaria parasite / antigen
  ['DENGUE',       900,   700],  // Dengue NS1 / IgM / IgG
  ['HIV',          500,   300],  // HIV I & II (screening)
  ['HBSAG',        400,   250],  // HBsAg (screening)
  ['HCV',          600,   400],  // Anti-HCV (screening)
  ['PREG',         350,   450],  // Pregnancy test (beta hCG)
  ['AGRATIO',        0,   120],  // A/G ratio (albumin / globulin)
  ['CBC-ABASO',      0,   110],  // Absolute basophil count
  ['CBC-AEOS',       0,    90],  // Absolute eosinophil count
  ['CBC-ALYMP',      0,   110],  // Absolute lymphocyte count
  ['CBC-AMONO',      0,   110],  // Absolute monocyte count
  ['CBC-ANEUT',      0,   110],  // Absolute neutrophil count
  ['ALB',            0,    90],  // Albumin
  ['ALP',            0,   120],  // Alkaline phosphatase (ALP)
  ['CBC-BASOP',      0,    80],  // Basophils
  ['BIL-D',          0,   100],  // Bilirubin, direct (conjugated)
  ['BIL-I',          0,   120],  // Bilirubin, indirect (unconjugated)
  ['BIL-T',          0,   100],  // Bilirubin, total
  ['BUN',            0,    80],  // Blood urea nitrogen (BUN)
  ['BUNCR',          0,   120],  // BUN / creatinine ratio
  ['LIP-CHDL',       0,   145],  // Cholesterol / HDL ratio
  ['LIP-CHOL',       0,    90],  // Cholesterol, total
  ['RFT-CREAT',      0,   110],  // Creatinine, serum
  ['EGFR',           0,   250],  // eGFR (estimated glomerular filtration rate)
  ['CBC-EOSP',       0,    80],  // Eosinophils
  ['HBA1C-EAG',      0,   400],  // Estimated average glucose (eAG)
  ['FERRITIN',       0,   550],  // Ferritin
  ['GGT',            0,   150],  // Gamma GT (GGT)
  ['GLOB',           0,    90],  // Globulin
  ['CBC-HB',         0,    60],  // Haemoglobin
  ['CBC-HCT',        0,    70],  // HCT / PCV
  ['LIP-HDL',        0,   100],  // HDL cholesterol
  ['IRON',           0,   250],  // Iron, total
  ['LIP-LHDL',       0,   145],  // LDL / HDL ratio
  ['LIP-LDL',        0,   100],  // LDL cholesterol
  ['CBC-LYMPP',      0,    80],  // Lymphocytes
  ['CBC-MCH',        0,   110],  // MCH
  ['CBC-MCHC',       0,   110],  // MCHC
  ['CBC-MCV',        0,   110],  // MCV
  ['CBC-MONOP',      0,    80],  // Monocytes
  ['CBC-MPV',        0,   110],  // MPV
  ['CBC-NEUTP',      0,    80],  // Neutrophils
  ['LIP-NONHDL',     0,   145],  // Non-HDL cholesterol
  ['CBC-PLT',        0,    80],  // Platelet count
  ['CBC-PDW',        0,   110],  // Platelet distribution width (PDW-CV)
  ['CBC-PCT',        0,   110],  // Plateletcrit (PCT)
  ['PROT-T',         0,    90],  // Protein, total
  ['CBC-RBC',        0,    70],  // RBC count
  ['CBC-RDWCV',      0,   110],  // RDW-CV
  ['CBC-RDWSD',      0,   110],  // RDW-SD
  ['SGOT',           0,    90],  // SGOT - aspartate aminotransferase (AST)
  ['SGPT',           0,    90],  // SGPT - alanine aminotransferase (ALT)
  ['T3',             0,   150],  // T3 (triiodothyronine), total
  ['T4',             0,   150],  // T4 (thyroxine), total
  ['TIBC',           0,   300],  // Total iron binding capacity (TIBC)
  ['CBC-TLC',        0,    70],  // Total leucocyte count (TLC)
  ['TRFSAT',         0,   650],  // Transferrin saturation
  ['LIP-TG',         0,    90],  // Triglycerides
  ['TFT-TSH',        0,    90],  // TSH (thyroid stimulating hormone)
  ['UIBC',           0,   250],  // Unsaturated iron binding capacity (UIBC)
  ['RFT-UREA',       0,    55],  // Urea
  ['RFT-URIC',       0,    90],  // Uric acid
  ['LIP-VLDL',       0,   145],  // VLDL cholesterol

  // ---- Urine & stool (31 items, 1900 -> 3310)
  ['URINE',      200,    90],  // Urine Routine
  ['UPREG',      150,   100],  // Urine pregnancy test
  ['URCULT',     700,   450],  // Urine culture & sensitivity
  ['STOOL',      250,   120],  // Stool routine
  ['STOCC',      300,   150],  // Stool occult blood
  ['SPUTUM',     300,   150],  // Sputum AFB
  ['UR-AMOR',      0,    90],  // Amorphous crystals
  ['UR-BACT',      0,    90],  // Bacteria
  ['UR-BIL',       0,    90],  // Bilirubin
  ['UR-BLD',       0,    90],  // Blood
  ['UR-COXD',      0,    90],  // Calcium oxalate dihydrate crystals
  ['UR-COXM',      0,    90],  // Calcium oxalate monohydrate crystals
  ['UR-COL',       0,    90],  // Colour
  ['UR-EPI',       0,    90],  // Epithelial cells
  ['UR-GLU',       0,    90],  // Glucose
  ['UR-GRAN',      0,    90],  // Granular casts
  ['UR-HYAL',      0,    90],  // Hyaline casts
  ['UR-KET',       0,    90],  // Ketone bodies
  ['UR-LEU',       0,    90],  // Leucocyte esterase
  ['UR-MUCUS',     0,    90],  // Mucus strands
  ['UR-NIT',       0,    90],  // Nitrite
  ['UR-PH',        0,    90],  // pH
  ['UR-PROT',      0,    90],  // Protein
  ['UR-PUS',       0,    90],  // Pus cells
  ['UR-RBC',       0,    90],  // RBC
  ['UR-SG',        0,    90],  // Specific gravity
  ['UR-SPERM',     0,    90],  // Spermatozoa
  ['UR-TURB',      0,    90],  // Turbidity
  ['UR-URIC',      0,    90],  // Uric acid crystals
  ['UR-URO',       0,    90],  // Urobilinogen
  ['UR-YEAST',     0,    90],  // Yeast cells

  // ---- X-ray (57 items, 4750 -> 35500)
  ['XR-CHEST',         400,   225],  // X-Ray Chest PA
  ['XR-CHEST-AP',        0,   250],  // X-Ray Chest AP (portable)
  ['XR-CHEST-LAT',       0,   225],  // X-Ray Chest lateral
  ['XR-CHEST-BOTH',      0,   400],  // X-Ray Chest PA & lateral
  ['XR-ABD',           450,   250],  // X-Ray Abdomen erect
  ['XR-ABD-SUP',         0,   250],  // X-Ray Abdomen supine
  ['XR-ABD-BOTH',        0,   400],  // X-Ray Abdomen erect & supine
  ['XR-KUB',             0,   250],  // X-Ray KUB (plain)
  ['XR-PELV',          550,   300],  // X-Ray Pelvis
  ['XR-HIP',             0,   350],  // X-Ray Hip AP/Lateral (one side)
  ['XR-HIPS',            0,   400],  // X-Ray Both hips AP
  ['XR-SKULL',         500,   300],  // X-Ray Skull
  ['XR-MAND',            0,   250],  // X-Ray Mandible
  ['XR-TMJ',             0,   300],  // X-Ray Temporomandibular joints
  ['XR-MASTOID',         0,   300],  // X-Ray Mastoids
  ['XR-NASAL',           0,   250],  // X-Ray Nasal bone
  ['XR-ORBIT',           0,   300],  // X-Ray Orbit - foreign body
  ['XR-PNS',             0,   250],  // X-Ray Paranasal sinuses (Water's view)
  ['XR-NECK',            0,   250],  // X-Ray Soft tissue neck
  ['XR-CSPINE',        550,   350],  // X-Ray Cervical Spine
  ['XR-CSPINE-FLEX',     0,   450],  // X-Ray Cervical Spine - flexion & extension
  ['XR-CSPINE-OBL',      0,   450],  // X-Ray Cervical Spine - oblique views
  ['XR-DSPINE',          0,   350],  // X-Ray Dorsal (thoracic) Spine AP/Lateral
  ['XR-SPINE',         600,   350],  // X-Ray Lumbar Spine AP/Lateral
  ['XR-LSPINE-FLEX',     0,   450],  // X-Ray Lumbosacral Spine - flexion & extension
  ['XR-SCOLI',           0,   700],  // X-Ray Whole spine (scoliosis series)
  ['XR-SACRUM',          0,   300],  // X-Ray Sacrum & coccyx
  ['XR-SHOUL',         500,   250],  // X-Ray Shoulder
  ['XR-CLAV',            0,   250],  // X-Ray Clavicle
  ['XR-SCAP',            0,   250],  // X-Ray Scapula
  ['XR-STERN',           0,   300],  // X-Ray Sternum
  ['XR-RIBS',            0,   250],  // X-Ray Ribs (one side)
  ['XR-HUM',             0,   300],  // X-Ray Humerus AP/Lateral
  ['XR-ELBOW',           0,   300],  // X-Ray Elbow AP/Lateral
  ['XR-FOREARM',         0,   300],  // X-Ray Forearm AP/Lateral
  ['XR-WRIST',           0,   300],  // X-Ray Wrist AP/Lateral
  ['XR-HAND',            0,   250],  // X-Ray Hand / fingers
  ['XR-FEMUR',           0,   350],  // X-Ray Femur AP/Lateral
  ['XR-KNEE',          500,   300],  // X-Ray Knee AP/Lateral
  ['XR-PATELLA',         0,   300],  // X-Ray Knee - skyline (patella)
  ['XR-LEG',             0,   300],  // X-Ray Leg - tibia & fibula
  ['XR-ANKLE',           0,   300],  // X-Ray Ankle AP/Lateral
  ['XR-FOOT',            0,   250],  // X-Ray Foot AP/Oblique
  ['XR-CALC',            0,   250],  // X-Ray Calcaneum
  ['XR-LIMB',          450,   300],  // X-Ray Limb (per part)
  ['XR-DENT',          250,   200],  // Dental X-Ray (IOPA)
  ['XR-OPG',             0,   600],  // Orthopantomogram (OPG)
  ['XR-BASWA',           0,  1500],  // Barium swallow
  ['XR-BAMEAL',          0,  1800],  // Barium meal
  ['XR-BAMFT',           0,  2200],  // Barium meal follow-through
  ['XR-BAENEMA',         0,  2200],  // Barium enema
  ['XR-IVP',             0,  2500],  // Intravenous pyelogram (IVP)
  ['XR-MCU',             0,  2200],  // Micturating cystourethrogram (MCU)
  ['XR-RGU',             0,  2200],  // Retrograde urethrogram (RGU)
  ['XR-HSG',             0,  2500],  // Hysterosalpingogram (HSG)
  ['XR-FISTULO',         0,  1800],  // Fistulogram
  ['XR-SIALO',           0,  1800],  // Sialogram

  // ---- Ultrasound & Doppler (29 items, 12800 -> 34450)
  ['USG-ABD',     1200,  1050],  // Ultrasound - Abdomen & Pelvis
  ['USG-ABDW',       0,  1050],  // Ultrasound - Whole abdomen
  ['USG-UAP',        0,   850],  // Ultrasound - Upper abdomen
  ['USG-KUB',     1100,   850],  // Ultrasound - KUB
  ['USG-PELVF',      0,   850],  // Ultrasound - Pelvis (female)
  ['USG-TVS',        0,  1050],  // Ultrasound - Transvaginal (TVS)
  ['USG-TRUS',       0,  1200],  // Ultrasound - Transrectal prostate (TRUS)
  ['USG-OBS',     1400,   900],  // Ultrasound - Obstetric
  ['USG-NT',         0,  1600],  // Ultrasound - NT / NB scan (11-13 weeks)
  ['USG-ANOM',       0,  1800],  // Ultrasound - Anomaly scan (18-22 weeks)
  ['USG-GROWTH',     0,  1600],  // Ultrasound - Growth scan with Doppler
  ['USG-FOLLI',      0,   500],  // Ultrasound - Follicular study (per scan)
  ['USG-BRE',     1200,   900],  // Ultrasound - Breast
  ['USG-THY',     1200,   850],  // Ultrasound - Thyroid / Neck
  ['USG-SCR',     1100,   850],  // Ultrasound - Scrotum
  ['USG-SOFT',    1000,   750],  // Ultrasound - Soft tissue
  ['USG-LOCAL',      0,   750],  // Ultrasound - Local part / swelling
  ['USG-MSK',        0,   900],  // Ultrasound - Musculoskeletal joint
  ['USG-CHEST',      0,   850],  // Ultrasound - Chest / pleural
  ['USG-NEO',        0,   900],  // Ultrasound - Neonatal cranium
  ['USG-INFHIP',     0,   900],  // Ultrasound - Infant hip
  ['USG-GUIDE',      0,  1800],  // Ultrasound-guided aspiration / biopsy
  ['USG-DOPART',     0,  1600],  // Doppler - Arterial (one limb)
  ['USG-DOPVEN',     0,  1600],  // Doppler - Venous (one limb)
  ['USG-DOP',     2400,  2100],  // Doppler - Peripheral vascular
  ['USG-DOPCAR',     0,  1800],  // Doppler - Carotid & vertebral
  ['USG-DOPO',    2200,  1600],  // Doppler - Obstetric
  ['USG-DOPREN',     0,  1800],  // Doppler - Renal
  ['USG-DOPSCR',     0,  1200],  // Doppler - Scrotal

  // ---- ECG & heart (4 items, 8500 -> 5150)
  ['ECG12',    300,   150],  // ECG - 12 lead
  ['ECHO',    2200,  1250],  // 2D Echocardiogram
  ['TMT',     2500,  1250],  // Treadmill test (TMT)
  ['HOLTER',  3500,  2500],  // Holter monitoring - 24 hour

  // ---- Nursing & ward (7 items, 5700 -> 4250)
  ['WARD-OBS',    200,   150],  // Observation - per hour
  ['WARD-DAY',    700,   500],  // Day-care bed - per day
  ['WARD-GEN',    700,   500],  // Ward - general, per day
  ['WARD-SEMI',  1200,   900],  // Ward - semi-private, per day
  ['WARD-PVT',   2000,  1500],  // Room - private, per day
  ['NURS-DAY',    400,   300],  // Nursing charges - per day
  ['NURS-RMO',    500,   400],  // RMO / duty doctor - per day

  // ---- Ambulance & other (6 items, 1880 -> 1305)
  ['REG-CARD',     50,    30],  // Registration / record card
  ['REG-DUP',     100,    50],  // Duplicate report or record
  ['CERT-MED',    200,   150],  // Medical certificate
  ['CERT-FIT',    300,   250],  // Fitness certificate
  ['AMB-LOCAL',  1200,   800],  // Ambulance - within town
  ['AMB-OUT',      30,    25],  // Ambulance - outstation, per km

];

/**
 * Move the catalogue on to this tariff.
 *
 * A rate is only changed where it still stands at the old figure — so a fresh
 * database picks the whole list up, an existing one picks up everything the
 * clinic has not touched, and a rate somebody set by hand is left alone and
 * counted as kept. Nothing here invents a row: a code the catalogue does not
 * carry is reported as missing rather than quietly inserted, because a tariff
 * line with no test behind it would sit on the rate card offering something
 * the clinic cannot do.
 *
 * Prices live in two tables — `services` for what the clinic does, `lab_tests`
 * for what it measures — so each code is tried against both.
 */
function apply(db, { revalue = true } = {}) {
  const find = db.prepare(
    `SELECT 'services' AS tbl, id, price FROM services WHERE code = ?
     UNION ALL
     SELECT 'lab_tests', id, price FROM lab_tests WHERE code = ?`
  );
  const setService = db.prepare('UPDATE services SET price = ? WHERE id = ?');
  const setTest = db.prepare('UPDATE lab_tests SET price = ? WHERE id = ?');

  const report = { updated: 0, already: 0, kept: [], missing: [] };
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

  db.transaction(() => {
    for (const [code, was, now] of TARIFF) {
      const rows = find.all(code, code);
      if (!rows.length) { report.missing.push(code); continue; }
      for (const row of rows) {
        if (near(row.price, now)) { report.already += 1; continue; }
        /*
         * `revalue` is the difference between publishing the list and living
         * with it. The first time, every rate still sitting at its old figure
         * moves on. Afterwards the list only fills in rows that have no rate
         * at all — a test added since — because by then the clinic is the
         * authority on its own prices, and an administrator who deliberately
         * types the old figure back in means it.
         */
        const may = revalue ? near(row.price, was) : !(row.price > 0);
        if (!may) { report.kept.push({ code, at: row.price, wanted: now }); continue; }
        (row.tbl === 'services' ? setService : setTest).run(now, row.id);
        report.updated += 1;
      }
    }
  })();
  return report;
}

module.exports = { TARIFF, apply };
