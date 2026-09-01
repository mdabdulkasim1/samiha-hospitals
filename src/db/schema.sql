-- =============================================================================
-- SAMIHA POLYCLINIC & DIAGNOSTICS — ERP schema
-- Covers the clinic visit workflow end to end:
--   enquiry -> appointment -> registration -> financial screening -> check-in
--   -> vitals -> consultation -> diagnostics -> pharmacy -> billing -> exit
-- plus in-patient (IPD) records and the WhatsApp booking channel.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- core / auth
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_code     TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  email          TEXT UNIQUE,
  phone          TEXT,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN
                   ('admin','reception','counselor','nurse','doctor','lab','pharmacy','cashier','ward')),
  department_id  INTEGER REFERENCES departments(id),
  active         INTEGER NOT NULL DEFAULT 1,
  last_login_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  code    TEXT NOT NULL UNIQUE,
  name    TEXT NOT NULL,
  -- 'specialist' departments take consultations and appear in the booking flow;
  -- 'diagnostic' departments are service counters (lab, pharmacy, imaging, day care).
  kind    TEXT NOT NULL DEFAULT 'specialist'
            CHECK (kind IN ('specialist','diagnostic')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS doctor_profiles (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  qualification  TEXT,
  specialization TEXT,
  reg_no         TEXT,
  consult_fee    REAL NOT NULL DEFAULT 0,
  follow_up_fee  REAL NOT NULL DEFAULT 0,
  slot_minutes   INTEGER NOT NULL DEFAULT 15,
  room_no        TEXT,
  signature_line TEXT
);

CREATE TABLE IF NOT EXISTS doctor_schedules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sunday
  start_time    TEXT NOT NULL,      -- 'HH:MM'
  end_time      TEXT NOT NULL,
  slot_minutes  INTEGER NOT NULL DEFAULT 15,
  max_tokens    INTEGER NOT NULL DEFAULT 40,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS doctor_leaves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_date TEXT NOT NULL,
  reason     TEXT,
  UNIQUE (doctor_id, leave_date)
);

-- ------------------------------------------------------------------- patients
CREATE TABLE IF NOT EXISTS patients (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  uhid                TEXT NOT NULL UNIQUE,
  title               TEXT,
  first_name          TEXT NOT NULL,
  last_name           TEXT,
  dob                 TEXT,
  age_years           INTEGER,
  gender              TEXT CHECK (gender IN ('male','female','other')),
  phone               TEXT,
  whatsapp            TEXT,
  email               TEXT,
  address             TEXT,
  city                TEXT,
  state               TEXT,
  pincode             TEXT,
  blood_group         TEXT,
  marital_status      TEXT,
  occupation          TEXT,
  emergency_name      TEXT,
  emergency_phone     TEXT,
  emergency_relation  TEXT,
  id_type             TEXT,
  id_number           TEXT,
  -- insurance / assistance
  is_uninsured        INTEGER NOT NULL DEFAULT 1,
  insurance_provider  TEXT,
  insurance_policy_no TEXT,
  insurance_valid_till TEXT,
  sliding_scale_band  TEXT,
  assistance_program_id INTEGER REFERENCES assistance_programs(id),
  -- clinical flags
  allergies           TEXT,
  chronic_conditions  TEXT,
  last_screening_date TEXT,
  -- preferred pharmacy (workflow step: "Update Patient Pharmacy Information")
  pharmacy_name       TEXT,
  pharmacy_phone      TEXT,
  pharmacy_address    TEXT,
  notes               TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  registered_at       TEXT NOT NULL DEFAULT (datetime('now')),
  created_by          INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
CREATE INDEX IF NOT EXISTS idx_patients_whatsapp ON patients(whatsapp);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(first_name, last_name);

CREATE TABLE IF NOT EXISTS patient_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN
                ('past_illness','surgery','family','social','allergy','immunisation','obstetric')),
  detail      TEXT NOT NULL,
  since       TEXT,
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_history_patient ON patient_history(patient_id);

