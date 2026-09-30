'use strict';
/**
 * Handing the clinic a live system.
 *
 * This ships with a working demonstration in it — invented staff, invented
 * doctors, sample patients — and the sign-in page used to list every account
 * and print the shared password. That is fine for showing somebody the system
 * and wrong the moment a real patient is registered, and changing the seed
 * does not fix it: the seed decides what a *new* database gets, and the one
 * the clinic is running already has the demo in it.
 *
 * So the line under test is between what the clinic *is* — its departments,
 * beds, catalogue, rate card, formulary and stock — and what has *happened in*
 * it, which is what goes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-golive-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_DIR = path.join(tmp, 'backups');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';
// This file is about what a *live* install gets, so the demonstration the
// rest of the suite runs against is explicitly off here.
process.env.SEED_DEMO = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');
const config = require('../src/config');
const golive = require('../src/services/golive');

let server;
let base;
const tokens = {};
let adminId;

async function api(method, p, body, as = 'admin') {
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

/*
 * A database that looks like one the clinic has been trying out: the demo
 * staff the old seed created, a patient, and a visit against them.
 */
function seedTheDemo() {
  const { hashPassword } = require('../src/lib/auth');
  const add = db.prepare(
    'INSERT INTO users (staff_code, name, email, role, password_hash) VALUES (?, ?, ?, ?, ?)'
  );
  for (const [code, name, email, role] of [
    ['REC01', 'Fathima Reception', 'reception@samiha.local', 'reception'],
    ['LAB01', 'Ravi Lab Technician', 'lab@samiha.local', 'lab'],
    ['DOC01', 'Dr. Imran Sheikh', 'imran@samiha.local', 'doctor'],
    // No staff code of ours, but the give-away address of the demo.
    ['DOC99', 'Dr. Someone Else', 'someone@samiha.local', 'doctor'],
  ]) add.run(code, name, email, role, hashPassword('samiha@123'));

  const doctor = db.prepare("SELECT id FROM users WHERE staff_code = 'DOC01'").get().id;
  db.prepare('INSERT INTO doctor_profiles (user_id, doctor_code) VALUES (?, ?)').run(doctor, 'SPC-IMR-001');
  db.prepare(
    'INSERT INTO doctor_schedules (doctor_id, weekday, start_time, end_time) VALUES (?, 1, ?, ?)'
  ).run(doctor, '09:00', '13:00');

  const p = db.prepare(
    "INSERT INTO patients (uhid, first_name, last_name, gender, age_years, phone) VALUES ('SPD-DEMO', 'Sample', 'Patient', 'female', 40, '9000000000')"
  ).run().lastInsertRowid;
  db.prepare(
    "INSERT INTO visits (visit_no, patient_id, doctor_id, status) VALUES ('V-DEMO', ?, ?, 'checked_in')"
  ).run(p, doctor);
  db.prepare("INSERT INTO vitals (patient_id, recorded_at) VALUES (?, datetime('now'))").run(p);
}

test.before(async () => {
  seedTheDemo();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const admin = db.prepare("SELECT id, email FROM users WHERE role = 'admin' LIMIT 1").get();
  adminId = admin.id;
  // The seed's administrator has a generated password, so set a known one.
  const { hashPassword } = require('../src/lib/auth');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword('Str0ng#Pass1'), adminId);

  const r = await api('POST', '/api/auth/login',
    { username: admin.email, password: 'Str0ng#Pass1' }, null);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  tokens.admin = r.body.token;

  const lab = await api('POST', '/api/auth/login',
    { username: 'lab@samiha.local', password: 'samiha@123' }, null);
  tokens.lab = lab.body.token;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ----------------------------------------------------------- what is seeded
test('a fresh install has one account and no patients', () => {
  /*
   * The eight invented staff, three invented doctors and five sample patients
   * are gone from the seed. What a clinic gets is itself, and one way in.
   */
  assert.strictEqual(db.prepare(
    "SELECT COUNT(*) AS c FROM patients WHERE uhid != 'SPD-DEMO'"
  ).get().c, 0, 'no sample patients are invented');

  // The demo users in this fixture are the ones the test put there.
  const seeded = db.prepare(
    "SELECT COUNT(*) AS c FROM users WHERE staff_code NOT IN ('REC01','LAB01','DOC01','DOC99')"
  ).get().c;
  assert.strictEqual(seeded, 1, 'exactly one administrator is seeded');

  // And the clinic still gets everything it runs on.
  for (const [table, least] of [['departments', 5], ['beds', 10], ['lab_tests', 100],
    ['services', 20], ['drugs', 50], ['insurers', 5], ['icd_codes', 20]]) {
    assert.ok(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c >= least,
      `${table} is part of the clinic, not the demo`);
  }
});

test('no password is published in the sign-in page', async () => {
  const html = await (await fetch(`${base}/js/app.js`)).text();
  assert.ok(!/samiha@123/.test(html.replace(/COMMON|isWeakPassword/g, '')),
    'the shared password is not shipped to the browser');
  assert.ok(!/demo-grid|Demo desks/.test(html), 'and neither is the list of desks');
  assert.ok(!/reception@samiha\.local/.test(html), 'nor a real account as a placeholder');
});

// --------------------------------------------------------------- the clear
test('the plan says exactly what would go, and takes nothing', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM patients').get().c;
  const r = await api('GET', '/api/admin/go-live');
  assert.strictEqual(r.status, 200);

  assert.ok(r.body.rows > 0, 'there is something to clear');
  assert.ok(r.body.tables.some((t) => t.table === 'patients'));
  assert.ok(r.body.staff.length >= 4, 'the demo accounts are listed');
  assert.strictEqual(r.body.confirm, config.clinic.name, 'and what to type to confirm');

  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM patients').get().c, before,
    'asking what would happen must not make it happen');
});

