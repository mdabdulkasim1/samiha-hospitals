'use strict';
/**
 * Taking a person out of the records, and leaving the records.
 *
 * Deleting a staff account is refused the moment somebody has treated a
 * patient, because the consultation points at them and several of those
 * references cannot be empty — deleting the person would mean deleting the
 * patient's record of being treated.
 *
 * So the owner gets the other answer: erase who they were, keep what they
 * did. These tests are about both halves of that sentence holding at once.
 * The name has to be gone from everywhere it was written down, including
 * the audit trail, which keeps it as plain text precisely so that it
 * survives a deleted account. And the consultation, the prescription, the
 * bill and the result have to still be there afterwards, still pointing at
 * the same account, still readable.
 *
 * And it is the owner's alone. An administrator can already create and
 * disable accounts; taking a name off the audit trail of its own work is
 * the one thing they must not be able to do quietly.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-erase-'));
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

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  for (const who of ['admin', 'reception', 'cashier']) {
    tokens[who] = (await api('POST', '/api/auth/login',
      { username: `${who}@samiha.local`, password: 'samiha@123' }, null)).body.token;
  }

  // The clinic's owner, who is the only one this screen belongs to.
  const owner = await api('POST', '/api/masters/staff',
    { name: 'Mohamed Kasim', role: 'owner', password: 'Samiha#Owner1' }, 'admin');
  assert.strictEqual(owner.status, 201, JSON.stringify(owner.body));
  ids.owner = owner.body.id;
  const ownerCode = db.prepare('SELECT staff_code FROM users WHERE id = ?').get(ids.owner).staff_code;
  tokens.owner = (await api('POST', '/api/auth/login',
    { username: ownerCode, password: 'Samiha#Owner1' }, null)).body.token;

  /*
   * A doctor who has actually worked: an appointment, a visit, a
   * prescription and an audit trail of their own. Deleting them is refused
   * today, which is the whole reason this exists.
   */
  const doctor = await api('POST', '/api/masters/staff', {
    name: 'Dr. Bashir Ahmed', role: 'doctor', password: 'Samiha#Doc1',
    email: 'bashir@samiha.local', phone: '9840110099',
    departmentId: db.prepare("SELECT id FROM departments WHERE code = 'IM'").get().id,
    qualification: 'MBBS, MD', regNo: 'TN-44219', consultFee: 200,
  }, 'owner');
  assert.strictEqual(doctor.status, 201, JSON.stringify(doctor.body));
  ids.doctor = doctor.body.id;
  ids.doctorCode = db.prepare('SELECT staff_code FROM users WHERE id = ?').get(ids.doctor).staff_code;

  tokens.doctor = (await api('POST', '/api/auth/login',
    { username: 'bashir@samiha.local', password: 'Samiha#Doc1' }, null)).body.token;

  ids.patient = (await api('POST', '/api/patients', {
    firstName: 'Lakshmi', lastName: 'Narayanan', phone: '9845030011', gender: 'female',
    age: 52, consentTreatment: true,
  }, 'reception')).body.id;

  await api('POST', '/api/appointments', {
    doctorId: ids.doctor, scheduledAt: `${scheduling.dateKey(new Date())} 11:00:00`,
    patientId: ids.patient, reason: 'Fever',
  }, 'reception');

  const drug = (await api('GET', '/api/pharmacy/drugs?limit=20', undefined, 'doctor')).body[0];
  const rx = await api('POST', '/api/prescriptions', {
    patientId: ids.patient, complaints: 'Fever three days',
    items: [{ drugId: drug.id, doseMorning: 1, durationDays: 3 }],
  }, 'doctor');
  assert.strictEqual(rx.status, 201, JSON.stringify(rx.body));
  ids.sheet = rx.body.id;
  ids.rxNo = rx.body.rx_no;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const userRow = () => db.prepare('SELECT * FROM users WHERE id = ?').get(ids.doctor);

// ------------------------------------------------------------------- who may
test('deleting a doctor who has treated somebody is still refused', async () => {
  const r = await api('DELETE', `/api/masters/staff/${ids.doctor}`, undefined, 'admin');
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /cannot be deleted/i);
  assert.ok(r.body.details.references.length, 'and it says what is holding the account');
});

