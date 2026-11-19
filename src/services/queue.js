'use strict';
/**
 * The queue.
 *
 * A token is a two-digit category code and a sequence that starts again
 * every morning: 08-001 is the day's first Paediatrics patient, 08-002 the
 * next, and 12-001 is the first at the laboratory. The code is what makes a
 * number shouted across a waiting room mean something — two counters
 * calling "number seven" tells nobody anything, and 08-007 tells exactly
 * one person to stand up and exactly where to go.
 *
 * A patient holds one token per place they have to queue. Seen in
 * Paediatrics and sent for a blood test, they hold 08-004 and then 12-011,
 * and both are real positions in different rooms — which is why a token is
 * a row of its own rather than a number stamped on the visit.
 *
 * Who goes in next, in a consulting room, is the one rule in here with any
 * subtlety. The desk works to this:
 *
 *   A booked patient is seen at their time. Between one booking and the
 *   next, whoever walked in goes in.
 *
 * So a 10:00 appointment goes in at 10:00. If that consultation runs to
 * 10:25 and the 10:15 patient is sitting there, the 10:15 goes next — not
 * the walk-in who has been waiting since half past nine, because the 10:15
 * was promised a time and the walk-in was not. But if the next booking is
 * at 11:00 and it is now 10:30, the walk-in goes in: holding an empty room
 * for half an hour to honour an appointment that is not due yet honours
 * nothing.
 *
 * The one refinement experience forces: a booked patient who arrives late
 * is due from when they arrive, not from the time they missed. A nine
 * o'clock appointment who strolls in at half eleven does not walk past the
 * half eleven appointment who came on time. Where two are due in the same
 * minute, the one who kept their appointment goes first, and two who both
 * kept theirs are ordered by their slots — so lateness buys no place at
 * all, not even a tie.
 *
 * Positions are worked out at the moment somebody looks, never stored. A
 * queue is a fact about the clock; a stored position is a fact about when it
 * was last written down. The number on the token is the opposite — written
 * once and never recalculated, because the screen on the wall and the paper
 * in the patient's hand have to agree all morning.
 */
const { db } = require('../db');
const { badRequest, notFound, conflict } = require('../lib/http');

const now = () => new Date();
const dateKey = (d) => new Date(d).toISOString().slice(0, 10);
const stamp = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
/** SQLite datetimes are 'YYYY-MM-DD HH:MM:SS', written in UTC. */
const toTime = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}Z`).getTime() : null);
const hhmm = (s) => (s ? String(s).slice(11, 16) : '');
const trim = (s) => (s === undefined || s === null || s === '' ? null : String(s).trim());

/*
 * Past 999 the sequence carries on to 1000 rather than wrapping, as the
 * clinic's own note says. Three digits is the usual case, and the padding is
 * what makes 08-007 and 08-070 line up under each other on a screen.
 */
const labelFor = (code, seq) => `${code}-${String(seq).padStart(3, '0')}`;

// =========================================================================
// The categories
// =========================================================================

const CATS = `SELECT c.*, (SELECT GROUP_CONCAT(d.name, ', ') FROM departments d
                             WHERE d.queue_category_id = c.id) AS departments
                FROM queue_categories c`;

const categories = ({ includeInactive = false, kind } = {}) => db.prepare(
  `${CATS} WHERE 1 = 1 ${includeInactive ? '' : 'AND c.active = 1'}
     ${kind ? 'AND c.kind = ?' : ''} ORDER BY c.sort_order, c.code`
).all(...(kind ? [kind] : []));

const categoryOr404 = (id) => {
  const row = db.prepare(`${CATS} WHERE c.id = ?`).get(id);
  if (!row) throw notFound('Queue category not found');
  return row;
};

function saveCategory(id, fields) {
  const cols = ['code', 'name', 'kind', 'sort_order', 'active', 'location'];

  if (fields.code !== undefined) {
    const code = String(fields.code).trim();
    // Two digits, because that is the shape of every code the clinic
    // printed, and '1-001' is not a token it ever issued.
    if (!/^\d{2}$/.test(code)) throw badRequest('A category code is two digits, such as 08.');
    const clash = db.prepare('SELECT id, name FROM queue_categories WHERE code = ? AND id IS NOT ?')
      .get(code, id || null);
    if (clash) throw conflict(`Code ${code} is already ${clash.name}.`);
    fields.code = code;
  }

  const given = cols.filter((c) => fields[c] !== undefined);
  if (!given.length) throw badRequest('Nothing to change.');

  if (id) {
    categoryOr404(id);
    db.prepare(`UPDATE queue_categories SET ${given.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...given.map((c) => fields[c]), id);
    return categoryOr404(id);
  }

  if (!fields.code || !fields.name) throw badRequest('A category needs a code and a name.');
  const info = db.prepare(
    `INSERT INTO queue_categories (${given.join(', ')}) VALUES (${given.map(() => '?').join(', ')})`
  ).run(...given.map((c) => fields[c]));
  return categoryOr404(info.lastInsertRowid);
}

