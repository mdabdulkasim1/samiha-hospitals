'use strict';
const { db } = require('../db');
const config = require('../config');
const whatsapp = require('./whatsapp');
const mailer = require('./mailer');
const scheduling = require('./scheduling');

/**
 * Telling a doctor what has been booked into their clinic.
 *
 * Three places carry the same message, because a doctor who is not at the
 * clinic still needs to know:
 *   - the bell inside the ERP (`staff_notifications`), which their phone shows
 *     the moment they sign in;
 *   - WhatsApp to their own mobile, through the same queue patients are sent on;
 *   - email, for doctors who ask for it.
 *
 * A failure to notify must never lose the appointment, so everything here is
 * best-effort and swallows its own errors.
 */

/** Drop an alert into a staff member's bell. */
function push({ userId, kind, title, body, route = null, refType = null, refId = null }) {
  if (!userId) return null;
  const info = db.prepare(
    `INSERT INTO staff_notifications (user_id, kind, title, body, route, ref_type, ref_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, kind, title, body || null, route, refType, refId);
  return db.prepare('SELECT * FROM staff_notifications WHERE id = ?').get(info.lastInsertRowid);
}

function doctorContact(doctorId) {
  return db.prepare(
    `SELECT u.id, u.name, u.email, u.phone, u.whatsapp,
            COALESCE(dp.notify_whatsapp, 1) AS notify_whatsapp,
            COALESCE(dp.notify_email, 0)    AS notify_email
       FROM users u LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
      WHERE u.id = ? AND u.active = 1`
  ).get(doctorId);
}

/** How many patients that doctor already has on that day. */
function dayLoad(doctorId, dateStr) {
  return db.prepare(
    `SELECT COUNT(*) AS c FROM appointments
      WHERE doctor_id = ? AND date(scheduled_at) = ? AND status NOT IN ('cancelled','no_show')`
  ).get(doctorId, dateStr).c;
}

/**
 * The front desk (or the WhatsApp bot) has booked a patient with this doctor.
 * Reaches the doctor's phone, not just the screen at the desk.
 */
function appointmentBooked(appointment, { patientName, bookedBy } = {}) {
  try {
    const doctor = doctorContact(appointment.doctor_id);
    if (!doctor) return;

    const when = scheduling.humanDateTime(appointment.scheduled_at);
    const dateStr = appointment.scheduled_at.slice(0, 10);
    const name = patientName || appointment.guest_name || 'A patient';
    const total = dayLoad(appointment.doctor_id, dateStr);

    push({
      userId: doctor.id,
      kind: 'appointment_booked',
      title: `New appointment — ${name}`,
      body: `${when} · token ${appointment.token_no}. ` +
            `You now have ${total} patient(s) that day.` +
            (bookedBy ? ` Booked by ${bookedBy}.` : ''),
      route: `#/myclinic?date=${dateStr}`,
      refType: 'appointment',
      refId: appointment.id,
    });

    const to = doctor.whatsapp || doctor.phone;
    if (doctor.notify_whatsapp && to) {
      whatsapp.notify({
        to,
        template: 'doctor_new_appointment',
        refType: 'appointment',
        refId: appointment.id,
        data: {
          doctorName: doctor.name, patientName: name, when,
          token: appointment.token_no, apptNo: appointment.appt_no,
          reason: appointment.reason, total,
          phone: appointment.guest_phone || null,
        },
      });
    }

    if (doctor.notify_email && doctor.email) {
      mailer.send({
        to: doctor.email,
        subject: `New appointment — ${name}, ${when}`,
        text: `${name} has been booked into your clinic at ${config.clinic.name}.\n\n` +
              `When: ${when}\nToken: ${appointment.token_no}\nRef: ${appointment.appt_no}\n` +
              (appointment.reason ? `Reason: ${appointment.reason}\n` : '') +
              `\nYou now have ${total} patient(s) that day.`,
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[staff-alert] booking notice failed:', err.message);
  }
}

/** The appointment moved, so the doctor's day changed. */
function appointmentChanged(appointment, { patientName, kind = 'appointment_changed', headline } = {}) {
  try {
    const doctor = doctorContact(appointment.doctor_id);
    if (!doctor) return;
    const when = scheduling.humanDateTime(appointment.scheduled_at);
    const name = patientName || appointment.guest_name || 'A patient';
    const title = headline || `Appointment changed — ${name}`;

    push({
      userId: doctor.id, kind, title,
      body: `${when} · ${appointment.appt_no}`,
      route: `#/myclinic?date=${appointment.scheduled_at.slice(0, 10)}`,
      refType: 'appointment', refId: appointment.id,
    });

    const to = doctor.whatsapp || doctor.phone;
    if (doctor.notify_whatsapp && to) {
      whatsapp.notify({
        to, template: 'generic', refType: 'appointment', refId: appointment.id,
        data: { body: `${config.clinic.name}\n\n${title}\n${when}\nRef: ${appointment.appt_no}` },
      });
    }
  } catch (err) {
    console.error('[staff-alert] change notice failed:', err.message);
  }
}

// ------------------------------------------------------------------ reading
function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM staff_notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId).c;
}

function list(userId, limit = 30) {
  return db.prepare(
    'SELECT * FROM staff_notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?'
  ).all(userId, limit);
}

function markRead(userId, id) {
  db.prepare("UPDATE staff_notifications SET read_at = datetime('now') WHERE user_id = ? AND id = ? AND read_at IS NULL")
    .run(userId, id);
}

function markAllRead(userId) {
  return db.prepare("UPDATE staff_notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL")
    .run(userId).changes;
}

module.exports = {
  push, appointmentBooked, appointmentChanged,
  unreadCount, list, markRead, markAllRead, dayLoad,
};
