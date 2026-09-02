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

/** Normalise an Indian-style mobile number to digits with country code. */
function phone(v) {
  const s = str(v);
  if (s === null) return null;
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function money(v, fallback = 0) {
  return Math.round(num(v, fallback) * 100) / 100;
}

/** Paging helper: returns { limit, offset } clamped to sane bounds. */
function paging(query, defaultLimit = 50, maxLimit = 500) {
  const limit = Math.min(Math.max(int(query.limit, defaultLimit) || defaultLimit, 1), maxLimit);
  const page = Math.max(int(query.page, 1) || 1, 1);
  return { limit, offset: (page - 1) * limit, page };
}

/*
 * An Aadhaar number, or nothing.
 *
 * Twelve digits, never starting 0 or 1, and ending in a Verhoeff check digit —
 * the scheme UIDAI uses. Checking it here is worth the few lines: a mistyped
 * Aadhaar is not merely a wrong field, it is a number that may belong to
 * somebody else, and the digit catches every single-digit slip and almost
 * every transposition, which is exactly how they are mistyped.
 */
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function verhoeffOk(digits) {
  let c = 0;
  [...digits].reverse().forEach((ch, i) => {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(ch)]];
  });
  return c === 0;
}

/** '2345 6789 0123' or '234567890123' -> '234567890123'; empty stays empty. */
function aadhaar(value) {
  const raw = String(value === undefined || value === null ? '' : value).replace(/[\s-]/g, '');
  if (!raw) return null;
  if (!/^\d{12}$/.test(raw)) {
    throw badRequest('An Aadhaar number is twelve digits.');
  }
  if (/^[01]/.test(raw)) {
    throw badRequest('An Aadhaar number does not begin with 0 or 1 — check the number.');
  }
  if (!verhoeffOk(raw)) {
    throw badRequest('That Aadhaar number fails its check digit — a digit has been mistyped.');
  }
  return raw;
}

/** The 4-4-4 grouping an Aadhaar is written in, for anything that prints it. */
function formatAadhaar(value) {
  const raw = String(value || '').replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(raw)) return '';
  return `${raw.slice(0, 4)} ${raw.slice(4, 8)} ${raw.slice(8)}`;
}

module.exports = {
  aadhaar, formatAadhaar, verhoeffOk, required, str, num, int, bool, oneOf, phone, money, paging, isBlank };
