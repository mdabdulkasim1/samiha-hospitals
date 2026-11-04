'use strict';
/**
 * Adopting the Manitham imaging card.
 *
 * Replacing a live catalogue is the most destructive thing done to this
 * system so far, and the tests are about what must survive it rather than
 * about the arithmetic.
 *
 * Nothing is deleted. A report issued last year names the study it was
 * issued for, and that name has to keep resolving — so the 86 studies this
 * replaces are switched off, not removed.
 *
 * Nothing is left dangling. Six health packages list an imaging study among
 * their contents; those entries are repointed at the card's equivalent
 * before the old study goes dark. A package whose contents resolve to
 * nothing is a package the laboratory cannot work from.
 *
 * And nothing appears twice. The whole reason for replacing rather than
 * merging is that two naming schemes on one order form means two prices for
 * the same film.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-imaging-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const imaging = require('../src/db/imaging');
const catalogue = require('../src/db/catalogue');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const row = (code) => db.prepare('SELECT * FROM lab_tests WHERE code = ?').get(code);

test('the card is loaded at its rate times 1.2, throughout', () => {
  assert.strictEqual(imaging.IMAGING.length, 167);
  for (const t of imaging.IMAGING) {
    assert.strictEqual(t.price, Math.round(t.rate * 1.2), `${t.code} is its card rate x 1.2`);
    const r = row(t.code);
    assert.ok(r, `${t.code} is on the catalogue`);
    assert.strictEqual(r.price, t.price);
    assert.strictEqual(r.active, 1);
    assert.strictEqual(r.category, 'radiology');
  }
});

test('the card rate is kept, because it is the cost of every one of these', () => {
  /*
   * These films are read by a radiologist the clinic pays. Without the card
   * rate beside the price, imaging would look like pure margin on the
   * owner's board forever.
   */
  for (const t of imaging.IMAGING) {
    assert.ok(t.rate > 0, `${t.code} carries the rate it came from`);
  }
});

test('the studies it replaces are switched off, never deleted', () => {
  assert.strictEqual(imaging.RETIRED.length, 78);
  for (const code of imaging.RETIRED) {
    const r = row(code);
    assert.ok(r, `${code} still exists — a past report names it`);
    assert.strictEqual(r.active, 0, `${code} is off the order form`);
  }

  // And a study that is off is genuinely off everywhere the clinic looks.
  const live = db.prepare(
    `SELECT COUNT(*) AS c FROM lab_tests
      WHERE active = 1 AND bill_group IN ('X-ray', 'Ultrasound & Doppler')`).get().c;
  assert.strictEqual(live, 167 + imaging.KEPT.length,
    'the card, plus the studies it has no line for');
});

test('every health package still resolves to tests that exist and are live', () => {
  /*
   * The failure this guards against is silent: the package still sells, the
   * bill still prints, and the laboratory receives a request for a study
   * that is no longer on anybody's list.
   */
  const broken = db.prepare(
    `SELECT pi.package_code, pi.test_code
       FROM lab_package_items pi
       LEFT JOIN lab_tests t ON t.code = pi.test_code
      WHERE t.id IS NULL OR t.active = 0`).all();
  assert.deepStrictEqual(broken, [], 'no package points at a missing or retired study');

  // The four that were repointed now name the card's study.
  for (const [from, to] of Object.entries(imaging.PACKAGE_REMAP)) {
    const stale = db.prepare(
      'SELECT COUNT(*) AS c FROM lab_package_items WHERE test_code = ?').get(from).c;
    assert.strictEqual(stale, 0, `no package still points at ${from}`);
    assert.ok(row(to), `${to} is the study they point at now`);
  }
});

test('the two studies the card prices twice are loaded once, at the chosen rate', () => {
  /*
   * Chest PA appears at 200 and at 450, abdomen-pelvis at 1000 and 2000.
   * Loading both would put the same film on the order form at two prices,
   * which is exactly what replacing the catalogue was meant to prevent.
   */
  const byName = (n) => imaging.IMAGING.filter((t) => t.name.toLowerCase() === n);
  const chest = byName('x-ray chest pa');
  assert.strictEqual(chest.length, 1, 'chest PA is on the card once');
  assert.strictEqual(chest[0].rate, 450, 'at the higher of the two rates');
  assert.strictEqual(chest[0].price, 540);

  const abdo = byName('us abdomen pelvis');
  assert.strictEqual(abdo.length, 1);
  assert.strictEqual(abdo[0].rate, 2000);
  assert.strictEqual(abdo[0].price, 2400);
});

test('no two studies share a code, and none collides with what was there', () => {
  const codes = imaging.IMAGING.map((t) => t.code);
  assert.strictEqual(new Set(codes).size, codes.length, 'the card has no duplicate codes');
  for (const code of codes) {
    assert.ok(!imaging.RETIRED.includes(code),
      `${code} is new, not one of the studies being switched off`);
  }
  const all = db.prepare('SELECT code FROM lab_tests').all().map((r) => r.code);
  assert.strictEqual(new Set(all).size, all.length, 'the catalogue has no duplicate codes');
});

test('adopting the card again changes nothing', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM lab_tests').get().c;
  const again = imaging.load(db);
  assert.strictEqual(again.added, 0);
  assert.strictEqual(again.switchedOff, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM lab_tests').get().c, before);

  /*
   * And a price the clinic has since set on one of these is its own. The
   * card is adopted once; after that the clinic is the authority.
   */
  db.prepare("UPDATE lab_tests SET price = 1234 WHERE code = 'XR-CHESTPA'").run();
  catalogue.sync({ quiet: true });
  assert.strictEqual(row('XR-CHESTPA').price, 1234);
  db.prepare("UPDATE lab_tests SET price = 540 WHERE code = 'XR-CHESTPA'").run();

  // A study the clinic switches back on stays on.
  db.prepare("UPDATE lab_tests SET active = 1 WHERE code = 'XR-DENT'").run();
  catalogue.sync({ quiet: true });
  assert.strictEqual(row('XR-DENT').active, 1,
    'the clinic may keep a retired study if it still does it');
  db.prepare("UPDATE lab_tests SET active = 0 WHERE code = 'XR-DENT'").run();
});

test('imaging revenue still lands in the right department', () => {
  /*
   * The owner's department board splits revenue by the category on the test.
   * If the card had loaded as 'lab' these films would have reported as
   * laboratory work and the X-ray department would have looked empty.
   */
  const wrong = db.prepare(
    `SELECT COUNT(*) AS c FROM lab_tests
      WHERE active = 1 AND bill_group IN ('X-ray', 'Ultrasound & Doppler')
        AND category != 'radiology'`).get().c;
  assert.strictEqual(wrong, 0);
});
