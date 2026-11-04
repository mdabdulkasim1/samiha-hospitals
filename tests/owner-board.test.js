'use strict';
/**
 * The owner's board: the arithmetic, and the door.
 *
 * Two things are worth testing about a page like this, and the second is the
 * one that would matter at three in the morning.
 *
 * The arithmetic, because the whole point of the board is the difference
 * between money that arrived and money that was invoiced. A clinic that adds
 * its unpaid bills into its revenue will believe it is profitable for about
 * as long as it takes the bank to disagree. So the fixture below deliberately
 * leaves part of a bill unpaid and asserts that the unpaid part turns up as
 * what the clinic is owed and nowhere near the sale.
 *
 * The door, because this is the one screen in the system an administrator
 * does not reach. Everywhere else an admin passes every gate, on purpose —
 * a short-staffed polyclinic needs one account that can work any desk. Here
 * the gate is requireOwner, and the test that it holds for 'admin' is the
 * test that the whole design is real rather than a hidden menu item.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-board-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');

let server;
let base;
const tokens = {};

async function api(method, p, body, as = 'owner') {
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

/*
 * A trading day built by hand, because every figure on the board has to be
 * checkable against one. The seed ships no invoices, payments, counter sales
 * or cash book at all, so this day is the only thing in its window and the
 * totals are arithmetic rather than approximately-right.
 *
 *   billed       600   a 1,000 consultation bill, 600 of it actually paid
 *   counter      250   five packs over the counter, bought in at 30 each
 *   otherIncome  100   something banked that was not a patient
 *   ------------------
 *   sale         950
 *
 *   expense      400   rent, out of the cash book
 *   medicines    150   5 × 30, the real purchase price of the real packs
 *   ------------------
 *   cost         550   leaving 400 of profit on 950 taken — 42.1%
 *
 * And 400 of that bill was never paid, so it belongs in what the clinic is
 * owed and in none of the above.
 */
