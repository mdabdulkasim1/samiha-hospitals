'use strict';
const { db } = require('../db');

/*
 * Document references, in the shapes the company already uses.
 *
 * AKR-FD26-016 and AKR-SO-082026-014 are on paper that suppliers and clients
 * are holding. A system that renumbered them would break every conversation
 * that starts "about order AKR-FD26-016" — so the patterns are followed, and
 * kept as records rather than constants, so a series can be adjusted or picked
 * up from a number already issued without touching the code.
 *
 * A pattern is a template:
 *
 *   {company}   the company code            AKR
 *   {type}      the document's short code   LPO, SO, INV
 *   {yy} {yyyy} the year                    26 / 2026
 *   {mm}        the month                   08
 *   {mmyyyy}    month and year together     082026
 *   {yyyymm}    year and month together     202608
 *   {n} {n:3}   the serial, padded          016
 *
 * Anything else in the pattern is printed as it stands, which is how the
 * literal "FD" in AKR-FD26-016 survives.
 */

/** The short code each document is known by. */
const DOC_TYPES = {
  enquiry: 'ENQ',
  salesQuotation: 'QT',
  salesOrder: 'SO',
  deliveryNote: 'DN',
  salesInvoice: 'INV',
  receipt: 'RV',
  supplierEnquiry: 'RFQ',
  supplierQuotation: 'SQ',
  purchaseOrder: 'LPO',
  grn: 'GRN',
  supplierInvoice: 'BILL',
  payment: 'PV',
  expense: 'EXP',
  income: 'INC',
  stockAdjustment: 'ADJ',
};

/** What each series is called on screen. */
const DOC_LABELS = {
  enquiry: 'Client enquiry',
  salesQuotation: 'Our quotation to a client',
  salesOrder: "Client's LPO (our sales order)",
  deliveryNote: 'Delivery note',
  salesInvoice: 'Tax invoice',
  receipt: 'Receipt voucher (money in)',
  supplierEnquiry: 'Our enquiry to a manufacturer (RFQ)',
  supplierQuotation: "Supplier's quotation",
  purchaseOrder: 'Our LPO to a supplier',
  grn: 'Goods receipt note',
  supplierInvoice: "Supplier's invoice, as we file it",
  payment: 'Payment voucher (money out)',
  expense: 'Expense voucher',
  income: 'Other income voucher',
  stockAdjustment: 'Stock adjustment',
};

/*
 * The company's own two shapes, and the rest of the documents kept in the
 * family of whichever of them they belong to.
 *
 * The LPO series carries the literal "FD" — the Fabrication Division — and the
 * meaning is written down here and on the series itself, because a two-letter
 * code on a document nobody can explain a year later is how a reference stops
 * being useful. It is a plain part of the pattern, so if another division ever
 * issues its own orders the code can be changed under Masters → Document
 * numbers without anybody touching this file.
 *
 * Every series that carries a month restarts within it: AKR-SO-082026-014 is
 * the fourteenth order of August 2026. A reference that carries a month but
 * counts through the year invites the reader to work out which of the two it
 * means.
 *
 * The LPO is the exception, and it is not an oversight. Its reference carries
 * the year and no month, so counting within the month would produce
 * AKR-FD26-001 in January and AKR-FD26-001 again in February — the one thing a
 * reference must never do. See validatePattern below, which refuses that
 * combination rather than leaving it to be discovered.
 */
const DEFAULTS = {
  purchaseOrder: {
    pattern: '{company}-FD{yy}-{n:3}',
    reset_on: 'yearly',
    note: 'FD — Fabrication Division',
  },
  supplierEnquiry: { pattern: '{company}-RFQ-{mmyyyy}-{n:3}', reset_on: 'monthly' },
  supplierQuotation: { pattern: '{company}-SQ-{mmyyyy}-{n:3}', reset_on: 'monthly' },
  grn: { pattern: '{company}-GRN-{mmyyyy}-{n:3}', reset_on: 'monthly' },
  supplierInvoice: { pattern: '{company}-BILL-{mmyyyy}-{n:3}', reset_on: 'monthly' },

  salesOrder: { pattern: '{company}-SO-{mmyyyy}-{n:3}', reset_on: 'monthly' },
  enquiry: { pattern: '{company}-ENQ-{mmyyyy}-{n:3}', reset_on: 'monthly' },
  salesQuotation: { pattern: '{company}-QT-{mmyyyy}-{n:3}', reset_on: 'monthly' },
  deliveryNote: { pattern: '{company}-DN-{mmyyyy}-{n:3}', reset_on: 'monthly' },
  salesInvoice: { pattern: '{company}-INV-{mmyyyy}-{n:3}', reset_on: 'monthly' },

  receipt: { pattern: '{company}-RV-{mmyyyy}-{n:3}', reset_on: 'monthly' },
  payment: { pattern: '{company}-PV-{mmyyyy}-{n:3}', reset_on: 'monthly' },
  expense: { pattern: '{company}-EXP-{mmyyyy}-{n:3}', reset_on: 'monthly' },
  income: { pattern: '{company}-INC-{mmyyyy}-{n:3}', reset_on: 'monthly' },
  stockAdjustment: { pattern: '{company}-ADJ-{mmyyyy}-{n:3}', reset_on: 'monthly' },
};

