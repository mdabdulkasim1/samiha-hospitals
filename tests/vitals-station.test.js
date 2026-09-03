'use strict';
/**
 * The vitals station: every reading a counter takes, for anybody who walks up
 * to it, with the flags that decide whether a doctor is told now.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-vit-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');
const vitals = require('../src/services/vitals');

let server;
let base;
const tokens = {};
const ids = {};

async function api(method, p, body, as = 'nurse') {
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
  for (const [as, email] of [
    ['nurse', 'nurse@samiha.local'], ['reception', 'reception@samiha.local'],
    ['imran', 'imran@samiha.local'], ['pharmacy', 'pharmacy@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.patient = (await api('POST', '/api/patients', {
    firstName: 'Walkin', lastName: 'Vitals', phone: '9843001122', gender: 'male',
    age: 52, consentTreatment: true,
  }, 'reception')).body.id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --------------------------------------------------------- the whole reading
test('every reading the counter takes is stored, pain score included', async () => {
  const res = await api('POST', `/api/patients/${ids.patient}/vitals`, {
    bpSystolic: 186, bpDiastolic: 112, pulse: 92, respRate: 26, tempC: 38.4,
    spo2: 91, heightCm: 170, weightKg: 70, bloodSugar: 260, painScore: 8,
    purpose: 'Walk-in BP check', notes: 'Came in off the street',
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  const v = res.body;
  assert.strictEqual(v.bp_systolic, 186);
  assert.strictEqual(v.bp_diastolic, 112);
  assert.strictEqual(v.pulse, 92);
  assert.strictEqual(v.resp_rate, 26, 'the breathing rate is the one most often dropped');
  assert.strictEqual(v.temp_c, 38.4);
  assert.strictEqual(v.spo2, 91);
  assert.strictEqual(v.blood_sugar, 260);
  assert.strictEqual(v.pain_score, 8, 'the pain score used to be lost on this route');
  assert.strictEqual(v.bmi, 24.2, '70 / 1.7² worked out and stored');
  assert.strictEqual(v.purpose, 'Walk-in BP check');
  assert.strictEqual(v.visit_id, null, 'no visit is needed to take a reading');
});

test('a walk-in reading raises the same flags as a queued one', async () => {
  const res = await api('POST', `/api/patients/${ids.patient}/vitals`, {
    bpSystolic: 186, bpDiastolic: 112, spo2: 91, respRate: 26, painScore: 8,
  });
  const levels = res.body.alerts.map((a) => a.level);
  const text = res.body.alerts.map((a) => a.text).join(' ');
  assert.ok(levels.includes('critical'), 'a crisis reading is escalated');
  assert.match(text, /Hypertensive crisis/);
  assert.match(text, /SpO₂ 91%/);
  assert.match(text, /Respiratory rate 26/);
  assert.match(text, /Pain 8\/10/);
});

test('a pain score of nothing is still a reading', async () => {
  const res = await api('POST', `/api/patients/${ids.patient}/vitals`, { painScore: 0 });
  assert.strictEqual(res.status, 201, '"no pain" is worth recording');
  assert.strictEqual(res.body.pain_score, 0);

  const nothing = await api('POST', `/api/patients/${ids.patient}/vitals`, { purpose: 'Just asking' });
  assert.strictEqual(nothing.status, 400, 'but a form with no readings at all is not');
});

test('height carries forward so a weight alone still gives a BMI', async () => {
  const res = await api('POST', `/api/patients/${ids.patient}/vitals`, { weightKg: 74 });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.height_cm, null, 'nothing was measured');
  assert.strictEqual(res.body.bmi, 25.6, 'but the last height still gives a BMI');
});

// ------------------------------------------------------------- the judgements
test('the BMI band follows the Indian cut-offs, not the WHO ones', () => {
  assert.strictEqual(vitals.band(17), 'underweight');
  assert.strictEqual(vitals.band(22), 'normal');
  assert.strictEqual(vitals.band(24), 'overweight', 'WHO would call 24 normal; here it is not');
  assert.strictEqual(vitals.band(27), 'obese', 'WHO would call 27 overweight');
  assert.strictEqual(vitals.band(0), '');
});

test('the flags are the ones a nurse should act on', () => {
  const of = (v) => vitals.alerts(v).map((a) => `${a.level}:${a.text}`).join(' | ');

  assert.match(of({ bp_systolic: 185, bp_diastolic: 100 }), /critical/);
  assert.match(of({ bp_systolic: 145, bp_diastolic: 92 }), /warn/);
  assert.match(of({ bp_systolic: 85 }), /critical.*Hypotension/);
  assert.match(of({ spo2: 89 }), /critical/);
  assert.match(of({ spo2: 93 }), /warn/);
  assert.match(of({ temp_c: 34.5 }), /critical.*Hypothermic/);
  assert.match(of({ resp_rate: 26 }), /critical/);
  assert.match(of({ resp_rate: 22 }), /warn/);
  assert.match(of({ blood_sugar: 60 }), /critical/);
  assert.match(of({ pain_score: 9 }), /warn.*severe/);

  // A normal set says nothing, which is the point of a flag.
  assert.strictEqual(vitals.alerts({
    bp_systolic: 118, bp_diastolic: 76, pulse: 72, resp_rate: 16,
    temp_c: 36.8, spo2: 98, blood_sugar: 92, pain_score: 0, bmi: 21,
  }).length, 0);
});

test('a reading is only a nurse\'s or a doctor\'s to take', async () => {
  assert.strictEqual((await api('POST', `/api/patients/${ids.patient}/vitals`,
    { pulse: 70 }, 'pharmacy')).status, 403);
  assert.strictEqual((await api('POST', `/api/patients/${ids.patient}/vitals`,
    { pulse: 70 }, 'imran')).status, 201, 'a doctor may');
});

test('a walk-in reading joins the same dated chart as a visit reading', async () => {
  const chart = (await api('GET', `/api/patients/${ids.patient}`, undefined, 'nurse')).body.vitals;
  assert.ok(chart.length >= 4, 'every reading is on the chart');
  assert.ok(chart.every((v, i) => i === 0
    || new Date(chart[i - 1].recorded_at) >= new Date(v.recorded_at)),
  'newest first, so the chart reads as a history');
});

// ------------------------------------------------- finishing a reading later
test('a half-taken reading can be finished afterwards', async () => {
  // The cuff was on somebody else, the oximeter across the room.
  const taken = (await api('POST', `/api/patients/${ids.patient}/vitals`,
    { purpose: 'fever', weightKg: 74, heightCm: 164, tempC: 36.5 })).body;
  assert.strictEqual(taken.bp_systolic, null);
  assert.strictEqual(taken.spo2, null);
  assert.strictEqual(taken.bmi, 27.5, 'BMI from what was measured');

  const done = await api('PATCH', `/api/patients/${ids.patient}/vitals/${taken.id}`,
    { bpSystolic: 148, bpDiastolic: 94, pulse: 82, spo2: 97, bloodSugar: 142 });
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));

  // The gaps are filled and nothing else moved.
  assert.strictEqual(done.body.bp_systolic, 148);
  assert.strictEqual(done.body.spo2, 97);
  assert.strictEqual(done.body.blood_sugar, 142);
  assert.strictEqual(done.body.weight_kg, 74, 'the weight is untouched');
  assert.strictEqual(done.body.temp_c, 36.5, 'and so is the temperature');
  assert.strictEqual(done.body.bmi, 27.5);

  // It still belongs to whoever took it, and says it was completed.
  assert.strictEqual(done.body.recorded_by, taken.recorded_by);
  assert.ok(done.body.amended_at, 'and when');
  assert.ok(done.body.amended_by, 'and by whom');

  // And it now raises the flags its new figures deserve: a reading completed
  // an hour late is still a reading somebody has to act on.
  assert.ok(done.body.alerts.some((a) => /blood pressure/i.test(a.text)),
    JSON.stringify(done.body.alerts));
});

test('what is not sent is not touched, and an emptied box is a figure withdrawn', async () => {
  const taken = (await api('POST', `/api/patients/${ids.patient}/vitals`,
    { purpose: 'review', pulse: 78, tempC: 37.1, spo2: 98 })).body;

  // A request naming only the pulse leaves the rest exactly as it was.
  const one = (await api('PATCH', `/api/patients/${ids.patient}/vitals/${taken.id}`,
    { pulse: 84 })).body;
  assert.strictEqual(one.pulse, 84);
  assert.strictEqual(one.temp_c, 37.1, 'the temperature somebody else recorded');
  assert.strictEqual(one.spo2, 98);

  // An empty box takes a figure back out — a number typed in the wrong place.
  const cleared = (await api('PATCH', `/api/patients/${ids.patient}/vitals/${taken.id}`,
    { spo2: '' })).body;
  assert.strictEqual(cleared.spo2, null);
  assert.strictEqual(cleared.pulse, 84, 'and leaves the rest alone');

  // But a reading cannot be emptied altogether: a dated row saying nothing is
  // worse than no row.
  const emptied = await api('PATCH', `/api/patients/${ids.patient}/vitals/${taken.id}`, {
    pulse: '', tempC: '', spo2: '', weightKg: '', heightCm: '',
    bpSystolic: '', bpDiastolic: '', respRate: '', bloodSugar: '', painScore: '',
  });
  assert.strictEqual(emptied.status, 400);
  assert.match(emptied.body.error, /at least one measurement/i);

  // Nonsense is refused rather than stored.
  assert.strictEqual((await api('PATCH', `/api/patients/${ids.patient}/vitals/${taken.id}`,
    { pulse: 'fast' })).status, 400);
});

test('a reading belongs to its own patient, and to the people who take readings', async () => {
  const taken = (await api('POST', `/api/patients/${ids.patient}/vitals`,
    { purpose: 'check', pulse: 70 })).body;

  // Another patient's id cannot reach it.
  const other = (await api('POST', '/api/patients', {
    firstName: 'Other', lastName: 'Chart', phone: '9846333222', gender: 'female',
    age: 30, consentTreatment: true,
  }, 'reception')).body;
  assert.strictEqual((await api('PATCH', `/api/patients/${other.id}/vitals/${taken.id}`,
    { pulse: 90 })).status, 404);
  assert.strictEqual((await api('PATCH', `/api/patients/${ids.patient}/vitals/999999`,
    { pulse: 90 })).status, 404);

  assert.strictEqual((await api('PATCH', `/api/patients/${ids.patient}/vitals/${taken.id}`,
    { pulse: 90 }, 'pharmacy')).status, 403, 'the pharmacy takes no readings');
  assert.strictEqual((await api('PATCH', `/api/patients/${ids.patient}/vitals/${taken.id}`,
    { pulse: 90 }, 'imran')).status, 200, 'a doctor may');
});
