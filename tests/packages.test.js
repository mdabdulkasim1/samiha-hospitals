'use strict';
/**
 * Health packages: the ones that ship, and the ones the clinic builds.
 *
 * A package is two things written at once — one line the counter presses,
 * and the list of tests the bench is then asked to run. Getting only the
 * first is how a package gets sold that nobody runs, and it is invisible
 * until a patient asks where their results are.
 *
 * The hard part is not creating one. It is that the shipped packages are
 * rewritten from seed data on every boot while the clinic's own must never
 * be touched, and that a package's contents have to keep resolving to tests
 * that exist and are still offered — through a rate change, through a
 * catalogue being replaced underneath it, and through a restart.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-pkg-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');
const catalogue = require('../src/db/catalogue');

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

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['lab', 'lab@samiha.local']]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, email);
    tokens[as] = r.body.token;
  }
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const priceOf = (code) => db.prepare('SELECT price FROM lab_tests WHERE code = ?').get(code).price;
const membersOf = (code) => db.prepare(
  'SELECT test_code FROM lab_package_items WHERE package_code = ? ORDER BY sort_order')
  .all(code).map((r) => r.test_code);
const broken = () => db.prepare(
  `SELECT pi.package_code, pi.test_code FROM lab_package_items pi
     LEFT JOIN lab_tests t ON t.code = pi.test_code
    WHERE t.id IS NULL OR t.active = 0`).all();

// ------------------------------------------------------- the basic package
test('the basic health check is the three numbers, at the price the clinic set', () => {
  assert.deepStrictEqual(membersOf('PKG-BASIC'), ['FBS', 'HBA1C', 'LIPID']);
  assert.strictEqual(priceOf('PKG-BASIC'), 500);

  /*
   * Bought separately the three come to 630. The package has to be worth
   * buying — a package priced at or above its own contents is one a patient
   * beats by asking for the tests one at a time.
   */
  const apart = db.prepare(
    `SELECT SUM(t.price) AS s FROM lab_package_items i JOIN lab_tests t ON t.code = i.test_code
      WHERE i.package_code = 'PKG-BASIC'`).get().s;
  assert.strictEqual(apart, 630);
  assert.ok(priceOf('PKG-BASIC') < apart, 'the package saves the patient something');

  // And the counter can see what is in it without opening anything.
  const row = db.prepare("SELECT ref_text FROM lab_tests WHERE code = 'PKG-BASIC'").get();
  for (const t of ['Fasting Blood Sugar', 'Glycated Haemoglobin', 'Lipid Profile']) {
    assert.ok(row.ref_text.includes(t), `the blurb names ${t}`);
  }
});

// --------------------------------------------------- surviving the restart
test('a package still resolves after the catalogue is rebuilt, twice', () => {
  /*
   * The bug this pins down shipped and was caught here. Package membership
   * is rewritten from seed data on every boot, and the imaging card that
   * replaced the X-ray list only repointed those lines once. So the first
   * restart was fine and the SECOND put the old codes back — pointing at
   * studies that were by then switched off. Six packages would have gone on
   * selling while the bench was asked for films nobody offers.
   */
  assert.deepStrictEqual(broken(), [], 'nothing is dangling to begin with');
  catalogue.sync({ quiet: true });
  assert.deepStrictEqual(broken(), [], 'nor after one rebuild');
  catalogue.sync({ quiet: true });
  assert.deepStrictEqual(broken(), [], 'nor after a second — this is the one that failed');
  catalogue.sync({ quiet: true });
  assert.deepStrictEqual(broken(), [], 'nor a third');

  // The packages that cover imaging name the card's studies, not the old ones.
  assert.ok(membersOf('PKG-EXEC-M').includes('XR-CHESTPA'));
  assert.ok(!membersOf('PKG-EXEC-M').includes('XR-CHEST'));
});

// ------------------------------------------------- what the clinic builds
test('the clinic can build a package, and it is sellable at once', async () => {
  const made = await api('POST', '/api/masters/packages', {
    name: 'Diabetes follow-up', strapline: 'Every three months',
    price: 270, members: ['FBS', 'PPBS', 'HBA1C'],
  });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const code = made.body.code;
  assert.ok(code.startsWith('PKG-'), `generated a code: ${code}`);

  assert.strictEqual(made.body.bill_group, 'Health packages');
  assert.strictEqual(made.body.price, 270);
  assert.strictEqual(made.body.active, 1);
  assert.deepStrictEqual(membersOf(code), ['FBS', 'PPBS', 'HBA1C']);
  assert.ok(made.body.ref_text.includes('Fasting Blood Sugar'), 'the blurb lists what it covers');

  // It is on the charge board the counter presses.
  const board = (await api('GET', '/api/masters/catalogue', undefined, 'reception')).body;
  assert.ok(board.flatMap((g) => g.items).some((i) => i.code === code), 'on the charge board');

  // And a rebuild does not touch it: the clinic's own work is its own.
  catalogue.sync({ quiet: true });
  assert.strictEqual(priceOf(code), 270);
  assert.deepStrictEqual(membersOf(code), ['FBS', 'PPBS', 'HBA1C']);
});

