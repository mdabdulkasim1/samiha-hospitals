'use strict';
const { db } = require('../db');

/**
 * The patient's measurements as they stood when a document was written.
 *
 * Deliberately not "the latest". A dose worked out against a 12 kg child must
 * still read against 12 kg when the prescription is reprinted a year later,
 * and a report issued in March must not acquire May's weight the next time
 * somebody prints it. So the reading taken nearest the document's own date is
 * the one it carries — with a day's grace, because the desk often records the
 * weight a few minutes after the paperwork is raised.
 *
 * `when` is any datetime string SQLite understands; omitting it takes the most
 * recent reading, which is what a screen wants.
 */
function asOf(patientId, when = null) {
  const row = when
    ? db.prepare(
      `SELECT height_cm, weight_kg, bmi, bp_systolic, bp_diastolic, recorded_at
         FROM vitals
        WHERE patient_id = ? AND (height_cm IS NOT NULL OR weight_kg IS NOT NULL)
          AND datetime(recorded_at) <= datetime(?, '+1 day')
        ORDER BY datetime(recorded_at) DESC LIMIT 1`
    ).get(patientId, when)
    : db.prepare(
      `SELECT height_cm, weight_kg, bmi, bp_systolic, bp_diastolic, recorded_at
         FROM vitals
        WHERE patient_id = ? AND (height_cm IS NOT NULL OR weight_kg IS NOT NULL)
        ORDER BY datetime(recorded_at) DESC LIMIT 1`
    ).get(patientId);

  if (!row) return null;
  // A BMI recorded at the time is kept; otherwise it is worked out from the
  // height and weight that were, rather than left blank on the paper.
  if (!row.bmi && row.height_cm > 0 && row.weight_kg > 0) {
    const m = row.height_cm / 100;
    row.bmi = Math.round((row.weight_kg / (m * m)) * 10) / 10;
  }
  return row;
}

/**
 * The BMI band, on the Indian cut-offs rather than the WHO ones.
 *
 * South Asians carry more visceral fat and develop diabetes and heart disease
 * at a lower BMI, so the national guidelines put overweight at 23 and obesity
 * at 25 where the WHO puts them at 25 and 30. Using the WHO bands here would
 * tell a patient at 24 that they are in the clear when this is the population
 * those thresholds were lowered for.
 */
function band(bmi) {
  const n = Number(bmi) || 0;
  if (!n) return '';
  if (n < 18.5) return 'underweight';
  if (n < 23) return 'normal';
  if (n < 25) return 'overweight';
  return 'obese';
}

/**
 * What the nurse should escalate before the patient sits back down.
 *
 * These are screening thresholds, not diagnoses: they exist so that a reading
 * which needs a doctor's eyes now does not wait its turn in the queue.
 */
function alerts(v) {
  const out = [];
  const push = (level, text) => out.push({ level, text });

  if (v.bp_systolic >= 180 || v.bp_diastolic >= 110) {
    push('critical', 'Hypertensive crisis range — inform the doctor now.');
  } else if (v.bp_systolic >= 140 || v.bp_diastolic >= 90) {
    push('warn', 'Blood pressure above normal.');
  }
  if (v.bp_systolic && v.bp_systolic < 90) push('critical', 'Hypotension — escalate.');
  if (v.spo2 && v.spo2 < 94) push(v.spo2 < 90 ? 'critical' : 'warn', `SpO₂ ${v.spo2}% — low.`);
  if (v.temp_c && v.temp_c >= 38) push('warn', `Febrile (${v.temp_c} °C).`);
  if (v.temp_c && v.temp_c < 35) push('critical', `Hypothermic (${v.temp_c} °C) — escalate.`);
  if (v.pulse && (v.pulse > 120 || v.pulse < 50)) push('warn', `Pulse ${v.pulse} bpm — outside 60–100.`);
  // Breathing is the earliest thing to go in a deteriorating patient and the
  // most often left uncounted, so it is flagged as firmly as the rest.
  if (v.resp_rate && v.resp_rate > 24) push('critical', `Respiratory rate ${v.resp_rate}/min — high.`);
  else if (v.resp_rate && (v.resp_rate > 20 || v.resp_rate < 12)) {
    push('warn', `Respiratory rate ${v.resp_rate}/min — outside 12–20.`);
  }
  if (v.blood_sugar && v.blood_sugar > 250) push('warn', `Blood sugar ${v.blood_sugar} mg/dL — high.`);
  if (v.blood_sugar && v.blood_sugar < 70) push('critical', `Blood sugar ${v.blood_sugar} mg/dL — low.`);
  if (v.pain_score >= 7) push('warn', `Pain ${v.pain_score}/10 — severe.`);
  if (v.bmi && band(v.bmi) === 'obese') push('info', `BMI ${v.bmi} — obesity range.`);
  return out;
}

module.exports = { asOf, band, alerts };
