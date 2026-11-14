'use strict';
/**
 * The expense book.
 *
 * The accounts office asked for two things to be kept apart — what it cost
 * to build the clinic and what it costs to run it — and for every rupee to
 * be booked under a heading and an item rather than typed into a box. That
 * is what these tests are about, and under them sit three rules that are
 * easy to state and easy to get wrong.
 *
 * A cost is incurred when the bill is raised, not when it is paid. A rupee
 * is counted exactly once, wherever it is counted. And nothing that is not
 * a cost of the month — a machine bought, a deposit paid, a loan principal
 * repaid, stock put on a shelf — is allowed into the operating subtotal,
 * because that subtotal is what the clinic judges itself by.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-exp-'));
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
const month = new Date().toISOString().slice(0, 7);
const today = new Date().toISOString().slice(0, 10);

async function api(method, p, body, as = 'cashier') {
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

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['admin', 'cashier', 'counselor', 'reception', 'nurse']) {
    const r = await api('POST', '/api/auth/login',
      { username: `${who}@samiha.local`, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, who);
    tokens[who] = r.body.token;
  }
  const cats = await api('GET', '/api/expenses/categories');
  ids.catalogue = cats.body;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const headingByCode = (code) => ids.catalogue.groups
  .flatMap((g) => g.categories).find((c) => c.code === code);

// --------------------------------------------------------------- the headings
test('the headings the accounts office asked for are all there, with their items', () => {
  const groups = Object.fromEntries(ids.catalogue.groups.map((g) => [g.key, g.categories]));
  assert.strictEqual(groups.setup.length, 4, 'the four setup headings');
  assert.strictEqual(groups.operating.length, 20, 'the twenty running ones');
  assert.ok(groups.finance.length >= 1, 'and interest, below the line');
  assert.ok(groups.schedule.length >= 3, 'with the schedules that are not expenses');

  // Each one is itemised, because "Laboratory — 14,500" tells an owner nothing.
  for (const c of [...groups.setup, ...groups.operating]) {
    assert.ok(c.items.length >= 3, `${c.name} has its items (${c.items.length})`);
  }

  // Spot-check the lists are the ones the letter gave, not an approximation.
  const lab = headingByCode('OP-LAB').items.map((i) => i.name);
  for (const want of ['Reagents', 'Test kits', 'Sample tubes', 'Controls', 'Calibrators',
    'Outsourced tests', 'Sample courier charges']) {
    assert.ok(lab.includes(want), `laboratory covers ${want}`);
  }
  const build = headingByCode('SETUP-BUILD').items.map((i) => i.name);
  for (const want of ['Civil works', 'X-ray room shielding', 'Permanent signage']) {
    assert.ok(build.includes(want), `fit-out covers ${want}`);
  }

  // The seven departments the letter named, and no others.
  assert.deepStrictEqual(ids.catalogue.departments.map((d) => d.label), [
    'OPD', 'Treatment & Day Care', 'Laboratory', 'Radiology', 'Pharmacy',
    'Home Sample Collection', 'Administration & Common Services']);
});

test('a restart does not undo what the clinic changed', () => {
  /*
   * The seed list is insert-if-absent. A clinic that renames a heading or
   * switches one off must find its work there after the next deploy — a
   * list that overwrites them every boot teaches people not to use it.
   */
  const row = db.prepare("SELECT * FROM expense_categories WHERE code = 'OP-UTIL'").get();
  db.prepare("UPDATE expense_categories SET name = 'EB and water', active = 0 WHERE id = ?").run(row.id);
  db.prepare("INSERT INTO expense_items (category_id, name, seeded, sort_order) VALUES (?, 'Solar upkeep', 0, 999)")
    .run(row.id);

  require('../src/db/catalogue').sync({ quiet: true });

  const after = db.prepare("SELECT * FROM expense_categories WHERE code = 'OP-UTIL'").get();
  assert.strictEqual(after.name, 'EB and water', 'the rename stands');
  assert.strictEqual(after.active, 0, 'and so does switching it off');
  assert.ok(db.prepare("SELECT 1 FROM expense_items WHERE category_id = ? AND name = 'Solar upkeep'")
    .get(row.id), 'and the clinic\'s own item');

  db.prepare("UPDATE expense_categories SET name = ?, active = 1 WHERE id = ?").run(row.name, row.id);
  db.prepare("DELETE FROM expense_items WHERE category_id = ? AND name = 'Solar upkeep'").run(row.id);
});

