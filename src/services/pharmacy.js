'use strict';
const { db } = require('../db');
const { conflict, badRequest } = require('../lib/http');

const config = require('../config');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * GST on a medicine line.
 *
 * The MRP printed on a pack is the most a patient may legally be charged and
 * it already contains the tax, so GST is *extracted* out of it rather than
 * added on top:
 *
 *     taxable = MRP × qty × 100 / (100 + rate)
 *     tax     = MRP × qty − taxable
 *
 * A sale inside the state carries CGST and SGST at half the rate each; the
 * clinic's own state is the place of supply for anyone walking up to the
 * counter. Set MRP_INCLUDES_GST=false only if a supplier's prices are quoted
 * before tax.
 */
function gstOnLine({ mrp, qty, taxPct }) {
  const rate = Number(taxPct) || 0;
  const lineTotal = round2((Number(mrp) || 0) * (Number(qty) || 0));
  const taxable = config.pharmacy.mrpIncludesGst
    ? round2((lineTotal * 100) / (100 + rate))
    : lineTotal;
  const tax = round2((config.pharmacy.mrpIncludesGst ? lineTotal : lineTotal * (1 + rate / 100)) - taxable);
  return {
    rate,
    lineTotal: round2(taxable + tax),
    taxable,
    tax,
    cgst: round2(tax / 2),
    sgst: round2(tax - round2(tax / 2)),   // the odd paisa stays with SGST
  };
}

/** Rate-wise HSN summary — the table a GST invoice has to carry. */
function gstSummary(items) {
  const byRate = new Map();
  for (const it of items) {
    const rate = Number(it.tax_pct) || 0;
    const line = gstOnLine({ mrp: it.mrp, qty: it.qty, taxPct: rate });
    const key = `${rate}|${it.hsn || ''}`;
    const row = byRate.get(key) || { rate, hsn: it.hsn || '', taxable: 0, cgst: 0, sgst: 0, tax: 0 };
    row.taxable = round2(row.taxable + line.taxable);
    row.cgst = round2(row.cgst + line.cgst);
    row.sgst = round2(row.sgst + line.sgst);
    row.tax = round2(row.tax + line.tax);
    byRate.set(key, row);
  }
  return [...byRate.values()].sort((a, b) => a.rate - b.rate);
}

/** ₹ in words, as a tax invoice must state the total. */
function amountInWords(amount) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const twoDigit = (n) => n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ' ' + ones[n % 10] : ''}`;
  const threeDigit = (n) => (n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' : ''}` : '') +
    (n % 100 ? twoDigit(n % 100) : '');

  const whole = Math.floor(Math.abs(round2(amount)));
  const paise = Math.round((Math.abs(round2(amount)) - whole) * 100);
  if (whole === 0 && paise === 0) return 'Zero Rupees Only';

  // Indian grouping: crore, lakh, thousand, hundred.
  const parts = [];
  const units = [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']];
  let left = whole;
  for (const [value, label] of units) {
    if (left >= value) {
      parts.push(`${threeDigit(Math.floor(left / value))} ${label}`);
      left %= value;
    }
  }
  if (left) parts.push(threeDigit(left));

  const rupees = parts.join(' ').replace(/\s+/g, ' ').trim();
  return `${rupees ? rupees + ' Rupees' : ''}${paise ? `${rupees ? ' and ' : ''}${twoDigit(paise)} Paise` : ''} Only`.trim();
}

/** Batches with stock, oldest expiry first (FEFO — first expiry, first out). */
function availableBatches(drugId) {
  return db.prepare(
    `SELECT * FROM drug_batches
      WHERE drug_id = ? AND qty_available > 0 AND date(expiry_date) >= date('now')
      ORDER BY date(expiry_date) ASC, id ASC`
  ).all(drugId);
}

function stockOnHand(drugId) {
  return db.prepare(
    `SELECT COALESCE(SUM(qty_available), 0) AS qty FROM drug_batches
      WHERE drug_id = ? AND date(expiry_date) >= date('now')`
  ).get(drugId).qty;
}

