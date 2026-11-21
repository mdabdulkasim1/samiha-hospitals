'use strict';
/**
 * The duty chart.
 *
 * The clinic keeps this on a sheet of paper: a row for every specialty with
 * the doctor who covers it, the OP room, the floor, and a bar across the
 * hours showing when they sit. It is the document the whole building runs
 * on — the desk quotes it on the phone, the queue reads it to know whose
 * room is whose, and a patient on WhatsApp is told from it whether anybody
 * is in this evening.
 *
 * So this is not a second copy of that information. It writes the weekly
 * rota (`doctor_schedules`) that the appointment book, the queue and the
 * WhatsApp bot already read, which is the whole point: the chart is the one
 * place the clinic edits, and everything downstream follows because it was
 * already looking at the same table. A per-date window
 * (`doctor_availability`) still overrides the pattern for one day — a camp,
 * a doctor away — exactly as before.
 *
 * Two things are deliberate:
 *
 *   - A row with no doctor is still a row. The clinic's own chart has eight
 *     specialties reading "to be confirmed", and leaving them off would
 *     hide the recruiting the chart exists to prompt.
 *   - Clashes are reported, never refused. The clinic's printed chart
 *     carries "Clash: OP-1 has both GP and Surgery 5–7 PM" in its own
 *     footnote, which means the clinic knows and has decided. Software that
 *     refused to record it would just be a reason to keep the paper.
 */
const { db } = require('../db');
const { badRequest, notFound, conflict } = require('../lib/http');
const scheduling = require('./scheduling');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* The clinic's day, as the printed chart draws it: seven in the morning to
 * ten at night. Only the frame for the bars — a window outside it is still
 * recorded, it simply draws to the edge. */
const DAY_START = '07:00';
const DAY_END = '22:00';

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (h * 60) + (m || 0);
};
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
const clean = (s) => (s === undefined || s === null || s === '' ? null : String(s).trim());

// =========================================================================
// Reading the chart
// =========================================================================

const DOCTORS = `
  SELECT u.id, u.name, u.department_id, u.op_room_id,
         d.name AS department_name, d.queue_category_id,
         c.code AS category_code, c.name AS category_name,
         r.name AS room_name, r.floor AS room_floor, r.floor_order,
         dp.qualification, dp.specialization, dp.slot_minutes
    FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN queue_categories c ON c.id = d.queue_category_id
    LEFT JOIN op_rooms r ON r.id = u.op_room_id
    LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
   WHERE u.role = 'doctor' AND u.active = 1 AND u.erased_at IS NULL`;

const windowsFor = (doctorId) => db.prepare(
  `SELECT s.id, s.weekday, s.start_time, s.end_time, s.slot_minutes, s.max_tokens,
          s.op_room_id, s.note, r.name AS room_name, r.floor AS room_floor
     FROM doctor_schedules s
     LEFT JOIN op_rooms r ON r.id = s.op_room_id
    WHERE s.doctor_id = ? AND s.active = 1
    ORDER BY s.weekday, s.start_time`).all(doctorId);

/**
 * The whole week, doctor by doctor.
 *
 * Ordered the way the printed chart is: by room, so the two ground-floor
 * rooms come before the two upstairs and somebody reading it can see at a
 * glance who is in which. A doctor with no room yet falls to the end.
 */
