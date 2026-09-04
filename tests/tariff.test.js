'use strict';
/**
 * The rate card, and how it reaches a clinic that is already running.
 *
 * Two things are being checked. First that applying the tariff is a merge and
 * not an overwrite: a rate an administrator has set by hand outlives every
 * deploy, because the alternative — a restart quietly resetting the prices
 * somebody agreed with a patient — is the kind of bug nobody reports and
 * everybody stops trusting the system over.
 *
 * Second that the catalogue reaches an install that has been running for
 * months. Seeding happens once, when there are no accounts; a clinic six
 * months in never sees it again. Without a sync on boot, every test the
 * department starts doing and every rate card agreed after go-live would sit
 * in the repository and never reach the people using it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-tariff-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
const { db } = require('../src/db');
const { TARIFF, apply } = require('../src/db/rates');
const catalogue = require('../src/db/catalogue');

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const priceOf = (code) => {
  const row = db.prepare('SELECT price FROM services WHERE code = ?').get(code)
    || db.prepare('SELECT price FROM lab_tests WHERE code = ?').get(code);
  return row ? row.price : null;
};

test('the rate card is one row per item, and every row is a real one', () => {
  assert.ok(TARIFF.length >= 250, `expected the clinic's whole list, got ${TARIFF.length}`);

  const codes = TARIFF.map((r) => r[0]);
  assert.strictEqual(new Set(codes).size, codes.length, 'no code is priced twice');

  for (const [code, was, now] of TARIFF) {
    assert.ok(typeof code === 'string' && code.length, 'every row names an item');
    assert.ok(was >= 0 && now >= 0, `${code}: rates are not negative`);
    assert.ok(now > 0, `${code}: every item on the card carries a rate`);
    assert.notStrictEqual(priceOf(code), null, `${code} is a real catalogue item`);
  }
});

test('seeding leaves nothing in the catalogue unpriced', () => {
  const services = db.prepare('SELECT COUNT(*) AS c FROM services WHERE COALESCE(price,0) = 0').get().c;
  const tests = db.prepare('SELECT COUNT(*) AS c FROM lab_tests WHERE COALESCE(price,0) = 0').get().c;
  assert.strictEqual(services, 0, 'every service the clinic does has a rate');
  assert.strictEqual(tests, 0, 'and so does every test it measures');

  // Spot-checks against the printed card, so a mangled import is caught.
  assert.strictEqual(priceOf('CONS-NEW'), 150);
  assert.strictEqual(priceOf('CONS-FU'), 100);
  assert.strictEqual(priceOf('CBC'), 110);
  assert.strictEqual(priceOf('XR-CHEST'), 225);
  assert.strictEqual(priceOf('PKG-MAN'), 299);
});

test('a rate the clinic set by hand survives the tariff being applied again', () => {
  const before = priceOf('CBC');
  db.prepare("UPDATE lab_tests SET price = 999 WHERE code = 'CBC'").run();

  // Re-publishing the card revalues what is untouched and keeps what is not.
  const report = apply(db, { revalue: true });
  assert.strictEqual(priceOf('CBC'), 999, 'the clinic\'s own figure stands');
  assert.ok(report.kept.some((k) => k.code === 'CBC'), 'and is reported as kept, not lost');
  assert.strictEqual(report.updated, 0, 'nothing else moved — it was all already right');

  db.prepare('UPDATE lab_tests SET price = ? WHERE code = ?').run(before, 'CBC');
});

test('once published, the card only fills in what has no rate at all', () => {
  // A test the department started doing after the card was agreed.
  const id = db.prepare(
    `INSERT INTO lab_tests (code, name, category, bill_group, price, tat_hours)
     VALUES ('LATE-ADD', 'Started after the tariff', 'lab', 'Blood tests', 0, 24)`
  ).run().lastInsertRowid;

  // A rate deliberately put back to what the card was published at. Living
  // with the card must not treat that as "untouched" and move it on.
  const cons = TARIFF.find((r) => r[0] === 'CONS-NEW');
  db.prepare("UPDATE services SET price = ? WHERE code = 'CONS-NEW'").run(cons[1]);

  apply(db, { revalue: false });
  assert.strictEqual(priceOf('CONS-NEW'), cons[1],
    'a rate the clinic typed is theirs, even when it matches the old card');

  db.prepare('DELETE FROM lab_tests WHERE id = ?').run(id);
  db.prepare("UPDATE services SET price = ? WHERE code = 'CONS-NEW'").run(cons[2]);
});

test('a clinic already running receives a catalogue it never seeded', () => {
  // Wind one back to look like an install from before the diagnostics were
  // loaded: the panels and the radiology list simply are not there.
  const gone = db.prepare(
    "DELETE FROM lab_tests WHERE code IN ('CBC-HB', 'XR-ANKLE', 'PKG-DIAB')"
  ).run().changes;
  assert.strictEqual(gone, 3);

  const report = catalogue.sync({ quiet: true });
  assert.strictEqual(report.added.tests, 3, 'the missing tests arrive');
  assert.strictEqual(priceOf('CBC-HB'), 60, 'priced from the card');
  assert.ok(priceOf('XR-ANKLE') > 0);
  assert.ok(priceOf('PKG-DIAB') > 0);

  // And a second boot changes nothing at all.
  const again = catalogue.sync({ quiet: true });
  assert.strictEqual(again.added.tests, 0);
  assert.strictEqual(again.added.services, 0);
  assert.strictEqual(again.tariff.updated, 0);
});

test('syncing the catalogue does not disturb what the clinic owns', () => {
  const beds = db.prepare('SELECT COUNT(*) AS c FROM beds').get().c;
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const drugs = db.prepare('SELECT COUNT(*) AS c FROM drugs').get().c;
  const stock = db.prepare('SELECT COALESCE(SUM(qty_available),0) AS q FROM drug_batches').get().q;
  const patients = db.prepare('SELECT COUNT(*) AS c FROM patients').get().c;

  catalogue.sync({ quiet: true });

  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM beds').get().c, beds);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, users);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM drugs').get().c, drugs);
  assert.strictEqual(db.prepare('SELECT COALESCE(SUM(qty_available),0) AS q FROM drug_batches').get().q, stock,
    'no stock moves because the app restarted');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM patients').get().c, patients);
});

test('the consultation fee comes off the rate card, not the doctor\'s profile', () => {
  /*
   * This was the hole the card fell through. The commonest line on every bill
   * was priced from doctor_profiles, which the card never touched — so a
   * clinic that had just published "new consultation, 150" went on billing
   * whatever figure had sat on that doctor since the day they were set up.
   */
  const card = db.prepare("SELECT price FROM services WHERE code = 'CONS-NEW'").get().price;
  const followUp = db.prepare("SELECT price FROM services WHERE code = 'CONS-FU'").get().price;
  assert.strictEqual(card, 150);
  assert.strictEqual(followUp, 100);

  const fees = db.prepare('SELECT consult_fee, follow_up_fee FROM doctor_profiles').all();
  assert.ok(fees.length, 'the seed has doctors');
  assert.ok(fees.every((f) => f.consult_fee <= card),
    'no doctor is quoted above the published card');
  assert.ok(fees.every((f) => f.follow_up_fee <= followUp));
});

test('publishing a card never raises a fee, and leaves a lower one alone', () => {
  const one = db.prepare('SELECT user_id FROM doctor_profiles LIMIT 1').get().user_id;
  db.prepare('UPDATE doctor_profiles SET consult_fee = 80, follow_up_fee = 60 WHERE user_id = ?').run(one);

  // Re-publishing: the guard is "higher than the card", so 80 stays 80.
  db.prepare("DELETE FROM settings WHERE key = 'tariff.2026_09'").run();
  catalogue.sync({ quiet: true });

  const after = db.prepare('SELECT consult_fee, follow_up_fee FROM doctor_profiles WHERE user_id = ?').get(one);
  assert.strictEqual(after.consult_fee, 80, 'a doctor priced below the card keeps their figure');
  assert.strictEqual(after.follow_up_fee, 60);
});
