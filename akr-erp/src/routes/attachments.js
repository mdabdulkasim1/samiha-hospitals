'use strict';
const express = require('express');
const { db } = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const v = require('../lib/validate');
const { wrap, badRequest, notFound, forbidden } = require('../lib/http');
const attachments = require('../services/attachments');
const docs = require('../services/documents');

const router = express.Router();

/*
 * Paperwork kept against a document.
 *
 * What may be attached to what is a fixed list rather than anything the caller
 * names: an entity type arriving from outside would otherwise let a file be
 * hung on a table that does not exist, or on one it has no business touching.
 */
const ENTITIES = {
  sales_order: { table: 'sales_orders', ref: 'so_no', label: "the client's LPO",
    write: ['sales', 'kam', 'accounts'] },
  sales_quotation: { table: 'sales_quotations', ref: 'quote_no', label: 'our quotation',
    write: ['sales', 'kam'] },
  purchase_order: { table: 'purchase_orders', ref: 'lpo_no', label: 'our LPO',
    write: ['kam'] },
  supplier_quotation: { table: 'supplier_quotations', ref: 'quote_no', label: "the supplier's quotation",
    write: ['kam'] },
  supplier_invoice: { table: 'supplier_invoices', ref: 'bill_no', label: "the supplier's invoice",
    write: ['accounts'] },
  sales_invoice: { table: 'sales_invoices', ref: 'invoice_no', label: 'the tax invoice',
    write: ['accounts'] },
  delivery_note: { table: 'delivery_notes', ref: 'dn_no', label: 'the delivery note',
    write: ['logistics', 'kam'] },
  grn: { table: 'grns', ref: 'grn_no', label: 'the goods receipt', write: ['logistics', 'kam'] },
  payment: { table: 'payments', ref: 'payment_no', label: 'the payment', write: ['accounts'] },
  expense: { table: 'expenses', ref: 'voucher_no', label: 'the expense', write: ['accounts'] },
};

function entityFor(type, id) {
  const meta = ENTITIES[type];
  if (!meta) throw badRequest(`Nothing can be attached to "${type}".`);
  const row = db.prepare(`SELECT id, ${meta.ref} AS ref FROM ${meta.table} WHERE id = ?`).get(id);
  if (!row) throw notFound(`No such document to attach to.`);
  return { meta, row };
}

const mayWrite = (user, meta) =>
  user.role === 'admin' || meta.write.includes(user.role);

/*
 * Opening a file, and why this route comes first.
 *
 * '/:type/:id' would happily match '/file/123' with the type "file", and the
 * request would be turned away as an unknown entity rather than served. Express
 * takes the first route that matches, so the specific one goes above the
 * general one.
 */
router.get('/file/:id', wrap(async (req, res) => {
  const { row, file } = attachments.fileFor(req.params.id);
  if (!ENTITIES[row.entity_type]) throw notFound('No such attachment.');

  res.type(row.mime || 'application/octet-stream');
  // Shown in the browser rather than downloaded — the point is to look at it.
  res.setHeader('Content-Disposition',
    `inline; filename="${row.filename.replace(/["\\]/g, '')}"`);
  // It is somebody's paperwork; no cache but this browser's.
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  res.sendFile(file);
}));

/** Everything filed against one document. */
router.get('/:type/:id', wrap(async (req, res) => {
  const { meta, row } = entityFor(req.params.type, req.params.id);
  res.json({
    entity: { type: req.params.type, id: row.id, ref: row.ref, label: meta.label },
    rows: attachments.listFor(req.params.type, row.id),
    canAttach: mayWrite(req.user, meta),
    maxMb: require('../config').maxAttachmentMb,
  });
}));

/**
 * Keep a file against a document.
 *
 * Sent as base64 in JSON rather than as a multipart form: it keeps the upload
 * on the same path as every other request in this system, and a trading
 * office's paperwork is a few megabytes, not a video.
 */
router.post('/:type/:id', wrap(async (req, res) => {
  const { meta, row } = entityFor(req.params.type, req.params.id);
  if (!mayWrite(req.user, meta)) {
    throw forbidden(`Attaching to ${meta.label} is restricted to: ${meta.write.join(', ')}.`);
  }
  v.required(req.body, ['data', 'filename']);

  const saved = attachments.save({
    entityType: req.params.type,
    entityId: row.id,
    data: req.body.data,
    filename: req.body.filename,
    mime: v.str(req.body.mime),
    kind: v.str(req.body.kind),
    notes: v.str(req.body.notes),
    companyId: docs.defaultCompany() ? docs.defaultCompany().id : null,
    userId: req.user.id,
  });

  audit.log(req, 'attachment.added', req.params.type, row.id,
    { ref: row.ref, filename: saved.filename, size: saved.size_bytes });
  res.status(201).json(saved);
}));

router.delete('/:id', wrap(async (req, res) => {
  const row = attachments.get(req.params.id);
  if (!row) throw notFound('No such attachment.');
  const meta = ENTITIES[row.entity_type];
  if (!meta || !mayWrite(req.user, meta)) throw forbidden('You cannot remove this attachment.');
  attachments.remove(row.id);
  audit.log(req, 'attachment.removed', row.entity_type, row.entity_id,
    { filename: row.filename });
  res.json({ ok: true });
}));

module.exports = router;
module.exports.ENTITIES = ENTITIES;
