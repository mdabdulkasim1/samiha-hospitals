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
  const [scheme, salt, expected] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Rejects passwords that would not survive a determined guess. */
function passwordProblems(password) {
  const value = String(password || '');
  const problems = [];
  if (value.length < 8) problems.push('be at least 8 characters long');
  if (!/[A-Za-z]/.test(value)) problems.push('contain a letter');
  if (!/[0-9]/.test(value)) problems.push('contain a number');
  if (/^[0-9]+$/.test(value)) problems.push('not be only numbers');
  const common = ['password', '12345678', 'akr@1234', 'qwerty123', 'admin123', 'welcome1'];
  if (common.includes(value.toLowerCase())) problems.push('not be a commonly used password');
  return problems;
}

// ------------------------------------------------------------------- sessions
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.session.ttlHours * 3600_000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, expiresAt: expires };
}

const destroySession = (token) => { if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token); };
const purgeExpiredSessions = () => db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

function userForToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.staff_code, u.name, u.email, u.role, u.designation, u.company_id, u.active,
            c.code AS company_code, c.name AS company_name, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN companies c ON c.id = u.company_id
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

function attachUser(req, _res, next) {
  req.sessionToken = readToken(req);
  req.user = userForToken(req.sessionToken);
  next();
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/**
 * Role gate. An administrator always passes: in a trading house of this size
 * one person covers two desks on any given week, and the account that answers
 * for all of it must be able to work all of it.
 */
function requireRole(...roles) {
  const allowed = new Set(roles.flat());
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role === 'admin' || allowed.has(req.user.role)) return next();
    next(forbidden(`This action is restricted to: ${[...allowed].join(', ')}`));
  };
}

/*
 * Who may see what, in money terms. One list, exported once, so a screen and
 * its endpoint can never disagree about who is allowed to see a figure.
 *
 * seesPrices  — the rate on a quotation, an LPO, an invoice. The desks that
 *               negotiate, order, deliver against and collect on those
 *               documents. Not logistics: a driver's delivery note carries
 *               quantities and part numbers, and a priced one in the wrong
 *               hands tells a client's storeman what we paid.
 *
 * seesMoney   — the books: ledgers, ageing, payments, the cheque register,
 *               what the group earned and spent. The accounts desk, the key
 *               account manager who answers for a client's balance, and the
 *               administrator.
 *
 * seesCost    — what we paid the manufacturer, and therefore the margin.
 *               Whoever sets the selling price needs it; a sales officer
 *               working to a price list does not, and a client asking for a
 *               discount should not be able to read it off a screen.
 */
const PRICE_ROLES = ['admin', 'kam', 'accounts', 'sales'];
const MONEY_ROLES = ['admin', 'kam', 'accounts'];
const COST_ROLES  = ['admin', 'kam', 'accounts'];
/*
 * buildsRates — who works a selling rate up from the maker's price and the
 * charges on it. The desks that price the work: the sales officer who prepares
 * the quotation, the key account manager who approves it, and the
 * administrator. Not accounts, who book what was agreed rather than set it,
 * and not logistics, who never see money at all.
 */
const RATE_ROLES  = ['admin', 'kam', 'sales'];

const seesPrices = (user) => Boolean(user) && PRICE_ROLES.includes(user.role);
const seesMoney  = (user) => Boolean(user) && MONEY_ROLES.includes(user.role);
const seesCost   = (user) => Boolean(user) && COST_ROLES.includes(user.role);
const buildsRates = (user) => Boolean(user) && RATE_ROLES.includes(user.role);

/** Strip the fields a role may not see from a row or list of rows. */
function screen(user, rows, fields) {
  const list = Array.isArray(rows) ? rows : [rows];
  for (const row of list) {
    if (!row) continue;
    for (const f of fields) if (f in row) row[f] = null;
  }
  return rows;
}

/** Blank out cost and margin for anyone who may not see them. */
function screenCost(user, rows) {
  if (seesCost(user)) return rows;
  return screen(user, rows, ['cost_price', 'cost_total', 'margin', 'margin_percent', 'gross_profit']);
}

module.exports = {
  PRICE_ROLES, MONEY_ROLES, COST_ROLES, RATE_ROLES,
  seesPrices, seesMoney, seesCost, buildsRates, screen, screenCost,
  hashPassword, verifyPassword, passwordProblems,
  createSession, destroySession, purgeExpiredSessions, userForToken,
  attachUser, requireAuth, requireRole, readToken,
};
