'use strict';
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const v = require('../lib/validate');
const { wrap, badRequest, unauthorized } = require('../lib/http');
const branding = require('../services/branding');
const screens = require('../services/screens');

const router = express.Router();

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, staffCode: u.staff_code, role: u.role,
  designation: u.designation, companyId: u.company_id, companyCode: u.company_code,
  companyName: u.company_name,
});

/** Everything the front end needs to render itself once somebody is signed in. */
function context(user) {
  const company = user.company_id
    ? db.prepare('SELECT * FROM companies WHERE id = ?').get(user.company_id)
    : db.prepare('SELECT * FROM companies WHERE is_default = 1').get();
  return {
    user: publicUser(user),
    company: company ? {
      id: company.id, code: company.code, name: company.name, legalName: company.legal_name,
      trn: company.trn, address: company.address, phone: company.phone, email: company.email,
      website: company.website, currency: company.currency, vatPercent: company.vat_percent,
      // Whatever the company has uploaded, falling back to the bundled file.
      logo: branding.urlFor('mark'), logoFull: branding.urlFor('full'),
      // Whether there is artwork to print. There always is now: the company's
      // mark ships in public/assets, so a document carries it on the first run
      // with nothing uploaded and no volume mounted. What must never reach a
      // client's desk is a placeholder announcing that the logo is missing,
      // which is what this flag was guarding against.
      logoSet: true,
      // Whether that artwork is the company's own file or the bundled
      // rendition of it. The Logo screen says which; nothing else needs to.
      logoUploaded: Boolean(branding.resolve('mark')),
      // Whether to put a light plate behind it — see services/branding.js.
      logoPlate: branding.settings().plate,
      bankName: company.bank_name, bankAccount: company.bank_account, iban: company.iban, swift: company.swift,
    } : null,
    group: {
      name: config.group.name,
      companies: db.prepare('SELECT id, code, name, is_default FROM companies WHERE active = 1 ORDER BY is_default DESC, code').all(),
    },
    currency: config.vat.currency,
    currencySymbol: config.vat.currencySymbol,
    vatPercent: config.vat.percent,
    /*
     * Whether the books survive the next deploy.
     *
     * This has been a warning in the server's console since the beginning, and
     * nobody reads a container's console. It belongs where the person who can
     * fix it will see it, which is on their screen, every day, until it is
     * fixed — losing a month of invoices to a deploy is not a thing to find
     * out afterwards.
     */
    storage: config.dbIsEphemeral ? 'ephemeral' : (config.volumePath ? 'volume' : 'local'),
    // The commit running, shown in the sidebar — see config.js for why.
    release: config.release,
    permissions: {
      seesPrices: auth.seesPrices(user),
      seesMoney: auth.seesMoney(user),
      seesCost: auth.seesCost(user),
    },
    // The screens this person may open: their desk's default, with whatever
    // the administrator has changed for them.
    screens: screens.effective(user),
  };
}

/**
 * What the sign-in page needs before anybody has signed in: the company's name
 * and whether its artwork carries its own background. Open on purpose — it is
 * the letterhead, which is public by nature.
 */
router.get('/look', wrap(async (_req, res) => {
  res.json({
    logoPlate: branding.settings().plate,
    /*
     * The commit running, before anybody has signed in.
     *
     * Which version is live turned out to be the hardest question to answer
     * about this system, and answering it should not require a password on a
     * phone. It is on the sign-in page, in the corner.
     */
    release: config.release,
  });
}));

router.post('/login', wrap(async (req, res) => {
  v.required(req.body, ['username', 'password']);
  const username = String(req.body.username).trim();
  const row = db.prepare(
    'SELECT * FROM users WHERE (lower(email) = lower(?) OR upper(staff_code) = upper(?))'
  ).get(username, username);

  if (!row || !auth.verifyPassword(req.body.password, row.password_hash)) {
    audit.log(req, 'login.failed', 'user', null, { username });
    throw unauthorized('Those sign-in details are not right.');
  }
  if (!row.active) throw unauthorized('That account has been deactivated.');

  const { token, expiresAt } = auth.createSession(row.id);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  res.cookie(config.session.cookieName, token, {
    httpOnly: true, sameSite: 'Lax', secure: config.isProd,
    maxAge: config.session.ttlHours * 3600_000,
  });
  // The request itself, with the user attached — spreading it would drop the
  // headers the audit row records the address from.
  req.user = auth.userForToken(token);
  audit.log(req, 'login', 'user', row.id);
  res.json({ token, expiresAt, ...context(req.user) });
}));

router.post('/logout', wrap(async (req, res) => {
  auth.destroySession(req.sessionToken);
  res.clearCookie(config.session.cookieName);
  res.json({ ok: true });
}));

router.get('/me', wrap(async (req, res) => {
  if (!req.user) throw unauthorized();
  res.json(context(req.user));
}));

router.post('/change-password', wrap(async (req, res) => {
  if (!req.user) throw unauthorized();
  v.required(req.body, ['currentPassword', 'newPassword']);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(req.body.currentPassword, row.password_hash)) {
    throw badRequest('That is not your current password.');
  }
  const problems = auth.passwordProblems(req.body.newPassword);
  if (problems.length) throw badRequest(`A password must ${problems.join(', ')}.`);

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(auth.hashPassword(req.body.newPassword), req.user.id);
  // Everyone signed in on the old password is signed out, except this session.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
  audit.log(req, 'password.changed', 'user', req.user.id);
  res.json({ ok: true, message: 'Your password has been changed.' });
}));

module.exports = router;
module.exports.context = context;