/**
 * Move a specialty into a room.
 *
 * This is the morning's most ordinary administrative act: the cardiologist
 * is away, so Cardiology moves out of OP-4 and the room is given to somebody
 * else, and at four o'clock it moves back. So it is one call, it replaces
 * wherever the specialty was sitting rather than adding a second room, and
 * it says how many people it affected.
 *
 * The people already in the queue are the real question. Their printed
 * slips say the old room and they are sitting in front of the old door, so
 * moving them silently would send them to a room nobody calls them from.
 * They are moved by default, because the alternative — a queue pointing at a
 * room the doctor has left — is worse, and the caller is told the count so
 * somebody can announce it. Anybody already called or already in with a
 * doctor is left exactly where they are.
 */
function assignCategoryRoom(categoryId, roomId, { moveWaiting = true, date = dateKey(now()) } = {}) {
  const category = categoryOr404(categoryId);
  if (roomId) roomOr404(roomId);

  const before = db.prepare(
    `SELECT r.id, r.name, r.floor FROM op_room_categories rc JOIN op_rooms r ON r.id = rc.room_id
      WHERE rc.category_id = ?`).all(categoryId);

  const write = db.transaction(() => {
    db.prepare('DELETE FROM op_room_categories WHERE category_id = ?').run(categoryId);
    if (roomId) {
      const next = db.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM op_room_categories WHERE room_id = ?')
        .get(roomId).n;
      db.prepare('INSERT INTO op_room_categories (room_id, category_id, sort_order) VALUES (?, ?, ?)')
        .run(roomId, categoryId, next);
    }
    if (!moveWaiting) return 0;
    return db.prepare(
      `UPDATE queue_tokens SET room_id = ?
        WHERE category_id = ? AND issue_date = date(?) AND status = 'waiting'`
    ).run(roomId || null, categoryId, date).changes;
  });
  const moved = write();

  return {
    category: categoryOr404(categoryId),
    from: before[0] || null,
    to: roomId ? roomOr404(roomId) : null,
    moved,
  };
}

/** The room a specialty is sitting in, if the clinic has said. */
const roomOfCategory = (categoryId) => db.prepare(
  `SELECT r.* FROM op_room_categories rc JOIN op_rooms r ON r.id = rc.room_id
    WHERE rc.category_id = ? AND r.active = 1 ORDER BY r.floor_order, r.name`).get(categoryId) || null;

/** Which departments feed a category — several may, and the clinic says so. */
function setCategoryDepartments(categoryId, departmentIds) {
  categoryOr404(categoryId);
  const write = db.transaction(() => {
    db.prepare('UPDATE departments SET queue_category_id = NULL WHERE queue_category_id = ?')
      .run(categoryId);
    for (const deptId of departmentIds || []) {
      db.prepare('UPDATE departments SET queue_category_id = ? WHERE id = ?').run(categoryId, deptId);
    }
  });
  write();
  return categoryOr404(categoryId);
}

// =========================================================================
// The rooms
// =========================================================================

const ROOM = 'SELECT r.* FROM op_rooms r';

const roomCategories = (roomId) => db.prepare(
  `SELECT c.id, c.code, c.name, c.kind, rc.sort_order
     FROM op_room_categories rc JOIN queue_categories c ON c.id = rc.category_id
    WHERE rc.room_id = ? ORDER BY rc.sort_order, c.code`).all(roomId);

const roomDoctors = (roomId) => db.prepare(
  `SELECT u.id, u.name, d.name AS department_name
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.op_room_id = ? AND u.active = 1 AND u.erased_at IS NULL ORDER BY u.name`).all(roomId);

function rooms({ includeInactive = false } = {}) {
  return db.prepare(`${ROOM} ${includeInactive ? '' : 'WHERE r.active = 1'}
     ORDER BY r.floor_order, r.floor, r.name`).all().map((r) => ({
    ...r,
    categories: roomCategories(r.id),
    doctors: roomDoctors(r.id),
  }));
}

const roomOr404 = (id) => {
  const row = db.prepare(`${ROOM} WHERE r.id = ?`).get(id);
  if (!row) throw notFound('Room not found');
  return { ...row, categories: roomCategories(id), doctors: roomDoctors(id) };
};

