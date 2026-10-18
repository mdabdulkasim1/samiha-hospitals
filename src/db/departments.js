'use strict';
/**
 * The clinic's service board, in one place.
 *
 * Two files need this list and they need the same one. seed.js lays it down on
 * an empty install; catalogue.js adds what is missing on every boot, which is
 * how a clinic that has been running for months receives a department opened
 * since it was set up. Keeping the list in both would mean adding a department
 * to one and quietly not to the other.
 *
 * Specialist departments take consultations and appear in the booking menu
 * once they have a doctor. Diagnostic departments are service counters.
 *
 * sort_order is the order they are listed in, and the gaps are deliberate:
 * a department added later slots into place without renumbering the ones the
 * clinic is already used to seeing.
 */
const DEPARTMENTS = [
  // code, name, kind, sort order
  ['GP',  'General Practitioner (GP)', 'specialist', 0],
  ['IM',  'Internal Medicine',  'specialist', 1],
  ['PED', 'Pediatrics',         'specialist', 2],
  ['GYN', 'Gynecology',         'specialist', 3],
  ['CAR', 'Cardiology',         'specialist', 4],
  ['DEN', 'Dentist',            'specialist', 5],
  ['DER', 'Dermatology',        'specialist', 6],
  ['ORT', 'Orthopedics',        'specialist', 7],
  ['ONC', 'Oncology',           'specialist', 8],
  // Service counters rather than consulting rooms.
  ['LAB', 'Diagnostics / Lab',  'diagnostic', 11],
  ['PHA', 'Pharmacy',           'diagnostic', 12],
  ['DAY', 'Day Care / Ward',    'diagnostic', 13],
  ['XRY', 'X-Ray',              'diagnostic', 14],
  ['USG', 'USG (Ultrasound)',   'diagnostic', 15],
];

module.exports = { DEPARTMENTS };
