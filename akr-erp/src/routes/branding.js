'use strict';
const express = require('express');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const v = require('../lib/validate');
const { wrap, notFound } = require('../lib/http');
const branding = require('../services/branding');

const router = express.Router();

/*
 * Serving the company's mark.
 *
 * Open, deliberately: it is on the sign-in page before anybody has signed in,
 * and in the print window, which opens as a document of its own. A logo is
 * what a company puts on its letterhead — there is nothing in it to protect.
 */
router.get('/:slot', wrap(async (req, res) => {
  const found = branding.find(req.params.slot);
  if (!found) throw notFound('No logo has been uploaded for that.');
  res.type(found.mime);
  // Fingerprinted in the URL, so it can be cached hard and still change at once.
  res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.sendFile(found.file);
}));

module.exports = router;

/** The administrator's side of it, mounted under /api/masters. */
const admin = express.Router();

admin.get('/', wrap(async (_req, res) => {
  res.json({ slots: branding.status() });
}));

admin.post('/:slot', auth.requireRole('admin'), wrap(async (req, res) => {
  v.required(req.body, ['data']);
  const saved = branding.save(req.params.slot, {
    data: req.body.data,
    mime: v.str(req.body.mime),
    filename: v.str(req.body.filename),
  });
  audit.log(req, 'branding.updated', 'branding', req.params.slot,
    { filename: saved.filename, size: saved.size_bytes });
  res.json({ ...saved, slots: branding.status() });
}));

admin.delete('/:slot', auth.requireRole('admin'), wrap(async (req, res) => {
  const removed = branding.clear(req.params.slot);
  audit.log(req, 'branding.cleared', 'branding', req.params.slot);
  res.json({ ok: true, removed, slots: branding.status() });
}));

module.exports.admin = admin;
