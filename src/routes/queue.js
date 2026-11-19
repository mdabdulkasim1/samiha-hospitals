'use strict';
/**
 * The queue, over the wire.
 *
 * Who touches what follows the clinic's own division of labour. The front
 * desk owns the queue: it hands out tokens, prints slips and decides who is
 * called. Doctors and nurses call the next patient in and close them out,
 * because they are the people who know the room is free. Admin and the
 * owner set up the categories and the rooms, which is a decision about the
 * building rather than about this morning.
 *
 * The waiting-room screen is readable by any signed-in account, because
 * that is what a television in a corridor is: it shows numbers and rooms
 * and no names, and it has to keep showing them all day without anybody
 * standing next to it.
 */
const express = require('express');
const { db } = require('../db');
const { wrap, badRequest } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { str, int, bool } = require('../lib/validate');
const audit = require('../lib/audit');
const queue = require('../services/queue');

const router = express.Router();

/** The desk runs the queue; the clinical staff call and close out. */
const deskRoles = requireRole('reception');
const callRoles = requireRole('reception', 'nurse', 'doctor');
/** Lab, pharmacy and the counters call their own queues. */
const counterRoles = requireRole('reception', 'nurse', 'doctor', 'lab', 'pharmacy');
/** Anybody signed in may read a screen that shows numbers and rooms. */
const anyone = requireRole('reception', 'nurse', 'doctor', 'lab', 'pharmacy',
  'cashier', 'counselor', 'accountant');

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- the set-up
router.get('/setup', anyone, wrap((req, res) => {
  res.json({
    categories: queue.categories({ includeInactive: true }),
    rooms: queue.rooms({ includeInactive: true }),
  });
}));

router.get('/categories', anyone, wrap((req, res) => {
  res.json({ rows: queue.categories({ includeInactive: req.query.all === '1', kind: str(req.query.kind) }) });
}));

router.post('/categories', requireRole(), wrap((req, res) => {
  const row = queue.saveCategory(null, {
    code: str(req.body.code), name: str(req.body.name),
    kind: str(req.body.kind) === 'service' ? 'service' : 'consult',
    sort_order: int(req.body.sortOrder) ?? 99,
  });
  audit.log(req, 'queue.category.create', 'queue_category', row.id, { code: row.code, name: row.name });
  res.status(201).json(row);
}));

router.patch('/categories/:id', requireRole(), wrap((req, res) => {
  const fields = {};
  if (req.body.code !== undefined) fields.code = str(req.body.code);
  if (req.body.name !== undefined) fields.name = str(req.body.name);
  if (req.body.kind !== undefined) fields.kind = str(req.body.kind) === 'service' ? 'service' : 'consult';
  if (req.body.sortOrder !== undefined) fields.sort_order = int(req.body.sortOrder);
  if (req.body.location !== undefined) fields.location = str(req.body.location);
  if (req.body.active !== undefined) fields.active = bool(req.body.active) ? 1 : 0;
  const row = queue.saveCategory(Number(req.params.id), fields);

  if (req.body.departments !== undefined) {
    queue.setCategoryDepartments(row.id, (req.body.departments || []).map(Number).filter(Boolean));
  }
  audit.log(req, 'queue.category.update', 'queue_category', row.id, fields);
  res.json(queue.categories({ includeInactive: true }).find((c) => c.id === row.id));
}));

/**
 * Move a specialty into another room.
 *
 * The front desk's call, not only admin's: a doctor failing to arrive is a
 * nine o'clock problem and the person who finds out is the receptionist.
 */
router.post('/categories/:id/room', deskRoles, wrap((req, res) => {
  const out = queue.assignCategoryRoom(Number(req.params.id),
    int(req.body.roomId) || null,
    { moveWaiting: req.body.moveWaiting === undefined ? true : bool(req.body.moveWaiting) });
  audit.log(req, 'queue.category.room', 'queue_category', Number(req.params.id), {
    from: out.from ? out.from.name : null, to: out.to ? out.to.name : null, moved: out.moved,
  });
  res.json(out);
}));

// ----------------------------------------------------------------- the rooms
router.get('/rooms', anyone, wrap((req, res) => {
  res.json({ rows: queue.rooms({ includeInactive: req.query.all === '1' }) });
}));

router.post('/rooms', requireRole(), wrap((req, res) => {
  const row = queue.saveRoom(null, {
    name: str(req.body.name), floor: str(req.body.floor),
    floor_order: int(req.body.floorOrder) ?? 0, note: str(req.body.note),
    categories: req.body.categories,
  });
  audit.log(req, 'queue.room.create', 'op_room', row.id, { name: row.name, floor: row.floor });
  res.status(201).json(row);
}));

