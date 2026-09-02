'use strict';
/**
 * What a prescription has to carry: the measurements it was written against,
 * a diagnosis that can be coded and claimed, and an Aadhaar that is validated
 * when it goes in and masked when it comes out.
 *
 * And, at the other end of the shelf, the pharmacist saying how many are
 * actually there.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-rxd-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');
const validate = require('../src/lib/validate');

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

/** A number that satisfies the Verhoeff check, the way UIDAI issues them. */
function makeAadhaar(prefix) {
  const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],
    [4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],
    [8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
    [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  const INV = [0,4,3,2,1,5,6,7,8,9];
  let c = 0;
  [...prefix].reverse().forEach((ch, i) => { c = D[c][P[(i + 1) % 8][Number(ch)]]; });
  return prefix + INV[c];
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['imran', 'imran@samiha.local'], ['pharmacy', 'pharmacy@samiha.local'],
    ['lab', 'lab@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.imran = db.prepare("SELECT id FROM users WHERE email = 'imran@samiha.local'").get().id;
  ids.para = db.prepare("SELECT id FROM drugs WHERE code = 'PARA500'").get().id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ Aadhaar
test('an Aadhaar is checked before it is stored', () => {
  const good = makeAadhaar('98765432109');
  assert.strictEqual(validate.aadhaar(good), good);
  assert.strictEqual(validate.aadhaar(`${good.slice(0, 4)} ${good.slice(4, 8)} ${good.slice(8)}`), good,
    'spaces are how people write it and must be accepted');
  assert.strictEqual(validate.aadhaar(''), null, 'it is optional');

  // A single mistyped digit must not pass — that is the whole point.
  const wrong = good.slice(0, 11) + ((Number(good[11]) + 1) % 10);
  assert.throws(() => validate.aadhaar(wrong), /check digit/i);
  assert.throws(() => validate.aadhaar('12345'), /twelve digits/i);
  assert.throws(() => validate.aadhaar('123456789012'), /0 or 1/);

  // The Verhoeff implementation itself, against the textbook cases.
  assert.ok(validate.verhoeffOk('2363'));
  assert.ok(validate.verhoeffOk('758722'));
  assert.ok(!validate.verhoeffOk('2364'));
  assert.ok(!validate.verhoeffOk('2373'));
});

test('an Aadhaar prints whole, in the grouping it is written in', () => {
  assert.strictEqual(validate.formatAadhaar('483670290134'), '4836 7029 0134');
  assert.strictEqual(validate.formatAadhaar('4836 7029 0134'), '4836 7029 0134');
  assert.strictEqual(validate.formatAadhaar('not a number'), '');
});

test('a patient registers with an Aadhaar, and a bad one is refused', async () => {
  const aadhaar = makeAadhaar('87654321098');
  const ok = await api('POST', '/api/patients', {
    firstName: 'Mohamed', lastName: 'Kasim', phone: '9840100200', gender: 'male',
    age: 34, consentTreatment: true, aadhaarNumber: aadhaar,
    vitals: { heightCm: 172, weightKg: 78 },
  }, 'reception');
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  ids.patient = ok.body.id;
  assert.strictEqual(
    db.prepare('SELECT aadhaar_number FROM patients WHERE id = ?').get(ids.patient).aadhaar_number,
    aadhaar);

  const bad = await api('POST', '/api/patients', {
    firstName: 'Bad', lastName: 'Number', phone: '9840100201', gender: 'male',
    age: 20, consentTreatment: true, aadhaarNumber: '234567890123',
  }, 'reception');
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /check digit/i);
});

// --------------------------------------------------------- the printed sheet
test('a prescription carries the measurements it was written against', async () => {
  await api('POST', '/api/appointments', {
    doctorId: ids.imran, patientId: ids.patient,
    scheduledAt: `${new Date().toISOString().slice(0, 10)} 11:00:00`, reason: 'Fever',
  }, 'reception');

  const rx = await api('POST', '/api/prescriptions', {
    patientId: ids.patient,
    complaints: 'Fever 3 days',
    items: [{ drugId: ids.para, doseMorning: 1, doseNight: 1, durationDays: 3 }],
  }, 'imran');
  assert.strictEqual(rx.status, 201, JSON.stringify(rx.body));
  ids.sheet = rx.body.id;

  assert.ok(rx.body.vitals, 'the sheet knows the measurements');
  assert.strictEqual(rx.body.vitals.height_cm, 172);
  assert.strictEqual(rx.body.vitals.weight_kg, 78);
  // 78 / 1.72² = 26.4
  assert.strictEqual(rx.body.vitals.bmi, 26.4, 'BMI is worked out if it was not recorded');
  assert.ok(rx.body.aadhaar_number, 'the sheet can mask it for printing');
});

test('a diagnosis is coded, ranked, and keeps its own wording', async () => {
  const rx = await api('POST', '/api/prescriptions', {
    patientId: ids.patient,
    complaints: 'Itchy rash',
    diagnosis: 'Ringworm over the trunk',
    diagnoses: [
      { code: 'B35.4', rank: 'primary' },
      { code: 'L23.9' },
      { code: 'A49.9' },
    ],
    items: [{ drugId: ids.para, doseMorning: 1, durationDays: 3 }],
  }, 'imran');
  assert.strictEqual(rx.status, 201, JSON.stringify(rx.body));

  const dx = rx.body.diagnoses;
  assert.strictEqual(dx.length, 3);
  assert.strictEqual(dx[0].code, 'B35.4');
  assert.strictEqual(dx[0].rank, 'primary');
  assert.strictEqual(dx[0].title, 'Tinea corporis', 'the term is filled in from the code');
  assert.strictEqual(dx.filter((d) => d.rank === 'primary').length, 1, 'exactly one primary');
  assert.ok(dx.slice(1).every((d) => d.rank === 'secondary'));

  // The doctor's own words are kept alongside, not instead.
  assert.strictEqual(rx.body.diagnosis, 'Ringworm over the trunk');

  // The wording is copied, so revising the master cannot rewrite a sheet
  // already in a patient's hand.
  db.prepare("UPDATE icd_codes SET title = 'Ringworm of the body' WHERE code = 'B35.4'").run();
  const again = (await api('GET', `/api/prescriptions/${rx.body.id}`, undefined, 'imran')).body;
  assert.strictEqual(again.diagnoses[0].title, 'Tinea corporis',
    'an issued prescription does not change under the patient');
  db.prepare("UPDATE icd_codes SET title = 'Tinea corporis' WHERE code = 'B35.4'").run();
});

test('with no diagnosis marked primary, the first one is', async () => {
  const rx = await api('POST', '/api/prescriptions', {
    patientId: ids.patient,
    diagnoses: [{ code: 'J06.9' }, { code: 'R50.9' }],
    items: [{ drugId: ids.para, doseMorning: 1, durationDays: 2 }],
  }, 'imran');
  assert.strictEqual(rx.body.diagnoses[0].rank, 'primary');
  assert.strictEqual(rx.body.diagnoses[0].code, 'J06.9');
  assert.strictEqual(rx.body.diagnoses[1].rank, 'secondary');
});

test('a diagnosis needs a term we can print', async () => {
  const res = await api('POST', '/api/prescriptions', {
    patientId: ids.patient,
    diagnoses: [{ code: 'NOT-A-CODE' }],
    items: [{ drugId: ids.para, doseMorning: 1, durationDays: 2 }],
  }, 'imran');
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /term/i);
});

test('the code master covers what a polyclinic actually sees', async () => {
  const all = db.prepare('SELECT COUNT(*) c FROM icd_codes').get().c;
  assert.ok(all >= 80, `expected a usable code list, got ${all}`);
  for (const code of ['B35.4', 'L23.9', 'A49.9', 'A90', 'E11.9', 'I10', 'J06.9']) {
    assert.ok(db.prepare('SELECT 1 FROM icd_codes WHERE code = ?').get(code), `missing ${code}`);
  }
  const search = (await api('GET', '/api/masters/icd?q=tinea', undefined, 'imran')).body;
  assert.ok(search.some((r) => r.code === 'B35.4'), 'searchable by term');
});

// ------------------------------------------------------- the shelf, corrected
test('a pharmacist says how many are on the shelf, and the register still adds up', async () => {
  const drug = db.prepare("SELECT * FROM drugs WHERE code = 'CEFIX-200MG-TAB'").get();
  assert.ok(drug, 'the formulary item exists');
  assert.strictEqual(db.prepare(
    'SELECT COALESCE(SUM(qty_available),0) q FROM drug_batches WHERE drug_id = ?').get(drug.id).q, 0);

  // A first count needs what only the pack can say.
  const bare = await api('POST', '/api/stock/opening', { drugId: drug.id, qty: 240 }, 'pharmacy');
  assert.strictEqual(bare.status, 400);
  assert.match(bare.body.error, /batch number and expiry/i);

  const expired = await api('POST', '/api/stock/opening', {
    drugId: drug.id, qty: 240, batchNo: 'OLD', expiryDate: '2020-01-01', mrp: 12.5,
  }, 'pharmacy');
  assert.strictEqual(expired.status, 400);
  assert.match(expired.body.error, /expired/i);

  const first = await api('POST', '/api/stock/opening', {
    drugId: drug.id, qty: 240, batchNo: 'CFX-2601', expiryDate: '2028-03-31',
    mrp: 12.5, purchasePrice: 8, reason: 'Opening stock counted on the shelf',
  }, 'pharmacy');
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));
  assert.strictEqual(first.body.onHand, 240);
  assert.strictEqual(first.body.delta, 240);
  // A formulary line with no price gets one from the first pack in.
  assert.strictEqual(db.prepare('SELECT mrp FROM drugs WHERE id = ?').get(drug.id).mrp, 12.5);

  // The change is on the ledger with its reason, not silently applied.
  const move = db.prepare(
    "SELECT * FROM stock_ledger WHERE drug_id = ? ORDER BY id DESC LIMIT 1").get(drug.id);
  assert.strictEqual(move.txn_type, 'adjustment');
  assert.strictEqual(move.qty_delta, 240);
  assert.match(move.notes, /Opening stock/);

  // A recount adjusts the same batch, up or down.
  const recount = await api('POST', '/api/stock/opening', {
    drugId: drug.id, qty: 235, batchNo: 'CFX-2601', reason: 'Five damaged in the strip',
  }, 'pharmacy');
  assert.strictEqual(recount.body.onHand, 235);
  assert.strictEqual(recount.body.delta, -5);
  assert.strictEqual(db.prepare(
    'SELECT COUNT(*) c FROM drug_batches WHERE drug_id = ?').get(drug.id).c, 1,
    'a recount does not open a second batch');

  // And the register reconciles: opening + in − out = closing.
  const reg = (await api('GET', '/api/stock/register?q=CEFIX', undefined, 'pharmacy')).body;
  const row = reg.rows.find((r) => r.drug_id === drug.id);
  assert.strictEqual(Math.round((row.opening + row.inward - row.outward) * 100) / 100, row.closing);
  assert.strictEqual(row.on_hand, 235);
});

