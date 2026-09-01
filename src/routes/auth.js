'use strict';
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const auth = require('../lib/auth');
const { wrap, unauthorized, badRequest } = require('../lib/http');
const { required } = require('../lib/validate');
const audit = require('../lib/audit');

const router = express.Router();

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
    clinic: config.clinic,
    whatsappProvider: config.whatsapp.provider,
  });
}));

router.post('/change-password', auth.requireAuth, wrap((req, res) => {
  required(req.body, ['currentPassword', 'newPassword']);
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(req.body.currentPassword, row.password_hash)) {
    throw badRequest('Current password is incorrect');
  }
  if (String(req.body.newPassword).length < 8) throw badRequest('New password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(auth.hashPassword(req.body.newPassword), req.user.id);
  audit.log(req, 'change_password', 'user', req.user.id);
  res.json({ ok: true });
}));

module.exports = router;