router.patch('/rooms/:id', requireRole(), wrap((req, res) => {
  const fields = {};
  if (req.body.name !== undefined) fields.name = str(req.body.name);
  if (req.body.floor !== undefined) fields.floor = str(req.body.floor);
  if (req.body.floorOrder !== undefined) fields.floor_order = int(req.body.floorOrder);
  if (req.body.note !== undefined) fields.note = str(req.body.note);
  if (req.body.active !== undefined) fields.active = bool(req.body.active) ? 1 : 0;
  if (req.body.categories !== undefined) fields.categories = req.body.categories;
  const row = queue.saveRoom(Number(req.params.id), fields);
  audit.log(req, 'queue.room.update', 'op_room', row.id, fields);
  res.json(row);
}));

router.delete('/rooms/:id', requireRole(), wrap((req, res) => {
  const out = queue.removeRoom(Number(req.params.id));
  audit.log(req, 'queue.room.remove', 'op_room', Number(req.params.id), out);
  res.json(out);
}));

/** Which room a doctor sits in. */
router.post('/rooms/:id/doctors', requireRole(), wrap((req, res) => {
  const roomId = req.params.id === 'none' ? null : Number(req.params.id);
  const doctorId = int(req.body.doctorId);
  if (!doctorId) throw badRequest('Which doctor?');
  const row = queue.setDoctorRoom(doctorId, roomId);
  audit.log(req, 'queue.room.doctor', 'op_room', roomId, { doctorId });
  res.json(row);
}));

/** Who is sitting for each specialty today, and in which room. */
router.get('/duty', anyone, wrap((req, res) => {
  res.json({ date: str(req.query.date) || today(), rows: queue.dutyBoard(str(req.query.date) || today()) });
}));

// ---------------------------------------------------------------- the tokens
router.get('/board', counterRoles, wrap((req, res) => {
  res.json(queue.board(str(req.query.date) || today()));
}));

router.get('/queues', counterRoles, wrap((req, res) => {
  res.json(queue.queueFor({
    categoryId: int(req.query.categoryId) || null,
    roomId: int(req.query.roomId) || null,
    date: str(req.query.date) || today(),
  }));
}));

router.get('/tokens', counterRoles, wrap((req, res) => {
  res.json({
    rows: queue.tokensFor({
      visitId: int(req.query.visitId), patientId: int(req.query.patientId),
      date: str(req.query.date),
    }),
  });
}));

/**
 * Hand out a token. The desk's own button, and the one the lab and the
 * pharmacy press when somebody walks up to their counter.
 */
router.post('/tokens', counterRoles, wrap((req, res) => {
  const categoryId = int(req.body.categoryId);
  if (!categoryId) throw badRequest('Which queue is this token for?');
  const token = queue.issue({
    categoryId,
    patientId: int(req.body.patientId) || null,
    visitId: int(req.body.visitId) || null,
    doctorId: int(req.body.doctorId) || null,
    roomId: int(req.body.roomId) || null,
    note: str(req.body.note),
    again: bool(req.body.again),
    userId: req.user.id,
  });
  audit.log(req, 'queue.token.issue', 'queue_token', token.id,
    { label: token.label, category: token.category_name });
  res.status(201).json(token);
}));

/** The token a visit is holding, issued on the spot if it has none yet. */
router.post('/visits/:id/token', counterRoles, wrap((req, res) => {
  const token = queue.tokenForVisit(Number(req.params.id), { userId: req.user.id });
  if (!token) {
    throw badRequest('This patient\'s department has no queue category yet — '
      + 'pick one on Queue → Set-up, or choose a category by hand.');
  }
  res.json(token);
}));

router.get('/tokens/:id/slip', counterRoles, wrap((req, res) => {
  res.json(queue.slip(Number(req.params.id)));
}));

router.post('/tokens/:id/call', callRoles, wrap((req, res) => {
  const out = queue.call(Number(req.params.id), req.user.id, { reason: str(req.body.reason) });
  audit.log(req, 'queue.token.call', 'queue_token', out.token.id,
    { label: out.token.label, outOfTurn: out.outOfTurn });
  res.json(out);
}));

router.post('/call-next', callRoles, wrap((req, res) => {
  const out = queue.callNext({
    categoryId: int(req.body.categoryId) || null,
    roomId: int(req.body.roomId) || null,
  }, req.user.id);
  audit.log(req, 'queue.token.call', 'queue_token', out.token.id, { label: out.token.label });
  res.json(out);
}));

router.post('/tokens/:id/pass', callRoles, wrap((req, res) => {
  const row = queue.pass(Number(req.params.id), req.user.id, { reason: str(req.body.reason) });
  audit.log(req, 'queue.token.pass', 'queue_token', row.id, { label: row.label });
  res.json(row);
}));

router.post('/tokens/:id/uncall', callRoles, wrap((req, res) => {
  res.json(queue.uncall(Number(req.params.id)));
}));

router.post('/tokens/:id/serving', callRoles, wrap((req, res) => {
  res.json(queue.serving(Number(req.params.id), req.user.id));
}));

router.post('/tokens/:id/done', callRoles, wrap((req, res) => {
  const row = queue.done(Number(req.params.id));
  audit.log(req, 'queue.token.done', 'queue_token', row.id, { label: row.label });
  res.json(row);
}));

