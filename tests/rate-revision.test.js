'use strict';
/**
 * The November diagnostic revision, and the two ways a price change goes
 * wrong in a clinic.
 *
 * A rate card is published once and then revised, and both of those have to
 * land on a database that is already running. The danger is never the
 * arithmetic — it is that a sheet marked up a fortnight ago silently
 * overwrites a price somebody changed yesterday, and the front desk starts
 * quoting a figure the owner retired. So a revision is a three-way merge: a
 * rate moves only while it still stands at the figure the revision was
 * written against, and anything else is kept and reported.
 *
 * The other danger is a fresh install drifting away from the live clinic. A
 * new database runs the September card and then every revision in order, and
 * has to arrive at precisely the prices the clinic that has been open all
 * along is charging. The test for that is the whole sheet, line by line.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-rates-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const rates = require('../src/db/rates');
const catalogue = require('../src/db/catalogue');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/*
 * The sheet, as the owner marked it up. Written out here rather than
 * imported from the source so the test is an independent statement of what
 * the paper says: if somebody edits the revision list, this disagrees.
 *
 * The 17 with no new rate were ticked or left blank and keep what they had —
 * which is the instruction that came with the sheet, and the easiest thing
 * in a repricing to get wrong in the quiet direction.
 */
const SHEET = {
  HCV: [400, 200], BLGRP: [90, 30], UREA: [55, 70], CRP: [225, 250], CL: [120, 120],
  CBC: [110, 200], DENGUE: [700, 1200], ESR: [35, 35], FBS: [60, 30], HBA1C: [400, 300],
  HBSAG: [250, 200], HIV: [300, 200], HB: [60, 50], IRONPROF: [650, 500], LIPID: [145, 300],
  LFT: [200, 350], 'LFT-ADV': [350, 350], MP: [200, 200], PAP: [450, 450], PLT: [80, 100],
  PPBS: [60, 30], PREG: [450, 450], PSA: [550, 550], PT: [300, 250], RBS: [50, 30],
  RFT: [135, 200], 'RFT-GFR': [250, 250], SEMEN: [300, 300], CALC: [90, 200], CREAT: [110, 70],
  ELEC: [300, 450], URIC: [90, 90], NA: [120, 120], TESTO: [550, 550], TSH: [90, 150],
  THYP: [135, 350], VDRL: [150, 250], VITB12: [675, 500], VITD: [720, 800], WIDAL: [180, 180],
  SPUTUM: [150, 200], STOCC: [150, 250], STOOL: [120, 200], URINE: [90, 50],
  URCULT: [450, 250], UPREG: [100, 50],
  // ECG & heart: the owner left every box blank.
  ECHO: [1250, 1250], ECG12: [150, 150], HOLTER: [2500, 2500], TMT: [1250, 1250],
};

const priceOf = (code) => {
  const row = db.prepare('SELECT price FROM lab_tests WHERE code = ?').get(code);
  return row ? Math.round(row.price) : null;
};

test('a fresh install arrives at exactly the rates on the marked-up sheet', () => {
  /*
   * The seed above ran the September card and then the November revision.
   * Every line of the sheet is checked, including the ones that did not
   * move — a revision that quietly drags an untouched price along with it is
   * the failure nobody notices until a patient is charged for it.
   */
  for (const [code, [, want]] of Object.entries(SHEET)) {
    assert.strictEqual(priceOf(code), want, `${code} should be ${want}`);
  }
});

test('the revision lists only what changed, and matches the sheet', () => {
  const rev = rates.REVISIONS.find((r) => r.key === 'tariff.2026_11_diagnostics');
  assert.ok(rev, 'the November revision is on file');

  const changed = Object.entries(SHEET).filter(([, [was, now]]) => was !== now);
  assert.strictEqual(rev.rates.length, changed.length,
    `${changed.length} lines were marked up on the sheet`);

  for (const [code, was, now] of rev.rates) {
    assert.ok(SHEET[code], `${code} is on the sheet`);
    assert.strictEqual(was, SHEET[code][0], `${code} was printed at ${SHEET[code][0]}`);
    assert.strictEqual(now, SHEET[code][1], `${code} was marked up to ${SHEET[code][1]}`);
  }
  // And nothing is restated as moving from its own price to its own price.
  assert.ok(!rev.rates.some(([, was, now]) => was === now),
    'a no-op line in a tariff is one somebody will later read as a decision');
});

