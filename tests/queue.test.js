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

const at = (hhmm) => new Date(`${ids.date}T${hhmm}:00Z`);

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
      seq, `${ids.date} ${arrived}:00`).lastInsertRowid;
  }

  const id = db.prepare(
    `INSERT INTO queue_tokens (category_id, issue_date, seq, label, patient_id, visit_id,
                               doctor_id, room_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cat.id, ids.date, seq, queue.labelFor(cat.code, seq), patient || ids.patient,
    visitId, ids.doctor, ids.room, `${ids.date} ${arrived}:00`).lastInsertRowid;
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

  // First Floor OP 1 takes Paediatrics, as the clinic would enter it.
  const rooms = queue.rooms();
  const room = rooms.find((r) => r.floor === 'First Floor' && r.name === 'OP 1');
  const pedCat = queue.categories().find((c) => c.code === '08');
  queue.setRoomCategories(room.id, [pedCat.id]);
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
  assert.strictEqual(cats.length, 20);
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
  assert.strictEqual(t.room_name, 'OP 1');
  assert.strictEqual(t.room_floor, 'First Floor');
});

test('a doctor\'s own room beats the specialty\'s room', () => {
  clear();
  const ground = queue.rooms().find((r) => r.floor === 'Ground Floor' && r.name === 'OP 2');
  queue.setDoctorRoom(ids.doctor, ground.id);
  const t = queue.issue({ categoryId: ids.pedCat, doctorId: ids.doctor, date: ids.date });
  assert.strictEqual(t.room_name, 'OP 2');
  assert.strictEqual(t.room_floor, 'Ground Floor');
  queue.setDoctorRoom(ids.doctor, null);
});

test('a room with no specialty set sends nobody anywhere, rather than guessing', () => {
  clear();
  const ent = queue.categories().find((c) => c.code === '03');
  const t = queue.issue({ categoryId: ent.id, date: ids.date });
  assert.strictEqual(t.room_id, null, 'no room invented');
  assert.strictEqual(t.label, '03-001', 'but the number is still issued');
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
  const todayKey = new Date().toISOString().slice(0, 10);
  const apptId = db.prepare(
    `INSERT INTO appointments (appt_no, patient_id, doctor_id, department_id, scheduled_at,
                               slot_minutes, status, created_by)
     VALUES ('APT-LATER', ?, ?, ?, ?, 15, 'checked_in', 1)`
  ).run(ids.other, ids.doctor, ids.dept,
    soon.toISOString().slice(0, 19).replace('T', ' ')).lastInsertRowid;
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
  assert.strictEqual(slip.room, 'OP 1');
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
      .run(`${ids.date} 09:00:00`, `${ids.date} 09:20:00`, t.id);
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
    .run(`${ids.date} 09:05:00`, t.id);
  plant({ category: '08', arrived: '09:10', patient: ids.other });

  const first = queue.display('First Floor', ids.date, at('09:06'));
  assert.deepStrictEqual(first.floors, ['Ground Floor', 'First Floor']);
  const panel = first.panels.find((p) => p.room.name === 'OP 1');
  assert.strictEqual(panel.nowCalling.label, '08-001');
  assert.deepStrictEqual(panel.upNext.map((u) => u.label), ['08-002']);
  assert.deepStrictEqual(panel.room.specialties, ['Paediatrics']);

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
    .run(`${ids.date} 09:05:00`, t.id);

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
  assert.strictEqual(res.body.queueToken.room_name, 'OP 1');

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
  assert.strictEqual(still.room_name, 'OP 1');
  await api('PATCH', `/api/queue/rooms/${ids.room}`, { active: true }, 'admin');
});
