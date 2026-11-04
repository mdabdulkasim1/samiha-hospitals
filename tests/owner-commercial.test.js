'use strict';
/**
 * The commercial eye, and the three ways a clinic's own profit statement lies
 * to it.
 *
 * Each of these has a test below, because each is a mistake that produces a
 * confident, specific, wrong number — which is worse than no number, since
 * nobody goes looking for the error behind a figure that looks fine.
 *
 *   Counting what was bought as what was used. Buy six months of stock in
 *   March and March looks like a disaster while August looks like a triumph.
 *   The fixture below buys 90,000 of medicines and dispenses 300 worth, and
 *   asserts the month is charged 300.
 *
 *   Counting what was invoiced as what was earned, or the other way about.
 *   Both are defensible; using one and labelling it the other is not. The
 *   department board is accrual and says so, and the test holds it to that
 *   with a bill nobody paid.
 *
 *   Charging a department for something it did not cause. Rent is not a cost
 *   of running a blood test. It is allocated, by a convention, and the test
 *   checks that contribution is struck before that allocation rather than
 *   after it.
 *
 * The rest is arithmetic — but arithmetic the owner will make decisions on,
 * so it is checked against figures worked out by hand rather than against
 * whatever the code happened to return the first time.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-ce-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');
const commercial = require('../src/lib/commercial');

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
 * One month, built by hand, every figure chosen so the answer can be worked
 * out on paper:
 *
 *   Consultations    12,000 billed, 3,000 of it discounted away →  9,000 net
 *                     4,000 paid out to the consultant
 *   Laboratory        6,000 billed (a blood test)
 *                     1,500 of reagents bought
 *   Imaging           5,000 billed (an X-ray and an ECG)
 *   Procedures        4,000 billed (a day-care procedure)
 *   Pharmacy          2,000 sold over the counter, bought in for 800
 *   -------------------------------------------------------------------
 *   Net revenue      26,000 billed + 1,000 camp income − 500 refunded
 *
 *   Direct costs      4,000 doctor + 1,500 reagents + 800 medicines = 6,300
 *   Overheads        10,000 rent (fixed) + 2,000 marketing (variable)
 *   And 90,000 of stock bought, which is not a cost of this month at all.
 */
