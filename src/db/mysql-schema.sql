-- SAMIHA POLYCLINIC & DIAGNOSTICS — MySQL Schema
-- Auto-generated from SQLite database definition

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `admissions`;
CREATE TABLE `admissions` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `ip_no` VARCHAR(255) NULL,
  `patient_id` INT NULL,
  `visit_id` INT NULL,
  `doctor_id` INT NULL,
  `ward_id` INT NULL,
  `bed_id` INT NULL,
  `admission_type` VARCHAR(255) NULL,
  `admitted_at` DATETIME NULL,
  `reason` VARCHAR(255) NULL,
  `provisional_diagnosis` VARCHAR(255) NULL,
  `attendant_name` VARCHAR(255) NULL,
  `attendant_phone` VARCHAR(255) NULL,
  `status` VARCHAR(100) NULL,
  `discharged_at` DATETIME NULL,
  `discharge_type` VARCHAR(255) NULL,
  `final_diagnosis` VARCHAR(255) NULL,
  `course_in_hospital` VARCHAR(255) NULL,
  `discharge_advice` VARCHAR(255) NULL,
  `discharge_medication` VARCHAR(255) NULL,
  `follow_up_date` DATE NULL,
  `discharged_by` INT NULL,
  `invoice_id` INT NULL,
  `created_by` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `appointments`;
CREATE TABLE `appointments` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `appt_no` VARCHAR(255) NULL,
  `patient_id` INT NULL,
  `guest_name` VARCHAR(255) NULL,
  `guest_phone` VARCHAR(255) NULL,
  `doctor_id` INT NULL,
  `department_id` INT NULL,
  `scheduled_at` DATETIME NULL,
  `slot_minutes` INT NULL,
  `token_no` INT NULL,
  `visit_kind` VARCHAR(255) NULL,
  `source` VARCHAR(255) NULL,
  `status` VARCHAR(100) NULL,
  `reason` VARCHAR(255) NULL,
  `reminder_sent` INT NULL,
  `cancel_reason` VARCHAR(255) NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `asset_events`;
CREATE TABLE `asset_events` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `asset_id` INT NULL,
  `kind` VARCHAR(255) NULL,
  `happened_on` DATE NULL,
  `detail` VARCHAR(255) NULL,
  `done_by` INT NULL,
  `reference` VARCHAR(255) NULL,
  `cost` DOUBLE NULL,
  `next_due` VARCHAR(255) NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `assets`;
CREATE TABLE `assets` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `asset_no` VARCHAR(255) NULL,
  `name` VARCHAR(255) NULL,
  `category` VARCHAR(255) NULL,
  `make` VARCHAR(255) NULL,
  `model` VARCHAR(255) NULL,
  `serial_no` VARCHAR(255) NULL,
  `quantity` DOUBLE NULL,
  `location` VARCHAR(255) NULL,
  `department_id` INT NULL,
  `status` VARCHAR(100) NULL,
  `supplier` VARCHAR(255) NULL,
  `po_no` VARCHAR(255) NULL,
  `invoice_no` VARCHAR(255) NULL,
  `purchase_date` DATE NULL,
  `unit_cost` DOUBLE NULL,
  `warranty_until` VARCHAR(255) NULL,
  `amc_until` VARCHAR(255) NULL,
  `needs_calibration` INT NULL,
  `calibration_months` INT NULL,
  `last_calibrated` VARCHAR(255) NULL,
  `calibration_due` VARCHAR(255) NULL,
  `calibration_by` INT NULL,
  `certificate_no` VARCHAR(255) NULL,
  `notes` TEXT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0,
  `created_by` INT NULL,
  `created_at` DATETIME NULL,
  `updated_at` DATETIME NULL,
  `life_years` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `assistance_programs`;
CREATE TABLE `assistance_programs` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(100) NULL,
  `name` VARCHAR(255) NULL,
  `description` TEXT NULL,
  `coverage_pct` DOUBLE NULL,
  `max_fpl_pct` DOUBLE NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `audit_logs`;
CREATE TABLE `audit_logs` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NULL,
  `actor` VARCHAR(255) NULL,
  `action` VARCHAR(255) NULL,
  `entity` VARCHAR(255) NULL,
  `entity_id` INT NULL,
  `details` TEXT,
  `ip` VARCHAR(255) NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `backups`;
CREATE TABLE `backups` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `filename` VARCHAR(255) NULL,
  `size_bytes` INT NULL,
  `kind` VARCHAR(255) NULL,
  `emailed_to` VARCHAR(255) NULL,
  `status` VARCHAR(100) NULL,
  `error` VARCHAR(255) NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `bed_transfers`;
CREATE TABLE `bed_transfers` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `admission_id` INT NULL,
  `from_bed_id` INT NULL,
  `to_bed_id` INT NULL,
  `reason` VARCHAR(255) NULL,
  `transferred_at` DATETIME NULL,
  `transferred_by` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `beds`;
CREATE TABLE `beds` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `ward_id` INT NULL,
  `bed_no` VARCHAR(255) NULL,
  `tariff_per_day` DOUBLE NULL,
  `status` VARCHAR(100) NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `budgets`;
