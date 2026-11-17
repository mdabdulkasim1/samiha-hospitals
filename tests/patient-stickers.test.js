'use strict';
/**
 * The two stickers a patient record prints.
 *
 * One goes on the cover of the paper file, one goes on the tube. Both are
 * the same sort of thing: a small piece of paper that leaves the computer
 * and is then the only record anybody has in their hand. What is wrong on
 * it stays wrong, because nobody opens the file again to check the label
 * on the file.
 *
 * So these tests are about content rather than looks. The UHID has to be
 * on the sticker whole — a file number ending in an ellipsis is a file
 * nobody can find. The barcode has to carry the UHID and nothing else. The
 * name on a tube must be the patient's name and not a courtesy title and
 * three dots. And the S/o · D/o · W/o line, which is what tells two
 * patients of the same name apart at a counter, has to survive the round
 * trip from the registration form.
 *
 * The sticker code runs in the browser, so it is loaded here into a plain
 * sandbox with the few helpers it uses stubbed. That is enough to assert
 * what ends up on the paper.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-stk-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');

let server;
let base;
const tokens = {};
const ids = {};

async function api(method, p, body, as = 'reception') {
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

/**
 * The sticker module, loaded the way the browser loads it.
 *
 * Only the handful of helpers it actually calls are stubbed, and the real
 * barcode renderer is loaded beside it — the one thing on the sample
 * sticker that cannot be checked by eye is what the bars say.
 */
