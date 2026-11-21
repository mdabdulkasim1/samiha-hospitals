'use strict';
/**
 * The code stuck to the equipment, and the keeper who sticks it there.
 *
 * An asset code is the one identifier in this system that leaves the
 * computer and lives in the world: it is printed on a 50 × 25 mm sticker
 * and glued to a wheelchair for the next ten years. Everything asserted
 * here follows from that.
 *
 * It has to be readable by a person holding the object — which is why the
 * shape SHC-WHLCH-0326-MPM-001 is tested as a shape and not just as a
 * unique string. It has to mean the same thing every time, so two
 * wheelchairs entered by two people on two days must carry the same middle
 * letters. And it must never change: a purchase date corrected next month
 * cannot rewrite a label that is already on the chair, because nobody is
 * going to go round the building with a scraper.
 *
 * The store keeper is tested alongside it because the role exists for this
 * work: the cupboard and the equipment in it, and nothing that touches a
 * patient.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-assets-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
require('../src/db/catalogue').sync({ quiet: true });
const { db } = require('../src/db');
const codes = require('../src/services/assetCodes');
const { hashPassword } = require('../src/lib/auth');
const app = require('../src/server');

let server;
let base;
const tokens = {};
const ids = {};

async function api(method, p, body, as = 'store') {
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

/** An asset straight into the table, with the fields a code needs. */
function asset({ name, purchase = '2026-03-14', branchId = null, category = 'Medical equipment' }) {
  const no = `AST${String(db.prepare('SELECT COUNT(*) AS c FROM assets').get().c + 9000)}`;
  return db.prepare(
    `INSERT INTO assets (asset_no, name, category, purchase_date, branch_id, created_by)
     VALUES (?, ?, ?, ?, ?, 1)`).run(no, name, category, purchase, branchId).lastInsertRowid;
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // The store keeper, created the way the staff screen creates one.
  db.prepare(
    `INSERT INTO users (staff_code, name, email, password_hash, role, active)
     VALUES ('EMPSTORE', 'Store Keeper', 'store@samiha.local', ?, 'store', 1)`
  ).run(hashPassword('samiha@123'));

  for (const [who, username] of Object.entries({
    store: 'store@samiha.local', admin: 'admin@samiha.local',
    reception: 'reception@samiha.local', nurse: 'nurse@samiha.local',
  })) {
    const res = await api('POST', '/api/auth/login', { username, password: 'samiha@123' }, null);
    assert.ok(res.body && res.body.token, `${who} could not sign in: ${JSON.stringify(res.body)}`);
    tokens[who] = res.body.token;
  }
  ids.branch = codes.defaultBranch().id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// =============================================================== the shape
test('a code reads Samiha, the item, the month, the branch and the serial', () => {
  const id = asset({ name: 'Wheelchair', purchase: '2026-03-14' });
  const { code } = codes.mint(id, { userId: 1 });

  assert.strictEqual(code, 'SHC-WHLCH-0326-MPM-001');
  const [prefix, item, month, branch, serial] = code.split('-');
  assert.strictEqual(prefix, 'SHC', 'Samiha Healthcare');
  assert.strictEqual(item, 'WHLCH', 'what the thing is');
  assert.strictEqual(month, '0326', 'March 2026, as the clinic writes it');
  assert.strictEqual(branch, 'MPM', 'Melapalayam');
  assert.strictEqual(serial, '001', 'the first of them');
});

test('the serial counts within the item at that branch', () => {
  const codesOut = ['Wheelchair', 'Wheelchair', 'Wheelchair']
    .map((n) => codes.mint(asset({ name: n, purchase: '2026-04-02' }), { userId: 1 }).code);
  assert.deepStrictEqual(codesOut, [
    'SHC-WHLCH-0426-MPM-002', 'SHC-WHLCH-0426-MPM-003', 'SHC-WHLCH-0426-MPM-004',
  ], 'the month moves on, the count does not start again');

  // A different kind of thing starts at 001 of its own.
  assert.match(codes.mint(asset({ name: 'Autoclave', purchase: '2026-04-02' }), { userId: 1 }).code,
    /^SHC-ATCLV-0426-MPM-001$/);
});

test('the same kind of thing always carries the same letters', () => {
  /*
   * The whole scheme rests on this. If two people entering wheelchairs on
   * two days produce WHLCH and WHEEL, the code stops being readable and
   * becomes a serial number with extra steps.
   */
  const a = codes.mint(asset({ name: 'Hospital cot — 2 function manual' }), { userId: 1 }).code;
  const b = codes.mint(asset({ name: 'Hospital cot — 3 function electric, ABS panels' }), { userId: 1 }).code;
  assert.strictEqual(a.split('-')[1], b.split('-')[1],
    'the specification after the dash is not part of what the thing is');
  assert.strictEqual(a.split('-')[4], '001');
  assert.strictEqual(b.split('-')[4], '002', 'and they share one running count');
});

test('a branch opening later changes the middle of the code and nothing else', () => {
  const ch = codes.saveBranch(null, { code: 'CH', name: 'Cheranmahadevi' });
  const id = asset({ name: 'Wheelchair', purchase: '2026-05-01', branchId: ch.id });
  const { code } = codes.mint(id, { userId: 1 });
  assert.strictEqual(code, 'SHC-WHLCH-0526-CH-001',
    'the new branch starts its own count for that item');

  // Melapalayam's count is untouched by it.
  assert.match(codes.mint(asset({ name: 'Wheelchair', purchase: '2026-05-01' }), { userId: 1 }).code,
    /^SHC-WHLCH-0526-MPM-005$/);
});

test('a code is never reissued, and never rewritten under a printed sticker', () => {
  const id = asset({ name: 'Nebulizer', purchase: '2026-02-10' });
  const first = codes.mint(id, { userId: 1 }).code;

  assert.throws(() => codes.mint(id, { userId: 1 }), /already carries/,
    'a second code for one object is how a register stops matching the store room');

  /*
   * Correcting the purchase date afterwards is allowed — the register
   * should be right — but the code stays as printed. Nobody is going round
   * the building with a scraper.
   */
  db.prepare("UPDATE assets SET purchase_date = '2025-11-01' WHERE id = ?").run(id);
  assert.strictEqual(db.prepare('SELECT asset_code FROM assets WHERE id = ?').get(id).asset_code,
    first);
});

test('no purchase date, no code — rather than a made-up month', () => {
  const id = asset({ name: 'Trolley', purchase: null });
  assert.throws(() => codes.mint(id, { userId: 1 }), /purchase date/i);
  assert.strictEqual(db.prepare('SELECT asset_code FROM assets WHERE id = ?').get(id).asset_code, null,
    'and the asset is still on the register, just unlabelled');
});

test('two things can never hold the same code', () => {
  const id = asset({ name: 'Suction apparatus', purchase: '2026-01-05' });
  const { code } = codes.mint(id, { userId: 1 });
  const other = asset({ name: 'Suction apparatus', purchase: '2026-01-05' });
  assert.throws(() => db.prepare('UPDATE assets SET asset_code = ? WHERE id = ?').run(code, other),
    /UNIQUE/, 'the database refuses it even if something else tries');
});

// ============================================================== the batch
test('the first run over a store room codes everything that can be coded', async () => {
  const good = asset({ name: 'Oxygen cylinder', purchase: '2026-06-01' });
  const bad = asset({ name: 'Step stool', purchase: null });

  const res = await api('POST', '/api/assets/codes/mint-missing', {});
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.minted.length >= 1);
  assert.ok(res.body.minted.some((m) => m.id === good),
    'the oxygen cylinder got its code');
  assert.ok(res.body.skipped.some((s) => s.id === bad && /purchase date/i.test(s.reason)),
    'and the one that could not be coded is named, with the reason');

  // Run it twice and nothing moves: already-coded assets are left alone.
  const again = await api('POST', '/api/assets/codes/mint-missing', {});
  assert.ok(!again.body.minted.some((m) => m.id === good));
});