-- ------------------------------------------------------------------ enquiries
CREATE TABLE IF NOT EXISTS enquiries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_no         TEXT NOT NULL UNIQUE,
  source         TEXT NOT NULL CHECK (source IN
                   ('whatsapp','walk_in','phone','web','referral','camp')),
  name           TEXT NOT NULL,
  phone          TEXT,
  patient_id     INTEGER REFERENCES patients(id),
  department_id  INTEGER REFERENCES departments(id),
  doctor_id      INTEGER REFERENCES users(id),
  subject        TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','contacted','converted','closed','lost')),
  assigned_to    INTEGER REFERENCES users(id),
  follow_up_at   TEXT,
  appointment_id INTEGER REFERENCES appointments(id),
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_enquiries_status ON enquiries(status);

-- --------------------------------------------------------------- appointments
CREATE TABLE IF NOT EXISTS appointments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appt_no        TEXT NOT NULL UNIQUE,
  patient_id     INTEGER REFERENCES patients(id),
  -- unregistered WhatsApp/phone bookings keep contact details until registration
  guest_name     TEXT,
  guest_phone    TEXT,
  doctor_id      INTEGER NOT NULL REFERENCES users(id),
  department_id  INTEGER REFERENCES departments(id),
  scheduled_at   TEXT NOT NULL,
  slot_minutes   INTEGER NOT NULL DEFAULT 15,
  token_no       INTEGER,
  visit_kind     TEXT NOT NULL DEFAULT 'new'
                   CHECK (visit_kind IN ('new','follow_up','screening','procedure','teleconsult')),
  source         TEXT NOT NULL DEFAULT 'reception'
                   CHECK (source IN ('whatsapp','reception','phone','web','walk_in','referral')),
  status         TEXT NOT NULL DEFAULT 'booked'
                   CHECK (status IN ('booked','confirmed','checked_in','in_consult','completed','cancelled','no_show')),
  reason         TEXT,
  reminder_sent  INTEGER NOT NULL DEFAULT 0,
  cancel_reason  TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_doctor_time ON appointments(doctor_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);

-- --------------------------------------------------------------------- visits
-- One OPD encounter. Drives the queue board and mirrors the workflow stages.
CREATE TABLE IF NOT EXISTS visits (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_no            TEXT NOT NULL UNIQUE,
  patient_id          INTEGER NOT NULL REFERENCES patients(id),
  appointment_id      INTEGER REFERENCES appointments(id),
  doctor_id           INTEGER REFERENCES users(id),
  department_id       INTEGER REFERENCES departments(id),
  visit_type          TEXT NOT NULL DEFAULT 'opd'
                        CHECK (visit_type IN ('opd','emergency','review','teleconsult')),
  status              TEXT NOT NULL DEFAULT 'waiting_room'
                        CHECK (status IN ('waiting_room','financial_screening','checked_in','vitals_done',
                                          'with_provider','labs_pending','pharmacy_pending','billing_pending',
                                          'checked_out','cancelled')),
  token_no            INTEGER,
  reason_for_visit    TEXT,
  is_new_patient      INTEGER NOT NULL DEFAULT 0,
  financial_changed   INTEGER NOT NULL DEFAULT 0,
  screening_due       INTEGER NOT NULL DEFAULT 0,
  arrived_at          TEXT NOT NULL DEFAULT (datetime('now')),
  checked_in_at       TEXT,
  checked_in_by       INTEGER REFERENCES users(id),
  vitals_at           TEXT,
  consult_start_at    TEXT,
  consult_end_at      TEXT,
  billing_at          TEXT,
  checked_out_at      TEXT,
  checked_out_by      INTEGER REFERENCES users(id),
  exit_pass_no        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id);

-- Immutable trail of every workflow stage a visit passed through.
CREATE TABLE IF NOT EXISTS visit_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id   INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  stage      TEXT NOT NULL,
  detail     TEXT,
  actor_id   INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visit_events_visit ON visit_events(visit_id);

-- --------------------------------------------------------------------- vitals
CREATE TABLE IF NOT EXISTS vitals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id      INTEGER REFERENCES visits(id) ON DELETE CASCADE,
  admission_id  INTEGER REFERENCES admissions(id) ON DELETE CASCADE,
  patient_id    INTEGER NOT NULL REFERENCES patients(id),
  height_cm     REAL,
  weight_kg     REAL,
  bmi           REAL,
  temp_c        REAL,
  pulse         INTEGER,
  resp_rate     INTEGER,
  bp_systolic   INTEGER,
  bp_diastolic  INTEGER,
  spo2          INTEGER,
  blood_sugar   REAL,
  pain_score    INTEGER,
  notes         TEXT,
  recorded_by   INTEGER REFERENCES users(id),
  recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vitals_patient ON vitals(patient_id);

