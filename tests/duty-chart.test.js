'use strict';
/**
 * The duty chart.
 *
 * The chart is the document the clinic actually runs on: the desk quotes it
 * on the phone, the queue reads it to know whose room is whose, the
 * appointment book books against it, and a patient on WhatsApp is told from
 * it whether anybody is in this evening. The whole value of putting it in
 * the ERP is that those four stop being four separate copies that drift
 * apart, so most of what is asserted here is not "the chart saved" but
 * "changing the chart changed what the patient is told".
 *
 * The rest is about the two kinds of mistake. One doctor in two places at
 * once is a typing error and is refused. Two doctors in one room is a
 * decision the clinic may have taken on purpose — its own printed chart
 * carries exactly that as a footnote — so it is reported and recorded,
 * never blocked. Software that refused it would just be a reason to keep
 * using the paper.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-chart-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
require('../src/db/catalogue').sync({ quiet: true });
const { db } = require('../src/db');
const chart = require('../src/services/dutyChart');
const scheduling = require('../src/services/scheduling');
const queue = require('../src/services/queue');
const bot = require('../src/services/whatsappBot');
const app = require('../src/server');

let server;
let base;
const tokens = {};
const ids = {};

async function api(method, p, body, as = 'admin') {
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

/** Monday, since the chart's interesting cases all live on a working day. */
const MON = 1;
const nextMonday = () => {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return scheduling.dateKey(d);
};

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [who, username] of Object.entries({
    admin: 'admin@samiha.local', reception: 'reception@samiha.local',
    nurse: 'nurse@samiha.local',
  })) {
    const res = await api('POST', '/api/auth/login', { username, password: 'samiha@123' }, null);
    assert.ok(res.body && res.body.token, `${who} could not sign in`);
    tokens[who] = res.body.token;
  }

  ids.dentist = db.prepare(
    "SELECT u.id FROM users u JOIN departments d ON d.id = u.department_id "
    + "WHERE u.role = 'doctor' AND d.code = 'DEN'").get().id;
  ids.gp = db.prepare(
    "SELECT u.id FROM users u JOIN departments d ON d.id = u.department_id "
    + "WHERE u.role = 'doctor' AND d.code = 'IM'").get().id;
  ids.op3 = queue.rooms().find((r) => r.name === 'OP-3').id;
  ids.op1 = queue.rooms().find((r) => r.name === 'OP-1').id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ======================================================= the chart itself
test('the chart carries every doctor, and the specialties nobody covers yet', () => {
  const week = chart.chart();
  assert.ok(week.doctors.length >= 7);
  assert.strictEqual(week.days.length, 7);
  assert.strictEqual(week.dayStart, '07:00');
  assert.strictEqual(week.dayEnd, '22:00');

  /*
   * The clinic's own sheet has eight rows reading "to be confirmed", and a
   * chart that dropped them would hide the recruiting it exists to prompt.
   */
  assert.ok(week.awaiting.some((c) => c.name === 'ENT'));
  assert.ok(week.awaiting.every((c) => typeof c.code === 'string'));
});

test('a day is written whole, and clearing it means the doctor is not sitting', async () => {
  const set = await api('PUT', `/api/schedule/doctors/${ids.dentist}/days/${MON}`, {
    windows: [{ start: '16:00', end: '21:00', slotMinutes: 15, roomId: ids.op3 }],
  });
  assert.strictEqual(set.status, 200, JSON.stringify(set.body));
  assert.strictEqual(set.body.windows.length, 1);
  assert.strictEqual(set.body.windows[0].start_time, '16:00');
  assert.strictEqual(set.body.windows[0].room_name, 'OP-3');

  // Two sessions replace the one, rather than adding to it.
  const two = await api('PUT', `/api/schedule/doctors/${ids.dentist}/days/${MON}`, {
    windows: [
      { start: '09:00', end: '13:00', roomId: ids.op3 },
      { start: '16:00', end: '21:00', roomId: ids.op3 },
    ],
  });
  assert.strictEqual(two.body.windows.length, 2);

  const cleared = await api('PUT', `/api/schedule/doctors/${ids.dentist}/days/0`, { windows: [] });
  assert.strictEqual(cleared.body.windows.length, 0, 'Sunday: not sitting');
});

test('one doctor cannot be in two places at once — that is a typing mistake', async () => {
  const res = await api('PUT', `/api/schedule/doctors/${ids.dentist}/days/2`, {
    windows: [{ start: '09:00', end: '13:00' }, { start: '12:00', end: '17:00' }],
  });
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /overlap/i);
});

