'use strict';
/**
 * Taking a person out of the records, and leaving the records.
 *
 * A clinic sometimes has to remove somebody completely: a sample account
 * created while the system was being set up, a locum who asks for their
 * details to be deleted, a name entered wrongly and billed against for a
 * month before anybody noticed.
 *
 * Deleting the row is not available, and the reason is worth stating plainly
 * rather than hiding behind an error message. A consultation, a prescription,
 * a laboratory result and a bill all point at the user who made them, and
 * several of those references cannot be empty. Deleting the person therefore
 * means deleting the consultation — which is a patient's medical record, not
 * the staff member's to take with them when they go.
 *
 * So what happens instead is erasure. Everything that says who the person
 * was goes: their name, email, telephone, WhatsApp number, their signature,
 * their qualification and registration number, their way of signing in. What
 * stays is the work and the code it was done under — SPC-IMR-001 and EMP0014
 * — which identifies the worker to the clinic's own files without naming them
 * on anything that leaves the building. That is the posture every printed
 * document here already takes: a prescription and a bill carry the doctor's
 * code and never their name.
 *
 * Only the owner may do it. Not the administrator: an administrator can
 * already create and disable accounts, and removing a person's name from
 * the audit trail of their own work is a different kind of act — the one
 * thing an administrator must not be able to do quietly to cover their own
 * tracks.
 */
const crypto = require('crypto');
const { db } = require('../db');
const { hashPassword } = require('../lib/auth');
const { badRequest, notFound, conflict } = require('../lib/http');

/** What a person is called once their name has gone. */
const tombstone = (staffCode) => `Former staff ${staffCode}`;

/**
 * What the clinic will still be able to see about this person afterwards.
 *
 * Shown before the owner confirms, because "their related data stays" is
 * easy to say and worth proving: this is the list of what keeps pointing at
 * the account, and all of it survives.
 */
function preview(id) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw notFound('Staff member not found');
  const profile = db.prepare('SELECT * FROM doctor_profiles WHERE user_id = ?').get(id) || {};

  const count = (sql, ...params) => {
    try { return db.prepare(sql).get(...params).c; } catch { return 0; }
  };
  const keeps = [
    ['consultations', count('SELECT COUNT(*) AS c FROM consultations WHERE doctor_id = ?', id)],
    ['prescriptions', count('SELECT COUNT(*) AS c FROM prescription_sheets WHERE doctor_id = ?', id)],
    ['visits as the treating doctor', count('SELECT COUNT(*) AS c FROM visits WHERE doctor_id = ?', id)],
    ['appointments', count('SELECT COUNT(*) AS c FROM appointments WHERE doctor_id = ?', id)],
    ['diagnostic reports verified', count('SELECT COUNT(*) AS c FROM lab_orders WHERE verified_by = ?', id)],
    ['bills raised', count('SELECT COUNT(*) AS c FROM invoices WHERE created_by = ?', id)],
    ['payments taken', count('SELECT COUNT(*) AS c FROM payments WHERE received_by = ?', id)],
    ['pharmacy bills', count('SELECT COUNT(*) AS c FROM pharmacy_sales WHERE created_by = ?', id)],
    ['cash book entries', count('SELECT COUNT(*) AS c FROM cash_book WHERE created_by = ?', id)],
    ['audit trail entries', count('SELECT COUNT(*) AS c FROM audit_logs WHERE user_id = ?', id)],
  ].filter(([, n]) => n > 0).map(([what, n]) => ({ what, count: n }));

  return {
    id,
    name: user.name,
    staffCode: user.staff_code,
    doctorCode: profile.doctor_code || null,
    role: user.role,
    active: user.active,
    erasedAt: user.erased_at || null,
    becomes: tombstone(user.staff_code),
    keeps,
    /*
     * The one thing erasure does not reach, said up front rather than
     * discovered later. A prescription that was signed carries the image of
     * the signature on the sheet itself — that is the issued document, and
     * altering one after it has gone to a patient and an insurer is not
     * something this will do quietly. The stored signature goes, so nothing
     * further can be signed with it.
     */
    caveats: [
      ...(db.prepare(
        'SELECT COUNT(*) AS c FROM prescription_sheets WHERE doctor_id = ? AND signature_image IS NOT NULL')
        .get(id).c
        ? [`${db.prepare('SELECT COUNT(*) AS c FROM prescription_sheets WHERE doctor_id = ? AND signature_image IS NOT NULL').get(id).c} `
          + 'prescription(s) already issued carry their signature on the sheet. Those sheets are '
          + 'left exactly as they were sent — the stored signature is cleared so nothing further '
          + 'can be signed with it.']
        : []),
      'WhatsApp messages already sent to patients may name them in the text. Those are messages '
        + 'that have left the building and are not rewritten.',
    ],
  };
}