const KINDS = Object.keys(DEFAULTS);

const HAS_MONTH = /\{(mm|mmyyyy|yyyymm)\}/;
const HAS_YEAR = /\{(yy|yyyy|mmyyyy|yyyymm)\}/;
const HAS_SERIAL = /\{n(?::\d+)?\}/;

/**
 * Whether a pattern can actually tell its documents apart.
 *
 * A serial that restarts is only safe if what it restarts for is written into
 * the reference. Counting within the month, on a pattern that names no month,
 * gives January's first order and February's first order the same number —
 * and two documents with one reference is the single thing a reference exists
 * to prevent. So the combination is refused here rather than discovered later
 * by whoever is holding both pieces of paper.
 *
 * Returns a sentence explaining the problem, or null when the pattern is sound.
 */
function validatePattern(pattern, resetOn = 'yearly') {
  const p = String(pattern || '');
  if (!HAS_SERIAL.test(p)) {
    return 'A pattern must contain {n} — without a serial, every document would have the same reference.';
  }
  if (resetOn === 'monthly') {
    if (!HAS_MONTH.test(p)) {
      return 'This serial restarts every month, but the pattern names no month — January\u2019s first '
        + 'document and February\u2019s would both read 001. Add {mmyyyy}, or let the serial restart yearly.';
    }
    if (!HAS_YEAR.test(p)) {
      return 'This serial restarts every month, but the pattern names no year — August 2026 and '
        + 'August 2027 would collide. Use {mmyyyy} rather than {mm}.';
    }
  }
  if (resetOn === 'yearly' && !HAS_YEAR.test(p)) {
    return 'This serial restarts every year, but the pattern names no year — this year\u2019s first '
      + 'document and next year\u2019s would both read 001. Add {yy} or {yyyy}.';
  }
  return null;
}
const pad = (n, width) => String(n).padStart(width, '0');

/** The series in force for a company and a document kind. */
function seriesFor(companyId, kind) {
  const row = companyId
    ? db.prepare('SELECT * FROM document_series WHERE company_id = ? AND doc_kind = ? AND active = 1')
      .get(companyId, kind)
    : null;
  const fallback = DEFAULTS[kind] || { pattern: '{company}-{type}-{yyyy}-{n:4}', reset_on: 'yearly' };
  return row || { note: null, ...fallback, doc_kind: kind, company_id: companyId, fallback: true };
}

/**
 * What makes one series distinct from another, for the counter.
 *
 * A yearly series counts from one each January; a monthly one each month. Two
 * documents can only collide if they share a scope, and the counter is atomic
 * within it.
 */
function scopeKey(series, when) {
  const y = when.getFullYear();
  const m = pad(when.getMonth() + 1, 2);
  if (series.reset_on === 'monthly') return `${y}${m}`;
  if (series.reset_on === 'never') return 'all';
  return String(y);
}

const counterName = (companyCode, kind, scope) => `${companyCode}:${kind}:${scope}`;

/** Fill a pattern. `serial` is the number this document has been given. */
function render(pattern, { companyCode, kind, serial, when = new Date() }) {
  const y = when.getFullYear();
  const mm = pad(when.getMonth() + 1, 2);
  return String(pattern).replace(/\{(\w+)(?::(\d+))?\}/g, (whole, key, width) => {
    switch (key) {
      case 'company': return String(companyCode || '').toUpperCase();
      case 'type': return DOC_TYPES[kind] || String(kind).toUpperCase();
      case 'yy': return String(y).slice(-2);
      case 'yyyy': return String(y);
      case 'mm': return mm;
      case 'mmyyyy': return `${mm}${y}`;
      case 'yyyymm': return `${y}${mm}`;
      case 'n': return pad(serial, Number(width) || 1);
      default: return whole;
    }
  });
}

