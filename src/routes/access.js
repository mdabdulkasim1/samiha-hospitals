'use strict';
/**
 * Which screens each role is shown — the owner's to decide.
 *
 * What this is, and what it is not, because the difference matters.
 *
 * It decides what appears in somebody's menu. A clinic is not obliged to put
 * every screen in front of every person entitled to one: a nurse who never
 * touches the WhatsApp console does not need it in her sidebar, and an
 * administrator the owner would rather kept out of the reports can have them
 * taken off. That is a question about the shape of the working day, and the
 * owner is the right person to answer it.
 *
 * It is NOT the thing that protects patient records or the clinic's money.
 * Every endpoint still enforces its own roles exactly as before — a cashier
 * whose Billing screen is hidden is still a cashier to the server, and the
 * financial reports still refuse everyone but the owner, the administrator
 * and the counsellor whatever is set here. Hiding narrows; it never widens,
 * and it can never grant a screen a role was not entitled to in the first
 * place.
 *
 * Stored as what is hidden rather than what is allowed, deliberately. A
 * screen added to the app next year appears for the roles that qualify for
 * it, rather than vanishing for everybody because nobody thought to tick a
 * new box.
 */
const express = require('express');
const { db } = require('../db');
const { wrap, badRequest } = require('../lib/http');
const { requireOwner } = require('../lib/auth');
const audit = require('../lib/audit');

const router = express.Router();
// Not requireRole('owner'): an administrator must not be able to set their
// own screens back on. See requireOwner in src/lib/auth.js.
const ownerOnly = requireOwner;

const KEY = 'access.hidden';

/*
 * The screens the owner can switch off, and who they belong to.
 *
 * This mirrors the navigation in public/js/app.js. It is written out rather
 * than derived because the server has no view of the browser's menu, and a
 * list the owner is shown has to be the list the server will accept.
 */
const SCREENS = [
  { id: 'dashboard', label: 'Dashboard', group: 'Front office' },
  { id: 'queue', label: 'Patient Queue', group: 'Front office' },
  { id: 'enquiries', label: 'Enquiries', group: 'Front office' },
  { id: 'appointments', label: 'Appointments', group: 'Front office' },
  { id: 'patients', label: 'Patients', group: 'Front office' },
  { id: 'track', label: 'Patient Track', group: 'Front office' },
  { id: 'vitals', label: 'Nurse Station', group: 'Clinical' },
  { id: 'myclinic', label: 'My Clinic', group: 'Clinical' },
  { id: 'consult', label: 'Consultation', group: 'Clinical' },
  { id: 'lab', label: 'Diagnostics', group: 'Clinical' },
  { id: 'pharmacy', label: 'Pharmacy', group: 'Clinical' },
  { id: 'ipd', label: 'Wards & Beds', group: 'In-patient' },
  { id: 'assets', label: 'Assets & Calibration', group: 'In-patient' },
  { id: 'billing', label: 'Billing & Payments', group: 'Money' },
  { id: 'insurance', label: 'Insurance & TPA', group: 'Money' },
  { id: 'rates', label: 'Services & Rates', group: 'Money' },
  { id: 'financial', label: 'Financial Assistance', group: 'Money' },
  { id: 'accounts', label: 'Accounts & Expenses', group: 'Money' },
  { id: 'whatsapp', label: 'WhatsApp', group: 'Channels & insight' },
  { id: 'reports', label: 'Reports', group: 'Channels & insight' },
  { id: 'workflow', label: 'Workflow Map', group: 'Channels & insight' },
  { id: 'staff', label: 'Staff & Doctors', group: 'Channels & insight' },
];

/*
 * Two things are never hideable.
 *
 * The owner's own menu, because an owner who could hide their own screens
 * could hide the screen that unhides them, and the only way back would be
 * somebody editing the database. And Account & System for everybody, because
 * that is where a person changes their own password.
 */
const NEVER_HIDE = ['account'];
const CONFIGURABLE_ROLES = ['admin', 'doctor', 'nurse', 'reception', 'pharmacy',
  'lab', 'cashier', 'counselor', 'ward'];

const SCREEN_IDS = new Set(SCREENS.map((s) => s.id));

/** What the owner has switched off, as a plain object of role → screen ids. */
function hiddenMap() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  if (!row || !row.value) return {};
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A setting nobody can parse is a setting nobody set. Better an empty
    // map — everything visible — than a crash on every sign-in.
    console.error('[access] the stored screen settings could not be read; ignoring them.');
    return {};
  }
}

/** What this particular user should not be shown. */
function hiddenFor(user) {
  if (!user) return [];
  // The owner sees everything there is; that is what the role is.
  if (user.role === 'owner') return [];
  return (hiddenMap()[user.role] || []).filter((id) => SCREEN_IDS.has(id));
}

router.get('/', ownerOnly, wrap((req, res) => {
  res.json({
    screens: SCREENS,
    roles: CONFIGURABLE_ROLES,
    hidden: hiddenMap(),
    neverHide: NEVER_HIDE,
  });
}));

router.put('/', ownerOnly, wrap((req, res) => {
  const incoming = req.body && req.body.hidden;
  if (!incoming || typeof incoming !== 'object') {
    throw badRequest('Send a map of role to the screens that role should not see.');
  }

  const clean = {};
  for (const [role, list] of Object.entries(incoming)) {
    if (!CONFIGURABLE_ROLES.includes(role)) {
      throw badRequest(`"${role}" is not a role whose screens can be set.`);
    }
    if (!Array.isArray(list)) throw badRequest(`The list for ${role} should be an array.`);
    const ids = [...new Set(list.map(String))]
      .filter((id) => SCREEN_IDS.has(id) && !NEVER_HIDE.includes(id));
    if (ids.length) clean[role] = ids.sort();
  }

  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(KEY, JSON.stringify(clean));

  audit.log(req, 'set_screen_access', 'settings', null, {
    roles: Object.keys(clean).length,
    hidden: Object.fromEntries(Object.entries(clean).map(([r, v]) => [r, v.length])),
  });
  res.json({ hidden: clean });
}));

module.exports = router;
module.exports.hiddenFor = hiddenFor;
module.exports.SCREENS = SCREENS;
