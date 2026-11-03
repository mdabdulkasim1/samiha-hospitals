'use strict';
/**
 * What the clinic owns, and whether it can be trusted today.
 *
 * An asset register is usually a finance exercise — a list of what was bought
 * so it can be depreciated. The reason this one is in a clinical system is the
 * calibration date. A biochemistry analyser out of calibration is not an
 * overdue maintenance ticket, it is a machine still printing numbers onto
 * reports that patients are treated on; an X-ray unit past its AERB quality
 * assurance is a licence problem discovered during an inspection. Both are
 * things the clinic should see coming weeks out, which means the date has to
 * live somewhere that puts it in front of somebody.
 *
 * So the register is open to read across the clinic — the technician at the
 * bench has as much business knowing an analyser is overdue as the owner does
 * — while adding and editing belongs to the people who answer for the
 * equipment.
 */
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, badRequest } = require('../lib/http');
const { requireRole, requireAuth, seesPrices } = require('../lib/auth');
const { required, str, int, num, oneOf, bool, paging } = require('../lib/validate');
const { generate } = require('../lib/ids');
const audit = require('../lib/audit');

const router = express.Router();

/** Anyone signed in may look; the equipment they use is their business. */
const readRoles = requireAuth;
/** Keeping it is the owner's, the administrator's and the departments that run it. */
const keepRoles = requireRole('lab', 'pharmacy', 'ward', 'nurse');

const STATUSES = ['in_use', 'standby', 'under_repair', 'condemned', 'disposed'];
const EVENT_KINDS = ['calibration', 'service', 'repair', 'moved', 'status', 'note'];

const CATEGORIES = [
  'Imaging & laboratory',
  'Medical equipment',
  'Dental equipment',
  'Radiation protection',
  'Hospital furniture',
  'Furniture & fittings',
  'IT & office',
  'Electrical & utility',
  'Other',
];

const today = () => new Date().toISOString().slice(0, 10);
const addMonths = (date, months) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + Number(months || 0));
  return d.toISOString().slice(0, 10);
};

const SELECT = `
  SELECT a.*, d.name AS department_name, u.name AS added_by_name,
         (SELECT COUNT(*) FROM asset_events e WHERE e.asset_id = a.id) AS event_count
    FROM assets a
    LEFT JOIN departments d ON d.id = a.department_id
    LEFT JOIN users u ON u.id = a.created_by`;

const one = (id) => db.prepare(`${SELECT} WHERE a.id = ?`).get(id);

/**
 * How a calibration date reads today.
 *
 * Worked out here rather than in the browser so the list, the dashboard tile
 * and any future report cannot disagree about what "due soon" means. Sixty
 * days, because that is roughly how long it takes to get an engineer booked
 * and a certificate issued — a warning that arrives the week it expires is
 * not a warning.
 */
const SOON_DAYS = 60;
function calibrationState(a) {
  if (!a.needs_calibration) return null;
  if (!a.calibration_due) return 'unset';
  const days = Math.round(
    (new Date(`${a.calibration_due}T00:00:00Z`) - new Date(`${today()}T00:00:00Z`)) / 86400000
  );
  if (days < 0) return 'expired';
  if (days <= SOON_DAYS) return 'due_soon';
  return 'ok';
}

const decorate = (rows, user) => rows.map((a) => {
  const out = { ...a, calibration_state: calibrationState(a) };
  // What a machine cost is a price, and the bench has no call to read it.
  if (!seesPrices(user)) out.unit_cost = null;
  return out;
});

router.get('/meta', readRoles, wrap((req, res) => {
  res.json({
    categories: CATEGORIES,
    statuses: STATUSES,
    eventKinds: EVENT_KINDS,
    departments: db.prepare('SELECT id, name FROM departments WHERE active = 1 ORDER BY sort_order, name').all(),
    soonDays: SOON_DAYS,
  });
}));

