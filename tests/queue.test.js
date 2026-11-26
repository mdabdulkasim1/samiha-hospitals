'use strict';
/**
 * The queue.
 *
 * Two things are tested here, and they fail in different ways.
 *
 * The numbering is the one a clinic notices within an hour. A token is a
 * category code and a sequence that starts again each morning, so the tests
 * insist that 08-001 is Paediatrics' first patient of the day and that the
 * laboratory's 12-001 is issued in the same minute without either number
 * being touched — two counters that share a counter are two counters
 * calling the same number at the same person.
 *
 * The ordering is the one a clinic notices in a year, by which time the
 * waiting room has learned that turning up early gets you seen and the
 * appointment book has stopped meaning anything. The rule is that a booked
 * patient is seen at their time and a walk-in fills the gap between one
 * booking and the next, and the interesting cases are all about the clock:
 * the walk-in who has been waiting longer than the booked patient, the
 * booking that is not due yet, and the patient who booked at nine and
 * strolls in at half eleven expecting to go straight in.
 *
 * Times are set explicitly rather than taken from the wall clock. A queue
 * is a fact about the clock, so a test of one that depends on when it ran
 * is a test that passes until the afternoon.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-queue-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
require('../src/db/catalogue').sync({ quiet: true });
const { db } = require('../src/db');
const queue = require('../src/services/queue');
const app = require('../src/server');

let server;
let base;
const tokens = {};
const ids = {};

async function api(method, p, body, as = 'reception') {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(as && tokens[as] ? { Authorization: `Bearer ${tokens[as]}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

/*
 * Every time in this file is the clinic's own clock, because that is the
 * clock the desk and the appointment book are written in. What the database
 * stores is UTC, so the helpers below convert — and a test that got that
 * backwards would be asserting the very bug this exists to prevent.
 */
const clock = require('../src/lib/clinicClock');
/** A clinic time of day on the test's date, as a moment. */
const at = (hhmm) => new Date(clock.fromWall(`${ids.date} ${hhmm}:00`));
/** The same, as the UTC stamp the database would have written. */
const stampAt = (hhmm) => at(hhmm).toISOString().slice(0, 19).replace('T', ' ');

/**
 * A token, planted directly with the times the case needs.
 *
 * `arrived` is when they reached the clinic and `booked` is their slot, if
 * they had one. Going through the service would mean issuing at the wall
 * clock, which is exactly the thing these tests must control.
 */
