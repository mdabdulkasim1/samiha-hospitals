'use strict';
const { db } = require('../db');

/*
 * The conditions printed at the foot of a document.
 *
 * They are held as separate clauses rather than one lump of text so the key
 * account manager can edit a point, add one, or drop one for a particular
 * order without retyping the rest — and so a clause improved today improves
 * every LPO raised tomorrow while leaving every LPO already sent exactly as
 * the supplier received it.
 *
 * Placeholders are filled in from the document. That is not a flourish: the
 * conditions on a real LPO named a supplier who was not the one being ordered
 * from, because the block had been copied across from another order. A name
 * that comes from the order cannot be copied wrong.
 */

const PLACEHOLDERS = {
  '{{company}}': 'the buying company, e.g. AKR General Trading L.L.C',
  '{{supplier}}': "the supplier this LPO is addressed to",
  '{{client}}': 'the client, on a quotation or an order',
  '{{lpo_no}}': 'this LPO number',
  '{{doc_no}}': 'this document number',
  '{{project}}': 'the project named on the document',
  '{{authority}}': 'the approving authority — DEWA, Dubai Municipality, Etisalat',
  '{{delivery_date}}': 'the delivery date on the document',
  '{{payment_terms}}': 'the payment terms chosen on the document',
  '{{application}}': 'the application — potable water, storm water, and so on',
};

/** Fill the placeholders in one clause from a document's own details. */
function fill(text, context = {}) {
  const values = {
    company: context.company || 'the buying company',
    supplier: context.supplier || 'the supplier',
    client: context.client || 'the client',
    lpo_no: context.lpo_no || 'this order',
    doc_no: context.doc_no || context.lpo_no || 'this document',
    project: context.project || 'this project',
    authority: context.authority || 'the approving authority',
    delivery_date: context.delivery_date || 'the date stated above',
    payment_terms: context.payment_terms || 'the terms stated above',
    application: context.application || 'the stated application',
  };
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    (values[key] === undefined ? whole : values[key]));
}

/** The clause library for a document type. */
function list(docType, { defaultsOnly = false, includeInactive = false } = {}) {
  const where = ['doc_type = ?'];
  const params = [docType];
  if (!includeInactive) where.push('active = 1');
  if (defaultsOnly) where.push('is_default = 1');
  return db.prepare(
    `SELECT * FROM terms_clauses WHERE ${where.join(' AND ')} ORDER BY sort_order, id`
  ).all(...params);
}

/** The clauses a new document starts with, already filled in. */
function forDocument(docType, context = {}) {
  return list(docType, { defaultsOnly: true }).map((c) => ({
    id: c.id,
    clause_group: c.clause_group,
    text: fill(c.text, context),
  }));
}

/**
 * The block as it is stored on the document and printed.
 *
 * Numbered, one clause to a line. Once written onto the document it is that
 * document's own text: editing the library afterwards does not reach back and
 * change an order a supplier is already working to.
 */
function textFor(docType, context = {}) {
  return forDocument(docType, context).map((c) => c.text).join('\n');
}

/** Split a stored block back into editable lines, dropping any numbering. */
function toLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
}

const fromLines = (lines) => (lines || []).map((l) => String(l).trim()).filter(Boolean).join('\n');

module.exports = { PLACEHOLDERS, fill, list, forDocument, textFor, toLines, fromLines };