CREATE TABLE `budgets` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `period` VARCHAR(255) NULL,
  `line` VARCHAR(255) NULL,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `note` VARCHAR(255) NULL,
  `set_by` INT NULL,
  `set_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `cash_book`;
CREATE TABLE `cash_book` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `ref_no` VARCHAR(255) NULL,
  `direction` VARCHAR(255) NULL,
  `category` VARCHAR(255) NULL,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `entry_date` DATE NULL,
  `mode` VARCHAR(255) NULL,
  `payee` VARCHAR(255) NULL,
  `reference` VARCHAR(255) NULL,
  `notes` TEXT NULL,
  `supplier_id` INT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL,
  `voided_at` DATETIME NULL,
  `voided_by` INT NULL,
  `void_reason` VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `claim_events`;
CREATE TABLE `claim_events` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `claim_id` INT NULL,
  `event` VARCHAR(255) NULL,
  `detail` VARCHAR(255) NULL,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `actor_id` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `claim_items`;
CREATE TABLE `claim_items` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `claim_id` INT NULL,
  `invoice_item_id` INT NULL,
  `description` TEXT NULL,
  `category` VARCHAR(255) NULL,
  `billed` DOUBLE NULL,
  `claimed` DOUBLE NULL,
  `approved` DOUBLE NULL,
  `disallowed` DOUBLE NULL,
  `disallow_reason` VARCHAR(255) NULL,
  `admissible` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `claims`;
CREATE TABLE `claims` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `claim_no` VARCHAR(255) NULL,
  `patient_id` INT NULL,
  `policy_id` INT NULL,
  `insurer_id` INT NULL,
  `invoice_id` INT NULL,
  `admission_id` INT NULL,
  `visit_id` INT NULL,
  `preauth_id` INT NULL,
  `claim_type` VARCHAR(255) NULL,
  `status` VARCHAR(100) NULL,
  `billed_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `claimed_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `approved_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `disallowed_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `copay_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `tds_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `settled_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `disallow_reason` VARCHAR(255) NULL,
  `rejection_reason` VARCHAR(255) NULL,
  `utr_no` VARCHAR(255) NULL,
  `submitted_at` DATETIME NULL,
  `decision_at` DATETIME NULL,
  `settled_at` DATETIME NULL,
  `due_at` DATETIME NULL,
  `remarks` VARCHAR(255) NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `complaints`;
CREATE TABLE `complaints` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `ref_no` VARCHAR(255) NULL,
  `patient_id` INT NULL,
  `complainant` VARCHAR(255) NULL,
  `contact` VARCHAR(255) NULL,
  `received_on` VARCHAR(255) NULL,
  `channel` VARCHAR(255) NULL,
  `category` VARCHAR(255) NULL,
  `department_id` INT NULL,
  `severity` VARCHAR(255) NULL,
  `detail` VARCHAR(255) NULL,
  `action_taken` VARCHAR(255) NULL,
  `owner_name` VARCHAR(255) NULL,
  `due_date` DATE NULL,
  `status` VARCHAR(100) NULL,
  `resolved_on` VARCHAR(255) NULL,
  `resolution` VARCHAR(255) NULL,
  `satisfied` INT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `compliance_items`;
CREATE TABLE `compliance_items` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NULL,
  `kind` VARCHAR(255) NULL,
  `authority` VARCHAR(255) NULL,
  `reference_no` VARCHAR(255) NULL,
  `issued_on` VARCHAR(255) NULL,
  `valid_till` DATE NULL,
  `renewal_notice_days` INT NULL,
  `owner_name` VARCHAR(255) NULL,
  `cost` DOUBLE NULL,
  `status` VARCHAR(100) NULL,
  `notes` TEXT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0,
  `created_by` INT NULL,
  `created_at` DATETIME NULL,
  `updated_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `consultation_diagnoses`;
CREATE TABLE `consultation_diagnoses` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `consultation_id` INT NULL,
  `icd_code` VARCHAR(255) NULL,
  `title` VARCHAR(255) NULL,
  `kind` VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `consultations`;
CREATE TABLE `consultations` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `visit_id` INT NULL,
  `patient_id` INT NULL,
  `doctor_id` INT NULL,
  `chief_complaint` VARCHAR(255) NULL,
  `subjective` VARCHAR(255) NULL,
  `objective` VARCHAR(255) NULL,
  `assessment` VARCHAR(255) NULL,
  `plan` TEXT,
  `advice` VARCHAR(255) NULL,
  `screening_done` INT NULL,
  `referred_to` VARCHAR(255) NULL,
  `follow_up_days` INT NULL,
  `follow_up_date` DATE NULL,
  `signed_at` DATETIME NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `counters`;
CREATE TABLE `counters` (
  `name` VARCHAR(255) NULL,
  `value` INT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `departments`;
CREATE TABLE `departments` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(100) NULL,
  `name` VARCHAR(255) NULL,
  `kind` VARCHAR(255) NULL,
  `sort_order` INT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `doctor_availability`;
CREATE TABLE `doctor_availability` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `doctor_id` INT NULL,
  `avail_date` DATE NULL,
  `start_time` VARCHAR(255) NULL,
  `end_time` VARCHAR(255) NULL,
  `slot_minutes` INT NULL,
  `max_tokens` INT NULL,
  `note` VARCHAR(255) NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `doctor_leaves`;
CREATE TABLE `doctor_leaves` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `doctor_id` INT NULL,
  `leave_date` DATE NULL,
  `reason` VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `doctor_profiles`;
CREATE TABLE `doctor_profiles` (
  `user_id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `qualification` VARCHAR(255) NULL,
  `specialization` VARCHAR(255) NULL,
  `reg_no` VARCHAR(255) NULL,
  `consult_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `follow_up_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `slot_minutes` INT NULL,
  `room_no` VARCHAR(255) NULL,
  `signature_line` VARCHAR(255) NULL,
  `notify_whatsapp` TINYINT(1) NOT NULL DEFAULT 0,
  `notify_email` TINYINT(1) NOT NULL DEFAULT 0,
  `signature_image` LONGTEXT,
  `doctor_code` VARCHAR(100) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `doctor_schedules`;
CREATE TABLE `doctor_schedules` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `doctor_id` INT NULL,
  `weekday` INT NULL,
  `start_time` VARCHAR(255) NULL,
  `end_time` VARCHAR(255) NULL,
  `slot_minutes` INT NULL,
  `max_tokens` INT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `document_shares`;
