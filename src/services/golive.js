'use strict';
const { db } = require('../db');

/**
 * Clearing the demo data and handing the clinic a live system.
 *
 * This system is shipped with a working demonstration in it: invented staff,
 * invented doctors, sample patients, and whatever was entered while it was
 * being tried out. None of that belongs in a clinic that has started seeing
 * real people, and it cannot be fixed by changing the seed — the seed only
 * decides what a *new* database gets, and the one the clinic is running
 * already has it all.
 *
 * So this empties the clinic's day-to-day record and keeps everything it was
 * set up with. The line is between what the clinic *is* and what has *happened
 * in* it:
 *
 *   kept    — departments, wards and beds, the diagnostic catalogue and the
 *             rate card, the formulary and the stock on the shelf, insurers
 *             and TPAs, the ICD list, the sliding-scale bands and assistance
 *             programmes, and the administrator.
 *   cleared — patients and every record hanging off one, appointments, visits,
 *             invoices, receipts, lab orders, prescriptions, admissions,
 *             pharmacy sales, enquiries, claims and messages.
 *
 * This is irreversible, and a backup is taken first for the case where it is
 * run by somebody who did not understand that.
 */

/*
 * Written out one by one rather than derived, and in the order a foreign key
 * needs. A list of tables to *keep* would be the dangerous way round: add a
 * table next month, forget to list it, and the clinic's new records are
 * silently wiped by a routine somebody ran for an unrelated reason. Listed
 * this way, a table nobody thought about is simply left alone.
 */
const OPERATIONAL = [
  // What happened to a patient, innermost first.
  'ip_medication_admin', 'ip_medication_orders', 'ip_notes', 'ip_charges',
  'bed_transfers', 'admissions',
  'consultation_diagnoses', 'consultations',
  'prescription_diagnoses', 'prescriptions', 'prescription_sheets',
  'lab_samples', 'lab_order_items', 'lab_orders',
  'vitals', 'visit_events', 'visits', 'appointments',
  'patient_notes', 'patient_history',
  // Money.
  'payment_plan_installments', 'payment_plans', 'payment_exceptions',
  'payments', 'invoice_items', 'invoices',
  'pharmacy_sale_items', 'pharmacy_sales',
  // Insurance.
  'claim_events', 'claim_items', 'claims',
  'preauth_events', 'preauths', 'insurance_documents', 'patient_policies',
  // Means testing.
  'financial_screenings',
  // The people themselves.
  'patients', 'enquiries',
  // Conversations and alerts about them.
  'whatsapp_messages', 'whatsapp_sessions', 'notifications', 'staff_notifications',
];

/*
 * The shelf is deliberately not here. A clinic that has been trying the system
 * out has also been counting its real stock into it, and the opening quantity
 * is the clinic's own figure from its own shelf — throwing that away would
 * mean counting the whole pharmacy again. Purchases and stock-takes are
 * movements against that stock and stay with it.
 */

/*
 * What is on the staff list that came out of the box rather than from the
 * clinic.
 *
 * Two tests, because one is not enough. The staff codes are the accounts this
 * repository has seeded; the address is the giveaway for the rest —
 * `samiha.local` is not a real mail domain and nobody at the clinic has an
 * address there. Between them they catch the four extra doctors an older
 * version of the seed left behind, which a list of codes written today would
 * have missed.
 */
const DEMO_STAFF_CODES = [
  'REC01', 'CNS01', 'NUR01', 'LAB01', 'PHR01', 'CSH01', 'WRD01',
  'DOC01', 'DOC02', 'DOC03',
];
const DEMO_EMAIL_DOMAIN = '@samiha.local';

/*
 * A departing account's loose ends, in the tables that are *not* cleared.
 *
 * Their way in goes with them.
 */
const GONE_WITH_THEM = [
  ['sessions', 'user_id'],
  ['password_resets', 'user_id'],
];

/*
 * What they did stays, with the name cut loose from the deleted row. These
 * are the surviving tables that point at a user; everything else pointing at
 * one is in OPERATIONAL above and has already gone.
 */
