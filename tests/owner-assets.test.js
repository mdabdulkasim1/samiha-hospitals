'use strict';
/**
 * The owner, what they can set, and the equipment register.
 *
 * Three things, and the first two pull against each other on purpose. The
 * owner passes every gate in the system. The administrator passes every gate
 * too — except the one that decides what the administrator is shown, because
 * an administrator who could edit that could simply switch their own screens
 * back on and the setting would be decoration.
 *
 * The third is the asset register, which earns its place in a clinical system
 * for one column: a machine past its calibration date is not an overdue
 * maintenance ticket, it is an analyser still printing numbers onto reports.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-owner-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');

let server;
let base;
const tokens = {};

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

const today = () => new Date().toISOString().slice(0, 10);
const shift = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['counselor', 'counselor@samiha.local'],
    ['nurse', 'nurse@samiha.local'], ['lab', 'lab@samiha.local'],
    ['cashier', 'cashier@samiha.local'], ['reception', 'reception@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }

  const made = await api('POST', '/api/masters/staff', {
    name: 'A.B Mohamed Abdul Kasim', role: 'owner',
    email: 'owner@samiha.local', password: 'Samiha#2026',
  }, 'admin');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const signin = await api('POST', '/api/auth/login',
    { username: 'owner@samiha.local', password: 'Samiha#2026' }, null);
  assert.strictEqual(signin.status, 200);
  tokens.owner = signin.body.token;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the owner
test('an owner account can exist, and reaches everything', async () => {
  // The role had to be added to a CHECK constraint, which in SQLite means the
  // users table was rebuilt. The thing that would make that a disaster is a
  // broken reference, so that is what is checked.
  assert.strictEqual(db.pragma('foreign_key_check').length, 0,
    'nothing was orphaned by rebuilding the users table');

  for (const p of ['/api/access', '/api/reports/revenue', '/api/reports/audit',
    '/api/accounts/summary', '/api/masters/staff', '/api/assets', '/api/stock/register']) {
    assert.strictEqual((await api('GET', p, undefined, 'owner')).status, 200, p);
  }

  // Money and prices reach them, as they reach the administrator.
  const rev = await api('GET', '/api/reports/revenue', undefined, 'owner');
  assert.ok(rev.body.concessions, 'the owner sees the figures, not a blanked report');
});

test('only the owner sets what the other roles are shown — not even the administrator', async () => {
  assert.strictEqual((await api('GET', '/api/access', undefined, 'owner')).status, 200);
  /*
   * The administrator is the case that matters. They bypass every other role
   * gate in the system, and must not bypass this one: what the owner sets
   * here includes the administrator's own menu.
   */
  for (const who of ['admin', 'counselor', 'nurse', 'cashier']) {
    assert.strictEqual((await api('GET', '/api/access', undefined, who)).status, 403, who);
    assert.strictEqual((await api('PUT', '/api/access', { hidden: {} }, who)).status, 403, who);
  }
});

test('hiding a screen takes it off the menu and leaves the lock alone', async () => {
  const set = await api('PUT', '/api/access',
    { hidden: { nurse: ['reports', 'whatsapp'], admin: ['workflow'] } }, 'owner');
  assert.strictEqual(set.status, 200, JSON.stringify(set.body));

  const nurse = await api('GET', '/api/auth/me', undefined, 'nurse');
  assert.deepStrictEqual(nurse.body.hiddenScreens.sort(), ['reports', 'whatsapp']);

  /*
   * The point of the whole design, stated as a test: hiding is about menus.
   * The nurse still reaches the endpoints her role entitles her to, because
   * what keeps anybody out of anything is the role gate on the route, and
   * that has not moved.
   */
  assert.strictEqual((await api('GET', '/api/reports/dashboard', undefined, 'nurse')).status, 200,
    'a hidden screen is not a revoked permission');
  // And it cannot grant anything either: the nurse was never allowed the
  // financial reports and still is not.
  assert.strictEqual((await api('GET', '/api/reports/revenue', undefined, 'nurse')).status, 403);

  // The owner's own menu is never touched.
  const owner = await api('GET', '/api/auth/me', undefined, 'owner');
  assert.deepStrictEqual(owner.body.hiddenScreens, []);
});

