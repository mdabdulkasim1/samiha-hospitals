'use strict';
const nodemailer = require('nodemailer');
const config = require('../config');
const { db } = require('../db');

/**
 * Email delivery for account recovery and backup notices.
 *
 * Two providers:
 *   - "smtp" → a real mailbox (Gmail with an App Password by default)
 *   - "mock" → nothing leaves the machine; the message is written to the
 *              notification outbox so an administrator can still read the
 *              reset link. This is the default, so the app works offline.
 *
 * Every message is copied to config.mail.recoveryEmail — the clinic's central
 * mailbox — so an account can be recovered even when the staff member has lost
 * access to their own inbox.
 */

let transport = null;
function getTransport() {
  if (transport) return transport;
  if (config.mail.provider !== 'smtp') return null;
  if (!config.mail.user || !config.mail.pass) {
    throw new Error('SMTP_USER and SMTP_PASS must be set for MAIL_PROVIDER=smtp.');
  }
  transport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: { user: config.mail.user, pass: config.mail.pass },
  });
  return transport;
}

function record({ to, subject, body, status, error }) {
  db.prepare(
    `INSERT INTO notifications (channel, to_addr, template, body, status, error, sent_at)
     VALUES ('email', ?, ?, ?, ?, ?, CASE WHEN ? = 'sent' THEN datetime('now') ELSE NULL END)`
  ).run(to, subject, body, status, error || null, status);
}

/**
 * Send one email. Never throws — a failure is recorded so the desk can see it
 * and retry, rather than breaking the request that triggered it.
 */
async function send({ to, subject, text, html, attachments, copyRecovery = true }) {
  const recipients = [...new Set([to, copyRecovery ? config.mail.recoveryEmail : null].filter(Boolean))];
  const joined = recipients.join(', ');

  if (config.mail.provider !== 'smtp') {
    record({ to: joined, subject, body: text || '', status: 'sent' });
    console.log(`\n[mail:mock] to ${joined}\n[mail:mock] ${subject}\n${text}\n`);
    return { ok: true, mocked: true, recipients };
  }

  try {
    await getTransport().sendMail({
      from: config.mail.from, to: joined, subject, text, html, attachments,
    });
    record({ to: joined, subject, body: text || '', status: 'sent' });
    return { ok: true, mocked: false, recipients };
  } catch (err) {
    record({ to: joined, subject, body: text || '', status: 'failed', error: err.message });
    console.error('[mail] send failed:', err.message);
    return { ok: false, error: err.message, recipients };
  }
}

/** Confirms the SMTP settings actually work, without sending anything. */
async function verify() {
  if (config.mail.provider !== 'smtp') {
    return { ok: true, provider: 'mock', note: 'Running offline — messages go to the outbox.' };
  }
  try {
    await getTransport().verify();
    return { ok: true, provider: 'smtp', host: config.mail.host, user: config.mail.user };
  } catch (err) {
    return { ok: false, provider: 'smtp', error: err.message };
  }
}

// ---------------------------------------------------------------- templates
const templates = {
  passwordReset({ name, link, ttlMinutes, requestedFrom }) {
    const subject = `Reset your ${config.clinic.name} password`;
    const text =
      `Hello ${name},\n\n` +
      `A password reset was requested for your ${config.clinic.name} ERP account.\n\n` +
      `Open this link to choose a new password:\n${link}\n\n` +
      `The link expires in ${ttlMinutes} minutes and can be used once.\n` +
      (requestedFrom ? `Requested from: ${requestedFrom}\n` : '') +
      `\nIf you did not ask for this, ignore this email — your password has not changed. ` +
      `If you keep receiving these, tell your administrator.\n\n` +
      `— ${config.clinic.name}\n${config.clinic.phone}`;
    const html =
      `<div style="font-family:Georgia,serif;max-width:520px;margin:auto">
         <h2 style="color:#9E1B34;margin-bottom:4px">${escapeHtml(config.clinic.name)}</h2>
         <div style="color:#176B7C;letter-spacing:.12em;font-size:11px;text-transform:uppercase">
           Care • Compassion • Commitment</div>
         <hr style="border:0;border-top:2px solid #9E1B34;margin:14px 0">
         <p style="font-family:Arial,sans-serif">Hello ${escapeHtml(name)},</p>
         <p style="font-family:Arial,sans-serif">A password reset was requested for your ERP account.</p>
         <p style="text-align:center;margin:26px 0">
           <a href="${escapeHtml(link)}" style="background:#9E1B34;color:#fff;padding:12px 26px;
              border-radius:7px;text-decoration:none;font-family:Arial,sans-serif;font-weight:bold">
             Choose a new password</a></p>
         <p style="font-family:Arial,sans-serif;font-size:13px;color:#43555F">
           The link expires in ${ttlMinutes} minutes and can be used once.
           If you did not ask for this, ignore this email — your password has not changed.</p>
         <p style="font-family:Arial,sans-serif;font-size:12px;color:#74858E;word-break:break-all">
           ${escapeHtml(link)}</p>
       </div>`;
    return { subject, text, html };
  },

  passwordChanged({ name, when }) {
    return {
      subject: `Your ${config.clinic.name} password was changed`,
      text:
        `Hello ${name},\n\n` +
        `Your ERP password was changed on ${when}.\n\n` +
        `If this was not you, contact your administrator immediately — someone else may have ` +
        `access to your account.\n\n— ${config.clinic.name}`,
    };
  },

  backupNotice({ filename, sizeMb, when, kind, retention }) {
    return {
      subject: `${config.clinic.name} — database backup ${filename}`,
      text:
        `A ${kind} backup of the ${config.clinic.name} database completed.\n\n` +
        `File: ${filename}\nSize: ${sizeMb} MB\nTaken: ${when}\n\n` +
        `The last ${retention} backups are kept on the server. Copy them somewhere off the ` +
        `machine as well — a backup that lives only on the same disk is not a backup.\n\n` +
        `— ${config.clinic.name}`,
    };
  },

  backupFailed({ error, when }) {
    return {
      subject: `⚠ ${config.clinic.name} — database backup FAILED`,
      text:
        `The scheduled database backup failed at ${when}.\n\n` +
        `Error: ${error}\n\n` +
        `Check disk space and the BACKUP_DIR setting. Until this is fixed there is no ` +
        `recent copy of the clinic's records.\n\n— ${config.clinic.name}`,
    };
  },
};

function escapeHtml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { send, verify, templates, escapeHtml };
