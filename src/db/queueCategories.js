'use strict';
/*
 * The clinic's queue categories, as it issued them.
 *
 * Each row is: the two-digit code, the name, whether it is a consultation
 * or a service counter, and the department codes that feed it. A token is
 * the code and a daily sequence — 08-001, 08-002 — so these codes end up on
 * paper in a patient's hand and in large type on a waiting-room screen.
 *
 * Three things about this list are deliberate and should not be "corrected"
 * to match the department table:
 *
 *   - ENT (03) and Urology (04) are here although the clinic has no such
 *     department yet. The front desk can issue their tokens the day a
 *     visiting consultant starts.
 *   - General Practice and Internal Medicine both feed 05, because the
 *     clinic's directory lists them as one.
 *   - Oncology has no category. It is absent from the directory the codes
 *     were drawn from, and inventing an unused code is how a list stops
 *     matching the printed one it is supposed to be.
 *
 * Spelling follows the clinic's own sheet — Paediatrics, Orthopaedics,
 * Nebulization — because a staff member looking for a category searches for
 * the word they were given.
 */
const CATEGORIES = [
  // code  name                            kind       departments that feed it
  ['01', 'Neurology', 'consult', ['NEU']],
  ['02', 'Cardiology', 'consult', ['CAR']],
  ['03', 'ENT', 'consult', []],
  ['04', 'Urology', 'consult', []],
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
];

module.exports = { CATEGORIES };