function writeLedger({ drugId, batchId, txnType, qtyDelta, refType, refId, notes, userId }) {
  const balance = stockOnHand(drugId);
  db.prepare(
    `INSERT INTO stock_ledger (drug_id, batch_id, txn_type, qty_delta, balance_after, ref_type, ref_id, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(drugId, batchId || null, txnType, qtyDelta, balance, refType || null, refId || null, notes || null, userId || null);
}

/**
 * Take stock into a batch. Every batch carries its own scannable label so the
 * counter can pick the exact expiry it is selling, not just the medicine.
 * `refType`/`refId` let a goods-received note own the ledger entry.
 */
function receiveStock({ drugId, batchNo, expiryDate, qty, mrp, purchasePrice, supplier, userId,
                        barcode, refType, refId, notes }) {
  const existing = db.prepare('SELECT * FROM drug_batches WHERE drug_id = ? AND batch_no = ?').get(drugId, batchNo);
  let batchId;
  if (existing) {
    db.prepare(
      `UPDATE drug_batches
          SET qty_received = qty_received + ?, qty_available = qty_available + ?,
              mrp = ?, purchase_price = ?, expiry_date = ?, supplier = COALESCE(?, supplier),
              barcode = COALESCE(barcode, ?)
        WHERE id = ?`
    ).run(qty, qty, mrp, purchasePrice, expiryDate, supplier, barcode || null, existing.id);
    batchId = existing.id;
  } else {
    const info = db.prepare(
      `INSERT INTO drug_batches (drug_id, batch_no, expiry_date, qty_received, qty_available,
                                 mrp, purchase_price, supplier, barcode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(drugId, batchNo, expiryDate, qty, qty, mrp, purchasePrice, supplier || null, barcode || null);
    batchId = info.lastInsertRowid;
  }
  writeLedger({
    drugId, batchId, txnType: 'purchase', qtyDelta: qty,
    refType: refType || 'batch', refId: refId || batchId, userId,
    notes: notes || `Received batch ${batchNo}`,
  });
  return db.prepare('SELECT * FROM drug_batches WHERE id = ?').get(batchId);
}

/**
 * Allocate a quantity across batches using FEFO. Returns the per-batch split,
 * or throws when stock is short so the caller never half-dispenses.
 */
function allocate(drugId, qty) {
  const batches = availableBatches(drugId);
  const drug = db.prepare('SELECT name FROM drugs WHERE id = ?').get(drugId);
  let remaining = qty;
  const picks = [];
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, b.qty_available);
    picks.push({ batch: b, qty: take });
    remaining -= take;
  }
  if (remaining > 0) {
    throw conflict(
      `Insufficient stock for ${drug ? drug.name : 'drug #' + drugId}: short by ${round2(remaining)} unit(s).`
    );
  }
  return picks;
}

function consume(batchId, qty) {
  const res = db.prepare(
    'UPDATE drug_batches SET qty_available = qty_available - ? WHERE id = ? AND qty_available >= ?'
  ).run(qty, batchId, qty);
  if (res.changes === 0) throw conflict('Stock changed while dispensing — please retry.');
}

function lowStock() {
  return db.prepare(
    `SELECT d.id, d.code, d.name, d.form, d.strength, d.reorder_level,
            COALESCE(SUM(CASE WHEN date(b.expiry_date) >= date('now') THEN b.qty_available ELSE 0 END), 0) AS on_hand
       FROM drugs d LEFT JOIN drug_batches b ON b.drug_id = d.id
      WHERE d.active = 1
      GROUP BY d.id
     HAVING on_hand <= d.reorder_level
      ORDER BY on_hand ASC`
  ).all();
}