const DAY = '2026-03-10';
const NEXT = '2026-03-11';

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['counselor', 'counselor@samiha.local'],
    ['cashier', 'cashier@samiha.local'], ['nurse', 'nurse@samiha.local'],
    ['pharmacy', 'pharmacy@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }

  const made = await api('POST', '/api/masters/staff', {
    name: 'The owner', role: 'owner', email: 'owner@samiha.local', password: 'Samiha#2026',
  }, 'admin');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const signin = await api('POST', '/api/auth/login',
    { username: 'owner@samiha.local', password: 'Samiha#2026' }, null);
  assert.strictEqual(signin.status, 200);
  tokens.owner = signin.body.token;

  const doctor = db.prepare("SELECT id, department_id FROM users WHERE role = 'doctor' AND active = 1").get();
  const drug = db.prepare('SELECT id, name FROM drugs LIMIT 1').get();

  db.prepare(`INSERT INTO visits (visit_no, patient_id, doctor_id, department_id, arrived_at)
              VALUES ('BOARD-V1', 1, ?, ?, ?), ('BOARD-V2', 2, ?, ?, ?)`)
    .run(doctor.id, doctor.department_id, `${DAY} 10:00:00`,
      doctor.id, doctor.department_id, `${DAY} 11:00:00`);
  const visit = db.prepare("SELECT id FROM visits WHERE visit_no = 'BOARD-V1'").get().id;

  db.prepare(`INSERT INTO invoices (invoice_no, patient_id, visit_id, kind, status,
                gross, net, paid, balance, created_at)
              VALUES ('BOARD-I1', 1, ?, 'opd', 'partial', 1000, 1000, 600, 400, ?)`)
    .run(visit, `${DAY} 12:00:00`);
  const invoice = db.prepare("SELECT id FROM invoices WHERE invoice_no = 'BOARD-I1'").get().id;
  db.prepare(`INSERT INTO invoice_items (invoice_id, ref_type, description, qty, unit_price, amount)
              VALUES (?, 'consultation', 'Consultation', 1, 1000, 1000)`).run(invoice);
  db.prepare(`INSERT INTO payments (receipt_no, invoice_id, patient_id, amount, mode, paid_at)
              VALUES ('BOARD-R1', ?, 1, 600, 'cash', ?)`).run(invoice, `${DAY} 12:05:00`);

  db.prepare(`INSERT INTO drug_batches (drug_id, batch_no, expiry_date, qty_received,
                qty_available, mrp, purchase_price)
              VALUES (?, 'BOARD-B1', '2027-12-31', 50, 45, 50, 30)`).run(drug.id);
  const batch = db.prepare("SELECT id FROM drug_batches WHERE batch_no = 'BOARD-B1'").get().id;

  const sale = (billNo, at, paid) => {
    db.prepare(`INSERT INTO pharmacy_sales (bill_no, sale_type, paid_amount, gross, net,
                  status, created_at)
                VALUES (?, 'counter', ?, ?, ?, 'billed', ?)`).run(billNo, paid, paid, paid, at);
    return db.prepare('SELECT id FROM pharmacy_sales WHERE bill_no = ?').get(billNo).id;
  };
  const line = (saleId, batchId, qty, amount) => db.prepare(
    `INSERT INTO pharmacy_sale_items (sale_id, drug_id, batch_id, drug_name, qty, mrp, amount)
     VALUES (?, ?, ?, ?, ?, 50, ?)`).run(saleId, drug.id, batchId, drug.name, qty, amount);

  line(sale('BOARD-P1', `${DAY} 13:00:00`, 250), batch, 5, 250);

  /*
   * The day after carries a line dispensed from a batch that predates the
   * stock ledger — no purchase price to join to. It contributes nothing to
   * cost rather than a guess, which understates the cost of sale, so the
   * board has to say so. That caveat is what the second window tests.
   */
  line(sale('BOARD-P2', `${NEXT} 09:00:00`, 400), null, 4, 400);

  db.prepare(`INSERT INTO cash_book (ref_no, direction, category, amount, entry_date, mode)
              VALUES ('BOARD-C1', 'in', 'Other income', 100, ?, 'cash'),
                     ('BOARD-C2', 'out', 'Rent', 400, ?, 'cash')`).run(DAY, DAY);
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const board = (q) => api('GET', `/api/owner/overview${q}`, undefined, 'owner');

// -------------------------------------------------------------------- the door
test('the board is the owner\'s, and the administrator does not bypass it', async () => {
  assert.strictEqual((await board('')).status, 200);

  /*
   * Admin is the case that matters, and it is first in the list for that
   * reason: everywhere else in this system an administrator passes, so a
   * regression here would look like the rest of the app working normally.
   */
  for (const who of ['admin', 'counselor', 'cashier', 'nurse', 'pharmacy']) {
    const r = await api('GET', '/api/owner/overview', undefined, who);
    assert.strictEqual(r.status, 403, `${who} must not reach the owner's board`);
  }
  // And signed out is not a way in either.
  assert.strictEqual((await api('GET', '/api/owner/overview', undefined, null)).status, 401);
});

// -------------------------------------------------------------- the arithmetic
test('sale is money that arrived, and cost is money that left', async () => {
  const r = await board(`?by=day&from=${DAY}&to=${DAY}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const t = r.body.totals;

  assert.strictEqual(t.billed, 600, 'the payment taken, not the bill raised');
  assert.strictEqual(t.counter, 250);
  assert.strictEqual(t.otherIncome, 100);
  assert.strictEqual(t.sale, 950);

  assert.strictEqual(t.expense, 400);
  assert.strictEqual(t.medicineCost, 150, '5 packs bought in at 30');
  assert.strictEqual(t.cost, 550);

  assert.strictEqual(t.profit, 400);
  assert.strictEqual(t.margin, 42.1);
  assert.strictEqual(t.visits, 2);
  assert.strictEqual(t.perVisit, 475);

  // The day is one bucket, and the bucket agrees with the totals.
  assert.strictEqual(r.body.points.length, 1);
  assert.strictEqual(r.body.points[0].at, DAY);
  assert.strictEqual(r.body.points[0].profit, 400);
});

test('the 400 nobody paid is what the clinic is owed, and is not revenue', async () => {
  const r = await board(`?by=day&from=${DAY}&to=${DAY}`);
  assert.strictEqual(r.body.totals.sale, 950, 'a 1,000 bill, 600 paid — the sale is 600 of it');
  assert.strictEqual(r.body.position.outstanding, 400);
  assert.strictEqual(r.body.position.outstandingBills, 1);

  /*
   * What sells is a different question from what was collected, and it is
   * answered off the bill on purpose: the owner wants to know that
   * consultations are what the clinic does, whether or not that bill has
   * been settled yet.
   */
  assert.deepStrictEqual(r.body.byCategory.map((c) => [c.category, c.amount]),
    [['consultation', 1000]]);
  assert.deepStrictEqual(r.body.spend.map((c) => [c.category, c.amount]), [['Rent', 400]]);
});

test('the medicine counter quotes a real margin, and owns up when it cannot', async () => {
  const good = (await board(`?by=day&from=${DAY}&to=${DAY}`)).body.pharmacy;
  assert.strictEqual(good.sold, 250);
  assert.strictEqual(good.cost, 150);
  assert.strictEqual(good.gross, 100);
  assert.strictEqual(good.margin, 40);
  assert.strictEqual(good.unpriced_lines, 0, 'every pack sold that day had a price on it');

  /*
   * The next day's line has no batch to cost against. The margin it reports
   * is therefore too good, and the number that lets the screen say so is
   * unpriced_lines — without it the board would quietly claim a 100% margin.
   */
  const thin = (await board(`?by=day&from=${NEXT}&to=${NEXT}`)).body.pharmacy;
  assert.strictEqual(thin.sold, 400);
  assert.strictEqual(thin.cost, 0);
  assert.strictEqual(thin.unpriced_lines, 1);
  assert.strictEqual(thin.lines, 1);
});

test('the doctor rows count visits once, however many bills hang off them', async () => {
  /*
   * A visit with two invoices against it must still be one visit. The join
   * that produces this table fans out across invoices, so COUNT(DISTINCT) is
   * not decoration — without it a busy doctor's visit count climbs with the
   * clinic's billing habits.
   */
  const visit = db.prepare("SELECT id FROM visits WHERE visit_no = 'BOARD-V1'").get().id;
  db.prepare(`INSERT INTO invoices (invoice_no, patient_id, visit_id, kind, status,
                gross, net, paid, balance, created_at)
              VALUES ('BOARD-I2', 1, ?, 'pharmacy', 'paid', 250, 250, 250, 0, ?)`)
    .run(visit, `${DAY} 13:30:00`);

  const rows = (await board(`?by=day&from=${DAY}&to=${DAY}`)).body.byDoctor;
  assert.strictEqual(rows.length, 1, 'only the doctor who saw somebody');
  assert.strictEqual(rows[0].visits, 2);
  assert.strictEqual(rows[0].billed, 1250, 'both bills, each counted once');

  db.prepare("DELETE FROM invoices WHERE invoice_no = 'BOARD-I2'").run();
});

test('two bills for the same amount are two bills', async () => {
  /*
   * The regression this pins down was SUM(DISTINCT i.net), which looks like a
   * sensible companion to the DISTINCT the visit count genuinely needs and is
   * not: it drops the second of any two bills that come to the same figure.
   * At a clinic with one consultation fee, that is almost every pair.
   */
  const second = db.prepare("SELECT id FROM visits WHERE visit_no = 'BOARD-V2'").get().id;
  db.prepare(`INSERT INTO invoices (invoice_no, patient_id, visit_id, kind, status,
                gross, net, paid, balance, created_at)
              VALUES ('BOARD-I3', 2, ?, 'opd', 'paid', 1000, 1000, 1000, 0, ?)`)
    .run(second, `${DAY} 14:00:00`);

  const rows = (await board(`?by=day&from=${DAY}&to=${DAY}`)).body.byDoctor;
  assert.strictEqual(rows[0].visits, 2, 'still two visits');
  assert.strictEqual(rows[0].billed, 2000, 'two 1,000 bills are 2,000, not 1,000');

  db.prepare("DELETE FROM invoices WHERE invoice_no = 'BOARD-I3'").run();
});

test('a cancelled sale and a voided entry leave the board alone', async () => {
  db.prepare("UPDATE pharmacy_sales SET status = 'cancelled' WHERE bill_no = 'BOARD-P1'").run();
  db.prepare("UPDATE cash_book SET voided_at = datetime('now') WHERE ref_no = 'BOARD-C2'").run();

  const t = (await board(`?by=day&from=${DAY}&to=${DAY}`)).body.totals;
  assert.strictEqual(t.counter, 0, 'a cancelled counter sale is not a sale');
  assert.strictEqual(t.medicineCost, 0, 'and its packs are not a cost of sale');
  assert.strictEqual(t.expense, 0, 'a voided cash-book entry is not money that left');
  assert.strictEqual(t.sale, 700, 'what is left is the 600 collected and the 100 banked');

  db.prepare("UPDATE pharmacy_sales SET status = 'billed' WHERE bill_no = 'BOARD-P1'").run();
  db.prepare("UPDATE cash_book SET voided_at = NULL WHERE ref_no = 'BOARD-C2'").run();
});

test('the period can be cut by week or by month, and asks for nothing else', async () => {
  for (const by of ['day', 'week', 'month']) {
    const r = await board(`?by=${by}`);
    assert.strictEqual(r.status, 200, by);
    assert.strictEqual(r.body.by, by);
  }
  const bad = await board('?by=quarter');
  assert.strictEqual(bad.status, 400);

  // A month cut puts the whole of March in one bucket beginning on the 1st.
  const march = await board('?by=month&from=2026-03-01&to=2026-03-31');
  const bucket = march.body.points.find((p) => p.at === '2026-03-01');
  assert.ok(bucket, 'March is one bucket');
  assert.strictEqual(bucket.billed, 600);
  assert.strictEqual(bucket.counter, 650, 'both counter sales in the month');
});
