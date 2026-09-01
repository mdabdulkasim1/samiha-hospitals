'use strict';
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const { wrap, badRequest } = require('../lib/http');
const { requireAuth, requireRole } = require('../lib/auth');
const { required, str, phone, int } = require('../lib/validate');
const bot = require('../services/whatsappBot');
const whatsapp = require('../services/whatsapp');
const audit = require('../lib/audit');

const router = express.Router();

// ------------------------------------------------------------------- webhook
/**
 * Meta Cloud API webhook verification handshake.
 * Configure the callback URL as  https://<host>/api/whatsapp/webhook
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

/**
 * Inbound messages. Meta retries on any non-2xx, so this always answers 200
 * and swallows per-message failures into the log rather than the response.
 */
router.post('/webhook', (req, res) => {
  res.sendStatus(200);
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const message of value.messages || []) {
          const from = message.from;
          const text = message.text?.body
            || message.interactive?.button_reply?.title
            || message.interactive?.list_reply?.title
            || message.button?.text
            || '';
          if (!from) continue;
          try {
            bot.handleIncoming(from, text);
          } catch (err) {
            console.error('[whatsapp] bot error for', from, err.message);
            whatsapp.send(from, 'Sorry — something went wrong on our side. Please reply *MENU* to start again, ' +
              `or call us on ${config.clinic.phone}.`).catch(() => {});
          }
        }
        // Delivery receipts
        for (const status of value.statuses || []) {
          db.prepare('UPDATE whatsapp_messages SET status = ? WHERE provider_message_id = ?')
            .run(str(status.status) || 'sent', status.id);
        }
      }
    }
  } catch (err) {
    console.error('[whatsapp] webhook parse error:', err.message);
  }
});

// ----------------------------------------------------------------- simulator
/**
 * Built-in simulator. Lets staff (and this app's demo mode) drive the exact
 * same bot the real webhook drives, without a Meta business account.
 */
router.post('/simulate', requireAuth, wrap((req, res) => {
  required(req.body, ['from', 'text']);
  const from = phone(req.body.from);
  if (!from) throw badRequest('A valid phone number is required.');
  const reply = bot.handleIncoming(from, str(req.body.text));
  audit.log(req, 'whatsapp_simulate', 'whatsapp', null, { from });
  res.json({
    reply,
    session: bot.getSession(from),
    conversation: whatsapp.conversation(from, 60),
  });
}));

router.get('/conversations', requireAuth, wrap((_req, res) => {
  res.json(whatsapp.recentNumbers(40));
}));

router.get('/conversations/:number', requireAuth, wrap((req, res) => {
  const number = phone(req.params.number);
  res.json({
    number,
    patient: bot.findPatient(number),
    session: db.prepare('SELECT * FROM whatsapp_sessions WHERE wa_number = ?').get(number) || null,
    messages: whatsapp.conversation(number, 100),
  });
}));

/** Staff-initiated outbound message on an existing conversation. */
router.post('/send', requireRole('reception', 'counselor', 'cashier', 'nurse', 'pharmacy', 'lab', 'ward'),
  wrap(async (req, res) => {
    required(req.body, ['to', 'body']);
    const to = phone(req.body.to);
    const message = await whatsapp.send(to, str(req.body.body));
    audit.log(req, 'whatsapp_send', 'whatsapp', message ? message.id : null, { to });
    res.status(201).json(message);
  }));

/** Reset a stuck conversation back to the main menu. */
router.post('/conversations/:number/reset', requireAuth, wrap((req, res) => {
  const number = phone(req.params.number);
  bot.setState(number, 'idle', {});
  res.json({ ok: true });
}));

// ------------------------------------------------------------------- outbox
router.get('/outbox', requireAuth, wrap((req, res) => {
  const status = str(req.query.status);
  res.json(db.prepare(
    `SELECT * FROM notifications WHERE (? IS NULL OR status = ?) ORDER BY id DESC LIMIT 200`
  ).all(status, status));
}));

router.post('/outbox/dispatch', requireAuth, wrap(async (req, res) => {
  res.json(await whatsapp.dispatchPending(int(req.body?.limit, 50) || 50));
}));

router.post('/outbox/:id/retry', requireAuth, wrap(async (req, res) => {
  db.prepare("UPDATE notifications SET status = 'queued', error = NULL WHERE id = ?").run(int(req.params.id));
  res.json(await whatsapp.dispatchPending(5));
}));

/** Sessions currently mid-booking — useful when a patient calls in confused. */
router.get('/sessions', requireAuth, wrap((_req, res) => {
  res.json(db.prepare(
    `SELECT s.*, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name, p.uhid
       FROM whatsapp_sessions s LEFT JOIN patients p ON p.id = s.patient_id
      WHERE s.state != 'idle' ORDER BY s.last_message_at DESC LIMIT 50`
  ).all());
}));

module.exports = router;
