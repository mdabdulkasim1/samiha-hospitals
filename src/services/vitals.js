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

module.exports = { asOf };