test('the settings refuse what would lock somebody out or mean nothing', async () => {
  // The owner is not a role whose screens can be set — see above for why.
  const atOwner = await api('PUT', '/api/access', { hidden: { owner: ['reports'] } }, 'owner');
  assert.strictEqual(atOwner.status, 400);
  assert.match(atOwner.body.error, /not a role whose screens can be set/);

  // Account & System is where a person changes their own password, so it
  // stays; a screen that does not exist is dropped rather than stored.
  const cleaned = await api('PUT', '/api/access',
    { hidden: { nurse: ['account', 'does-not-exist', 'reports'] } }, 'owner');
  assert.strictEqual(cleaned.status, 200);
  assert.deepStrictEqual(cleaned.body.hidden, { nurse: ['reports'] });

  assert.strictEqual((await api('PUT', '/api/access', { hidden: 'everything' }, 'owner')).status, 400);
});

// ------------------------------------------------- who may put a person on
/*
 * Adding staff is how access is granted at all, so it belongs to the owner —
 * from the moment there is one. Before that the administrator carries on as
 * before, because a clinic with no owner still has to run, and somebody has
 * to be able to create the first owner.
 */
test('once an owner exists, only the owner adds people', async () => {
  const mine = await api('POST', '/api/masters/staff',
    { name: 'Added by the owner', role: 'nurse', password: 'Samiha#2026' }, 'owner');
  assert.strictEqual(mine.status, 201, JSON.stringify(mine.body));

  const theirs = await api('POST', '/api/masters/staff',
    { name: 'Added by the admin', role: 'nurse', password: 'Samiha#2026' }, 'admin');
  assert.strictEqual(theirs.status, 403);
  assert.match(theirs.body.error, /Only the owner can add people/);

  // Not even another owner: the hand-over is complete.
  assert.strictEqual((await api('POST', '/api/masters/staff',
    { name: 'A second owner', role: 'owner', password: 'Samiha#2026' }, 'admin')).status, 403);
});

test('an administrator cannot take over the owner\'s account', async () => {
  const staff = (await api('GET', '/api/masters/staff', undefined, 'admin')).body;
  const owner = staff.find((u) => u.role === 'owner');
  assert.ok(owner);

  /*
   * The hole this closes: an administrator who could set the owner's password
   * could sign in as the owner, and every rule above it would be decoration.
   */
  for (const [method, p, body] of [
    ['POST', `/api/masters/staff/${owner.id}/password`, {}],
    ['PATCH', `/api/masters/staff/${owner.id}`, { password: 'Hijack#2026' }],
    ['DELETE', `/api/masters/staff/${owner.id}`, undefined],
  ]) {
    const r = await api(method, p, body, 'admin');
    assert.strictEqual(r.status, 403, `${method} ${p}`);
    assert.match(r.body.error, /Only the owner/);
  }

  // The owner's own password still works, which is the point of all three.
  assert.strictEqual((await api('POST', '/api/auth/login',
    { username: 'owner@samiha.local', password: 'Samiha#2026' }, null)).status, 200);

  // And the owner may still do all three to anybody else.
  const other = staff.find((u) => u.role === 'pharmacy');
  assert.strictEqual((await api('POST', `/api/masters/staff/${other.id}/password`, {}, 'owner')).status, 200);
});