const P = '2026-05';
const DAY = '2026-05-10';
const PREV = '2026-04';
let ids = {};

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['counselor', 'counselor@samiha.local'],
    ['cashier', 'cashier@samiha.local'], ['lab', 'lab@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, email);
    tokens[as] = r.body.token;
  }
  const made = await api('POST', '/api/masters/staff',
    { name: 'The owner', role: 'owner', email: 'owner@samiha.local', password: 'Samiha#2026' }, 'admin');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  tokens.owner = (await api('POST', '/api/auth/login',
    { username: 'owner@samiha.local', password: 'Samiha#2026' }, null)).body.token;

  // --- the things that were sold, each traceable to a department
  const test_ = (code, category) => {
    db.prepare(`INSERT INTO lab_tests (code, name, category, price)
                VALUES (?, ?, ?, 0)`).run(code, `CE ${code}`, category);
    return db.prepare('SELECT id FROM lab_tests WHERE code = ?').get(code).id;
  };
  const bloodTest = test_('CE-BLOOD', 'lab');
  const xray = test_('CE-XRAY', 'radiology');
  const ecg = test_('CE-ECG', 'cardiology');
  const dayCare = test_('CE-PROC', 'procedure');

  db.prepare(`INSERT INTO lab_orders (order_no, patient_id, status)
              VALUES ('CE-O1', 1, 'ordered')`).run();
  const order = db.prepare("SELECT id FROM lab_orders WHERE order_no = 'CE-O1'").get().id;
  const orderItem = (testId, name, price) => {
    db.prepare(`INSERT INTO lab_order_items (order_id, test_id, test_name, price)
                VALUES (?, ?, ?, ?)`).run(order, testId, name, price);
    return db.prepare('SELECT MAX(id) AS id FROM lab_order_items').get().id;
  };
  ids = {
    blood: orderItem(bloodTest, 'Blood', 6000),
    xray: orderItem(xray, 'X-ray', 3000),
    ecg: orderItem(ecg, 'ECG', 2000),
    proc: orderItem(dayCare, 'Day care', 4000),
  };

  /*
   * One bill carrying every department, with a 3,000 concession against the
   * whole of it. The concession must land on the lines in proportion — a
   * bill-level discount charged entirely to whichever department is billed
   * first would make that department look like it loses money.
   */
  db.prepare(`INSERT INTO invoices (invoice_no, patient_id, kind, status,
                gross, net, paid, balance, sliding_discount, created_at)
              VALUES ('CE-I1', 1, 'opd', 'unpaid', 27000, 24000, 0, 24000, 3000, ?)`)
    .run(`${DAY} 10:00:00`);
  const inv = db.prepare("SELECT id FROM invoices WHERE invoice_no = 'CE-I1'").get().id;
  const line = (refType, refId, desc, amount) => db.prepare(
    `INSERT INTO invoice_items (invoice_id, ref_type, ref_id, description, qty, unit_price, amount)
     VALUES (?, ?, ?, ?, 1, ?, ?)`).run(inv, refType, refId, desc, amount, amount);
  line('consultation', 1, 'Consultation', 12000);
  line('lab', ids.blood, 'Blood', 6000);
  line('lab', ids.xray, 'X-ray', 3000);
  line('lab', ids.ecg, 'ECG', 2000);
  line('lab', ids.proc, 'Day care', 4000);

  // --- the counter, whose cost of sale is known exactly
  const drug = db.prepare('SELECT id, name FROM drugs LIMIT 1').get();
  db.prepare(`INSERT INTO drug_batches (drug_id, batch_no, expiry_date, qty_received,
                qty_available, mrp, purchase_price)
              VALUES (?, 'CE-B1', '2028-01-01', 100, 90, 200, 80)`).run(drug.id);
  const batch = db.prepare("SELECT id FROM drug_batches WHERE batch_no = 'CE-B1'").get().id;
  db.prepare(`INSERT INTO pharmacy_sales (bill_no, sale_type, paid_amount, gross, net, status, created_at)
              VALUES ('CE-P1', 'counter', 2000, 2000, 2000, 'billed', ?)`).run(`${DAY} 11:00:00`);
  const sale = db.prepare("SELECT id FROM pharmacy_sales WHERE bill_no = 'CE-P1'").get().id;
  db.prepare(`INSERT INTO pharmacy_sale_items (sale_id, drug_id, batch_id, drug_name, qty, mrp, amount)
              VALUES (?, ?, ?, ?, 10, 200, 2000)`).run(sale, drug.id, batch, drug.name);

  // Two packs expired. Avoidable, and therefore reported on its own.
  db.prepare(`INSERT INTO stock_ledger (drug_id, batch_id, txn_type, qty_delta, balance_after, created_at)
              VALUES (?, ?, 'expiry', -5, 85, ?)`).run(drug.id, batch, `${DAY} 12:00:00`);

  // --- the cash book
  const cb = (ref, dir, cat, amt, payee, notes) => db.prepare(
    `INSERT INTO cash_book (ref_no, direction, category, amount, entry_date, mode, payee, notes)
     VALUES (?, ?, ?, ?, ?, 'cash', ?, ?)`).run(ref, dir, cat, amt, DAY, payee || null, notes || null);
  cb('CE-C1', 'out', 'Doctor fees & honorarium', 4000);
  cb('CE-C2', 'out', 'Lab reagents & kits', 1500);
  cb('CE-C3', 'out', 'Rent', 10000);
  cb('CE-C4', 'out', 'Marketing & camps', 2000);
  cb('CE-C5', 'out', 'Medicines & consumables', 90000, 'Distributor', 'six months of stock');
  cb('CE-C6', 'out', 'Equipment purchase', 50000, 'Supplier');
  cb('CE-C7', 'out', 'Refund to patient', 500);
  cb('CE-C8', 'in', 'Health camp collection', 1000);
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const board = () => commercial.departmentBoard(commercial.monthStart(P), commercial.monthEnd(P));
const dept = (key) => board().rows.find((r) => r.key === key);

// ------------------------------------------------------------------- the door
test('the commercial eye is the owner\'s, and the administrator does not bypass it', async () => {
  assert.strictEqual((await api('GET', `/api/owner/commercial?period=${P}`)).status, 200);
  for (const who of ['admin', 'counselor', 'cashier', 'lab']) {
    for (const p of [`/api/owner/commercial?period=${P}`, `/api/owner/budget/${P}`, '/api/owner/actions']) {
      assert.strictEqual((await api('GET', p, undefined, who)).status, 403, `${who} ${p}`);
    }
    assert.strictEqual((await api('PUT', `/api/owner/budget/${P}`,
      { budget: { payroll: 1 } }, who)).status, 403, who);
    assert.strictEqual((await api('POST', '/api/owner/actions',
      { finding: 'x', action: 'y', responsible: 'z' }, who)).status, 403, who);
  }
});

