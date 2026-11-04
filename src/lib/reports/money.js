'use strict';
/**
 * Stock, people, money and the clinic's position.
 *
 * The second half of the owner's shelf. The same two rules hold: a report
 * says what it cannot know, and a number carries the denominator it came
 * from. Two more apply to everything in this file, because they are where a
 * clinic's own figures most often mislead it:
 *
 *   Collected is not billed, and both are needed. Collections tell you
 *   whether the clinic can pay its staff this week; billings tell you
 *   whether the work is worth doing. A report that silently uses one and is
 *   read as the other causes decisions nobody intended, so each says which
 *   it is in its own subtitle.
 *
 *   Ageing is counted from the invoice, not from today's balance. A bill
 *   half-paid last week is not a fresh bill; its unpaid half is as old as
 *   the day it was raised, and bucketing it by last activity is how a ledger
 *   quietly reports itself as healthier than it is.
 */
const { db } = require('../../db');
const commercial = require('../commercial');
const { T, r2, pct, today, has, count } = require('./registry');

const daysBetween = (a, b) => Math.round(
  (new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/* ========================================================= stock & supply */

const pharmacyStock = {
  key: 'pharmacy-stock',
  group: 'stock',
  title: 'Pharmacy sales, stock and stockout',
  subtitle: 'What sold, what is left, and what ran out',
  run({ from, to }) {
    const rows = db.prepare(
      `SELECT dr.id, dr.name, dr.strength, dr.form,
              COALESCE(SUM(si.qty), 0) AS sold,
              COALESCE(SUM(si.amount), 0) AS revenue,
              (SELECT COALESCE(SUM(b.qty_available), 0) FROM drug_batches b WHERE b.drug_id = dr.id) AS on_hand,
              (SELECT COALESCE(SUM(b.qty_available * b.purchase_price), 0)
                 FROM drug_batches b WHERE b.drug_id = dr.id) AS stock_value,
              dr.reorder_level
         FROM drugs dr
         LEFT JOIN pharmacy_sale_items si ON si.drug_id = dr.id
              AND si.sale_id IN (SELECT id FROM pharmacy_sales
                                  WHERE status != 'cancelled'
                                    AND date(created_at) BETWEEN date(?) AND date(?))
        WHERE dr.active = 1
        GROUP BY dr.id
        ORDER BY sold DESC, dr.name`).all(from, to);

    const days = Math.max(daysBetween(from, to) + 1, 1);
    const priced = rows.map((r) => {
      const perDay = r.sold / days;
      return {
        ...r,
        revenue: r2(r.revenue),
        stock_value: r2(r.stock_value),
        // Days of cover is the figure that turns a stock list into a warning:
        // 400 tablets is a lot of something nobody buys and a day and a half
        // of something everybody does.
        days_cover: perDay > 0 ? Math.round((r.on_hand / perDay) * 10) / 10 : null,
        state: r.on_hand <= 0 ? 'Out of stock'
          : (r.reorder_level && r.on_hand <= r.reorder_level) ? 'At reorder level'
            : perDay > 0 && r.on_hand / perDay < 7 ? 'Under a week left' : 'In stock',
      };
    });

    const out = priced.filter((r) => r.on_hand <= 0);
    const movedAndOut = out.filter((r) => r.sold > 0);
    return {
      columns: [
        { key: 'name', label: 'Medicine', type: T.text, strong: true },
        { key: 'strength', label: 'Strength', type: T.text },
        { key: 'sold', label: 'Sold', type: T.num },
        { key: 'revenue', label: 'Revenue', type: T.money },
        { key: 'on_hand', label: 'On hand', type: T.num },
        { key: 'days_cover', label: 'Days of cover', type: T.num },
        { key: 'stock_value', label: 'Stock at cost', type: T.money },
        { key: 'state', label: 'State', type: T.badge },
      ],
      rows: priced,
      tiles: [
        { label: 'Lines sold', value: priced.filter((r) => r.sold > 0).length },
        { label: 'Sales value', value: r2(priced.reduce((t, r) => t + r.revenue, 0)), money: true },
        { label: 'Stock on hand', value: r2(priced.reduce((t, r) => t + r.stock_value, 0)),
          money: true, foot: 'at what it cost' },
        { label: 'Out of stock', value: out.length, tone: movedAndOut.length ? 'warn' : 'ok',
          foot: `${movedAndOut.length} of them sold in this period — those are the lost sales` },
      ],
      notes: [
        'Days of cover uses this period\'s rate of sale. A medicine that sold nothing has no rate and no cover figure, which is not the same as having plenty.',
        'A stockout only costs the clinic money if the medicine was moving. Both counts are given.',
      ],
    };
  },
};

const expiryWastage = {
  key: 'expiry',
  group: 'stock',
  title: 'Near-expiry, expired stock and wastage',
  subtitle: 'What is about to be lost, and what already was',
  run({ from, to }) {
    const soon = db.prepare(
      `SELECT b.batch_no, dr.name AS drug, b.expiry_date, b.qty_available,
              b.purchase_price, b.qty_available * b.purchase_price AS value,
              CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_left
         FROM drug_batches b JOIN drugs dr ON dr.id = b.drug_id
        WHERE b.qty_available > 0
          AND julianday(b.expiry_date) - julianday('now') < 120
        ORDER BY b.expiry_date`).all();

    const written = db.prepare(
      `SELECT date(l.created_at) AS day, l.txn_type AS kind, dr.name AS drug,
              b.batch_no, -l.qty_delta AS qty,
              -l.qty_delta * COALESCE(b.purchase_price, 0) AS value, l.notes
         FROM stock_ledger l
         JOIN drugs dr ON dr.id = l.drug_id
         LEFT JOIN drug_batches b ON b.id = l.batch_id
        WHERE l.txn_type IN ('expiry','adjustment') AND l.qty_delta < 0
          AND date(l.created_at) BETWEEN date(?) AND date(?)
        ORDER BY value DESC`).all(from, to);

    const expired = soon.filter((r) => r.days_left < 0);
    const within30 = soon.filter((r) => r.days_left >= 0 && r.days_left <= 30);
    const lost = r2(written.reduce((t, r) => t + r.value, 0));

    return {
      columns: [
        { key: 'drug', label: 'Medicine', type: T.text, strong: true },
        { key: 'batch_no', label: 'Batch', type: T.text },
        { key: 'expiry_date', label: 'Expires', type: T.date },
        { key: 'days_left', label: 'Days left', type: T.num },
        { key: 'qty_available', label: 'On hand', type: T.num },
        { key: 'value', label: 'At risk', type: T.money },
      ],
      rows: soon.map((r) => ({ ...r, value: r2(r.value) })),
      tiles: [
        { label: 'Already expired, still on the shelf', value: expired.length,
          tone: expired.length ? 'danger' : 'ok',
          foot: `${r2(expired.reduce((t, r) => t + r.value, 0))} at cost — and it must not be dispensed` },
        { label: 'Expiring within 30 days', value: within30.length, tone: within30.length ? 'warn' : 'ok',
          foot: `${r2(within30.reduce((t, r) => t + r.value, 0))} at cost` },
        { label: 'Written off in the period', value: lost, money: true },
        { label: 'Entries', value: written.length, foot: 'expiry and adjustment lines' },
      ],
      lists: written.length ? [{ title: 'What was written off', rows: written,
        columns: [
          { key: 'day', label: 'Date', type: T.date },
          { key: 'drug', label: 'Medicine', type: T.text },
          { key: 'batch_no', label: 'Batch', type: T.text },
          { key: 'kind', label: 'Why', type: T.badge },
          { key: 'qty', label: 'Quantity', type: T.num },
          { key: 'value', label: 'Cost', type: T.money },
        ] }] : [],
      notes: [
        'The near-expiry list is live, not confined to the date range: a batch expiring next week is next week\'s problem whichever month you are looking at.',
        'Expired stock still showing a quantity has not been written off. Until it is, it is both a loss the accounts have not taken and a pack somebody could dispense.',
      ],
      warn: expired.length
        ? `${expired.length} expired batch${expired.length > 1 ? 'es are' : ' is'} still showing stock on hand.`
        : null,
    };
  },
};

const purchaseOrders = {
  key: 'purchases',
  group: 'stock',
  title: 'Purchase orders, goods received and pending supplies',
  subtitle: 'What was ordered, what arrived, and what is owed on it',
  run({ from, to }) {
    const rows = db.prepare(
      `SELECT sp.grn_no, s.name AS supplier, sp.invoice_no, sp.invoice_date,
              sp.received_at, sp.net, sp.paid, sp.net - sp.paid AS due,
              sp.due_date, sp.status,
              (SELECT COUNT(*) FROM stock_purchase_items i WHERE i.purchase_id = sp.id) AS lines
         FROM stock_purchases sp
         LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE date(sp.received_at) BETWEEN date(?) AND date(?)
        ORDER BY sp.received_at DESC`).all(from, to);

    const overdue = db.prepare(
      `SELECT sp.grn_no, s.name AS supplier, sp.net - sp.paid AS due, sp.due_date,
              CAST(julianday('now') - julianday(sp.due_date) AS INTEGER) AS days_overdue
         FROM stock_purchases sp
         LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.status != 'cancelled' AND sp.net - sp.paid > 0.01
          AND sp.due_date IS NOT NULL AND date(sp.due_date) < date('now')
        ORDER BY days_overdue DESC`).all();

    return {
      columns: [
        { key: 'grn_no', label: 'GRN', type: T.text },
        { key: 'supplier', label: 'Supplier', type: T.text, strong: true },
        { key: 'invoice_no', label: 'Invoice', type: T.text },
        { key: 'received_at', label: 'Received', type: T.date },
        { key: 'lines', label: 'Lines', type: T.num },
        { key: 'net', label: 'Value', type: T.money },
        { key: 'paid', label: 'Paid', type: T.money },
        { key: 'due', label: 'Outstanding', type: T.money },
        { key: 'due_date', label: 'Payable by', type: T.date },
        { key: 'status', label: 'Status', type: T.badge },
      ],
      rows: rows.map((r) => ({ ...r, net: r2(r.net), paid: r2(r.paid), due: r2(r.due) })),
      tiles: [
        { label: 'Goods received', value: rows.length, foot: 'deliveries booked in' },
        { label: 'Value received', value: r2(rows.reduce((t, r) => t + r.net, 0)), money: true },
        { label: 'Still unpaid on these', value: r2(rows.reduce((t, r) => t + r.due, 0)), money: true },
        { label: 'Overdue to suppliers', value: r2(overdue.reduce((t, r) => t + r.due, 0)),
          money: true, tone: overdue.length ? 'warn' : 'ok',
          foot: `${overdue.length} invoice${overdue.length === 1 ? '' : 's'} past their date` },
      ],
      lists: overdue.length ? [{ title: 'Past the date agreed with the supplier', rows: overdue,
        columns: [
          { key: 'supplier', label: 'Supplier', type: T.text },
          { key: 'grn_no', label: 'GRN', type: T.text },
          { key: 'due', label: 'Outstanding', type: T.money },
          { key: 'due_date', label: 'Was due', type: T.date },
          { key: 'days_overdue', label: 'Days late', type: T.num },
        ] }] : [],
      notes: [
        'The clinic books goods in on receipt, so this is a goods-received register. An order placed and not yet delivered is not recorded and cannot appear here.',
      ],
    };
  },
};

const inventoryValuation = {
  key: 'inventory',
  group: 'stock',
  title: 'Inventory valuation and stock variance',
  subtitle: 'What the shelf is worth, and whether the count agrees',
  run({ from, to }) {
    const byForm = db.prepare(
      `SELECT COALESCE(NULLIF(dr.form, ''), 'Unspecified') AS form,
              COUNT(DISTINCT dr.id) AS items,
              SUM(b.qty_available) AS units,
              SUM(b.qty_available * b.purchase_price) AS at_cost,
              SUM(b.qty_available * b.mrp) AS at_mrp
         FROM drug_batches b JOIN drugs dr ON dr.id = b.drug_id
        WHERE b.qty_available > 0
        GROUP BY form ORDER BY at_cost DESC`).all();

    const takes = db.prepare(
      `SELECT st.reference, st.counted_at, u.name AS counted_by, st.lines, st.variances,
              (SELECT COALESCE(SUM(ABS(sti.variance) * b.purchase_price), 0)
                 FROM stock_take_items sti JOIN drug_batches b ON b.id = sti.batch_id
                WHERE sti.take_id = st.id) AS variance_value
         FROM stock_takes st LEFT JOIN users u ON u.id = st.counted_by
        WHERE date(st.counted_at) BETWEEN date(?) AND date(?)
        ORDER BY st.counted_at DESC`).all(from, to);

    const unpriced = count(
      'SELECT COUNT(*) AS c FROM drug_batches WHERE qty_available > 0 AND (purchase_price IS NULL OR purchase_price = 0)');
    const totalCost = r2(byForm.reduce((t, r) => t + r.at_cost, 0));

    return {
      columns: [
        { key: 'form', label: 'Form', type: T.text, strong: true },
        { key: 'items', label: 'Items', type: T.num },
        { key: 'units', label: 'Units on hand', type: T.num },
        { key: 'at_cost', label: 'At cost', type: T.money },
        { key: 'at_mrp', label: 'At MRP', type: T.money },
        { key: 'markup', label: 'Markup held', type: T.money },
      ],
      rows: byForm.map((r) => ({ ...r, at_cost: r2(r.at_cost), at_mrp: r2(r.at_mrp),
        markup: r2(r.at_mrp - r.at_cost) })),
      tiles: [
        { label: 'Stock at cost', value: totalCost, money: true,
          foot: 'This is the balance-sheet figure' },
        { label: 'Stock at MRP', value: r2(byForm.reduce((t, r) => t + r.at_mrp, 0)), money: true,
          foot: 'What it would fetch, not what it is worth' },
        { label: 'Stock counts in the period', value: takes.length,
          tone: takes.length ? 'ok' : 'warn',
          foot: takes.length ? '' : 'nothing was counted — the valuation rests entirely on the book' },
        { label: 'Batches with no cost price', value: unpriced, tone: unpriced ? 'warn' : 'ok',
          foot: unpriced ? 'these count as worth nothing and understate the total' : '' },
      ],
      lists: takes.length ? [{ title: 'Stock counts and what they found', rows: takes,
        columns: [
          { key: 'reference', label: 'Count', type: T.text },
          { key: 'counted_at', label: 'When', type: T.date },
          { key: 'counted_by', label: 'By', type: T.text },
          { key: 'lines', label: 'Lines counted', type: T.num },
          { key: 'variances', label: 'Did not match', type: T.num },
          { key: 'variance_value', label: 'Value of the gap', type: T.money },
        ] }] : [],
      notes: [
        'Valued at purchase price, which is what an accountant will want. MRP is shown beside it only to make the margin held in stock visible; nobody should put MRP on a balance sheet.',
        'A variance is the book against the shelf. Persistent variance in one direction is not miscounting, it is leakage.',
      ],
    };
  },
};

const equipmentReport = {
  key: 'equipment',
  group: 'stock',
  title: 'Equipment breakdown, maintenance and calibration',
  subtitle: 'What broke, what was serviced, and what is out of date',
  run({ from, to }) {
    const events = db.prepare(
      `SELECT a.asset_no, a.name, a.category, e.kind, e.happened_on, e.detail,
              e.done_by, e.cost, e.next_due
         FROM asset_events e JOIN assets a ON a.id = e.asset_id
        WHERE date(e.happened_on) BETWEEN date(?) AND date(?)
        ORDER BY e.happened_on DESC`).all(from, to);

    const state = db.prepare(
      `SELECT a.asset_no, a.name, a.category, a.status, a.location,
              a.calibration_due, a.needs_calibration,
              CAST(julianday(a.calibration_due) - julianday('now') AS INTEGER) AS days_left,
              a.amc_until, a.warranty_until
         FROM assets a WHERE a.active = 1
        ORDER BY a.needs_calibration DESC, a.calibration_due IS NULL, a.calibration_due`).all();

    const expired = state.filter((r) => r.needs_calibration && r.days_left !== null && r.days_left < 0);
    const unset = state.filter((r) => r.needs_calibration && !r.calibration_due);
    const broken = state.filter((r) => r.status === 'under_repair');
    const repairs = events.filter((e) => e.kind === 'repair');

    return {
      columns: [
        { key: 'name', label: 'Asset', type: T.text, strong: true },
        { key: 'asset_no', label: 'Number', type: T.text },
        { key: 'category', label: 'Category', type: T.text },
        { key: 'status', label: 'Status', type: T.badge },
        { key: 'location', label: 'Where', type: T.text },
        { key: 'calibration_due', label: 'Calibration due', type: T.date },
        { key: 'days_left', label: 'Days', type: T.num },
        { key: 'amc_until', label: 'AMC until', type: T.date },
      ],
      rows: state,
      tiles: [
        { label: 'Calibration expired', value: expired.length,
          tone: expired.length ? 'danger' : 'ok',
          foot: expired.length ? 'Readings from these should not be relied on' : 'Nothing overdue' },
        { label: 'No calibration date entered', value: unset.length, tone: unset.length ? 'warn' : 'ok' },
        { label: 'Under repair now', value: broken.length, tone: broken.length ? 'warn' : 'ok' },
        { label: 'Spent on repairs and service', value: r2(events.reduce((t, e) => t + (e.cost || 0), 0)),
          money: true, foot: `${repairs.length} repair${repairs.length === 1 ? '' : 's'} in the period` },
      ],
      lists: events.length ? [{ title: 'What was done in the period', rows: events,
        columns: [
          { key: 'happened_on', label: 'Date', type: T.date },
          { key: 'name', label: 'Asset', type: T.text },
          { key: 'kind', label: 'What', type: T.badge },
          { key: 'detail', label: 'Detail', type: T.text },
          { key: 'done_by', label: 'By', type: T.text },
          { key: 'cost', label: 'Cost', type: T.money },
          { key: 'next_due', label: 'Next due', type: T.date },
        ] }] : [],
      notes: [
        'An expired calibration is not a maintenance ticket. It is a machine still printing numbers onto reports that patients are treated on.',
      ],
      warn: expired.length ? `${expired.length} asset${expired.length > 1 ? 's are' : ' is'} past its calibration date.` : null,
    };
  },
};

const complianceReport = {
  key: 'compliance',
  group: 'stock',
  title: 'Licence, insurance and compliance renewal',
  subtitle: 'What expires, and what would stop the clinic if it lapsed',
  needs: () => (has('compliance_items') && count('SELECT COUNT(*) AS c FROM compliance_items WHERE active = 1')
    ? null
    : 'No licence or policy has been recorded yet. The register exists — open "Compliance register" from this report to add the pharmacy licence, the biomedical-waste authorisation, the AERB registration, the fire NOC and the indemnity policy. Until they are in it, nothing here can warn you before one lapses.'),
  run() {
    const rows = db.prepare(
      `SELECT *, CAST(julianday(valid_till) - julianday('now') AS INTEGER) AS days_left
         FROM compliance_items WHERE active = 1
        ORDER BY valid_till IS NULL, valid_till`).all();
    const lapsed = rows.filter((r) => r.days_left !== null && r.days_left < 0 && r.status === 'active');
    const soon = rows.filter((r) => r.days_left !== null && r.days_left >= 0
      && r.days_left <= (r.renewal_notice_days || 60));

    return {
      columns: [
        { key: 'name', label: 'Item', type: T.text, strong: true },
        { key: 'kind', label: 'Kind', type: T.badge },
        { key: 'authority', label: 'Authority', type: T.text },
        { key: 'reference_no', label: 'Reference', type: T.text },
        { key: 'valid_till', label: 'Valid till', type: T.date },
        { key: 'days_left', label: 'Days left', type: T.num },
        { key: 'owner_name', label: 'Who renews it', type: T.text },
        { key: 'status', label: 'Status', type: T.badge },
      ],
      rows,
      tiles: [
        { label: 'On the register', value: rows.length },
        { label: 'Lapsed', value: lapsed.length, tone: lapsed.length ? 'danger' : 'ok' },
        { label: 'Due within the notice period', value: soon.length, tone: soon.length ? 'warn' : 'ok',
          foot: 'A licence takes weeks to renew; the notice period is per item' },
        { label: 'Renewal cost on file', value: r2(rows.reduce((t, r) => t + (r.cost || 0), 0)),
          money: true },
      ],
      notes: [
        'Live, and ignores the date range: a licence expiring next month is expiring next month whichever window you are looking at.',
        'This is the paperwork. Equipment calibration and AMC live on the asset register, which has its own report.',
        'An item with no expiry date entered cannot be warned about, and sits at the bottom of the list.',
      ],
      warn: lapsed.length ? `${lapsed.length} item${lapsed.length > 1 ? 's have' : ' has'} lapsed.` : null,
    };
  },
};

/* ================================================================= people */

const attendanceReport = {
  key: 'attendance',
  group: 'people',
  title: 'Staff attendance, shift coverage and overtime',
  subtitle: 'Who was in, which shifts were thin, and what the overtime cost',
  needs: () => (has('staff_attendance') && count('SELECT COUNT(*) AS c FROM staff_attendance')
    ? null
    : 'Nothing has been marked on the attendance register yet. It exists — open "Attendance" from this report to mark a day. Doctors have schedules and leave recorded already; everybody else had nothing, which is why overtime and a short-handed shift were invisible until the payroll arrived.'),
  run({ from, to }) {
    const rows = db.prepare(
      `SELECT u.name AS person, u.role, d.name AS department,
              COUNT(*) AS marked,
              SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
              SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
              SUM(CASE WHEN a.status = 'leave' THEN 1 ELSE 0 END) AS leave_days,
              SUM(CASE WHEN a.status = 'half_day' THEN 1 ELSE 0 END) AS half_days,
              COALESCE(SUM(a.worked_hours), 0) AS hours,
              COALESCE(SUM(a.overtime_hours), 0) AS overtime
         FROM staff_attendance a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN departments d ON d.id = u.department_id
        WHERE date(a.on_date) BETWEEN date(?) AND date(?)
        GROUP BY a.user_id ORDER BY overtime DESC, u.name`).all(from, to);

    const byShift = db.prepare(
      `SELECT a.on_date, a.shift, COUNT(*) AS on_duty
         FROM staff_attendance a
        WHERE a.status IN ('present','half_day')
          AND date(a.on_date) BETWEEN date(?) AND date(?)
        GROUP BY a.on_date, a.shift ORDER BY on_duty ASC LIMIT 15`).all(from, to);

    const overtime = rows.reduce((t, r) => t + r.overtime, 0);
    const absent = rows.reduce((t, r) => t + r.absent, 0);
    const marked = rows.reduce((t, r) => t + r.marked, 0);

    return {
      columns: [
        { key: 'person', label: 'Person', type: T.text, strong: true },
        { key: 'role', label: 'Role', type: T.badge },
        { key: 'department', label: 'Department', type: T.text },
        { key: 'present', label: 'Present', type: T.num },
        { key: 'absent', label: 'Absent', type: T.num },
        { key: 'leave_days', label: 'Leave', type: T.num },
        { key: 'hours', label: 'Hours worked', type: T.hours },
        { key: 'overtime', label: 'Overtime', type: T.hours, tone: 'warn' },
      ],
      rows,
      tiles: [
        { label: 'People marked', value: rows.length },
        { label: 'Days marked', value: marked },
        { label: 'Absences', value: absent, foot: `${pct(absent, marked) ?? 0}% of days marked` },
        { label: 'Overtime hours', value: Math.round(overtime * 10) / 10,
          tone: overtime ? 'warn' : 'ok',
          foot: 'Concentrated on a few names usually means a rota gap, not willing staff' },
      ],
      lists: byShift.length ? [{ title: 'Thinnest shifts in the period', rows: byShift,
        columns: [
          { key: 'on_date', label: 'Date', type: T.date },
          { key: 'shift', label: 'Shift', type: T.badge },
          { key: 'on_duty', label: 'On duty', type: T.num },
        ] }] : [],
      notes: [
        'Only days somebody marked appear here. An unmarked day is not an absence, and is not counted as one.',
        'Overtime hours are as recorded on the register; what they cost is in the payroll report.',
      ],
    };
  },
};

const payrollReport = {
  key: 'payroll',
  group: 'people',
  title: 'Payroll and doctor payout',
  subtitle: 'What each person was paid, and what the payouts came to',
  needs: () => (has('payroll_lines') && count('SELECT COUNT(*) AS c FROM payroll_lines')
    ? null
    : 'No payroll has been entered yet. The register exists — open "Payroll" from this report to enter a month. The cash book already has the total that left the bank; this is the only thing that can say whose it was, or whether one department\'s wage bill is growing.'),
  run({ from, to, period }) {
    const p = period || from.slice(0, 7);
    const rows = db.prepare(
      `SELECT pl.*, d.name AS department
         FROM payroll_lines pl
         LEFT JOIN departments d ON d.id = pl.department_id
        WHERE pl.period = ? ORDER BY pl.kind, pl.net_pay DESC`).all(p);

    const salary = rows.filter((r) => r.kind !== 'doctor_payout');
    const payout = rows.filter((r) => r.kind === 'doctor_payout');
    const net = (list) => r2(list.reduce((t, r) => t + r.net_pay, 0));

    /*
     * Beside what the cash book says actually left. The two should be close;
     * a persistent gap means either the payroll is not being entered or the
     * bank is paying something the payroll does not know about, and both are
     * worth knowing before the auditor finds them.
     */
    const cash = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM cash_book
        WHERE direction = 'out' AND voided_at IS NULL
          AND category IN ('Salaries & wages','Doctor fees & honorarium')
          AND strftime('%Y-%m', entry_date) = ?`).get(p).s;

    return {
      columns: [
        { key: 'person', label: 'Person', type: T.text, strong: true },
        { key: 'role', label: 'Role', type: T.badge },
        { key: 'department', label: 'Department', type: T.text },
        { key: 'kind', label: 'Kind', type: T.badge },
        { key: 'basic', label: 'Basic', type: T.money },
        { key: 'allowances', label: 'Allowances', type: T.money },
        { key: 'overtime', label: 'Overtime', type: T.money },
        { key: 'deductions', label: 'Deductions', type: T.money },
        { key: 'net_pay', label: 'Net pay', type: T.money },
        { key: 'paid_on', label: 'Paid', type: T.date },
      ],
      rows,
      tiles: [
        { label: 'Salaries', value: net(salary), money: true,
          foot: `${salary.length} people` },
        { label: 'Doctor payouts', value: net(payout), money: true,
          foot: `${payout.length} consultants` },
        { label: 'Overtime paid', value: r2(rows.reduce((t, r) => t + r.overtime, 0)), money: true },
        { label: 'Against the cash book', value: r2(cash), money: true,
          tone: Math.abs(cash - net(rows)) > 1 ? 'warn' : 'ok',
          foot: Math.abs(cash - net(rows)) > 1
            ? `${r2(Math.abs(cash - net(rows)))} apart from the payroll above`
            : 'agrees with the payroll' },
      ],
      notes: [
        'The period here is a calendar month and ignores the date range above, because payroll is run monthly.',
        'A gap against the cash book means either the payroll was not entered or the bank paid something the payroll does not know about.',
      ],
    };
  },
};

/* ================================================================== money */

const billingCollections = {
  key: 'billing',
  group: 'money',
  title: 'Billing, collections and outstanding',
  subtitle: 'Raised against received — two different questions',
  run({ from, to }) {
    const daily = db.prepare(
      `SELECT date(i.created_at) AS day,
              COUNT(*) AS bills, SUM(i.gross) AS gross,
              SUM(i.discount + i.sliding_discount + i.assistance_covered) AS concessions,
              SUM(i.net) AS billed, SUM(i.paid) AS paid_against,
              SUM(i.balance) AS balance
         FROM invoices i
        WHERE i.status NOT IN ('cancelled','draft')
          AND date(i.created_at) BETWEEN date(?) AND date(?)
        GROUP BY day ORDER BY day DESC`).all(from, to);

    const collected = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c FROM payments
        WHERE date(paid_at) BETWEEN date(?) AND date(?)`).get(from, to);

    const outstanding = db.prepare(
      `SELECT COALESCE(SUM(balance), 0) AS s, COUNT(*) AS c FROM invoices
        WHERE status IN ('unpaid','partial')`).get();

    const billed = r2(daily.reduce((t, d) => t + d.billed, 0));
    return {
      columns: [
        { key: 'day', label: 'Date', type: T.date },
        { key: 'bills', label: 'Bills', type: T.num },
        { key: 'gross', label: 'Gross', type: T.money },
        { key: 'concessions', label: 'Concessions', type: T.money },
        { key: 'billed', label: 'Net billed', type: T.money },
        { key: 'paid_against', label: 'Paid against them', type: T.money },
        { key: 'balance', label: 'Still open', type: T.money },
      ],
      rows: daily.map((d) => ({ ...d, gross: r2(d.gross), concessions: r2(d.concessions),
        billed: r2(d.billed), paid_against: r2(d.paid_against), balance: r2(d.balance) })),
      tiles: [
        { label: 'Net billed', value: billed, money: true, foot: 'work done in the period' },
        { label: 'Collected', value: r2(collected.s), money: true,
          foot: `${collected.c} receipts — includes money against older bills` },
        { label: 'Collection rate', value: pct(daily.reduce((t, d) => t + d.paid_against, 0), billed),
          pct: true, foot: 'of this period\'s own bills, settled so far' },
        { label: 'Outstanding, all time', value: r2(outstanding.s), money: true,
          tone: outstanding.s > 0 ? 'warn' : 'ok',
          foot: `${outstanding.c} unpaid or part-paid bills` },
      ],
      notes: [
        'Billed and collected are different questions and will not agree. Collections include money against bills raised before this period, and this period\'s bills may be settled after it.',
      ],
    };
  },
};

const paymentModes = {
  key: 'reconciliation',
  group: 'money',
  title: 'Cash, UPI, card and bank reconciliation',
  subtitle: 'What came in by each route, and what the cash book agrees with',
  run({ from, to }) {
    const modes = db.prepare(
      `SELECT mode, COUNT(*) AS receipts, SUM(amount) AS amount
         FROM payments WHERE date(paid_at) BETWEEN date(?) AND date(?)
        GROUP BY mode ORDER BY amount DESC`).all(from, to);

    const counter = db.prepare(
      `SELECT COALESCE(payment_mode, 'unrecorded') AS mode, COUNT(*) AS receipts,
              SUM(paid_amount) AS amount
         FROM pharmacy_sales
        WHERE sale_type = 'counter' AND status != 'cancelled'
          AND date(created_at) BETWEEN date(?) AND date(?)
        GROUP BY payment_mode`).all(from, to);

    const book = db.prepare(
      `SELECT mode, direction, SUM(amount) AS amount FROM cash_book
        WHERE voided_at IS NULL AND date(entry_date) BETWEEN date(?) AND date(?)
        GROUP BY mode, direction`).all(from, to);

    const merged = {};
    const add = (mode, field, amount, receipts) => {
      const k = mode || 'unrecorded';
      merged[k] = merged[k] || { mode: k, patient: 0, counter: 0, book_in: 0, book_out: 0, receipts: 0 };
      merged[k][field] += amount;
      merged[k].receipts += receipts || 0;
    };
    for (const m of modes) add(m.mode, 'patient', m.amount, m.receipts);
    for (const m of counter) add(m.mode, 'counter', m.amount, m.receipts);
    for (const b of book) add(b.mode, b.direction === 'in' ? 'book_in' : 'book_out', b.amount, 0);

    const rows = Object.values(merged).map((m) => ({
      ...m,
      patient: r2(m.patient), counter: r2(m.counter),
      book_in: r2(m.book_in), book_out: r2(m.book_out),
      takings: r2(m.patient + m.counter),
      net_movement: r2(m.patient + m.counter + m.book_in - m.book_out),
    })).sort((a, b) => b.takings - a.takings);

    const cashRow = rows.find((r) => r.mode === 'cash') || { takings: 0, book_out: 0, book_in: 0 };
    return {
      columns: [
        { key: 'mode', label: 'Route', type: T.badge, strong: true },
        { key: 'receipts', label: 'Receipts', type: T.num },
        { key: 'patient', label: 'Patient bills', type: T.money },
        { key: 'counter', label: 'Counter sales', type: T.money },
        { key: 'takings', label: 'Total taken', type: T.money },
        { key: 'book_in', label: 'Other income', type: T.money },
        { key: 'book_out', label: 'Paid out', type: T.money },
        { key: 'net_movement', label: 'Net movement', type: T.money },
      ],
      rows,
      tiles: [
        { label: 'Taken, all routes', value: r2(rows.reduce((t, r) => t + r.takings, 0)), money: true },
        { label: 'Cash taken', value: r2(cashRow.takings), money: true,
          foot: 'what should have been in the drawer' },
        { label: 'Cash paid out', value: r2(cashRow.book_out), money: true,
          foot: 'from the cash book' },
        { label: 'Cash that should remain', value: r2(cashRow.takings + cashRow.book_in - cashRow.book_out),
          money: true, foot: 'before any banking, which the clinic records as a cash-book entry' },
      ],
      notes: [
        'This reconciles what the system was told. It cannot see the bank: a true reconciliation is this table against the statement, and the difference is the thing worth chasing.',
        'A counter sale with no payment mode recorded appears as "unrecorded" rather than being assumed to be cash.',
      ],
    };
  },
};

const discountsWriteoffs = {
  key: 'discounts',
  group: 'money',
  title: 'Discounts, refunds, cancellations and write-offs',
  subtitle: 'Everywhere revenue left without being collected',
  run({ from, to }) {
    const rows = db.prepare(
      `SELECT date(i.created_at) AS day,
              SUM(i.discount) AS discount,
              SUM(i.sliding_discount) AS sliding,
              SUM(i.assistance_covered) AS assistance,
              SUM(CASE WHEN i.status = 'written_off' THEN i.balance ELSE 0 END) AS written_off,
              SUM(CASE WHEN i.status = 'cancelled' THEN i.net ELSE 0 END) AS cancelled,
              COUNT(CASE WHEN i.status = 'cancelled' THEN 1 END) AS cancelled_bills
         FROM invoices i
        WHERE date(i.created_at) BETWEEN date(?) AND date(?)
        GROUP BY day ORDER BY day DESC`).all(from, to);

    const refunds = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c FROM cash_book
        WHERE direction = 'out' AND category = 'Refund to patient' AND voided_at IS NULL
          AND date(entry_date) BETWEEN date(?) AND date(?)`).get(from, to);

    const returned = db.prepare(
      `SELECT COALESCE(SUM(paid_amount), 0) AS s, COUNT(*) AS c FROM pharmacy_sales
        WHERE status = 'returned' AND date(created_at) BETWEEN date(?) AND date(?)`).get(from, to);

    const gross = db.prepare(
      `SELECT COALESCE(SUM(gross), 0) AS s FROM invoices
        WHERE status NOT IN ('cancelled','draft')
          AND date(created_at) BETWEEN date(?) AND date(?)`).get(from, to).s;

    const sum = (k) => r2(rows.reduce((t, r) => t + r[k], 0));
    const leakage = r2(sum('discount') + sum('sliding') + sum('assistance')
      + sum('written_off') + refunds.s + returned.s);

    return {
      columns: [
        { key: 'day', label: 'Date', type: T.date },
        { key: 'discount', label: 'Discount given', type: T.money },
        { key: 'sliding', label: 'Sliding scale', type: T.money },
        { key: 'assistance', label: 'Assistance', type: T.money },
        { key: 'written_off', label: 'Written off', type: T.money },
        { key: 'cancelled', label: 'Cancelled bills', type: T.money },
        { key: 'cancelled_bills', label: 'Bills cancelled', type: T.num },
      ],
      rows: rows.map((r) => ({ ...r, discount: r2(r.discount), sliding: r2(r.sliding),
        assistance: r2(r.assistance), written_off: r2(r.written_off), cancelled: r2(r.cancelled) })),
      tiles: [
        { label: 'Given away in total', value: leakage, money: true,
          foot: `${pct(leakage, gross) ?? 0}% of gross billing` },
        { label: 'Means-tested concessions', value: r2(sum('sliding') + sum('assistance')),
          money: true, foot: 'sliding scale and assistance — deliberate, and the point of the clinic' },
        { label: 'Discretionary discounts', value: sum('discount'), money: true,
          tone: sum('discount') > sum('sliding') ? 'warn' : 'ok',
          foot: 'given at the counter, not through a screening' },
        { label: 'Refunded and returned', value: r2(refunds.s + returned.s), money: true,
          foot: `${refunds.c} refunds, ${returned.c} medicine returns` },
      ],
      notes: [
        'A means-tested concession is the clinic doing its job. A discretionary discount is a decision somebody made at the counter — the two are separated here because only the second is worth questioning.',
      ],
    };
  },
};

const receivablesAgeing = {
  key: 'receivables',
  group: 'money',
  title: 'Patient, corporate and insurance receivables ageing',
  subtitle: 'Who owes what, and how long they have owed it',
  run() {
    /*
     * Aged from the invoice date, never from the last payment. A bill
     * half-settled last week is not a fresh bill — the unpaid half is as old
     * as the day it was raised, and bucketing by last activity is how a
     * ledger reports itself healthier than it is.
     */
    const bucket = `CASE
        WHEN julianday('now') - julianday(i.created_at) <= 30 THEN '0-30 days'
        WHEN julianday('now') - julianday(i.created_at) <= 60 THEN '31-60 days'
        WHEN julianday('now') - julianday(i.created_at) <= 90 THEN '61-90 days'
        WHEN julianday('now') - julianday(i.created_at) <= 180 THEN '91-180 days'
        ELSE 'Over 180 days' END`;

    const patient = db.prepare(
      `SELECT ${bucket} AS age, COUNT(*) AS bills, SUM(i.balance) AS amount
         FROM invoices i
        WHERE i.status IN ('unpaid','partial')
          AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.invoice_id = i.id
                            AND c.status NOT IN ('rejected','closed'))
        GROUP BY age`).all();

    const insurance = db.prepare(
      `SELECT CASE
          WHEN julianday('now') - julianday(c.submitted_at) <= 30 THEN '0-30 days'
          WHEN julianday('now') - julianday(c.submitted_at) <= 60 THEN '31-60 days'
          WHEN julianday('now') - julianday(c.submitted_at) <= 90 THEN '61-90 days'
          WHEN julianday('now') - julianday(c.submitted_at) <= 180 THEN '91-180 days'
          ELSE 'Over 180 days' END AS age,
          COUNT(*) AS bills,
          SUM(COALESCE(NULLIF(c.approved_amount, 0), c.claimed_amount) - c.settled_amount) AS amount
         FROM claims c
        WHERE c.status NOT IN ('draft','rejected','closed')
          AND COALESCE(NULLIF(c.approved_amount, 0), c.claimed_amount) - c.settled_amount > 0.01
        GROUP BY age`).all();

    const ORDER = ['0-30 days', '31-60 days', '61-90 days', '91-180 days', 'Over 180 days'];
    const rows = ORDER.map((age) => {
      const p = patient.find((x) => x.age === age) || { bills: 0, amount: 0 };
      const i = insurance.find((x) => x.age === age) || { bills: 0, amount: 0 };
      return {
        age,
        patient_bills: p.bills, patient: r2(p.amount),
        insurance_bills: i.bills, insurance: r2(i.amount),
        total: r2(p.amount + i.amount),
      };
    });

    const total = r2(rows.reduce((t, r) => t + r.total, 0));
    const old = r2(rows.filter((r) => ['91-180 days', 'Over 180 days'].includes(r.age))
      .reduce((t, r) => t + r.total, 0));

    const worst = db.prepare(
      `SELECT i.invoice_no, p.uhid, p.first_name || ' ' || COALESCE(p.last_name, '') AS patient,
              i.created_at, i.net, i.balance,
              CAST(julianday('now') - julianday(i.created_at) AS INTEGER) AS days_old
         FROM invoices i JOIN patients p ON p.id = i.patient_id
        WHERE i.status IN ('unpaid','partial')
        ORDER BY days_old DESC LIMIT 25`).all();

    return {
      columns: [
        { key: 'age', label: 'Age', type: T.text, strong: true },
        { key: 'patient_bills', label: 'Patient bills', type: T.num },
        { key: 'patient', label: 'Owed by patients', type: T.money },
        { key: 'insurance_bills', label: 'Claims', type: T.num },
        { key: 'insurance', label: 'Owed by insurers', type: T.money },
        { key: 'total', label: 'Total', type: T.money },
      ],
      rows,
      tiles: [
        { label: 'Owed in total', value: total, money: true },
        { label: 'Older than 90 days', value: old, money: true,
          tone: old > 0 ? 'warn' : 'ok',
          foot: `${pct(old, total) ?? 0}% of the book — the part that usually does not arrive` },
        { label: 'From patients', value: r2(rows.reduce((t, r) => t + r.patient, 0)), money: true },
        { label: 'From insurers and TPAs', value: r2(rows.reduce((t, r) => t + r.insurance, 0)),
          money: true, foot: 'submitted claims not yet settled' },
      ],
      lists: [{ title: 'The oldest unpaid bills', rows: worst,
        columns: [
          { key: 'invoice_no', label: 'Invoice', type: T.text },
          { key: 'patient', label: 'Patient', type: T.text },
          { key: 'created_at', label: 'Raised', type: T.date },
          { key: 'days_old', label: 'Days', type: T.num },
          { key: 'net', label: 'Bill', type: T.money },
          { key: 'balance', label: 'Still owed', type: T.money },
        ] }],
      notes: [
        'Aged from the day the bill was raised, not from the last payment against it — a part payment does not make an old debt new.',
        'A bill with a live claim against it is counted as owed by the insurer, not by the patient, so the same rupee is not demanded twice.',
        'Ageing is live and ignores the date range: a debt from March is still a debt in November.',
      ],
    };
  },
};

const supplierPayables = {
  key: 'payables',
  group: 'money',
  title: 'Supplier payables and payment due',
  subtitle: 'What the clinic owes, and when it was promised',
  run() {
    const rows = db.prepare(
      `SELECT s.name AS supplier, s.phone,
              COUNT(*) AS invoices,
              SUM(sp.net - sp.paid) AS owed,
              MIN(sp.due_date) AS earliest_due,
              SUM(CASE WHEN sp.due_date IS NOT NULL AND date(sp.due_date) < date('now')
                  THEN sp.net - sp.paid ELSE 0 END) AS overdue
         FROM stock_purchases sp
         LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.status != 'cancelled' AND sp.net - sp.paid > 0.01
        GROUP BY sp.supplier_id ORDER BY owed DESC`).all();

    const owed = r2(rows.reduce((t, r) => t + r.owed, 0));
    const overdue = r2(rows.reduce((t, r) => t + r.overdue, 0));
    const week = db.prepare(
      `SELECT COALESCE(SUM(net - paid), 0) AS s FROM stock_purchases
        WHERE status != 'cancelled' AND net - paid > 0.01
          AND due_date IS NOT NULL
          AND date(due_date) BETWEEN date('now') AND date('now', '+7 days')`).get().s;

    return {
      columns: [
        { key: 'supplier', label: 'Supplier', type: T.text, strong: true },
        { key: 'phone', label: 'Phone', type: T.text },
        { key: 'invoices', label: 'Invoices', type: T.num },
        { key: 'owed', label: 'Owed', type: T.money },
        { key: 'overdue', label: 'Of which overdue', type: T.money, tone: 'warn' },
        { key: 'earliest_due', label: 'Earliest due', type: T.date },
      ],
      rows: rows.map((r) => ({ ...r, owed: r2(r.owed), overdue: r2(r.overdue) })),
      tiles: [
        { label: 'Owed to suppliers', value: owed, money: true },
        { label: 'Already overdue', value: overdue, money: true, tone: overdue ? 'warn' : 'ok' },
        { label: 'Falling due this week', value: r2(week), money: true },
        { label: 'Suppliers owed', value: rows.length },
      ],
      notes: [
        'Live, and ignores the date range: an invoice unpaid since March is still unpaid whichever month you are looking at.',
        'From goods received and what has been paid against them. An invoice with no due date recorded cannot be called overdue and is counted only in the total.',
      ],
    };
  },
};

const serviceContribution = {
  key: 'services',
  group: 'money',
  title: 'Service-wise cost and contribution',
  subtitle: 'What each service earns, line by line',
  run({ from, to }) {
    const rows = db.prepare(
      `WITH gross AS (
         SELECT ii.invoice_id AS id, SUM(ii.amount) AS total
           FROM invoice_items ii GROUP BY ii.invoice_id)
       SELECT ii.description AS service,
              ${commercial.DEPT_OF_LINE} AS dept,
              COUNT(*) AS times,
              SUM(ii.qty) AS units,
              SUM(ii.amount) AS gross_billed,
              SUM(${commercial.NET_LINE}) AS net_billed
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
         JOIN gross ON gross.id = ii.invoice_id
        WHERE i.status NOT IN ('cancelled','draft')
          AND date(i.created_at) BETWEEN date(?) AND date(?)
        GROUP BY ii.description
        ORDER BY net_billed DESC LIMIT 200`).all(from, to);

    const label = {
      consultation: 'Consultations', laboratory: 'Laboratory', imaging: 'X-ray / Scans / ECG',
      pharmacy: 'Pharmacy', procedures: 'Procedures / Day care', other: 'Unclassified',
    };
    return {
      columns: [
        { key: 'service', label: 'Service', type: T.text, strong: true },
        { key: 'department', label: 'Department', type: T.text },
        { key: 'times', label: 'Times billed', type: T.num },
        { key: 'units', label: 'Units', type: T.num },
        { key: 'net_billed', label: 'Net revenue', type: T.money },
        { key: 'per_unit', label: 'Average price', type: T.money },
        { key: 'concession', label: 'Given away', type: T.money },
      ],
      rows: rows.map((r) => ({
        ...r,
        department: label[r.dept] || r.dept,
        net_billed: r2(r.net_billed),
        per_unit: r.units ? r2(r.net_billed / r.units) : null,
        concession: r2(r.gross_billed - r.net_billed),
      })),
      notes: [
        'Revenue only. A per-service cost would need the clinic to record what each test and each procedure consumes, which it does not — only the pharmacy has a true per-line cost, and that is in its own report.',
        'Contribution per service is therefore not shown rather than estimated. The department report is the honest level for cost; this is the honest level for price and volume.',
      ],
    };
  },
};

/* ===================================================== accounts & position */

const cashFlow = {
  key: 'cashflow',
  group: 'accounts',
  title: 'Cash-flow statement and forecast',
  subtitle: 'What moved, and what is committed next',
  run({ from, to }) {
    const inflow = db.prepare(
      `SELECT 'Patient collections' AS line, COALESCE(SUM(amount), 0) AS amount
         FROM payments WHERE date(paid_at) BETWEEN date(?) AND date(?)
       UNION ALL
       SELECT 'Counter sales', COALESCE(SUM(paid_amount), 0) FROM pharmacy_sales
        WHERE sale_type = 'counter' AND status != 'cancelled'
          AND date(created_at) BETWEEN date(?) AND date(?)
       UNION ALL
       SELECT 'Other receipts', COALESCE(SUM(amount), 0) FROM cash_book
        WHERE direction = 'in' AND voided_at IS NULL
          AND date(entry_date) BETWEEN date(?) AND date(?)`).all(from, to, from, to, from, to);

    const outflow = db.prepare(
      `SELECT category AS line, SUM(amount) AS amount FROM cash_book
        WHERE direction = 'out' AND voided_at IS NULL
          AND date(entry_date) BETWEEN date(?) AND date(?)
        GROUP BY category ORDER BY amount DESC`).all(from, to);

    const inTotal = r2(inflow.reduce((t, r) => t + r.amount, 0));
    const outTotal = r2(outflow.reduce((t, r) => t + r.amount, 0));

    /*
     * The forecast is only what is already committed — supplier invoices with
     * a date on them, and receivables that are not yet hopeless. No trend is
     * extrapolated: a cash forecast built by projecting last month forward is
     * a guess wearing a number's clothes, and the owner would act on it.
     */
    const dueOut = db.prepare(
      `SELECT 'Supplier invoices due' AS line,
              COALESCE(SUM(net - paid), 0) AS amount
         FROM stock_purchases
        WHERE status != 'cancelled' AND net - paid > 0.01
          AND due_date IS NOT NULL AND date(due_date) <= date('now', '+30 days')`).all();
    const dueIn = db.prepare(
      `SELECT 'Patient bills under 90 days old' AS line, COALESCE(SUM(balance), 0) AS amount
         FROM invoices WHERE status IN ('unpaid','partial')
          AND julianday('now') - julianday(created_at) <= 90
       UNION ALL
       SELECT 'Claims approved, not yet settled',
              COALESCE(SUM(approved_amount - settled_amount), 0)
         FROM claims WHERE status = 'approved' AND approved_amount - settled_amount > 0.01`).all();

    const rows = [
      ...inflow.map((r) => ({ ...r, kind: 'In', amount: r2(r.amount) })),
      { line: 'Total in', kind: 'Subtotal', amount: inTotal },
      ...outflow.map((r) => ({ ...r, kind: 'Out', amount: r2(-r.amount) })),
      { line: 'Total out', kind: 'Subtotal', amount: r2(-outTotal) },
      { line: 'Net movement', kind: 'Total', amount: r2(inTotal - outTotal) },
    ];

    return {
      columns: [
        { key: 'line', label: 'Line', type: T.text, strong: true },
        { key: 'kind', label: '', type: T.badge },
        { key: 'amount', label: 'Amount', type: T.money },
      ],
      rows,
      tiles: [
        { label: 'Cash in', value: inTotal, money: true },
        { label: 'Cash out', value: outTotal, money: true },
        { label: 'Net movement', value: r2(inTotal - outTotal), money: true,
          tone: inTotal - outTotal < 0 ? 'warn' : 'ok' },
        { label: 'Committed out, next 30 days', value: r2(dueOut.reduce((t, r) => t + r.amount, 0)),
          money: true, foot: 'supplier invoices with a date on them' },
      ],
      lists: [{ title: 'What is expected to come in', rows: dueIn.map((r) => ({ ...r, amount: r2(r.amount) })),
        columns: [{ key: 'line', label: 'Expected', type: T.text },
          { key: 'amount', label: 'Amount', type: T.money }] }],
      notes: [
        'The forecast is only what is already committed or already owed. Nothing is extrapolated from the trend — a projected figure is a guess wearing a number\'s clothes, and it would be acted on as if it were a fact.',
        'Bills older than 90 days are left out of the expected column; the ageing report shows why.',
      ],
    };
  },
};

const profitAndLoss = {
  key: 'pnl',
  group: 'accounts',
  title: 'Profit and loss statement',
  subtitle: 'The month, on an accrual basis',
  run({ period, from }) {
    const p = period || from.slice(0, 7);
    const c = commercial.comparison(p);
    return {
      columns: [
        { key: 'label', label: 'Particulars', type: T.text, strong: true },
        { key: 'actual', label: 'This month', type: T.money },
        { key: 'previous', label: 'Previous month', type: T.money },
        { key: 'change', label: 'Change', type: T.money },
      ],
      rows: c.rows.map((r) => ({ ...r, emphasis: r.kind === 'subtotal' || r.kind === 'total' })),
      notes: [
        c.basis.revenue,
        c.basis.medicines,
        `${c.basis.purchases} of stock and equipment was bought this month and is not in the figures above; it belongs to the cash-flow statement.`,
        'Budget and variance for the same month are on the Commercial eye tab.',
      ],
    };
  },
};

/*
 * The balance sheet, and the honest reason it is only half-derivable.
 *
 * Everything else on this shelf is computed from what the clinic recorded.
 * A balance sheet cannot be: what the bank holds, what the owner put in,
 * what is still owed on a loan, and how far the assets were already worn
 * down on the day this system started are facts from outside it. They are
 * entered as a dated position, and the statement shows the date it was last
 * trued up, because a balance sheet resting on a year-old opening figure is
 * worth knowing about before anybody borrows against it.
 */
const POSITION_LINES = [
  { key: 'bank', label: 'Bank balances', side: 'asset', hint: 'Across all current accounts, as per the statement' },
  { key: 'cash_in_hand', label: 'Cash in hand', side: 'asset', hint: 'Counted, not calculated' },
  { key: 'deposits', label: 'Deposits and advances', side: 'asset', hint: 'Rent deposit, utility deposits' },
  { key: 'accumulated_depreciation', label: 'Accumulated depreciation brought forward', side: 'contra', hint: 'How worn down the equipment already was when this system started' },
  { key: 'loans', label: 'Loans outstanding', side: 'liability', hint: 'Principal still owed' },
  { key: 'other_liabilities', label: 'Other liabilities', side: 'liability', hint: 'Statutory dues, anything else owed' },
  { key: 'capital', label: 'Owner\'s capital introduced', side: 'equity', hint: 'What the owner has put in' },
  { key: 'drawings', label: 'Owner\'s drawings', side: 'equity', hint: 'What the owner has taken out' },
];

const balanceSheet = {
  key: 'balance-sheet',
  group: 'accounts',
  title: 'Balance sheet',
  subtitle: 'What the clinic owns and owes',
  needs: () => (has('ledger_positions') && count('SELECT COUNT(*) AS c FROM ledger_positions')
    ? null
    : 'A balance sheet needs figures this system cannot see: the bank balance, the owner\'s capital, any loan still outstanding, and how far the equipment was already depreciated when this system started. Open "Opening position" from this report to enter them once. Stock, receivables, payables and the equipment register are already computed and will fill themselves in.'),
  run() {
    const asOn = db.prepare('SELECT MAX(as_on) AS d FROM ledger_positions').get().d;
    const entered = {};
    for (const r of db.prepare('SELECT line, amount FROM ledger_positions WHERE as_on = ?').all(asOn)) {
      entered[r.line] = r.amount;
    }
    const get = (k) => r2(entered[k] || 0);

    const stock = db.prepare(
      'SELECT COALESCE(SUM(qty_available * purchase_price), 0) AS s FROM drug_batches').get().s;
    const equipment = db.prepare(
      'SELECT COALESCE(SUM(unit_cost * quantity), 0) AS s FROM assets WHERE active = 1').get().s;
    const receivable = db.prepare(
      "SELECT COALESCE(SUM(balance), 0) AS s FROM invoices WHERE status IN ('unpaid','partial')").get().s;
    const claims = db.prepare(
      `SELECT COALESCE(SUM(COALESCE(NULLIF(approved_amount, 0), claimed_amount) - settled_amount), 0) AS s
         FROM claims WHERE status NOT IN ('draft','rejected','closed')`).get().s;
    const payable = db.prepare(
      "SELECT COALESCE(SUM(net - paid), 0) AS s FROM stock_purchases WHERE status != 'cancelled'").get().s;

    const assets = [
      { line: 'Equipment and furniture, at cost', amount: r2(equipment), source: 'Asset register' },
      { line: 'Less: accumulated depreciation', amount: r2(-get('accumulated_depreciation')), source: 'Entered' },
      { line: 'Medicines in stock, at cost', amount: r2(stock), source: 'Batch records' },
      { line: 'Owed by patients', amount: r2(receivable), source: 'Unpaid invoices' },
      { line: 'Owed by insurers', amount: r2(claims), source: 'Open claims' },
      { line: 'Deposits and advances', amount: get('deposits'), source: 'Entered' },
      { line: 'Bank balances', amount: get('bank'), source: 'Entered' },
      { line: 'Cash in hand', amount: get('cash_in_hand'), source: 'Entered' },
    ];
    const liabilities = [
      { line: 'Owed to suppliers', amount: r2(payable), source: 'Goods received, unpaid' },
      { line: 'Loans outstanding', amount: get('loans'), source: 'Entered' },
      { line: 'Other liabilities', amount: get('other_liabilities'), source: 'Entered' },
    ];

    const totalAssets = r2(assets.reduce((t, r) => t + r.amount, 0));
    const totalLiabilities = r2(liabilities.reduce((t, r) => t + r.amount, 0));
    const capital = r2(get('capital') - get('drawings'));
    // Whatever is left is what the business has earned and kept. It is a
    // balancing figure and is labelled as one rather than dressed up as a
    // computed reserve.
    const retained = r2(totalAssets - totalLiabilities - capital);

    const rows = [
      { line: 'ASSETS', amount: null, kind: 'head' },
      ...assets.map((r) => ({ ...r, kind: 'row' })),
      { line: 'Total assets', amount: totalAssets, kind: 'total' },
      { line: 'LIABILITIES', amount: null, kind: 'head' },
      ...liabilities.map((r) => ({ ...r, kind: 'row' })),
      { line: 'Total liabilities', amount: totalLiabilities, kind: 'total' },
      { line: 'OWNER\'S FUNDS', amount: null, kind: 'head' },
      { line: 'Capital, net of drawings', amount: capital, source: 'Entered', kind: 'row' },
      { line: 'Retained in the business', amount: retained, source: 'Balancing figure', kind: 'row' },
      { line: 'Total liabilities and owner\'s funds', amount: r2(totalLiabilities + capital + retained),
        kind: 'total' },
    ];

    const stale = asOn ? daysBetween(asOn, today()) : null;
    return {
      columns: [
        { key: 'line', label: 'Particulars', type: T.text, strong: true },
        { key: 'source', label: 'Where it comes from', type: T.text },
        { key: 'amount', label: 'Amount', type: T.money },
      ],
      rows,
      tiles: [
        { label: 'Total assets', value: totalAssets, money: true },
        { label: 'Total liabilities', value: totalLiabilities, money: true },
        { label: 'Net worth', value: r2(totalAssets - totalLiabilities), money: true },
        { label: 'Entered figures last trued up', value: asOn || '—',
          tone: stale !== null && stale > 120 ? 'warn' : 'ok',
          foot: stale === null ? 'never' : `${stale} days ago` },
      ],
      notes: [
        'The lines marked "Entered" are the ones this system cannot see and somebody typed in. Everything else is computed from the clinic\'s own records.',
        'Equipment is at purchase price less whatever depreciation was entered as brought forward; this is not a valuation and no revaluation has been applied.',
        '"Retained in the business" is a balancing figure, not an independently computed reserve. It is what is left once everything else is in place.',
      ],
      warn: stale !== null && stale > 120
        ? `The entered figures were last updated ${stale} days ago. A balance sheet resting on an old bank balance should not be relied on.`
        : null,
    };
  },
};

const pendingActions = {
  key: 'pending',
  group: 'accounts',
  title: 'Pending actions, approvals and escalations',
  subtitle: 'Everything waiting on somebody, in one place',
  run() {
    const items = [];
    const add = (area, what, n, where, tone) => {
      if (n > 0) items.push({ area, what, count: n, where, tone });
    };

    add('Clinical', 'Critical results not signed off', count(
      `SELECT COUNT(*) AS c FROM lab_order_items
        WHERE abnormal_flag = 'critical' AND verified_at IS NULL AND status != 'cancelled'`),
    'Diagnostics', 'danger');
    add('Clinical', 'Results entered, awaiting verification', count(
      "SELECT COUNT(*) AS c FROM lab_order_items WHERE status = 'result_entered'"), 'Diagnostics');
    add('Clinical', 'Consultations written but not signed', count(
      'SELECT COUNT(*) AS c FROM consultations WHERE signed_at IS NULL'), 'Medical records');

    add('Insurance', 'Pre-authorisations awaiting a decision', count(
      "SELECT COUNT(*) AS c FROM preauths WHERE status IN ('submitted','query_raised')"), 'Insurance & TPA');
    add('Insurance', 'Claims with a query raised', count(
      "SELECT COUNT(*) AS c FROM claims WHERE status = 'query_raised'"), 'Insurance & TPA', 'warn');
    add('Insurance', 'Claims submitted, no decision yet', count(
      "SELECT COUNT(*) AS c FROM claims WHERE status IN ('submitted','under_process')"), 'Insurance & TPA');

    add('Equipment', 'Calibration expired', count(
      `SELECT COUNT(*) AS c FROM assets WHERE active = 1 AND needs_calibration = 1
        AND calibration_due IS NOT NULL AND date(calibration_due) < date('now')`),
    'Assets & Calibration', 'danger');
    add('Equipment', 'Assets under repair', count(
      "SELECT COUNT(*) AS c FROM assets WHERE active = 1 AND status = 'under_repair'"),
    'Assets & Calibration');

    add('Stock', 'Expired batches still showing stock', count(
      `SELECT COUNT(*) AS c FROM drug_batches
        WHERE qty_available > 0 AND date(expiry_date) < date('now')`), 'Pharmacy stock', 'danger');
    add('Money', 'Supplier invoices past their due date', count(
      `SELECT COUNT(*) AS c FROM stock_purchases
        WHERE status != 'cancelled' AND net - paid > 0.01
          AND due_date IS NOT NULL AND date(due_date) < date('now')`), 'Payables', 'warn');
    add('Money', 'Bills unpaid for over 90 days', count(
      `SELECT COUNT(*) AS c FROM invoices WHERE status IN ('unpaid','partial')
        AND julianday('now') - julianday(created_at) > 90`), 'Receivables', 'warn');

    if (has('owner_actions')) {
      add('Owner', 'Corrective actions still open', count(
        "SELECT COUNT(*) AS c FROM owner_actions WHERE status IN ('open','in_progress')"),
      'Commercial eye');
      add('Owner', 'Corrective actions past their date', count(
        `SELECT COUNT(*) AS c FROM owner_actions WHERE status IN ('open','in_progress')
          AND due_date IS NOT NULL AND date(due_date) < date('now')`), 'Commercial eye', 'danger');
    }
    if (has('complaints')) {
      add('Quality', 'Complaints still open', count(
        "SELECT COUNT(*) AS c FROM complaints WHERE status IN ('open','investigating')"), 'Complaints', 'warn');
    }
    if (has('safety_incidents')) {
      add('Quality', 'Safety incidents not closed', count(
        "SELECT COUNT(*) AS c FROM safety_incidents WHERE status != 'closed'"), 'Safety incidents', 'warn');
    }
    if (has('compliance_items')) {
      add('Compliance', 'Licences and policies lapsed', count(
        `SELECT COUNT(*) AS c FROM compliance_items
          WHERE active = 1 AND status = 'active'
            AND valid_till IS NOT NULL AND date(valid_till) < date('now')`), 'Compliance', 'danger');
      add('Compliance', 'Due for renewal soon', count(
        `SELECT COUNT(*) AS c FROM compliance_items
          WHERE active = 1 AND status = 'active' AND valid_till IS NOT NULL
            AND date(valid_till) BETWEEN date('now')
                AND date('now', '+' || COALESCE(renewal_notice_days, 60) || ' days')`),
      'Compliance', 'warn');
    }

    const urgent = items.filter((i) => i.tone === 'danger');
    return {
      columns: [
        { key: 'area', label: 'Area', type: T.text },
        { key: 'what', label: 'Waiting on somebody', type: T.text, strong: true },
        { key: 'count', label: 'How many', type: T.num },
        { key: 'where', label: 'Where it lives', type: T.text },
      ],
      rows: items.sort((a, b) => (a.tone === 'danger' ? -1 : b.tone === 'danger' ? 1 : 0)),
      tiles: [
        { label: 'Things waiting', value: items.reduce((t, i) => t + i.count, 0) },
        { label: 'Needing attention today', value: urgent.reduce((t, i) => t + i.count, 0),
          tone: urgent.length ? 'danger' : 'ok' },
        { label: 'Areas involved', value: new Set(items.map((i) => i.area)).size },
      ],
      notes: [
        'Live, and deliberately ignores the date range: something that has been waiting since March is still waiting today.',
        'An empty list means nothing is queued in the places this system can see — it does not mean there is nothing to do.',
      ],
      warn: urgent.length ? 'Some of these are clinical or statutory and should not wait.' : null,
    };
  },
};

module.exports = {
  POSITION_LINES,
  STOCK: [pharmacyStock, expiryWastage, purchaseOrders, inventoryValuation,
    equipmentReport, complianceReport],
  PEOPLE: [attendanceReport, payrollReport],
  MONEY: [billingCollections, paymentModes, discountsWriteoffs, receivablesAgeing,
    supplierPayables, serviceContribution],
  ACCOUNTS: [cashFlow, profitAndLoss, balanceSheet, pendingActions],
};
