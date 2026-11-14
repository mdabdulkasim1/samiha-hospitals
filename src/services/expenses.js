'use strict';
/**
 * The expense book.
 *
 * The cash book next door records money moving. This records a cost being
 * incurred, and those are not the same event: a supplier's invoice dated the
 * 3rd and paid on the 28th is one cost in this month and one payment in it.
 * A clinic that writes down only payments cannot answer "what did October
 * cost" until every bill from October happens to be settled, and cannot
 * answer "what do we owe" at all.
 *
 * So an expense here is the invoice, and payments hang off it. Each payment
 * writes the cash book line it always would have, linked both ways, so the
 * money is counted exactly once where money is counted and the cost exactly
 * once where costs are counted. Nothing had to be unpicked from the owner's
 * board for this: the board still reads the cash book, and now reads better
 * headings than "other expense".
 *
 * What the counter has to type is deliberately short — heading, item,
 * department, supplier, amount, date. Everything else has a sensible default
 * and can be filled in later by whoever has the paperwork.
 */
const { db } = require('../db');
const { generate } = require('../lib/ids');
const { badRequest, notFound, conflict } = require('../lib/http');
const book = require('../db/expenseBook');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const MODES = ['cash', 'card', 'upi', 'netbanking', 'cheque', 'other'];

/* ------------------------------------------------------------- the headings */

const CATEGORY_SELECT = `
  SELECT c.*,
         (SELECT COUNT(*) FROM expense_items i WHERE i.category_id = c.id AND i.active = 1) AS item_count,
         (SELECT COUNT(*) FROM expenses e WHERE e.category_id = c.id AND e.voided_at IS NULL) AS used
    FROM expense_categories c`;

/**
 * Every heading, grouped the way the report prints them, each with its items.
 *
 * Switched-off headings are left out of what the counter is offered but kept
 * in what management sees, because a heading is switched off rather than
 * deleted precisely so that last year's entries under it still read.
 */
function categories({ includeInactive = false } = {}) {
  const rows = db.prepare(
    `${CATEGORY_SELECT} ${includeInactive ? '' : 'WHERE c.active = 1'}
      ORDER BY c.cost_group, c.sort_order, c.id`).all();
  const items = db.prepare(
    `SELECT * FROM expense_items ${includeInactive ? '' : 'WHERE active = 1'}
      ORDER BY sort_order, id`).all();

  const byCategory = new Map();
  for (const it of items) {
    if (!byCategory.has(it.category_id)) byCategory.set(it.category_id, []);
    byCategory.get(it.category_id).push(it);
  }
  for (const c of rows) c.items = byCategory.get(c.id) || [];

  return book.GROUPS.map((g) => ({
    ...g,
    categories: rows.filter((c) => c.cost_group === g.key),
  })).filter((g) => g.categories.length);
}

const categoryById = (id) => db.prepare(`${CATEGORY_SELECT} WHERE c.id = ?`).get(id);
const categoryByCode = (code) => db.prepare(`${CATEGORY_SELECT} WHERE c.code = ?`).get(code);

/**
 * A heading the clinic adds for itself.
 *
 * It must say which group it belongs in and what nature it has, because
 * those two decide whether it lands in the operating subtotal — and a new
 * heading that silently defaulted into the subtotal could turn a month's
 * profit into a loss without anybody choosing that.
 */
