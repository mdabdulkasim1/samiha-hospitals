'use strict';
/**
 * Taking a patient record off the system altogether.
 *
 * Nothing else in this ERP deletes a patient, and that is the right default:
 * a person who has been seen here has a medical record, and a medical record
 * is not the clinic's to tidy away. Everything about a real patient is
 * corrected in place or marked, never removed.
 *
 * But a clinic setting a system up types in two or three people to see what
 * the screens do, and those are not patients. They are test rows sitting at
 * the top of the register with a UHID that will never be used, and leaving
 * them there means every count of "patients registered" is wrong for ever
 * and somebody, one day, books a real appointment against "kasim".
 *
 * So the rule is: a record with nothing behind it can go, and a record with
 * anything behind it cannot. What counts as "anything" is read from the
 * database's own foreign keys rather than from a list kept by hand — a list
 * would rot the first time a table was added, and the failure would be a
 * patient's visit quietly deleted along with them.
 */
const { db } = require('../db');
const { badRequest, notFound } = require('../lib/http');

/*
 * The two references that do not mean the patient has been treated.
 *
 * A WhatsApp conversation is a chat that happened to be matched to a file;
 * the messages stay, under the number, which is how every chat from a
 * stranger is already held. A patient's own history of stage changes is
 * about the record rather than about any care given.
 */
const SOFT = new Set(['whatsapp_sessions.patient_id']);

/** English for a table name: "lab order", not "lab_orders". */
const singular = (table) => table.replace(/_/g, ' ')
  .replace(/ies$/, 'y').replace(/ses$/, 's').replace(/s$/, '');

/**
 * Everywhere this patient is still pointed at, worked out from the schema.
 *
 * `blocks` is anything that means they were treated, billed or booked.
 * `goesWith` cascades away with the row — their notes, their stage history,
 * their insurance policies. `detach` is cut loose and left behind.
 */
function references(id) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();

  const blocks = [];
  const goesWith = [];
  const detach = [];

  for (const { name } of tables) {
    for (const fk of db.pragma(`foreign_key_list("${name}")`)) {
      if (fk.table !== 'patients') continue;
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE "${fk.from}" = ?`).get(id);

      if (String(fk.on_delete || '').toUpperCase() === 'CASCADE') {
        if (n) goesWith.push({ table: name, what: n === 1 ? singular(name) : name.replace(/_/g, ' '), count: n });
        continue;
      }
      if (SOFT.has(`${name}.${fk.from}`)) {
        if (n) detach.push({ table: name, column: fk.from, count: n });
        continue;
      }
      if (n) blocks.push({ table: name, what: n === 1 ? singular(name) : name.replace(/_/g, ' '), count: n });
    }
  }
  return { blocks, goesWith, detach };
}

/** What would happen, shown before the owner commits to it. */
function preview(id) {
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!patient) throw notFound('Patient not found');
  const { blocks, goesWith, detach } = references(id);
  return {
    id,
    uhid: patient.uhid,
    name: `${patient.first_name || ''} ${patient.last_name || ''}`.trim(),
    phone: patient.phone,
    stage: patient.stage,
    registeredAt: patient.created_at,
    blocks,
    goesWith,
    detach: detach.map((d) => ({ what: d.table.replace(/_/g, ' '), count: d.count })),
    canRemove: blocks.length === 0,
  };
}

/**
 * Remove the record.
 *
 * Refused outright the moment anything clinical or financial points at it,
 * and the refusal says what — because the answer to "this one has a visit
 * on it" is not to try harder, it is that this is a patient and not a test
 * row.
 */
function remove(id, { reason, by }) {
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!patient) throw notFound('Patient not found');
  if (!String(reason || '').trim()) throw badRequest('Say why this record is being removed.');

  const { blocks, goesWith, detach } = references(id);
  if (blocks.length) {
    const list = blocks.map((b) => `${b.count} ${b.what}`).join(', ');
    throw badRequest(
      `${patient.uhid} cannot be removed — this is a patient the clinic has records for: ${list}. `
      + 'A record with care behind it is corrected, never deleted.',
      { references: blocks }
    );
  }

  db.transaction(() => {
    for (const { table, column } of detach) {
      db.prepare(`UPDATE "${table}" SET "${column}" = NULL WHERE "${column}" = ?`).run(id);
    }
    db.prepare('DELETE FROM patients WHERE id = ?').run(id);
  })();

  return {
    removed: true,
    id,
    uhid: patient.uhid,
    name: `${patient.first_name || ''} ${patient.last_name || ''}`.trim(),
    cascaded: goesWith,
    detached: detach,
    by: by || null,
  };
}

module.exports = { preview, remove, references };
