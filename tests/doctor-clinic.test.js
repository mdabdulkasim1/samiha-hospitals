'use strict';
/**
 * Fixed visiting hours, the doctor's own sign-in and day list, and the alert
 * that reaches a doctor's phone the moment the front desk books someone.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-doc-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');
const scheduling = require('../src/services/scheduling');

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

/** A date `days` ahead, as the ERP writes dates. */
const day = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return scheduling.dateKey(d);
};

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['imran', 'imran@samiha.local'], ['sara', 'sara@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.imran = db.prepare("SELECT id FROM users WHERE email = 'imran@samiha.local'").get().id;
  ids.sara = db.prepare("SELECT id FROM users WHERE email = 'sara@samiha.local'").get().id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// -------------------------------------------------------- visiting hours
test('a doctor sits only for the hours admin fixes on a date', async () => {
  ids.day = day(3);
  const set = await api('POST', `/api/masters/doctors/${ids.imran}/availability`, {
    date: ids.day, startTime: '18:00', endTime: '20:00', slotMinutes: 15, note: 'Evening OPD',
  });
  assert.strictEqual(set.status, 201, JSON.stringify(set.body));
  assert.strictEqual(set.body.added, 1);

  // Two hours at fifteen minutes is eight patients, and not one more.
  const avail = (await api('GET',
    `/api/appointments/availability?doctorId=${ids.imran}&date=${ids.day}`, undefined, 'reception')).body;
  assert.strictEqual(avail.slots.length, 8);
  assert.strictEqual(avail.slots[0].time, '18:00');
  assert.strictEqual(avail.slots.at(-1).time, '19:45');

  // And the desk is told the window, not just a count.
  const days = (await api('GET',
    `/api/appointments/availability?doctorId=${ids.imran}&count=10`, undefined, 'reception')).body;
  const fixed = days.dates.find((d) => d.date === ids.day);
  assert.strictEqual(fixed.hours, '6:00 PM – 8:00 PM');
});

test('a fixed day replaces the weekly rota rather than adding to it', async () => {
  // The seeded rota runs mornings and evenings; the fixed day above does not.
  const weekly = (await api('GET',
    `/api/appointments/availability?doctorId=${ids.imran}&date=${day(4)}`, undefined, 'reception')).body;
  const fixed = (await api('GET',
    `/api/appointments/availability?doctorId=${ids.imran}&date=${ids.day}`, undefined, 'reception')).body;
  assert.ok(weekly.slots.length > fixed.slots.length,
    'the standing rota offers more than the two-hour window that replaced it');
  assert.ok(!fixed.slots.some((s) => s.time < '18:00'), 'nothing before the fixed start is offered');
});

test('a cap on patients is honoured even when the hours would hold more', async () => {
  const capped = day(5);
  await api('POST', `/api/masters/doctors/${ids.sara}/availability`, {
    date: capped, startTime: '17:00', endTime: '20:00', slotMinutes: 15, maxTokens: 6,
  });
  const avail = (await api('GET',
    `/api/appointments/availability?doctorId=${ids.sara}&date=${capped}`, undefined, 'reception')).body;
  assert.strictEqual(avail.slots.length, 6, 'three hours would hold twelve, but the doctor will see six');
});

test('the same window repeats across a range in one entry', async () => {
  const res = await api('POST', `/api/masters/doctors/${ids.sara}/availability`, {
    from: day(10), to: day(24), weekdays: [2, 5], startTime: '18:00', endTime: '20:00',
  });
  assert.strictEqual(res.status, 201);
  assert.ok(res.body.added >= 4, 'a fortnight of Tuesdays and Fridays');

  const listed = (await api('GET',
    `/api/masters/doctors/${ids.sara}/availability?from=${day(10)}&to=${day(24)}`)).body;
  for (const r of listed.rows) {
    assert.ok([2, 5].includes(new Date(r.avail_date + 'T00:00:00').getDay()));
    assert.strictEqual(r.capacity, 8);
  }

  // Running it again changes nothing rather than doubling the day up.
  const again = await api('POST', `/api/masters/doctors/${ids.sara}/availability`, {
    from: day(10), to: day(24), weekdays: [2, 5], startTime: '18:00', endTime: '20:00',
  });
  assert.strictEqual(again.body.added, 0);
  assert.ok(again.body.skipped.length >= 4);
});

test('hours cannot be fixed backwards or on top of each other', async () => {
  const backwards = await api('POST', `/api/masters/doctors/${ids.imran}/availability`, {
    date: day(6), startTime: '20:00', endTime: '18:00',
  });
  assert.strictEqual(backwards.status, 400);
  assert.match(backwards.body.error, /end after it starts/i);

  const overlap = await api('POST', `/api/masters/doctors/${ids.imran}/availability`, {
    date: ids.day, startTime: '19:00', endTime: '21:00',
  });
  assert.strictEqual(overlap.body.added, 0);
  assert.match(overlap.body.skipped[0].reason, /overlaps/);
});

// ------------------------------------------------- booking alerts to the doctor
test('booking a patient reaches the doctor, not just the desk screen', async () => {
  const booked = await api('POST', '/api/appointments', {
    doctorId: ids.imran, scheduledAt: `${ids.day} 18:30:00`,
    guestName: 'Anitha Raj', guestPhone: '9840099887', reason: 'fever review',
  }, 'reception');
  assert.strictEqual(booked.status, 201, JSON.stringify(booked.body));
  ids.appt = booked.body.id;

  // The bell inside the ERP.
  const bell = (await api('GET', '/api/me/notifications', undefined, 'imran')).body;
  assert.strictEqual(bell.unread, 1);
  assert.match(bell.rows[0].title, /New appointment — Anitha Raj/);
  assert.match(bell.rows[0].body, /token 1/);
  assert.match(bell.rows[0].body, /Booked by/);
  assert.strictEqual(bell.rows[0].route, `#/myclinic?date=${ids.day}`);

  // And a copy on the doctor's own mobile.
  const queued = db.prepare(
    "SELECT * FROM notifications WHERE template = 'doctor_new_appointment' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.ok(queued, 'a WhatsApp went to the doctor');
  const doctorPhone = db.prepare('SELECT phone FROM users WHERE id = ?').get(ids.imran).phone;
  assert.strictEqual(queued.to_addr, doctorPhone);
  assert.match(queued.body, /Anitha Raj/);
  assert.match(queued.body, /New appointment/);
});

test('a doctor with no mobile on file simply gets the bell', async () => {
  db.prepare('UPDATE users SET phone = NULL, whatsapp = NULL WHERE id = ?').run(ids.sara);
  const before = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE template = 'doctor_new_appointment'").get().c;

  const booked = await api('POST', '/api/appointments', {
    doctorId: ids.sara, scheduledAt: `${day(5)} 17:15:00`, guestName: 'Baby Karthik',
  }, 'reception');
  assert.strictEqual(booked.status, 201);

  const after = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE template = 'doctor_new_appointment'").get().c;
  assert.strictEqual(after, before, 'nothing is queued to nowhere');
  assert.strictEqual((await api('GET', '/api/me/notifications', undefined, 'sara')).body.unread, 1);
});

test('alerts are read, and are nobody else\'s to read', async () => {
  const mine = (await api('GET', '/api/me/notifications', undefined, 'imran')).body;
  assert.strictEqual((await api('POST', `/api/me/notifications/${mine.rows[0].id}/read`, {}, 'imran')).body.unread, 0);

  // Sara's bell is untouched by Imran reading his.
  assert.strictEqual((await api('GET', '/api/me/notifications', undefined, 'sara')).body.unread, 1);
  // And Imran cannot mark Sara's read: the id is simply not his.
  const saraAlert = (await api('GET', '/api/me/notifications', undefined, 'sara')).body.rows[0];
  await api('POST', `/api/me/notifications/${saraAlert.id}/read`, {}, 'imran');
  assert.strictEqual((await api('GET', '/api/me/notifications', undefined, 'sara')).body.unread, 1);
});

test('cancelling or moving an appointment tells the doctor too', async () => {
  await api('POST', '/api/me/notifications/read-all', {}, 'imran');
  const moved = await api('PATCH', `/api/appointments/${ids.appt}`, {
    scheduledAt: `${ids.day} 19:15:00`,
  }, 'reception');
  assert.strictEqual(moved.status, 200);
  let bell = (await api('GET', '/api/me/notifications', undefined, 'imran')).body;
  assert.match(bell.rows[0].title, /Appointment moved/);

  await api('PATCH', `/api/appointments/${ids.appt}`, { status: 'cancelled' }, 'reception');
  bell = (await api('GET', '/api/me/notifications', undefined, 'imran')).body;
  assert.match(bell.rows[0].title, /Appointment cancelled/);
});

// ------------------------------------------------------------- the doctor's day
test('a doctor signs in and sees their own day', async () => {
  const booked = await api('POST', '/api/appointments', {
    doctorId: ids.imran, scheduledAt: `${ids.day} 18:00:00`,
    guestName: 'Suresh Babu', guestPhone: '9840012312', reason: 'BP review',
  }, 'reception');
  assert.strictEqual(booked.status, 201);

  const day1 = (await api('GET', `/api/appointments/my-day?date=${ids.day}`, undefined, 'imran')).body;
  assert.strictEqual(day1.doctor.id, ids.imran);
  assert.strictEqual(day1.hours, '6:00 PM – 8:00 PM');
  assert.strictEqual(day1.summary.booked, 1, 'the cancelled one does not count');
  assert.strictEqual(day1.summary.cancelled, 1);
  assert.strictEqual(day1.rows.find((r) => r.status !== 'cancelled').display_name, 'Suresh Babu');
  assert.strictEqual(day1.rows.find((r) => r.status !== 'cancelled').time, '6:00 PM');
  assert.ok(day1.upcoming.some((u) => u.date === ids.day && u.hours === '6:00 PM – 8:00 PM'));
});

test('a doctor cannot open another doctor\'s clinic list', async () => {
  const peek = await api('GET', `/api/appointments/my-day?doctorId=${ids.sara}`, undefined, 'imran');
  assert.strictEqual(peek.status, 403);

  // The front desk and admin can, because they run the diary.
  assert.strictEqual((await api('GET', `/api/appointments/my-day?doctorId=${ids.sara}`, undefined, 'reception')).status, 200);
});

test('a doctor blocks their own day, and nobody can then be booked', async () => {
  const blockDate = day(7);
  await api('POST', `/api/masters/doctors/${ids.imran}/availability`, {
    date: blockDate, startTime: '18:00', endTime: '20:00',
  });
  assert.ok((await api('GET',
    `/api/appointments/availability?doctorId=${ids.imran}&date=${blockDate}`, undefined, 'reception')).body.slots.length);

  const blocked = await api('POST', '/api/me/leave', { date: blockDate, reason: 'Conference' }, 'imran');
  assert.strictEqual(blocked.status, 201);
  assert.strictEqual(blocked.body.booked, 0);

  assert.strictEqual((await api('GET',
    `/api/appointments/availability?doctorId=${ids.imran}&date=${blockDate}`, undefined, 'reception')).body.slots.length, 0);

  const refused = await api('POST', '/api/appointments', {
    doctorId: ids.imran, scheduledAt: `${blockDate} 18:30:00`, guestName: 'Too Late',
  }, 'reception');
  assert.strictEqual(refused.status, 409);
  assert.match(refused.body.error, /on leave|already booked/i);
});

// ------------------------------------------------------- the dashboard board
test('the dashboard counts appointments doctor by doctor', async () => {
  const today = scheduling.dateKey(new Date());
  await api('POST', `/api/masters/doctors/${ids.imran}/availability`, {
    date: today, startTime: '18:00', endTime: '20:00',
  });
  for (const [time, name] of [['18:00', 'Board One'], ['18:15', 'Board Two']]) {
    const r = await api('POST', '/api/appointments', {
      doctorId: ids.imran, scheduledAt: `${today} ${time}:00`, guestName: name,
    }, 'reception');
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  }

  const board = (await api('GET', '/api/reports/dashboard')).body.byDoctor;
  assert.ok(Array.isArray(board));

  const imran = board.find((r) => r.id === ids.imran);
  assert.strictEqual(imran.booked, 2);
  assert.strictEqual(imran.new_patients, 2);
  assert.strictEqual(imran.completed, 0);
  assert.strictEqual(imran.hours, '6:00 PM – 8:00 PM');
  assert.strictEqual(imran.free, 6, 'eight slots in the window, two taken');
  assert.strictEqual(imran.on_leave, 0);
  assert.ok(imran.specialization, 'the board says what each doctor does');

  // Busiest first, so the desk reads the top of the list.
  assert.strictEqual(board[0].id, ids.imran);
  for (let i = 1; i < board.length; i += 1) assert.ok(board[i - 1].booked >= board[i].booked);

  // A doctor with neither hours nor a booking is not at the clinic today.
  assert.ok(board.every((r) => r.total > 0 || r.hours));
});

test('a cancelled appointment leaves the doctor\'s count, but is still shown', async () => {
  const today = scheduling.dateKey(new Date());
  const appt = (await api('GET', `/api/appointments/my-day?date=${today}&doctorId=${ids.imran}`,
    undefined, 'reception')).body.rows[0];
  await api('PATCH', `/api/appointments/${appt.id}`, { status: 'cancelled' }, 'reception');

  const imran = (await api('GET', '/api/reports/dashboard')).body.byDoctor.find((r) => r.id === ids.imran);
  assert.strictEqual(imran.booked, 1, 'the cancellation comes off the count');
  assert.strictEqual(imran.cancelled, 1, 'but is still reported');
  assert.strictEqual(imran.free, 7, 'and the slot goes back on sale');
});

test('a doctor on leave shows as such, with nothing free', async () => {
  const soon = day(9);
  await api('POST', `/api/masters/doctors/${ids.sara}/availability`, {
    date: soon, startTime: '18:00', endTime: '20:00',
  });
  await api('POST', '/api/me/leave', { date: soon, reason: 'Conference' }, 'sara');

  const board = (await api('GET', `/api/reports/dashboard?date=${soon}`)).body.byDoctor;
  const sara = board.find((r) => r.id === ids.sara);
  assert.strictEqual(sara.on_leave, 1);
  assert.strictEqual(sara.free, 0);
});

test('a doctor sets where their alerts go', async () => {
  const saved = await api('PATCH', '/api/me/alert-settings', {
    whatsapp: '9840055555', notifyWhatsapp: true, notifyEmail: true,
  }, 'imran');
  assert.strictEqual(saved.status, 200);

  const now = (await api('GET', '/api/me/alert-settings', undefined, 'imran')).body;
  assert.strictEqual(now.whatsapp, '919840055555', 'normalised to a full Indian mobile');
  assert.strictEqual(now.notify_email, 1);

  await api('POST', '/api/appointments', {
    doctorId: ids.imran, scheduledAt: `${ids.day} 19:30:00`, guestName: 'Latha M',
  }, 'reception');
  const queued = db.prepare(
    "SELECT * FROM notifications WHERE template = 'doctor_new_appointment' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.strictEqual(queued.to_addr, '919840055555', 'the number they chose, not the staff record');
});

// ------------------------------------------------- doctor month by month
test('the monthly report counts appointments and bills doctor by doctor', async () => {
  // A patient of Dr Sheikh's, billed and paid in full.
  const p1 = (await api('POST', '/api/patients', {
    firstName: 'Monthly', lastName: 'One', phone: '9845031001', gender: 'male',
    dateOfBirth: '1985-04-04', consentTreatment: true,
  })).body;
  const v1 = (await api('POST', '/api/visits/arrive', {
    patientId: p1.id, reasonForVisit: 'Review', doctorId: ids.imran,
  }, 'reception')).body.visit;
  const i1 = (await api('POST', '/api/billing/invoices', { patientId: p1.id, visitId: v1.id })).body;
  await api('POST', `/api/billing/invoices/${i1.id}/items`, {
    description: 'Consultation', unitPrice: 500, refType: 'consultation',
  });
  await api('POST', `/api/billing/invoices/${i1.id}/payments`, { amount: 500, mode: 'cash' });

  // A patient of Dr Ahmed's, billed but only part paid.
  const p2 = (await api('POST', '/api/patients', {
    firstName: 'Monthly', lastName: 'Two', phone: '9845031002', gender: 'female',
    dateOfBirth: '2019-06-06', consentTreatment: true,
  })).body;
  const v2 = (await api('POST', '/api/visits/arrive', {
    patientId: p2.id, reasonForVisit: 'Cough', doctorId: ids.sara,
  }, 'reception')).body.visit;
  const i2 = (await api('POST', '/api/billing/invoices', { patientId: p2.id, visitId: v2.id })).body;
  await api('POST', `/api/billing/invoices/${i2.id}/items`, {
    description: 'Consultation', unitPrice: 450, refType: 'consultation',
  });
  await api('POST', `/api/billing/invoices/${i2.id}/items`, {
    description: 'Nebulisation', unitPrice: 250, refType: 'service',
  });
  await api('POST', `/api/billing/invoices/${i2.id}/payments`, { amount: 300, mode: 'upi' });

  const report = (await api('GET', '/api/reports/doctor-monthly?months=3')).body;
  const thisMonth = report.months.at(-1).key;
  assert.strictEqual(thisMonth, scheduling.dateKey(new Date()).slice(0, 7));

  const imran = report.rows.find((r) => r.id === ids.imran);
  assert.strictEqual(imran.months[thisMonth].visits, 1);
  assert.strictEqual(imran.months[thisMonth].billed, 500);
  assert.strictEqual(imran.months[thisMonth].collected, 500);
  assert.strictEqual(imran.months[thisMonth].outstanding, 0);
  assert.ok(imran.months[thisMonth].booked > 0, 'appointments count in the same row');

  const sara = report.rows.find((r) => r.id === ids.sara);
  assert.strictEqual(sara.months[thisMonth].billed, 700, 'every line on the bill counts to the doctor');
  assert.strictEqual(sara.months[thisMonth].collected, 300);
  assert.strictEqual(sara.months[thisMonth].outstanding, 400, 'the gap between billed and taken is visible');

  // Per-patient value — and no division by zero for a doctor with bills but no
  // appointments booked in the window.
  assert.strictEqual(imran.total.perPatient,
    Math.round((imran.total.billed / imran.total.booked) * 100) / 100);
  assert.ok(Number.isFinite(sara.total.perPatient));
  if (!sara.total.booked) assert.strictEqual(sara.total.perPatient, 0);
  for (let i = 1; i < report.rows.length; i += 1) {
    assert.ok(report.rows[i - 1].total.billed >= report.rows[i].total.billed);
  }

  // The columns foot.
  const summed = report.rows.reduce((a, r) => a + r.months[thisMonth].billed, 0);
  assert.strictEqual(report.totals.byMonth[thisMonth].billed, Math.round(summed * 100) / 100);
  assert.strictEqual(report.totals.overall.billed,
    Math.round(report.rows.reduce((a, r) => a + r.total.billed, 0) * 100) / 100);
});

test('the monthly window is asked for in months and answered in months', async () => {
  const three = (await api('GET', '/api/reports/doctor-monthly?months=3')).body;
  const twelve = (await api('GET', '/api/reports/doctor-monthly?months=12')).body;
  assert.strictEqual(three.months.length, 3);
  assert.strictEqual(twelve.months.length, 12);
  assert.strictEqual(twelve.months.at(-1).key, three.months.at(-1).key, 'both end this month');
  assert.match(three.months[0].label, /^[A-Z][a-z]+ \d{4}$/);

  // Silly windows are clamped rather than allowed to scan for ever.
  assert.strictEqual((await api('GET', '/api/reports/doctor-monthly?months=999')).body.months.length, 24);
  assert.strictEqual((await api('GET', '/api/reports/doctor-monthly?months=0')).body.months.length, 6);
});

test('the monthly report is management information, not for the front desk', async () => {
  assert.strictEqual((await api('GET', '/api/reports/doctor-monthly', undefined, 'admin')).status, 200);
  assert.strictEqual((await api('GET', '/api/reports/doctor-monthly', undefined, 'reception')).status, 200);
  assert.strictEqual((await api('GET', '/api/reports/doctor-monthly', undefined, 'imran')).status, 403);
});
