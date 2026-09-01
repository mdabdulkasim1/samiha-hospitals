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

/**
 * The visiting windows a doctor actually sits for on a date.
 *
 * Admin fixing hours for a specific date is the stronger statement — our
 * consultants come in for two or three hours on days that are agreed, not on a
 * standing rota — so any `doctor_availability` row for the date REPLACES the
 * weekly pattern. With none, the weekly `doctor_schedules` rota applies.
 */
function sessionsFor(doctorId, dateStr) {
  const fixed = db.prepare(
    `SELECT id, start_time, end_time, slot_minutes, max_tokens, note, 'fixed' AS origin
       FROM doctor_availability WHERE doctor_id = ? AND avail_date = ? ORDER BY start_time`
  ).all(doctorId, dateStr);
  if (fixed.length) return fixed;

  const weekday = parseDateKey(dateStr).getDay();
  return db.prepare(
    `SELECT id, start_time, end_time, slot_minutes, max_tokens, NULL AS note, 'weekly' AS origin
       FROM doctor_schedules WHERE doctor_id = ? AND weekday = ? AND active = 1 ORDER BY start_time`
  ).all(doctorId, weekday);
}

/** The visiting hours to show a patient, e.g. "6:00 PM – 8:00 PM". */
function windowLabel(doctorId, dateStr) {
  const sessions = sessionsFor(doctorId, dateStr);
  if (!sessions.length) return null;
  return sessions.map((s) => `${to12h(s.start_time)} – ${to12h(s.end_time)}`).join(', ');
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
    // `max_tokens` caps how many patients the doctor will see in this window,
    // counting the ones already booked — 0 means "as many as the window holds".
    const cap = s.max_tokens > 0 ? s.max_tokens : Infinity;
    let placed = 0;
    for (let t = toMinutes(s.start_time); t + step <= toMinutes(s.end_time); t += step) {
      if (placed >= cap) break;
      const hhmm = toHHMM(t);
      placed += 1;                       // the slot exists whether or not it is free
      if (taken.has(hhmm)) continue;
      if (isToday && t <= nowMins + 5) continue;
      slots.push(hhmm);
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
    if (slots.length) {
      out.push({ date: key, label: humanDate(key), slots: slots.length, hours: windowLabel(doctorId, key) });
    }
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

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Read a date the way a patient actually types one into WhatsApp:
 *   today · tomorrow · 25.05.26 · 25/05/2026 · 25-5-26 · 28th of May ·
 *   May 28 · 2026-05-28
 * Two-digit years are this century. A bare day/month that has already gone by
 * is taken as next year, since nobody books into the past.
 * Returns 'YYYY-MM-DD', or null when it cannot be read.
 */
function parseDate(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return null;

  const today = new Date();
  const atMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (/^(today|now|2day)$/.test(text)) return dateKey(today);
  if (/^(tomorrow|tmrw|tmr)$/.test(text)) {
    return dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  }
  if (/^day after( tomorrow)?$/.test(text)) {
    return dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2));
  }

  // A weekday name means the next one coming up.
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayIdx = days.findIndex((d) => text === d || text === d.slice(0, 3));
  if (dayIdx !== -1) {
    const ahead = (dayIdx - today.getDay() + 7) % 7 || 7;
    return dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + ahead));
  }

  // ISO first, so it is never mistaken for day-first.
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // Day-first numeric, which is how it is written locally.
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = dmy[3] === undefined ? null : Number(dmy[3]);
    if (year !== null && year < 100) year += 2000;
    if (year === null) {
      const guess = build(today.getFullYear(), month, day);
      if (guess && atMidnight(parseDateKey(guess)) >= atMidnight(today)) return guess;
      return build(today.getFullYear() + 1, month, day);
    }
    return build(year, month, day);
  }

  // '28th of May', '28 may 2026', 'may 28'
  const named = text.match(/^(?:(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s*)?)?([a-z]{3,9})\.?\s*(\d{1,2})?(?:st|nd|rd|th)?,?\s*(\d{2,4})?$/);
  if (named) {
    const monthIdx = MONTHS.indexOf(named[2].slice(0, 3));
    if (monthIdx !== -1) {
      const day = Number(named[1] || named[3]);
      if (day >= 1 && day <= 31) {
        let year = named[4] === undefined ? null : Number(named[4]);
        if (year !== null && year < 100) year += 2000;
        if (year === null) {
          const guess = build(today.getFullYear(), monthIdx + 1, day);
          if (guess && atMidnight(parseDateKey(guess)) >= atMidnight(today)) return guess;
          return build(today.getFullYear() + 1, monthIdx + 1, day);
        }
        return build(year, monthIdx + 1, day);
      }
    }
  }
  return null;

  function build(y, m, d) {
    if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    const dt = new Date(y, m - 1, d);
    // Rejects the likes of 31 February, which Date would roll over.
    if (dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dateKey(dt);
  }
}

/**
 * Read a time the way a patient types one: 15:00 · 3:00 · 3pm · 3.30 pm · 1500.
 * A bare hour of 1–7 is read as afternoon, because the clinic is not open then
 * in the morning and that is what the patient means.
 * Returns 'HH:MM', or null.
 */
function parseTime(input) {
  const text = String(input || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return null;

  const m = text.match(/^(\d{1,2})(?:[:.](\d{2}))?(am|pm|a|p)?$/)
    || text.match(/^(\d{2})(\d{2})$/);
  if (!m) return null;

  let hour = Number(m[1]);
  let minute = Number(m[2] || 0);
  const meridiem = m[3];

  // '1500' style, where the whole thing is one four-digit block.
  if (!m[3] && /^\d{4}$/.test(text)) { hour = Number(text.slice(0, 2)); minute = Number(text.slice(2)); }

  if (meridiem) {
    if (meridiem.startsWith('p') && hour < 12) hour += 12;
    if (meridiem.startsWith('a') && hour === 12) hour = 0;
  } else if (hour >= 1 && hour <= 7) {
    hour += 12;   // '3:00' means the afternoon clinic
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

/** The free slot closest to what was asked for, and a few either side. */
function nearestSlots(doctorId, dateStr, wanted, count = 4) {
  const slots = availableSlots(doctorId, dateStr);
  if (!slots.length) return { exact: null, alternatives: [] };
  if (slots.includes(wanted)) return { exact: wanted, alternatives: [] };

  const toMin = (t) => toMinutes(t);
  const target = toMin(wanted);
  const sorted = [...slots].sort((a, b) => Math.abs(toMin(a) - target) - Math.abs(toMin(b) - target));
  return { exact: null, alternatives: sorted.slice(0, count).sort() };
}

module.exports = {
  dateKey, parseDateKey, availableSlots, nextAvailableDates, humanDate,
  humanDateTime, to12h, nextToken, isSlotFree, sessionsFor, isOnLeave,
  parseDate, parseTime, nearestSlots, windowLabel,
};
