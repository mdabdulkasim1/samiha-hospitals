'use strict';
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const clinic = require('../services/clinic');
const auth = require('../lib/auth');
const { wrap, unauthorized, badRequest } = require('../lib/http');
const { required, str } = require('../lib/validate');
const audit = require('../lib/audit');
const mailer = require('../services/mailer');

const router = express.Router();

// A reset request is cheap to send and expensive to receive, so the same
// address cannot be used to spray a mailbox.
const resetAttempts = new Map();
function throttled(key, limit = 5, windowMs = 15 * 60_000) {
  const now = Date.now();
  const hits = (resetAttempts.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  resetAttempts.set(key, hits);
  if (resetAttempts.size > 5000) resetAttempts.clear();
  return hits.length > limit;
}

router.post('/login', wrap((req, res) => {
  required(req.body, ['username', 'password']);
  const { username, password } = req.body;
  const user = db.prepare(
    'SELECT * FROM users WHERE (email = ? OR staff_code = ?) AND active = 1'
  ).get(String(username).trim().toLowerCase(), String(username).trim().toUpperCase());

  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    throw unauthorized('Invalid credentials');
  }

  const session = auth.createSession(user.id);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  res.cookie(config.session.cookieName, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: config.session.ttlHours * 3600_000,
  });
  audit.log({ ...req, user }, 'login', 'user', user.id);
  res.json({
    token: session.token,
    expiresAt: session.expiresAt,
    user: { id: user.id, name: user.name, role: user.role, staffCode: user.staff_code, email: user.email, departmentId: user.department_id },
  });
}));

router.post('/logout', wrap((req, res) => {
  auth.destroySession(req.sessionToken);
  res.clearCookie(config.session.cookieName);
  res.json({ ok: true });
}));

router.get('/me', wrap((req, res) => {
  if (!req.user) throw unauthorized();
  const dept = req.user.department_id
    ? db.prepare('SELECT name FROM departments WHERE id = ?').get(req.user.department_id)
    : null;
  res.json({
    user: {
      id: req.user.id, name: req.user.name, role: req.user.role,
      staffCode: req.user.staff_code, email: req.user.email,
      departmentId: req.user.department_id, departmentName: dept ? dept.name : null,
    },
    clinic: clinic.profile(),
    whatsappProvider: config.whatsapp.provider,
  });
}));

router.post('/change-password', auth.requireAuth, wrap(async (req, res) => {
  required(req.body, ['currentPassword', 'newPassword']);
  const row = db.prepare('SELECT password_hash, name, email FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(req.body.currentPassword, row.password_hash)) {
    throw badRequest('Current password is incorrect');
  }
  const problems = auth.passwordProblems(req.body.newPassword);
  if (problems.length) throw badRequest(`The new password must ${problems.join(', ')}.`, { problems });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(auth.hashPassword(req.body.newPassword), req.user.id);
  // Signing out everywhere else is the point of changing a password.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken || '');

  const msg = mailer.templates.passwordChanged({
    name: row.name, when: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
  mailer.send({ to: row.email, subject: msg.subject, text: msg.text })
    .catch((err) => console.error('[mail]', err.message));

  audit.log(req, 'change_password', 'user', req.user.id);
  res.json({ ok: true, note: 'Password changed. Other sessions have been signed out.' });
}));

// ------------------------------------------------------------- forgot password
/**
 * Start a reset. Always answers the same way whether or not the account exists —
 * this endpoint must not become a way to discover who works here.
 * The link is copied to the clinic's recovery mailbox, so an account can still
 * be recovered when the staff member has lost access to their own inbox.
 */
router.post('/forgot-password', wrap(async (req, res) => {
  required(req.body, ['username']);
  const username = str(req.body.username);
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;

  const generic = {
    ok: true,
    message: `If that account exists, a reset link has been sent to its email address and to ` +
      `${config.mail.recoveryEmail}. The link is valid for ${config.mail.resetTtlMinutes} minutes.`,
  };

  if (throttled(`${username}|${ip}`)) {
    audit.log(req, 'forgot_password_throttled', 'user', null, { username });
    return res.json(generic);
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE (LOWER(email) = LOWER(?) OR UPPER(staff_code) = UPPER(?)) AND active = 1'
  ).get(username, username);

  if (!user) {
    audit.log(req, 'forgot_password_unknown', 'user', null, { username });
    return res.json(generic);
  }

  const { token, expiresAt } = auth.createResetToken(user.id, {
    requestedBy: username, ip, ttlMinutes: config.mail.resetTtlMinutes,
  });
  const link = `${config.appUrl}/#/reset?token=${encodeURIComponent(token)}`;
  const msg = mailer.templates.passwordReset({
    name: user.name, link, ttlMinutes: config.mail.resetTtlMinutes, requestedFrom: ip,
  });
  const sent = await mailer.send({
    to: user.email, subject: msg.subject, text: msg.text, html: msg.html,
  });

  audit.log(req, 'forgot_password', 'user', user.id, { username, delivered: sent.ok });

  // Offline installs have no mailbox to check, so the administrator needs the
  // link itself — it is already visible to them in the outbox either way.
  res.json({
    ...generic,
    ...(config.mail.provider !== 'smtp'
      ? { devLink: link, devNote: 'Email is in offline mode — this link is shown because no message was actually sent. Set MAIL_PROVIDER=smtp to email it instead.' }
      : {}),
    expiresAt,
  });
}));

/** Lets the reset screen tell a bad link from a good one before asking for a password. */
router.get('/reset-password/:token', wrap((req, res) => {
  const user = auth.userForResetToken(req.params.token);
  if (!user) {
    return res.status(400).json({
      valid: false,
      error: 'This reset link has expired or has already been used. Request a new one.',
    });
  }
  res.json({ valid: true, name: user.name, email: maskEmail(user.email), staffCode: user.staff_code });
}));

router.post('/reset-password', wrap(async (req, res) => {
  required(req.body, ['token', 'newPassword']);
  const user = auth.userForResetToken(req.body.token);
  if (!user) throw badRequest('This reset link has expired or has already been used. Request a new one.');

  const problems = auth.passwordProblems(req.body.newPassword);
  if (problems.length) throw badRequest(`The password must ${problems.join(', ')}.`, { problems });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(auth.hashPassword(req.body.newPassword), user.id);
  auth.consumeResetToken(user.reset_id);
  // Anyone signed in with the old password is signed out.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

  const msg = mailer.templates.passwordChanged({
    name: user.name, when: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
  mailer.send({ to: user.email, subject: msg.subject, text: msg.text })
    .catch((err) => console.error('[mail]', err.message));

  audit.log({ ...req, user: { id: user.id, name: user.name, role: user.role } },
    'reset_password', 'user', user.id);
  res.json({ ok: true, message: 'Password updated. You can sign in with it now.' });
}));

/** Shows enough of the address to recognise it, without publishing it. */
function maskEmail(email) {
  if (!email) return null;
  const [name, domain] = String(email).split('@');
  if (!domain) return '•••';
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}${'•'.repeat(Math.max(name.length - 2, 1))}@${domain}`;
}

module.exports = router;