function createCategory(input, userId) {
  const name = String(input.name || '').trim();
  if (!name) throw badRequest('Give the heading a name.');

  const group = String(input.group || 'operating');
  if (!book.GROUPS.some((g) => g.key === group)) {
    throw badRequest(`"${group}" is not one of the groups.`, { groups: book.GROUPS.map((g) => g.key) });
  }
  const nature = String(input.nature || (group === 'operating' ? 'operating' : 'capital'));
  if (!book.NATURES.includes(nature)) {
    throw badRequest(`"${nature}" is not a nature a heading can have.`, { natures: book.NATURES });
  }
  const department = String(input.department || book.DEFAULT_DEPARTMENT);
  if (!book.DEPARTMENT_KEYS.includes(department)) throw badRequest(`"${department}" is not a department.`);

  /*
   * A code is generated from the name rather than asked for. It is what the
   * reports key on and what a clinic should never have to think about, and
   * one typed by hand is one that will collide with a seeded heading.
   */
  const base = `CL-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20)}`
    || 'CL-HEADING';
  let code = base;
  for (let n = 2; db.prepare('SELECT 1 FROM expense_categories WHERE code = ?').get(code); n += 1) {
    code = `${base}-${n}`;
  }
  if (db.prepare('SELECT 1 FROM expense_categories WHERE LOWER(name) = LOWER(?)').get(name)) {
    throw conflict(`There is already a heading called "${name}".`);
  }

  const last = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS m FROM expense_categories WHERE cost_group = ?').get(group).m;
  const info = db.prepare(
    `INSERT INTO expense_categories
       (code, name, cost_group, nature, report_line, default_department, cash_category,
        is_direct, is_fixed, note, seeded, active, sort_order, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`
  ).run(code, name, group, nature,
    input.reportLine || (nature === 'operating' ? 'maintenanceAdmin' : null),
    department, input.cashCategory || 'Other expense',
    input.direct ? 1 : 0, input.fixed ? 1 : 0,
    String(input.note || '').trim() || null, last + 10, userId || null);

  for (const name2 of (Array.isArray(input.items) ? input.items : [])) {
    const trimmed = String(name2 || '').trim();
    if (trimmed) createItem(info.lastInsertRowid, { name: trimmed }, userId);
  }
  return categoryById(info.lastInsertRowid);
}

/**
 * Changing a heading.
 *
 * The name, the note, the order and whether it is offered are the clinic's.
 * The code never changes, because every report totals by it, and on a seeded
 * heading neither does the group or the nature: those are what keep the
 * owner's board adding up, and a clinic that moved "Rent" into the setup
 * group would silently take rent out of its own operating costs.
 */
