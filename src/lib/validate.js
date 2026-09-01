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

module.exports = { required, str, num, int, bool, oneOf, phone, money, paging, isBlank };
