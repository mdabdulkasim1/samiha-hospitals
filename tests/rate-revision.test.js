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
   * The seed above ran the September card and then both November revisions.
   * Every line the owner wrote a figure against is checked here — a
   * revision that quietly drags a marked price somewhere else is the failure
   * nobody notices until a patient is charged for it.
   *
   * The lines left blank are deliberately not checked against the sheet:
   * the second revision priced some of them from the referral lab's trade
   * list, which is what it was for. The test above holds those.
   */
  const marked = Object.entries(SHEET).filter(([, [was, now]]) => was !== now);
  assert.strictEqual(marked.length, 33, 'the owner marked 33 lines');
  for (const [code, [, want]] of marked) {
    assert.strictEqual(priceOf(code), want, `${code} should be ${want}`);
  }

  /*
   * The four the trade list could not settle were not guessed at: they were
   * put to the clinic and answered, and the answers are checked in their own
   * test below. What matters here is that they moved by a decision and not
   * by a default.
   */
  for (const code of ['WIDAL', 'MP', 'PAP', 'LFT-ADV']) {
    assert.notStrictEqual(priceOf(code), SHEET[code][1],
      `${code} was settled by the clinic, not left at the sheet's figure`);
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

/*
 * The second November revision: the tests the sheet left unmarked, priced at
 * twice the referral laboratory's trade rate.
 *
 * The instruction that came with it was "whatever was already updated, keep
 * the same rate" — so the thing worth testing is not the arithmetic but the
 * restraint. Doubling the trade rate would have moved almost every price the
 * owner had just set by hand, and in both directions: the sheet puts TSH at
 * 150 where twice trade is 120, and Vitamin D at 800 where twice trade is
 * 1200. A revision that quietly overwrote those would have undone the
 * owner's own decisions a day after they were made.
 */
const X2 = {
  CL: 200, NA: 200, PREG: 500, PSA: 500, TESTO: 600, URIC: 160, SEMEN: 300,
};
const UNTOUCHED = {
  // Marked on the sheet, so twice-trade does not apply however much it differs.
  TSH: 150, VITD: 800, CBC: 200, HBA1C: 300, URINE: 50, CREAT: 70,
  // Nothing on the B2B list corresponds to these at all.
  ESR: 35, 'RFT-GFR': 250,
};

test('the tests the sheet left unmarked are priced at twice the trade rate', () => {
  for (const [code, want] of Object.entries(X2)) {
    assert.strictEqual(priceOf(code), want, `${code} should be ${want}`);
  }
});

test('a price the owner set last week is not overwritten by a trade list', () => {
  for (const [code, want] of Object.entries(UNTOUCHED)) {
    assert.strictEqual(priceOf(code), want,
      `${code} should still be ${want} — the sheet or the absence of a match decides it`);
  }

  /*
   * Spelled out for the two that would have moved furthest, because this is
   * the whole point of the restraint and a future edit could quietly lose it.
   */
  const rev = rates.REVISIONS.find((r) => r.key === 'tariff.2026_11_sendout_x2');
  const codes = rev.rates.map(([c]) => c);
  assert.ok(!codes.includes('TSH'), 'TSH is not in the twice-trade list (would be 120, is 150)');
  assert.ok(!codes.includes('VITD'), 'Vitamin D is not in it either (would be 1200, is 800)');
});

test('a match that only looks right is left out', () => {
  /*
   * Matching on names alone put "SERUM BILIRUBIN" onto the urine bilirubin
   * analyte and "Total Protein" onto urine protein — both blood tests
   * mapped onto a dipstick reading. Nothing in the revision rests on a
   * matched name: every line names the B2B row it came from in a comment,
   * and anything that needed judgement was left for the clinic.
   */
  const rev = rates.REVISIONS.find((r) => r.key === 'tariff.2026_11_sendout_x2');
  assert.strictEqual(rev.rates.length, Object.keys(X2).length,
    'only the exact matches are in the list');
  for (const [, was, now] of rev.rates) {
    assert.ok(was > 0 && now > 0, 'every line carries both figures');
  }
});

/* ------------------------------------------------ the send-out menu */

test('the four the trade list could not settle are what the clinic chose', () => {
  /*
   * None of these could be inferred. The trade list priced Widal twice
   * (slide and tube), malaria three ways, and a Pap in two different
   * sections; the clinic said which it sells. The figures are here so that
   * the answers are on the record rather than in a conversation.
   */
  assert.strictEqual(priceOf('WIDAL'), 300, 'tube method, 150 x 2');
  assert.strictEqual(priceOf('MP'), 400, 'MP of smear, 200 x 2');
  assert.strictEqual(priceOf('PAP'), 900, 'the whole test, 450 x 2');
  assert.strictEqual(priceOf('LFT-ADV'), 600, 'the advanced panel, 300 x 2');

  // And the advanced panel now sits above the plain one, which is the point
  // of the clinic carrying both.
  assert.ok(priceOf('LFT-ADV') > priceOf('LFT'));
});

test('the referral laboratory\'s menu is loaded, at twice trade throughout', () => {
  const { SENDOUT } = require('../src/db/sendout');
  assert.ok(SENDOUT.length > 150, `${SENDOUT.length} send-out tests`);

  for (const t of SENDOUT) {
    assert.strictEqual(t.price, t.trade * 2, `${t.code} is twice its trade rate`);
    assert.ok(t.trade > 0, `${t.code} carries the trade rate it came from`);
    assert.strictEqual(priceOf(t.code), t.price, `${t.code} is on the catalogue at ${t.price}`);
  }
});

test('the send-out menu keeps the cost of every line it added', () => {
  /*
   * The trade rate is not kept for sentiment. It is the cost of sale for
   * every one of these, and the only thing that makes the margin on
   * send-out work knowable — the department board can read it the day
   * somebody wires it up. A list of prices with no costs behind it would
   * have made send-out work look like pure margin forever.
   */
  const { SENDOUT } = require('../src/db/sendout');
  assert.ok(SENDOUT.every((t) => typeof t.trade === 'number' && t.trade > 0));
});

test('nothing was added twice under a second name', () => {
  const codes = db.prepare('SELECT code FROM lab_tests').all().map((r) => r.code);
  assert.strictEqual(new Set(codes).size, codes.length, 'codes are unique');

  /*
   * The real risk is not a duplicate code but a duplicate test: the same
   * thing on the order form twice at two prices. Seven trade rows turned
   * out to be analytes the clinic already reports, and were repriced where
   * they stand rather than added beside themselves.
   */
  const { ANALYTE_REPRICE, SENDOUT } = require('../src/db/sendout');
  const added = new Set(SENDOUT.map((t) => t.name.toLowerCase()));
  for (const r of ANALYTE_REPRICE) {
    const existing = db.prepare('SELECT name, price FROM lab_tests WHERE code = ?').get(r.code);
    assert.ok(existing, `${r.code} is the row that was repriced`);
    assert.strictEqual(existing.price, r.price);
    assert.ok(!added.has(existing.name.toLowerCase()),
      `${existing.name} was not also added as a new test`);
  }
});

test('loading the menu again adds nothing', () => {
  const sendout = require('../src/db/sendout');
  const before = db.prepare('SELECT COUNT(*) AS c FROM lab_tests').get().c;
  const again = sendout.load(db);
  assert.strictEqual(again.added, 0, 'every one was already there');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM lab_tests').get().c, before);

  /*
   * And a price the clinic has since changed on one of these is its own:
   * the loader inserts, it does not restate.
   */
  db.prepare("UPDATE lab_tests SET price = 4321 WHERE code = 'SO-AMYLASE'").run();
  sendout.load(db);
  assert.strictEqual(priceOf('SO-AMYLASE'), 4321);
  db.prepare("UPDATE lab_tests SET price = 200 WHERE code = 'SO-AMYLASE'").run();
});

test('every test the clinic offers carries a price', () => {
  // A test on the order form with no rate is one the cashier cannot bill.
  const unpriced = db.prepare(
    'SELECT code, name FROM lab_tests WHERE COALESCE(price, 0) = 0').all();
  assert.deepStrictEqual(unpriced, [], 'nothing on the catalogue is unpriced');
});

test('the revision touches diagnostics only, and leaves the rest of the card alone', () => {
  /*
   * The sheet was two pages of a seven-page list. Everything not on those
   * pages — consultations, procedures, the other four pages of diagnostics —
   * must be exactly where the September card left it.
   */
  const touched = new Set(rates.REVISIONS.flatMap((r) => r.rates.map(([code]) => code)));
  // and the analytes the referral list repriced where they stand
  for (const r of require('../src/db/sendout').ANALYTE_REPRICE) touched.add(r.code);

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
