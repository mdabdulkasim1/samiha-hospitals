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
  res.json(queue.display(str(req.query.floor), str(req.query.date) || today()));
}));

module.exports = router;
