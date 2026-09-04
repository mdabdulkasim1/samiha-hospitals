'use strict';
/**
 * "Why they came" — the clinic's own note about a patient.
 *
 * It exists because the two boxes that already looked like it both come with
 * strings attached. The consultation's chief complaint needs a visit, so it
 * cannot be written about somebody booked for Thursday who rang this morning.
 * The prescription's complaints box is printed on a sheet that goes home with
 * the patient and on to a pharmacist. This is neither: it is the hospital's
 * record, written whenever, and it stays inside the building.
 *
 * That last part is the one worth a test. A note a doctor writes about a
 * patient — a suspicion, a social circumstance, a reason they keep missing
 * appointments — turning up on a printed prescription would be a disclosure
 * nobody intended, so the assertion here is that it never does.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-notes-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');

let server;
let base;
const tokens = {};
const ids = {};

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

const SECRET = 'Keeps missing appointments — money trouble at home, handle gently';

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['doctor', 'imran@samiha.local'], ['pharmacy', 'pharmacy@samiha.local'],
    ['cashier', 'cashier@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.doctor = db.prepare("SELECT id FROM users WHERE email = 'imran@samiha.local'").get().id;
  ids.patient = (await api('POST', '/api/patients', {
    firstName: 'Note', lastName: 'Keeper', phone: '9848001122',
    gender: 'male', age: 47, consentTreatment: true,
  }, 'reception')).body.id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a note can be written about a patient who has not arrived', async () => {
  // No visit, no appointment, nobody in the building. This is the case the
  // consultation's own complaint box cannot serve.
  const made = await api('POST', `/api/patients/${ids.patient}/notes`,
    { note: 'Rang about his sugars — bring him in this week' }, 'doctor');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.strictEqual(made.body.visit_id, null);
  assert.match(made.body.by_name, /Imran/);

  const listed = (await api('GET', `/api/patients/${ids.patient}/notes`, undefined, 'doctor')).body;
  assert.strictEqual(listed.length, 1);
  assert.match(listed[0].note, /sugars/);
});

test('an empty note is refused rather than filed as a blank line', async () => {
  for (const note of ['', '   ', undefined]) {
    const r = await api('POST', `/api/patients/${ids.patient}/notes`, { note }, 'doctor');
    assert.strictEqual(r.status, 400, `"${note}" should be refused`);
  }
});

test('the note reaches the patient record, newest first', async () => {
  await api('POST', `/api/patients/${ids.patient}/notes`, { note: SECRET }, 'doctor');
  const record = (await api('GET', `/api/patients/${ids.patient}`, undefined, 'doctor')).body;
  assert.ok(Array.isArray(record.notes));
  assert.strictEqual(record.notes[0].note, SECRET, 'the latest note is at the top');
  assert.strictEqual(record.notes.length, 2);
});

test('it never appears on the prescription the patient carries out', async () => {
  const drug = db.prepare("SELECT id FROM drugs WHERE code = 'PARA500'").get();
  const rx = await api('POST', '/api/prescriptions', {
    patientId: ids.patient,
    complaints: 'Fever three days',
    items: [{ drugId: drug.id, dose: '1 tab', frequency: '1-0-1', durationDays: 3 }],
  }, 'doctor');
  assert.strictEqual(rx.status, 201, JSON.stringify(rx.body));

  const sheet = (await api('GET', `/api/prescriptions/${rx.body.id}`, undefined, 'doctor')).body;
  const printed = JSON.stringify(sheet);
  assert.ok(printed.includes('Fever three days'), 'what the doctor wrote on the sheet is on the sheet');
  assert.ok(!printed.includes(SECRET), 'and the hospital\'s own note is not');
  assert.ok(!printed.includes('money trouble'), 'not a word of it');

  // Nor to the pharmacist who dispenses it.
  const forCounter = (await api('GET', `/api/pharmacy/prescriptions/${rx.body.id}`, undefined, 'pharmacy'))
    .body;
  if (forCounter) assert.ok(!JSON.stringify(forCounter).includes(SECRET));
});

test('writing one is for the people who see patients, not the counter', async () => {
  const cashier = await api('POST', `/api/patients/${ids.patient}/notes`,
    { note: 'Should not be able to write this' }, 'cashier');
  assert.strictEqual(cashier.status, 403, 'the till does not write clinical notes');

  const pharmacy = await api('POST', `/api/patients/${ids.patient}/notes`,
    { note: 'Nor this' }, 'pharmacy');
  assert.strictEqual(pharmacy.status, 403);

  // Reception takes it down when a patient rings, so they may.
  const desk = await api('POST', `/api/patients/${ids.patient}/notes`,
    { note: 'Rang to say he will be late' }, 'reception');
  assert.strictEqual(desk.status, 201);
});

test('a note against a visit also lands on that visit\'s trail', async () => {
  const arrive = await api('POST', '/api/visits/arrive', {
    patientId: ids.patient, doctorId: ids.doctor, reasonForVisit: 'Review',
  }, 'reception');
  const visit = arrive.body.visit || arrive.body;

  await api('POST', `/api/patients/${ids.patient}/notes`,
    { note: 'Sugars still high on the same dose', visitId: visit.id }, 'doctor');

  const full = (await api('GET', `/api/visits/${visit.id}`, undefined, 'doctor')).body;
  assert.ok(full.timeline.some((t) => t.stage === 'note' && /Sugars still high/.test(t.detail || '')),
    'the visit trail carries it, so it is findable from either end');
});

test("the doctor's own list for the day is what the consultation screen reads", async () => {
  const appt = await api('POST', '/api/appointments', {
    patientId: ids.patient, doctorId: ids.doctor,
    scheduledAt: new Date(Date.now() + 3600000).toISOString().slice(0, 16).replace('T', ' '),
    visitKind: 'follow_up', reason: 'Sugar review',
  }, 'reception');
  assert.strictEqual(appt.status, 201, JSON.stringify(appt.body));

  const day = await api('GET', '/api/appointments/my-day', undefined, 'doctor');
  assert.strictEqual(day.status, 200, JSON.stringify(day.body));
  const mine = day.body.rows.find((r) => r.patient_id === ids.patient);
  assert.ok(mine, 'the doctor sees their own booking without searching for it');
  assert.strictEqual(mine.display_name, 'Note Keeper');
  assert.ok(mine.time, 'with the time they are due');
  assert.strictEqual(mine.reason, 'Sugar review');
});
