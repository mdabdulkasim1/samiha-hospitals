'use strict';
const crypto = require('crypto');
const { db } = require('../db');
const config = require('../config');
const { unauthorized, forbidden } = require('./http');

// ------------------------------------------------------------------ passwords
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------------- sessions
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.session.ttlHours * 3600_000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, expires);
  return { token, expiresAt: expires };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

function userForToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.staff_code, u.name, u.email, u.role, u.department_id, u.active, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token);
  if (!row || !row.active) return null;
  return row;
}

// ------------------------------------------------------------------ middleware
function readToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map((c) => c.trim())
    .find((c) => c.startsWith(config.session.cookieName + '='));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : null;
}

/** Attaches req.user when a valid session exists; does not reject. */
function attachUser(req, _res, next) {
  req.sessionToken = readToken(req);
  req.user = userForToken(req.sessionToken);
  next();
}

/** Rejects unauthenticated requests. */
function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/**
 * Role gate. Admin always passes — a single admin account can operate every
 * desk, which matters for a small polyclinic running short-staffed shifts.
 */
function requireRole(...roles) {
  const allowed = new Set(roles.flat());
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role === 'admin' || allowed.has(req.user.role)) return next();
    next(forbidden(`This action is restricted to: ${[...allowed].join(', ')}`));
  };
}

module.exports = {
  hashPassword, verifyPassword,
  createSession, destroySession, purgeExpiredSessions, userForToken,
  attachUser, requireAuth, requireRole, readToken,
};