CREATE TABLE `document_shares` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `token` VARCHAR(255) NULL,
  `kind` VARCHAR(255) NULL,
  `ref_id` INT NULL,
  `doc_no` VARCHAR(255) NULL,
  `filename` VARCHAR(255) NULL,
  `content` LONGBLOB,
  `bytes` INT NULL,
  `wa_number` VARCHAR(255) NULL,
  `channel` VARCHAR(255) NULL,
  `message_id` INT NULL,
  `sent_by` INT NULL,
  `created_at` DATETIME NULL,
  `expires_at` DATETIME NULL,
  `downloads` INT NULL,
  `last_seen_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `drug_batches`;
CREATE TABLE `drug_batches` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `drug_id` INT NULL,
  `batch_no` VARCHAR(255) NULL,
  `expiry_date` DATE NULL,
  `qty_received` DOUBLE NULL,
  `qty_available` DOUBLE NULL,
  `mrp` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `purchase_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `supplier` VARCHAR(255) NULL,
  `barcode` VARCHAR(255) NULL,
  `received_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `drugs`;
CREATE TABLE `drugs` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(100) NULL,
  `name` VARCHAR(255) NULL,
  `generic_name` VARCHAR(255) NULL,
  `form` VARCHAR(255) NULL,
  `strength` VARCHAR(255) NULL,
  `manufacturer` VARCHAR(255) NULL,
  `hsn` VARCHAR(255) NULL,
  `tax_pct` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `mrp` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `purchase_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `unit_rate` DOUBLE NULL,
  `reorder_level` DOUBLE NULL,
  `schedule_type` VARCHAR(255) NULL,
  `barcode` VARCHAR(255) NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0,
  `category` VARCHAR(255) NULL,
  `pack_size` VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `enquiries`;
CREATE TABLE `enquiries` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `ref_no` VARCHAR(255) NULL,
  `source` VARCHAR(255) NULL,
  `name` VARCHAR(255) NULL,
  `phone` VARCHAR(100) NULL,
  `patient_id` INT NULL,
  `department_id` INT NULL,
  `doctor_id` INT NULL,
  `subject` VARCHAR(255) NULL,
  `notes` TEXT NULL,
  `status` VARCHAR(100) NULL,
  `assigned_to` INT NULL,
  `follow_up_at` DATETIME NULL,
  `appointment_id` INT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL,
  `closed_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `financial_screenings`;
CREATE TABLE `financial_screenings` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `screening_no` VARCHAR(255) NULL,
  `patient_id` INT NULL,
  `visit_id` INT NULL,
  `status` VARCHAR(100) NULL,
  `counselor_id` INT NULL,
  `uninsured` INT NULL,
  `household_size` INT NULL,
  `annual_income` DOUBLE NULL,
  `fpl_pct` DOUBLE NULL,
  `has_proof_of_income` TINYINT(1) NOT NULL DEFAULT 0,
  `proof_type` VARCHAR(255) NULL,
  `eligible_programs` VARCHAR(255) NULL,
  `sliding_scale_band` VARCHAR(255) NULL,
  `discount_pct` DOUBLE NULL,
  `assistance_program_id` INT NULL,
  `patient_decision` VARCHAR(255) NULL,
  `notes` TEXT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL,
  `completed_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `hygiene_rounds`;
CREATE TABLE `hygiene_rounds` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `on_date` DATE NULL,
  `shift` VARCHAR(255) NULL,
  `area` VARCHAR(255) NULL,
  `kind` VARCHAR(255) NULL,
  `score` DOUBLE NULL,
  `passed` INT NULL,
  `issues` VARCHAR(255) NULL,
  `action_taken` VARCHAR(255) NULL,
  `done_by` INT NULL,
  `verified_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `icd_codes`;
CREATE TABLE `icd_codes` (
  `code` VARCHAR(100) NULL,
  `title` VARCHAR(255) NULL,
  `chapter` VARCHAR(255) NULL,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `insurance_documents`;
CREATE TABLE `insurance_documents` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `preauth_id` INT NULL,
  `claim_id` INT NULL,
  `doc_type` VARCHAR(255) NULL,
  `reference` VARCHAR(255) NULL,
  `provided` INT NULL,
  `notes` TEXT,
  `recorded_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `insurers`;
CREATE TABLE `insurers` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(100) NULL,
  `name` VARCHAR(255) NULL,
  `kind` VARCHAR(255) NULL,
  `administered_by` INT NULL,
  `contact_person` VARCHAR(255) NULL,
  `phone` VARCHAR(100) NULL,
  `email` VARCHAR(255) NULL,
  `claim_email` VARCHAR(255) NULL,
  `portal_url` VARCHAR(255) NULL,
  `address` TEXT NULL,
  `cashless` INT NULL,
  `preauth_tat_hours` INT NULL,
  `settlement_days` INT NULL,
  `tariff_discount_pct` DOUBLE NULL,
  `notes` TEXT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `invoice_items`;
CREATE TABLE `invoice_items` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `invoice_id` INT NULL,
  `ref_type` VARCHAR(255) NULL,
  `ref_id` INT NULL,
  `description` TEXT NULL,
  `qty` DOUBLE NULL,
  `unit_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `discount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `tax_pct` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `invoices`;
CREATE TABLE `invoices` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `invoice_no` VARCHAR(255) NULL,
  `patient_id` INT NULL,
  `visit_id` INT NULL,
  `admission_id` INT NULL,
  `kind` VARCHAR(255) NULL,
  `status` VARCHAR(100) NULL,
  `gross` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `discount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `sliding_discount` DOUBLE NULL,
  `assistance_covered` DOUBLE NULL,
  `insurance_covered` DOUBLE NULL,
  `tax` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `net` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `paid` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `balance` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `notes` TEXT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL,
  `closed_at` DATETIME NULL,
  `bill_discount` DOUBLE NULL,
  `bill_discount_reason` VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `ip_charges`;
CREATE TABLE `ip_charges` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `admission_id` INT NULL,
  `service_id` INT NULL,
  `description` TEXT NULL,
  `qty` DOUBLE NULL,
  `unit_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `charge_date` DATE NULL,
  `billed` INT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `ip_medication_admin`;
