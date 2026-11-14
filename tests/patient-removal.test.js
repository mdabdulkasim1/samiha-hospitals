'use strict';
/**
 * Taking a record off that was never a patient.
 *
 * Every other screen in this ERP refuses to delete a patient, and should:
 * somebody who has been seen here has a medical record, and that is not the
 * clinic's to tidy away. But a clinic setting the system up types two or
 * three people in to watch the screens work, and those rows sit at the top
 * of the register for ever, making every count wrong and waiting for
 * somebody to book a real appointment against one of them.
 *
 * So the line has to be drawn exactly: nothing behind the record and it can
 * go; anything at all behind it and it cannot, with the reasons named. The
 * check reads the database's own foreign keys rather than a list kept by
 * hand, because a hand-kept list rots the first time a table is added and
 * the failure mode is a patient's visit quietly deleted along with them.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-prm-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');
const scheduling = require('../src/services/scheduling');

let server;
let base;
const tokens = {};
const ids = {};

async function api(method, p, body, as = 'owner') {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tokens[as] ? { Authorization: `Bearer ${tokens[as]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const register = async (first, phone) => (await api('POST', '/api/patients', {
  firstName: first, phone, gender: 'male', age: 40, consentTreatment: true,
}, 'reception')).body;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['admin', 'reception', 'cashier']) {
    tokens[who] = (await api('POST', '/api/auth/login',
      { username: `${who}@samiha.local`, password: 'samiha@123' }, null)).body.token;
  }
  const owner = await api('POST', '/api/masters/staff',
    { name: 'Mohamed Kasim', role: 'owner', password: 'Samiha#Owner1' }, 'admin');
  const code = db.prepare('SELECT staff_code FROM users WHERE id = ?').get(owner.body.id).staff_code;
  tokens.owner = (await api('POST', '/api/auth/login',
    { username: code, password: 'Samiha#Owner1' }, null)).body.token;

  ids.demo = await register('kasim', '917358947474');
  ids.seen = await register('Rafeek', '919500717856');
  ids.doctor = db.prepare("SELECT id FROM users WHERE email = 'imran@samiha.local'").get().id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const exists = (id) => Boolean(db.prepare('SELECT 1 FROM patients WHERE id = ?').get(id));

test('a record with nothing behind it can be taken off', async () => {
  const plan = await api('GET', `/api/patients/${ids.demo.id}/removal`);
  assert.strictEqual(plan.status, 200, JSON.stringify(plan.body));
  assert.strictEqual(plan.body.canRemove, true);
  assert.deepStrictEqual(plan.body.blocks, [], 'nothing points at it');
  assert.strictEqual(plan.body.uhid, ids.demo.uhid);

  const gone = await api('DELETE', `/api/patients/${ids.demo.id}`,
    { confirm: ids.demo.uhid, reason: 'Entered to try the system out' });
  assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
  assert.strictEqual(gone.body.removed, true);
  assert.strictEqual(exists(ids.demo.id), false, 'the row is gone, not hidden');
  assert.strictEqual(db.pragma('foreign_key_check').length, 0, 'and nothing is left dangling');
});

test('the UHID has to be typed, and a reason given', async () => {
  const p = await register('Typo', '919000000091');
  assert.strictEqual((await api('DELETE', `/api/patients/${p.id}`,
    { confirm: 'SPD9999', reason: 'wrong' })).status, 400);
  assert.strictEqual((await api('DELETE', `/api/patients/${p.id}`,
    { confirm: p.uhid })).status, 400, 'a reason is required');
  assert.strictEqual(exists(p.id), true, 'and nothing happened');
});

test('a patient the clinic has seen cannot be removed, and it says why', async () => {
  // One booking is enough to make this somebody's record.
  const appt = await api('POST', '/api/appointments', {
    doctorId: ids.doctor, scheduledAt: `${scheduling.dateKey(new Date())} 10:30:00`,
    patientId: ids.seen.id, reason: 'Cough',
  }, 'reception');
  assert.strictEqual(appt.status, 201, JSON.stringify(appt.body));

  const plan = await api('GET', `/api/patients/${ids.seen.id}/removal`);
  assert.strictEqual(plan.body.canRemove, false);
  assert.ok(plan.body.blocks.some((b) => /appointment/.test(b.what)), 'the booking is named');

  const refused = await api('DELETE', `/api/patients/${ids.seen.id}`,
    { confirm: ids.seen.uhid, reason: 'Trying anyway' });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.body.error, /records for/i);
  assert.match(refused.body.error, /never deleted/i);
  assert.strictEqual(exists(ids.seen.id), true, 'the patient stays');
});

test('a bill alone is enough to make it a patient\'s record', async () => {
  const p = await register('Billed Once', '919000000092');
  const inv = await api('POST', '/api/billing/invoices', { patientId: p.id, kind: 'opd' }, 'cashier');
  assert.strictEqual(inv.status, 201, JSON.stringify(inv.body));

  const refused = await api('DELETE', `/api/patients/${p.id}`,
    { confirm: p.uhid, reason: 'Demo' });
  assert.strictEqual(refused.status, 400);
  assert.ok(refused.body.details.references.some((r) => /invoice/.test(r.what)));
});

test('what cascades away with the record is listed first', async () => {
  const p = await register('With Notes', '919000000093');
  const note = await api('POST', `/api/patients/${p.id}/notes`,
    { note: 'Asked for an evening slot' }, 'reception');
  assert.strictEqual(note.status, 201, JSON.stringify(note.body));

  const plan = await api('GET', `/api/patients/${p.id}/removal`);
  assert.strictEqual(plan.body.canRemove, true, 'a note is not care given');
  assert.ok(plan.body.goesWith.some((g) => /note/.test(g.what)), 'and it is named as going too');

  const gone = await api('DELETE', `/api/patients/${p.id}`,
    { confirm: p.uhid, reason: 'Entered twice by mistake' });
  assert.strictEqual(gone.status, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM patient_notes WHERE patient_id = ?')
    .get(p.id).c, 0);
  assert.strictEqual(db.pragma('foreign_key_check').length, 0);
});

test('it is the owner\'s alone', async () => {
  const p = await register('Not Yours', '919000000094');
  for (const who of ['admin', 'reception', 'cashier']) {
    assert.strictEqual((await api('GET', `/api/patients/${p.id}/removal`, undefined, who)).status, 403, who);
    assert.strictEqual((await api('DELETE', `/api/patients/${p.id}`,
      { confirm: p.uhid, reason: 'x' }, who)).status, 403, who);
  }
  assert.strictEqual(exists(p.id), true);
});

test('the removal is on the record, with what went with it', async () => {
  const p = await register('Audited Away', '919000000095');
  await api('DELETE', `/api/patients/${p.id}`, { confirm: p.uhid, reason: 'Demo row' });

  const row = db.prepare(
    "SELECT * FROM audit_logs WHERE entity = 'patient' AND action = 'delete' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row);
  assert.strictEqual(row.entity_id, p.id);
  const details = JSON.parse(row.details);
  assert.strictEqual(details.uhid, p.uhid);
  assert.strictEqual(details.reason, 'Demo row');
  assert.match(row.actor, /Kasim|owner/i, 'and the owner who did it');
});

test('a WhatsApp chat matched to the record is cut loose, not deleted', async () => {
  const p = await register('Chatty', '919000000096');
  db.prepare(
    `INSERT INTO whatsapp_sessions (wa_number, state, context, expires_at, patient_id)
     VALUES ('919000000096', 'idle', '{}', datetime('now', '+1 hour'), ?)`).run(p.id);

  const plan = await api('GET', `/api/patients/${p.id}/removal`);
  assert.strictEqual(plan.body.canRemove, true, 'a chat is not care given');
  assert.ok(plan.body.detach.length, 'and it is named as being cut loose');

  assert.strictEqual((await api('DELETE', `/api/patients/${p.id}`,
    { confirm: p.uhid, reason: 'Demo' })).status, 200);

  const chat = db.prepare("SELECT * FROM whatsapp_sessions WHERE wa_number = '919000000096'").get();
  assert.ok(chat, 'the conversation is still there');
  assert.strictEqual(chat.patient_id, null, 'no longer pointing at a record that has gone');
  assert.strictEqual(db.pragma('foreign_key_check').length, 0);
});

test('the check reads the schema, so a new table cannot be forgotten', () => {
  /*
   * The guard that matters most and is hardest to see. If this were a
   * hand-kept list of tables, the first table added that points at a
   * patient would not be on it, and a patient with records in that table
   * would be deletable. It is read from the foreign keys instead, so this
   * test asserts the breadth rather than any one table.
   */
  const removal = require('../src/services/patientRemoval');
  const counted = new Set();
  const p = db.prepare('SELECT id FROM patients ORDER BY id LIMIT 1').get();
  const { blocks, goesWith, detach } = removal.references(p.id);
  for (const r of [...blocks, ...goesWith, ...detach]) counted.add(r.table);

  const pointing = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .filter(({ name }) => db.pragma(`foreign_key_list("${name}")`).some((fk) => fk.table === 'patients'));
  assert.ok(pointing.length >= 20, `every table that points at a patient is examined (${pointing.length})`);
});