test('the price is the clinic\'s, and the saving is reported rather than enforced', async () => {
  /*
   * Three quarters of the component total is what the form offers, not what
   * the system insists on — a clinic may price a package above its parts if
   * it bundles a consultation in. What it must not do is hide that, so the
   * listing carries what the tests come to separately and what the patient
   * actually saves.
   */
  const steep = await api('POST', '/api/masters/packages', {
    name: 'Priced above its parts', price: 9999, members: ['FBS', 'HBA1C'],
  });
  assert.strictEqual(steep.status, 201, 'the clinic is allowed to do this');

  const list = (await api('GET', '/api/masters/packages')).body;
  const row = list.find((p) => p.code === steep.body.code);
  assert.strictEqual(row.apart, 330, 'what the tests come to one at a time');
  assert.ok(row.saving < 0, 'and the listing says the patient loses by it');

  const basic = list.find((p) => p.code === 'PKG-BASIC');
  assert.strictEqual(basic.apart, 630);
  assert.strictEqual(basic.saving, 130);
});

test('a package with no tests in it is not a package', async () => {
  assert.strictEqual((await api('POST', '/api/masters/packages',
    { name: 'Empty', price: 100, members: [] })).status, 400);
  assert.strictEqual((await api('POST', '/api/masters/packages',
    { name: 'No price', members: ['FBS'] })).status, 400);
  assert.strictEqual((await api('POST', '/api/masters/packages',
    { name: '', price: 100, members: ['FBS'] })).status, 400);

  // And it cannot name something the clinic does not offer.
  const bogus = await api('POST', '/api/masters/packages',
    { name: 'Made up', price: 100, members: ['FBS', 'NO-SUCH-TEST'] });
  assert.strictEqual(bogus.status, 400);
  assert.match(bogus.body.error, /not tests the clinic offers/i);
});

test('a package that ships with the system cannot be rewritten here', async () => {
  /*
   * Its contents come from the seed list and are rewritten on every boot, so
   * an edit here would hold until the next restart and then quietly revert —
   * which is worse than refusing it.
   */
  const refused = await api('PATCH', '/api/masters/packages/PKG-BASIC',
    { name: 'Renamed', price: 400, members: ['FBS'] });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.body.error, /ships with the system/i);
  assert.deepStrictEqual(membersOf('PKG-BASIC'), ['FBS', 'HBA1C', 'LIPID']);

  // Its price is still the clinic's, and is set on the rate card like any other.
  const id = db.prepare("SELECT id FROM lab_tests WHERE code = 'PKG-BASIC'").get().id;
  assert.strictEqual((await api('PATCH', `/api/masters/lab-tests/${id}`, { price: 525 })).status, 200);
  assert.strictEqual(priceOf('PKG-BASIC'), 525);
  db.prepare("UPDATE lab_tests SET price = 500 WHERE code = 'PKG-BASIC'").run();
});

test('retiring a package takes it off the board without erasing it', async () => {
  const made = await api('POST', '/api/masters/packages',
    { name: 'Seasonal offer', price: 300, members: ['FBS', 'HBA1C'] });
  const code = made.body.code;

  assert.strictEqual((await api('DELETE', `/api/masters/packages/${code}`)).status, 200);
  assert.strictEqual(db.prepare('SELECT active FROM lab_tests WHERE code = ?').get(code).active, 0);

  const board = (await api('GET', '/api/masters/catalogue', undefined, 'reception')).body;
  assert.ok(!board.flatMap((g) => g.items).some((i) => i.code === code), 'off the board');
  // A bill raised for it last month still names it.
  assert.ok(db.prepare('SELECT 1 FROM lab_tests WHERE code = ?').get(code), 'still on file');

  assert.strictEqual((await api('DELETE', '/api/masters/packages/PKG-BASIC')).status, 400);
});

test('only management builds a package', async () => {
  for (const who of ['reception', 'lab']) {
    assert.strictEqual((await api('POST', '/api/masters/packages',
      { name: 'Nope', price: 100, members: ['FBS'] }, who)).status, 403, who);
  }
  // But anyone at the counter may read what is in one.
  assert.strictEqual((await api('GET', '/api/masters/packages', undefined, 'reception')).status, 200);
});