CREATE TABLE `ip_medication_admin` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_id` INT NULL,
  `admission_id` INT NULL,
  `due_at` DATETIME NULL,
  `status` VARCHAR(100) NULL,
  `administered_at` DATETIME NULL,
  `administered_by` INT NULL,
  `notes` TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `ip_medication_orders`;
CREATE TABLE `ip_medication_orders` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `admission_id` INT NULL,
  `drug_id` INT NULL,
  `drug_name` VARCHAR(255) NULL,
  `dose` VARCHAR(255) NULL,
  `frequency` VARCHAR(255) NULL,
  `route` VARCHAR(255) NULL,
  `start_date` DATE NULL,
  `end_date` DATE NULL,
  `status` VARCHAR(100) NULL,
  `ordered_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `ip_notes`;
CREATE TABLE `ip_notes` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `admission_id` INT NULL,
  `note_type` VARCHAR(255) NULL,
  `note` TEXT,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `lab_order_items`;
CREATE TABLE `lab_order_items` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_id` INT NULL,
  `test_id` INT NULL,
  `test_name` VARCHAR(255) NULL,
  `price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `unit` VARCHAR(255) NULL,
  `ref_range` VARCHAR(255) NULL,
  `result_value` VARCHAR(255) NULL,
  `result_notes` TEXT NULL,
  `abnormal_flag` VARCHAR(255) NULL,
  `status` VARCHAR(100) NULL,
  `result_by` INT NULL,
  `result_at` DATETIME NULL,
  `verified_by` INT NULL,
  `verified_at` DATETIME NULL,
  `parent_item_id` INT NULL,
  `sort_order` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `lab_orders`;
CREATE TABLE `lab_orders` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_no` VARCHAR(255) NULL,
  `visit_id` INT NULL,
  `admission_id` INT NULL,
  `patient_id` INT NULL,
  `doctor_id` INT NULL,
  `priority` VARCHAR(255) NULL,
  `status` VARCHAR(100) NULL,
  `clinical_notes` TEXT NULL,
  `ordered_at` DATETIME NULL,
  `reported_at` DATETIME NULL,
  `billing_status` VARCHAR(255) NULL,
  `invoice_id` INT NULL,
  `released_at` DATETIME NULL,
  `released_by` INT NULL,
  `release_note` VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `lab_package_items`;
CREATE TABLE `lab_package_items` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `package_code` VARCHAR(255) NULL,
  `test_code` VARCHAR(255) NULL,
  `sort_order` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `lab_samples`;
CREATE TABLE `lab_samples` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `order_id` INT NULL,
  `barcode` VARCHAR(255) NULL,
  `sample_type` VARCHAR(255) NULL,
  `collected_at` DATETIME NULL,
  `collected_by` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `lab_tests`;
CREATE TABLE `lab_tests` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(100) NULL,
  `name` VARCHAR(255) NULL,
  `category` VARCHAR(255) NULL,
  `sample_type` VARCHAR(255) NULL,
  `unit` VARCHAR(255) NULL,
  `ref_low` DOUBLE NULL,
  `ref_high` DOUBLE NULL,
  `ref_text` TEXT NULL,
  `price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `tat_hours` INT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0,
  `bill_group` VARCHAR(255) NULL,
  `component_of` VARCHAR(255) NULL,
  `sort_order` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `ledger_positions`;
CREATE TABLE `ledger_positions` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `as_on` DATE NULL,
  `line` VARCHAR(255) NULL,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `note` VARCHAR(255) NULL,
  `set_by` INT NULL,
  `set_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `notifications`;
CREATE TABLE `notifications` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `channel` VARCHAR(255) NULL,
  `to_addr` VARCHAR(255) NULL,
  `template` VARCHAR(255) NULL,
  `body` VARCHAR(255) NULL,
  `ref_type` VARCHAR(255) NULL,
  `ref_id` INT NULL,
  `status` VARCHAR(100) NULL,
  `attempts` INT NULL,
  `error` VARCHAR(255) NULL,
  `scheduled_at` DATETIME NULL,
  `sent_at` DATETIME NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `owner_actions`;
CREATE TABLE `owner_actions` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `period` VARCHAR(255) NULL,
  `area` VARCHAR(255) NULL,
  `finding` VARCHAR(255) NULL,
  `cause` VARCHAR(255) NULL,
  `action` VARCHAR(255) NULL,
  `responsible` VARCHAR(255) NULL,
  `due_date` DATE NULL,
  `status` VARCHAR(100) NULL,
  `outcome` VARCHAR(255) NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL,
  `closed_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `password_resets`;
CREATE TABLE `password_resets` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NULL,
  `token_hash` VARCHAR(255) NULL,
  `requested_by` INT NULL,
  `ip` VARCHAR(255) NULL,
  `expires_at` VARCHAR(64) NULL,
  `used_at` VARCHAR(64) NULL,
  `created_at` VARCHAR(64) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `patient_history`;
