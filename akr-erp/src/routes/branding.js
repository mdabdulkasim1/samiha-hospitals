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
  const slot = req.params.slot;
  if (!branding.SLOTS[slot]) throw notFound('There is no such logo.');
  const found = branding.resolve(slot);
  // Nothing uploaded at all: hand back the file bundled with the source rather
  // than a 404 the page then has to work around.
  if (!found) return res.redirect(302, branding.SLOTS[slot].fallback);
  res.type(found.mime);
  // Fingerprinted in the URL, so it can be cached hard and still change at once.
  res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.sendFile(found.file);
}));

module.exports = router;

/** The administrator's side of it, mounted under /api/masters. */
const admin = express.Router();

admin.get('/', wrap(async (_req, res) => {
  res.json({
    slots: branding.status(),
    settings: branding.settings(),
    // Whether what is uploaded here survives the next deploy.
    ephemeral: branding.isEphemeral(),
  });
}));

/** Whether the artwork carries its own background. */
admin.patch('/', auth.requireRole('admin'), wrap(async (req, res) => {
  const saved = branding.setSettings({ plate: v.bool(req.body.plate, true) });
  audit.log(req, 'branding.settings', 'branding', 'settings', saved);
  res.json({ slots: branding.status(), settings: saved });
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
