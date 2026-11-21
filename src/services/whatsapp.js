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
async function sendViaMeta(to, body, options = {}) {
  const { token, phoneNumberId, apiVersion } = config.whatsapp;
  if (!token || !phoneNumberId) {
    throw new Error('WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be set for provider "meta".');
  }

  let requestBody;
  if (options.interactive) {
    const inter = { ...options.interactive };
    if (inter.type === 'list' && inter.action?.sections) {
      let count = 0;
      inter.action.button = String(inter.action.button || 'Select').slice(0, 20);
      inter.action.sections = inter.action.sections.map((sec) => {
        const remaining = 10 - count;
        if (remaining <= 0) return null;
        const rows = (sec.rows || []).slice(0, remaining).map((r) => ({
          id: String(r.id),
          title: String(r.title).slice(0, 24),
          description: r.description ? String(r.description).slice(0, 72) : undefined,
        }));
        count += rows.length;
        return { title: String(sec.title || '').slice(0, 24), rows };
      }).filter(Boolean);
    } else if (inter.type === 'button' && inter.action?.buttons) {
      inter.action.buttons = inter.action.buttons.slice(0, 3).map((b) => ({
        type: 'reply',
        reply: {
          id: String(b.reply?.id || b.id),
          title: String(b.reply?.title || b.title).slice(0, 20),
        },
      }));
    }
    requestBody = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: inter,
    };
  } else if (options.template) {
    requestBody = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: options.template,
    };
  } else {
    requestBody = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body },
    };
  }

  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error?.message || `Meta API responded ${res.status}`);
  }
  return json?.messages?.[0]?.id || null;
}