test('removing the name is the owner\'s, not the administrator\'s', async () => {
  for (const who of ['admin', 'reception', 'cashier']) {
    const peek = await api('GET', `/api/masters/staff/${ids.doctor}/erasure`, undefined, who);
    assert.strictEqual(peek.status, 403, `${who} cannot even look`);
    const go = await api('POST', `/api/masters/staff/${ids.doctor}/erase`,
      { confirm: ids.doctorCode, reason: 'trying it on' }, who);
    assert.strictEqual(go.status, 403, `${who} cannot do it`);
  }
  assert.strictEqual(userRow().name, 'Dr. Bashir Ahmed', 'and nothing happened');
});

test('what will survive is shown before anything is done', async () => {
  const r = await api('GET', `/api/masters/staff/${ids.doctor}/erasure`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.staffCode, ids.doctorCode);
  assert.strictEqual(r.body.becomes, `Former staff ${ids.doctorCode}`);
  assert.ok(r.body.doctorCode, 'the code their prescriptions were printed under');

  const kept = Object.fromEntries(r.body.keeps.map((k) => [k.what, k.count]));
  assert.ok(kept.prescriptions >= 1, 'the prescription is listed as staying');
  assert.ok(kept.appointments >= 1);
  assert.ok(kept['audit trail entries'] >= 1);
  assert.ok(r.body.caveats.length, 'and what erasure does not reach is said up front');
});

test('the staff code has to be typed, and a reason given', async () => {
  const wrong = await api('POST', `/api/masters/staff/${ids.doctor}/erase`,
    { confirm: 'NOT-THE-CODE', reason: 'Left the clinic' });
  assert.strictEqual(wrong.status, 400);
  assert.match(wrong.body.error, new RegExp(ids.doctorCode));

  const silent = await api('POST', `/api/masters/staff/${ids.doctor}/erase`,
    { confirm: ids.doctorCode });
  assert.strictEqual(silent.status, 400);
  assert.match(silent.body.error, /why/i);

  assert.strictEqual(userRow().name, 'Dr. Bashir Ahmed', 'still there');
});

// --------------------------------------------------------------- the erasure
test('the owner removes the name, and the work stays', async () => {
  const before = {
    prescriptions: db.prepare('SELECT COUNT(*) AS c FROM prescription_sheets WHERE doctor_id = ?')
      .get(ids.doctor).c,
    appointments: db.prepare('SELECT COUNT(*) AS c FROM appointments WHERE doctor_id = ?')
      .get(ids.doctor).c,
    audit: db.prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE user_id = ?').get(ids.doctor).c,
  };
  assert.ok(before.prescriptions && before.appointments && before.audit);

  const r = await api('POST', `/api/masters/staff/${ids.doctor}/erase`,
    { confirm: ids.doctorCode, reason: 'Left the clinic and asked to be removed' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.name, `Former staff ${ids.doctorCode}`);

  // The person is gone.
  const row = userRow();
  assert.strictEqual(row.name, `Former staff ${ids.doctorCode}`);
  assert.strictEqual(row.email, null);
  assert.strictEqual(row.phone, null);
  assert.strictEqual(row.active, 0);
  assert.ok(row.erased_at);
  assert.match(row.erase_reason, /asked to be removed/);

  const profile = db.prepare('SELECT * FROM doctor_profiles WHERE user_id = ?').get(ids.doctor);
  assert.strictEqual(profile.qualification, null);
  assert.strictEqual(profile.reg_no, null);
  assert.strictEqual(profile.signature_image, null);
  assert.ok(profile.doctor_code, 'the code stays — every printed sheet carries it');

  // The work is not.
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM prescription_sheets WHERE doctor_id = ?')
    .get(ids.doctor).c, before.prescriptions, 'the prescriptions are all still there');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM appointments WHERE doctor_id = ?')
    .get(ids.doctor).c, before.appointments);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE user_id = ?')
    .get(ids.doctor).c, before.audit, 'and so is every line of the audit trail');
  assert.strictEqual(db.pragma('foreign_key_check').length, 0, 'with nothing dangling');
});