router.get('/', readRoles, wrap((req, res) => {
  const q = str(req.query.q, '');
  const category = str(req.query.category);
  const status = oneOf(req.query.status, STATUSES, 'status');
  const due = oneOf(req.query.due, ['expired', 'due_soon', 'unset', 'ok'], 'due');
  const { limit, offset, page } = paging(req.query, 200);

  const clauses = ['a.active = 1'];
  const params = [];
  if (q) {
    clauses.push(`(a.asset_no LIKE ? OR a.name LIKE ? OR a.make LIKE ? OR a.model LIKE ?
      OR a.serial_no LIKE ? OR a.supplier LIKE ? OR a.location LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like);
  }
  if (category) { clauses.push('a.category = ?'); params.push(category); }
  if (status) { clauses.push('a.status = ?'); params.push(status); }
  const where = `WHERE ${clauses.join(' AND ')}`;

  // Anything with a date comes first and in date order, so what is about to
  // run out is at the top rather than wherever the alphabet put it.
  const rows = decorate(db.prepare(
    `${SELECT} ${where}
      ORDER BY CASE WHEN a.needs_calibration = 1 AND a.calibration_due IS NOT NULL THEN 0
                    WHEN a.needs_calibration = 1 THEN 1 ELSE 2 END,
               a.calibration_due, a.category, a.name
      LIMIT ? OFFSET ?`
  ).all(...params, limit, offset), req.user);

  res.json({
    page, limit, rows: due ? rows.filter((r) => r.calibration_state === due) : rows,
    total: db.prepare(`SELECT COUNT(*) AS c FROM assets a ${where}`).get(...params).c,
    summary: summary(req.user),
  });
}));

/** The counts the dashboard tile and the screen's header both read. */
function summary(user) {
  const all = decorate(db.prepare(`${SELECT} WHERE a.active = 1`).all(), user);
  const count = (s) => all.filter((a) => a.calibration_state === s).length;
  return {
    assets: all.length,
    units: all.reduce((t, a) => t + (Number(a.quantity) || 0), 0),
    value: seesPrices(user)
      ? Math.round(all.reduce((t, a) => t + (Number(a.unit_cost) || 0) * (Number(a.quantity) || 0), 0) * 100) / 100
      : null,
    needCalibration: all.filter((a) => a.needs_calibration).length,
    expired: count('expired'),
    dueSoon: count('due_soon'),
    unset: count('unset'),
    underRepair: all.filter((a) => a.status === 'under_repair').length,
  };
}

router.get('/summary', readRoles, wrap((req, res) => res.json(summary(req.user))));

router.get('/:id', readRoles, wrap((req, res) => {
  const asset = one(int(req.params.id));
  if (!asset) throw notFound('Asset not found');
  const [decorated] = decorate([asset], req.user);
  decorated.events = db.prepare(
    `SELECT e.*, u.name AS entered_by_name FROM asset_events e
       LEFT JOIN users u ON u.id = e.created_by
      WHERE e.asset_id = ? ORDER BY date(e.happened_on) DESC, e.id DESC`
  ).all(asset.id);
  res.json(decorated);
}));

/** The fields an asset can be given, on the way in and on the way through. */
function fieldsFrom(body, existing = {}) {
  const pick = (key, fn, fallback) => (body[key] === undefined
    ? (existing[fallback !== undefined ? fallback : key] === undefined ? null : existing[fallback !== undefined ? fallback : key])
    : fn(body[key]));
  return {
    name: body.name === undefined ? existing.name : str(body.name),
    category: pick('category', str),
    make: pick('make', str),
    model: pick('model', str),
    serial_no: pick('serialNo', str, 'serial_no'),
    quantity: body.quantity === undefined ? (existing.quantity || 1) : Math.max(int(body.quantity) || 1, 1),
    location: pick('location', str),
    department_id: body.departmentId === undefined
      ? (existing.department_id === undefined ? null : existing.department_id)
      : (body.departmentId ? int(body.departmentId) : null),
    status: body.status === undefined
      ? (existing.status || 'in_use') : (oneOf(body.status, STATUSES, 'status') || 'in_use'),
    supplier: pick('supplier', str),
    po_no: pick('poNo', str, 'po_no'),
    invoice_no: pick('invoiceNo', str, 'invoice_no'),
    purchase_date: pick('purchaseDate', str, 'purchase_date'),
    unit_cost: body.unitCost === undefined
      ? (existing.unit_cost === undefined ? null : existing.unit_cost)
      : (body.unitCost === '' || body.unitCost === null ? null : num(body.unitCost)),
    warranty_until: pick('warrantyUntil', str, 'warranty_until'),
    amc_until: pick('amcUntil', str, 'amc_until'),
    needs_calibration: body.needsCalibration === undefined
      ? (existing.needs_calibration || 0) : (bool(body.needsCalibration) ? 1 : 0),
    calibration_months: body.calibrationMonths === undefined
      ? (existing.calibration_months === undefined ? null : existing.calibration_months)
      : (body.calibrationMonths ? int(body.calibrationMonths) : null),
    last_calibrated: pick('lastCalibrated', str, 'last_calibrated'),
    calibration_due: pick('calibrationDue', str, 'calibration_due'),
    calibration_by: pick('calibrationBy', str, 'calibration_by'),
    certificate_no: pick('certificateNo', str, 'certificate_no'),
    notes: pick('notes', str),
  };
}

/*
 * A due date the clinic did not give us, worked out from the one it did.
 *
 * Only ever filled in, never corrected: if somebody has typed a due date it
 * stands, even where the arithmetic disagrees, because the certificate in
 * their hand outranks our assumption about the interval.
 */
function fillDue(f) {
  if (f.needs_calibration && !f.calibration_due && f.last_calibrated && f.calibration_months) {
    f.calibration_due = addMonths(f.last_calibrated, f.calibration_months);
  }
  return f;
}

router.post('/', keepRoles, wrap((req, res) => {
  required(req.body, ['name']);
  const f = fillDue(fieldsFrom(req.body));
  const assetNo = str(req.body.assetNo) || generate('asset');
  const cols = Object.keys(f);
  const info = db.prepare(
    `INSERT INTO assets (asset_no, created_by, ${cols.join(', ')})
     VALUES (@asset_no, @created_by, ${cols.map((c) => `@${c}`).join(', ')})`
  ).run({ ...f, asset_no: assetNo, created_by: req.user.id });

  audit.log(req, 'asset_add', 'asset', info.lastInsertRowid, { assetNo, name: f.name });
  res.status(201).json(one(info.lastInsertRowid));
}));

router.patch('/:id', keepRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const existing = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  if (!existing) throw notFound('Asset not found');
  const f = fillDue(fieldsFrom(req.body, existing));
  if (!f.name) throw badRequest('An asset needs a name.');

  db.prepare(
    `UPDATE assets SET ${Object.keys(f).map((c) => `${c} = @${c}`).join(', ')},
            updated_at = datetime('now') WHERE id = @id`
  ).run({ ...f, id });

  audit.log(req, 'asset_edit', 'asset', id, { assetNo: existing.asset_no });
  res.json(one(id));
}));

/**
 * Retiring an asset, which is not deleting it.
 *
 * A machine that was in the building has results and repairs attached to it,
 * and "what was this report run on" is a question asked years later. So it
 * leaves the active list and keeps its history.
 */
router.post('/:id/retire', keepRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  if (!asset) throw notFound('Asset not found');
  const reason = str(req.body.reason);
  if (!reason) throw badRequest('Say why it is being retired.');
  const status = oneOf(req.body.status, ['condemned', 'disposed'], 'status') || 'disposed';

  db.prepare("UPDATE assets SET active = 0, status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id);
  db.prepare(
    `INSERT INTO asset_events (asset_id, kind, happened_on, detail, created_by)
     VALUES (?, 'status', ?, ?, ?)`
  ).run(id, today(), `Retired as ${status}: ${reason}`, req.user.id);

  audit.log(req, 'asset_retire', 'asset', id, { assetNo: asset.asset_no, status, reason });
  res.json(one(id));
}));

// -------------------------------------------------------------- what happened
router.post('/:id/events', keepRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  if (!asset) throw notFound('Asset not found');
  required(req.body, ['kind', 'happenedOn']);
  const kind = oneOf(req.body.kind, EVENT_KINDS, 'kind');
  const happenedOn = str(req.body.happenedOn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(happenedOn || '')) throw badRequest('Give the date as YYYY-MM-DD.');
  if (happenedOn > today()) throw badRequest('That date is in the future.');

  /*
   * A calibration recorded here moves the asset's own dates, because the
   * alternative is a register whose header says one thing and whose history
   * says another — and the header is the one people read.
   */
  let nextDue = str(req.body.nextDue);
  if (kind === 'calibration' && !nextDue && asset.calibration_months) {
    nextDue = addMonths(happenedOn, asset.calibration_months);
  }

  const info = db.prepare(
    `INSERT INTO asset_events (asset_id, kind, happened_on, detail, done_by, reference, cost, next_due, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, kind, happenedOn, str(req.body.detail), str(req.body.doneBy),
        str(req.body.reference),
        req.body.cost === undefined || req.body.cost === '' ? null : num(req.body.cost),
        nextDue, req.user.id);

  if (kind === 'calibration') {
    db.prepare(
      `UPDATE assets SET last_calibrated = ?, calibration_due = COALESCE(?, calibration_due),
              calibration_by = COALESCE(?, calibration_by),
              certificate_no = COALESCE(?, certificate_no),
              needs_calibration = 1, updated_at = datetime('now')
        WHERE id = ?`
    ).run(happenedOn, nextDue, str(req.body.doneBy), str(req.body.reference), id);
  }
  if (kind === 'status' && req.body.status) {
    db.prepare("UPDATE assets SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(oneOf(req.body.status, STATUSES, 'status'), id);
  }

  audit.log(req, 'asset_event', 'asset', id, { assetNo: asset.asset_no, kind, happenedOn });
  res.status(201).json(one(id));
}));

module.exports = router;
