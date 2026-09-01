'use strict';
const { db } = require('../db');

const pad = (n) => String(n).padStart(2, '0');
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};
const toHHMM = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

/** 'YYYY-MM-DD' for a Date, in local time. */
function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isOnLeave(doctorId, dateStr) {
  return !!db.prepare('SELECT 1 FROM doctor_leaves WHERE doctor_id = ? AND leave_date = ?').get(doctorId, dateStr);
}

function sessionsFor(doctorId, dateStr) {
  const weekday = parseDateKey(dateStr).getDay();
  return db.prepare(
    'SELECT * FROM doctor_schedules WHERE doctor_id = ? AND weekday = ? AND active = 1 ORDER BY start_time'
  ).all(doctorId, weekday);
}

function bookedAt(doctorId, dateStr) {
  const rows = db.prepare(
    `SELECT scheduled_at FROM appointments
      WHERE doctor_id = ? AND date(scheduled_at) = ?
        AND status NOT IN ('cancelled','no_show')`
  ).all(doctorId, dateStr);
  return new Set(rows.map((r) => r.scheduled_at.slice(11, 16)));
}

/**
 * Free slots for a doctor on a date. Slots already in the past are dropped so
 * the WhatsApp bot never offers a time that has gone by.
 */
function availableSlots(doctorId, dateStr) {
  if (isOnLeave(doctorId, dateStr)) return [];
  const taken = bookedAt(doctorId, dateStr);
  const now = new Date();
  const isToday = dateKey(now) === dateStr;
  const nowMins = now.getHours() * 60 + now.getMinutes();

  const slots = [];
  for (const s of sessionsFor(doctorId, dateStr)) {
    const step = s.slot_minutes || 15;
    for (let t = toMinutes(s.start_time); t + step <= toMinutes(s.end_time); t += step) {
      const hhmm = toHHMM(t);
      if (taken.has(hhmm)) continue;
      if (isToday && t <= nowMins + 5) continue;
      slots.push(hhmm);
      if (slots.length >= s.max_tokens * 4) break;
    }
  }
  return slots;
}

/** Next `count` dates (from `fromOffset` days ahead) on which the doctor has slots. */
function nextAvailableDates(doctorId, count = 5, horizonDays = 30) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < horizonDays && out.length < count; i += 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const key = dateKey(d);
    const slots = availableSlots(doctorId, key);
    if (slots.length) out.push({ date: key, label: humanDate(key), slots: slots.length });
  }
  return out;
}

function humanDate(dateStr) {
  const d = parseDateKey(dateStr);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const today = dateKey(new Date());
  const tomorrow = dateKey(new Date(Date.now() + 86400000));
  const suffix = dateStr === today ? ' (today)' : dateStr === tomorrow ? ' (tomorrow)' : '';
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}${suffix}`;
}

function humanDateTime(iso) {
  if (!iso) return '—';
  return `${humanDate(iso.slice(0, 10))} at ${to12h(iso.slice(11, 16))}`;
}

function to12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${pad(m)} ${ampm}`;
}

/** Token number = position among that doctor's appointments for that day. */
function nextToken(doctorId, dateStr) {
  const row = db.prepare(
    `SELECT COALESCE(MAX(token_no), 0) AS t FROM appointments
      WHERE doctor_id = ? AND date(scheduled_at) = ? AND status NOT IN ('cancelled')`
  ).get(doctorId, dateStr);
  return row.t + 1;
}

function isSlotFree(doctorId, scheduledAt) {
  const dateStr = scheduledAt.slice(0, 10);
  const hhmm = scheduledAt.slice(11, 16);
  if (isOnLeave(doctorId, dateStr)) return false;
  return !bookedAt(doctorId, dateStr).has(hhmm);
}

module.exports = {
  dateKey, parseDateKey, availableSlots, nextAvailableDates, humanDate,
  humanDateTime, to12h, nextToken, isSlotFree, sessionsFor, isOnLeave,
};