test('a price the clinic has since set by hand is kept, not overwritten', () => {
  /*
   * The case this whole mechanism exists for. The sheet was marked up on
   * paper; between then and the deploy, somebody may have repriced a test at
   * the desk. The revision must leave that alone — and say that it did,
   * because a silently ignored line and a silently applied one look the same
   * on a boot log that reports neither.
   */
  db.prepare('UPDATE lab_tests SET price = 275 WHERE code = ?').run('CBC');
  db.prepare('DELETE FROM settings WHERE key = ?').run('tariff.2026_11_diagnostics');

  const [report] = rates.applyRevisions(db);
  assert.ok(report, 'the revision ran again once its marker was cleared');

  assert.strictEqual(priceOf('CBC'), 275, 'the hand-set price stands');
  const kept = report.kept.find((k) => k.code === 'CBC');
  assert.ok(kept, 'and it is reported as kept rather than passed over in silence');
  assert.strictEqual(kept.at, 275);
  assert.strictEqual(kept.wanted, 200);

  // Everything else still moved, so one edited row does not stall the rest.
  assert.strictEqual(priceOf('DENGUE'), 1200);
  assert.ok(report.already > 0, 'rates already at the new figure are counted, not re-set');

  db.prepare('UPDATE lab_tests SET price = 200 WHERE code = ?').run('CBC');
});

test('a revision runs once and is then history', () => {
  const before = rates.applyRevisions(db);
  assert.deepStrictEqual(before, [], 'nothing to do — its marker is in settings');

  /*
   * Re-running it would undo whatever the clinic decided afterwards, which
   * is the opposite of what a dated revision means. Prove it by moving a
   * price and syncing: the catalogue must not drag it back.
   */
  db.prepare('UPDATE lab_tests SET price = 999 WHERE code = ?').run('VITD');
  catalogue.sync({ quiet: true });
  assert.strictEqual(priceOf('VITD'), 999, 'the clinic is the authority on its own prices');

  db.prepare('UPDATE lab_tests SET price = 800 WHERE code = ?').run('VITD');
});

test('repricing a test does not disturb bills already raised', () => {
  /*
   * An order carries the price it was charged at. If repricing reached back
   * into history, every past invoice would quietly restate itself and the
   * month's revenue would change after the books were read.
   */
  const test_ = db.prepare("SELECT id, price FROM lab_tests WHERE code = 'CBC'").get();
  db.prepare(`INSERT INTO lab_orders (order_no, patient_id, status)
              VALUES ('RATE-O1', 1, 'ordered')`).run();
  const order = db.prepare("SELECT id FROM lab_orders WHERE order_no = 'RATE-O1'").get().id;
  db.prepare(`INSERT INTO lab_order_items (order_id, test_id, test_name, price)
              VALUES (?, ?, 'Complete Blood Count', ?)`).run(order, test_.id, test_.price);

  db.prepare('UPDATE lab_tests SET price = 450 WHERE code = ?').run('CBC');
  const line = db.prepare('SELECT price FROM lab_order_items WHERE order_id = ?').get(order);
  assert.strictEqual(line.price, test_.price, 'the order keeps what it was charged');

  db.prepare('UPDATE lab_tests SET price = 200 WHERE code = ?').run('CBC');
});

test('the revision touches diagnostics only, and leaves the rest of the card alone', () => {
  /*
   * The sheet was two pages of a seven-page list. Everything not on those
   * pages — consultations, procedures, the other four pages of diagnostics —
   * must be exactly where the September card left it.
   */
  const rev = rates.REVISIONS.find((r) => r.key === 'tariff.2026_11_diagnostics');
  const touched = new Set(rev.rates.map(([code]) => code));

  for (const [code, was] of rates.TARIFF.map(([c, , now]) => [c, now])) {
    if (touched.has(code)) continue;
    const row = db.prepare(
      `SELECT price FROM services WHERE code = ?
       UNION ALL SELECT price FROM lab_tests WHERE code = ?`).get(code, code);
    if (!row) continue;
    assert.strictEqual(Math.round(row.price), was,
      `${code} is not on the sheet and should still be at its September rate`);
  }
});