// ------------------------------------------------- purchased is not consumed
test('buying six months of stock is not a cost of this month', () => {
  const c = commercial.comparison(P);
  const row = (k) => c.rows.find((r) => r.key === k);

  /*
   * 90,000 of medicines was bought and 800 worth was dispensed. The month is
   * charged 800 for medicines and 1,500 for reagents — the reagent line is
   * purchases because reagents are not stock-counted, and the screen says so.
   */
  assert.strictEqual(row('medicinesConsumed').actual, 2300,
    '800 of packs that left the shelf, plus 1,500 of reagents that cannot be counted');

  // The 90,000 and the 50,000 machine are reported, but as cash flow.
  assert.strictEqual(c.basis.purchases, 140000);
  assert.match(c.basis.purchasesNote, /not a cost of the period/i);

  /*
   * And the proof that it stayed out: 90,000 of stock against this month's
   * revenue would have turned a profit into a very large loss.
   */
  assert.ok(row('profitBeforeTax').actual > 0,
    'the month is profitable; it only looks otherwise if purchases are miscounted as costs');
});

test('a machine bought this month reaches the profit as depreciation, not as a cost', () => {
  const c = commercial.comparison(P);
  const lines = c.rows.map((r) => r.key);
  assert.ok(!lines.includes('equipment'), 'there is no capital line in a profit statement');
  // It does depreciate, though — over its life, once it is on the register.
  const dep = commercial.depreciation('2026-05-01', '2026-05-31');
  assert.ok(dep.amount >= 0);
  assert.ok(dep.assets >= 0);
});

// ---------------------------------------------------- billed is not collected
test('an unpaid bill is still revenue earned, and the board says which it is using', async () => {
  // Nothing on the fixture invoice was paid at all.
  assert.strictEqual(db.prepare("SELECT paid FROM invoices WHERE invoice_no = 'CE-I1'").get().paid, 0);
  assert.ok(board().totals.revenue > 0, 'an unpaid bill is earned revenue on an accrual board');

  const c = commercial.comparison(P);
  assert.match(c.basis.revenue, /earned and billed/i);
  assert.match(c.basis.revenue, /not what was collected/i);

  /*
   * The distinction is the whole point of having both boards: the headline
   * overview counts money that arrived and must NOT agree with this one
   * while a bill is outstanding.
   */
  const collected = (await api('GET', `/api/owner/overview?by=month&from=2026-05-01&to=2026-05-31`)).body;
  assert.notStrictEqual(collected.totals.sale, c.rows.find((r) => r.key === 'netRevenue').actual);
});

// ---------------------------------------------------- the department mapping
test('a scan is not a blood test, and a day-care case is neither', () => {
  /*
   * All four came through the same lab order and the same bill. What
   * separates them is the category on the test, and if that join is wrong
   * every department figure on the page is wrong together — which is the
   * sort of error that looks like no error at all.
   */
  const net = (gross) => Math.round(gross * (24000 / 27000) * 100) / 100;

  assert.strictEqual(dept('laboratory').revenue, net(6000), 'the blood test alone');
  assert.strictEqual(dept('imaging').revenue, net(5000), 'the X-ray and the ECG together');
  assert.strictEqual(dept('procedures').revenue, net(4000), 'the day-care procedure');
  assert.strictEqual(dept('consultation').revenue, net(12000));
});

test('a discount on the whole bill is shared out over the lines that earned it', () => {
  /*
   * 27,000 of lines, 3,000 conceded, so every line keeps 8/9 of itself. The
   * failure this guards against is charging the lot to line one: the
   * consultation would read 9,000 instead of 10,666 and look unprofitable
   * while every other department looked better than it was.
   */
  const rows = board().rows;
  const billed = rows.reduce((t, r) => t + r.revenue, 0) - dept('pharmacy').revenue;
  assert.strictEqual(Math.round(billed), 24000, 'the lines add back to the discounted bill');
  assert.strictEqual(dept('consultation').revenue, 10666.67,
    'the consultation keeps eight ninths of itself, not all of the concession');
});

// ------------------------------------------------------ direct is not overhead
test('contribution is struck before the rent, and operating profit after it', () => {
  const lab = dept('laboratory');
  // Reagents are the laboratory's own cost; the rent is not.
  assert.strictEqual(lab.direct, 1500);
  assert.strictEqual(lab.contribution, Math.round((lab.revenue - 1500) * 100) / 100);
  assert.ok(lab.allocated > 0, 'it still carries a share of the overheads');
  assert.strictEqual(lab.operatingProfit, Math.round((lab.contribution - lab.allocated) * 100) / 100);

  const b = board();
  assert.match(b.overhead.basis, /proportion to revenue/i);
  // The whole of the shared cost is spread and none of it is lost.
  const spread = b.rows.reduce((t, r) => t + r.allocated, 0);
  assert.ok(Math.abs(spread - b.totals.allocated) < 0.5, 'every rupee of overhead lands somewhere');
});

