'use strict';
/**
 * The signed-in staff member's own corner of the ERP: their alert bell, and the
 * few preferences a doctor sets for themselves. Everything here is scoped to
 * `req.user` — there is no way to read another person's alerts.
 */
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, badRequest } = require('../lib/http');
const { str, int, bool, phone } = require('../lib/validate');
const staffAlerts = require('../services/staffAlerts');
const audit = require('../lib/audit');

const router = express.Router();

/** The bell: unread count plus the most recent alerts. */
router.get('/notifications', wrap((req, res) => {
  res.json({
    unread: staffAlerts.unreadCount(req.user.id),
    rows: staffAlerts.list(req.user.id, int(req.query.limit, 30) || 30),
  });
}));

/** Cheap poll for the badge alone, so the header can check often. */
router.get('/notifications/count', wrap((req, res) => {
  res.json({ unread: staffAlerts.unreadCount(req.user.id) });
}));

router.post('/notifications/:id/read', wrap((req, res) => {
  staffAlerts.markRead(req.user.id, int(req.params.id));
  res.json({ unread: staffAlerts.unreadCount(req.user.id) });
}));

router.post('/notifications/read-all', wrap((req, res) => {
  const cleared = staffAlerts.markAllRead(req.user.id);
  res.json({ cleared, unread: 0 });
}));

/**
 * How this doctor wants to hear about a booking, and the mobile it goes to.
 * A doctor sets their own; nobody sets it for them here.
 */
router.get('/alert-settings', wrap((req, res) => {
  const row = db.prepare(
    `SELECT u.phone, u.whatsapp, u.email,
            COALESCE(dp.notify_whatsapp, 1) AS notify_whatsapp,
            COALESCE(dp.notify_email, 0)    AS notify_email
       FROM users u LEFT JOIN doctor_profiles dp ON dp.user_id = u.id WHERE u.id = ?`
  ).get(req.user.id);
  if (!row) throw notFound('Account not found');
  res.json({ ...row, isDoctor: req.user.role === 'doctor' });
}));

router.patch('/alert-settings', wrap((req, res) => {
  if (req.body.whatsapp !== undefined) {
    const wa = phone(req.body.whatsapp);
    if (wa && wa.length < 10) throw badRequest('That does not look like a mobile number.');
    db.prepare('UPDATE users SET whatsapp = ? WHERE id = ?').run(wa, req.user.id);
  }
  if (req.user.role === 'doctor') {
    db.prepare('INSERT OR IGNORE INTO doctor_profiles (user_id) VALUES (?)').run(req.user.id);
    if (req.body.notifyWhatsapp !== undefined) {
      db.prepare('UPDATE doctor_profiles SET notify_whatsapp = ? WHERE user_id = ?')
        .run(bool(req.body.notifyWhatsapp) ? 1 : 0, req.user.id);
    }
    if (req.body.notifyEmail !== undefined) {
      db.prepare('UPDATE doctor_profiles SET notify_email = ? WHERE user_id = ?')
        .run(bool(req.body.notifyEmail) ? 1 : 0, req.user.id);
    }
  }
  audit.log(req, 'update', 'alert_settings', req.user.id);
  res.json({ ok: true });
}));

/**
 * The doctor's own signature, stored once and stamped onto what they sign.
 *
 * It is held as a data URL because it is one small image per doctor and it has
 * to travel with a printed sheet without a second request. Nothing else about
 * them goes on that sheet.
 */
router.get('/signature', wrap((req, res) => {
  const row = db.prepare('SELECT signature_image FROM doctor_profiles WHERE user_id = ?').get(req.user.id);
  res.json({ signature: (row && row.signature_image) || null });
}));

router.put('/signature', wrap((req, res) => {
  if (req.user.role !== 'doctor') throw badRequest('Only a doctor signs a prescription.');
  const image = str(req.body.signature);
  if (!image) {
    db.prepare('UPDATE doctor_profiles SET signature_image = NULL WHERE user_id = ?').run(req.user.id);
    audit.log(req, 'clear_signature', 'doctor', req.user.id);
    return res.json({ signature: null });
  }
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(image)) {
    throw badRequest('Upload the signature as a PNG or JPEG image.');
  }
  // A signature is a small strip of ink. Anything larger is a photograph that
  // will not print well and will bloat every sheet it goes on.
  if (image.length > 400_000) throw badRequest('That image is too large — keep the signature under 300 KB.');

  db.prepare('INSERT OR IGNORE INTO doctor_profiles (user_id) VALUES (?)').run(req.user.id);
  db.prepare('UPDATE doctor_profiles SET signature_image = ? WHERE user_id = ?').run(image, req.user.id);
  audit.log(req, 'set_signature', 'doctor', req.user.id);
  res.json({ signature: image });
}));

/**
 * A doctor blocking a day for themselves — they know before admin does when
 * they cannot sit. Existing appointments are left alone; the desk has to move
 * them, which is deliberate.
 */
router.post('/leave', wrap((req, res) => {
  if (req.user.role !== 'doctor') throw badRequest('Only a doctor has clinic days to block.');
  const date = str(req.body.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw badRequest('Give the date as YYYY-MM-DD.');
  db.prepare('INSERT OR REPLACE INTO doctor_leaves (doctor_id, leave_date, reason) VALUES (?, ?, ?)')
    .run(req.user.id, date, str(req.body.reason));

  const booked = db.prepare(
    `SELECT COUNT(*) AS c FROM appointments WHERE doctor_id = ? AND date(scheduled_at) = ?
       AND status NOT IN ('cancelled','no_show')`
  ).get(req.user.id, date).c;

  audit.log(req, 'block_day', 'doctor', req.user.id, { date });
  res.status(201).json({
    ok: true,
    booked,
    warning: booked
      ? `${booked} patient(s) are already booked that day — the front desk must move or cancel them.`
      : null,
  });
}));

router.delete('/leave/:date', wrap((req, res) => {
  db.prepare('DELETE FROM doctor_leaves WHERE doctor_id = ? AND leave_date = ?')
    .run(req.user.id, str(req.params.date));
  res.json({ ok: true });
}));

module.exports = router;
