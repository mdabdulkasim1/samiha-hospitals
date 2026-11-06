'use strict';
/**
 * The address a sent bill lives at.
 *
 * This is the one part of the ERP that answers without a login, because the
 * people who need it are patients and because WhatsApp's own servers fetch
 * the link to attach the document. Everything that makes that safe is in the
 * token: 128 random bits, one document behind it, and an expiry date.
 *
 * Nothing here lists, searches or enumerates. A token either names a stored
 * file or it does not.
 */
const express = require('express');
const billShare = require('../services/billShare');
const config = require('../config');

const router = express.Router();

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A page for a patient who followed a link that is no longer good. */
function notice(res, status, heading, line) {
  const c = config.clinic;
  res.status(status).type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.name)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #F4F7F9; color: #16232B;
         font: 15px/1.6 "Segoe UI", system-ui, -apple-system, Arial, sans-serif; }
  .card { background: #fff; border-radius: 10px; padding: 28px 24px; max-width: 420px; margin: 18px;
          box-shadow: 0 2px 16px rgba(0,0,0,.08); text-align: center; }
  h1 { font-size: 17px; margin: 0 0 4px; color: #9E1B34; }
  .clinic { font-size: 12px; letter-spacing: 1.4px; text-transform: uppercase; color: #176B7C;
            font-weight: 600; margin-bottom: 14px; }
  p { margin: 8px 0 0; color: #5A6B74; }
  a { color: #9E1B34; }
</style></head>
<body><div class="card">
  <div class="clinic">${esc(c.name)}</div>
  <h1>${esc(heading)}</h1>
  <p>${esc(line)}</p>
  <p>Please call the clinic on <a href="tel:${esc(String(c.phone).replace(/\s/g, ''))}">${esc(c.phone)}</a>
     and we will send it again.</p>
</div></body></html>`);
}

/**
 * One shared bill.
 *
 * Served inline so a phone opens it in its own viewer rather than dropping a
 * file into the downloads folder, and marked private and no-store so it is
 * not cached by anything between here and the patient.
 */
router.get('/:token', (req, res) => {
  const token = String(req.params.token || '').replace(/\.pdf$/i, '');
  const row = billShare.fetch(token);
  if (!row) {
    return billShare.expired(token)
      ? notice(res, 410, 'This link has expired',
        'For safety, a bill we send stays available for a few months and then stops.')
      : notice(res, 404, 'We could not find that bill',
        'The link may have been copied incompletely.');
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${row.filename.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Length', row.content.length);
  return res.end(row.content);
});

module.exports = router;