test('the pharmacy is costed from the batch, not from the purchase invoice', () => {
  const ph = dept('pharmacy');
  assert.strictEqual(ph.revenue, 2000);
  assert.strictEqual(ph.direct, 800, '10 packs bought in at 80');
  assert.strictEqual(ph.contribution, 1200);
  assert.strictEqual(ph.margin, 60);
  // And the 90,000 purchase invoice is nowhere near it.
  assert.ok(ph.direct < 1000);
});

test('a department with no cost recorded says so rather than claiming a perfect margin', () => {
  const img = dept('imaging');
  assert.strictEqual(img.direct, 0);
  assert.strictEqual(img.exact, false);
  assert.ok(img.caveats.some((c) => /no direct cost is recorded/i.test(c)),
    'a 100% margin with nothing behind it has to carry a warning');
});

test('stock written off is counted at what it cost, from the ledger', () => {
  const w = commercial.wastage('2026-05-01', '2026-05-31');
  assert.strictEqual(w.expired, 400, '5 packs that cost 80 each');
  assert.strictEqual(w.total, 400);
});

// -------------------------------------------------- outsourced work, once only
test('referral-lab work is counted on its own line and not again inside another', () => {
  db.prepare(
    `INSERT INTO cash_book (ref_no, direction, category, amount, entry_date, mode, payee, notes)
     VALUES ('CE-OS', 'out', 'Lab reagents & kits', 700, ?, 'cash', 'Referral lab', 'outsourced histopath')`
  ).run(DAY);

  const c = commercial.comparison(P);
  const row = (k) => c.rows.find((r) => r.key === k).actual;
  assert.strictEqual(row('outsourced'), 700);
  /*
   * The bug this pins down: the 700 was booked under reagents, so pulling it
   * onto its own line without netting it off reagents charged the month
   * twice for the same payment.
   */
  assert.strictEqual(row('medicinesConsumed'), 2300,
    'the reagent line is unchanged — the 700 moved out of it, it did not duplicate');

  db.prepare("DELETE FROM cash_book WHERE ref_no = 'CE-OS'").run();
});

// ------------------------------------------------------------------ the budget
test('a budget can be set, and a blank line is not a budget of nothing', async () => {
  const set = await api('PUT', `/api/owner/budget/${P}`,
    { budget: { netRevenue: 30000, payroll: 5000, marketing: 1000 } });
  assert.strictEqual(set.status, 200, JSON.stringify(set.body));

  let c = commercial.comparison(P);
  const row = (k) => c.rows.find((r) => r.key === k);
  assert.strictEqual(row('netRevenue').budget, 30000);
  assert.strictEqual(row('rentUtilities').budget, null, 'never set, so not budgeted');

  // Clearing a line removes it rather than storing a zero — "not budgeted"
  // and "budgeted at nothing" mean different things in the variance column.
  await api('PUT', `/api/owner/budget/${P}`, { budget: { marketing: '' } });
  c = commercial.comparison(P);
  assert.strictEqual(c.rows.find((r) => r.key === 'marketing').budget, null);

  await api('PUT', `/api/owner/budget/${P}`, { budget: { marketing: 0 } });
  c = commercial.comparison(P);
  assert.strictEqual(c.rows.find((r) => r.key === 'marketing').budget, 0,
    'a deliberate zero is kept, and is not the same as a blank');
});

test('under budget is good news on a cost and bad news on revenue', () => {
  const c = commercial.comparison(P);
  const revenue = c.rows.find((r) => r.key === 'netRevenue');
  const payroll = c.rows.find((r) => r.key === 'payroll');

  /*
   * A single signed subtraction would colour half this table backwards. The
   * fixture earns less than its 30,000 budget and spends nothing against a
   * 5,000 payroll budget: the first is a problem and the second is not.
   */
  assert.ok(revenue.difference < 0);
  assert.strictEqual(revenue.favourable, false, 'earning less than planned is not good news');

  assert.ok(payroll.difference < 0);
  assert.strictEqual(payroll.favourable, true, 'spending less than planned is');
});

