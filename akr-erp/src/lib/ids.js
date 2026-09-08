'use strict';

/*
 * The database is reached lazily: `src/db` calls in here while it is still
 * setting itself up, and a top-level require would hand back a half-built
 * module.
 */
const database = () => require('../db').db;

/**
 * Atomic per-name counter. Every human-facing document number comes from here,
 * so numbers are gap-free within their series and two desks raising an LPO at
 * the same moment can never land on the same one.
 */
function nextSeq(name) {
  const row = database().prepare(
    `INSERT INTO counters (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1
     RETURNING value`
  ).get(name);
  return row.value;
}

/** Read a counter without moving it. */
function peekSeq(name) {
  const row = database().prepare('SELECT value FROM counters WHERE name = ?').get(name);
  return row ? row.value : 0;
}

/** Never hand out a number that is already on a printed document. */
function bumpSeqTo(name, value) {
  database().prepare(
    `INSERT INTO counters (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)`
  ).run(name, Number(value) || 0);
}

const pad = (n, width) => String(n).padStart(width, '0');
const year = (d = new Date()) => String(d.getFullYear());

/*
 * What each document is called on paper.
 *
 * The shapes themselves live in src/services/numbering.js, because the company
 * already has its own — AKR-FD26-016 for an LPO, AKR-SO-082026-014 for a sales
 * order — and they are kept as records that can be changed rather than as
 * constants in the code.
 */
const DOC_TYPES = {
  enquiry:          'ENQ',
  salesQuotation:   'QTN',
  salesOrder:       'SO',
  deliveryNote:     'DN',
  salesInvoice:     'INV',
  receipt:          'RCT',
  supplierQuotation:'SQ',
  purchaseOrder:    'LPO',
  grn:              'GRN',
  supplierInvoice:  'BILL',
  payment:          'PV',      // payment voucher — money out
  expense:          'EXP',
  income:           'INC',
  stockAdjustment:  'ADJ',
};

/**
 * The next reference in a company's series for a document type.
 *
 * Every human-facing number in the system comes through here, so that one
 * place decides what a reference looks like and one atomic counter decides
 * what number it carries.
 */
function docNo(kind, companyCode, when = new Date(), companyId = null) {
  const numbering = require('../services/numbering');
  const code = String(companyCode || 'AKR').toUpperCase();
  const id = companyId
    || (database().prepare('SELECT id FROM companies WHERE upper(code) = ?').get(code) || {}).id
    || null;
  return numbering.next(id, code, kind, when);
}

/**
 * The common item number: AKR-VLP-00001.
 *
 *   AKR    the group's prefix
 *   VLP    the product line — valves for potable water
 *   00001  the serial within that line
 *
 * The line is in the code on purpose. Somebody reading an LPO, a delivery note
 * or a rack label can tell what the item is without looking it up, and the
 * serial stays short because each line counts from one.
 */
function itemCode(categoryCode, prefix = 'AKR') {
  const cat = String(categoryCode || 'GEN').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const serial = nextSeq(`item-${cat}`);
  return `${String(prefix).toUpperCase()}-${cat}-${pad(serial, 5)}`;
}

/** SUP-0001 for a manufacturer, CLI-0001 for a client. */
function partnerCode(type) {
  const prefix = type === 'client' ? 'CLI' : type === 'both' ? 'PTR' : 'SUP';
  return `${prefix}-${pad(nextSeq(`partner-${prefix}`), 4)}`;
}

const staffCode = () => `EMP${pad(nextSeq('staff'), 4)}`;

module.exports = { DOC_TYPES, nextSeq, peekSeq, bumpSeqTo, docNo, itemCode, partnerCode, staffCode, pad };