/** What the next reference would look like, without issuing it. */
function preview(companyId, companyCode, kind, when = new Date()) {
  const series = seriesFor(companyId, kind);
  const scope = scopeKey(series, when);
  const row = db.prepare('SELECT value FROM counters WHERE name = ?')
    .get(counterName(companyCode, kind, scope));
  return render(series.pattern, {
    companyCode, kind, serial: (row ? row.value : 0) + 1, when,
  });
}

/**
 * Issue the next reference. The serial comes from the atomic counter, so two
 * desks raising an LPO at the same moment can never land on the same one.
 */
function next(companyId, companyCode, kind, when = new Date()) {
  if (!DEFAULTS[kind]) throw new Error(`Unknown document kind: ${kind}`);
  const series = seriesFor(companyId, kind);
  const scope = scopeKey(series, when);
  const name = counterName(companyCode, kind, scope);
  const row = db.prepare(
    `INSERT INTO counters (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1
     RETURNING value`
  ).get(name);
  return render(series.pattern, { companyCode, kind, serial: row.value, when });
}

/**
 * Continue a series from a number already issued on paper.
 *
 * The counter is only ever moved forward. Setting it back would hand out a
 * reference that is already on a document somebody is holding, and two
 * documents with one number is precisely what a reference is for preventing.
 */
function setNext(companyCode, kind, nextNumber, { companyId = null, when = new Date() } = {}) {
  const series = seriesFor(companyId, kind);
  const name = counterName(companyCode, kind, scopeKey(series, when));
  const wanted = Math.max(0, Math.floor(Number(nextNumber) || 1) - 1);
  const current = db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
  if (current && current.value > wanted) {
    return { ok: false, current: current.value + 1,
      message: `${current.value} has already been issued in this series, so the next one cannot be `
        + `${nextNumber}. It will be ${current.value + 1}.` };
  }
  db.prepare(
    `INSERT INTO counters (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)`
  ).run(name, wanted);
  return { ok: true, current: wanted + 1 };
}

/** Every series for a company, with what the next reference would read. */
function listFor(company) {
  return KINDS.map((kind) => {
    const series = seriesFor(company.id, kind);
    const scope = scopeKey(series, new Date());
    const row = db.prepare('SELECT value FROM counters WHERE name = ?')
      .get(counterName(company.code, kind, scope));
    return {
      doc_kind: kind,
      label: DOC_LABELS[kind],
      type_code: DOC_TYPES[kind],
      pattern: series.pattern,
      reset_on: series.reset_on,
      note: series.note || null,
      is_default: Boolean(series.fallback),
      issued: row ? row.value : 0,
      next_number: (row ? row.value : 0) + 1,
      next_reference: preview(company.id, company.code, kind),
    };
  });
}

/** Save a company's pattern for one kind of document. */
function save(companyId, kind, { pattern, reset_on, note, userId = null }) {
  if (!DEFAULTS[kind]) throw new Error(`Unknown document kind: ${kind}`);
  const problem = validatePattern(pattern, reset_on || 'yearly');
  if (problem) throw new Error(problem);
  db.prepare(`
    INSERT INTO document_series (company_id, doc_kind, pattern, reset_on, note, updated_by, updated_at)
    VALUES (@company_id, @doc_kind, @pattern, @reset_on, @note, @updated_by, datetime('now'))
    ON CONFLICT(company_id, doc_kind) DO UPDATE SET
      pattern = excluded.pattern, reset_on = excluded.reset_on, note = excluded.note,
      active = 1, updated_by = excluded.updated_by, updated_at = datetime('now')`).run({
    company_id: companyId,
    doc_kind: kind,
    pattern,
    reset_on: reset_on || 'yearly',
    note: note || null,
    updated_by: userId,
  });
  return seriesFor(companyId, kind);
}

module.exports = {
  DOC_TYPES, DOC_LABELS, DEFAULTS, KINDS,
  seriesFor, scopeKey, render, preview, next, setNext, listFor, save, validatePattern,
};