function loadStickers() {
  const sandbox = {
    window: {},
    UI: {
      esc: (s) => String(s === null || s === undefined ? '' : s)
        .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      titleise: (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase()),
      date: (s) => `D(${s})`,
      dateShort: (s) => `d(${s})`,
      err: () => {},
      field: () => '',
      modal: () => {},
      print: (html, title) => { sandbox.printed = { html, title }; },
    },
  };
  sandbox.window.UI = sandbox.UI;
  vm.createContext(sandbox);
  for (const file of ['public/js/barcode.js', 'public/js/stickers.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox, { filename: file });
  }
  sandbox.Barcode = sandbox.window.Barcode;
  sandbox.Stickers = sandbox.window.Stickers;
  return sandbox;
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['reception', 'nurse', 'admin']) {
    tokens[who] = (await api('POST', '/api/auth/login',
      { username: `${who}@samiha.local`, password: 'samiha@123' }, null)).body.token;
  }

  const made = await api('POST', '/api/patients', {
    title: 'Mrs.', firstName: 'Ayesha', lastName: 'Begum', gender: 'female', age: 34,
    phone: '9876543210', guardianRelation: 'W/o', guardianName: 'Mohamed Rafiq',
    address: '14, Nethaji Road, Melapalayam', city: 'Tirunelveli', pincode: '627005',
    consentTreatment: true,
  });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  ids.patient = made.body.id;
  ids.uhid = made.body.uhid;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------- the field behind it
test('S/o · D/o · W/o survives the round trip from the form', async () => {
  const p = (await api('GET', `/api/patients/${ids.patient}`)).body;
  assert.strictEqual(p.guardian_relation, 'W/o');
  assert.strictEqual(p.guardian_name, 'Mohamed Rafiq');

  // It is one of three things, not free text: a sticker reading
  // "Spouse Mohamed Rafiq" is not the line an Indian file carries.
  const wrong = await api('PATCH', `/api/patients/${ids.patient}`, { guardianRelation: 'Spouse' });
  assert.strictEqual(wrong.status, 400);
  assert.match(wrong.body.error, /guardianRelation/);

  const changed = await api('PATCH', `/api/patients/${ids.patient}`,
    { guardianRelation: 'D/o', guardianName: 'Abdul Kareem' });
  assert.strictEqual(changed.status, 200);
  assert.strictEqual((await api('GET', `/api/patients/${ids.patient}`)).body.guardian_relation, 'D/o');

  await api('PATCH', `/api/patients/${ids.patient}`,
    { guardianRelation: 'W/o', guardianName: 'Mohamed Rafiq' });
});

// ------------------------------------------------------------- the file label
test('the file sticker carries what the clinic\'s own design asks for', async () => {
  const p = (await api('GET', `/api/patients/${ids.patient}`)).body;
  const { Stickers } = loadStickers();
  const html = Stickers.fileSticker(p);

  assert.ok(html.includes(ids.uhid), 'the UHID, whole');
  assert.ok(!/SPD\d+…|SPD\d+\.\.\./.test(html), 'and never cut short');
  assert.ok(html.includes('SAMIHA HEALTHCARE'), 'the clinic badge');
  assert.ok(html.includes('Mrs. Ayesha Begum'), 'the name as the file is labelled');
  assert.ok(html.includes('>34<'), 'the age');
  assert.ok(html.includes('Female'), 'and the sex');
  assert.ok(html.includes('W/o Mohamed Rafiq'), 'the line that tells two Ayeshas apart');
  assert.ok(html.includes('9876543210'), 'the mobile');
  assert.ok(html.includes('S/o · D/o · W/o'), 'with the field labels of the clinic\'s design');
  assert.ok(html.includes('Reg. Date'));
});

test('the address uses both lines rather than ending in three dots', async () => {
  const p = (await api('GET', `/api/patients/${ids.patient}`)).body;
  const { Stickers } = loadStickers();
  const html = Stickers.fileSticker(p);

  assert.ok(html.includes('14, Nethaji Road, Melapalayam'), 'the street on the first line');
  assert.ok(html.includes('Tirunelveli, 627005'), 'and the town and PIN on the second');
  assert.ok(!html.includes('…'), 'nothing is elided');
});

test('a record with gaps prints the blanks rather than the word undefined', async () => {
  const bare = (await api('POST', '/api/patients', {
    firstName: 'Rafeek', gender: 'male', phone: '9000000077', consentTreatment: true,
  })).body;
  const p = (await api('GET', `/api/patients/${bare.id}`)).body;
  const { Stickers } = loadStickers();
  const html = Stickers.fileSticker(p);

  assert.ok(html.includes(p.uhid));
  assert.ok(html.includes('Rafeek'));
  assert.ok(!/undefined|null|NaN/.test(html),
    'an empty field is an empty line to write on, not the word "undefined"');
});

// ----------------------------------------------------------- the tube label
test('the sample sticker carries the name, age, mobile and a barcode of the UHID', async () => {
  const p = (await api('GET', `/api/patients/${ids.patient}`)).body;
  const { Stickers, Barcode } = loadStickers();
  const html = Stickers.sampleSticker(p, {});

  assert.ok(html.includes('Ayesha Begum'), 'the name');
  assert.ok(!html.includes('Mrs.'), 'without the courtesy title — a tube has 50 mm, not a greeting');
  assert.ok(html.includes('34 yrs'), 'the age');
  assert.ok(html.includes('Female'));
  assert.ok(html.includes('9876543210'), 'the mobile');
  assert.ok(html.includes(ids.uhid), 'and the UHID in words under the bars');

  /*
   * The bars themselves. What a scanner reads has to be the UHID exactly —
   * a sample that scans as something else is worse than one that does not
   * scan at all, because the second gets checked by hand.
   */
  assert.ok(html.includes('<svg'), 'there is a barcode');
  const expected = Barcode.svg(p.uhid, { module: 1.6, height: 34, showText: false });
  assert.ok(html.includes(expected.slice(expected.indexOf('<g fill'), expected.indexOf('</g>'))),
    'and the bars are the UHID, not the name or the row id');
});

test('the barcode is Code 128 of the UHID and of nothing else', () => {
  const { Barcode } = loadStickers();
  const values = Barcode.encode('SPD26000006');

  // Start-B, the characters, the modulo-103 check, and the stop.
  assert.strictEqual(values[0], 104, 'starts in code set B');
  assert.strictEqual(values[values.length - 1], 106, 'and ends with the stop pattern');
  assert.strictEqual(values.length, 'SPD26000006'.length + 3);
  const payload = values.slice(1, -2).map((v) => String.fromCharCode(v + 32)).join('');
  assert.strictEqual(payload, 'SPD26000006', 'the bars say the UHID');

  let sum = 104;
  payload.split('').forEach((ch, i) => { sum += (ch.charCodeAt(0) - 32) * (i + 1); });
  assert.strictEqual(values[values.length - 2], sum % 103, 'with the checksum a scanner verifies');
});

test('printing asks for its own page size and no watermark over the bars', async () => {
  const p = (await api('GET', `/api/patients/${ids.patient}`)).body;
  const box = loadStickers();
  box.Stickers.print('sample', p, { copies: 3 });

  const { html, title } = box.printed;
  assert.match(title, new RegExp(ids.uhid));
  assert.ok(html.includes('@page { size: 50mm 25mm; margin: 0; }'),
    'the label prints at the size of the label');
  assert.strictEqual((html.match(/class="sticker sample"/g) || []).length, 3, 'three tubes, three stickers');

  box.Stickers.print('file', p, { copies: 1 });
  assert.ok(box.printed.html.includes('@page { size: 100mm 65mm; margin: 0; }'));

  /*
   * The watermark is off and the application stylesheet is left out. Either
   * one printed across a barcode costs the scanner reads it exists to make,
   * and app.css carries an @page rule that would quietly resize the label.
   */
  const call = [];
  box.UI.print = (h, t, opts) => call.push(opts);
  box.Stickers.print('sample', p, {});
  assert.strictEqual(call[0].watermark, false);
  assert.strictEqual(call[0].standalone, true);
});

test('more than forty copies is a jammed printer, not an order', async () => {
  const p = (await api('GET', `/api/patients/${ids.patient}`)).body;
  const box = loadStickers();
  box.Stickers.print('sample', p, { copies: 500 });
  assert.strictEqual((box.printed.html.match(/class="sticker sample"/g) || []).length, 40);
});