const KEEPS_THE_RECORD = [
  ['audit_logs', 'user_id'],
  ['backups', 'created_by'],
  ['stock_ledger', 'created_by'],
  ['stock_purchases', 'created_by'],
  ['stock_takes', 'counted_by'],
];

const countOf = (table) => {
  try { return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c; }
  catch { return 0; }  // A table this build does not have is nothing to clear.
};

/**
 * Demo staff still on the list.
 *
 * Never the account asking — an administrator must not be able to delete the
 * account they are signed in with — and never the last administrator standing,
 * because a clinic locked out of its own system has no way back in.
 */
function demoStaff(exceptUserId) {
  const rows = db.prepare(
    `SELECT id, staff_code, name, role, email FROM users
      WHERE (staff_code IN (${DEMO_STAFF_CODES.map(() => '?').join(',')})
             OR LOWER(COALESCE(email, '')) LIKE ?)
        AND id != ?
      ORDER BY id`
  ).all(...DEMO_STAFF_CODES, `%${DEMO_EMAIL_DOMAIN}`, exceptUserId || -1);

  const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
  const goingAdmins = rows.filter((r) => r.role === 'admin').length;
  if (goingAdmins && admins - goingAdmins < 1) {
    // Keep the newest administrator of the set rather than refusing outright:
    // the clinic asked to be rid of the demo, not to be locked out of it.
    const last = rows.filter((r) => r.role === 'admin').pop();
    return rows.filter((r) => r.id !== last.id);
  }
  return rows;
}

/** What clearing would remove, without removing any of it. */
function plan(exceptUserId) {
  const tables = OPERATIONAL
    .map((table) => ({ table, rows: countOf(table) }))
    .filter((t) => t.rows > 0);
  const staff = demoStaff(exceptUserId);
  return {
    tables,
    rows: tables.reduce((t, x) => t + x.rows, 0),
    staff,
    patients: countOf('patients'),
    kept: {
      departments: countOf('departments'),
      beds: countOf('beds'),
      labTests: countOf('lab_tests'),
      services: countOf('services'),
      drugs: countOf('drugs'),
      insurers: countOf('insurers'),
      users: countOf('users') - staff.length,
    },
  };
}

/**
 * Do it. The caller is excluded from the staff sweep so the administrator
 * running this cannot delete the account they are signed in with — and the
 * counters are reset so the first real patient is UHID 1 rather than 6.
 */
function apply(exceptUserId) {
  const before = plan(exceptUserId);

  db.transaction(() => {
    // Foreign keys are enforced, and the list is ordered innermost first, so
    // anything out of order fails loudly here rather than leaving an orphan.
    for (const { table } of before.tables) db.prepare(`DELETE FROM ${table}`).run();

    for (const s of before.staff) {
      // A doctor's profile, sessions and leave go with them.
      for (const t of ['doctor_availability', 'doctor_leaves', 'doctor_schedules', 'doctor_profiles']) {
        try { db.prepare(`DELETE FROM ${t} WHERE ${t === 'doctor_profiles' ? 'user_id' : 'doctor_id'} = ?`).run(s.id); }
        catch { /* not a doctor */ }
      }
      for (const [t, col] of GONE_WITH_THEM) {
        try { db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(s.id); } catch { /* absent */ }
      }
      /*
       * Everything else that names them is a record of something they did,
       * and it outlives the account: the audit log is the answer to "who did
       * this", and a stock movement has to keep saying somebody made it. The
       * reference is cleared and the entry stays — `audit_logs.actor` already
       * holds the name and role as text, which is what a reader needs.
       */
      for (const [t, col] of KEEPS_THE_RECORD) {
        try { db.prepare(`UPDATE ${t} SET ${col} = NULL WHERE ${col} = ?`).run(s.id); }
        catch { /* absent */ }
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(s.id);
    }

    // Numbering starts again, because a clinic's first invoice should be 1.
    try { db.prepare("UPDATE counters SET value = 0").run(); } catch { /* no counters table */ }
  })();

  return before;
}

module.exports = { plan, apply, OPERATIONAL, DEMO_STAFF_CODES, DEMO_EMAIL_DOMAIN };