test('setting stock is the pharmacy\'s, and a count cannot be negative', async () => {
  const drug = db.prepare("SELECT id FROM drugs WHERE code = 'CEFIX-200MG-TAB'").get();
  assert.strictEqual((await api('POST', '/api/stock/opening',
    { drugId: drug.id, qty: 10, batchNo: 'CFX-2601' }, 'imran')).status, 403);
  assert.strictEqual((await api('POST', '/api/stock/opening',
    { drugId: drug.id, qty: -1, batchNo: 'CFX-2601' }, 'pharmacy')).status, 400);
});

// ------------------------------------------------------------- the drug label
test('a medicine that already names its strength does not say it twice', async () => {
  const rx = await api('POST', '/api/prescriptions', {
    patientId: ids.patient,
    items: [
      { drugId: db.prepare("SELECT id FROM drugs WHERE code = 'PARA-500MG-TAB'").get().id,
        doseMorning: 1, durationDays: 3 },
      { drugId: ids.para, doseMorning: 1, durationDays: 3 },   // 'Dolo 650', strength 650 mg
    ],
  }, 'imran');
  assert.strictEqual(rx.status, 201, JSON.stringify(rx.body));
  const names = rx.body.items.map((i) => i.drug_name);
  assert.ok(names.includes('Paracetamol 500 mg'), names.join(' | '));
  for (const n of names) {
    const strengths = n.match(/\d+\s*(mg|ml|mcg)/gi) || [];
    assert.ok(strengths.length <= 1, `"${n}" says its strength more than once`);
  }
});

