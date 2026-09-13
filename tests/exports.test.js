'use strict';
/**
 * Downloading the department's data as a workbook.
 *
 * The point of most of this file is one idea: a download is not a lesser kind
 * of screen. Every rule about who may see money holds in the file too, because
 * a rule enforced in the browser and not in the export is not a rule — it is
 * an inconvenience, and the way round it is a button marked "Download".
 *
 * The workbook itself is checked by unzipping it and reading the XML back, so
 * "it opens" means the bytes are a real spreadsheet rather than that the route
 * returned two hundred.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-export-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_DIR = path.join(tmp, 'backups');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
const app = require('../src/server');
const xlsx = require('../src/lib/xlsx');

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

/** Fetch a workbook and hand back its bytes plus the response headers. */
async function book(p, as) {
  const res = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${tokens[as]}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, headers: res.headers };
}

/*
 * A minimal unzip, so the test reads the workbook the way a spreadsheet would
 * rather than trusting the writer to describe itself. Walks the central
 * directory, which is the only part whose offsets can be relied on.
 */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0, 'the file has a zip end-of-directory record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i += 1) {
    assert.strictEqual(buf.readUInt32LE(at), 0x02014b50, 'central directory entry');
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.slice(at + 46, at + 46 + nameLen).toString('utf8');

    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compressed);
    files[name] = method === 8 ? zlib.inflateRawSync(raw).toString('utf8') : raw.toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const sheetNames = (files) =>
  [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);

/** Every inline string and number in a sheet, as text — enough to search. */
const textOf = (files, index) =>
  (files[`xl/worksheets/sheet${index}.xml`] || '')
    .replace(/<[^>]+>/g, ' ');

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['cashier', 'cashier@samiha.local'], ['lab', 'lab@samiha.local'],
    ['pharmacy', 'pharmacy@samiha.local'], ['doctor', 'imran@samiha.local'],
    ['nurse', 'nurse@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------- the workbook
test('the writer produces a file a spreadsheet can actually open', () => {
  const buf = xlsx.build([
    xlsx.fromRows('Numbers', [{ name: 'One & <two>', qty: 3, ok: true, blank: null }]),
  ]);
  assert.strictEqual(buf.slice(0, 2).toString(), 'PK', 'it is a zip');

  const files = unzip(buf);
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files[part], `${part} is in the package`);
  }
  assert.deepStrictEqual(sheetNames(files), ['Numbers']);

  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /One &amp; &lt;two&gt;/, 'text is escaped, not mangled');
  assert.match(sheet, /<c r="B2"><v>3<\/v><\/c>/, 'a number stays a number the sheet can add up');
  assert.match(sheet, /t="b"><v>1</, 'and a yes stays a boolean');
});

test('a sheet name Excel would refuse is made into one it accepts', () => {
  const files = unzip(xlsx.build([
    { name: 'Bill/Lines: 2026 [final] — a very long name indeed', columns: ['a'], rows: [['x']] },
    { name: '', columns: ['a'], rows: [['y']] },
  ]));
  const names = sheetNames(files);
  assert.ok(names[0].length <= 31, 'trimmed to the limit');
  assert.ok(!/[[\]:*?/\\]/.test(names[0]), 'and stripped of what is not allowed');
  assert.ok(names[1], 'a nameless sheet still gets a name');
});

// ------------------------------------------------------------ the downloads
test('each department is offered its own book and no one else\'s', async () => {
  const mine = (await api('GET', '/api/exports', undefined, 'pharmacy')).body;
  assert.deepStrictEqual(mine.departments.map((d) => d.key), ['pharmacy']);
  assert.strictEqual(mine.full, false, 'the whole-clinic book is not theirs');

  const boss = (await api('GET', '/api/exports', undefined, 'admin')).body;
  assert.ok(boss.departments.length >= 8, 'the admin is offered every department');
  assert.strictEqual(boss.full, true);

  // And asking for somebody else's directly is refused, not merely un-offered.
  assert.strictEqual((await book('/api/exports/cashier.xlsx', 'pharmacy')).status, 403);
  assert.strictEqual((await book('/api/exports/full/backup.xlsx', 'cashier')).status, 403);
  assert.strictEqual((await book('/api/exports/nonesuch.xlsx', 'admin')).status, 404);
});

test('a department download is a real workbook, named and typed for the browser', async () => {
  const res = await book('/api/exports/pharmacy.xlsx', 'pharmacy');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml\.sheet/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename=".*pharmacy.*\.xlsx"/);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');

  const files = unzip(res.buf);
  const names = sheetNames(files);
  assert.ok(names.includes('Formulary'), `expected the shelf, got ${names.join(', ')}`);
  assert.ok(names.includes('Stock movements'));
  assert.match(textOf(files, 1), /Paracetamol/i, 'with the medicines actually in it');
});

// --------------------------------------------- the rules hold in the file too
test('the lab\'s book carries the tests and none of the prices', async () => {
  const asLab = unzip((await book('/api/exports/lab.xlsx', 'lab')).buf);
  const asCashier = unzip((await book('/api/exports/lab.xlsx', 'admin')).buf);

  const labOrders = textOf(asLab, 1);
  assert.match(labOrders, /order_no/, 'the orders are there');
  assert.ok(!/\bamount\b/.test(labOrders), 'and the money column is gone, not blanked');

  // The same sheet, downloaded by somebody who may see prices, still has it.
  assert.match(textOf(asCashier, 1), /\bamount\b/,
    'so the column was withheld from the role, not dropped from the query');

  const catalogue = textOf(asLab, 3);
  assert.match(catalogue, /sample_type/, 'the bench gets the whole catalogue');
  assert.ok(!/\bprice\b/.test(catalogue), 'priced for somebody else');
});