function chart() {
  const doctors = db.prepare(`${DOCTORS} ORDER BY u.name`).all().map((doc) => {
    const windows = windowsFor(doc.id);
    const days = DAYS.map((_, weekday) => windows.filter((w) => w.weekday === weekday));
    return {
      ...doc,
      days,
      // The room the chart shows against the row: whatever their windows
      // say, falling back to the room they usually sit in.
      room: windows.find((w) => w.room_name)
        ? { name: windows.find((w) => w.room_name).room_name,
          floor: windows.find((w) => w.room_name).room_floor }
        : (doc.room_name ? { name: doc.room_name, floor: doc.room_floor } : null),
      hours: windows.length,
    };
  });

  doctors.sort((a, b) => {
    const ra = a.room ? a.room.name : 'zzz';
    const rb = b.room ? b.room.name : 'zzz';
    return ra.localeCompare(rb) || a.name.localeCompare(b.name);
  });

  /*
   * The specialties nobody covers yet, kept on the chart as the clinic's
   * own sheet keeps them. They are not rows anybody can edit — there is no
   * doctor to give hours to — but a chart that quietly dropped them would
   * hide the eight vacancies it exists to show.
   */
  const covered = new Set(doctors.map((d) => d.queue_category_id).filter(Boolean));
  const awaiting = db.prepare(
    `SELECT c.id, c.code, c.name,
            (SELECT GROUP_CONCAT(d.name, ', ') FROM departments d WHERE d.queue_category_id = c.id)
              AS departments
       FROM queue_categories c
      WHERE c.active = 1 AND c.kind = 'consult'
      ORDER BY c.sort_order, c.code`).all().filter((c) => !covered.has(c.id));

  return {
    days: DAYS,
    short: SHORT,
    dayStart: DAY_START,
    dayEnd: DAY_END,
    doctors,
    awaiting,
    rooms: db.prepare('SELECT id, name, floor, floor_order FROM op_rooms WHERE active = 1 '
      + 'ORDER BY floor_order, name').all(),
    clashes: clashes(),
  };
}

/**
 * Two doctors in one room at the same time.
 *
 * Reported rather than refused, because the clinic's own chart carries
 * exactly this as a footnote — it knows, and it has decided to run them
 * together or it has not got round to moving one. What software can do is
 * make sure nobody has to spot it by eye.
 */
function clashes() {
  const rows = db.prepare(
    `SELECT s.weekday, s.start_time, s.end_time, s.op_room_id,
            u.id AS doctor_id, u.name AS doctor_name, r.name AS room_name, r.floor AS room_floor
       FROM doctor_schedules s
       JOIN users u ON u.id = s.doctor_id
       JOIN op_rooms r ON r.id = s.op_room_id
      WHERE s.active = 1 AND u.active = 1 AND u.erased_at IS NULL
      ORDER BY s.weekday, r.name, s.start_time`).all();

  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      if (a.weekday !== b.weekday || a.op_room_id !== b.op_room_id) continue;
      if (a.doctor_id === b.doctor_id) continue;
      const overlap = toMinutes(a.start_time) < toMinutes(b.end_time)
        && toMinutes(b.start_time) < toMinutes(a.end_time);
      if (!overlap) continue;
      out.push({
        weekday: a.weekday,
        day: DAYS[a.weekday],
        room: a.room_name,
        floor: a.room_floor,
        from: scheduling.to12h(
          toMinutes(a.start_time) > toMinutes(b.start_time) ? a.start_time : b.start_time),
        to: scheduling.to12h(
          toMinutes(a.end_time) < toMinutes(b.end_time) ? a.end_time : b.end_time),
        doctors: [a.doctor_name, b.doctor_name],
      });
    }
  }
  return out;
}

// =========================================================================
// Writing the chart
// =========================================================================

/**
 * Set one doctor's hours for one day of the week.
 *
 * The whole day is replaced in one go rather than patched window by
 * window, because that is how somebody edits a chart: they look at Monday,
 * decide it is nine to two and five to ten, and write that. Sending an
 * empty list is how a day is cleared, which is what "not sitting on Sunday"
 * means.
 */
