'use strict';
const { db } = require('./index');
const config = require('../config');

/*
 * The company's own details, from .env into the books.
 *
 * Seeding reads .env once, which is no help at all in the ordinary case: the
 * system is set up, somebody runs it, and only then goes and fills in the TRN
 * and the bank account. So on every boot the environment fills in the fields
 * that are still blank on the default company — and only those.
 *
 * Never overwriting a value that is already there is the whole point. Once a
 * detail has been typed under Masters → Companies it belongs to the company,
 * not to a file on the server, and a stale .env must not be able to put an old
 * TRN back onto a live tax invoice.
 */
const FIELDS = [
  ['trn', () => config.company.trn],
  ['legal_name', () => config.company.name],
  ['address', () => config.company.address],
  ['phone', () => config.company.phone],
  ['email', () => config.company.email],
  ['website', () => config.company.website],
  ['bank_name', () => config.company.bankName],
  ['bank_account', () => config.company.bankAccount],
  ['iban', () => config.company.iban],
  ['swift', () => config.company.swift],
];

function applyEnvDefaults() {
  const company = db.prepare('SELECT * FROM companies WHERE is_default = 1').get();
  if (!company) return [];

  const filled = [];
  for (const [column, read] of FIELDS) {
    const value = String(read() || '').trim();
    if (!value) continue;
    const current = company[column];
    if (current !== null && String(current).trim() !== '') continue;
    db.prepare(`UPDATE companies SET ${column} = ? WHERE id = ?`).run(value, company.id);
    filled.push(column);
  }
  return filled;
}

/** What is still missing before this company can issue a valid tax invoice. */
function missingForInvoice() {
  const company = db.prepare('SELECT * FROM companies WHERE is_default = 1').get();
  if (!company) return ['a company'];
  const gaps = [];
  if (!company.trn) gaps.push('TRN');
  if (!company.address) gaps.push('address');
  if (!company.iban && !company.bank_account) gaps.push('bank details');
  return gaps;
}

module.exports = { applyEnvDefaults, missingForInvoice, FIELDS };