// --------------------------------------------------------------- the register
test('the purchase orders are on the register, with the blanks left blank', async () => {
  const { status, body } = await api('GET', '/api/assets?limit=500', undefined, 'admin');
  assert.strictEqual(status, 200);
  assert.ok(body.total >= 60, `expected the five purchase orders, got ${body.total}`);

  const find = (part) => body.rows.find((a) => a.name.includes(part));
  const analyser = find('Biochemistry analyser');
  assert.ok(analyser, 'the biochemistry analyser is on the register');
  assert.strictEqual(analyser.supplier, 'People Health Care');
  assert.strictEqual(analyser.po_no, 'AKB-SMC-010826-007');
  assert.strictEqual(analyser.unit_cost, 420000);
  assert.strictEqual(analyser.needs_calibration, 1);
  assert.strictEqual(analyser.calibration_months, 6);

  // What the paperwork cannot know is left for the clinic, not invented.
  for (const a of body.rows) {
    assert.strictEqual(a.serial_no, null, `${a.name} should have no serial number yet`);
    assert.strictEqual(a.location, null, `${a.name} should have no location yet`);
    assert.strictEqual(a.calibration_due, null, `${a.name} should have no due date yet`);
  }

  // Furniture is on the register but nobody calibrates a waiting-room chair.
  const chairs = body.rows.find((a) => a.model === 'Fly-07');
  assert.ok(chairs, 'the Fly-07 chair sets are on the register');
  assert.strictEqual(chairs.needs_calibration, 0);
  assert.strictEqual(chairs.quantity, 6);
  assert.strictEqual(chairs.supplier, 'Geeken Seating Collection Pvt Ltd');
});

test('seeding again adds nothing and overwrites nothing the clinic has entered', async () => {
  const before = (await api('GET', '/api/assets?limit=500', undefined, 'admin')).body.total;
  const target = (await api('GET', '/api/assets?limit=500', undefined, 'admin'))
    .body.rows.find((a) => a.name.includes('ECG machine'));

  await api('PATCH', `/api/assets/${target.id}`,
    { serialNo: 'MED-99812', location: 'OPD-1' }, 'lab');

  const { added } = require('../src/db/catalogue').sync({ quiet: true });
  assert.strictEqual(added.assets, 0, 'a second run adds nothing');

  const after = (await api('GET', `/api/assets/${target.id}`, undefined, 'admin')).body;
  assert.strictEqual(after.serial_no, 'MED-99812', 'what the clinic typed survives');
  assert.strictEqual(after.location, 'OPD-1');
  assert.strictEqual((await api('GET', '/api/assets?limit=500', undefined, 'admin')).body.total, before);
});

test('a calibration date is read as expired, due soon or not set', async () => {
  const made = await api('POST', '/api/assets', {
    name: 'Test autoclave', category: 'Medical equipment',
    needsCalibration: true, calibrationMonths: 12,
  }, 'lab');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id;

  const state = async () => (await api('GET', `/api/assets/${id}`, undefined, 'nurse')).body.calibration_state;
  assert.strictEqual(await state(), 'unset', 'no date yet is its own state, not "fine"');

  await api('PATCH', `/api/assets/${id}`, { calibrationDue: shift(-1) }, 'lab');
  assert.strictEqual(await state(), 'expired');

  await api('PATCH', `/api/assets/${id}`, { calibrationDue: shift(30) }, 'lab');
  assert.strictEqual(await state(), 'due_soon', 'two months of warning, not two days');

  await api('PATCH', `/api/assets/${id}`, { calibrationDue: shift(200) }, 'lab');
  assert.strictEqual(await state(), 'ok');

  // The dashboard counts the same thing, so the board and the register agree.
  await api('PATCH', `/api/assets/${id}`, { calibrationDue: shift(-5) }, 'lab');
  const dash = (await api('GET', '/api/reports/dashboard', undefined, 'nurse')).body;
  assert.ok(dash.calibration.expired >= 1, 'an overdue machine reaches the board everybody lands on');
});

