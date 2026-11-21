'use strict';
/**
 * The duty chart, over the wire.
 *
 * Reading it is open to the staff who answer for it: the desk quotes it on
 * the phone a dozen times a day, and a receptionist who cannot see when the
 * dentist sits is a receptionist telling people to call back.
 *
 * Writing it belongs to the owner and the administrator alone. It is the
 * document the appointment book, the queue and the WhatsApp line all run
 * from — changing a cell changes what patients are promised — so it is not
 * a thing the front desk edits between calls.
 */
const express = require('express');
const { wrap, badRequest } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { str, int } = require('../lib/validate');
const audit = require('../lib/audit');
const chart = require('../services/dutyChart');

const router = express.Router();

/** Everybody who has to answer "when is the dentist in". */
const readRoles = requireRole('reception', 'nurse', 'doctor', 'counselor', 'cashier',
  'lab', 'pharmacy', 'ward');
/** Owner and administrator only — requireRole() with no arguments. */
const editRoles = requireRole();

const today = () => new Date().toISOString().slice(0, 10);

router.get('/', readRoles, wrap((req, res) => res.json(chart.chart())));

/** One day, laid out as the printed chart draws it. */
router.get('/day/:weekday', readRoles, wrap((req, res) => {
  const weekday = Number(req.params.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw badRequest('A weekday is 0 (Sunday) to 6 (Saturday).');
  }
  res.json(chart.day(weekday, { date: str(req.query.date) || null }));
}));

/** Who is sitting on a date, which is what the desk is actually asked. */
router.get('/on/:date', readRoles, wrap((req, res) => {
  res.json(chart.onDate(str(req.params.date) || today()));
}));

router.get('/clashes', readRoles, wrap((req, res) => res.json({ rows: chart.clashes() })));

/**
 * Replace one doctor's hours for one weekday.
 *
 * The whole day at once, because that is how a chart is edited: somebody
 * looks at Monday and decides what it is.
 */
router.put('/doctors/:id/days/:weekday', editRoles, wrap((req, res) => {
  const out = chart.setDay(int(req.params.id), Number(req.params.weekday),
    req.body.windows || [], { userId: req.user.id });
  audit.log(req, 'duty_chart.set_day', 'doctor', out.doctor.id, {
    weekday: out.weekday,
    windows: out.windows.map((w) => `${w.start_time}-${w.end_time}`).join(', ') || 'none',
  });
  res.json({ ...out, chart: chart.chart() });
}));

/** The same hours on other days — one decision, six rows. */
router.post('/doctors/:id/copy', editRoles, wrap((req, res) => {
  const out = chart.copyDay(int(req.params.id), Number(req.body.from),
    req.body.to || [], { userId: req.user.id });
  audit.log(req, 'duty_chart.copy_day', 'doctor', int(req.params.id), out);
  res.json({ ...out, chart: chart.chart() });
}));

/** Clear one doctor's week — the chart's own "start again" for that row. */
router.delete('/doctors/:id', editRoles, wrap((req, res) => {
  const out = chart.clearWeek(int(req.params.id));
  audit.log(req, 'duty_chart.clear_week', 'doctor', out.doctor.id, { cleared: out.cleared });
  res.json({ ...out, chart: chart.chart() });
}));

/**
 * Clear every weekly timing.
 *
 * What the clinic reaches for when it is putting its own chart in for the
 * first time and wants whatever was there before gone. Hours fixed against
 * a date, and leave, are left alone — those are decisions about particular
 * days rather than the pattern being replaced.
 */
router.delete('/', editRoles, wrap((req, res) => {
  const out = chart.clearAll();
  audit.log(req, 'duty_chart.clear_all', 'schedule', null, out);
  res.json({ ...out, chart: chart.chart() });
}));

/** The room column: where this doctor sits, and their windows follow it. */
router.post('/doctors/:id/room', editRoles, wrap((req, res) => {
  const row = chart.setRoom(int(req.params.id), int(req.body.roomId) || null);
  audit.log(req, 'duty_chart.set_room', 'doctor', int(req.params.id),
    { roomId: int(req.body.roomId) || null });
  res.json({ doctor: row, chart: chart.chart() });
}));

module.exports = router;
