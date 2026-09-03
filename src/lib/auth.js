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

// ------------------------------------------------------------ password rules
/** Rejects passwords that would not survive a determined guess. */
function passwordProblems(password) {
  const value = String(password || '');
  const problems = [];
  if (value.length < 8) problems.push('be at least 8 characters long');
  if (!/[A-Za-z]/.test(value)) problems.push('contain a letter');
  if (!/[0-9]/.test(value)) problems.push('contain a number');
  if (/^[0-9]+$/.test(value)) problems.push('not be only numbers');
  const common = ['password', '12345678', 'samiha@123', 'qwerty123', 'admin123', 'welcome1'];
  if (common.includes(value.toLowerCase())) problems.push('not be a commonly used password');
  return problems;
}

// ------------------------------------------------------------- reset tokens
/** Only the hash is stored; the raw token exists solely in the emailed link. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createResetToken(userId, { requestedBy = null, ip = null, ttlMinutes = 30 } = {}) {
  // One live token per account — issuing a new link invalidates the old one.
  db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL")
    .run(userId);
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  db.prepare(
    'INSERT INTO password_resets (user_id, token_hash, requested_by, ip, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, hashToken(token), requestedBy, ip, expiresAt);
  return { token, expiresAt };
}

/** Returns the user for a live token, or null. Does not consume it. */
function userForResetToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT r.id AS reset_id, u.id, u.name, u.email, u.staff_code, u.role, u.active
       FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > datetime('now')`
  ).get(hashToken(token));
  if (!row || !row.active) return null;
  return row;
}

function consumeResetToken(resetId) {
  db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?").run(resetId);
}

function purgeExpiredResets() {
  db.prepare("DELETE FROM password_resets WHERE expires_at < datetime('now', '-7 days')").run();
}

/*
 * Who may see rupees, anywhere in the system.
 *
 * A clinic is read by everybody in it — the technician at the bench, the nurse
 * at the station, the desk that books the appointment — and what a patient
 * owes is not their work. Money belongs to the people who handle it: the
 * cashier who takes it, the counsellor who decides what to waive, and the
 * administrator who answers for both.
 *
 * One list, exported once, so a screen and its endpoint cannot disagree about
 * who is allowed to see a figure.
 */
const MONEY_ROLES = ['admin', 'cashier', 'counselor'];
const seesMoney = (user) => Boolean(user) && MONEY_ROLES.includes(user.role);

module.exports = {
  MONEY_ROLES, seesMoney,
  hashPassword, verifyPassword, passwordProblems,
  createResetToken, userForResetToken, consumeResetToken, purgeExpiredResets, hashToken,
  createSession, destroySession, purgeExpiredSessions, userForToken,
  attachUser, requireAuth, requireRole, readToken,
};
