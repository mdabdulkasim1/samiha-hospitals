'use strict';
/**
 * The clinic's own clock.
 *
 * Two kinds of time meet in this system and they are not the same kind.
 *
 *   - A timestamp the database writes — `datetime('now')`, so `arrived_at`,
 *     `called_at`, `created_at` — is UTC. The browser reads those back as
 *     UTC and shows them in whatever zone the person is sitting in, which
 *     at a counter in Melapalayam is IST. That works and should stay.
 *
 *   - A time somebody typed is wall clock. A doctor's visiting hours of
 *     18:00, an appointment slot of 10:15 — six in the evening and a
 *     quarter past ten in the morning, in Melapalayam. There is no timezone
 *     in those strings because there was none in the person's head.
 *
 * Comparing the two needs the clinic's zone said out loud, which is what
 * this file is. Without it a server running on UTC — which is what a cloud
 * host gives you unless it is told otherwise — decides that the evening
 * clinic starts at half past eleven at night and that a ten o'clock
 * appointment is not due until half past three. The queue would then hold
 * every booked patient back all morning and let the walk-ins past them,
 * which is precisely the thing it exists to prevent.
 *
 * Set CLINIC_TZ to move the clinic. India has no daylight saving, so the
 * offset is fixed and the arithmetic below is exact; it stays correct for a
 * zone that does shift, to within the hour of the shift itself.
 */
const TZ = process.env.CLINIC_TZ || 'Asia/Kolkata';

/** A Date, or a database stamp, as a Date. A bare stamp is UTC. */
function asDate(value) {
  if (value instanceof Date) return value;
  const s = String(value);
  return new Date(s.includes('T') || s.endsWith('Z') ? s : `${s.replace(' ', 'T')}Z`);
}

/** What the clinic's wall clock reads at that moment: 'YYYY-MM-DD HH:MM:SS'. */
function wallAt(value = new Date()) {
  return asDate(value).toLocaleString('sv-SE', { timeZone: TZ });
}

/** The clinic's date, 'YYYY-MM-DD'. */
const dateKey = (value = new Date()) => wallAt(value).slice(0, 10);

/** The clinic's time of day, 'HH:MM'. */
const clockHHMM = (value = new Date()) => wallAt(value).slice(11, 16);

/** Minutes since midnight on the clinic's clock. */
function minutesOfDay(value = new Date()) {
  const [h, m] = clockHHMM(value).split(':').map(Number);
  return (h * 60) + m;
}

/** A stamp the database wrote (UTC), as milliseconds. */
const fromStamp = (value) => (value ? asDate(value).getTime() : null);

/**
 * A wall-clock string somebody typed, as milliseconds.
 *
 * '2026-03-10 10:15:00' means a quarter past ten in Melapalayam, so the
 * instant it names is that reading less the clinic's offset from UTC. The
 * offset is measured at that date rather than assumed, so a zone that
 * shifts for summer still lands on the right instant.
 */
function fromWall(value) {
  if (!value) return null;
  const naive = Date.parse(`${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(naive)) return null;
  const shown = Date.parse(`${wallAt(new Date(naive)).replace(' ', 'T')}Z`);
  return naive - (shown - naive);
}

module.exports = { TZ, asDate, wallAt, dateKey, clockHHMM, minutesOfDay, fromStamp, fromWall };