test('recording a calibration moves the dates and keeps the certificate', async () => {
  const made = await api('POST', '/api/assets', {
    name: 'Test analyser', needsCalibration: true, calibrationMonths: 6,
  }, 'lab');
  const id = made.body.id;

  const done = await api('POST', `/api/assets/${id}/events`, {
    kind: 'calibration', happenedOn: today(),
    doneBy: 'Alpha Chem service', reference: 'CAL/2026/118', cost: 4500,
  }, 'lab');
  assert.strictEqual(done.status, 201, JSON.stringify(done.body));

  const a = (await api('GET', `/api/assets/${id}`, undefined, 'lab')).body;
  assert.strictEqual(a.last_calibrated, today());
  assert.ok(a.calibration_due > today(), 'the next due date is worked out from the interval');
  assert.strictEqual(a.calibration_by, 'Alpha Chem service');
  assert.strictEqual(a.certificate_no, 'CAL/2026/118');
  assert.strictEqual(a.calibration_state, 'ok');

  // The history is a history, not a single overwritten date.
  assert.strictEqual(a.events.length, 1);
  assert.strictEqual(a.events[0].kind, 'calibration');
  assert.strictEqual(a.events[0].cost, 4500);

  // A date in the future is not something that has happened.
  assert.strictEqual((await api('POST', `/api/assets/${id}/events`,
    { kind: 'service', happenedOn: shift(5) }, 'lab')).status, 400);
});

test('a retired machine leaves the list and keeps its history', async () => {
  const made = await api('POST', '/api/assets', { name: 'Old nebuliser' }, 'lab');
  const id = made.body.id;

  assert.strictEqual((await api('POST', `/api/assets/${id}/retire`, {}, 'lab')).status, 400,
    'retiring needs a reason');
  const gone = await api('POST', `/api/assets/${id}/retire`,
    { reason: 'Beyond economical repair', status: 'condemned' }, 'lab');
  assert.strictEqual(gone.status, 200);
  assert.strictEqual(gone.body.status, 'condemned');

  const list = (await api('GET', '/api/assets?limit=500', undefined, 'admin')).body;
  assert.ok(!list.rows.some((a) => a.id === id), 'off the active register');
  const still = await api('GET', `/api/assets/${id}`, undefined, 'admin');
  assert.strictEqual(still.status, 200, 'but still there to be looked up');
  assert.ok(still.body.events.some((e) => /Beyond economical repair/.test(e.detail || '')));
});

test('everyone may read the register; what a machine cost is a price', async () => {
  // The bench has as much business knowing the analyser is overdue as the
  // owner does, so reading is open.
  for (const who of ['nurse', 'lab', 'reception', 'cashier', 'owner']) {
    assert.strictEqual((await api('GET', '/api/assets', undefined, who)).status, 200, who);
  }
  // What it cost follows the same rule as every other price in the system.
  const bench = (await api('GET', '/api/assets?limit=500', undefined, 'lab')).body;
  assert.ok(bench.rows.every((a) => a.unit_cost === null), 'no rupees for the bench');
  assert.strictEqual(bench.summary.value, null);

  const desk = (await api('GET', '/api/assets?limit=500', undefined, 'cashier')).body;
  assert.ok(desk.rows.some((a) => a.unit_cost > 0), 'and figures for the desks that see prices');
  assert.ok(desk.summary.value > 0);

  // Adding is not open to everybody who may look.
  assert.strictEqual((await api('POST', '/api/assets', { name: 'Nope' }, 'reception')).status, 403);
});

// ---------------------------------------------------------- month by month
test('the cash flow can be read by month as well as by day and week', async () => {
  const month = await api('GET', '/api/accounts/summary?by=month&from=2026-01-01', undefined, 'owner');
  assert.strictEqual(month.status, 200);
  assert.strictEqual(month.body.by, 'month');
  for (const p of month.body.points) {
    assert.match(p.at, /^\d{4}-\d{2}-01$/, 'a month is labelled by its first day');
  }

  const day = await api('GET', '/api/accounts/summary?by=day&from=2026-01-01', undefined, 'owner');
  const sum = (pts, k) => Math.round(pts.reduce((t, p) => t + p[k], 0));
  assert.strictEqual(sum(day.body.points, 'income'), sum(month.body.points, 'income'),
    'the same money however it is cut');
  assert.strictEqual(sum(day.body.points, 'expense'), sum(month.body.points, 'expense'));

  assert.strictEqual((await api('GET', '/api/accounts/summary?by=fortnight', undefined, 'owner')).status, 400);
});
