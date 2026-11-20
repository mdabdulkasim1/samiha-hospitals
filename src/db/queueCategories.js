'use strict';
/*
 * The clinic's queue categories, as it issued them.
 *
 * Each row is: the two-digit code, the name, whether it is a consultation
 * or a service counter, and the department codes that feed it. A token is
 * the code and a daily sequence — 08-001, 08-002 — so these codes end up on
 * paper in a patient's hand and in large type on a waiting-room screen.
 *
 * Four things about this list are deliberate and should not be "corrected"
 * to match the department table:
 *
 *   - ENT (03) and Urology (04) were here before the clinic had either
 *     department, so the front desk could issue their tokens the day a
 *     visiting consultant started. Both are departments now and feed their
 *     codes like the rest.
 *   - General Practice and Internal Medicine both feed 05, because the
 *     clinic's directory lists them as one.
 *   - Oncology has no category. It is absent from the directory the codes
 *     were drawn from, and inventing an unused code is how a list stops
 *     matching the printed one it is supposed to be.
 *   - Diabetology (21) and Radiology (22) are past the end of the printed
 *     sheet, because both are departments the clinic has opened since and
 *     both need a queue of their own. Added at the end so that no number
 *     already on a sheet of paper moves.
 *
 * Spelling follows the clinic's own sheet — Paediatrics, Orthopaedics,
 * Nebulization — because a staff member looking for a category searches for
 * the word they were given.
 */
const CATEGORIES = [
  // code  name                            kind       departments that feed it
  ['01', 'Neurology', 'consult', ['NEU']],
  ['02', 'Cardiology', 'consult', ['CAR']],
  ['03', 'ENT', 'consult', ['ENT']],
  ['04', 'Urology', 'consult', ['URO']],
  ['05', 'General / Internal Medicine', 'consult', ['IM', 'GP']],
  ['06', 'General Surgery', 'consult', ['SUR']],
  ['07', 'Obstetrics & Gynaecology', 'consult', ['GYN']],
  ['08', 'Paediatrics', 'consult', ['PED']],
  ['09', 'Orthopaedics', 'consult', ['ORT']],
  ['10', 'Dental Care', 'consult', ['DEN']],
  ['11', 'Dermatology', 'consult', ['DER']],
  ['12', 'Laboratory Services', 'service', ['LAB']],
  ['13', 'ECG', 'service', []],
  ['14', 'Pharmacy', 'service', ['PHA']],
  ['15', 'Injection & Dressing', 'service', []],
  ['16', 'Nebulization', 'service', []],
  ['17', 'Daycare Services / Ward', 'service', ['DAY']],
  ['18', 'Health Check-up Packages', 'service', []],
  ['19', 'X-Ray', 'service', ['XRY']],
  ['20', 'USG (Ultrasound)', 'service', ['USG']],
  /*
   * Diabetology is the one code that was not on the sheet of twenty. It is
   * on the clinic's duty chart, so its patients need a queue of their own
   * rather than being called under General Medicine — and a code that
   * carries on from 20 is the only kind that does not disturb a number
   * already printed. Switch it off on Queue → Set-up if the clinic would
   * rather see those patients under another code.
   */
  ['21', 'Diabetology', 'consult', ['DIA']],
  /*
   * Radiology counts on from there, for the same reason and with the same
   * care: a patient seeing the radiologist is not the same queue as a
   * patient waiting for the X-ray machine, so 19 and 20 stay as they are
   * and the consultation gets its own number.
   */
  ['22', 'Radiology', 'consult', ['RAD']],
];

module.exports = { CATEGORIES };