function plant({ category, arrived, booked = null, patient = null }) {
  const cat = queue.categories().find((c) => c.code === category);
  const seq = (db.prepare(
    'SELECT MAX(seq) AS m FROM queue_tokens WHERE category_id = ? AND issue_date = ?')
    .get(cat.id, ids.date).m || 0) + 1;

  let visitId = null;
  if (arrived) {
    const apptId = booked ? db.prepare(
      `INSERT INTO appointments (appt_no, patient_id, doctor_id, department_id, scheduled_at,
                                 slot_minutes, status, created_by)
       VALUES (?, ?, ?, ?, ?, 15, 'checked_in', 1)`
    ).run(`APT-T${seq}-${category}`, patient || ids.patient, ids.doctor, ids.dept,
      `${ids.date} ${booked}:00`).lastInsertRowid : null;

    visitId = db.prepare(
      `INSERT INTO visits (visit_no, patient_id, appointment_id, doctor_id, department_id,
                           visit_type, status, token_no, arrived_at)
       VALUES (?, ?, ?, ?, ?, 'opd', 'waiting_room', ?, ?)`
    ).run(`VIS-T${seq}-${category}`, patient || ids.patient, apptId, ids.doctor, ids.dept,
      seq, stampAt(arrived)).lastInsertRowid;
  }

  const id = db.prepare(
    `INSERT INTO queue_tokens (category_id, issue_date, seq, label, patient_id, visit_id,
                               doctor_id, room_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cat.id, ids.date, seq, queue.labelFor(cat.code, seq), patient || ids.patient,
    visitId, ids.doctor, ids.room, stampAt(arrived)).lastInsertRowid;
  return queue.tokenOr404(id);
}

const clear = () => {
  db.prepare('DELETE FROM queue_tokens').run();
  db.prepare('DELETE FROM visits').run();
  db.prepare('DELETE FROM appointments').run();
};

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  /*
   * The seeded doctors sign in under their own names rather than a generic
   * address, and the Paediatrics one is the doctor these tests send patients
   * to, so that is the account that calls them in.
   */
  const logins = {
    reception: 'reception@samiha.local', nurse: 'nurse@samiha.local',
    admin: 'admin@samiha.local', lab: 'lab@samiha.local',
    cashier: 'cashier@samiha.local', doctor: 'sara@samiha.local',
  };
  for (const [who, username] of Object.entries(logins)) {
    const res = await api('POST', '/api/auth/login', { username, password: 'samiha@123' }, null);
    assert.ok(res.body && res.body.token, `${who} could not sign in: ${JSON.stringify(res.body)}`);
    tokens[who] = res.body.token;
  }

  ids.date = '2026-03-10';
  const ped = db.prepare("SELECT id FROM departments WHERE code = 'PED'").get();
  ids.dept = ped.id;
  ids.doctor = db.prepare("SELECT id FROM users WHERE role = 'doctor' AND department_id = ?")
    .get(ped.id)?.id
    || db.prepare("SELECT id FROM users WHERE role = 'doctor'").get().id;
  ids.patient = db.prepare('SELECT id FROM patients ORDER BY id').get().id;

  const made = await api('POST', '/api/patients', {
    firstName: 'Queue', lastName: 'Tester', gender: 'male', age: 40,
    phone: '9000000123', consentTreatment: true,
  });
  ids.other = made.body.id;

  /*
   * Paediatrics sits in OP-2 by the clinic's own allocation. These tests
   * put it in OP-3 instead, so that a test which moves it has somewhere to
   * move it from and the seeded allocation is not what is being asserted.
   */
  const rooms = queue.rooms();
  const room = rooms.find((r) => r.name === 'OP-3');
  const pedCat = queue.categories().find((c) => c.code === '08');
  queue.assignCategoryRoom(pedCat.id, room.id);
  ids.room = room.id;
  ids.pedCat = pedCat.id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ================================================================ numbering
test('the clinic\'s own twenty categories are there, with its codes', () => {
  const cats = queue.categories();
  /*
   * The twenty the clinic printed, all present and all still meaning what
   * the sheet says. Anything added since — Diabetology, which was on the
   * duty chart but not on the sheet — counts past the end, so no number
   * anybody is holding has moved.
   */
  for (let n = 1; n <= 20; n += 1) {
    assert.ok(cats.some((c) => c.code === String(n).padStart(2, '0')),
      `code ${n} is on the list`);
  }
  assert.ok(cats.length >= 20);
  assert.ok(cats.filter((c) => Number(c.code) > 20).every((c) => c.code > '20'));
  assert.strictEqual(cats.find((c) => c.code === '08').name, 'Paediatrics');
  assert.strictEqual(cats.find((c) => c.code === '12').name, 'Laboratory Services');

  // General and Internal Medicine share one code, as the directory lists
  // them — so the link lives on the department, not the category.
  const five = cats.find((c) => c.code === '05');
  assert.match(five.departments, /Internal Medicine/);
  assert.match(five.departments, /General Practitioner/);

  // Oncology is deliberately absent from the clinic's sheet. An invented
  // code is how a list stops matching the printed one it stands for.
  assert.ok(!cats.some((c) => /oncolog/i.test(c.name)));
});

test('a token is the category code and a sequence that starts at 001 each morning', () => {
  clear();
  const first = queue.issue({ categoryId: ids.pedCat, date: ids.date });
  const second = queue.issue({ categoryId: ids.pedCat, patientId: ids.other, date: ids.date });
  assert.strictEqual(first.label, '08-001');
  assert.strictEqual(second.label, '08-002');

  // Tomorrow starts again at 001 without anything having to be reset.
  const tomorrow = queue.issue({ categoryId: ids.pedCat, date: '2026-03-11' });
  assert.strictEqual(tomorrow.label, '08-001');
});

test('each category counts on its own, so two counters never call one number', () => {
  clear();
  const lab = queue.categories().find((c) => c.code === '12');
  assert.strictEqual(queue.issue({ categoryId: ids.pedCat, date: ids.date }).label, '08-001');
  assert.strictEqual(queue.issue({ categoryId: lab.id, date: ids.date }).label, '12-001');
  assert.strictEqual(queue.issue({ categoryId: ids.pedCat, patientId: ids.other, date: ids.date }).label,
    '08-002');
});

test('past 999 the sequence carries on rather than wrapping', () => {
  clear();
  db.prepare(`INSERT INTO queue_tokens (category_id, issue_date, seq, label) VALUES (?, ?, 999, ?)`)
    .run(ids.pedCat, ids.date, '08-999');
  assert.strictEqual(queue.issue({ categoryId: ids.pedCat, date: ids.date }).label, '08-1000');
});

test('pressing the button twice does not put the same patient in the queue twice', () => {
  clear();
  const one = queue.issue({ categoryId: ids.pedCat, patientId: ids.patient, date: ids.date });
  const again = queue.issue({ categoryId: ids.pedCat, patientId: ids.patient, date: ids.date });
  assert.strictEqual(again.id, one.id, 'the same token comes back');

  /*
   * A second blood test the same day does happen. It is a decision somebody
   * makes, not a side-effect of a double click.
   */
  const deliberate = queue.issue({
    categoryId: ids.pedCat, patientId: ids.patient, date: ids.date, again: true });
  assert.notStrictEqual(deliberate.id, one.id);
  assert.strictEqual(deliberate.label, '08-002');
});

test('a token with no patient is still a place in the line', () => {
  clear();
  const walkUp = queue.issue({ categoryId: ids.pedCat, date: ids.date });
  assert.strictEqual(walkUp.label, '08-001');
  assert.strictEqual(walkUp.patient_id, null);
  // …and a second one does not collapse into the first, the way two named
  // patients' tokens must not.
  assert.strictEqual(queue.issue({ categoryId: ids.pedCat, date: ids.date }).label, '08-002');
});

// ================================================== where the patient is sent
test('the room on the token is the room the clinic entered', () => {
  clear();
  const t = queue.issue({ categoryId: ids.pedCat, date: ids.date });
  assert.strictEqual(t.room_name, 'OP-3');
  assert.strictEqual(t.room_floor, 'First Floor');
});

test('a doctor\'s own room beats the specialty\'s room', () => {
  clear();
  const ground = queue.rooms().find((r) => r.name === 'OP-2');
  queue.setDoctorRoom(ids.doctor, ground.id);
  const t = queue.issue({ categoryId: ids.pedCat, doctorId: ids.doctor, date: ids.date });
  assert.strictEqual(t.room_name, 'OP-2');
  assert.strictEqual(t.room_floor, 'Ground Floor');
  queue.setDoctorRoom(ids.doctor, null);
});

test('a specialty with no room sends nobody anywhere, rather than guessing', () => {
  clear();
  const ent = queue.categories().find((c) => c.code === '03');
  queue.assignCategoryRoom(ent.id, null);
  const t = queue.issue({ categoryId: ent.id, date: ids.date });
  assert.strictEqual(t.room_id, null, 'no room invented');
  assert.strictEqual(t.label, '03-001', 'but the number is still issued');
  queue.assignCategoryRoom(ent.id, queue.rooms().find((r) => r.name === 'OP-1').id);
});

test('a room takes several specialties, because one room holds several clinics', () => {
  const room = queue.rooms().find((r) => r.id === ids.room);
  const codes = ['08', '02', '01', '11'].map((c) =>
    queue.categories().find((x) => x.code === c).id);
  const saved = queue.setRoomCategories(room.id, codes);
  assert.strictEqual(saved.categories.length, 4);
  assert.deepStrictEqual(saved.categories.map((c) => c.code), ['08', '02', '01', '11'],
    'and in the order the clinic listed them');
  queue.setRoomCategories(room.id, [ids.pedCat]);
  // Put the four back where the clinic's own sheet has them.
  queue.assignCategoryRoom(queue.categories().find((c) => c.code === '02').id,
    queue.rooms().find((r) => r.name === 'OP-4').id);
  queue.assignCategoryRoom(queue.categories().find((c) => c.code === '01').id,
    queue.rooms().find((r) => r.name === 'OP-4').id);
  queue.assignCategoryRoom(queue.categories().find((c) => c.code === '11').id,
    queue.rooms().find((r) => r.name === 'OP-4').id);
  queue.assignCategoryRoom(queue.categories().find((c) => c.code === '10').id,
    queue.rooms().find((r) => r.name === 'OP-3').id);
});

// ============================================== the rule: who goes in next
test('a booked patient whose time has come goes before a longer-waiting walk-in', () => {
  clear();
  const walkIn = plant({ category: '08', arrived: '09:30' });
  const booked = plant({ category: '08', arrived: '09:55', booked: '10:00', patient: ids.other });

  const q = queue.queueFor({ categoryId: ids.pedCat, date: ids.date }, at('10:00'));
  assert.strictEqual(q.queue[0].id, booked.id, 'the appointment was promised a time');
  assert.strictEqual(q.queue[1].id, walkIn.id);
  assert.strictEqual(q.next.id, booked.id);
  assert.match(q.queue[0].why, /^Booked 10:00/);
  assert.match(q.queue[1].why, /Walk-in/);
});

test('the walk-in fills the gap while the next booking is not due', () => {
  clear();
  const walkIn = plant({ category: '08', arrived: '09:30' });
  plant({ category: '08', arrived: '09:55', booked: '11:00', patient: ids.other });

  const q = queue.queueFor({ categoryId: ids.pedCat, date: ids.date }, at('10:00'));
  assert.strictEqual(q.next.id, walkIn.id,
    'holding the room empty for an hour honours nothing');
  assert.strictEqual(q.queue[0].id, walkIn.id);
  assert.match(q.queue[1].why, /not due yet/);
  assert.strictEqual(q.queue[1].callable, false,
    'and the booking that is not due is not offered either');
});

test('at the moment the booking comes due, the walk-in stops being next', () => {
  clear();
  const walkIn = plant({ category: '08', arrived: '09:30' });
  const booked = plant({ category: '08', arrived: '09:55', booked: '11:00', patient: ids.other });

  assert.strictEqual(queue.queueFor({ categoryId: ids.pedCat, date: ids.date }, at('10:59')).next.id,
    walkIn.id);
  const after = queue.queueFor({ categoryId: ids.pedCat, date: ids.date }, at('11:00'));
  assert.strictEqual(after.next.id, booked.id, 'eleven o\'clock means eleven o\'clock');
  assert.strictEqual(after.queue.find((r) => r.id === walkIn.id).callable, false,
    'the walk-in waits while somebody is due');
});

test('arriving two hours late does not walk past the patient who came on time', () => {
  clear();
  const late = plant({ category: '08', arrived: '11:30', booked: '09:00' });
  const onTime = plant({ category: '08', arrived: '11:20', booked: '11:30', patient: ids.other });

  const q = queue.queueFor({ categoryId: ids.pedCat, date: ids.date }, at('11:35'));
  assert.strictEqual(q.queue[0].id, onTime.id, 'lateness buys no place');
  assert.strictEqual(q.queue[1].id, late.id);
  assert.match(q.queue[1].why, /arrived late/);
});

test('two bookings due in the same minute are ordered by their slots', () => {
  clear();
  const nine = plant({ category: '08', arrived: '08:50', booked: '09:00' });
  const half = plant({ category: '08', arrived: '08:55', booked: '09:30', patient: ids.other });
  const q = queue.queueFor({ categoryId: ids.pedCat, date: ids.date }, at('09:45'));
  assert.deepStrictEqual(q.queue.map((r) => r.id), [nine.id, half.id]);
});

test('nobody answered: they keep their place but stop overtaking the people behind', async () => {
  clear();
  const first = plant({ category: '08', arrived: '09:00' });
  const second = plant({ category: '08', arrived: '09:10', patient: ids.other });

  await api('POST', `/api/queue/tokens/${first.id}/call`, {}, 'nurse');
  const passed = (await api('POST', `/api/queue/tokens/${first.id}/pass`,
    { reason: 'Did not answer' }, 'nurse'));
  assert.strictEqual(passed.status, 200);
  assert.strictEqual(passed.body.status, 'waiting', 'still in the queue, not sent home');
  assert.ok(passed.body.passed_at);

  const q = queue.queueFor({ categoryId: ids.pedCat, date: ids.date }, at('12:00'));
  assert.strictEqual(q.next.id, second.id,
    'the person behind them is not overtaken a second time');
  assert.strictEqual(q.queue[1].id, first.id);
});

test('calling out of turn is allowed, and says so', async () => {
  clear();
  plant({ category: '08', arrived: '09:00' });
  const behind = plant({ category: '08', arrived: '09:40', patient: ids.other });

  const out = await api('POST', `/api/queue/tokens/${behind.id}/call`,
    { reason: 'Pregnant, standing' }, 'reception');
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.outOfTurn, true, 'the override is recorded, not refused');
  assert.strictEqual(out.body.expected.label, '08-001');
  assert.strictEqual(out.body.token.status, 'called');
});

test('"call next" refuses to invent somebody when nobody is due', async () => {
  clear();
  /*
   * "Call next" always means now, so this one case has to live on today's
   * date rather than the fixed date the ordering tests use: a booking three
   * hours out, and nobody else.
   */
  const soon = new Date(Date.now() + 3 * 3600 * 1000);
  const todayKey = clock.dateKey();
  const apptId = db.prepare(
    `INSERT INTO appointments (appt_no, patient_id, doctor_id, department_id, scheduled_at,
                               slot_minutes, status, created_by)
     VALUES ('APT-LATER', ?, ?, ?, ?, 15, 'checked_in', 1)`
  ).run(ids.other, ids.doctor, ids.dept, clock.wallAt(soon)).lastInsertRowid;
  const visitId = db.prepare(
    `INSERT INTO visits (visit_no, patient_id, appointment_id, doctor_id, department_id,
                         visit_type, status, token_no, arrived_at)
     VALUES ('VIS-LATER', ?, ?, ?, ?, 'opd', 'waiting_room', 1, datetime('now'))`
  ).run(ids.other, apptId, ids.doctor, ids.dept).lastInsertRowid;
  db.prepare(
    `INSERT INTO queue_tokens (category_id, issue_date, seq, label, patient_id, visit_id, room_id)
     VALUES (?, ?, 1, '08-001', ?, ?, ?)`
  ).run(ids.pedCat, todayKey, ids.other, visitId, ids.room);

  const res = await api('POST', '/api/queue/call-next', { categoryId: ids.pedCat }, 'nurse');
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /not come round|Nobody is due/i);
});

test('a consultation is closed out by the doctor, and leaves the queue', async () => {
  clear();
  const t = plant({ category: '08', arrived: '09:00' });
  assert.strictEqual((await api('POST', `/api/queue/tokens/${t.id}/call`, {}, 'doctor')).status, 200);
  assert.strictEqual((await api('POST', `/api/queue/tokens/${t.id}/serving`, {}, 'doctor')).body.status,
    'serving');
  const closed = await api('POST', `/api/queue/tokens/${t.id}/done`, {}, 'doctor');
  assert.strictEqual(closed.body.status, 'done');
  assert.ok(closed.body.done_at);

  const q = queue.queueFor({ categoryId: ids.pedCat, date: ids.date }, at('12:00'));
  assert.strictEqual(q.counts.waiting, 0);
  assert.strictEqual(q.counts.done, 1);
});

// ===================================================== what the desk prints
test('the slip carries the number, the room and how many are ahead', async () => {
  clear();
  const first = plant({ category: '08', arrived: '09:00' });
  const second = plant({ category: '08', arrived: '09:10', patient: ids.other });

  const slip = (await api('GET', `/api/queue/tokens/${second.id}/slip`)).body;
  assert.strictEqual(slip.label, '08-002');
  assert.strictEqual(slip.category, 'Paediatrics');
  assert.strictEqual(slip.room, 'OP-3');
  assert.strictEqual(slip.floor, 'First Floor');
  assert.strictEqual(slip.ahead, 1, 'one person in front of them');
  assert.strictEqual(slip.clinic, 'SAMIHA HEALTHCARE');

  /*
   * No invented wait. Until the morning has produced enough consultations
   * to measure one, the slip says the count of people and stops — "about
   * forty minutes" taken from a slot length is a promise the clinic never
   * made.
   */
  assert.strictEqual(slip.waitMinutes, null);
  assert.strictEqual((await api('GET', `/api/queue/tokens/${first.id}/slip`)).body.ahead, 0);
});

test('an estimate appears only once the morning has been measured', () => {
  clear();
  // Three closed consultations of twenty minutes each, then somebody waiting.
  for (let i = 0; i < 3; i += 1) {
    const t = plant({ category: '08', arrived: '09:00' });
    db.prepare(`UPDATE queue_tokens SET status = 'done', serving_at = ?, done_at = ? WHERE id = ?`)
      .run(stampAt('09:00'), stampAt('09:20'), t.id);
  }
  plant({ category: '08', arrived: '10:00' });
  const waiting = plant({ category: '08', arrived: '10:05', patient: ids.other });

  const q = queue.queueFor({ categoryId: ids.pedCat, date: ids.date }, at('10:10'));
  assert.strictEqual(q.averageMinutes, 20);
  const slip = queue.slip(waiting.id, at('10:10'));
  assert.strictEqual(slip.ahead, 1);
  assert.strictEqual(slip.waitMinutes, 20);
});

// ======================================================== the TV in the hall
test('the waiting-room screen shows one floor, with numbers and no names', () => {
  clear();
  const t = plant({ category: '08', arrived: '09:00' });
  db.prepare("UPDATE queue_tokens SET status = 'called', called_at = ? WHERE id = ?")
    .run(stampAt('09:05'), t.id);
  plant({ category: '08', arrived: '09:10', patient: ids.other });

  const first = queue.display('First Floor', ids.date, at('09:06'));
  assert.deepStrictEqual(first.floors, ['Ground Floor', 'First Floor']);
  const panel = first.panels.find((p) => p.room.name === 'OP-3');
  assert.strictEqual(panel.nowCalling.label, '08-001');
  assert.deepStrictEqual(panel.upNext.map((u) => u.label), ['08-002']);
  assert.ok(panel.room.specialties.includes('Paediatrics'),
    'the panel names the clinics sitting in that room');

  // A waiting room is a public place.
  const json = JSON.stringify(first);
  assert.ok(!/Queue Tester/.test(json), 'no patient names on the wall');
  assert.ok(!/SPD\d/.test(json), 'and no UHIDs either');

  // The screen downstairs does not call people to a room upstairs.
  const ground = queue.display('Ground Floor', ids.date, at('09:06'));
  assert.ok(ground.panels.every((p) => p.room.floor === 'Ground Floor'));
  assert.ok(!JSON.stringify(ground.panels).includes('08-001'));
});

test('a counter with a queue of its own shows up on both floors\' screens', () => {
  clear();
  const lab = queue.categories().find((c) => c.code === '12');
  const t = queue.issue({ categoryId: lab.id, date: ids.date });
  db.prepare("UPDATE queue_tokens SET status = 'called', called_at = ? WHERE id = ?")
    .run(stampAt('09:05'), t.id);

  for (const floor of ['Ground Floor', 'First Floor']) {
    const d = queue.display(floor, ids.date, at('09:06'));
    const counter = d.counters.find((c) => c.counter.code === '12');
    assert.ok(counter, `${floor} shows the laboratory`);
    assert.strictEqual(counter.nowCalling.label, '12-001');
  }
});

// ============================================================ arrival & roles
test('recording an arrival hands out the token for that department', async () => {
  clear();
  const made = await api('POST', '/api/patients', {
    firstName: 'Arrival', lastName: 'Check', gender: 'female', age: 9,
    phone: '9000000456', consentTreatment: true,
  });
  const res = await api('POST', '/api/visits/arrive', {
    patientId: made.body.id, doctorId: ids.doctor, reasonForVisit: 'Cough',
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.queueToken, 'a token comes back with the arrival');
  assert.match(res.body.queueToken.label, /^08-\d{3}$/);
  assert.strictEqual(res.body.queueToken.room_name, 'OP-3');

  // Opening the visit again shows the same token — never a second number.
  const visit = (await api('GET', `/api/visits/${res.body.visit.id}`)).body;
  assert.strictEqual(visit.queueToken.id, res.body.queueToken.id);
  const reprint = await api('POST', `/api/queue/visits/${res.body.visit.id}/token`, {});
  assert.strictEqual(reprint.body.id, res.body.queueToken.id, 'reprinting reuses the token');
});

test('a department with no category yet gets no token, and the desk is told', async () => {
  clear();
  const onc = db.prepare("SELECT id FROM departments WHERE code = 'ONC'").get();
  db.prepare('UPDATE departments SET queue_category_id = NULL WHERE id = ?').run(onc.id);
  const doctor = db.prepare("SELECT id FROM users WHERE role = 'doctor' AND department_id = ?")
    .get(onc.id);

  const made = await api('POST', '/api/patients', {
    firstName: 'Nocat', gender: 'male', age: 60, phone: '9000000789', consentTreatment: true,
  });
  const res = await api('POST', '/api/visits/arrive', {
    patientId: made.body.id, departmentId: onc.id,
    doctorId: doctor ? doctor.id : ids.doctor, reasonForVisit: 'Review',
  });
  assert.strictEqual(res.status, 201, 'the patient is in the building either way');
  if (!doctor) return; // the seed may not staff oncology; the arrival still stands
  assert.strictEqual(res.body.queueToken, null);
  assert.match(res.body.queueNote, /no category/i);
});

test('the queue is the desk\'s and the clinical staff\'s; the rooms are admin\'s', async () => {
  clear();
  const t = plant({ category: '08', arrived: '09:00' });

  // Reception, nurses and doctors call.
  assert.strictEqual((await api('POST', `/api/queue/tokens/${t.id}/uncall`, {}, 'nurse')).status, 200);
  assert.strictEqual((await api('POST', `/api/queue/tokens/${t.id}/call`, {}, 'doctor')).status, 200);

  // The cashier does not.
  assert.strictEqual((await api('POST', `/api/queue/tokens/${t.id}/call`, {}, 'cashier')).status, 403);

  // The rooms and the codes are set up by admin, not by the front desk.
  assert.strictEqual((await api('PATCH', `/api/queue/rooms/${ids.room}`,
    { note: 'Paediatrics morning clinic' }, 'reception')).status, 403);
  assert.strictEqual((await api('PATCH', `/api/queue/rooms/${ids.room}`,
    { note: 'Paediatrics morning clinic' }, 'admin')).status, 200);

  // And the screen is readable by anybody signed in, because it is a
  // television in a corridor.
  assert.strictEqual((await api('GET', '/api/queue/display?floor=First%20Floor', undefined, 'lab')).status, 200);
  assert.strictEqual((await api('GET', '/api/queue/display', undefined, null)).status, 401);
});

test('a code is two digits, and two queues may not share one', async () => {
  const cats = queue.categories();
  const ped = cats.find((c) => c.code === '08');
  const car = cats.find((c) => c.code === '02');

  const bad = await api('PATCH', `/api/queue/categories/${ped.id}`, { code: '8' }, 'admin');
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /two digits/);

  const clash = await api('PATCH', `/api/queue/categories/${ped.id}`, { code: car.code }, 'admin');
  assert.strictEqual(clash.status, 409);
  assert.match(clash.body.error, /already/i);

  assert.strictEqual(queue.categories().find((c) => c.id === ped.id).code, '08',
    'and nothing moved');
});

test('a room that tokens point at is switched off rather than deleted', async () => {
  clear();
  plant({ category: '08', arrived: '09:00' });
  const res = await api('DELETE', `/api/queue/rooms/${ids.room}`, undefined, 'admin');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.deactivated, true);
  assert.strictEqual(res.body.removed, false);
  assert.ok(res.body.tokens >= 1);

  // The token still says where that patient was sent.
  const still = queue.tokensFor({ date: ids.date })[0];
  assert.strictEqual(still.room_name, 'OP-3');
  await api('PATCH', `/api/queue/rooms/${ids.room}`, { active: true }, 'admin');
});

// ============================================ the clinic's own OP allocation
test('the consulting rooms are numbered through the building, as the plan draws them', () => {
  const rooms = queue.rooms().filter((r) => r.name.startsWith('OP-'));
  assert.deepStrictEqual(
    rooms.map((r) => `${r.floor}:${r.name}`),
    ['Ground Floor:OP-1', 'Ground Floor:OP-2',
      'First Floor:OP-3', 'First Floor:OP-4', 'First Floor:OP-5'],
    'OP-1 and OP-2 downstairs, OP-3 to OP-5 up — not one and two on each floor');

  // The imaging rooms are on the list too, on the floors the plan puts them.
  const all = queue.rooms().map((r) => `${r.floor}:${r.name}`);
  assert.ok(all.includes('Ground Floor:USG'));
  assert.ok(all.includes('First Floor:X-Ray'));
});

test('a fifth room is there to be filled, and starts empty', () => {
  /*
   * OP-5 is added to the building rather than to the allocation: a clinic
   * that has been running for months has already put its specialties where
   * it wants them, and a new room must not move any of them. The clinic
   * fills it from Queue → Set-up.
   */
  const op5 = queue.rooms().find((r) => r.name === 'OP-5');
  assert.ok(op5, 'the fifth consulting room is on the list');
  assert.strictEqual(op5.floor, 'First Floor');
  assert.strictEqual(op5.active, 1);
  assert.strictEqual(op5.categories.length, 0,
    'and nothing has been moved into it behind the clinic\'s back');
});

test('each specialty starts in the room the clinic allocated it', () => {
  // Paediatrics is moved to OP-3 by these tests' own set-up, so it is the
  // one specialty not asserted here.
  const where = (code) => {
    const cat = queue.categories().find((c) => c.code === code);
    const room = queue.roomOfCategory(cat.id);
    return room ? room.name : null;
  };
  assert.strictEqual(where('05'), 'OP-1', 'General / Internal Medicine downstairs');
  assert.strictEqual(where('06'), 'OP-1', 'General Surgery downstairs');
  assert.strictEqual(where('07'), 'OP-2', 'Obstetrics & Gynaecology downstairs');
  assert.strictEqual(where('10'), 'OP-3', 'the dentist in the dental room on the plan');
  assert.strictEqual(where('02'), 'OP-4', 'Cardiology upstairs');
  assert.strictEqual(where('09'), 'OP-4', 'Orthopaedics upstairs');
});

test('a counter carries a floor instead of a room, and the slip says it', () => {
  clear();
  const xray = queue.categories().find((c) => c.code === '19');
  assert.strictEqual(xray.location, 'First Floor');

  const t = queue.issue({ categoryId: xray.id, date: ids.date });
  assert.strictEqual(t.room_id, null, 'the X-ray is not a consulting room');
  const slip = queue.slip(t.id);
  assert.strictEqual(slip.room, null);
  assert.strictEqual(slip.location, 'First Floor',
    'and a patient holding 19-001 is still told which floor to walk to');
});

test('moving a clinic takes the people waiting in it to the new room', async () => {
  clear();
  const from = queue.rooms().find((r) => r.name === 'OP-3');
  const to = queue.rooms().find((r) => r.name === 'OP-1');

  const waiting = plant({ category: '08', arrived: '09:00' });
  const calledIn = plant({ category: '08', arrived: '09:10', patient: ids.other });
  db.prepare("UPDATE queue_tokens SET status = 'called', called_at = ? WHERE id = ?")
    .run(stampAt('09:12'), calledIn.id);
  assert.strictEqual(queue.tokenOr404(waiting.id).room_name, 'OP-3');

  /*
   * Over the wire first, to prove the front desk may do this at all — the
   * route moves today's queue, and these tokens are dated, so the count it
   * reports is of today's and is zero here.
   */
  const res = await api('POST', `/api/queue/categories/${ids.pedCat}/room`,
    { roomId: to.id }, 'reception');
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.from.name, 'OP-3');
  assert.strictEqual(res.body.to.name, 'OP-1');

  // Then the move itself, against the day these tokens were issued on.
  queue.assignCategoryRoom(ids.pedCat, from.id, { date: ids.date });
  const moved = queue.assignCategoryRoom(ids.pedCat, to.id, { date: ids.date });
  assert.strictEqual(moved.moved, 1, 'one patient was still waiting');

  assert.strictEqual(queue.tokenOr404(waiting.id).room_name, 'OP-1',
    'the queue follows the doctor');
  assert.strictEqual(queue.tokenOr404(calledIn.id).room_name, 'OP-3',
    'somebody already called stays at the door they were called to');

  // The next token issued goes to the new room without being told.
  assert.strictEqual(queue.issue({ categoryId: ids.pedCat, date: ids.date,
    patientId: null, again: true }).room_name, 'OP-1');

  // And it is one call to swap it back.
  const back = await api('POST', `/api/queue/categories/${ids.pedCat}/room`,
    { roomId: from.id }, 'reception');
  assert.strictEqual(back.body.to.name, 'OP-3');
  assert.strictEqual(queue.roomOfCategory(ids.pedCat).name, 'OP-3');
  queue.assignCategoryRoom(ids.pedCat, from.id, { date: ids.date });
});

test('a clinic sits in one room at a time, so moving it does not leave it in two', () => {
  const op4 = queue.rooms().find((r) => r.name === 'OP-4');
  const op1 = queue.rooms().find((r) => r.name === 'OP-1');
  const derm = queue.categories().find((c) => c.code === '11');

  queue.assignCategoryRoom(derm.id, op1.id);
  const stillInFour = queue.rooms().find((r) => r.id === op4.id)
    .categories.some((c) => c.id === derm.id);
  assert.strictEqual(stillInFour, false, 'it left the room it was in');
  assert.strictEqual(queue.roomOfCategory(derm.id).name, 'OP-1');
  queue.assignCategoryRoom(derm.id, op4.id);
});

test('the queue can be left behind when the move is only for later', async () => {
  clear();
  const waiting = plant({ category: '08', arrived: '09:00' });
  const to = queue.rooms().find((r) => r.name === 'OP-4');

  const res = queue.assignCategoryRoom(ids.pedCat, to.id,
    { moveWaiting: false, date: ids.date });
  assert.strictEqual(res.moved, 0);
  assert.strictEqual(queue.tokenOr404(waiting.id).room_name, 'OP-3',
    'the people already holding a slip are left where the slip sent them');
  queue.assignCategoryRoom(ids.pedCat, ids.room);
});

// ====================================== the queue reads the doctor's hours
/**
 * Fix hours for a doctor on the test's date, optionally naming a room.
 * This is the same row the staff screen writes.
 */
function fixHours(doctorId, from, to, roomId = null) {
  return db.prepare(
    `INSERT INTO doctor_availability
       (doctor_id, avail_date, start_time, end_time, slot_minutes, max_tokens, op_room_id, created_by)
     VALUES (?, ?, ?, ?, 15, 0, ?, 1)`
  ).run(doctorId, ids.date, from, to, roomId).lastInsertRowid;
}
const clearHours = () => db.prepare('DELETE FROM doctor_availability').run();

test('a ten o\'clock booking is due at ten, not at whatever UTC says', () => {
  clear();
  /*
   * The appointment book stores wall clock — somebody typed 10:00 meaning
   * ten in the morning in Melapalayam — while the database stamps arrivals
   * in UTC. Compare the two without converting and a server running on UTC
   * decides a ten o'clock patient is not due until half past three, holds
   * every booking back all morning and lets the walk-ins past. That is the
   * failure this asserts against.
   */
  const booked = plant({ category: '08', arrived: '09:50', booked: '10:00' });
  const walkIn = plant({ category: '08', arrived: '08:00', patient: ids.other });

  const before = queue.queueFor({ categoryId: ids.pedCat, date: ids.date }, at('09:55'));
  assert.strictEqual(before.next.id, walkIn.id, 'at five to ten the walk-in still fills the gap');

  const after = queue.queueFor({ categoryId: ids.pedCat, date: ids.date }, at('10:00'));
  assert.strictEqual(after.next.id, booked.id, 'at ten the booking is due');
  assert.match(after.queue[0].why, /^Booked 10:00/, 'and reads as the time it was booked for');
});

test('the token names the doctor whose hours cover this minute', () => {
  clear();
  clearHours();
  const room = queue.rooms().find((r) => r.name === 'OP-1');
  fixHours(ids.doctor, '09:00', '13:00', room.id);

  const t = queue.issue({ categoryId: ids.pedCat, date: ids.date, at: at('10:00'), again: true });
  assert.strictEqual(t.doctor_id, ids.doctor, 'read from the hours, not asked for again');
  assert.strictEqual(t.room_name, 'OP-1', 'and the room those hours name');
  assert.strictEqual(t.room_floor, 'Ground Floor');

  const slip = queue.slip(t.id);
  assert.strictEqual(slip.doctor, db.prepare('SELECT name FROM users WHERE id = ?')
    .get(ids.doctor).name);
  assert.match(slip.doctorHours, /9:00 AM – 1:00 PM/, 'the slip says when they sit');
  assert.strictEqual(slip.room, 'OP-1');
  clearHours();
});

test('the room on the hours beats the doctor\'s usual room and the specialty\'s', () => {
  clear();
  clearHours();
  const op1 = queue.rooms().find((r) => r.name === 'OP-1');
  const op4 = queue.rooms().find((r) => r.name === 'OP-4');

  // Their usual room is OP-1; this evening's hours are upstairs in OP-4.
  queue.setDoctorRoom(ids.doctor, op1.id);
  fixHours(ids.doctor, '00:01', '23:59', op4.id);
  assert.strictEqual(queue.issue({ categoryId: ids.pedCat, date: ids.date, at: at('10:00'),
    again: true }).room_name, 'OP-4', 'the hours name the door');

  // With no room on the hours it falls back to the usual room …
  clearHours();
  fixHours(ids.doctor, '00:01', '23:59', null);
  assert.strictEqual(queue.issue({ categoryId: ids.pedCat, date: ids.date, at: at('10:00'),
    again: true }).room_name, 'OP-1', 'then where the doctor usually sits');

  // … and with neither, to wherever the specialty sits.
  queue.setDoctorRoom(ids.doctor, null);
  assert.strictEqual(queue.issue({ categoryId: ids.pedCat, date: ids.date, at: at('10:00'),
    again: true }).room_name, 'OP-3', 'then where the specialty sits');
  clearHours();
});

test('two doctors sitting at once means the slip names neither', () => {
  clear();
  clearHours();
  const second = db.prepare(
    `INSERT INTO users (staff_code, name, email, password_hash, role, department_id, active)
     VALUES ('EMPQ1', 'Dr. Second Paediatrician', 'second@samiha.local', 'x', 'doctor', ?, 1)`
  ).run(ids.dept).lastInsertRowid;
  fixHours(ids.doctor, '00:01', '23:59');
  fixHours(second, '00:01', '23:59');

  const t = queue.issue({ categoryId: ids.pedCat, date: ids.date, at: at('10:00'), again: true });
  assert.strictEqual(t.doctor_id, null,
    'a slip naming the wrong doctor is worse than one naming none');
  assert.strictEqual(t.room_name, 'OP-3', 'the room is still right');

  db.prepare('DELETE FROM users WHERE id = ?').run(second);
  clearHours();
});

test('a doctor on leave is not sitting, whatever the rota says', () => {
  clearHours();
  fixHours(ids.doctor, '00:01', '23:59');
  assert.strictEqual(queue.dutyFor(ids.pedCat, { date: ids.date, at: at('10:00') }).now.length, 1);

  db.prepare('INSERT INTO doctor_leaves (doctor_id, leave_date, reason) VALUES (?, ?, ?)')
    .run(ids.doctor, ids.date, 'Family function');
  assert.strictEqual(queue.dutyFor(ids.pedCat, { date: ids.date, at: at('10:00') }).now.length, 0);

  db.prepare('DELETE FROM doctor_leaves WHERE doctor_id = ? AND leave_date = ?')
    .run(ids.doctor, ids.date);
  clearHours();
});

test('the duty board says where the hours and the allocation disagree', async () => {
  clearHours();
  const op1 = queue.rooms().find((r) => r.name === 'OP-1');
  // Paediatrics sits in OP-3, but today's hours put the doctor in OP-1.
  fixHours(ids.doctor, '00:01', '23:59', op1.id);

  const board = queue.dutyBoard(ids.date, at('10:00'));
  const ped = board.find((r) => r.category.code === '08');
  assert.strictEqual(ped.room.name, 'OP-3', 'the specialty is allocated to OP-3');
  assert.strictEqual(ped.now.length, 1, 'and somebody is sitting');
  assert.strictEqual(ped.elsewhere.length, 1, 'but not in that room, and it says so');
  assert.strictEqual(ped.elsewhere[0].room, 'OP-1');

  // A specialty nobody is in for today reads as exactly that.
  const ent = board.find((r) => r.category.code === '03');
  assert.strictEqual(ent.now.length, 0);
  assert.strictEqual(ent.doctors.length, 0);

  const res = await api('GET', `/api/queue/duty?date=${ids.date}`, undefined, 'reception');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.rows.length >= 11);
  clearHours();
});

test('the waiting-room screen names the doctor sitting in that room now', () => {
  clear();
  clearHours();
  const op3 = queue.rooms().find((r) => r.name === 'OP-3');
  fixHours(ids.doctor, '00:01', '23:59', op3.id);

  const d = queue.display('First Floor', ids.date, at('10:00'));
  const panel = d.panels.find((p) => p.room.name === 'OP-3');
  // The dentist sits in this room too, on the weekly rota — so the screen
  // names both, which is right: both are behind that door this morning.
  assert.ok(panel.room.sittingNow.includes(
    db.prepare('SELECT name FROM users WHERE id = ?').get(ids.doctor).name),
  'the doctor whose hours cover this minute is named on the wall');
  clearHours();
});

// ============================================ the poster beside the numbers
test('a poster is stored whole and served back as the image it was', async () => {
  // A one-pixel PNG is enough: what is asserted is the round trip, not the
  // picture. The clinic's real posters are a few hundred KB of JPEG.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const made = await api('POST', '/api/queue/slides', {
    data: `data:image/png;base64,${png}`, title: 'Sunday wellness package', seconds: 15,
  }, 'reception');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.strictEqual(made.body.mime, 'image/png');
  assert.ok(made.body.bytes > 0);

  const res = await fetch(`${base}/api/queue/slides/${made.body.id}/image`,
    { headers: { Authorization: `Bearer ${tokens.reception}` } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'image/png');
  const back = Buffer.from(await res.arrayBuffer());
  assert.deepStrictEqual(back, Buffer.from(png, 'base64'), 'the bytes come back unchanged');

  // And it reaches the screen with the numbers, in one call.
  const screen = await api('GET', '/api/queue/display', undefined, 'reception');
  assert.ok(screen.body.slides.some((s) => s.id === made.body.id));
  assert.strictEqual(screen.body.slides.find((s) => s.id === made.body.id).seconds, 15);
});

test('a poster can be pinned to one floor, and taken off without deleting it', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const made = await api('POST', '/api/queue/slides',
    { data: `data:image/png;base64,${png}`, title: 'Dental camp', floor: 'First Floor' }, 'reception');
  assert.strictEqual(made.status, 201);

  const upstairs = await api('GET', '/api/queue/display?floor=First%20Floor', undefined, 'reception');
  const downstairs = await api('GET', '/api/queue/display?floor=Ground%20Floor', undefined, 'reception');
  assert.ok(upstairs.body.slides.some((s) => s.id === made.body.id));
  assert.ok(!downstairs.body.slides.some((s) => s.id === made.body.id),
    'the dental camp poster does not play on the other floor');

  /*
   * But it does play on the common board. Every television in the clinic
   * shows all floors at once, so a poster pinned to one of them would
   * otherwise never be seen on the only board anybody is looking at.
   */
  const everywhere = await api('GET', '/api/queue/display', undefined, 'reception');
  assert.ok(everywhere.body.slides.some((s) => s.id === made.body.id));

  await api('PATCH', `/api/queue/slides/${made.body.id}`, { active: false }, 'reception');
  const after = await api('GET', '/api/queue/display?floor=First%20Floor', undefined, 'reception');
  assert.ok(!after.body.slides.some((s) => s.id === made.body.id),
    'off the screen, still on the list to put back');
  assert.ok((await api('GET', '/api/queue/slides', undefined, 'reception')).body.rows
    .some((s) => s.id === made.body.id));
});

test('what cannot go on the screen is refused with a reason', async () => {
  const pdf = await api('POST', '/api/queue/slides',
    { data: 'data:application/pdf;base64,JVBERi0=', title: 'A PDF' }, 'reception');
  assert.strictEqual(pdf.status, 400);
  assert.match(pdf.body.error, /JPEG|PNG/i);

  const nothing = await api('POST', '/api/queue/slides', { title: 'No file' }, 'reception');
  assert.strictEqual(nothing.status, 400);

  // The screen is readable by anybody signed in; what plays on it is not
  // theirs to change.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.strictEqual((await api('POST', '/api/queue/slides',
    { data: `data:image/png;base64,${png}` }, 'lab')).status, 403);
});

// ======================================================= the imaging rooms
test('the scan and the X-ray are rooms a doctor can be allocated to', () => {
  const rooms = queue.rooms();
  const usg = rooms.find((r) => r.name === 'USG');
  const xray = rooms.find((r) => r.name === 'X-Ray');
  assert.ok(usg, 'the scan room is on the list');
  assert.ok(xray, 'and the X-ray room');
  assert.strictEqual(usg.floor, 'Ground Floor', 'as the floor plan has them');
  assert.strictEqual(xray.floor, 'First Floor');

  /*
   * The radiologist sits in one of them, and their patients are sent there
   * — which is the whole reason the rooms exist in this list.
   */
  const radiology = queue.categories().find((c) => c.code === '22');
  const doctorId = db.prepare(
    `INSERT INTO users (staff_code, name, email, password_hash, role, department_id, active)
     VALUES ('EMPRAD', 'Dr. Radiologist', 'rad@samiha.local', 'x', 'doctor',
             (SELECT id FROM departments WHERE code = 'RAD'), 1)`).run().lastInsertRowid;
  queue.setDoctorRoom(doctorId, xray.id);

  const token = queue.issue({ categoryId: radiology.id, doctorId, date: '2026-05-05' });
  assert.strictEqual(token.label, '22-001');
  assert.strictEqual(token.room_name, 'X-Ray');
  assert.strictEqual(token.room_floor, 'First Floor');

  db.prepare('DELETE FROM queue_tokens WHERE id = ?').run(token.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(doctorId);
});

test('a room with nothing in it stays off the television', () => {
  clear();
  /*
   * The imaging rooms are empty most of the morning, and a television
   * cannot be scrolled: a line that says nothing is a line taken from one
   * that does. They appear the moment somebody is called to them.
   */
  const before = queue.display('First Floor', ids.date, at('10:00'));
  assert.ok(!before.panels.some((p) => p.room.name === 'X-Ray'));
  assert.ok(before.panels.some((p) => p.room.name === 'OP-3'),
    'a consulting room with a clinic allocated keeps its place all day');

  const xray = queue.rooms().find((r) => r.name === 'X-Ray');
  const t = queue.issue({ categoryId: ids.pedCat, roomId: xray.id, date: ids.date });
  const after = queue.display('First Floor', ids.date, at('10:00'));
  assert.ok(after.panels.some((p) => p.room.name === 'X-Ray'), 'and now it is on the board');
  db.prepare('DELETE FROM queue_tokens WHERE id = ?').run(t.id);
});

// ============================================ the poster library and its clock
test('a poster plays only between its dates', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  /*
   * The clinic's own days, not the server's. A poster's dates are read in
   * clinic time, so a test that worked out "tomorrow" in UTC would, for the
   * five and a half hours after midnight in Melapalayam, be asserting that
   * today's poster is not up yet.
   */
  const day = (shift) => clock.dateKey(new Date(Date.now() + shift * 86400000));
  const yesterday = day(-1);
  const tomorrow = day(1);

  const live = await api('POST', '/api/queue/slides',
    { data: `data:image/png;base64,${png}`, title: 'Opening offer', fromDate: yesterday, toDate: tomorrow },
    'reception');
  const over = await api('POST', '/api/queue/slides',
    { data: `data:image/png;base64,${png}`, title: 'Last month', fromDate: '2020-01-01', toDate: yesterday },
    'reception');
  const later = await api('POST', '/api/queue/slides',
    { data: `data:image/png;base64,${png}`, title: 'Next month', fromDate: tomorrow },
    'reception');

  const screen = await api('GET', '/api/queue/display', undefined, 'reception');
  const on = screen.body.slides.map((s) => s.id);
  assert.ok(on.includes(live.body.id), 'the campaign that is running plays');
  assert.ok(!on.includes(over.body.id), 'the one that ended does not');
  assert.ok(!on.includes(later.body.id), 'nor the one that has not started');

  // The library still holds all three, and says which is on the wall.
  const lib = await api('GET', '/api/queue/slides', undefined, 'reception');
  const byId = Object.fromEntries(lib.body.rows.map((r) => [r.id, r]));
  assert.strictEqual(byId[live.body.id].playing, true);
  assert.strictEqual(byId[over.body.id].playing, false);
  assert.strictEqual(byId[later.body.id].active, 1, 'kept, not deleted');

  await api('POST', '/api/queue/slides/bulk',
    { ids: [live.body.id, over.body.id, later.body.id], action: 'remove' }, 'reception');
});

test('a poster can be given the hours of the day it is worth showing', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const made = await api('POST', '/api/queue/slides',
    { data: `data:image/png;base64,${png}`, title: 'Evening clinic' }, 'reception');

  /*
   * The clinic's clock, not the server's: a window of 17:00–22:00 means
   * five in the evening in Melapalayam, and a server running on UTC would
   * otherwise decide it is time at half past ten at night.
   */
  const clock = require('../src/lib/clinicClock');
  const nowHHMM = clock.clockHHMM();
  const plus = (mins) => {
    const t = new Date(clock.fromWall(`${clock.dateKey()} ${nowHHMM}:00`) + mins * 60000);
    return clock.clockHHMM(t);
  };

  await api('POST', '/api/queue/slides/bulk',
    { ids: [made.body.id], fromTime: plus(60), toTime: plus(120) }, 'reception');
  let screen = await api('GET', '/api/queue/display', undefined, 'reception');
  assert.ok(!screen.body.slides.some((s) => s.id === made.body.id), 'not its hour yet');

  await api('POST', '/api/queue/slides/bulk',
    { ids: [made.body.id], fromTime: plus(-60), toTime: plus(60) }, 'reception');
  screen = await api('GET', '/api/queue/display', undefined, 'reception');
  assert.ok(screen.body.slides.some((s) => s.id === made.body.id), 'and now it is');

  // Clearing the times lifts the limit.
  await api('POST', '/api/queue/slides/bulk',
    { ids: [made.body.id], fromTime: '', toTime: '' }, 'reception');
  const lib = await api('GET', '/api/queue/slides', undefined, 'reception');
  const row = lib.body.rows.find((r) => r.id === made.body.id);
  assert.strictEqual(row.from_time, null);
  assert.strictEqual(row.playing, true);

  await api('POST', '/api/queue/slides/bulk', { ids: [made.body.id], action: 'remove' }, 'reception');
});

test('a set of posters is changed together, or not at all', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const ids = [];
  for (const title of ['Camp A', 'Camp B', 'Camp C']) {
    ids.push((await api('POST', '/api/queue/slides',
      { data: `data:image/png;base64,${png}`, title }, 'reception')).body.id);
  }

  const out = await api('POST', '/api/queue/slides/bulk',
    { ids, fromDate: '2027-01-01', toDate: '2027-01-10', seconds: 20 }, 'reception');
  assert.strictEqual(out.body.changed, 3);

  const lib = await api('GET', '/api/queue/slides', undefined, 'reception');
  for (const id of ids) {
    const row = lib.body.rows.find((r) => r.id === id);
    assert.strictEqual(row.from_date, '2027-01-01');
    assert.strictEqual(row.seconds, 20);
    assert.strictEqual(row.playing, false, 'a campaign next year is not on the wall today');
  }

  // A bad date changes none of them.
  const bad = await api('POST', '/api/queue/slides/bulk',
    { ids, fromDate: '2027-02-01', toDate: '2027-01-01' }, 'reception');
  assert.strictEqual(bad.status, 400);
  const after = await api('GET', '/api/queue/slides', undefined, 'reception');
  assert.strictEqual(after.body.rows.find((r) => r.id === ids[0]).from_date, '2027-01-01');

  assert.strictEqual((await api('POST', '/api/queue/slides/bulk',
    { ids, active: false }, 'lab')).status, 403);
  await api('POST', '/api/queue/slides/bulk', { ids, action: 'remove' }, 'reception');
});