-- -------------------------------------------------------------- consultations
CREATE TABLE IF NOT EXISTS consultations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id        INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  doctor_id       INTEGER NOT NULL REFERENCES users(id),
  chief_complaint TEXT,
  subjective      TEXT,   -- history of present illness
  objective       TEXT,   -- examination findings
  assessment      TEXT,
  plan            TEXT,
  advice          TEXT,
  screening_done  INTEGER NOT NULL DEFAULT 0,
  referred_to     TEXT,
  follow_up_days  INTEGER,
  follow_up_date  TEXT,
  signed_at       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_consult_patient ON consultations(patient_id);

CREATE TABLE IF NOT EXISTS consultation_diagnoses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_id INTEGER NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  icd_code        TEXT,
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'provisional'
                    CHECK (kind IN ('provisional','final','differential','comorbidity'))
);

CREATE TABLE IF NOT EXISTS icd_codes (
  code  TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  chapter TEXT
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_id INTEGER REFERENCES consultations(id) ON DELETE CASCADE,
  visit_id        INTEGER REFERENCES visits(id),
  admission_id    INTEGER REFERENCES admissions(id),
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  drug_id         INTEGER REFERENCES drugs(id),
  drug_name       TEXT NOT NULL,
  dose            TEXT,
  frequency       TEXT,
  route           TEXT DEFAULT 'oral',
  duration_days   INTEGER,
  quantity        REAL NOT NULL DEFAULT 0,
  instructions    TEXT,
  dispensed_qty   REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','partially_dispensed','dispensed','cancelled','external')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rx_visit ON prescriptions(visit_id);

-- ------------------------------------------- financial screening / assistance
CREATE TABLE IF NOT EXISTS assistance_programs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  coverage_pct REAL NOT NULL DEFAULT 0,
  max_fpl_pct  REAL,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sliding_scale_bands (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  band          TEXT NOT NULL UNIQUE,
  fpl_min       REAL NOT NULL,
  fpl_max       REAL NOT NULL,
  discount_pct  REAL NOT NULL,
  flat_consult_fee REAL NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1
);

-- Federal-poverty-line style income slabs used to compute FPL%.
CREATE TABLE IF NOT EXISTS poverty_guidelines (
  household_size INTEGER PRIMARY KEY,
  annual_income  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS financial_screenings (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  screening_no       TEXT NOT NULL UNIQUE,
  patient_id         INTEGER NOT NULL REFERENCES patients(id),
  visit_id           INTEGER REFERENCES visits(id),
  status             TEXT NOT NULL DEFAULT 'initiated'
                       CHECK (status IN ('initiated','awaiting_counselor','with_counselor',
                                         'docs_pending','completed','declined','deferred')),
  counselor_id       INTEGER REFERENCES users(id),
  uninsured          INTEGER NOT NULL DEFAULT 1,
  household_size     INTEGER,
  annual_income      REAL,
  fpl_pct            REAL,
  has_proof_of_income INTEGER NOT NULL DEFAULT 0,
  proof_type         TEXT,
  eligible_programs  TEXT,          -- JSON array of program codes
  sliding_scale_band TEXT,
  discount_pct       REAL NOT NULL DEFAULT 0,
  assistance_program_id INTEGER REFERENCES assistance_programs(id),
  patient_decision   TEXT CHECK (patient_decision IN ('continue','defer','decline')),
  notes              TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_screen_status ON financial_screenings(status);

-- ---------------------------------------------------------- diagnostics / lab
CREATE TABLE IF NOT EXISTS lab_tests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'lab'
                  CHECK (category IN ('lab','radiology','cardiology','procedure')),
  sample_type   TEXT,
  unit          TEXT,
  ref_low       REAL,
  ref_high      REAL,
  ref_text      TEXT,
  price         REAL NOT NULL DEFAULT 0,
  tat_hours     INTEGER NOT NULL DEFAULT 24,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS lab_orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no       TEXT NOT NULL UNIQUE,
  visit_id       INTEGER REFERENCES visits(id),
  admission_id   INTEGER REFERENCES admissions(id),
  patient_id     INTEGER NOT NULL REFERENCES patients(id),
  doctor_id      INTEGER REFERENCES users(id),
  priority       TEXT NOT NULL DEFAULT 'routine'
                   CHECK (priority IN ('routine','urgent','stat')),
  status         TEXT NOT NULL DEFAULT 'ordered'
                   CHECK (status IN ('ordered','sample_collected','in_process','result_entered','verified','reported','cancelled')),
  clinical_notes TEXT,
  ordered_at     TEXT NOT NULL DEFAULT (datetime('now')),
  reported_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_lab_orders_status ON lab_orders(status);

CREATE TABLE IF NOT EXISTS lab_order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES lab_orders(id) ON DELETE CASCADE,
  test_id       INTEGER REFERENCES lab_tests(id),
  test_name     TEXT NOT NULL,
  price         REAL NOT NULL DEFAULT 0,
  unit          TEXT,
  ref_range     TEXT,
  result_value  TEXT,
  result_notes  TEXT,
  abnormal_flag TEXT CHECK (abnormal_flag IN ('normal','low','high','critical')),
  status        TEXT NOT NULL DEFAULT 'ordered'
                  CHECK (status IN ('ordered','sample_collected','in_process','result_entered','verified','cancelled')),
  result_by     INTEGER REFERENCES users(id),
  result_at     TEXT,
  verified_by   INTEGER REFERENCES users(id),
  verified_at   TEXT
);

CREATE TABLE IF NOT EXISTS lab_samples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES lab_orders(id) ON DELETE CASCADE,
  barcode      TEXT NOT NULL UNIQUE,
  sample_type  TEXT,
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  collected_by INTEGER REFERENCES users(id)
);

-- ------------------------------------------------------------------- pharmacy
CREATE TABLE IF NOT EXISTS drugs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  generic_name   TEXT,
  form           TEXT,          -- tablet / syrup / injection ...
  strength       TEXT,
  manufacturer   TEXT,
  hsn            TEXT,
  tax_pct        REAL NOT NULL DEFAULT 12,
  mrp            REAL NOT NULL DEFAULT 0,
  purchase_price REAL NOT NULL DEFAULT 0,
  reorder_level  REAL NOT NULL DEFAULT 10,
  schedule_type  TEXT,          -- H, H1, OTC ...
  active         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_drugs_name ON drugs(name);

CREATE TABLE IF NOT EXISTS drug_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  drug_id        INTEGER NOT NULL REFERENCES drugs(id) ON DELETE CASCADE,
  batch_no       TEXT NOT NULL,
  expiry_date    TEXT NOT NULL,
  qty_received   REAL NOT NULL DEFAULT 0,
  qty_available  REAL NOT NULL DEFAULT 0,
  mrp            REAL NOT NULL DEFAULT 0,
  purchase_price REAL NOT NULL DEFAULT 0,
  supplier       TEXT,
  received_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (drug_id, batch_no)
);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON drug_batches(expiry_date);