async function postToMeta(to, message) {
  const { token, phoneNumberId, apiVersion } = config.whatsapp;
  if (!token || !phoneNumberId) {
    throw new Error('WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be set for provider "meta".');
  }
  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Meta API responded ${res.status}`);
    err.code = json?.error?.code || null;
    err.details = json?.error?.error_data?.details || null;
    throw err;
  }
  return json?.messages?.[0]?.id || null;
}


/**
 * Whether a refusal means "you may not write to this person right now".
 *
 * WhatsApp allows a business to send whatever it likes for 24 hours after
 * the patient's own last message, and after that only an approved template.
 * 131047 is the re-engagement error, 131026 the undeliverable one that is
 * raised for the same reason on some accounts, and 470 is its older name.
 * The sentences are matched too, because Meta has reworded them before and
 * a new code would otherwise look like a different fault.
 */
const WINDOW_CODES = [131047, 131026, 470];

function isWindowClosed(err) {
  if (!err) return false;
  const said = `${err.message || ''} ${err.details || ''}`;
  // A failure read back off a stored message has its code in front of the
  // sentence rather than on a field, because that is how it was written to
  // the conversation; both forms are understood.
  const stamped = Number((said.match(/^\s*\[(\d+)\]/) || [])[1]);
  if (WINDOW_CODES.includes(Number(err.code)) || WINDOW_CODES.includes(stamped)) return true;
  return /re-?engagement|24 hours|outside.*window|message template/i.test(said);
}

/**
 * Send a file — a bill, so far — as a WhatsApp document.
 *
 * Meta fetches the link itself rather than taking the bytes from us, so the
 * URL has to be reachable from the public internet. That is why a shared bill
 * is served from a tokenised address and not from behind the staff login.
 *
 * The caption is what shows above the attachment in the chat. The filename is
 * what the patient sees when they save it, so it carries the bill number.
 */
const sendDocumentViaMeta = (to, { link, filename, caption }) =>
  postToMeta(to, { type: 'document', document: { link, filename, caption } });

/**
 * Send a document now.
 *
 * Returns the logged message either way. A send can fail for a reason the
 * counter has to hear about rather than discover later — most often that
 * WhatsApp only allows a free-form message within 24 hours of the patient's
 * own last one — so the failure is recorded against the conversation and
 * handed back, not swallowed.
 */
async function sendDocument(to, { link, filename, caption = '' } = {}) {
  if (!to || !link) return null;
  const payload = { link, filename };
  if (config.whatsapp.provider === 'meta') {
    try {
      const id = await sendDocumentViaMeta(to, { link, filename, caption });
      return logMessage({
        waNumber: to, direction: 'out', body: caption, messageType: 'document',
        payload, providerMessageId: id, status: 'sent',
      });
    } catch (err) {
      return logMessage({
        waNumber: to, direction: 'out', body: caption, messageType: 'document',
        payload, status: 'failed', error: metaError(err),
      });
    }
  }
  return logMessage({
    waNumber: to, direction: 'out', body: caption, messageType: 'document',
    payload, status: 'sent',
  });
}

/**
 * Send a document under an approved template.
 *
 * This is the only way to put a bill in front of a patient who has not
 * written to the clinic in the last 24 hours — which, at a counter, is
 * almost all of them. The template is approved once in Meta Business
 * Manager with a document header; the file and the few words that vary are
 * filled in per message.
 *
 * Body parameters may not contain a newline, a tab, or four spaces in a
 * row: Meta rejects the whole message if they do, so they are flattened
 * here rather than at every call site.
 */
const flatten = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/\s+/g, ' ').trim();

async function sendTemplateDocumentViaMeta(to, { name, language, link, filename, params = [] }) {
  const components = [{
    type: 'header',
    parameters: [{ type: 'document', document: { link, filename } }],
  }];
  if (params.length) {
    components.push({
      type: 'body',
      parameters: params.map((text) => ({ type: 'text', text: flatten(text) || '-' })),
    });
  }
  return postToMeta(to, {
    type: 'template',
    template: { name, language: { code: language || 'en' }, components },
  });
}

/**
 * Send a document as a template message.
 *
 * Recorded in the conversation like any other message, with the template
 * name kept on the row: a clinic looking at a bill that did not arrive
 * needs to know which template was used and what was put in it.
 */
async function sendDocumentTemplate(to, { name, language, link, filename, params = [], body = '' } = {}) {
  if (!to || !link || !name) return null;
  const payload = { link, filename, template: name, language: language || 'en', params };
  if (config.whatsapp.provider === 'meta') {
    try {
      const id = await sendTemplateDocumentViaMeta(to, { name, language, link, filename, params });
      return logMessage({
        waNumber: to, direction: 'out', body, messageType: 'template',
        payload, providerMessageId: id, status: 'sent',
      });
    } catch (err) {
      return logMessage({
        waNumber: to, direction: 'out', body, messageType: 'template',
        payload, status: 'failed', error: metaError(err),
      });
    }
  }
  return logMessage({
    waNumber: to, direction: 'out', body, messageType: 'template', payload, status: 'sent',
  });
}

/**
 * What Meta's templates say about themselves.
 *
 * A template is written and approved outside this system, so the one thing
 * the clinic cannot tell from in here is whether the name in the settings
 * actually exists and has been approved yet. This asks.
 */
async function listTemplates() {
  const { token, wabaId, apiVersion } = config.whatsapp;
  if (config.whatsapp.provider !== 'meta') {
    return { configured: false, reason: 'WhatsApp is in simulator mode on this system.', templates: [] };
  }
  if (!token || !wabaId) {
    return {
      configured: false,
      reason: 'Set WHATSAPP_WABA_ID (the WhatsApp Business Account ID) to read back your templates.',
      templates: [],
    };
  }
  const res = await fetch(
    `https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`
    + '?fields=name,status,category,language,components&limit=100',
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { configured: true, reason: json?.error?.message || `Meta responded ${res.status}`, templates: [] };
  return {
    configured: true,
    reason: null,
    templates: (json.data || []).map((t) => ({
      name: t.name,
      status: t.status,
      category: t.category,
      language: t.language,
      // Whether it can carry a bill at all: a template without a document
      // header has nowhere to put the PDF.
      hasDocumentHeader: (t.components || []).some(
        (c) => c.type === 'HEADER' && String(c.format || '').toUpperCase() === 'DOCUMENT'),
      variables: ((t.components || []).find((c) => c.type === 'BODY')?.text || '')
        .match(/\{\{\d+\}\}/g)?.length || 0,
    })),
  };
}

/** Meta's sentence, with its code, so a log line says which refusal it was. */
const metaError = (err) => (err && err.code ? `[${err.code}] ${err.message}` : (err && err.message) || 'send failed');

/** Send one message now. Always logged, whichever provider is configured. */
async function send(to, body, options = {}) {
  if (!to) return null;
  const messageType = options.messageType || (options.interactive ? 'interactive' : 'text');
  const payload = options.payload || options.interactive || null;
  if (config.whatsapp.provider === 'meta') {
    try {
      const id = await sendViaMeta(to, body, options);
      return logMessage({ waNumber: to, direction: 'out', body, messageType, payload, providerMessageId: id, status: 'sent' });
    } catch (err) {
      return logMessage({ waNumber: to, direction: 'out', body, messageType, payload, status: 'failed', error: err.message });
    }
  }
  return logMessage({ waNumber: to, direction: 'out', body, messageType, payload, status: 'sent' });
}

/** Send an interactive list message (Meta interactive: list). */
async function sendInteractiveList(to, { header, body, footer, buttonText = 'Select Service', sections = [] } = {}) {
  const interactive = {
    type: 'list',
    ...(header ? { header: { type: 'text', text: header } } : {}),
    body: { text: body },
    ...(footer ? { footer: { text: footer } } : {}),
    action: {
      button: String(buttonText || 'Select Option').slice(0, 20),
      sections,
    },
  };
  return send(to, body, { messageType: 'interactive', interactive });
}

/** Send interactive reply buttons (Meta interactive: button, max 3). */
async function sendInteractiveButtons(to, { header, body, footer, buttons = [] } = {}) {
  const interactive = {
    type: 'button',
    ...(header ? { header: { type: 'text', text: header } } : {}),
    body: { text: body },
    ...(footer ? { footer: { text: footer } } : {}),
    action: {
      buttons: buttons.slice(0, 3).map((b) => ({
        type: 'reply',
        reply: {
          id: String(b.id),
          title: String(b.title).slice(0, 20),
        },
      })),
    },
  };
  return send(to, body, { messageType: 'interactive', interactive });
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

module.exports = {
  send, sendInteractiveList, sendInteractiveButtons, sendDocument, sendDocumentTemplate, listTemplates, isWindowClosed, logMessage, dispatchPending, notify, conversation, recentNumbers,
};