test('the name is gone from the audit trail too, which keeps it as plain text', () => {
  /*
   * The audit trail stores the actor's name in words so that a line still
   * reads after an account is deleted. Which means an erasure that did not
   * rewrite it would leave the name on every action the person ever took —
   * the opposite of what was asked for.
   */
  const named = db.prepare(
    "SELECT COUNT(*) AS c FROM audit_logs WHERE actor LIKE '%Bashir%'").get().c;
  assert.strictEqual(named, 0, 'nowhere in the audit trail');

  const underCode = db.prepare(
    'SELECT COUNT(*) AS c FROM audit_logs WHERE actor LIKE ?').get(`%${ids.doctorCode}%`).c;
  assert.ok(underCode > 0, 'but the lines are still there, under the code');

  // And nowhere else in the users table either.
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS c FROM users WHERE name LIKE '%Bashir%'").get().c, 0);
});

test('the prescription they wrote still reads, and still names its doctor by code', async () => {
  const sheet = await api('GET', `/api/prescriptions/${ids.sheet}`, undefined, 'admin');
  assert.strictEqual(sheet.status, 200);
  assert.strictEqual(sheet.body.rx_no, ids.rxNo);
  assert.ok(sheet.body.items.length, 'the medicines are on it');
  assert.ok(sheet.body.doctor_code, 'and the code it was printed under');
  assert.ok(!/Bashir/.test(JSON.stringify(sheet.body)), 'with the name nowhere on it');
});

test('they cannot sign in afterwards, and are signed out of wherever they were', async () => {
  const tryIn = await api('POST', '/api/auth/login',
    { username: 'bashir@samiha.local', password: 'Samiha#Doc1' }, null);
  assert.notStrictEqual(tryIn.status, 200);

  // The session they already had is dead too.
  const stillOpen = await api('GET', '/api/me', undefined, 'doctor');
  assert.strictEqual(stillOpen.status, 401, 'the open session goes with the account');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?')
    .get(ids.doctor).c, 0);
});

test('their rota comes off the booking menu, the bookings already made stay', () => {
  const live = db.prepare(
    'SELECT COUNT(*) AS c FROM doctor_schedules WHERE doctor_id = ? AND active = 1').get(ids.doctor).c;
  assert.strictEqual(live, 0, 'nobody can be booked with them now');
  assert.ok(db.prepare('SELECT COUNT(*) AS c FROM appointments WHERE doctor_id = ?')
    .get(ids.doctor).c > 0, 'and the appointment that was made is still on file');
});

test('the audit line says the code and never the name it just erased', () => {
  const row = db.prepare(
    "SELECT * FROM audit_logs WHERE action = 'erase' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row, 'the erasure itself is audited');
  assert.strictEqual(row.entity, 'user');
  assert.strictEqual(row.entity_id, ids.doctor);
  const details = JSON.parse(row.details);
  assert.strictEqual(details.staffCode, ids.doctorCode);
  assert.ok(details.reason);
  assert.ok(details.recordsKept.length, 'with what was kept, for whoever asks later');
  assert.ok(!/Bashir/.test(row.details),
    'and not the name — writing it here would put it straight back');
  assert.match(row.actor, /Kasim|owner/i, 'the owner who did it is named');
});

test('it cannot be done twice, and the list of who has gone is the owner\'s', async () => {
  const again = await api('POST', `/api/masters/staff/${ids.doctor}/erase`,
    { confirm: ids.doctorCode, reason: 'again' });
  assert.strictEqual(again.status, 409);

  const list = await api('GET', '/api/masters/staff-erased');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.length, 1);
  assert.strictEqual(list.body[0].staff_code, ids.doctorCode);
  assert.ok(list.body[0].erased_by_name, 'and who removed them');

  assert.strictEqual((await api('GET', '/api/masters/staff-erased', undefined, 'admin')).status, 403);
});

test('the clinic cannot be left with nobody who can administer it', async () => {
  const admin = db.prepare("SELECT id, staff_code FROM users WHERE email = 'admin@samiha.local'").get();

  // While the owner exists, removing the administrator is allowed.
  const ok = await api('POST', `/api/masters/staff/${admin.id}/erase`,
    { confirm: admin.staff_code, reason: 'Replaced by the owner' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));

  // The owner is now the last one, and cannot remove themselves.
  const self = await api('POST', `/api/masters/staff/${ids.owner}/erase`,
    { confirm: db.prepare('SELECT staff_code FROM users WHERE id = ?').get(ids.owner).staff_code,
      reason: 'trying' });
  assert.strictEqual(self.status, 400);
  assert.match(self.body.error, /yourself/i);
});