// =============================================================== scanning
test('what the scanner reads comes back as the asset it is stuck to', async () => {
  const id = asset({ name: 'Pulse oximeter', purchase: '2026-07-20' });
  const { code } = codes.mint(id, { userId: 1 });

  const found = await api('GET', `/api/assets/scan/${encodeURIComponent(code)}`, undefined, 'nurse');
  assert.strictEqual(found.status, 200);
  assert.strictEqual(found.body.id, id);
  assert.strictEqual(found.body.name, 'Pulse oximeter');
  assert.strictEqual(found.body.branch_name, 'Melapalayam');

  // Lower case off a hand-typed label still finds it.
  assert.strictEqual((await api('GET', `/api/assets/scan/${code.toLowerCase()}`,
    undefined, 'nurse')).status, 200);

  const missing = await api('GET', '/api/assets/scan/SHC-NOPE-0126-MPM-001', undefined, 'nurse');
  assert.strictEqual(missing.status, 404);
  assert.match(missing.body.error, /carries/);
});

test('the register can be searched by the code on the sticker', async () => {
  const id = asset({ name: 'Dressing trolley', purchase: '2026-08-11' });
  const { code } = codes.mint(id, { userId: 1 });
  const res = await api('GET', `/api/assets?q=${encodeURIComponent(code)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.rows.length, 1);
  assert.strictEqual(res.body.rows[0].id, id);
});

// ========================================================== the store keeper
test('the store keeper keeps the register and the cupboard, and nothing else', async () => {
  // The register: read, add, code, label.
  assert.strictEqual((await api('GET', '/api/assets')).status, 200);
  const added = await api('POST', '/api/assets',
    { name: 'Mop bucket, wringer', category: 'Other', purchaseDate: '2026-09-03' });
  assert.strictEqual(added.status, 201, JSON.stringify(added.body));

  const minted = await api('POST', `/api/assets/${added.body.id}/code`, {});
  assert.strictEqual(minted.status, 201);
  assert.match(minted.body.code, /^SHC-[A-Z0-9]{2,6}-0926-MPM-\d{3}$/);

  // The consumables cupboard.
  assert.strictEqual((await api('GET', '/api/consumables')).status, 200);

  /*
   * And nothing clinical or financial. A store keeper has no business in a
   * patient record, which is the point of giving them an account of their
   * own rather than handing them the administrator's.
   */
  assert.strictEqual((await api('GET', '/api/patients')).status, 403);
  assert.strictEqual((await api('GET', '/api/billing/invoices')).status, 403);
  assert.strictEqual((await api('GET', '/api/visits/board')).status, 403);
});

test('who may mint a code, and who may only look', async () => {
  const id = asset({ name: 'Weighing scale', purchase: '2026-10-01' });

  // Reception can read the register — the equipment they use is their
  // business — but does not label it.
  assert.strictEqual((await api('GET', `/api/assets/${id}`, undefined, 'reception')).status, 200);
  assert.strictEqual((await api('POST', `/api/assets/${id}/code`, {}, 'reception')).status, 403);

  // The branches are the clinic's structure, so they are admin's.
  assert.strictEqual((await api('POST', '/api/assets/branches',
    { code: 'XX', name: 'Nowhere' }, 'store')).status, 403);
  assert.strictEqual((await api('POST', '/api/assets/branches',
    { code: 'TN', name: 'Tenkasi' }, 'admin')).status, 201);

  assert.strictEqual((await api('POST', `/api/assets/${id}/code`, {}, 'store')).status, 201);
});

test('a branch code is letters, and two branches cannot share one', async () => {
  const bad = await api('POST', '/api/assets/branches', { code: 'M1', name: 'Bad' }, 'admin');
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /two to four letters/);

  const clash = await api('POST', '/api/assets/branches',
    { code: 'MPM', name: 'Another Melapalayam' }, 'admin');
  assert.strictEqual(clash.status, 409);
});

// ============================================================ the item list
test('an item code suggested once is reused, not re-invented', async () => {
  // A thing the clinic has never bought, so the first answer is a fresh one.
  const first = await api('GET', '/api/assets/item-codes/suggest?name=Fetal%20doppler');
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.known, false);
  const suggested = first.body.code;

  codes.mint(asset({ name: 'Fetal doppler', purchase: '2026-03-01' }), { userId: 1 });

  const second = await api('GET', '/api/assets/item-codes/suggest?name=Fetal%20doppler%20—%20pocket%20model');
  assert.strictEqual(second.body.code, suggested, 'the same letters come back');
  assert.strictEqual(second.body.known, true, 'and it says the clinic already uses them');
});

test('the clinic can overrule the suggestion, and the list keeps its answer', () => {
  const id = asset({ name: 'Electrocardiograph', purchase: '2026-03-01' });
  const { code, item } = codes.mint(id, { userId: 1, itemCode: 'ECG' });
  assert.strictEqual(item.code, 'ECG');
  assert.match(code, /^SHC-ECG-0326-MPM-001$/);

  const next = codes.mint(asset({ name: 'Electrocardiograph', purchase: '2026-03-01' }), { userId: 1 });
  assert.strictEqual(next.code, 'SHC-ECG-0326-MPM-002',
    'the next one follows the clinic\'s code, not the suggestion');
});