test('a window that ends before it starts is refused, and the day is untouched', async () => {
  const before = chart.windowsFor(ids.dentist).filter((w) => w.weekday === MON).length;
  const res = await api('PUT', `/api/schedule/doctors/${ids.dentist}/days/${MON}`, {
    windows: [{ start: '18:00', end: '17:00' }],
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(chart.windowsFor(ids.dentist).filter((w) => w.weekday === MON).length, before,
    'nothing was written');
});

test('two doctors in one room is reported, not refused', async () => {
  await api('PUT', `/api/schedule/doctors/${ids.gp}/days/${MON}`, {
    windows: [{ start: '17:00', end: '22:00', roomId: ids.op1 }],
  });
  const surgeon = db.prepare(
    "SELECT u.id FROM users u JOIN departments d ON d.id = u.department_id "
    + "WHERE u.role = 'doctor' AND d.code = 'SUR'").get();
  if (!surgeon) return; // the seed may not staff surgery; the rule is the same

  const res = await api('PUT', `/api/schedule/doctors/${surgeon.id}/days/${MON}`, {
    windows: [{ start: '17:00', end: '19:00', roomId: ids.op1 }],
  });
  assert.strictEqual(res.status, 200, 'the clinic may run two clinics in one room on purpose');

  const clash = chart.clashes().find((c) => c.weekday === MON && c.room === 'OP-1');
  assert.ok(clash, 'but it is reported');
  assert.strictEqual(clash.from, '5:00 PM');
  assert.strictEqual(clash.to, '7:00 PM');
  assert.strictEqual(clash.doctors.length, 2);
});

test('"the same every day" is one decision, not six', async () => {
  await api('PUT', `/api/schedule/doctors/${ids.dentist}/days/${MON}`, {
    windows: [{ start: '16:00', end: '21:00', roomId: ids.op3 }],
  });
  const copied = await api('POST', `/api/schedule/doctors/${ids.dentist}/copy`,
    { from: MON, to: [2, 3, 4, 5, 6] });
  assert.strictEqual(copied.status, 200);
  assert.strictEqual(copied.body.copied, 5);

  for (const day of [2, 3, 4, 5, 6]) {
    const windows = chart.windowsFor(ids.dentist).filter((w) => w.weekday === day);
    assert.strictEqual(windows.length, 1, `${chart.DAYS[day]} copied`);
    assert.strictEqual(windows[0].start_time, '16:00');
    assert.strictEqual(windows[0].op_room_id, ids.op3);
  }
  assert.strictEqual(chart.windowsFor(ids.dentist).filter((w) => w.weekday === 0).length, 0,
    'Sunday was left alone');
});

test('the room column moves the hours with it', async () => {
  await api('POST', `/api/schedule/doctors/${ids.dentist}/room`, { roomId: ids.op1 });
  assert.ok(chart.windowsFor(ids.dentist).every((w) => w.op_room_id === ids.op1),
    'a chart whose column and cells disagree sends patients to the wrong door');

  await api('POST', `/api/schedule/doctors/${ids.dentist}/room`, { roomId: ids.op3 });
  assert.ok(chart.windowsFor(ids.dentist).every((w) => w.op_room_id === ids.op3));
});

// ============================================ what the rest of the ERP reads
test('the appointment book offers exactly the hours the chart holds', () => {
  const monday = nextMonday();
  const slots = scheduling.availableSlots(ids.dentist, monday);
  assert.ok(slots.length, 'the dentist sits on Mondays');
  assert.ok(slots.every((s) => s >= '16:00' && s < '21:00'),
    'and the book offers nothing outside four to nine');

  // Narrow the chart; the book narrows with it, with nothing else touched.
  chart.setDay(ids.dentist, 1, [{ start: '18:00', end: '19:00', roomId: ids.op3 }]);
  const after = scheduling.availableSlots(ids.dentist, monday);
  assert.ok(after.every((s) => s >= '18:00' && s < '19:00'));
  assert.ok(after.length < slots.length);

  chart.setDay(ids.dentist, 1, [{ start: '16:00', end: '21:00', roomId: ids.op3 }]);
});

test('the queue sends the patient to the room the chart names', () => {
  const monday = nextMonday();
  const weekday = scheduling.parseDateKey(monday).getDay();
  assert.strictEqual(weekday, 1);

  const room = queue.roomFor({
    doctorId: ids.dentist,
    categoryId: queue.categories().find((c) => c.code === '10').id,
    date: monday,
    at: new Date(`${monday}T12:00:00Z`),
  });
  assert.strictEqual(room.name, 'OP-3', 'read off the chart, not entered a second time');
});

test('WhatsApp answers from the chart rather than from a line typed in the code', () => {
  const today = scheduling.dateKey(new Date());
  const weekday = new Date().getDay();

  // Put one doctor in today with hours nobody could have guessed.
  chart.setDay(ids.gp, weekday, [{ start: '11:15', end: '13:45', roomId: ids.op1 }]);

  const reply = bot.handleIncoming('919000000777', '7');
  assert.match(reply, /Doctors in today/);
  assert.match(reply, /11:15 AM–1:45 PM/, 'the hours the chart holds, to the minute');
  assert.ok(!/9:00 AM – 1:00 PM and 5:00 PM – 8:00 PM/.test(reply),
    'and not the timings that used to be typed into the bot');

  // Take them off today; the answer changes with it.
  chart.setDay(ids.gp, weekday, []);
  const after = bot.handleIncoming('919000000778', '7');
  assert.ok(!/11:15 AM/.test(after));

  // And somebody whose doctor is off today is told when they are next in,
  // because "not today" on its own sends them to the landline.
  chart.setDay(ids.gp, (weekday + 1) % 7, [{ start: '10:00', end: '12:00', roomId: ids.op1 }]);
  const next = chart.nextDay(ids.gp, today);
  assert.ok(next);
  assert.strictEqual(next.hours, '10:00 AM–12:00 PM');
});

test('a day of leave empties that date without touching the week', () => {
  const monday = nextMonday();
  db.prepare('INSERT INTO doctor_leaves (doctor_id, leave_date, reason) VALUES (?, ?, ?)')
    .run(ids.dentist, monday, 'Family function');

  const onDate = chart.day(1, { date: monday }).rows.find((r) => r.doctorId === ids.dentist);
  assert.strictEqual(onDate.windows.length, 0);
  assert.strictEqual(onDate.onLeave, true);

  // The weekly pattern is untouched — next Monday is still a working day.
  assert.strictEqual(chart.day(1).rows.find((r) => r.doctorId === ids.dentist).windows.length, 1);
  db.prepare('DELETE FROM doctor_leaves WHERE doctor_id = ? AND leave_date = ?')
    .run(ids.dentist, monday);
});

test('the day view places each bar where the printed chart puts it', () => {
  chart.setDay(ids.dentist, 1, [{ start: '16:00', end: '21:00', roomId: ids.op3 }]);
  const day = chart.day(1);
  const row = day.rows.find((r) => r.doctorId === ids.dentist);
  const bar = row.windows[0];

  // Four in the afternoon on a 7 AM – 10 PM ruler is nine hours in of
  // fifteen, and the bar runs five of those fifteen hours.
  assert.strictEqual(Math.round(bar.left), 60);
  assert.strictEqual(Math.round(bar.width), 33);
  assert.strictEqual(bar.label, '4:00 PM–9:00 PM');
  assert.strictEqual(day.hours.length, 16, 'seven in the morning to ten at night');
});

// =================================================================== access
test('the desk reads the chart; only the owner and the administrator write it', async () => {
  assert.strictEqual((await api('GET', '/api/schedule', undefined, 'reception')).status, 200,
    'a receptionist who cannot see when the dentist sits tells people to call back');
  assert.strictEqual((await api('GET', '/api/schedule/day/1', undefined, 'nurse')).status, 200);

  assert.strictEqual((await api('PUT', `/api/schedule/doctors/${ids.dentist}/days/3`,
    { windows: [] }, 'reception')).status, 403);
  assert.strictEqual((await api('POST', `/api/schedule/doctors/${ids.dentist}/room`,
    { roomId: ids.op1 }, 'nurse')).status, 403);
  assert.strictEqual((await api('GET', '/api/schedule', undefined, null)).status, 401);

  await api('POST', `/api/schedule/doctors/${ids.dentist}/room`, { roomId: ids.op3 });
});

test('"who is in on this date" is one question with one answer', async () => {
  const monday = nextMonday();
  const res = await api('GET', `/api/schedule/on/${monday}`, undefined, 'reception');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.day, 'Monday');
  assert.ok(res.body.sitting.some((s) => s.room === 'OP-3'));
  assert.ok(Array.isArray(res.body.away));
  // Everybody is accounted for: sitting or not, and if not, when next.
  assert.strictEqual(res.body.sitting.length + res.body.away.length,
    chart.chart().doctors.length);
});

// ====================================================== starting from blank
test('a doctor\'s week can be cleared without touching their fixed dates', async () => {
  const monday = nextMonday();
  chart.setDay(ids.dentist, 1, [{ start: '16:00', end: '21:00', roomId: ids.op3 }]);
  chart.copyDay(ids.dentist, 1, [2, 3, 4, 5, 6]);

  /*
   * A camp fixed for one date and a day of leave are decisions about
   * particular days. Wiping the pattern must not quietly reopen an
   * appointment book on a day the doctor is away.
   */
  db.prepare(
    `INSERT INTO doctor_availability (doctor_id, avail_date, start_time, end_time,
       slot_minutes, max_tokens, created_by) VALUES (?, ?, '10:00', '12:00', 15, 0, 1)`
  ).run(ids.dentist, monday);

  const res = await api('DELETE', `/api/schedule/doctors/${ids.dentist}`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.cleared >= 6);
  assert.strictEqual(chart.windowsFor(ids.dentist).length, 0, 'the week is blank');

  // The fixed date survives and still drives the book.
  const slots = scheduling.availableSlots(ids.dentist, monday);
  assert.ok(slots.length, 'the camp fixed for that date still stands');
  assert.ok(slots.every((s) => s >= '10:00' && s < '12:00'));
  db.prepare('DELETE FROM doctor_availability WHERE doctor_id = ?').run(ids.dentist);
});

test('the whole chart can be wiped to enter the clinic\'s own timings', async () => {
  chart.setDay(ids.dentist, 1, [{ start: '16:00', end: '21:00' }]);
  chart.setDay(ids.gp, 1, [{ start: '09:00', end: '14:00' }]);
  assert.ok(db.prepare('SELECT COUNT(*) AS c FROM doctor_schedules').get().c > 0);

  const res = await api('DELETE', '/api/schedule');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM doctor_schedules').get().c, 0);

  // The chart still lists everybody — blank, waiting to be filled in.
  assert.ok(res.body.chart.doctors.length >= 7);
  assert.ok(res.body.chart.doctors.every((d) => d.hours === 0));
  assert.strictEqual(chart.clashes().length, 0);

  // And the front desk cannot do it.
  assert.strictEqual((await api('DELETE', '/api/schedule', undefined, 'reception')).status, 403);
});

test('ENT, Urology and Diabetology are departments now, so consultants can be put in them', () => {
  for (const [code, category] of [['ENT', '03'], ['URO', '04'], ['DIA', '21']]) {
    const dept = db.prepare('SELECT * FROM departments WHERE code = ?').get(code);
    assert.ok(dept, `${code} is a department`);
    assert.strictEqual(dept.kind, 'specialist');

    const cat = db.prepare('SELECT code FROM queue_categories WHERE id = ?').get(dept.queue_category_id);
    assert.strictEqual(cat.code, category,
      'and it feeds the queue code the clinic printed for it');
  }

  // With a doctor in it, the specialty leaves the "to be confirmed" list.
  const ent = db.prepare("SELECT id FROM departments WHERE code = 'ENT'").get().id;
  assert.ok(chart.chart().awaiting.some((c) => c.name === 'ENT'));
  const doctorId = db.prepare(
    `INSERT INTO users (staff_code, name, email, password_hash, role, department_id, active)
     VALUES ('EMPENT', 'Dr. ENT Consultant', 'ent@samiha.local', 'x', 'doctor', ?, 1)`
  ).run(ent).lastInsertRowid;

  const week = chart.chart();
  assert.ok(!week.awaiting.some((c) => c.name === 'ENT'), 'it is covered now');
  assert.ok(week.doctors.some((d) => d.id === doctorId && d.category_name === 'ENT'));
  db.prepare('DELETE FROM users WHERE id = ?').run(doctorId);
});

test('Diabetology counts past the printed sheet rather than disturbing it', () => {
  /*
   * The clinic printed twenty codes. Diabetology is on its duty chart and
   * was not on that sheet, so it takes 21 — a number nobody has in their
   * hand — and every code that was printed still means what it did.
   */
  const dia = db.prepare("SELECT * FROM queue_categories WHERE code = '21'").get();
  assert.strictEqual(dia.name, 'Diabetology');
  assert.strictEqual(dia.kind, 'consult');

  for (const [code, name] of [['08', 'Paediatrics'], ['12', 'Laboratory Services'],
    ['19', 'X-Ray'], ['20', 'USG (Ultrasound)']]) {
    assert.strictEqual(db.prepare('SELECT name FROM queue_categories WHERE code = ?').get(code).name,
      name, `${code} still means what the sheet says`);
  }

  // And its tokens read 21-001, like any other queue.
  const token = queue.issue({ categoryId: dia.id, date: '2026-04-01' });
  assert.strictEqual(token.label, '21-001');
});
