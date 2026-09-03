'use strict';
/*
 * Who the clinic is, on paper.
 *
 * The name, address and payment details come from the environment on a fresh
 * install, because a deployment should stand up without anybody logging in.
 * Once it is running, the people who run it change these under Account &
 * System, and what they set is stored in `settings` and wins — a clinic should
 * not have to redeploy to correct a phone number or move its UPI collection to
 * a new account.
 */
const { db } = require('../db');
const config = require('../config');

/** The keys the clinic may set for itself, and the config value each falls back to. */
const EDITABLE = {
  'clinic.name': 'name',
  'clinic.address': 'address',
  'clinic.phone': 'phone',
  'clinic.email': 'email',
  'clinic.gstin': 'gstin',
  'clinic.upiId': 'upiId',
  'clinic.upiName': 'upiName',
};

function overrides() {
  const rows = db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${Object.keys(EDITABLE).map(() => '?').join(', ')})`
  ).all(...Object.keys(EDITABLE));
  const out = {};
  for (const r of rows) {
    // An empty string is "not set", not "set to nothing": it falls back.
    if (r.value !== null && String(r.value).trim() !== '') out[EDITABLE[r.key]] = String(r.value).trim();
  }
  return out;
}

/** The clinic as every document and screen should see it. */
function profile() {
  return { ...config.clinic, ...overrides() };
}

/** What the settings screen shows: the stored value and where it came from. */
function editable() {
  const stored = db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${Object.keys(EDITABLE).map(() => '?').join(', ')})`
  ).all(...Object.keys(EDITABLE));
  const byKey = new Map(stored.map((r) => [r.key, r.value]));
  return Object.entries(EDITABLE).map(([key, field]) => ({
    key,
    field,
    value: byKey.has(key) && byKey.get(key) !== null ? byKey.get(key) : '',
    fallback: config.clinic[field] || '',
  }));
}

function save(patch) {
  const write = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const changed = [];
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.prototype.hasOwnProperty.call(EDITABLE, key)) continue;
      write.run(key, value === null || value === undefined ? '' : String(value).trim());
      changed.push(key);
    }
  })();
  return changed;
}

module.exports = { profile, editable, save, EDITABLE };