router.post('/tokens/:id/cancel', deskRoles, wrap((req, res) => {
  const row = queue.cancel(Number(req.params.id), { reason: str(req.body.reason) });
  audit.log(req, 'queue.token.cancel', 'queue_token', row.id, { label: row.label });
  res.json(row);
}));

router.post('/tokens/:id/room', deskRoles, wrap((req, res) => {
  res.json(queue.moveRoom(Number(req.params.id), int(req.body.roomId) || null));
}));

// ------------------------------------------------- the screen in the corridor
router.get('/display', anyone, wrap((req, res) => {
  res.json({
    ...queue.display(str(req.query.floor), str(req.query.date) || today()),
    slides: slideList(str(req.query.floor)),
  });
}));

/*
 * The posters that play beside the numbers.
 *
 * Sent as a data URL because that is what a browser hands back from a file
 * input without an upload library, and stored as bytes in the database
 * because this container is rebuilt on every deploy — a poster written
 * beside the code is gone by the next release.
 */
const slideBody = express.json({ limit: '8mb' });
const MAX_SLIDE = 6 * 1024 * 1024;
const SLIDE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const slideList = (floor) => db.prepare(
  `SELECT id, title, mime, bytes, seconds, floor, sort_order, active, created_at
     FROM display_slides
    WHERE active = 1 AND (floor IS NULL OR floor = ?)
    ORDER BY sort_order, id`).all(floor || null);

router.get('/slides', anyone, wrap((req, res) => {
  res.json({
    rows: db.prepare(
      `SELECT s.id, s.title, s.mime, s.bytes, s.seconds, s.floor, s.sort_order, s.active,
              s.created_at, u.name AS uploaded_by_name
         FROM display_slides s LEFT JOIN users u ON u.id = s.uploaded_by
        ORDER BY s.sort_order, s.id`).all(),
  });
}));

/** The image itself. Cached hard: a television re-fetches it all day. */
router.get('/slides/:id/image', anyone, wrap((req, res) => {
  const row = db.prepare('SELECT mime, content FROM display_slides WHERE id = ?')
    .get(Number(req.params.id));
  if (!row) throw badRequest('No such slide.');
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.end(row.content);
}));

router.post('/slides', deskRoles, slideBody, wrap((req, res) => {
  const data = String(req.body.data || '');
  const match = data.match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!match) throw badRequest('Choose the poster image itself.');
  const mime = match[1].toLowerCase();
  if (!SLIDE_TYPES.includes(mime)) {
    throw badRequest(`A ${mime} cannot go on the screen. Use a JPEG, PNG, WEBP or GIF.`);
  }
  const content = Buffer.from(match[2], 'base64');
  if (!content.length) throw badRequest('That file is empty.');
  if (content.length > MAX_SLIDE) {
    throw badRequest(`That image is ${(content.length / 1048576).toFixed(1)} MB. `
      + `Save it smaller — up to ${MAX_SLIDE / 1048576} MB.`);
  }

  const next = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM display_slides').get().n;
  const info = db.prepare(
    `INSERT INTO display_slides (title, mime, bytes, content, seconds, floor, sort_order, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(str(req.body.title) || null, mime, content.length, content,
    Math.min(Math.max(int(req.body.seconds) || 12, 3), 120),
    str(req.body.floor) || null, next, req.user.id);

  audit.log(req, 'queue.slide.add', 'display_slide', info.lastInsertRowid,
    { title: str(req.body.title), bytes: content.length });
  res.status(201).json({ id: info.lastInsertRowid, bytes: content.length, mime });
}));

router.patch('/slides/:id', deskRoles, wrap((req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM display_slides WHERE id = ?').get(id);
  if (!row) throw badRequest('No such slide.');
  const sets = [];
  const args = [];
  if (req.body.title !== undefined) { sets.push('title = ?'); args.push(str(req.body.title) || null); }
  if (req.body.seconds !== undefined) {
    sets.push('seconds = ?');
    args.push(Math.min(Math.max(int(req.body.seconds) || 12, 3), 120));
  }
  if (req.body.floor !== undefined) { sets.push('floor = ?'); args.push(str(req.body.floor) || null); }
  if (req.body.sortOrder !== undefined) { sets.push('sort_order = ?'); args.push(int(req.body.sortOrder) || 0); }
  if (req.body.active !== undefined) { sets.push('active = ?'); args.push(bool(req.body.active) ? 1 : 0); }
  if (!sets.length) throw badRequest('Nothing to change.');
  db.prepare(`UPDATE display_slides SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  audit.log(req, 'queue.slide.update', 'display_slide', id, req.body);
  res.json(db.prepare(
    'SELECT id, title, mime, bytes, seconds, floor, sort_order, active FROM display_slides WHERE id = ?')
    .get(id));
}));

router.delete('/slides/:id', deskRoles, wrap((req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM display_slides WHERE id = ?').run(id);
  audit.log(req, 'queue.slide.remove', 'display_slide', id, {});
  res.json({ removed: true });
}));

module.exports = router;
