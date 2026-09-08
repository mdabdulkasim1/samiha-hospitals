'use strict';
const { badRequest } = require('./http');

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

function required(body, fields) {
  const missing = fields.filter((f) => isBlank(body[f]));
  if (missing.length) throw badRequest(`Missing required field(s): ${missing.join(', ')}`, { missing });
}

function str(v, fallback = null) {
  if (isBlank(v)) return fallback;
  return String(v).trim();
}

function num(v, fallback = 0) {
  if (isBlank(v)) return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw badRequest(`Expected a number but received "${v}"`);
  return n;
}

function int(v, fallback = 0) {
  return Math.trunc(num(v, fallback));
}

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on', 'y'].includes(String(v).toLowerCase());
}

function oneOf(v, allowed, field) {
  const s = str(v);
  if (s === null) return null;
  if (!allowed.includes(s)) {
    throw badRequest(`${field} must be one of: ${allowed.join(', ')}`, { field, allowed });
  }
  return s;
}

/** Money is fils-accurate: two decimals, rounded once, the same way everywhere. */
function money(v, fallback = 0) {
  return Math.round(num(v, fallback) * 100) / 100;
}

/** A quantity may be fractional — metres of geotextile, tonnes of fill. */
function qty(v, fallback = 0) {
  return Math.round(num(v, fallback) * 1000) / 1000;
}

/** 'YYYY-MM-DD', or nothing. Anything else is a typo worth catching here. */
function date(v, fallback = null) {
  const s = str(v);
  if (s === null) return fallback;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) throw badRequest(`Expected a date as YYYY-MM-DD but received "${v}"`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Add days to a 'YYYY-MM-DD' date, staying in date-only arithmetic. */
function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A UAE Tax Registration Number, or nothing.
 *
 * Fifteen digits. It is checked because a wrong TRN on a tax invoice is not a
 * typo the client can ignore — it is the number their own input tax claim
 * rests on, and a mistyped one costs them the claim.
 */
function trn(value) {
  const raw = String(value === undefined || value === null ? '' : value).replace(/[\s-]/g, '');
  if (!raw) return null;
  if (!/^\d{15}$/.test(raw)) {
    throw badRequest('A UAE TRN is fifteen digits — check the number.');
  }
  return raw;
}

/** UAE mobile/landline, normalised to digits with the country code. */
function phone(v) {
  const s = str(v);
  if (s === null) return null;
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length === 9 && digits.startsWith('5')) return `971${digits}`;
  if (digits.length === 10 && digits.startsWith('0')) return `971${digits.slice(1)}`;
  return digits;
}

/** Paging helper: returns { limit, offset, page } clamped to sane bounds. */
function paging(query, defaultLimit = 50, maxLimit = 500) {
  const limit = Math.min(Math.max(int(query.limit, defaultLimit) || defaultLimit, 1), maxLimit);
  const page = Math.max(int(query.page, 1) || 1, 1);
  return { limit, offset: (page - 1) * limit, page };
}

module.exports = {
  required, str, num, int, bool, oneOf, money, qty, date, addDays, today,
  trn, phone, paging, isBlank,
};
