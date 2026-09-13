'use strict';
const express = require('express');
const { wrap, notFound, forbidden } = require('../lib/http');
const { requireAuth, requireRole } = require('../lib/auth');
const { str } = require('../lib/validate');
const xlsx = require('../lib/xlsx');
const exports_ = require('../services/exports');
const audit = require('../lib/audit');
const config = require('../config');

const router = express.Router();

/**
 * Downloading the department's own data as a workbook.
 *
 * A download is not a lesser kind of screen. Whatever a role may not see in
 * the app it may not see in the file either, and that is applied here on the
 * server rather than by leaving a column out of a template — the same reason
 * the money rules are enforced in the API and not in the browser.
 *
 * Every download is written to the audit log with its size and sheet count.
 * A spreadsheet of the clinic's patients leaving the building is exactly the
 * kind of event somebody should be able to ask about six months later.
 */

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function send(res, req, filename, sheets, what) {
  const book = xlsx.build(sheets);
  audit.log(req, 'export', 'workbook', null, {
    what, filename, sheets: sheets.length,
    rows: sheets.reduce((t, s) => t + s.rows.length, 0),
    bytes: book.length,
  });
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', book.length);
  // A workbook is a snapshot of the moment it was asked for, never a cached one.
  res.setHeader('Cache-Control', 'no-store');
  res.end(book);
}

/** What this user may download. */
router.get('/', requireAuth, wrap((req, res) => {
  res.json({
    departments: exports_.menuFor(req.user),
    full: req.user.role === 'admin',
  });
}));

/** One department's workbook. */
router.get('/:key.xlsx', requireAuth, wrap((req, res) => {
  const key = str(req.params.key);
  if (!exports_.DEPARTMENTS[key]) throw notFound('No such export.');
  if (!exports_.canOpen(key, req.user)) {
    throw forbidden('That is another department\'s data.');
  }
  const book = exports_.department(key, req.user);
  const date = new Date().toISOString().slice(0, 10);
  send(res, req, `${slug(config.clinic.name)}-${key}-${date}.xlsx`, book.sheets, key);
}));

/**
 * The whole clinic in one book. The administrator's, and theirs alone — this
 * is the only download that carries the audit log and the staff list.
 */
router.get('/full/backup.xlsx', requireRole('admin'), wrap((req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  send(res, req, `${slug(config.clinic.name)}-full-backup-${date}.xlsx`,
    exports_.everything(req.user), 'full');
}));

module.exports = router;