/**
 * Erase the person.
 *
 * Everything in one transaction, because a half-erased account — name gone
 * from the user record but still on every audit line — is worse than either
 * outcome.
 */
function erase(id, { reason, by }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw notFound('Staff member not found');
  if (user.erased_at) throw conflict('This person has already been removed from the records.');
  if (!String(reason || '').trim()) throw badRequest('Say why this person is being removed.');
  if (id === by) throw badRequest('You cannot remove yourself from the records.');

  // The clinic must never be left with no way in.
  if (['owner', 'admin'].includes(user.role)) {
    const { n } = db.prepare(
      `SELECT COUNT(*) AS n FROM users
        WHERE role IN ('owner','admin') AND active = 1 AND erased_at IS NULL AND id != ?`).get(id);
    if (!n) {
      throw badRequest('This is the last account that can administer the clinic. '
        + 'Add another before removing this one.');
    }
  }

  const name = tombstone(user.staff_code);
  const note = String(reason).trim();

  db.transaction(() => {
    db.prepare(
      `UPDATE users
          SET name = ?, email = NULL, phone = NULL, whatsapp = NULL,
              password_hash = ?, active = 0,
              erased_at = datetime('now'), erased_by = ?, erase_reason = ?
        WHERE id = ?`
    ).run(name, hashPassword(crypto.randomBytes(24).toString('hex')), by || null, note, id);

    // No way back in, and no session still open on the way out.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);

    // The professional identity: qualification, registration, the signature.
    // The code stays — every document already printed carries it — and so do
    // the fees and slot length, which are the clinic's settings rather than
    // the person's details.
    db.prepare(
      `UPDATE doctor_profiles
          SET qualification = NULL, specialization = NULL, reg_no = NULL, room_no = NULL,
              signature_line = NULL, signature_image = NULL
        WHERE user_id = ?`).run(id);

    // Their rota comes off the booking menu; the bookings already made keep
    // pointing at the account, as everything else does.
    db.prepare('UPDATE doctor_schedules SET active = 0 WHERE doctor_id = ?').run(id);

    /*
     * The audit trail keeps the actor's name as plain text, so that every
     * line still reads after an account is deleted. Which means the name
     * survives erasure unless it is rewritten here — and an erasure that
     * leaves the name on four thousand audit lines has not erased anything.
     * The line itself stays, under the code.
     */
    db.prepare('UPDATE audit_logs SET actor = ? WHERE user_id = ?').run(`${name} (${user.role})`, id);
    db.prepare('UPDATE audit_logs SET actor = ? WHERE actor = ?')
      .run(`${name} (${user.role})`, `${user.name} (${user.role})`);
  })();

  return db.prepare(
    'SELECT id, name, staff_code, role, active, erased_at, erase_reason FROM users WHERE id = ?').get(id);
}

/** Everyone who has been taken out of the records, and by whom. */
const erased = () => db.prepare(
  `SELECT u.id, u.name, u.staff_code, u.role, u.erased_at, u.erase_reason,
          b.name AS erased_by_name, dp.doctor_code
     FROM users u
     LEFT JOIN users b ON b.id = u.erased_by
     LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
    WHERE u.erased_at IS NOT NULL
    ORDER BY datetime(u.erased_at) DESC`).all();

module.exports = { preview, erase, erased, tombstone };