// ------------------------------------------------------------ the lab sheets
test('a lab order and its report carry the Aadhaar and the measurements', async () => {
  const tests = (await api('GET', '/api/masters/lab-tests', undefined, 'imran')).body;
  const chosen = tests.filter((t) => String(t.category) === 'lab').slice(0, 2);
  assert.ok(chosen.length === 2, 'two measurable tests are needed');

  const order = await api('POST', '/api/lab/orders', {
    patientId: ids.patient, doctorId: ids.imran, priority: 'routine',
    clinicalNotes: 'Fever for three days',
    tests: chosen.map((t) => ({ testId: t.id })),
  }, 'imran');
  assert.strictEqual(order.status, 201, JSON.stringify(order.body));
  const orderId = order.body.id;

  // The requisition, which the collection counter works from.
  const slip = (await api('GET', `/api/lab/orders/${orderId}`, undefined, 'lab')).body;
  assert.ok(slip.aadhaar_number, 'the slip can print the Aadhaar');
  assert.ok(slip.vitals, 'and the measurements');
  assert.strictEqual(slip.vitals.height_cm, 172);
  assert.strictEqual(slip.vitals.weight_kg, 78);

  // Then results, and the report the patient takes home.
  await api('POST', `/api/lab/orders/${orderId}/collect`, { sampleType: 'blood' }, 'lab');
  const full = (await api('GET', `/api/lab/orders/${orderId}`, undefined, 'lab')).body;
  await api('POST', `/api/lab/orders/${orderId}/results`, {
    results: full.items.map((i) => ({ itemId: i.id, value: '12' })),
  }, 'lab');

  const report = (await api('GET', `/api/lab/orders/${orderId}/report`, undefined, 'lab')).body;
  assert.ok(report.aadhaar_number, 'the report carries it too');
  assert.strictEqual(report.vitals.weight_kg, 78);
  assert.strictEqual(report.vitals.height_cm, 172);
  assert.strictEqual(report.vitals.bmi, 26.4, 'worked out, as on the prescription');
});

test('a document keeps the measurements it was written against', async () => {
  const vitals = require('../src/services/vitals');

  // A later reading must not creep onto a document already issued.
  const sheet = db.prepare(
    'SELECT id, patient_id, created_at FROM prescription_sheets WHERE patient_id = ? ORDER BY id LIMIT 1'
  ).get(ids.patient);
  db.prepare(
    `INSERT INTO vitals (patient_id, height_cm, weight_kg, recorded_at)
     VALUES (?, 172, 91, datetime(?, '+40 days'))`
  ).run(ids.patient, sheet.created_at);

  const then = vitals.asOf(ids.patient, sheet.created_at);
  assert.strictEqual(then.weight_kg, 78, 'the sheet keeps the weight it was written against');

  const now = vitals.asOf(ids.patient);
  assert.strictEqual(now.weight_kg, 91, 'a screen wants the latest');

  const reprinted = (await api('GET', `/api/prescriptions/${sheet.id}`, undefined, 'imran')).body;
  assert.strictEqual(reprinted.vitals.weight_kg, 78,
    'reprinting an old prescription does not give it a new weight');
});