CREATE TABLE `patient_history` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `patient_id` INT NULL,
  `kind` VARCHAR(255) NULL,
  `detail` VARCHAR(255) NULL,
  `since` VARCHAR(255) NULL,
  `recorded_by` INT NULL,
  `recorded_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `patient_notes`;
CREATE TABLE `patient_notes` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `patient_id` INT NULL,
  `visit_id` INT NULL,
  `appointment_id` INT NULL,
  `note` TEXT,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `patient_policies`;
CREATE TABLE `patient_policies` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `patient_id` INT NULL,
  `insurer_id` INT NULL,
  `policy_no` VARCHAR(255) NULL,
  `member_id` INT NULL,
  `card_number` VARCHAR(255) NULL,
  `scheme` VARCHAR(255) NULL,
  `policy_holder` VARCHAR(255) NULL,
  `relationship` VARCHAR(255) NULL,
  `sum_insured` DOUBLE NULL,
  `sum_utilised` DOUBLE NULL,
  `copay_pct` DOUBLE NULL,
  `room_rent_limit` DOUBLE NULL,
  `valid_from` VARCHAR(255) NULL,
  `valid_to` VARCHAR(255) NULL,
  `waiting_till` VARCHAR(255) NULL,
  `status` VARCHAR(100) NULL,
  `verified_at` DATETIME NULL,
  `verified_by` INT NULL,
  `notes` TEXT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `patients`;
CREATE TABLE `patients` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `uhid` VARCHAR(255) NULL,
  `title` VARCHAR(255) NULL,
  `first_name` VARCHAR(255) NULL,
  `last_name` VARCHAR(255) NULL,
  `dob` DATE NULL,
  `age_years` INT NULL,
  `gender` VARCHAR(100) NULL,
  `phone` VARCHAR(100) NULL,
  `whatsapp` VARCHAR(100) NULL,
  `email` VARCHAR(255) NULL,
  `address` TEXT NULL,
  `city` VARCHAR(255) NULL,
  `state` VARCHAR(255) NULL,
  `pincode` VARCHAR(255) NULL,
  `blood_group` VARCHAR(100) NULL,
  `marital_status` VARCHAR(255) NULL,
  `occupation` VARCHAR(255) NULL,
  `emergency_name` VARCHAR(255) NULL,
  `emergency_phone` VARCHAR(255) NULL,
  `emergency_relation` VARCHAR(255) NULL,
  `id_type` VARCHAR(255) NULL,
  `id_number` VARCHAR(255) NULL,
  `sex_at_birth` VARCHAR(255) NULL,
  `billing_address` TEXT NULL,
  `smoking_status` VARCHAR(255) NULL,
  `alcohol_use` VARCHAR(255) NULL,
  `current_medications` TEXT NULL,
  `immunisations` TEXT NULL,
  `presenting_complaint` VARCHAR(255) NULL,
  `consent_treatment` TINYINT(1) NOT NULL DEFAULT 0,
  `consent_privacy` TINYINT(1) NOT NULL DEFAULT 0,
  `consent_contact` TINYINT(1) NOT NULL DEFAULT 0,
  `consent_signed_at` DATETIME NULL,
  `consent_signed_by` VARCHAR(255) NULL,
  `consent_taken_by` INT NULL,
  `is_uninsured` TINYINT(1) NOT NULL DEFAULT 0,
  `insurance_provider` VARCHAR(255) NULL,
  `insurance_policy_no` VARCHAR(255) NULL,
  `insurance_valid_till` VARCHAR(255) NULL,
  `sliding_scale_band` VARCHAR(255) NULL,
  `assistance_program_id` INT NULL,
  `allergies` VARCHAR(255) NULL,
  `chronic_conditions` VARCHAR(255) NULL,
  `last_screening_date` DATE NULL,
  `pharmacy_name` VARCHAR(255) NULL,
  `pharmacy_phone` VARCHAR(255) NULL,
  `pharmacy_address` TEXT NULL,
  `notes` TEXT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0,
  `stage` VARCHAR(255) NULL,
  `enquiry_at` DATETIME NULL,
  `registered_at` DATETIME NULL,
  `created_by` INT NULL,
  `relationship_to_primary` VARCHAR(255) NULL,
  `aadhaar_number` VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `payment_exceptions`;
CREATE TABLE `payment_exceptions` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `invoice_id` INT NULL,
  `patient_id` INT NULL,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `reason` VARCHAR(255) NULL,
  `approved_by` INT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `payment_plan_installments`;
CREATE TABLE `payment_plan_installments` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `plan_id` INT NULL,
  `seq` INT NULL,
  `due_date` DATE NULL,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `paid` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(100) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `payment_plans`;
CREATE TABLE `payment_plans` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `agreement_no` VARCHAR(255) NULL,
  `invoice_id` INT NULL,
  `patient_id` INT NULL,
  `total_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `down_payment` DOUBLE NULL,
  `installments` INT NULL,
  `installment_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `frequency` VARCHAR(255) NULL,
  `start_date` DATE NULL,
  `status` VARCHAR(100) NULL,
  `notes` TEXT NULL,
  `agreed_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `payments`;
CREATE TABLE `payments` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `receipt_no` VARCHAR(255) NULL,
  `invoice_id` INT NULL,
  `patient_id` INT NULL,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `mode` VARCHAR(255) NULL,
  `reference` VARCHAR(255) NULL,
  `notes` TEXT NULL,
  `received_by` INT NULL,
  `paid_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `payroll_lines`;
CREATE TABLE `payroll_lines` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `period` VARCHAR(255) NULL,
  `user_id` INT NULL,
  `person` VARCHAR(255) NULL,
  `role` VARCHAR(100) NULL,
  `department_id` INT NULL,
  `kind` VARCHAR(255) NULL,
  `basic` DOUBLE NULL,
  `allowances` DOUBLE NULL,
  `overtime` DOUBLE NULL,
  `deductions` DOUBLE NULL,
  `net_pay` DOUBLE NULL,
  `paid_on` VARCHAR(255) NULL,
  `mode` VARCHAR(255) NULL,
  `notes` TEXT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `pharmacy_sale_items`;
CREATE TABLE `pharmacy_sale_items` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `sale_id` INT NULL,
  `prescription_id` INT NULL,
  `drug_id` INT NULL,
  `batch_id` INT NULL,
  `drug_name` VARCHAR(255) NULL,
  `batch_no` VARCHAR(255) NULL,
  `expiry_date` DATE NULL,
  `qty` DOUBLE NULL,
  `mrp` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `tax_pct` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `hsn` VARCHAR(255) NULL,
  `taxable` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `cgst` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `sgst` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `discount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `pharmacy_sales`;
CREATE TABLE `pharmacy_sales` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `bill_no` VARCHAR(255) NULL,
  `sale_type` VARCHAR(255) NULL,
  `customer_name` VARCHAR(255) NULL,
  `customer_phone` VARCHAR(255) NULL,
  `rx_reference` VARCHAR(255) NULL,
  `paid_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `payment_mode` VARCHAR(255) NULL,
  `payment_reference` VARCHAR(255) NULL,
  `patient_id` INT NULL,
  `visit_id` INT NULL,
  `admission_id` INT NULL,
  `invoice_id` INT NULL,
  `gross` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `discount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `tax` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `net` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(100) NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL,
  `round_off` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `customer_gstin` VARCHAR(255) NULL,
  `customer_address` TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `poverty_guidelines`;
