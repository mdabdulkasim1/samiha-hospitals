'use strict';
const { db } = require('../db');
const { conflict, badRequest } = require('../lib/http');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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

/** Simple duplicate-therapy / allergy check run before dispensing. */
function safetyCheck(patientId, drugIds) {
  const patient = db.prepare('SELECT allergies FROM patients WHERE id = ?').get(patientId);
  const warnings = [];
  if (patient && patient.allergies) {
    const allergyTerms = patient.allergies.split(/[,;]/).map((a) => a.trim().toLowerCase()).filter(Boolean);
    for (const id of drugIds) {
      const drug = db.prepare('SELECT name, generic_name FROM drugs WHERE id = ?').get(id);
      if (!drug) continue;
      const haystack = `${drug.name} ${drug.generic_name || ''}`.toLowerCase();
      for (const term of allergyTerms) {
        if (term.length > 2 && haystack.includes(term)) {
          warnings.push(`Recorded allergy "${term}" may match ${drug.name}. Confirm with the prescriber.`);
        }
      }
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
};