// ---------------------------------------------------------------- booking one
test('the cashier books a bill under a heading and an item', async () => {
  const lab = headingByCode('OP-LAB');
  const reagents = lab.items.find((i) => i.name === 'Reagents');

  const r = await api('POST', '/api/expenses', {
    categoryId: lab.id, itemId: reagents.id, department: 'laboratory',
    supplierName: 'Tirunelveli Diagnostics Supply',
    description: 'Biochemistry reagent pack — monthly',
    invoiceNo: 'TDS/2026/4471', invoiceDate: today,
    periodFrom: `${month}-01`, periodTo: `${month}-28`,
    taxable: 10000, tax: 1800, dueDate: today,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  ids.reagents = r.body.id;

  assert.match(r.body.ref_no, /^EXP\d{9}$/);
  assert.strictEqual(r.body.total, 11800, 'the total is worked out, not typed a third time');
  assert.strictEqual(r.body.category_name, lab.name);
  assert.strictEqual(r.body.item_name, 'Reagents');
  assert.strictEqual(r.body.department, 'laboratory');
  assert.strictEqual(r.body.status, 'unpaid');
  assert.strictEqual(r.body.outstanding, 11800, 'and it is owed until it is paid');
});

test('the split has to add up, because a bill that does not is one misread', async () => {
  const lab = headingByCode('OP-LAB');
  const bad = await api('POST', '/api/expenses', {
    categoryId: lab.id, supplierName: 'Anyone', invoiceDate: today,
    taxable: 1000, tax: 180, total: 1500,
  });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /does not add up/i);

  // The total on its own is enough: that is the figure on the counter's desk.
  const fine = await api('POST', '/api/expenses', {
    categoryId: lab.id, supplierName: 'Anyone', invoiceDate: today, total: 500,
  });
  assert.strictEqual(fine.status, 201);
  assert.strictEqual(fine.body.total, 500);
  assert.strictEqual(fine.body.taxable, 500, 'with no tax claimed against it');
});

test('a bill cannot be dated into next month, or fall due before it was raised', async () => {
  const lab = headingByCode('OP-LAB');
  const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const ahead = await api('POST', '/api/expenses',
    { categoryId: lab.id, supplierName: 'X', invoiceDate: soon, total: 100 });
  assert.strictEqual(ahead.status, 400);
  assert.match(ahead.body.error, /future/i);

  const backwards = await api('POST', '/api/expenses', {
    categoryId: lab.id, supplierName: 'X', invoiceDate: today, total: 100,
    dueDate: '2020-01-01',
  });
  assert.strictEqual(backwards.status, 400);
  assert.match(backwards.body.error, /due before it was raised/i);
});

test('an item has to belong to the heading it is booked under', async () => {
  const lab = headingByCode('OP-LAB');
  const rent = headingByCode('OP-RENT');
  const r = await api('POST', '/api/expenses', {
    categoryId: rent.id, itemId: lab.items[0].id, supplierName: 'Landlord',
    invoiceDate: today, total: 1000,
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /not an item under/i);
});

// -------------------------------------------------------------- paying for it
test('paying a bill writes the cash book line, once', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM cash_book').get().c;

  const paid = await api('POST', `/api/expenses/${ids.reagents}/payments`,
    { amount: 5000, mode: 'upi', reference: 'UPI-5512', paidOn: today });
  assert.strictEqual(paid.status, 200, JSON.stringify(paid.body));
  assert.strictEqual(paid.body.status, 'part_paid');
  assert.strictEqual(paid.body.paid, 5000);
  assert.strictEqual(paid.body.outstanding, 6800);

  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM cash_book').get().c, before + 1,
    'one payment, one cash book line');
  const cash = db.prepare('SELECT * FROM cash_book ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(cash.direction, 'out');
  assert.strictEqual(cash.amount, 5000);
  assert.strictEqual(cash.category, 'Lab reagents & kits',
    'under a heading the cash flow and the owner\'s board already understand');
  assert.match(cash.notes, /^EXP\d+/, 'and pointing back at the bill it paid');

  // Settling the rest closes it.
  const rest = await api('POST', `/api/expenses/${ids.reagents}/payments`, { amount: 6800, mode: 'cash' });
  assert.strictEqual(rest.body.status, 'paid');
  assert.strictEqual(rest.body.outstanding, 0);

  const over = await api('POST', `/api/expenses/${ids.reagents}/payments`, { amount: 1 });
  assert.strictEqual(over.status, 400, 'and nothing more can be paid against it');
  assert.match(over.body.error, /more than is outstanding/i);
});

test('a bill paid as it is handed over takes one press', async () => {
  const office = headingByCode('OP-OFFICE');
  const r = await api('POST', '/api/expenses', {
    categoryId: office.id, itemId: office.items.find((i) => i.name === 'Stationery').id,
    supplierName: 'Melapalayam Stationers', invoiceDate: today, total: 740,
    paidNow: 740, mode: 'cash',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.status, 'paid');
  assert.strictEqual(r.body.payments.length, 1);
  assert.ok(r.body.payments[0].cash_ref, 'and it reached the cash book straight away');
});

test('taking a payment back takes the cash book line with it', async () => {
  const office = headingByCode('OP-OFFICE');
  const made = await api('POST', '/api/expenses', {
    categoryId: office.id, supplierName: 'Wrong shop', invoiceDate: today,
    total: 200, paidNow: 200,
  });
  const payment = made.body.payments[0];

  const undone = await api('POST', `/api/expenses/payments/${payment.id}/void`,
    { reason: 'Paid against the wrong bill' });
  assert.strictEqual(undone.status, 200, JSON.stringify(undone.body));
  assert.strictEqual(undone.body.paid, 0);
  assert.strictEqual(undone.body.status, 'unpaid');

  const cash = db.prepare('SELECT * FROM cash_book WHERE id = ?').get(payment.cash_book_id);
  assert.ok(cash.voided_at, 'the cash book line is voided, not deleted');
  assert.match(cash.void_reason, /wrong bill/i);
});

test('voiding a bill voids what was paid against it', async () => {
  const office = headingByCode('OP-OFFICE');
  const made = await api('POST', '/api/expenses', {
    categoryId: office.id, supplierName: 'Duplicate entry', invoiceDate: today,
    total: 900, paidNow: 900,
  });
  const cashId = made.body.payments[0].cash_book_id;

  const nothing = await api('POST', `/api/expenses/${made.body.id}/void`, {});
  assert.strictEqual(nothing.status, 400, 'a reason is required');

  const voided = await api('POST', `/api/expenses/${made.body.id}/void`,
    { reason: 'Entered twice' });
  assert.strictEqual(voided.status, 200);
  assert.strictEqual(voided.body.status, 'void');
  assert.ok(db.prepare('SELECT voided_at FROM cash_book WHERE id = ?').get(cashId).voided_at,
    'the money it moved goes with it — otherwise the drawer is short on paper');
});

// -------------------------------------------------------------- who does what
test('the counter books, management approves and reads the whole', async () => {
  const lab = headingByCode('OP-LAB');
  const entry = { categoryId: lab.id, supplierName: 'Supply co', invoiceDate: today, total: 300 };

  assert.strictEqual((await api('POST', '/api/expenses', entry, 'reception')).status, 403);
  assert.strictEqual((await api('POST', '/api/expenses', entry, 'nurse')).status, 403);
  assert.strictEqual((await api('POST', '/api/expenses', entry, 'counselor')).status, 201);

  const mine = await api('POST', '/api/expenses', entry, 'cashier');
  assert.strictEqual(mine.status, 201);

  // Approving is management's.
  assert.strictEqual((await api('POST', `/api/expenses/${mine.body.id}/approve`,
    { note: 'ok' }, 'cashier')).status, 403);
  const signed = await api('POST', `/api/expenses/${mine.body.id}/approve`,
    { note: 'Checked against the order' }, 'admin');
  assert.strictEqual(signed.status, 200);
  assert.ok(signed.body.approved_at);
  assert.match(signed.body.approved_by_name, /Admin/i);

  // And so is the report: the payroll line alone is not a counter's to read.
  assert.strictEqual((await api('GET', '/api/expenses/report', undefined, 'cashier')).status, 403);
  assert.strictEqual((await api('GET', '/api/expenses/report', undefined, 'counselor')).status, 403);
  assert.strictEqual((await api('GET', '/api/expenses/report', undefined, 'admin')).status, 200);
});

test('only management changes the headings', async () => {
  const added = { name: 'Ambulance oxygen refills', group: 'operating', nature: 'operating' };
  assert.strictEqual((await api('POST', '/api/expenses/categories', added, 'cashier')).status, 403);
  assert.strictEqual((await api('POST', '/api/expenses/categories', added, 'counselor')).status, 403);

  const made = await api('POST', '/api/expenses/categories', {
    ...added, department: 'treatment', items: ['Cylinder refill', 'Cylinder rental'],
  }, 'admin');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  assert.ok(made.body.code.startsWith('CL-'), `a code of its own: ${made.body.code}`);
  assert.strictEqual(made.body.seeded, 0);
  assert.strictEqual(made.body.item_count, 2);
  ids.ownHeading = made.body.id;

  // It can be booked to at once.
  const items = (await api('GET', '/api/expenses/categories')).body.groups
    .flatMap((g) => g.categories).find((c) => c.id === made.body.id).items;
  const booked = await api('POST', '/api/expenses', {
    categoryId: made.body.id, itemId: items[0].id, supplierName: 'Gas agency',
    invoiceDate: today, total: 1250, paidNow: 1250,
  });
  assert.strictEqual(booked.status, 201, JSON.stringify(booked.body));
  assert.strictEqual(booked.body.category_name, 'Ambulance oxygen refills');
});

test('a heading that ships with the system cannot be moved out from under the reports', async () => {
  const rent = headingByCode('OP-RENT');
  const moved = await api('PATCH', `/api/expenses/categories/${rent.id}`,
    { group: 'setup' }, 'admin');
  assert.strictEqual(moved.status, 400);
  assert.match(moved.body.error, /ships with the system/i);

  // Renaming it is the clinic's own business.
  const renamed = await api('PATCH', `/api/expenses/categories/${rent.id}`,
    { name: 'Rent and premises' }, 'admin');
  assert.strictEqual(renamed.status, 200);
  assert.strictEqual(renamed.body.name, 'Rent and premises');
  await api('PATCH', `/api/expenses/categories/${rent.id}`, { name: rent.name }, 'admin');

  // And one that ships cannot be deleted, only switched off.
  const gone = await api('DELETE', `/api/expenses/categories/${rent.id}`, undefined, 'admin');
  assert.strictEqual(gone.status, 400);
});

test('a heading the clinic has used is switched off rather than erased', async () => {
  const off = await api('DELETE', `/api/expenses/categories/${ids.ownHeading}`, undefined, 'admin');
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.switchedOff, true, 'because a bill is booked under it');
  assert.strictEqual(off.body.active, 0);

  // Off the form, but last month's entry under it still reads.
  const onForm = (await api('GET', '/api/expenses/categories')).body.groups
    .flatMap((g) => g.categories).some((c) => c.id === ids.ownHeading);
  assert.strictEqual(onForm, false);
  const all = (await api('GET', '/api/expenses/categories?all=1')).body.groups
    .flatMap((g) => g.categories).some((c) => c.id === ids.ownHeading);
  assert.strictEqual(all, true, 'management still sees it');
});

// ------------------------------------------------------------------ the report
test('setup is kept out of what it costs to run the clinic', async () => {
  const build = headingByCode('SETUP-BUILD');
  const equip = headingByCode('SETUP-EQUIP');
  await api('POST', '/api/expenses', {
    categoryId: build.id, itemId: build.items.find((i) => i.name === 'Civil works').id,
    supplierName: 'Builder', invoiceDate: today, total: 400000, paidNow: 400000,
  });
  await api('POST', '/api/expenses', {
    categoryId: equip.id, supplierName: 'Imaging supplier', invoiceDate: today,
    total: 250000, description: 'X-ray unit',
  });

  const r = await api('GET', `/api/expenses/report?period=${month}`, undefined, 'admin');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const out = r.body;

  const setup = out.groups.find((g) => g.key === 'setup');
  assert.strictEqual(setup.month.billed, 650000, 'the fit-out and the machine');
  assert.strictEqual(out.schedules.setup.month.billed, 650000, 'on their own schedule');
  assert.ok(out.operating.month.billed > 0, 'while the running costs are their own figure');
  assert.ok(out.operating.month.billed < 650000,
    'and the building does not land in them — it is an investment, not a month');
});

test('interest and depreciation are reported below the subtotal, not in it', async () => {
  const interest = headingByCode('FIN-INT');
  await api('POST', '/api/expenses', {
    categoryId: interest.id, itemId: interest.items[0].id, supplierName: 'Bank',
    invoiceDate: today, total: 18500, paidNow: 18500,
  });

  const out = (await api('GET', `/api/expenses/report?period=${month}`, undefined, 'admin')).body;
  assert.strictEqual(out.belowTheLine.finance.month.billed, 18500);
  assert.ok(out.belowTheLine.depreciation.month.billed > 0, 'from the asset register');
  assert.strictEqual(out.belowTheLine.depreciation.month.paid, 0, 'nothing is paid out for it');

  // The subtotal is the running cost alone.
  const operatingRows = out.groups.find((g) => g.key === 'operating');
  assert.strictEqual(out.totals.operating, operatingRows.month.billed);
  assert.strictEqual(out.totals.afterTheLine,
    Math.round((out.totals.operating + out.totals.interest + out.totals.depreciation) * 100) / 100);
});

test('a deposit, an advance and a loan repayment are schedules, not costs', async () => {
  const before = (await api('GET', `/api/expenses/report?period=${month}`, undefined, 'admin'))
    .body.operating.month.billed;

  for (const [code, amount] of [['SCH-DEPOSIT', 60000], ['SCH-ADVANCE', 25000], ['SCH-LOAN', 42000]]) {
    const heading = headingByCode(code);
    const r = await api('POST', '/api/expenses', {
      categoryId: heading.id, itemId: heading.items[0].id, supplierName: 'Counterparty',
      invoiceDate: today, total: amount, paidNow: amount,
    });
    assert.strictEqual(r.status, 201, `${code}: ${JSON.stringify(r.body)}`);
  }

  const out = (await api('GET', `/api/expenses/report?period=${month}`, undefined, 'admin')).body;
  assert.strictEqual(out.operating.month.billed, before,
    'none of the three is a cost of running the clinic');
  assert.strictEqual(out.schedules.deposits.month.billed, 60000);
  assert.strictEqual(out.schedules.advances.month.billed, 25000);
  assert.strictEqual(out.schedules.loanPrincipal.month.billed, 42000);

  // But the money did leave, and the cash book says so.
  const outflow = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM cash_book
      WHERE direction = 'out' AND voided_at IS NULL AND category = 'Deposit or advance paid'`).get().s;
  assert.strictEqual(outflow, 85000, 'the deposit and the advance are out of the bank');
});

test('the month reads by heading, by item and by department, with the year beside it', async () => {
  const out = (await api('GET', `/api/expenses/report?period=${month}`, undefined, 'admin')).body;

  const lab = out.groups.find((g) => g.key === 'operating').categories
    .find((c) => c.code === 'OP-LAB');
  assert.ok(lab.month.billed > 0);
  assert.ok(lab.items.some((i) => i.name === 'Reagents'), 'and down to the item');
  assert.strictEqual(lab.ytd.billed >= lab.month.billed, true, 'the year includes the month');

  const laboratory = out.departments.find((d) => d.key === 'laboratory');
  assert.ok(laboratory.month.billed > 0, 'the laboratory carries its own costs');
  const common = out.departments.find((d) => d.key === 'common');
  assert.ok(common, 'and what nobody owns is Common Services');

  // The financial year, not the calendar one.
  assert.match(out.ytdFrom, /-04-01$/);
});

test('what is owed, and what has no paperwork behind it', async () => {
  const out = (await api('GET', `/api/expenses/report?period=${month}`, undefined, 'admin')).body;
  assert.ok(out.flags.unpaid.amount > 0, 'the X-ray unit is still owed for');
  assert.ok(out.flags.missingDocuments.entries > 0,
    'and the bills with no invoice number and no scan are flagged');

  const owed = await api('GET', '/api/expenses/payable');
  assert.strictEqual(owed.status, 200);
  assert.ok(owed.body.length > 0);
  assert.ok(owed.body.every((r) => r.outstanding > 0));
});

test('a discount is revenue not earned, and never an expense', async () => {
  const out = (await api('GET', `/api/expenses/report?period=${month}`, undefined, 'admin')).body;
  assert.ok('discountsGiven' in out.patients);
  assert.ok('refunds' in out.patients);
  // They are reported, and they are not in any cost figure.
  assert.ok(!out.groups.some((g) => g.categories.some((c) => /discount/i.test(c.name))));
});

// ------------------------------------------------------------- the paperwork
test('the invoice itself can be filed against the entry', async () => {
  const lab = headingByCode('OP-LAB');
  const made = await api('POST', '/api/expenses', {
    categoryId: lab.id, supplierName: 'Supply co', invoiceNo: 'SC/9912',
    invoiceDate: today, total: 2400,
  });

  // A one-pixel PNG stands in for the photograph of a bill.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await api('POST', `/api/expenses/${made.body.id}/attachments`,
    { data: png, kind: 'invoice', filename: 'SC-9912.png' });
  assert.strictEqual(up.status, 201, JSON.stringify(up.body));
  assert.strictEqual(up.body.mime, 'image/png');
  assert.ok(up.body.bytes > 0);

  const full = await api('GET', `/api/expenses/${made.body.id}`);
  assert.strictEqual(full.body.files.length, 1);
  assert.strictEqual(full.body.attachments, 1);

  const served = await fetch(`${base}/api/expenses/attachments/${up.body.id}`,
    { headers: { Authorization: `Bearer ${tokens.cashier}` } });
  assert.strictEqual(served.status, 200);
  assert.match(served.headers.get('content-type'), /image\/png/);

  // Not without the login, though: a supplier's invoice is the clinic's business.
  assert.strictEqual((await fetch(`${base}/api/expenses/attachments/${up.body.id}`)).status, 401);

  const spreadsheet = await api('POST', `/api/expenses/${made.body.id}/attachments`,
    { data: 'data:application/vnd.ms-excel;base64,QQ==' });
  assert.strictEqual(spreadsheet.status, 400, 'a photograph or a PDF, not anything at all');
});

test('every booking is on the record', async () => {
  const row = db.prepare(
    "SELECT * FROM audit_logs WHERE entity = 'expense' AND action = 'create' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row, 'the expense book writes to the audit trail');
  assert.ok(row.actor && row.actor !== 'system', `and names who booked it — got ${row.actor}`);
  const details = JSON.parse(row.details);
  assert.ok(details.refNo && details.category && details.total);
});

test('the owner\'s board still adds up with the new headings in it', async () => {
  /*
   * Every payment writes a cash book line, and the owner's board is built
   * from the cash book. A heading the board has never heard of would fall
   * into its catch-all and quietly report a building as an overhead, so
   * each new one carries a rule.
   */
  const commercial = require('../src/lib/commercial');
  const accounts = db.prepare(
    "SELECT DISTINCT cash_category AS c FROM expense_categories WHERE cash_category IS NOT NULL").all();
  for (const { c } of accounts) {
    const rule = commercial.COST_BOOK[c];
    assert.ok(rule, `the board knows what "${c}" is`);
    assert.ok(!rule.unmapped, `"${c}" is not falling through to the catch-all`);
  }

  /*
   * And the building lands in the board's capital figure rather than in its
   * overheads. The X-ray unit does not, because it has not been paid for:
   * the board is built from money that moved, and the expense book is where
   * a cost that has been incurred but not yet settled is kept. That is the
   * difference between the two books, stated as a number — 400,000 paid for
   * the fit-out plus the deposit, the advance and the loan instalment.
   */
  const actuals = commercial.actuals(month);
  assert.strictEqual(actuals.capital, 527000,
    'the fit-out, the deposit, the advance and the loan principal — all paid, none a cost');

  const report = (await api('GET', `/api/expenses/report?period=${month}`, undefined, 'admin')).body;
  assert.strictEqual(report.schedules.setup.month.billed, 650000,
    'while the expense book carries the machine too, billed and still owed for');
  assert.strictEqual(report.schedules.setup.month.outstanding, 250000);
});