function updateCategory(id, patch, { seededMayMove = false } = {}) {
  const row = categoryById(id);
  if (!row) throw notFound('Expense heading not found');

  const name = patch.name === undefined ? row.name : String(patch.name).trim();
  if (!name) throw badRequest('A heading needs a name.');
  if (db.prepare('SELECT 1 FROM expense_categories WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, id)) {
    throw conflict(`There is already a heading called "${name}".`);
  }

  let group = row.cost_group;
  let nature = row.nature;
  if (patch.group !== undefined || patch.nature !== undefined) {
    if (row.seeded && !seededMayMove) {
      throw badRequest('This heading ships with the system. Its name can be changed; which group '
        + 'and nature it has cannot, because the reports are built on them.');
    }
    group = patch.group === undefined ? group : String(patch.group);
    nature = patch.nature === undefined ? nature : String(patch.nature);
    if (!book.GROUPS.some((g) => g.key === group)) throw badRequest(`"${group}" is not one of the groups.`);
    if (!book.NATURES.includes(nature)) throw badRequest(`"${nature}" is not a nature a heading can have.`);
  }

  const department = patch.department === undefined ? row.default_department : String(patch.department);
  if (!book.DEPARTMENT_KEYS.includes(department)) throw badRequest(`"${department}" is not a department.`);

  db.prepare(
    `UPDATE expense_categories
        SET name = ?, cost_group = ?, nature = ?, default_department = ?, note = ?,
            active = ?, sort_order = ?, report_line = ?, cash_category = ?
      WHERE id = ?`
  ).run(name, group, nature, department,
    patch.note === undefined ? row.note : (String(patch.note).trim() || null),
    patch.active === undefined ? row.active : (patch.active ? 1 : 0),
    patch.sortOrder === undefined ? row.sort_order : Number(patch.sortOrder) || 0,
    patch.reportLine === undefined ? row.report_line : (patch.reportLine || null),
    patch.cashCategory === undefined ? row.cash_category : (patch.cashCategory || 'Other expense'),
    id);
  return categoryById(id);
}

/**
 * Removing a heading, which is almost always the wrong thing to want.
 *
 * One that has been used is switched off instead, whatever was asked for:
 * deleting it would orphan every expense booked under it, and those are the
 * clinic's own records of money it spent.
 */
function deleteCategory(id) {
  const row = categoryById(id);
  if (!row) throw notFound('Expense heading not found');
  if (row.seeded) throw badRequest('A heading that ships with the system can be switched off, not removed.');
  if (row.used) {
    db.prepare('UPDATE expense_categories SET active = 0 WHERE id = ?').run(id);
    return { ...categoryById(id), switchedOff: true };
  }
  db.prepare('DELETE FROM expense_categories WHERE id = ?').run(id);
  return { removed: true, id, name: row.name };
}

function createItem(categoryId, input, userId) {
  const category = categoryById(categoryId);
  if (!category) throw notFound('Expense heading not found');
  const name = String(input.name || '').trim();
  if (!name) throw badRequest('Give the item a name.');
  if (db.prepare('SELECT 1 FROM expense_items WHERE category_id = ? AND LOWER(name) = LOWER(?)')
    .get(categoryId, name)) {
    throw conflict(`"${category.name}" already has an item called "${name}".`);
  }
  const last = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS m FROM expense_items WHERE category_id = ?').get(categoryId).m;
  const info = db.prepare(
    'INSERT INTO expense_items (category_id, name, seeded, active, sort_order, created_by) VALUES (?, ?, 0, 1, ?, ?)'
  ).run(categoryId, name, last + 10, userId || null);
  return db.prepare('SELECT * FROM expense_items WHERE id = ?').get(info.lastInsertRowid);
}

function updateItem(id, patch) {
  const row = db.prepare('SELECT * FROM expense_items WHERE id = ?').get(id);
  if (!row) throw notFound('Item not found');
  const name = patch.name === undefined ? row.name : String(patch.name).trim();
  if (!name) throw badRequest('An item needs a name.');
  db.prepare('UPDATE expense_items SET name = ?, active = ?, sort_order = ? WHERE id = ?')
    .run(name, patch.active === undefined ? row.active : (patch.active ? 1 : 0),
      patch.sortOrder === undefined ? row.sort_order : Number(patch.sortOrder) || 0, id);
  return db.prepare('SELECT * FROM expense_items WHERE id = ?').get(id);
}

function deleteItem(id) {
  const row = db.prepare('SELECT * FROM expense_items WHERE id = ?').get(id);
  if (!row) throw notFound('Item not found');
  const used = db.prepare('SELECT COUNT(*) AS c FROM expenses WHERE item_id = ?').get(id).c;
  if (used || row.seeded) {
    db.prepare('UPDATE expense_items SET active = 0 WHERE id = ?').run(id);
    return { ...db.prepare('SELECT * FROM expense_items WHERE id = ?').get(id), switchedOff: true };
  }
  db.prepare('DELETE FROM expense_items WHERE id = ?').run(id);
  return { removed: true, id, name: row.name };
}

/* -------------------------------------------------------------- the ledger */

const SELECT = `
  SELECT e.*, c.code AS category_code, c.name AS category_name, c.cost_group, c.nature,
         c.report_line, c.cash_category, i.name AS item_name,
         s.name AS supplier_account, u.name AS entered_by_name, a.name AS approved_by_name,
         v.name AS voided_by_name,
         (SELECT COUNT(*) FROM expense_attachments x WHERE x.expense_id = e.id) AS attachments,
         ROUND(e.total - e.paid, 2) AS outstanding
    FROM expenses e
    JOIN expense_categories c ON c.id = e.category_id
    LEFT JOIN expense_items i ON i.id = e.item_id
    LEFT JOIN suppliers s ON s.id = e.supplier_id
    LEFT JOIN users u ON u.id = e.created_by
    LEFT JOIN users a ON a.id = e.approved_by
    LEFT JOIN users v ON v.id = e.voided_by`;

const one = (id) => db.prepare(`${SELECT} WHERE e.id = ?`).get(id);

/** Everything about one expense, including how it was paid and what is filed. */
function detail(id) {
  const row = one(id);
  if (!row) throw notFound('Expense not found');
  row.payments = db.prepare(
    `SELECT p.*, u.name AS paid_by_name, cb.ref_no AS cash_ref
       FROM expense_payments p
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN cash_book cb ON cb.id = p.cash_book_id
      WHERE p.expense_id = ? ORDER BY date(p.paid_on), p.id`).all(id);
  row.files = db.prepare(
    `SELECT x.id, x.kind, x.filename, x.mime, x.bytes, x.uploaded_at, u.name AS uploaded_by_name
       FROM expense_attachments x LEFT JOIN users u ON u.id = x.uploaded_by
      WHERE x.expense_id = ? ORDER BY x.id`).all(id);
  return row;
}

/**
 * What the three money figures must come to.
 *
 * A counter usually has one number in front of it — the total on the bill —
 * and typing it three times is how a tax figure ends up wrong. So the total
 * alone is enough; give the split and it is checked, because a split that
 * does not add up is a bill somebody has misread.
 */
function amounts(input) {
  const has = (v) => v !== undefined && v !== null && v !== '';
  const taxable = has(input.taxable) ? round2(input.taxable) : null;
  const tax = has(input.tax) ? round2(input.tax) : null;
  const total = has(input.total) ? round2(input.total) : null;

  if (total === null && taxable === null) throw badRequest('What did the bill come to?');
  if (total === null) return { taxable, tax: tax || 0, total: round2(taxable + (tax || 0)) };
  if (taxable === null) return { taxable: round2(total - (tax || 0)), tax: tax || 0, total };
  const sum = round2(taxable + (tax || 0));
  if (Math.abs(sum - total) > 0.011) {
    throw badRequest(`The bill does not add up: ${taxable} before tax plus ${tax || 0} tax `
      + `comes to ${sum}, not ${total}.`);
  }
  return { taxable, tax: tax || 0, total };
}

const statusOf = (total, paid) => {
  if (paid >= round2(total) - 0.009) return 'paid';
  return paid > 0.009 ? 'part_paid' : 'unpaid';
};

/**
 * Book an expense.
 *
 * `paidNow` is the common case at a counter — a bill paid as it is handed
 * over — and saves the cashier a second screen. It writes a payment, which
 * writes the cash book line, in the same transaction as the expense itself.
 */
function create(input, userId) {
  const category = input.categoryId ? categoryById(Number(input.categoryId))
    : (input.categoryCode ? categoryByCode(String(input.categoryCode)) : null);
  if (!category) throw badRequest('Which heading is this under?');
  if (!category.active) throw badRequest(`"${category.name}" is switched off and cannot be booked to.`);

  let itemId = null;
  if (input.itemId) {
    const item = db.prepare('SELECT * FROM expense_items WHERE id = ?').get(Number(input.itemId));
    if (!item) throw notFound('Item not found');
    if (item.category_id !== category.id) {
      throw badRequest(`"${item.name}" is not an item under "${category.name}".`);
    }
    itemId = item.id;
  }

  const department = String(input.department || category.default_department);
  if (!book.DEPARTMENT_KEYS.includes(department)) {
    throw badRequest(`"${department}" is not one of the clinic's departments.`,
      { departments: book.DEPARTMENT_KEYS });
  }

  const invoiceDate = String(input.invoiceDate || today());
  if (!isDate(invoiceDate)) throw badRequest('Give the invoice date as YYYY-MM-DD.');
  if (invoiceDate > today()) throw badRequest('An invoice cannot be dated in the future.');

  const { taxable, tax, total } = amounts(input);
  if (!(total > 0)) throw badRequest('An expense has to be more than nothing.');

  const periodFrom = input.periodFrom ? String(input.periodFrom) : null;
  const periodTo = input.periodTo ? String(input.periodTo) : null;
  for (const [label, value] of [['from', periodFrom], ['to', periodTo]]) {
    if (value && !isDate(value)) throw badRequest(`Give the billing period ${label} as YYYY-MM-DD.`);
  }
  if (periodFrom && periodTo && periodFrom > periodTo) {
    throw badRequest('The billing period ends before it starts.');
  }
  const dueDate = input.dueDate ? String(input.dueDate) : null;
  if (dueDate && !isDate(dueDate)) throw badRequest('Give the due date as YYYY-MM-DD.');
  if (dueDate && dueDate < invoiceDate) throw badRequest('A bill cannot fall due before it was raised.');

  let supplierId = null;
  if (input.supplierId) {
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(input.supplierId));
    if (!supplier) throw notFound('Supplier not found');
    supplierId = supplier.id;
  }
  const supplierName = String(input.supplierName || '').trim() || null;
  if (!supplierId && !supplierName) throw badRequest('Who was it paid to?');

  const paidNow = input.paidNow ? round2(input.paidNow) : 0;
  if (paidNow < 0) throw badRequest('A payment cannot be negative.');
  if (paidNow - total > 0.009) throw badRequest(`That is more than the bill: ${total}.`);

  const refNo = generate('expense');
  const id = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO expenses
         (ref_no, category_id, item_id, department, supplier_id, supplier_name, description,
          invoice_no, invoice_date, period_from, period_to, taxable, tax, total, due_date,
          status, paid, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 0, ?, ?)`
    ).run(refNo, category.id, itemId, department, supplierId, supplierName,
      String(input.description || '').trim() || null,
      String(input.invoiceNo || '').trim() || null,
      invoiceDate, periodFrom, periodTo, taxable, tax, total, dueDate,
      String(input.notes || '').trim() || null, userId || null);

    if (paidNow > 0) {
      payInternal(info.lastInsertRowid, {
        amount: paidNow,
        paidOn: input.paidOn || invoiceDate,
        mode: input.mode,
        reference: input.paymentReference,
      }, userId);
    }
    return info.lastInsertRowid;
  })();

  return detail(id);
}

/**
 * Pay something, in part or in full.
 *
 * The cash book line is written here rather than left to whoever remembers:
 * the money left the drawer, the cash book is where money leaving the drawer
 * is recorded, and two books kept by hand drift apart within a month.
 */
function payInternal(expenseId, input, userId) {
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId);
  if (!expense) throw notFound('Expense not found');
  if (expense.voided_at) throw conflict('That expense has been voided.');

  const amount = round2(input.amount);
  if (!(amount > 0)) throw badRequest('A payment has to be more than nothing.');
  const outstanding = round2(expense.total - expense.paid);
  if (amount - outstanding > 0.009) {
    throw badRequest(`That is more than is outstanding on this bill (${outstanding.toFixed(2)}).`);
  }

  const paidOn = String(input.paidOn || today());
  if (!isDate(paidOn)) throw badRequest('Give the payment date as YYYY-MM-DD.');
  if (paidOn > today()) throw badRequest('A payment cannot be dated in the future.');

  const mode = MODES.includes(String(input.mode)) ? String(input.mode) : 'cash';
  const category = categoryById(expense.category_id);
  const payee = expense.supplier_name
    || (expense.supplier_id
      ? db.prepare('SELECT name FROM suppliers WHERE id = ?').get(expense.supplier_id)?.name
      : null)
    || category.name;

  const cashInfo = db.prepare(
    `INSERT INTO cash_book (ref_no, direction, category, amount, entry_date, mode,
                            payee, reference, notes, supplier_id, created_by)
     VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(generate('cashEntry'), category.cash_category || 'Other expense', amount, paidOn, mode,
    payee, String(input.reference || '').trim() || null,
    `${expense.ref_no}${expense.invoice_no ? ` · invoice ${expense.invoice_no}` : ''}`
    + `${category.name ? ` · ${category.name}` : ''}`,
    expense.supplier_id, userId || null);

  const payInfo = db.prepare(
    `INSERT INTO expense_payments (expense_id, amount, paid_on, mode, reference, cash_book_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(expenseId, amount, paidOn, mode, String(input.reference || '').trim() || null,
    cashInfo.lastInsertRowid, userId || null);

  const paid = round2(expense.paid + amount);
  db.prepare('UPDATE expenses SET paid = ?, status = ? WHERE id = ?')
    .run(paid, statusOf(expense.total, paid), expenseId);

  return { paymentId: payInfo.lastInsertRowid, cashBookId: cashInfo.lastInsertRowid, paid };
}

function pay(expenseId, input, userId) {
  db.transaction(() => payInternal(expenseId, input, userId))();
  return detail(expenseId);
}

/**
 * Taking a payment back out.
 *
 * The cash book line goes with it, voided rather than deleted and carrying
 * the same reason, so the two books cannot disagree about what was paid.
 */
function voidPayment(paymentId, reason, userId) {
  const row = db.prepare('SELECT * FROM expense_payments WHERE id = ?').get(paymentId);
  if (!row) throw notFound('Payment not found');
  if (!String(reason || '').trim()) throw badRequest('Say why the payment is being taken off.');

  db.transaction(() => {
    if (row.cash_book_id) {
      db.prepare(
        `UPDATE cash_book SET voided_at = datetime('now'), voided_by = ?, void_reason = ?
          WHERE id = ? AND voided_at IS NULL`
      ).run(userId || null, String(reason).trim(), row.cash_book_id);
    }
    db.prepare('DELETE FROM expense_payments WHERE id = ?').run(paymentId);
    const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(row.expense_id);
    const paid = round2(db.prepare(
      'SELECT COALESCE(SUM(amount), 0) AS s FROM expense_payments WHERE expense_id = ?')
      .get(row.expense_id).s);
    db.prepare('UPDATE expenses SET paid = ?, status = ? WHERE id = ?')
      .run(paid, statusOf(expense.total, paid), row.expense_id);
  })();
  return detail(row.expense_id);
}

/** Correcting the paperwork on an expense. The money is corrected by payment. */
function update(id, patch) {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!row) throw notFound('Expense not found');
  if (row.voided_at) throw conflict('That expense has been voided. Book a new one instead.');

  const merged = {
    taxable: patch.taxable === undefined ? row.taxable : patch.taxable,
    tax: patch.tax === undefined ? row.tax : patch.tax,
    total: patch.total === undefined ? row.total : patch.total,
  };
  // Re-derive rather than trust: a corrected total with the old tax beside it
  // is exactly the bill that stops adding up three months later.
  const money = patch.total !== undefined && patch.taxable === undefined && patch.tax === undefined
    ? { total: round2(patch.total), tax: row.tax, taxable: round2(round2(patch.total) - row.tax) }
    : amounts(merged);
  if (money.total < row.paid - 0.009) {
    throw badRequest(`${row.paid.toFixed(2)} has already been paid on this bill, so it cannot be `
      + `corrected down to ${money.total.toFixed(2)}. Take the payment off first.`);
  }

  let categoryId = row.category_id;
  let itemId = row.item_id;
  if (patch.categoryId !== undefined) {
    const category = categoryById(Number(patch.categoryId));
    if (!category) throw notFound('Expense heading not found');
    categoryId = category.id;
    itemId = null;                       // the old item belonged to the old heading
  }
  if (patch.itemId !== undefined && patch.itemId !== null && patch.itemId !== '') {
    const item = db.prepare('SELECT * FROM expense_items WHERE id = ?').get(Number(patch.itemId));
    if (!item || item.category_id !== categoryId) throw badRequest('That item is not under this heading.');
    itemId = item.id;
  }

  const department = patch.department === undefined ? row.department : String(patch.department);
  if (!book.DEPARTMENT_KEYS.includes(department)) throw badRequest(`"${department}" is not a department.`);

  const invoiceDate = patch.invoiceDate === undefined ? row.invoice_date : String(patch.invoiceDate);
  if (!isDate(invoiceDate)) throw badRequest('Give the invoice date as YYYY-MM-DD.');
  if (invoiceDate > today()) throw badRequest('An invoice cannot be dated in the future.');

  db.prepare(
    `UPDATE expenses
        SET category_id = ?, item_id = ?, department = ?, supplier_id = ?, supplier_name = ?,
            description = ?, invoice_no = ?, invoice_date = ?, period_from = ?, period_to = ?,
            taxable = ?, tax = ?, total = ?, due_date = ?, notes = ?, status = ?
      WHERE id = ?`
  ).run(categoryId, itemId, department,
    patch.supplierId === undefined ? row.supplier_id : (patch.supplierId ? Number(patch.supplierId) : null),
    patch.supplierName === undefined ? row.supplier_name : (String(patch.supplierName).trim() || null),
    patch.description === undefined ? row.description : (String(patch.description).trim() || null),
    patch.invoiceNo === undefined ? row.invoice_no : (String(patch.invoiceNo).trim() || null),
    invoiceDate,
    patch.periodFrom === undefined ? row.period_from : (patch.periodFrom || null),
    patch.periodTo === undefined ? row.period_to : (patch.periodTo || null),
    money.taxable, money.tax, money.total,
    patch.dueDate === undefined ? row.due_date : (patch.dueDate || null),
    patch.notes === undefined ? row.notes : (String(patch.notes).trim() || null),
    statusOf(money.total, row.paid), id);

  return detail(id);
}

/** Management signing off a bill. Who, when, and anything they wanted said. */
function approve(id, note, userId) {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!row) throw notFound('Expense not found');
  if (row.voided_at) throw conflict('That expense has been voided.');
  db.prepare("UPDATE expenses SET approved_by = ?, approved_at = datetime('now'), approval_note = ? WHERE id = ?")
    .run(userId || null, String(note || '').trim() || null, id);
  return detail(id);
}

/**
 * Voiding, which is the only way a line leaves the totals.
 *
 * Its payments go with it — voided in the cash book too, with the same
 * reason — because an expense that never was cannot have been paid, and a
 * cash book line left behind would be money out of a drawer with nothing to
 * show for it.
 */
function voidExpense(id, reason, userId) {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!row) throw notFound('Expense not found');
  if (row.voided_at) throw conflict('That expense is already voided.');
  if (!String(reason || '').trim()) throw badRequest('Say why the expense is being voided.');

  db.transaction(() => {
    for (const p of db.prepare('SELECT * FROM expense_payments WHERE expense_id = ?').all(id)) {
      if (!p.cash_book_id) continue;
      db.prepare(
        `UPDATE cash_book SET voided_at = datetime('now'), voided_by = ?, void_reason = ?
          WHERE id = ? AND voided_at IS NULL`
      ).run(userId || null, `Expense ${row.ref_no} voided — ${String(reason).trim()}`, p.cash_book_id);
    }
    db.prepare(
      "UPDATE expenses SET status = 'void', voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ?"
    ).run(userId || null, String(reason).trim(), id);
  })();
  return detail(id);
}

/* -------------------------------------------------------------- the listing */

function list(query = {}) {
  const from = query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const to = query.to || today();
  const clauses = ['date(e.invoice_date) BETWEEN date(?) AND date(?)'];
  const params = [from, to];

  if (query.categoryId) { clauses.push('e.category_id = ?'); params.push(Number(query.categoryId)); }
  if (query.group) { clauses.push('c.cost_group = ?'); params.push(String(query.group)); }
  if (query.department) { clauses.push('e.department = ?'); params.push(String(query.department)); }
  if (query.status) { clauses.push('e.status = ?'); params.push(String(query.status)); }
  if (query.supplierId) { clauses.push('e.supplier_id = ?'); params.push(Number(query.supplierId)); }
  if (query.unpaidOnly) clauses.push("e.status IN ('unpaid','part_paid')");
  if (query.q) {
    clauses.push(`(e.ref_no LIKE ? OR e.invoice_no LIKE ? OR e.supplier_name LIKE ?
                   OR e.description LIKE ? OR s.name LIKE ?)`);
    const like = `%${query.q}%`;
    params.push(like, like, like, like, like);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
  const page = Math.max(Number(query.page) || 1, 1);

  const rows = db.prepare(
    `${SELECT} ${where} ORDER BY date(e.invoice_date) DESC, e.id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, (page - 1) * limit);

  const totals = db.prepare(
    `SELECT COALESCE(SUM(e.total), 0) AS billed,
            COALESCE(SUM(e.paid), 0) AS paid,
            COALESCE(SUM(e.total - e.paid), 0) AS outstanding,
            COALESCE(SUM(e.tax), 0) AS tax,
            COUNT(*) AS entries
       FROM expenses e JOIN expense_categories c ON c.id = e.category_id
       LEFT JOIN suppliers s ON s.id = e.supplier_id
       ${where} AND e.voided_at IS NULL`
  ).get(...params);

  return {
    from, to, page, limit, rows,
    total: db.prepare(`SELECT COUNT(*) AS c FROM expenses e
                         JOIN expense_categories c2 ON c2.id = e.category_id
                         LEFT JOIN suppliers s ON s.id = e.supplier_id ${where.replace(/\bc\./g, 'c2.')}`)
      .get(...params).c,
    totals: {
      billed: round2(totals.billed), paid: round2(totals.paid),
      outstanding: round2(totals.outstanding), tax: round2(totals.tax), entries: totals.entries,
    },
  };
}

/** What is owed, oldest first, with how long it has been owed. */
function payable() {
  return db.prepare(
    `${SELECT}
      WHERE e.voided_at IS NULL AND e.status IN ('unpaid','part_paid')
      ORDER BY COALESCE(e.due_date, e.invoice_date), e.id`
  ).all().map((r) => ({
    ...r,
    days_overdue: r.due_date
      ? Math.max(0, Math.round((Date.now() - Date.parse(`${r.due_date}T00:00:00Z`)) / 86400000))
      : null,
  }));
}

module.exports = {
  MODES,
  categories, categoryById, categoryByCode,
  createCategory, updateCategory, deleteCategory,
  createItem, updateItem, deleteItem,
  create, update, detail, list, pay, voidPayment, voidExpense, approve, payable,
  round2, statusOf,
};
