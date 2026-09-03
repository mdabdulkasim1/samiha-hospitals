'use strict';
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const { wrap, notFound, badRequest } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { str, int } = require('../lib/validate');
const backup = require('../services/backup');
const mailer = require('../services/mailer');
const clinic = require('../services/clinic');
const upi = require('../services/upi');
const audit = require('../lib/audit');

const router = express.Router();
const adminOnly = requireRole('admin');

/**
 * The clinic's own particulars — what prints on every document, and the UPI
 * account a patient's payment lands in.
 *
 * Each row says what is stored and what the deployment would fall back to if
 * it were cleared, so nobody has to guess whether a blank box means "empty" or
 * "using the default".
 */
router.get('/clinic', adminOnly, wrap((_req, res) => {
  const profile = clinic.profile();
  const uri = upi.link({
    upiId: profile.upiId, payeeName: profile.upiName, amount: 1,
    invoiceNo: 'SAMPLE', note: 'Sample',
  });
  res.json({
    fields: clinic.editable(),
    profile,
    upi: {
      configured: Boolean(profile.upiId),
      // A sample code for ₹1, so whoever sets the ID can scan it with their own
      // phone and see the right account name before a patient ever does.
      sampleSvg: uri ? upi.qrSvg(uri) : null,
    },
  });
}));

router.patch('/clinic', adminOnly, wrap((req, res) => {
  const patch = req.body && typeof req.body === 'object' ? req.body : {};
  const unknown = Object.keys(patch).filter((k) => !Object.prototype.hasOwnProperty.call(clinic.EDITABLE, k));
  if (unknown.length) throw badRequest(`Not a clinic setting: ${unknown.join(', ')}`);

  // A UPI ID is checked for shape before it is saved. Money sent to a VPA that
  // does not exist simply fails, but money sent to one that exists and is not
  // ours is gone, so a typo is worth catching at the point it is typed.
  const vpa = patch['clinic.upiId'];
  if (vpa !== undefined && String(vpa).trim() !== '' && !/^[\w.\-]{2,64}@[A-Za-z]{2,64}$/.test(String(vpa).trim())) {
    throw badRequest('A UPI ID looks like name@bank — for example samiha@okicici.');
  }

  const changed = clinic.save(patch);
  audit.log(req, 'update', 'settings', null, { keys: changed });
  res.json({ changed, profile: clinic.profile() });
}));

/** Where recovery and backups are pointed, and whether they actually work. */
router.get('/system', adminOnly, wrap(async (_req, res) => {
  res.json({
    recoveryEmail: config.mail.recoveryEmail,
    mail: {
      provider: config.mail.provider,
      from: config.mail.from,
      host: config.mail.host,
      user: config.mail.user,
      resetTtlMinutes: config.mail.resetTtlMinutes,
      health: await mailer.verify(),
    },
    backup: {
      dir: config.backup.dir,
      retention: config.backup.retention,
      hour: config.backup.hour,
      emailAttach: config.backup.emailAttach,
      last: db.prepare("SELECT * FROM backups WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get() || null,
      failures: db.prepare("SELECT COUNT(*) AS c FROM backups WHERE status = 'failed'").get().c,
    },
    appUrl: config.appUrl,
    whatsappProvider: config.whatsapp.provider,
    environment: config.nodeEnv,
    database: config.dbFile,
    counts: {
      users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
      patients: db.prepare('SELECT COUNT(*) AS c FROM patients').get().c,
      visits: db.prepare('SELECT COUNT(*) AS c FROM visits').get().c,
      invoices: db.prepare('SELECT COUNT(*) AS c FROM invoices').get().c,
    },
  });
}));

/** Sends a real message so the settings can be proved before they are needed. */
router.post('/system/test-email', adminOnly, wrap(async (req, res) => {
  const to = str(req.body.to) || config.mail.recoveryEmail;
  const result = await mailer.send({
    to,
    subject: `${config.clinic.name} — test email`,
    text: `This is a test from the ${config.clinic.name} ERP, sent by ${req.user.name} ` +
      `at ${new Date().toISOString().replace('T', ' ').slice(0, 19)}.\n\n` +
      `If you received it, password-reset links and backup notices will arrive too.`,
    copyRecovery: false,
  });
  audit.log(req, 'test_email', 'system', null, { to, ok: result.ok });
  res.json(result);
}));

// ------------------------------------------------------------------ backups
router.get('/backups', adminOnly, wrap((_req, res) => {
  res.json({ dir: config.backup.dir, retention: config.backup.retention, rows: backup.list() });
}));

router.post('/backups', adminOnly, wrap(async (req, res) => {
  const b = await backup.create({ kind: 'manual', userId: req.user.id });
  audit.log(req, 'backup', 'system', b.id, { filename: b.filename });
  res.status(201).json(b);
}));

router.get('/backups/:filename/download', adminOnly, wrap((req, res) => {
  const file = backup.fileFor(req.params.filename);
  if (!file) throw notFound('That backup is no longer on the server.');
  audit.log(req, 'backup_download', 'system', null, { filename: req.params.filename });
  res.download(file);
}));

router.delete('/backups/:filename', adminOnly, wrap((req, res) => {
  const filename = str(req.params.filename);
  const row = db.prepare('SELECT * FROM backups WHERE filename = ?').get(filename);
  if (!row) throw notFound('Backup not found.');
  const file = backup.fileFor(filename);
  if (file) require('fs').unlinkSync(file);
  db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
  audit.log(req, 'backup_delete', 'system', row.id, { filename });
  res.json({ ok: true });
}));

// -------------------------------------------------------------- staff resets
/** An administrator resetting a password for someone standing at the desk. */
router.post('/users/:id/send-reset', adminOnly, wrap(async (req, res) => {
  const auth = require('../lib/auth');
  const id = int(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id);
  if (!user) throw notFound('Staff member not found.');
  if (!user.email) throw badRequest('This account has no email address — set one first.');

  const { token, expiresAt } = auth.createResetToken(user.id, {
    requestedBy: `admin:${req.user.name}`,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    ttlMinutes: config.mail.resetTtlMinutes,
  });
  const link = `${config.appUrl}/#/reset?token=${encodeURIComponent(token)}`;
  const msg = mailer.templates.passwordReset({
    name: user.name, link, ttlMinutes: config.mail.resetTtlMinutes, requestedFrom: `${req.user.name} (admin)`,
  });
  const sent = await mailer.send({ to: user.email, subject: msg.subject, text: msg.text, html: msg.html });

  audit.log(req, 'admin_send_reset', 'user', user.id);
  res.json({
    ok: true, expiresAt, delivered: sent.ok,
    ...(config.mail.provider !== 'smtp' ? { devLink: link } : {}),
    message: `Reset link sent to ${user.email} and copied to ${config.mail.recoveryEmail}.`,
  });
}));

module.exports = router;