test('it is the administrator\'s, and nobody else\'s', async () => {
  assert.strictEqual((await api('GET', '/api/admin/go-live', undefined, 'lab')).status, 403);
  assert.strictEqual((await api('POST', '/api/admin/go-live',
    { confirm: config.clinic.name }, 'lab')).status, 403);
});

test('the clinic\'s name has to be typed, or nothing happens', async () => {
  for (const confirm of ['', 'yes', 'SAMIHA', 'delete everything']) {
    const r = await api('POST', '/api/admin/go-live', { confirm });
    assert.strictEqual(r.status, 400, `"${confirm}" must not be accepted`);
    assert.match(r.body.error, /type the clinic's name/i);
  }
  assert.ok(db.prepare('SELECT COUNT(*) AS c FROM patients').get().c > 0, 'and nothing went');
});

test('clearing empties the day-to-day record and keeps the clinic', async () => {
  const kept = {};
  for (const t of ['departments', 'wards', 'beds', 'lab_tests', 'services', 'drugs',
    'drug_batches', 'insurers', 'icd_codes', 'sliding_scale_bands', 'assistance_programs']) {
    kept[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  }

  // Typed in a different case, because a person typing a name is not a machine.
  const r = await api('POST', '/api/admin/go-live', { confirm: config.clinic.name.toLowerCase() });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.cleared > 0);
  assert.ok(r.body.backup, 'a snapshot was taken first');
  assert.ok(fs.existsSync(path.join(config.backup.dir, r.body.backup)), 'and it is on disk');

  // Gone: the patient and everything that hung off them.
  for (const t of ['patients', 'visits', 'vitals']) {
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c, 0, `${t} is cleared`);
  }

  // Gone: the demo staff, by code and by that give-away address.
  assert.strictEqual(db.prepare(
    "SELECT COUNT(*) AS c FROM users WHERE email LIKE '%@samiha.local'"
  ).get().c, 0, 'including the one with no staff code of ours');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM doctor_profiles').get().c, 0,
    'and a departing doctor takes their profile');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM doctor_schedules').get().c, 0,
    'and their sessions');

  // Kept: everything the clinic was set up with.
  for (const [t, was] of Object.entries(kept)) {
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c, was,
      `${t} is what the clinic is, not what happened in it`);
  }
});

test('the administrator running it is still there afterwards', async () => {
  const me = await api('GET', '/api/auth/me');
  assert.strictEqual(me.status, 200, 'and still signed in');
  assert.strictEqual(me.body.user.id, adminId);
  assert.ok(db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c >= 1,
    'a clinic locked out of its own system has no way back in');
});

test('numbering starts again, so the first real patient is the first', () => {
  const left = db.prepare('SELECT name, value FROM counters WHERE value != 0').all();
  assert.deepStrictEqual(left, [], 'no counter is left mid-sequence');
});

// ------------------------------------------------------ and then, the clinic
test('the administrator can staff the clinic afterwards', async () => {
  const dept = db.prepare('SELECT id FROM departments LIMIT 1').get().id;

  const doctor = await api('POST', '/api/masters/staff', {
    name: 'Dr. Real Person', role: 'doctor', email: 'real@clinic.example',
    password: 'An0ther#Pass', departmentId: dept, qualification: 'MBBS, MD',
    consultFee: 150, followUpFee: 100, slotMinutes: 15,
  });
  assert.strictEqual(doctor.status, 201, JSON.stringify(doctor.body));
  assert.ok(doctor.body.doctorCode, 'a doctor is issued the code they sign reports with');

  const nurse = await api('POST', '/api/masters/staff', {
    name: 'A Nurse', role: 'nurse', email: 'nurse@clinic.example', password: 'An0ther#Pass',
  });
  assert.strictEqual(nurse.status, 201);

  // They can actually get in.
  const signIn = await api('POST', '/api/auth/login',
    { username: 'real@clinic.example', password: 'An0ther#Pass' }, null);
  assert.strictEqual(signIn.status, 200);
  assert.strictEqual(signIn.body.user.role, 'doctor');
  assert.strictEqual(signIn.body.weakPassword, false);
});

test('clearing a clinic that is already live finds nothing to do', async () => {
  const r = await api('GET', '/api/admin/go-live');
  assert.strictEqual(r.body.rows, 0, 'the records are gone');
  assert.strictEqual(r.body.staff.length, 0, 'and so are the demo accounts');
  // The staff just added are the clinic's own and are never swept.
  assert.ok(r.body.kept.users >= 3, 'the clinic keeps the people it hired');
});

// ------------------------------------------------- the password that shipped
test('signing in with a password this system published says so', async () => {
  const { hashPassword } = require('../src/lib/auth');
  const id = db.prepare("SELECT id FROM users WHERE email = 'nurse@clinic.example'").get().id;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword('samiha@123'), id);

  const r = await api('POST', '/api/auth/login',
    { username: 'nurse@clinic.example', password: 'samiha@123' }, null);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.weakPassword, true,
    'a clinic reachable with a password from the manual must be told');

  // It is on the record too, for whoever reviews the log.
  const flagged = db.prepare(
    "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'weak_password' AND entity_id = ?"
  ).get(id).c;
  assert.ok(flagged >= 1, 'and it is audited');
});

test('and such a password cannot be chosen', () => {
  const { passwordProblems } = require('../src/lib/auth');
  assert.ok(passwordProblems('samiha@123').length, 'the published one is refused outright');
  assert.deepStrictEqual(passwordProblems('An0ther#Pass'), [], 'a real one is fine');
});