function setDay(doctorId, weekday, windows, { userId = null } = {}) {
  const doctor = db.prepare(
    "SELECT id, name FROM users WHERE id = ? AND role = 'doctor' AND erased_at IS NULL").get(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw badRequest('A weekday is 0 (Sunday) to 6 (Saturday).');
  }

  const rows = (windows || []).map((w) => {
    const start = clean(w.start) || clean(w.start_time);
    const end = clean(w.end) || clean(w.end_time);
    if (!isTime(start) || !isTime(end)) {
      throw badRequest('Give each window as HH:MM, for example 17:00 and 20:00.');
    }
    if (toMinutes(end) <= toMinutes(start)) {
      throw badRequest(`${start}–${end} ends before it starts.`);
    }
    const roomId = w.roomId === undefined ? w.op_room_id : w.roomId;
    if (roomId && !db.prepare('SELECT 1 FROM op_rooms WHERE id = ? AND active = 1').get(roomId)) {
      throw badRequest('That consulting room is not in use.');
    }
    return {
      start,
      end,
      slot: Math.min(Math.max(Number(w.slotMinutes || w.slot_minutes || 15), 5), 120),
      max: Math.max(Number(w.maxTokens || w.max_tokens || 0), 0),
      roomId: roomId || null,
      note: clean(w.note),
    };
  }).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));

  /*
   * One doctor cannot be in two places at once, and unlike a room clash
   * this one is refused: it is not a decision the clinic could have made,
   * it is a typing mistake.
   */
  for (let i = 1; i < rows.length; i += 1) {
    if (toMinutes(rows[i].start) < toMinutes(rows[i - 1].end)) {
      throw conflict(`${doctor.name} cannot sit ${rows[i - 1].start}–${rows[i - 1].end} and `
        + `${rows[i].start}–${rows[i].end} on the same day — the two overlap.`);
    }
  }

  const write = db.transaction(() => {
    db.prepare('DELETE FROM doctor_schedules WHERE doctor_id = ? AND weekday = ?')
      .run(doctorId, weekday);
    for (const r of rows) {
      db.prepare(
        `INSERT INTO doctor_schedules
           (doctor_id, weekday, start_time, end_time, slot_minutes, max_tokens, op_room_id, note, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(doctorId, weekday, r.start, r.end, r.slot, r.max, r.roomId, r.note);
    }
  });
  write();

  return { doctor, weekday, windows: windowsFor(doctorId).filter((w) => w.weekday === weekday) };
}

/**
 * The same hours on other days.
 *
 * "Monday to Saturday, five to eight" is one decision and six rows, and
 * typing it six times is how a chart ends up disagreeing with itself.
 */
function copyDay(doctorId, fromWeekday, toWeekdays, opts = {}) {
  const source = windowsFor(doctorId).filter((w) => w.weekday === fromWeekday);
  const targets = [...new Set((toWeekdays || []).map(Number))]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6 && d !== fromWeekday);
  if (!targets.length) throw badRequest('Which days should it be copied to?');

  for (const day of targets) {
    setDay(doctorId, day, source.map((w) => ({
      start: w.start_time, end: w.end_time, slotMinutes: w.slot_minutes,
      maxTokens: w.max_tokens, roomId: w.op_room_id, note: w.note,
    })), opts);
  }
  return { copied: targets.length, days: targets.map((d) => DAYS[d]) };
}

/**
 * Wipe a doctor's week, or the whole chart.
 *
 * The clinic starts from a blank sheet rather than from whatever a demo
 * install or a departed locum left behind, and then fills it in as the
 * consultants confirm. Clearing is therefore a first-class thing to do and
 * not a matter of emptying fourteen cells by hand.
 *
 * Only the weekly pattern goes. Hours fixed against a particular date and
 * days of leave are facts about specific days that somebody entered on
 * purpose, and wiping those with the rota would quietly reopen an
 * appointment book on a day the doctor is away.
 */
function clearWeek(doctorId) {
  const doctor = db.prepare(
    "SELECT id, name FROM users WHERE id = ? AND role = 'doctor' AND erased_at IS NULL").get(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  const { changes } = db.prepare('DELETE FROM doctor_schedules WHERE doctor_id = ?').run(doctorId);
  return { doctor, cleared: changes };
}

function clearAll() {
  const { changes } = db.prepare('DELETE FROM doctor_schedules').run();
  return { cleared: changes };
}

/** Which room a doctor usually sits in — the chart's own column. */
function setRoom(doctorId, roomId) {
  const doctor = db.prepare(
    "SELECT id FROM users WHERE id = ? AND role = 'doctor' AND erased_at IS NULL").get(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  if (roomId && !db.prepare('SELECT 1 FROM op_rooms WHERE id = ? AND active = 1').get(roomId)) {
    throw badRequest('That consulting room is not in use.');
  }
  const write = db.transaction(() => {
    db.prepare('UPDATE users SET op_room_id = ? WHERE id = ?').run(roomId || null, doctorId);
    /*
     * The windows follow the row. A chart where the column says OP-4 and
     * the cells still send patients to OP-1 is worse than no chart: the
     * token slip reads the cell, and the patient reads the slip.
     */
    db.prepare('UPDATE doctor_schedules SET op_room_id = ? WHERE doctor_id = ?')
      .run(roomId || null, doctorId);
  });
  write();
  return db.prepare(`${DOCTORS} AND u.id = ?`).get(doctorId);
}

// =========================================================================
// What the chart says to somebody who asks
// =========================================================================

/**
 * One day of the chart, drawn as the printed one is.
 *
 * Each row carries its bars as percentages across the clinic's day, so the
 * screen and a printout can lay them out without either re-deciding where
 * seven in the morning sits.
 */
function day(weekday, { date = null } = {}) {
  const span = toMinutes(DAY_END) - toMinutes(DAY_START);
  const place = (w) => {
    const from = Math.max(toMinutes(w.start_time), toMinutes(DAY_START));
    const to = Math.min(toMinutes(w.end_time), toMinutes(DAY_END));
    return {
      ...w,
      label: `${scheduling.to12h(w.start_time)}–${scheduling.to12h(w.end_time)}`,
      left: Math.max(0, ((from - toMinutes(DAY_START)) / span) * 100),
      width: Math.max(1.5, ((to - from) / span) * 100),
    };
  };

  const full = chart();
  const rows = full.doctors.map((doc) => {
    /*
     * A date beats the weekly pattern, because that is what the rest of
     * the system does: a window fixed for one date replaces the rota, and
     * a day of leave empties it. A chart that showed the pattern on a day
     * the doctor is away would have the desk promising appointments that
     * cannot be kept.
     */
    const windows = date
      ? (scheduling.isOnLeave(doc.id, date) ? [] : scheduling.sessionsFor(doc.id, date))
      : doc.days[weekday];
    return {
      doctor: doc.name,
      doctorId: doc.id,
      specialty: doc.category_name || doc.department_name || '—',
      room: doc.room ? doc.room.name : null,
      floor: doc.room ? doc.room.floor : null,
      onLeave: Boolean(date && scheduling.isOnLeave(doc.id, date)),
      windows: windows.map(place),
    };
  });

  return {
    weekday,
    day: DAYS[weekday],
    date,
    dayStart: DAY_START,
    dayEnd: DAY_END,
    // The hour ticks the chart is ruled with, 7 AM through 10 PM.
    hours: Array.from({ length: (span / 60) + 1 }, (_, i) => {
      const mins = toMinutes(DAY_START) + (i * 60);
      return { label: scheduling.to12h(`${String(Math.floor(mins / 60)).padStart(2, '0')}:00`)
        .replace(':00', ''), left: ((mins - toMinutes(DAY_START)) / span) * 100 };
    }),
    rows,
    awaiting: full.awaiting,
    clashes: full.clashes.filter((c) => c.weekday === weekday),
  };
}

/**
 * Who is sitting on a given date, for somebody who has asked.
 *
 * This is what the front desk says on the phone and what the WhatsApp bot
 * answers with, so it is worked out here once rather than written out in
 * each of those places and drifting apart.
 */
function onDate(date) {
  const weekday = scheduling.parseDateKey(date).getDay();
  const rows = day(weekday, { date }).rows;
  return {
    date,
    day: DAYS[weekday],
    sitting: rows.filter((r) => r.windows.length).map((r) => ({
      doctor: r.doctor, specialty: r.specialty, room: r.room, floor: r.floor,
      hours: r.windows.map((w) => w.label).join(', '),
    })),
    away: rows.filter((r) => !r.windows.length).map((r) => ({
      doctor: r.doctor, specialty: r.specialty, onLeave: r.onLeave,
      // When they are next in, so "not today" is never the whole answer.
      next: nextDay(r.doctorId, date),
    })),
  };
}

/** The next date this doctor sits, looking a fortnight ahead. */
function nextDay(doctorId, fromDate, horizon = 14) {
  const start = scheduling.parseDateKey(fromDate);
  for (let i = 1; i <= horizon; i += 1) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = scheduling.dateKey(d);
    if (scheduling.isOnLeave(doctorId, key)) continue;
    const sessions = scheduling.sessionsFor(doctorId, key);
    if (sessions.length) {
      return {
        date: key,
        day: DAYS[d.getDay()],
        hours: sessions.map((w) => `${scheduling.to12h(w.start_time)}–${scheduling.to12h(w.end_time)}`)
          .join(', '),
      };
    }
  }
  return null;
}

module.exports = {
  DAYS, SHORT, DAY_START, DAY_END,
  chart, clashes, day, onDate, nextDay,
  setDay, copyDay, setRoom, windowsFor, clearWeek, clearAll,
};