test('a subtotal\'s budget is the arithmetic of the lines, not a figure anybody types', async () => {
  const b = await api('GET', `/api/owner/budget/${P}`);
  assert.ok(!b.body.lines.some((l) => l.key === 'ebitda'),
    'the owner is not offered a box for a subtotal');
  // Sending one anyway is ignored rather than honoured.
  await api('PUT', `/api/owner/budget/${P}`, { budget: { ebitda: 999999 } });
  const c = commercial.comparison(P);
  const ebitda = c.rows.find((r) => r.key === 'ebitda');
  assert.notStrictEqual(ebitda.budget, 999999, 'a statement must not be made to add up to a wish');
  const costKeys = ['medicinesConsumed', 'doctorPayout', 'payroll', 'outsourced',
    'rentUtilities', 'maintenanceAdmin', 'marketing'];
  const budgets = {};
  for (const r of c.rows) budgets[r.key] = r.budget;
  const expected = Math.round(((budgets.netRevenue || 0)
    - costKeys.reduce((t, k) => t + (budgets[k] || 0), 0)) * 100) / 100;
  assert.strictEqual(ebitda.budget, expected);
});

// -------------------------------------------------------------- break-even
test('break-even is fixed costs divided by the contribution margin', () => {
  const b = commercial.breakEven('2026-05-01', '2026-05-31');
  const d = board();

  // The rent is fixed; the marketing is not, and must not be in the divisor's
  // numerator or the clinic will think it has to earn more than it does.
  assert.ok(b.fixedRows.some((r) => r.category === 'Rent'));
  assert.ok(!b.fixedRows.some((r) => r.category === 'Marketing & camps'));
  assert.strictEqual(b.variableOverhead, 2000);

  const ratio = d.totals.contribution / d.totals.revenue;
  assert.ok(Math.abs(b.required - b.fixed / ratio) < 1,
    'required revenue is fixed cost over the contribution ratio');
  assert.strictEqual(b.surplus, Math.round((b.revenue - b.required) * 100) / 100);
});

test('the indicators each carry the two figures they were built from', () => {
  const list = commercial.indicators('2026-05-01', '2026-05-31', P);
  const by = (k) => list.find((i) => i.key === k);

  assert.strictEqual(by('pharmacyMargin').value, 60);
  assert.strictEqual(by('doctorPayout').value,
    Math.round((4000 / dept('consultation').revenue) * 1000) / 10);
  assert.strictEqual(by('wastage').value, 400);

  for (const i of list) {
    assert.ok(Array.isArray(i.of) && i.of.length === 2, `${i.key} shows its workings`);
    assert.ok(i.formula && i.why, `${i.key} says what it is and why`);
  }
  // The one that cannot be measured properly admits it.
  assert.match(by('reagents').caveat, /not stock-counted/i);
});

// ------------------------------------------------------------ what is being done
test('an action needs somebody\'s name against it', async () => {
  const thin = await api('POST', '/api/owner/actions',
    { finding: 'Margin fell', action: 'Look into it' });
  assert.strictEqual(thin.status, 400, 'a finding with nobody responsible is an observation');

  const made = await api('POST', '/api/owner/actions', {
    period: P, area: 'laboratory', finding: 'Reagent ratio 25%', cause: 'wastage',
    action: 'Count the fridge weekly', responsible: 'Lab — Nafisa', dueDate: '2026-06-15',
  });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.strictEqual(made.body.status, 'open');
  assert.strictEqual(made.body.closed_at, null);

  const done = await api('PATCH', `/api/owner/actions/${made.body.id}`,
    { status: 'done', outcome: 'Weekly count started 1 June' });
  assert.strictEqual(done.status, 200);
  assert.ok(done.body.closed_at, 'closing it stamps when');

  // Reopening clears the stamp rather than leaving a closed date on an open item.
  const back = await api('PATCH', `/api/owner/actions/${made.body.id}`, { status: 'in_progress' });
  assert.strictEqual(back.body.closed_at, null);

  const bad = await api('PATCH', `/api/owner/actions/${made.body.id}`, { status: 'maybe' });
  assert.strictEqual(bad.status, 400);
});

test('the whole board comes back in one call, for one month', async () => {
  const r = await api('GET', `/api/owner/commercial?period=${P}`);
  assert.strictEqual(r.status, 200);
  for (const key of ['departments', 'comparison', 'indicators', 'breakEven', 'slipping', 'actions']) {
    assert.ok(r.body[key], key);
  }
  assert.strictEqual(r.body.period, P);
  assert.strictEqual(r.body.comparison.previousPeriod, PREV);
  assert.strictEqual((await api('GET', '/api/owner/commercial?period=2026-13')).status, 400);
  assert.strictEqual((await api('GET', '/api/owner/budget/nonsense')).status, 400);
});
