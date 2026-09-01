'use strict';
const { db } = require('../db');
const config = require('../config');
const notifications = require('./notifications');

/**
 * WhatsApp transport.
 *
 * Two providers:
 *   - "meta"  → Meta WhatsApp Cloud API (real sends over HTTPS)
 *   - "mock"  → nothing leaves the box; messages are stored and shown in the
 *               built-in simulator. This is the default so the ERP is fully
 *               demonstrable without a Meta business account.
 */

function logMessage({ waNumber, direction, body, messageType = 'text', payload = null, providerMessageId = null, status, error = null }) {
  const info = db.prepare(
    `INSERT INTO whatsapp_messages (wa_number, direction, body, message_type, payload, provider_message_id, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(waNumber, direction, body, messageType, payload ? JSON.stringify(payload) : null,
        providerMessageId, status || (direction === 'in' ? 'received' : 'queued'), error);
  return db.prepare('SELECT * FROM whatsapp_messages WHERE id = ?').get(info.lastInsertRowid);
}

async function sendViaMeta(to, body) {
  const { token, phoneNumberId, apiVersion } = config.whatsapp;
  if (!token || !phoneNumberId) {
    throw new Error('WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be set for provider "meta".');
  }
  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error?.message || `Meta API responded ${res.status}`);
  }
  return json?.messages?.[0]?.id || null;
}

/** Send one message now. Always logged, whichever provider is configured. */
async function send(to, body) {
  if (!to) return null;
  if (config.whatsapp.provider === 'meta') {
    try {
      const id = await sendViaMeta(to, body);
      return logMessage({ waNumber: to, direction: 'out', body, providerMessageId: id, status: 'sent' });
    } catch (err) {
      return logMessage({ waNumber: to, direction: 'out', body, status: 'failed', error: err.message });
    }
  }
  return logMessage({ waNumber: to, direction: 'out', body, status: 'sent' });
}

/**
 * Drain the notification outbox. Called after workflow steps and on a timer,
 * so a failed send is retried rather than lost.
 */
async function dispatchPending(limit = 25) {
  const rows = notifications.pending(limit);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.channel !== 'whatsapp') {
      // SMS/email transports are not wired up; mark them so they do not spin.
      notifications.markSent(row.id);
      sent += 1;
      continue;
    }
    const msg = await send(row.to_addr, row.body);
    if (msg && msg.status === 'failed') {
      notifications.markFailed(row.id, msg.error || 'send failed');
      failed += 1;
    } else {
      notifications.markSent(row.id);
      sent += 1;
    }
  }
  return { sent, failed, considered: rows.length };
}

/** Queue a templated message and try to deliver it straight away. */
function notify({ to, template, data, refType, refId, scheduledAt }) {
  const row = notifications.queue({ to, template, data, refType, refId, scheduledAt });
  if (row && !scheduledAt) {
    // Fire and forget — delivery failures stay recorded in the outbox.
    dispatchPending(5).catch((err) => console.error('[whatsapp] dispatch:', err.message));
  }
  return row;
}

function conversation(waNumber, limit = 50) {
  return db.prepare(
    'SELECT * FROM whatsapp_messages WHERE wa_number = ? ORDER BY id DESC LIMIT ?'
  ).all(waNumber, limit).reverse();
}

function recentNumbers(limit = 30) {
  return db.prepare(
    `SELECT m.wa_number,
            MAX(m.created_at) AS last_at,
            COUNT(*) AS messages,
            (SELECT p.id FROM patients p WHERE p.whatsapp = m.wa_number OR p.phone = m.wa_number LIMIT 1) AS patient_id,
            (SELECT p.first_name || ' ' || COALESCE(p.last_name, '') FROM patients p
              WHERE p.whatsapp = m.wa_number OR p.phone = m.wa_number LIMIT 1) AS patient_name
       FROM whatsapp_messages m
      GROUP BY m.wa_number
      ORDER BY last_at DESC
      LIMIT ?`
  ).all(limit);
}

module.exports = { send, logMessage, dispatchPending, notify, conversation, recentNumbers };