CREATE TABLE IF NOT EXISTS pharmacy_sales (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no      TEXT NOT NULL UNIQUE,
  patient_id   INTEGER REFERENCES patients(id),
  visit_id     INTEGER REFERENCES visits(id),
  admission_id INTEGER REFERENCES admissions(id),
  invoice_id   INTEGER REFERENCES invoices(id),
  gross        REAL NOT NULL DEFAULT 0,
  discount     REAL NOT NULL DEFAULT 0,
  tax          REAL NOT NULL DEFAULT 0,
  net          REAL NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'billed'
                 CHECK (status IN ('billed','returned','cancelled')),
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pharmacy_sale_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id      INTEGER NOT NULL REFERENCES pharmacy_sales(id) ON DELETE CASCADE,
  prescription_id INTEGER REFERENCES prescriptions(id),
  drug_id      INTEGER NOT NULL REFERENCES drugs(id),
  batch_id     INTEGER REFERENCES drug_batches(id),
  drug_name    TEXT NOT NULL,
  batch_no     TEXT,
  expiry_date  TEXT,
  qty          REAL NOT NULL,
  mrp          REAL NOT NULL,
  tax_pct      REAL NOT NULL DEFAULT 0,
  amount       REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  drug_id       INTEGER NOT NULL REFERENCES drugs(id),
  batch_id      INTEGER REFERENCES drug_batches(id),
  txn_type      TEXT NOT NULL CHECK (txn_type IN ('purchase','sale','return','adjustment','expiry','ip_issue')),
  qty_delta     REAL NOT NULL,
  balance_after REAL NOT NULL,
  ref_type      TEXT,
  ref_id        INTEGER,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_drug ON stock_ledger(drug_id, created_at);

-- ---------------------------------------------------------- billing / payment
CREATE TABLE IF NOT EXISTS services (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  code     TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other'
             CHECK (category IN ('consultation','procedure','lab','radiology','room','nursing','pharmacy','other')),
  price    REAL NOT NULL DEFAULT 0,
  tax_pct  REAL NOT NULL DEFAULT 0,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS invoices (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no         TEXT NOT NULL UNIQUE,
  patient_id         INTEGER NOT NULL REFERENCES patients(id),
  visit_id           INTEGER REFERENCES visits(id),
  admission_id       INTEGER REFERENCES admissions(id),
  kind               TEXT NOT NULL DEFAULT 'opd'
                       CHECK (kind IN ('opd','ipd','pharmacy','lab','other')),
  status             TEXT NOT NULL DEFAULT 'unpaid'
                       CHECK (status IN ('draft','unpaid','partial','paid','cancelled','written_off')),
  gross              REAL NOT NULL DEFAULT 0,
  discount           REAL NOT NULL DEFAULT 0,
  sliding_discount   REAL NOT NULL DEFAULT 0,
  assistance_covered REAL NOT NULL DEFAULT 0,
  insurance_covered  REAL NOT NULL DEFAULT 0,
  tax                REAL NOT NULL DEFAULT 0,
  net                REAL NOT NULL DEFAULT 0,
  paid               REAL NOT NULL DEFAULT 0,
  balance            REAL NOT NULL DEFAULT 0,
  notes              TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_patient ON invoices(patient_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS invoice_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  ref_type    TEXT,          -- consultation | lab | pharmacy | room | service
  ref_id      INTEGER,
  description TEXT NOT NULL,
  qty         REAL NOT NULL DEFAULT 1,
  unit_price  REAL NOT NULL DEFAULT 0,
  discount    REAL NOT NULL DEFAULT 0,
  tax_pct     REAL NOT NULL DEFAULT 0,
  amount      REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no  TEXT NOT NULL UNIQUE,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  patient_id  INTEGER NOT NULL REFERENCES patients(id),
  amount      REAL NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN
                ('cash','card','upi','netbanking','cheque','insurance','assistance','wallet')),
  reference   TEXT,
  notes       TEXT,
  received_by INTEGER REFERENCES users(id),
  paid_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- "Payment Plan Agreement Form" branch of the workflow
CREATE TABLE IF NOT EXISTS payment_plans (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_no       TEXT NOT NULL UNIQUE,
  invoice_id         INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  patient_id         INTEGER NOT NULL REFERENCES patients(id),
  total_amount       REAL NOT NULL,
  down_payment       REAL NOT NULL DEFAULT 0,
  installments       INTEGER NOT NULL,
  installment_amount REAL NOT NULL,
  frequency          TEXT NOT NULL DEFAULT 'monthly'
                       CHECK (frequency IN ('weekly','fortnightly','monthly')),
  start_date         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','completed','defaulted','cancelled')),
  notes              TEXT,
  agreed_by          INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_plan_installments (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id   INTEGER NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  due_date  TEXT NOT NULL,
  amount    REAL NOT NULL,
  paid      REAL NOT NULL DEFAULT 0,
  status    TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','overdue','waived'))
);

-- "Document Payment Exception" branch of the workflow
CREATE TABLE IF NOT EXISTS payment_exceptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  patient_id  INTEGER NOT NULL REFERENCES patients(id),
  amount      REAL NOT NULL,
  reason      TEXT NOT NULL,
  approved_by INTEGER REFERENCES users(id),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------------------- IPD / wards
CREATE TABLE IF NOT EXISTS wards (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT NOT NULL UNIQUE,
  name   TEXT NOT NULL,
  kind   TEXT NOT NULL DEFAULT 'general'
           CHECK (kind IN ('general','semi_private','private','deluxe','icu','maternity','daycare','nicu')),
  floor  TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS beds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ward_id         INTEGER NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
  bed_no          TEXT NOT NULL,
  tariff_per_day  REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'vacant'
                    CHECK (status IN ('vacant','occupied','blocked','cleaning')),
  active          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (ward_id, bed_no)
);

CREATE TABLE IF NOT EXISTS admissions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_no                 TEXT NOT NULL UNIQUE,
  patient_id            INTEGER NOT NULL REFERENCES patients(id),
  visit_id              INTEGER REFERENCES visits(id),
  doctor_id             INTEGER NOT NULL REFERENCES users(id),
  ward_id               INTEGER NOT NULL REFERENCES wards(id),
  bed_id                INTEGER NOT NULL REFERENCES beds(id),
  admission_type        TEXT NOT NULL DEFAULT 'planned'
                          CHECK (admission_type IN ('planned','emergency','daycare','maternity','observation')),
  admitted_at           TEXT NOT NULL DEFAULT (datetime('now')),
  reason                TEXT,
  provisional_diagnosis TEXT,
  attendant_name        TEXT,
  attendant_phone       TEXT,
  status                TEXT NOT NULL DEFAULT 'admitted'
                          CHECK (status IN ('admitted','discharged','lama','transferred','expired')),
  discharged_at         TEXT,
  discharge_type        TEXT CHECK (discharge_type IN ('recovered','referred','lama','absconded','expired','transferred')),
  final_diagnosis       TEXT,
  course_in_hospital    TEXT,
  discharge_advice      TEXT,
  discharge_medication  TEXT,
  follow_up_date        TEXT,
  discharged_by         INTEGER REFERENCES users(id),
  invoice_id            INTEGER REFERENCES invoices(id),
  created_by            INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_admissions_status ON admissions(status);

CREATE TABLE IF NOT EXISTS bed_transfers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id   INTEGER NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  from_bed_id    INTEGER REFERENCES beds(id),
  to_bed_id      INTEGER NOT NULL REFERENCES beds(id),
  reason         TEXT,
  transferred_at TEXT NOT NULL DEFAULT (datetime('now')),
  transferred_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ip_notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id INTEGER NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  note_type    TEXT NOT NULL DEFAULT 'doctor_round'
                 CHECK (note_type IN ('doctor_round','nursing','procedure','diet','physio','handover')),
  note         TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ipnotes_admission ON ip_notes(admission_id);

CREATE TABLE IF NOT EXISTS ip_medication_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id INTEGER NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  drug_id      INTEGER REFERENCES drugs(id),
  drug_name    TEXT NOT NULL,
  dose         TEXT,
  frequency    TEXT,
  route        TEXT DEFAULT 'oral',
  start_date   TEXT NOT NULL,
  end_date     TEXT,
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','stopped','completed')),
  ordered_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ip_medication_admin (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES ip_medication_orders(id) ON DELETE CASCADE,
  admission_id    INTEGER NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  due_at          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'due'
                    CHECK (status IN ('due','given','missed','held','refused')),
  administered_at TEXT,
  administered_by INTEGER REFERENCES users(id),
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS ip_charges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id INTEGER NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  service_id   INTEGER REFERENCES services(id),
  description  TEXT NOT NULL,
  qty          REAL NOT NULL DEFAULT 1,
  unit_price   REAL NOT NULL DEFAULT 0,
  amount       REAL NOT NULL DEFAULT 0,
  charge_date  TEXT NOT NULL DEFAULT (date('now')),
  billed       INTEGER NOT NULL DEFAULT 0,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------- WhatsApp / communications
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_number       TEXT NOT NULL UNIQUE,
  patient_id      INTEGER REFERENCES patients(id),
  state           TEXT NOT NULL DEFAULT 'idle',
  context         TEXT NOT NULL DEFAULT '{}',   -- JSON
  last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_number           TEXT NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('in','out')),
  body                TEXT,
  message_type        TEXT NOT NULL DEFAULT 'text',
  payload             TEXT,
  provider_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'received'
                        CHECK (status IN ('received','queued','sent','delivered','read','failed')),
  error               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wa_msgs_number ON whatsapp_messages(wa_number, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel      TEXT NOT NULL DEFAULT 'whatsapp'
                 CHECK (channel IN ('whatsapp','sms','email')),
  to_addr      TEXT NOT NULL,
  template     TEXT,
  body         TEXT NOT NULL,
  ref_type     TEXT,
  ref_id       INTEGER,
  status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','sent','failed','cancelled')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications(status, scheduled_at);

-- ------------------------------------------------------------ audit / config
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  actor      TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  details    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