CREATE TABLE `poverty_guidelines` (
  `household_size` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `annual_income` DOUBLE NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `preauth_events`;
CREATE TABLE `preauth_events` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `preauth_id` INT NULL,
  `event` VARCHAR(255) NULL,
  `detail` VARCHAR(255) NULL,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `actor_id` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `preauths`;
CREATE TABLE `preauths` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `preauth_no` VARCHAR(255) NULL,
  `patient_id` INT NULL,
  `policy_id` INT NULL,
  `insurer_id` INT NULL,
  `admission_id` INT NULL,
  `visit_id` INT NULL,
  `doctor_id` INT NULL,
  `kind` VARCHAR(255) NULL,
  `parent_id` INT NULL,
  `status` VARCHAR(100) NULL,
  `icd_code` VARCHAR(255) NULL,
  `diagnosis` VARCHAR(255) NULL,
  `procedure_name` VARCHAR(255) NULL,
  `treatment_plan` VARCHAR(255) NULL,
  `clinical_notes` TEXT NULL,
  `past_history` VARCHAR(255) NULL,
  `estimated_stay_days` INT NULL,
  `room_category` VARCHAR(255) NULL,
  `requested_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `approved_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `copay_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `approval_no` VARCHAR(255) NULL,
  `valid_till` DATE NULL,
  `submitted_at` DATETIME NULL,
  `decision_at` DATETIME NULL,
  `reference_no` VARCHAR(255) NULL,
  `rejection_reason` VARCHAR(255) NULL,
  `remarks` VARCHAR(255) NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `prescription_diagnoses`;
CREATE TABLE `prescription_diagnoses` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `sheet_id` INT NULL,
  `code` VARCHAR(100) NULL,
  `title` VARCHAR(255) NULL,
  `rank` VARCHAR(255) NULL,
  `sort_order` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `prescription_sheets`;
CREATE TABLE `prescription_sheets` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `rx_no` VARCHAR(255) NULL,
  `patient_id` INT NULL,
  `doctor_id` INT NULL,
  `visit_id` INT NULL,
  `appointment_id` INT NULL,
  `complaints` VARCHAR(255) NULL,
  `findings` VARCHAR(255) NULL,
  `diagnosis` VARCHAR(255) NULL,
  `advice` VARCHAR(255) NULL,
  `follow_up_date` DATE NULL,
  `status` VARCHAR(100) NULL,
  `created_at` DATETIME NULL,
  `signed_at` DATETIME NULL,
  `signature_image` LONGTEXT,
  `amended_at` DATETIME NULL,
  `amended_by` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `prescriptions`;
CREATE TABLE `prescriptions` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `consultation_id` INT NULL,
  `visit_id` INT NULL,
  `admission_id` INT NULL,
  `patient_id` INT NULL,
  `drug_id` INT NULL,
  `drug_name` VARCHAR(255) NULL,
  `dose` VARCHAR(255) NULL,
  `frequency` VARCHAR(255) NULL,
  `route` VARCHAR(255) NULL,
  `duration_days` INT NULL,
  `quantity` DOUBLE NULL,
  `instructions` VARCHAR(255) NULL,
  `dispensed_qty` DOUBLE NULL,
  `status` VARCHAR(100) NULL,
  `created_at` DATETIME NULL,
  `sheet_id` INT NULL,
  `doctor_id` INT NULL,
  `dose_morning` DOUBLE NULL,
  `dose_afternoon` DOUBLE NULL,
  `dose_night` DOUBLE NULL,
  `dose_unit` DOUBLE NULL,
  `food_relation` VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `safety_incidents`;
CREATE TABLE `safety_incidents` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `ref_no` VARCHAR(255) NULL,
  `happened_on` DATE NULL,
  `happened_at` DATETIME NULL,
  `patient_id` INT NULL,
  `department_id` INT NULL,
  `location` VARCHAR(255) NULL,
  `kind` VARCHAR(255) NULL,
  `harm` VARCHAR(255) NULL,
  `detail` VARCHAR(255) NULL,
  `immediate_action` VARCHAR(255) NULL,
  `root_cause` VARCHAR(255) NULL,
  `corrective_action` VARCHAR(255) NULL,
  `owner_name` VARCHAR(255) NULL,
  `due_date` DATE NULL,
  `status` VARCHAR(100) NULL,
  `closed_on` VARCHAR(255) NULL,
  `reported_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `services`;
CREATE TABLE `services` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(100) NULL,
  `name` VARCHAR(255) NULL,
  `category` VARCHAR(255) NULL,
  `price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `tax_pct` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `active` TINYINT(1) NOT NULL DEFAULT 0,
  `bill_group` VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `sessions`;
CREATE TABLE `sessions` (
  `token` VARCHAR(255) NULL,
  `user_id` INT NULL,
  `created_at` VARCHAR(64) NULL,
  `expires_at` VARCHAR(64) NULL,
  PRIMARY KEY (`token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `settings`;
CREATE TABLE `settings` (
  `key` VARCHAR(255) NULL,
  `value` TEXT,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `sliding_scale_bands`;
CREATE TABLE `sliding_scale_bands` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `band` VARCHAR(255) NULL,
  `fpl_min` DOUBLE NULL,
  `fpl_max` DOUBLE NULL,
  `discount_pct` DOUBLE NULL,
  `flat_consult_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `active` TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `staff_attendance`;
CREATE TABLE `staff_attendance` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NULL,
  `on_date` DATE NULL,
  `shift` VARCHAR(255) NULL,
  `status` VARCHAR(100) NULL,
  `in_at` DATETIME NULL,
  `out_at` DATETIME NULL,
  `worked_hours` DOUBLE NULL,
  `overtime_hours` DOUBLE NULL,
  `notes` TEXT NULL,
  `recorded_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `staff_notifications`;
CREATE TABLE `staff_notifications` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NULL,
  `kind` VARCHAR(255) NULL,
  `title` VARCHAR(255) NULL,
  `body` VARCHAR(255) NULL,
  `route` VARCHAR(255) NULL,
  `ref_type` VARCHAR(255) NULL,
  `ref_id` INT NULL,
  `read_at` DATETIME NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `stock_ledger`;
CREATE TABLE `stock_ledger` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `drug_id` INT NULL,
  `batch_id` INT NULL,
  `txn_type` VARCHAR(255) NULL,
  `qty_delta` DOUBLE NULL,
  `balance_after` DOUBLE NULL,
  `ref_type` VARCHAR(255) NULL,
  `ref_id` INT NULL,
  `notes` TEXT NULL,
  `created_by` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `stock_purchase_items`;
CREATE TABLE `stock_purchase_items` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `purchase_id` INT NULL,
  `drug_id` INT NULL,
  `batch_id` INT NULL,
  `batch_no` VARCHAR(255) NULL,
  `expiry_date` DATE NULL,
  `qty` DOUBLE NULL,
  `free_qty` DOUBLE NULL,
  `purchase_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `mrp` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `tax_pct` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `discount_pct` DOUBLE NULL,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `stock_purchases`;
CREATE TABLE `stock_purchases` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `grn_no` VARCHAR(255) NULL,
  `supplier_id` INT NULL,
  `invoice_no` VARCHAR(255) NULL,
  `invoice_date` DATE NULL,
  `received_at` DATETIME NULL,
  `gross` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `discount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `tax` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `net` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `paid` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `due_date` DATE NULL,
  `status` VARCHAR(100) NULL,
  `notes` TEXT NULL,
  `created_by` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `stock_take_items`;
CREATE TABLE `stock_take_items` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `take_id` INT NULL,
  `drug_id` INT NULL,
  `batch_id` INT NULL,
  `book_qty` DOUBLE NULL,
  `counted_qty` DOUBLE NULL,
  `variance` DOUBLE NULL,
  `reason` VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `stock_takes`;
CREATE TABLE `stock_takes` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `reference` VARCHAR(255) NULL,
  `counted_at` DATETIME NULL,
  `notes` TEXT NULL,
  `counted_by` INT NULL,
  `lines` INT NULL,
  `variances` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `suppliers`;
CREATE TABLE `suppliers` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(100) NULL,
  `name` VARCHAR(255) NULL,
  `contact_person` VARCHAR(255) NULL,
  `phone` VARCHAR(100) NULL,
  `email` VARCHAR(255) NULL,
  `address` TEXT NULL,
  `gstin` VARCHAR(255) NULL,
  `dl_number` VARCHAR(255) NULL,
  `credit_days` INT NULL,
  `notes` TEXT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `staff_code` VARCHAR(100) NULL,
  `name` VARCHAR(255) NULL,
  `email` VARCHAR(255) NULL,
  `phone` VARCHAR(100) NULL,
  `password_hash` VARCHAR(255) NULL,
  `role` VARCHAR(100) NULL,
  `department_id` INT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0,
  `last_login_at` DATETIME NULL,
  `created_at` DATETIME NULL,
  `whatsapp` VARCHAR(100) NULL,
  `password_set_at` DATETIME NULL,
  `password_set_by` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `visit_events`;
CREATE TABLE `visit_events` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `visit_id` INT NULL,
  `stage` VARCHAR(255) NULL,
  `detail` VARCHAR(255) NULL,
  `actor_id` INT NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `visits`;
CREATE TABLE `visits` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `visit_no` VARCHAR(255) NULL,
  `patient_id` INT NULL,
  `appointment_id` INT NULL,
  `doctor_id` INT NULL,
  `department_id` INT NULL,
  `visit_type` VARCHAR(255) NULL,
  `status` VARCHAR(100) NULL,
  `token_no` INT NULL,
  `reason_for_visit` VARCHAR(255) NULL,
  `is_new_patient` TINYINT(1) NOT NULL DEFAULT 0,
  `financial_changed` INT NULL,
  `screening_due` INT NULL,
  `arrived_at` DATETIME NULL,
  `checked_in_at` DATETIME NULL,
  `checked_in_by` INT NULL,
  `vitals_at` DATETIME NULL,
  `consult_start_at` DATETIME NULL,
  `consult_end_at` DATETIME NULL,
  `billing_at` DATETIME NULL,
  `checked_out_at` DATETIME NULL,
  `checked_out_by` INT NULL,
  `exit_pass_no` VARCHAR(255) NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `vitals`;
CREATE TABLE `vitals` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `visit_id` INT NULL,
  `admission_id` INT NULL,
  `patient_id` INT NULL,
  `height_cm` DOUBLE NULL,
  `weight_kg` DOUBLE NULL,
  `bmi` DOUBLE NULL,
  `temp_c` DOUBLE NULL,
  `pulse` INT NULL,
  `resp_rate` INT NULL,
  `bp_systolic` INT NULL,
  `bp_diastolic` INT NULL,
  `spo2` INT NULL,
  `blood_sugar` DOUBLE NULL,
  `pain_score` INT NULL,
  `notes` TEXT NULL,
  `recorded_by` INT NULL,
  `recorded_at` DATETIME NULL,
  `purpose` VARCHAR(255) NULL,
  `amended_at` DATETIME NULL,
  `amended_by` INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `wards`;
CREATE TABLE `wards` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(100) NULL,
  `name` VARCHAR(255) NULL,
  `kind` VARCHAR(255) NULL,
  `floor` VARCHAR(255) NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `whatsapp_messages`;
CREATE TABLE `whatsapp_messages` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `wa_number` VARCHAR(255) NULL,
  `direction` VARCHAR(255) NULL,
  `body` TEXT NULL,
  `message_type` VARCHAR(255) NULL,
  `payload` TEXT,
  `provider_message_id` VARCHAR(255) NULL,
  `status` VARCHAR(100) NULL,
  `error` VARCHAR(255) NULL,
  `created_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `whatsapp_sessions`;
CREATE TABLE `whatsapp_sessions` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `wa_number` VARCHAR(255) NULL,
  `patient_id` INT NULL,
  `state` VARCHAR(255) NULL,
  `context` TEXT NULL,
  `last_message_at` DATETIME NULL,
  `expires_at` DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- Secondary & Performance Indexes
CREATE INDEX `idx_admissions_status` ON `admissions` (`status`);
CREATE INDEX `idx_appt_doctor_time` ON `appointments` (`doctor_id`, `scheduled_at`);
CREATE INDEX `idx_appt_status` ON `appointments` (`status`);
CREATE INDEX `idx_asset_events` ON `asset_events` (`asset_id`, `happened_on`);
CREATE INDEX `idx_assets_cat` ON `assets` (`category`);
CREATE INDEX `idx_assets_due` ON `assets` (`calibration_due`);
CREATE INDEX `idx_audit_created` ON `audit_logs` (`created_at`);
CREATE INDEX `idx_budgets_period` ON `budgets` (`period`);
CREATE INDEX `idx_cash_book_date` ON `cash_book` (`entry_date`);
CREATE INDEX `idx_cash_book_dir` ON `cash_book` (`direction`, `entry_date`);
CREATE INDEX `idx_claims_patient` ON `claims` (`patient_id`);
CREATE INDEX `idx_claims_status` ON `claims` (`status`);
CREATE INDEX `idx_complaints` ON `complaints` (`status`, `received_on`);
CREATE INDEX `idx_compliance` ON `compliance_items` (`valid_till`);
CREATE INDEX `idx_consult_patient` ON `consultations` (`patient_id`);
CREATE INDEX `idx_avail_doctor_date` ON `doctor_availability` (`doctor_id`, `avail_date`);
CREATE INDEX `idx_doc_shares_made` ON `document_shares` (`created_at`);
CREATE INDEX `idx_doc_shares_ref` ON `document_shares` (`kind`, `ref_id`);
CREATE INDEX `idx_batches_expiry` ON `drug_batches` (`expiry_date`);
CREATE INDEX `idx_drugs_name` ON `drugs` (`name`);
CREATE INDEX `idx_enquiries_status` ON `enquiries` (`status`);
CREATE INDEX `idx_screen_status` ON `financial_screenings` (`status`);
CREATE INDEX `idx_hygiene` ON `hygiene_rounds` (`on_date`, `area`);
CREATE INDEX `idx_invoices_patient` ON `invoices` (`patient_id`);
CREATE INDEX `idx_invoices_status` ON `invoices` (`status`);
CREATE INDEX `idx_ipnotes_admission` ON `ip_notes` (`admission_id`);
CREATE INDEX `idx_lab_orders_status` ON `lab_orders` (`status`);
CREATE INDEX `idx_positions` ON `ledger_positions` (`as_on`);
CREATE INDEX `idx_notif_status` ON `notifications` (`status`, `scheduled_at`);
CREATE INDEX `idx_owner_actions` ON `owner_actions` (`status`, `due_date`);
CREATE INDEX `idx_resets_user` ON `password_resets` (`user_id`);
CREATE INDEX `idx_history_patient` ON `patient_history` (`patient_id`);
CREATE INDEX `idx_patient_notes` ON `patient_notes` (`patient_id`, `id` DESC);
CREATE INDEX `idx_policies_patient` ON `patient_policies` (`patient_id`);
CREATE INDEX `idx_patients_name` ON `patients` (`first_name`, `last_name`);
CREATE INDEX `idx_patients_phone` ON `patients` (`phone`);
CREATE INDEX `idx_patients_whatsapp` ON `patients` (`whatsapp`);
CREATE INDEX `idx_payroll` ON `payroll_lines` (`period`);
CREATE INDEX `idx_preauth_patient` ON `preauths` (`patient_id`);
CREATE INDEX `idx_preauth_status` ON `preauths` (`status`);
CREATE INDEX `idx_rx_dx_sheet` ON `prescription_diagnoses` (`sheet_id`, `sort_order`);
CREATE INDEX `idx_rx_sheet_doctor` ON `prescription_sheets` (`doctor_id`, `created_at`);
CREATE INDEX `idx_rx_sheet_patient` ON `prescription_sheets` (`patient_id`);
CREATE INDEX `idx_rx_visit` ON `prescriptions` (`visit_id`);
CREATE INDEX `idx_incidents` ON `safety_incidents` (`status`, `happened_on`);
CREATE INDEX `idx_attendance_date` ON `staff_attendance` (`on_date`);
CREATE INDEX `idx_staff_notif` ON `staff_notifications` (`user_id`, `read_at`, `id`);
CREATE INDEX `idx_ledger_drug` ON `stock_ledger` (`drug_id`, `created_at`);
CREATE INDEX `idx_purchases_supplier` ON `stock_purchases` (`supplier_id`);
CREATE INDEX `idx_visit_events_visit` ON `visit_events` (`visit_id`);
CREATE INDEX `idx_visits_patient` ON `visits` (`patient_id`);
CREATE INDEX `idx_visits_status` ON `visits` (`status`);
CREATE INDEX `idx_vitals_patient` ON `vitals` (`patient_id`);
CREATE INDEX `idx_wa_msgs_number` ON `whatsapp_messages` (`wa_number`, `created_at`);

-- Compatibility function for SQLite julianday()
DROP FUNCTION IF EXISTS `julianday`;
DELIMITER ;;
CREATE FUNCTION `julianday`(d VARCHAR(255))
RETURNS DOUBLE
DETERMINISTIC
NO SQL
BEGIN
  IF d IS NULL THEN RETURN NULL; END IF;
  IF d = 'now' THEN RETURN UNIX_TIMESTAMP(NOW()) / 86400.0 + 2440587.5; END IF;
  RETURN UNIX_TIMESTAMP(d) / 86400.0 + 2440587.5;
END;;
DELIMITER ;