test('a doctor\'s book carries the care and none of the takings', async () => {
  const files = unzip((await book('/api/exports/doctor.xlsx', 'doctor')).buf);
  const names = sheetNames(files);
  assert.deepStrictEqual(names, ['Consultations', 'Prescriptions', 'Notes on file']);

  const everything = names.map((_, i) => textOf(files, i + 1)).join(' ');
  for (const money of ['amount', 'net', 'paid', 'balance', 'price', 'unit_price']) {
    assert.ok(!new RegExp(`\\b${money}\\b`).test(everything),
      `a doctor's export must not carry a "${money}" column`);
  }
  assert.match(textOf(files, 1), /assessment/, 'but it does carry the clinical note');
});

test('the cashier\'s book carries the money, because it is the cashier\'s', async () => {
  const files = unzip((await book('/api/exports/cashier.xlsx', 'cashier')).buf);
  assert.ok(sheetNames(files).includes('Receipts'));
  const invoices = textOf(files, 1);
  assert.match(invoices, /\bbalance\b/);
  assert.match(invoices, /invoice_no/);
});

test('a sheet with nothing in it yet still says what its columns are', async () => {
  // The clinic downloading its book on a quiet morning gets headings, not a
  // blank tab. SQLite names the columns of a SELECT that matched nothing.
  const dept = require('../src/services/exports').department('cashier', { role: 'cashier' });
  const empty = dept.sheets.filter((s) => s.rows.length === 0);
  assert.ok(empty.length, 'this fixture has at least one sheet with no rows');
  for (const s of empty) {
    assert.ok(s.columns.length, `"${s.name}" is empty but should still be headed`);
  }

  const files = unzip((await book('/api/exports/cashier.xlsx', 'cashier')).buf);
  const i = dept.sheets.findIndex((s) => s.name === empty[0].name) + 1;
  assert.match(textOf(files, i), new RegExp(`\\b${empty[0].columns[0]}\\b`),
    'and the headings reach the file');
});

// ------------------------------------------------------------- the full book
test('the administrator\'s book is the whole clinic, and only theirs', async () => {
  const res = await book('/api/exports/full/backup.xlsx', 'admin');
  assert.strictEqual(res.status, 200);
  const names = sheetNames(unzip(res.buf));

  assert.ok(names.length >= 25, `expected every department, got ${names.length} sheets`);
  assert.ok(names.some((n) => n.startsWith('Front office')));
  assert.ok(names.some((n) => n.startsWith('Pharmacy')));
  assert.ok(names.includes('Audit log'), 'the audit log is in this book');
  assert.ok(names.includes('Staff'), 'and the staff list');
  assert.ok(names.every((n) => n.length <= 31), 'every tab name is one Excel accepts');

  // Neither of those appears in any department's own book.
  for (const dept of ['pharmacy', 'cashier', 'reception']) {
    const own = sheetNames(unzip((await book(`/api/exports/${dept}.xlsx`, 'admin')).buf));
    assert.ok(!own.includes('Audit log'), `${dept} does not take the audit log home`);
    assert.ok(!own.includes('Staff'));
  }
});

test('the weekly book is written to the backup folder and listed with the rest', async () => {
  const made = await api('POST', '/api/admin/backups/workbook', {}, 'admin');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.match(made.body.filename, /^samiha-full-.*\.xlsx$/);
  assert.ok(made.body.sheets >= 25);

  const onDisk = path.join(process.env.BACKUP_DIR, made.body.filename);
  assert.ok(fs.existsSync(onDisk), 'it is actually on the disk');
  assert.ok(sheetNames(unzip(fs.readFileSync(onDisk))).includes('Audit log'));

  const listed = (await api('GET', '/api/admin/backups', undefined, 'admin')).body;
  const row = listed.rows.find((r) => r.filename === made.body.filename);
  assert.ok(row, 'and listed beside the database snapshots');
  assert.strictEqual(row.status, 'ok');
  assert.strictEqual(row.onDisk, true);

  // Downloadable through the same route as any other backup.
  const res = await fetch(`${base}/api/admin/backups/${made.body.filename}/download`,
    { headers: { Authorization: `Bearer ${tokens.admin}` } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(Buffer.from(await res.arrayBuffer()).slice(0, 2).toString(), 'PK');
});

test('building one is the administrator\'s alone', async () => {
  for (const as of ['cashier', 'pharmacy', 'doctor', 'reception']) {
    assert.strictEqual((await api('POST', '/api/admin/backups/workbook', {}, as)).status, 403);
  }
});

test('every download is written to the audit log', async () => {
  await book('/api/exports/reception.xlsx', 'reception');
  const { db } = require('../src/db');
  const row = db.prepare(
    "SELECT * FROM audit_logs WHERE action = 'export' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.ok(row, 'a workbook leaving the building is an event somebody can ask about');
  const detail = JSON.parse(row.details);
  assert.strictEqual(detail.what, 'reception');
  assert.ok(detail.bytes > 0 && detail.sheets > 0);
});
