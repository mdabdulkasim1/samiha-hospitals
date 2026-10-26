'use strict';
/**
 * The clinic's own money: the cash book, and the picture it makes.
 *
 * Two things are under test and they pull in opposite directions. The book has
 * to be easy to write down, by the people who handle the money — so the
 * cashier can enter it. The picture has to be hard to see, because "are we
 * losing money" is a question the clinic is run from rather than one a counter
 * is handed — so the same cashier is refused it, on the server, not by a tab
 * being left off a screen.
 *
 * The third thing, which is the one that would quietly ruin the figures: the
 * takings are counted from where they already sit and never re-entered here.
 * A clinic that types its income in twice reports it twice, and the second
 * number is the one somebody acts on.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-acc-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');

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

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['counselor', 'counselor@samiha.local'],
    ['cashier', 'cashier@samiha.local'], ['nurse', 'nurse@samiha.local'],
    ['lab', 'lab@samiha.local'], ['reception', 'reception@samiha.local'],
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

// ------------------------------------------------------------- who may do what
test('the counter writes the book down; it does not get to read the picture', async () => {
  // Entering is the cashier's work, and the counsellor's, and the admin's.
  for (const who of ['cashier', 'counselor', 'admin']) {
    const made = await api('POST', '/api/accounts/entries',
      { direction: 'out', category: 'Printing & stationery', amount: 100 + Math.random(), entryDate: today() }, who);
    assert.strictEqual(made.status, 201, `${who} should be able to record an expense`);
    assert.strictEqual((await api('GET', '/api/accounts/entries', undefined, who)).status, 200);
    assert.strictEqual((await api('GET', '/api/accounts/categories', undefined, who)).status, 200);
  }

  // Reading the whole picture is not.
  assert.strictEqual((await api('GET', '/api/accounts/summary', undefined, 'cashier')).status, 403,
    'the cash-flow overview is refused to the cashier by the server, not merely hidden');
  for (const who of ['counselor', 'admin']) {
    assert.strictEqual((await api('GET', '/api/accounts/summary', undefined, who)).status, 200);
  }

  // And the clinic's money is nobody else's business at all.
  for (const who of ['nurse', 'lab', 'reception']) {
    assert.strictEqual((await api('GET', '/api/accounts/entries', undefined, who)).status, 403);
    assert.strictEqual((await api('POST', '/api/accounts/entries',
      { direction: 'out', category: 'Rent', amount: 500 }, who)).status, 403);
    assert.strictEqual((await api('GET', '/api/accounts/summary', undefined, who)).status, 403);
  }
});

test('every financial report is the administrator\'s and the counsellor\'s', async () => {
  for (const report of ['/api/reports/revenue', '/api/reports/doctor-monthly']) {
    for (const who of ['admin', 'counselor']) {
      assert.strictEqual((await api('GET', report, undefined, who)).status, 200, `${who} ${report}`);
    }
    for (const who of ['cashier', 'reception', 'nurse', 'lab']) {
      assert.strictEqual((await api('GET', report, undefined, who)).status, 403,
        `${who} should not read ${report}`);
    }
  }
  // The cashier keeps what their own job turns on: the bills and the payments.
  assert.strictEqual((await api('GET', '/api/billing/invoices', undefined, 'cashier')).status, 200);
});

// ------------------------------------------------------------- writing it down
test('an entry is checked before it reaches the book', async () => {
  const bad = async (body, pattern) => {
    const r = await api('POST', '/api/accounts/entries', body, 'cashier');
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, pattern);
  };

  await bad({ direction: 'out', category: 'Rent', amount: 0 }, /more than nothing/);
  await bad({ direction: 'out', category: 'Rent', amount: -500 }, /more than nothing/);
  // A heading has to be one of the real ones, or the overview totals nothing.
  await bad({ direction: 'out', category: 'Sundries', amount: 500 }, /not one of the headings/);
  // And it has to belong to the direction: rent is not a kind of income.
  await bad({ direction: 'in', category: 'Rent', amount: 500 }, /not one of the headings/);
  // Money that has not moved yet is not a cash book entry.
  await bad({ direction: 'out', category: 'Rent', amount: 500, entryDate: '2099-01-01' },
    /cannot be dated in the future/);

  // A bill paid last week, entered today, belongs to last week.
  const back = await api('POST', '/api/accounts/entries',
    { direction: 'out', category: 'Rent', amount: 500, entryDate: daysAgo(6) }, 'cashier');
  assert.strictEqual(back.status, 201);
  assert.strictEqual(back.body.entry_date, daysAgo(6));
});

test('a voided entry stays on the page and leaves the totals', async () => {
  const made = await api('POST', '/api/accounts/entries',
    { direction: 'out', category: 'Travel & conveyance', amount: 7777, entryDate: today() }, 'cashier');
  const id = made.body.id;

  const before = (await api('GET', '/api/accounts/entries', undefined, 'counselor')).body.totals.money_out;

  assert.strictEqual((await api('POST', `/api/accounts/entries/${id}/void`, {}, 'cashier')).status, 400,
    'a void needs a reason');
  const voided = await api('POST', `/api/accounts/entries/${id}/void`,
    { reason: 'Entered twice' }, 'cashier');
  assert.strictEqual(voided.status, 200);
  assert.ok(voided.body.voided_at);
  assert.strictEqual(voided.body.void_reason, 'Entered twice');
  assert.ok(voided.body.voided_by_name, 'and who decided it');

  const after = (await api('GET', '/api/accounts/entries', undefined, 'counselor')).body;
  assert.strictEqual(Math.round(after.totals.money_out), Math.round(before - 7777),
    'the amount stops counting');
  assert.ok(after.rows.some((r) => r.id === id), 'but the line is still there to be seen');

  // It cannot be voided twice, or edited afterwards.
  assert.strictEqual((await api('POST', `/api/accounts/entries/${id}/void`,
    { reason: 'again' }, 'cashier')).status, 409);
  assert.strictEqual((await api('PATCH', `/api/accounts/entries/${id}`,
    { amount: 1 }, 'cashier')).status, 409);
});

test('a correction is recorded as a correction, with what it was before', async () => {
  const made = await api('POST', '/api/accounts/entries',
    { direction: 'out', category: 'Electricity & water', amount: 1000, entryDate: today() }, 'cashier');

  const fixed = await api('PATCH', `/api/accounts/entries/${made.body.id}`,
    { amount: 1450, notes: 'Meter reading was misread' }, 'cashier');
  assert.strictEqual(fixed.status, 200);
  assert.strictEqual(fixed.body.amount, 1450);
  assert.strictEqual(fixed.body.ref_no, made.body.ref_no, 'the same entry, not a new one');

  const logs = (await api('GET', '/api/reports/audit?entity=cash_book', undefined, 'admin')).body;
  const edit = (logs.rows || logs).find((r) => r.action === 'cash_entry_edit'
    && r.entity_id === made.body.id);
  assert.ok(edit, 'the edit is on the audit trail');
  const detail = JSON.parse(edit.details);
  assert.strictEqual(detail.was.amount, 1000);
  assert.strictEqual(detail.now.amount, 1450);
});

// ----------------------------------------------------------------- the picture
test('the takings are counted from where they already sit, never typed in twice', async () => {
  const when = daysAgo(3);
  const patient = db.prepare('SELECT id FROM patients LIMIT 1').get().id;
  const cashier = db.prepare("SELECT id FROM users WHERE role = 'cashier'").get().id;

  // A patient billed and paying at the cashier.
  const inv = db.prepare(
    `INSERT INTO invoices (invoice_no, patient_id, kind, status, gross, net, paid, balance, created_at)
     VALUES ('INVACC1', ?, 'opd', 'paid', 4000, 4000, 4000, 0, ?)`
  ).run(patient, `${when} 10:00`);
  db.prepare(
    `INSERT INTO payments (receipt_no, invoice_id, patient_id, amount, mode, received_by, paid_at)
     VALUES ('RCPACC1', ?, ?, 4000, 'cash', ?, ?)`
  ).run(inv.lastInsertRowid, patient, cashier, `${when} 10:05`);

  // A walk-in buying over the counter, who never reaches an invoice at all —
  // the one that is missed if only `payments` is counted.
  db.prepare(
    `INSERT INTO pharmacy_sales (bill_no, sale_type, paid_amount, net, status, created_at)
     VALUES ('PHACC1', 'counter', 600, 600, 'billed', ?)`
  ).run(`${when} 18:00`);

  // And income nobody was billed for.
  await api('POST', '/api/accounts/entries',
    { direction: 'in', category: 'Health camp collection', amount: 2500, entryDate: when }, 'counselor');

  const d = (await api('GET', `/api/accounts/summary?from=${when}&to=${when}`, undefined, 'counselor')).body;
  assert.strictEqual(d.totals.billed, 4000, 'what a billed patient handed over');
  assert.strictEqual(d.totals.counter, 600, 'and what the counter took without an invoice');
  assert.strictEqual(d.totals.otherIncome, 2500, 'and what no patient was billed for');
  assert.strictEqual(d.totals.income, 7100, 'added once each, not twice');

  const day = d.points.find((p) => p.at === when);
  assert.ok(day, 'the day is on the series');
  assert.strictEqual(day.income, 7100);
  assert.strictEqual(day.net, Math.round((day.income - day.expense) * 100) / 100);
});

test('the same money adds up by day and by week, and weeks start on Monday', async () => {
  const byDay = (await api('GET', '/api/accounts/summary?by=day&from=2026-01-01', undefined, 'admin')).body;
  const byWeek = (await api('GET', '/api/accounts/summary?by=week&from=2026-01-01', undefined, 'admin')).body;

  assert.strictEqual(byDay.by, 'day');
  assert.strictEqual(byWeek.by, 'week');
  // The same period cut two ways is the same money.
  assert.strictEqual(Math.round(byDay.totals.income), Math.round(byWeek.totals.income));
  assert.strictEqual(Math.round(byDay.totals.expense), Math.round(byWeek.totals.expense));
  assert.ok(byWeek.points.length <= byDay.points.length);

  const sum = (pts, k) => Math.round(pts.reduce((t, p) => t + p[k], 0));
  assert.strictEqual(sum(byDay.points, 'income'), sum(byWeek.points, 'income'),
    'nothing falls between the buckets');
  assert.strictEqual(sum(byDay.points, 'expense'), sum(byWeek.points, 'expense'));

  for (const p of byWeek.points) {
    assert.strictEqual(new Date(`${p.at}T00:00:00Z`).getUTCDay(), 1,
      `${p.at} should be a Monday — a Sunday clinic belongs to the week it finished`);
  }
});

test('the headings offered are the ones the book will accept', async () => {
  const { categories, modes } = (await api('GET', '/api/accounts/categories', undefined, 'cashier')).body;
  assert.ok(categories.out.includes('Salaries & wages'));
  assert.ok(categories.in.includes('Health camp collection'));
  assert.ok(modes.includes('cash') && modes.includes('upi'));

  // Every heading the form offers is one the server will take.
  for (const [direction, list] of Object.entries(categories)) {
    for (const category of list) {
      const r = await api('POST', '/api/accounts/entries',
        { direction, category, amount: 1, entryDate: today() }, 'cashier');
      assert.strictEqual(r.status, 201, `${direction}/${category} was offered but refused`);
      await api('POST', `/api/accounts/entries/${r.body.id}/void`, { reason: 'test' }, 'cashier');
    }
  }
});