function expiringSoon(days = 90) {
  return db.prepare(
    `SELECT b.*, d.name AS drug_name, d.code AS drug_code
       FROM drug_batches b JOIN drugs d ON d.id = b.drug_id
      WHERE b.qty_available > 0
        AND date(b.expiry_date) <= date('now', '+' || ? || ' days')
      ORDER BY date(b.expiry_date) ASC`
  ).all(days);
}

/**
 * Drug classes, so an allergy recorded as the class catches the members of it.
 *
 * A patient allergic to penicillin is allergic to amoxicillin, and nobody writes
 * "amoxicillin" in the allergy box — they write "penicillin". Matching only on
 * the name would miss exactly the allergy that matters most at an OPD counter.
 *
 * This is a starter list of the classes that come up daily in general practice.
 * It is a prompt to check, never a substitute for the prescriber's judgement,
 * and the clinic should extend it with whatever its own patients react to.
 */
const ALLERGY_CLASSES = [
  { terms: ['penicillin', 'penicillins', 'pencillin'],
    matches: /penicillin|amoxicillin|amoxycillin|ampicillin|cloxacillin|piperacillin|augmentin|amoxyclav|clavulan/ },
  { terms: ['cephalosporin', 'cephalosporins'],
    matches: /cef|ceph/ },
  { terms: ['sulfa', 'sulpha', 'sulphonamide', 'sulfonamide'],
    matches: /sulfamethoxazole|sulphamethoxazole|cotrimoxazole|co-trimoxazole|sulfasalazine/ },
  { terms: ['nsaid', 'nsaids', 'painkiller', 'painkillers'],
    matches: /ibuprofen|diclofenac|naproxen|aceclofenac|ketorolac|indomethacin|piroxicam|aspirin/ },
  { terms: ['aspirin', 'salicylate'],
    matches: /aspirin|acetylsalicylic|salicyl/ },
  { terms: ['quinolone', 'quinolones', 'fluoroquinolone'],
    matches: /floxacin/ },
  { terms: ['macrolide', 'macrolides'],
    matches: /azithromycin|erythromycin|clarithromycin|roxithromycin/ },
  { terms: ['tetracycline', 'tetracyclines'],
    matches: /cycline/ },
  { terms: ['statin', 'statins'],
    matches: /statin/ },
];

/**
 * Allergy check run before prescribing and before dispensing.
 *
 * Matches the recorded allergy against the brand name, the generic name, and
 * the drug class — so "penicillin" on the file stops an amoxicillin going out.
 */
function safetyCheck(patientId, drugIds) {
  const patient = db.prepare('SELECT allergies FROM patients WHERE id = ?').get(patientId);
  const warnings = [];
  if (!patient || !patient.allergies) return warnings;

  const allergyTerms = patient.allergies.split(/[,;/]/).map((a) => a.trim().toLowerCase()).filter(Boolean);
  const seen = new Set();

  for (const id of drugIds) {
    const drug = db.prepare('SELECT name, generic_name FROM drugs WHERE id = ?').get(id);
    if (!drug) continue;
    const haystack = `${drug.name} ${drug.generic_name || ''}`.toLowerCase();

    for (const term of allergyTerms) {
      if (term.length <= 2) continue;
      const byName = haystack.includes(term);
      const byClass = ALLERGY_CLASSES.some((c) =>
        c.terms.some((t) => term.includes(t)) && c.matches.test(haystack));
      if (!byName && !byClass) continue;

      const key = `${id}|${term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(byClass && !byName
        ? `Recorded allergy "${term}" covers the class ${drug.name} belongs to. Confirm with the prescriber.`
        : `Recorded allergy "${term}" may match ${drug.name}. Confirm with the prescriber.`);
    }
  }
  return warnings;
}

function assertPositive(qty, label) {
  if (!(Number(qty) > 0)) throw badRequest(`${label} must be greater than zero.`);
}

module.exports = {
  round2, availableBatches, stockOnHand, writeLedger, receiveStock,
  allocate, consume, lowStock, expiringSoon, safetyCheck, assertPositive,
  gstOnLine, gstSummary, amountInWords,
};