/**
 * Which specialties sit in a room.
 *
 * A room takes several — four or more is what the clinic plans for — and
 * the same specialty may sit in two rooms on different days, so nothing
 * here is exclusive. The order given is kept, because it is the order the
 * clinic will want them read out on the screen outside the door.
 */
function setRoomCategories(roomId, categoryIds) {
  roomOr404(roomId);
  const ids = [...new Set((categoryIds || []).map(Number).filter(Boolean))];
  for (const cid of ids) categoryOr404(cid);
  const write = db.transaction(() => {
    db.prepare('DELETE FROM op_room_categories WHERE room_id = ?').run(roomId);
    ids.forEach((cid, i) => db.prepare(
      'INSERT INTO op_room_categories (room_id, category_id, sort_order) VALUES (?, ?, ?)')
      .run(roomId, cid, i));
  });
  write();
  return roomOr404(roomId);
}

function saveRoom(id, fields) {
  const cols = ['name', 'floor', 'floor_order', 'note', 'active'];
  const given = cols.filter((c) => fields[c] !== undefined);

  if (id) {
    roomOr404(id);
    if (given.length) {
      db.prepare(`UPDATE op_rooms SET ${given.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...given.map((c) => fields[c]), id);
    }
  } else {
    if (!fields.name || !fields.floor) throw badRequest('A room needs a name and a floor.');
    const clash = db.prepare('SELECT id FROM op_rooms WHERE floor = ? AND name = ?')
      .get(fields.floor, fields.name);
    if (clash) throw conflict(`${fields.floor} already has a room called ${fields.name}.`);
    id = db.prepare(
      `INSERT INTO op_rooms (${given.join(', ')}) VALUES (${given.map(() => '?').join(', ')})`
    ).run(...given.map((c) => fields[c])).lastInsertRowid;
  }

  if (fields.categories !== undefined) setRoomCategories(id, fields.categories);
  return roomOr404(id);
}

/**
 * A room is switched off rather than deleted once tokens point at it.
 *
 * The slips printed this morning name it, and a token from last month says
 * which room that patient was sent to — worth keeping after the room has
 * become a store cupboard.
 */
function removeRoom(id) {
  roomOr404(id);
  const used = db.prepare('SELECT COUNT(*) AS c FROM queue_tokens WHERE room_id = ?').get(id).c;
  if (used) {
    db.prepare('UPDATE op_rooms SET active = 0 WHERE id = ?').run(id);
    return { deactivated: true, removed: false, tokens: used };
  }
  db.prepare('DELETE FROM op_rooms WHERE id = ?').run(id);
  return { deactivated: false, removed: true, tokens: 0 };
}

/** Put a doctor in a room, or take them out of one. */
function setDoctorRoom(doctorId, roomId) {
  const doctor = db.prepare('SELECT id FROM users WHERE id = ? AND erased_at IS NULL').get(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  if (roomId) roomOr404(roomId);
  db.prepare('UPDATE users SET op_room_id = ? WHERE id = ?').run(roomId || null, doctorId);
  return db.prepare(
    `SELECT u.id, u.name, u.op_room_id, r.name AS room_name, r.floor AS room_floor
       FROM users u LEFT JOIN op_rooms r ON r.id = u.op_room_id WHERE u.id = ?`).get(doctorId);
}

/**
 * Where to send this token.
 *
 * The doctor's own room first, because a patient seeing Dr Imran goes where
 * Dr Imran is sitting. Failing that, a room the specialty sits in. Nothing
 * is invented: a clinic that has not yet said where Paediatrics sits gets a
 * token with no room on it, which is honest, rather than "OP 1", which
 * sends people upstairs for nothing.
 */
function roomFor({ doctorId, categoryId }) {
  if (doctorId) {
    const sat = db.prepare(
      `SELECT r.* FROM users u JOIN op_rooms r ON r.id = u.op_room_id
        WHERE u.id = ? AND r.active = 1`).get(doctorId);
    if (sat) return sat;
  }
  if (!categoryId) return null;
  return db.prepare(
    `SELECT r.* FROM op_room_categories rc JOIN op_rooms r ON r.id = rc.room_id
      WHERE rc.category_id = ? AND r.active = 1
      ORDER BY r.floor_order, r.name`).get(categoryId) || null;
}

/** The category a department's patients are called under. */
function categoryForDepartment(departmentId) {
  if (!departmentId) return null;
  return db.prepare(
    `SELECT c.* FROM departments d JOIN queue_categories c ON c.id = d.queue_category_id
      WHERE d.id = ?`).get(departmentId) || null;
}

function categoryForDoctor(doctorId) {
  if (!doctorId) return null;
  const row = db.prepare('SELECT department_id FROM users WHERE id = ?').get(doctorId);
  return row ? categoryForDepartment(row.department_id) : null;
}

// =========================================================================
// Issuing a token
// =========================================================================

const TOKENS = `
  SELECT t.id, t.category_id, t.issue_date, t.seq, t.label, t.patient_id, t.visit_id,
         t.doctor_id, t.room_id, t.status, t.called_at, t.call_count, t.passed_at,
         t.serving_at, t.done_at, t.note, t.created_at,
         c.code AS category_code, c.name AS category_name, c.kind AS category_kind,
         c.location AS category_location,
         p.uhid, p.title AS patient_title, p.first_name, p.last_name,
         TRIM(p.first_name || ' ' || COALESCE(p.last_name, '')) AS patient_name,
         p.age_years, p.gender, p.phone,
         u.name AS doctor_name, cb.name AS called_by_name,
         r.name AS room_name, r.floor AS room_floor, r.floor_order AS room_floor_order,
         v.visit_no, v.status AS visit_status, v.arrived_at, v.token_no,
         v.consult_start_at, v.consult_end_at, v.reason_for_visit,
         a.scheduled_at, a.appt_no, a.visit_kind
    FROM queue_tokens t
    JOIN queue_categories c ON c.id = t.category_id
    LEFT JOIN patients p ON p.id = t.patient_id
    LEFT JOIN users u ON u.id = t.doctor_id
    LEFT JOIN users cb ON cb.id = t.called_by
    LEFT JOIN op_rooms r ON r.id = t.room_id
    LEFT JOIN visits v ON v.id = t.visit_id
    LEFT JOIN appointments a ON a.id = v.appointment_id`;

const tokenOr404 = (id) => {
  const row = db.prepare(`${TOKENS} WHERE t.id = ?`).get(id);
  if (!row) throw notFound('Token not found');
  return row;
};

/**
 * Hand out a token.
 *
 * Idempotent per patient, category and day on purpose: pressing the button
 * twice, or reprinting a slip, must not advance the queue or leave a gap in
 * it. A patient who genuinely needs a second blood test the same day — it
 * happens — is given one with `again`, which is then a decision somebody
 * made rather than the result of a double click.
 */
function issue({
  categoryId, patientId = null, visitId = null, doctorId = null, roomId = null,
  note = null, userId = null, again = false, date = dateKey(now()),
} = {}) {
  const category = categoryOr404(categoryId);
  if (!category.active) throw badRequest(`${category.name} is switched off.`);

  if (visitId) {
    const visit = db.prepare('SELECT id, patient_id, doctor_id FROM visits WHERE id = ?').get(visitId);
    if (!visit) throw notFound('Visit not found');
    patientId = patientId || visit.patient_id;
    doctorId = doctorId || visit.doctor_id;
  }

  if (!again && patientId) {
    const held = db.prepare(
      `SELECT id FROM queue_tokens
        WHERE patient_id = ? AND category_id = ? AND issue_date = date(?)
          AND status <> 'cancelled' ORDER BY id DESC`).get(patientId, categoryId, date);
    if (held) return tokenOr404(held.id);
  }

  const room = roomId ? roomOr404(roomId) : roomFor({ doctorId, categoryId });

  /*
   * The sequence: today's highest in this category, plus one. This is why
   * there is no nightly reset to forget — the morning's first patient finds
   * nothing above them from today and takes 001.
   */
  const write = db.transaction(() => {
    const highest = db.prepare(
      'SELECT MAX(seq) AS m FROM queue_tokens WHERE category_id = ? AND issue_date = date(?)')
      .get(categoryId, date).m;
    const seq = (highest || 0) + 1;
    return db.prepare(
      `INSERT INTO queue_tokens
         (category_id, issue_date, seq, label, patient_id, visit_id, doctor_id, room_id,
          note, issued_by)
       VALUES (?, date(?), ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(categoryId, date, seq, labelFor(category.code, seq), patientId, visitId,
      doctorId, room ? room.id : null, trim(note), userId).lastInsertRowid;
  });

  return tokenOr404(write());
}

/**
 * The consultation token a visit should be holding.
 *
 * Called when a patient arrives, and again by anything that needs the
 * number later. It returns the token the visit already has rather than
 * issuing a second one, so the number on the slip in the patient's hand is
 * the number everything else quotes.
 */
function tokenForVisit(visitId, { userId = null } = {}) {
  const visit = db.prepare(
    `SELECT v.id, v.patient_id, v.doctor_id, v.department_id, v.arrived_at,
            u.department_id AS doctor_department_id
       FROM visits v LEFT JOIN users u ON u.id = v.doctor_id WHERE v.id = ?`).get(visitId);
  if (!visit) throw notFound('Visit not found');

  const existing = db.prepare(
    `SELECT id FROM queue_tokens WHERE visit_id = ? AND status <> 'cancelled'
      ORDER BY id LIMIT 1`).get(visitId);
  if (existing) return tokenOr404(existing.id);

  const category = categoryForDepartment(visit.department_id)
    || categoryForDepartment(visit.doctor_department_id);
  /*
   * No category, no invented token. A clinic that has not pointed this
   * department at a code would otherwise get tokens issued under somebody
   * else's code, which is worse than the desk being asked to choose.
   */
  if (!category) return null;

  return issue({
    categoryId: category.id,
    patientId: visit.patient_id,
    visitId: visit.id,
    doctorId: visit.doctor_id,
    userId,
    date: dateKey(visit.arrived_at || now()),
  });
}

// =========================================================================
// Who goes in next
// =========================================================================

/**
 * The minute a token becomes the clinic's next obligation.
 *
 * For a walk-in, when it was issued. For a booking, the slot — or the issue
 * time if they came late, which is the refinement described at the top of
 * this file. Somebody passed over for not answering becomes due again from
 * the moment they were passed, so the people behind them are not overtaken
 * twice.
 */
function dueAt(row) {
  const issued = toTime(row.arrived_at || row.created_at);
  const base = row.scheduled_at ? Math.max(toTime(row.scheduled_at), issued) : issued;
  return Math.max(base, toTime(row.passed_at) || 0);
}

const isBooked = (row) => Boolean(row.scheduled_at);

/*
 * Did they miss their own slot?
 *
 * This is the tie-breaker, and it has to be, because a late patient's due
 * time is their arrival — so a 09:00 appointment walking in at 11:30 is due
 * in the same minute as the 11:30 appointment who came at 11:20. Breaking
 * that tie on the slot would put the stale nine o'clock first and hand the
 * waiting room the lesson that being late is rewarded.
 */
const wasLate = (row) => Boolean(row.scheduled_at
  && toTime(row.arrived_at || row.created_at) > toTime(row.scheduled_at));

/**
 * The order the room will call them in, as it stands this minute.
 *
 * Three groups: bookings that are due, then walk-ins, then bookings not due
 * yet. A walk-in is callable only while no booking is due — which is the
 * desk's rule, written once here so that the board, the screen and the
 * "call next" button can never disagree about it.
 */
function order(rows, at = now()) {
  const clock = at.getTime();
  const withDue = rows.map((r) => ({ ...r, due_at: dueAt(r), booked: isBooked(r) }));

  const dueBooked = withDue.filter((r) => r.booked && r.due_at <= clock)
    .sort((a, b) => a.due_at - b.due_at
      || (wasLate(a) ? 1 : 0) - (wasLate(b) ? 1 : 0)
      || toTime(a.scheduled_at) - toTime(b.scheduled_at) || a.seq - b.seq);
  const walkIns = withDue.filter((r) => !r.booked)
    .sort((a, b) => a.due_at - b.due_at || a.seq - b.seq);
  const laterBooked = withDue.filter((r) => r.booked && r.due_at > clock)
    .sort((a, b) => a.due_at - b.due_at || a.seq - b.seq);

  return [...dueBooked, ...walkIns, ...laterBooked].map((r, i) => ({
    ...r,
    position: i + 1,
    /*
     * Why this one is where it is, in the words the desk would use. A queue
     * that cannot explain itself is one the receptionist overrides, and an
     * overridden queue is no queue at all.
     */
    why: r.booked
      ? (r.due_at <= clock
        ? `Booked ${hhmm(r.scheduled_at)}${wasLate(r) ? ' · arrived late' : ''}`
        : `Booked ${hhmm(r.scheduled_at)} — not due yet`)
      : `Walk-in · waiting since ${hhmm(r.arrived_at || r.created_at)}`,
    callable: r.booked ? r.due_at <= clock : !dueBooked.length,
  }));
}

const LIVE = "t.status IN ('waiting','called','serving')";

/**
 * One queue: a category, or whatever is queued for one room.
 *
 * Returns who is being seen, who has been called and not yet appeared, and
 * who is waiting in the order they will be called.
 */
function queueFor({ categoryId = null, roomId = null, date = dateKey(now()) } = {}, at = now()) {
  const args = [date, ...(categoryId ? [categoryId] : []), ...(roomId ? [roomId] : [])];
  const rows = db.prepare(
    `${TOKENS} WHERE t.issue_date = date(?) AND ${LIVE}
       ${categoryId ? 'AND t.category_id = ?' : ''}
       ${roomId ? 'AND t.room_id = ?' : ''}`).all(...args);

  const serving = rows.filter((r) => r.status === 'serving');
  const called = rows.filter((r) => r.status === 'called')
    .sort((a, b) => toTime(b.called_at) - toTime(a.called_at));
  const queue = order(rows.filter((r) => r.status === 'waiting'), at);

  /*
   * What a patient should be told when they ask how long. Taken from what
   * today's consultations in this queue have actually taken rather than
   * from the slot length, which is a plan and not a measurement — and left
   * empty until the day has produced enough of them to average, because
   * "about forty minutes" invented from a slot length is a promise the
   * clinic never made.
   */
  const closed = db.prepare(
    `SELECT t.serving_at, t.done_at FROM queue_tokens t
      WHERE t.issue_date = date(?) AND t.status = 'done'
        AND t.serving_at IS NOT NULL AND t.done_at IS NOT NULL
        ${categoryId ? 'AND t.category_id = ?' : ''}
        ${roomId ? 'AND t.room_id = ?' : ''}`).all(...args);
  const minutes = closed.map((t) => (toTime(t.done_at) - toTime(t.serving_at)) / 60000)
    .filter((m) => m > 0 && m < 180);
  const average = minutes.length >= 3
    ? Math.round(minutes.reduce((t, m) => t + m, 0) / minutes.length) : null;

  return {
    date,
    serving,
    called,
    queue,
    next: queue.find((r) => r.callable) || null,
    counts: {
      waiting: queue.length,
      booked: queue.filter((r) => r.booked).length,
      walkIn: queue.filter((r) => !r.booked).length,
      called: called.length,
      serving: serving.length,
      done: closed.length,
    },
    averageMinutes: average,
    averageFrom: minutes.length,
  };
}

/** The whole desk: every category that has anybody in it today. */
function board(date = dateKey(now()), at = now()) {
  const live = db.prepare(
    `SELECT c.id, c.code, c.name, c.kind,
            SUM(CASE WHEN t.status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
            SUM(CASE WHEN t.status = 'called' THEN 1 ELSE 0 END) AS called,
            SUM(CASE WHEN t.status = 'serving' THEN 1 ELSE 0 END) AS serving,
            SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done,
            COUNT(*) AS issued, MAX(t.seq) AS last_seq
       FROM queue_tokens t JOIN queue_categories c ON c.id = t.category_id
      WHERE t.issue_date = date(?) AND t.status <> 'cancelled'
      GROUP BY c.id ORDER BY c.sort_order, c.code`).all(date);

  const lanes = live.map((c) => {
    const q = queueFor({ categoryId: c.id, date }, at);
    return {
      category: { id: c.id, code: c.code, name: c.name, kind: c.kind },
      issued: c.issued,
      done: c.done,
      lastSeq: c.last_seq,
      serving: q.serving,
      called: q.called,
      queue: q.queue,
      next: q.next,
      counts: q.counts,
      averageMinutes: q.averageMinutes,
    };
  });

  return {
    date,
    at: stamp(at),
    lanes,
    totals: {
      issued: live.reduce((t, c) => t + c.issued, 0),
      waiting: live.reduce((t, c) => t + c.waiting, 0),
      called: live.reduce((t, c) => t + c.called, 0),
      serving: live.reduce((t, c) => t + c.serving, 0),
      done: live.reduce((t, c) => t + c.done, 0),
    },
  };
}

// =========================================================================
// Calling, and closing out
// =========================================================================

/**
 * Call a token.
 *
 * Calling out of turn is allowed and recorded rather than refused. A
 * receptionist can see the pregnant woman who has been standing for forty
 * minutes and the software cannot; what the software can do is make sure
 * that when somebody is taken out of order, the queue says so afterwards.
 */
function call(tokenId, userId, { reason } = {}) {
  const token = tokenOr404(tokenId);
  if (token.status === 'done') throw conflict(`${token.label} has already been seen.`);
  if (token.status === 'cancelled') throw conflict(`${token.label} was cancelled.`);
  if (token.status === 'serving') throw conflict(`${token.label} is already in the room.`);

  const q = queueFor({ categoryId: token.category_id, roomId: token.room_id,
    date: token.issue_date });
  const expected = q.next ? q.next.id : null;
  const outOfTurn = Boolean(expected && expected !== tokenId);

  db.prepare(
    `UPDATE queue_tokens
        SET status = 'called', called_at = datetime('now'), called_by = ?,
            call_count = call_count + 1, note = COALESCE(?, note)
      WHERE id = ?`).run(userId || null, trim(reason), tokenId);

  return {
    token: tokenOr404(tokenId),
    outOfTurn,
    expected: outOfTurn ? { id: q.next.id, label: q.next.label, why: q.next.why } : null,
  };
}

/** Call whoever the rule says is next. */
function callNext({ categoryId = null, roomId = null } = {}, userId) {
  const q = queueFor({ categoryId, roomId });
  if (!q.next) {
    throw badRequest(q.counts.waiting
      ? 'Nobody is due yet — the next booking has not come round and no walk-in is waiting.'
      : 'Nobody is waiting in this queue.');
  }
  return call(q.next.id, userId);
}

/**
 * Nobody answered.
 *
 * They keep their place in the sense that matters — they are not sent home
 * — but they become due again from this moment, so the people behind them
 * are not overtaken a second time when they reappear.
 */
function pass(tokenId, userId, { reason } = {}) {
  const token = tokenOr404(tokenId);
  if (token.status === 'serving') throw conflict(`${token.label} is already in the room.`);
  if (token.status !== 'called') throw badRequest(`${token.label} has not been called yet.`);

  db.prepare(
    `UPDATE queue_tokens SET status = 'waiting', called_at = NULL,
            passed_at = datetime('now'), note = COALESCE(?, note) WHERE id = ?`
  ).run(trim(reason) || 'Did not answer', tokenId);
  return tokenOr404(tokenId);
}

/** Called by mistake: put them back where they were. */
function uncall(tokenId) {
  const token = tokenOr404(tokenId);
  if (token.status === 'serving') throw conflict(`${token.label} is already in the room.`);
  db.prepare("UPDATE queue_tokens SET status = 'waiting', called_at = NULL, called_by = NULL "
    + 'WHERE id = ?').run(tokenId);
  return tokenOr404(tokenId);
}

/** They came in. */
function serving(tokenId, userId) {
  const token = tokenOr404(tokenId);
  if (token.status === 'done') throw conflict(`${token.label} has already been seen.`);
  if (token.status === 'cancelled') throw conflict(`${token.label} was cancelled.`);
  db.prepare(
    `UPDATE queue_tokens SET status = 'serving', serving_at = COALESCE(serving_at, datetime('now')),
            called_at = COALESCE(called_at, datetime('now')),
            called_by = COALESCE(called_by, ?) WHERE id = ?`).run(userId || null, tokenId);
  return tokenOr404(tokenId);
}

/** Done with. The queue is closed out by whoever saw them. */
function done(tokenId) {
  const token = tokenOr404(tokenId);
  if (token.status === 'cancelled') throw conflict(`${token.label} was cancelled.`);
  db.prepare(
    `UPDATE queue_tokens SET status = 'done', done_at = datetime('now'),
            serving_at = COALESCE(serving_at, datetime('now')) WHERE id = ?`).run(tokenId);
  return tokenOr404(tokenId);
}

function cancel(tokenId, { reason } = {}) {
  tokenOr404(tokenId);
  db.prepare("UPDATE queue_tokens SET status = 'cancelled', note = COALESCE(?, note) WHERE id = ?")
    .run(trim(reason), tokenId);
  return tokenOr404(tokenId);
}

/** Send a token to another room, when a clinic is moved mid-morning. */
function moveRoom(tokenId, roomId) {
  tokenOr404(tokenId);
  if (roomId) roomOr404(roomId);
  db.prepare('UPDATE queue_tokens SET room_id = ? WHERE id = ?').run(roomId || null, tokenId);
  return tokenOr404(tokenId);
}

const tokensFor = ({ visitId, patientId, date } = {}) => db.prepare(
  `${TOKENS} WHERE 1 = 1
     ${visitId ? 'AND t.visit_id = ?' : ''}
     ${patientId ? 'AND t.patient_id = ?' : ''}
     ${date ? 'AND t.issue_date = date(?)' : ''}
   ORDER BY t.id DESC LIMIT 50`
).all(...[visitId, patientId, date].filter(Boolean));

// =========================================================================
// The slip, and the screen in the waiting room
// =========================================================================

/**
 * What goes on the 70 mm slip the desk hands over.
 *
 * The number is the whole of it as far as the patient is concerned, and it
 * is printed as large as the paper allows. Everything else answers the
 * question they are about to ask somebody: which room, which floor, and how
 * many people are in front of me.
 */
function slip(tokenId, at = now()) {
  const token = tokenOr404(tokenId);
  const q = queueFor({ categoryId: token.category_id, roomId: token.room_id,
    date: token.issue_date }, at);
  const place = q.queue.find((r) => r.id === token.id);
  const ahead = place ? place.position - 1 : null;

  return {
    clinic: 'SAMIHA HEALTHCARE',
    token,
    label: token.label,
    category: token.category_name,
    code: token.category_code,
    room: token.room_name || null,
    floor: token.room_floor || null,
    // A counter has no consulting room, so the slip falls back to where the
    // directory board says it is: "Ground Floor · Pharmacy".
    location: token.room_name ? null : (token.category_location || null),
    doctor: token.doctor_name || null,
    booked: isBooked(token),
    scheduledAt: token.scheduled_at || null,
    ahead,
    averageMinutes: q.averageMinutes,
    // An estimate only where it was measured.
    waitMinutes: q.averageMinutes !== null && ahead !== null ? q.averageMinutes * ahead : null,
    printedAt: stamp(at),
  };
}

/**
 * What the television shows.
 *
 * One floor at a time, because the screen downstairs must not call people
 * to a room upstairs — a patient reads the first large number they see and
 * stands up. Per room: the number being called now, and the next few
 * waiting, so somebody three places back can sit down again.
 *
 * No names. A waiting room is a public place, and a number on a wall tells
 * the right person everything and everybody else nothing.
 */
function display(floor, date = dateKey(now()), at = now()) {
  const all = rooms();
  const floors = [...new Set(all.map((r) => r.floor))];
  const wanted = floor
    ? all.filter((r) => r.floor.toLowerCase() === String(floor).toLowerCase())
    : all;

  const brief = (r) => ({
    label: r.label, category: r.category_name, code: r.category_code,
    doctor: r.doctor_name || null, at: r.called_at || r.serving_at || null,
  });

  const panels = wanted.map((room) => {
    const q = queueFor({ roomId: room.id, date }, at);
    return {
      room: {
        id: room.id, name: room.name, floor: room.floor, floorOrder: room.floor_order,
        specialties: room.categories.map((c) => c.name),
        doctors: room.doctors.map((d) => d.name),
      },
      // The number on the wall right now: whoever was called last and has
      // not yet reached the door, or failing that whoever is inside.
      nowCalling: q.called.length ? brief(q.called[0])
        : (q.serving.length ? brief(q.serving[0]) : null),
      serving: q.serving.map(brief),
      // Three is what somebody can hold in their head walking past a screen.
      upNext: q.queue.slice(0, 3).map((r) => ({ label: r.label, booked: r.booked })),
      waiting: q.counts.waiting,
    };
  });

  /*
   * Service counters have no room of their own, and the laboratory calling
   * 12-014 is exactly what a waiting room needs to see. They are shown
   * under the rooms, on every floor's screen.
   */
  const counters = categories({ kind: 'service' }).map((c) => {
    const q = queueFor({ categoryId: c.id, date }, at);
    if (!q.counts.waiting && !q.counts.called && !q.counts.serving) return null;
    const head = q.called[0] || q.serving[0] || null;
    return {
      counter: { id: c.id, code: c.code, name: c.name, location: c.location || null },
      nowCalling: head ? brief(head) : null,
      upNext: q.queue.slice(0, 3).map((r) => ({ label: r.label, booked: r.booked })),
      waiting: q.counts.waiting,
    };
  }).filter(Boolean);

  return {
    clinic: 'SAMIHA HEALTHCARE',
    floor: floor || null,
    floors,
    date,
    at: stamp(at),
    panels: panels.sort((a, b) => a.room.floorOrder - b.room.floorOrder
      || a.room.name.localeCompare(b.room.name)),
    counters,
  };
}

module.exports = {
  // what the clinic configures
  categories, saveCategory, setCategoryDepartments,
  rooms, saveRoom, removeRoom, setRoomCategories, setDoctorRoom,
  assignCategoryRoom, roomOfCategory,
  // tokens
  issue, tokenForVisit, tokensFor, tokenOr404,
  // the queue itself
  queueFor, board, order, dueAt, roomFor,
  categoryForDepartment, categoryForDoctor,
  call, callNext, pass, uncall, serving, done, cancel, moveRoom,
  // paper and glass
  slip, display, labelFor,
};
