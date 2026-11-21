'use strict';
/**
 * Test WhatsApp Dynamic Flow for booking an appointment end-to-end.
 * User scenario:
 * 1. User sends "HI"
 * 2. WhatsApp bot replies with interactive services / action buttons (queried live from ERP).
 * 3. User selects "General Consult" (dept_2).
 * 4. WhatsApp bot replies with available doctors for that service from ERP.
 * 5. User selects doctor (Dr. Imran Sheikh, doc_9).
 * 6. WhatsApp bot replies with doctor's visiting hours & interactive open time slots.
 * 7. User selects a time slot (e.g. slot_YYYY-MM-DD_HH:MM).
 * 8. WhatsApp bot asks for reason for visit (and patient details if new).
 * 9. User provides visit reason.
 * 10. WhatsApp bot presents interactive confirmation card with Action Buttons:
 *     [ ✅ Confirm Booking ] [ ❌ Cancel ]
 * 11. User taps "Confirm Booking".
 * 12. WhatsApp bot atomically creates appointment in ERP, generates APT... reference
 *     and queue token number, and confirms booking.
 */
process.env.WHATSAPP_PROVIDER = 'mock';
const config = require('../src/config');
config.whatsapp.provider = 'mock';

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const bot = require('../src/services/whatsappBot');
const whatsapp = require('../src/services/whatsapp');
const scheduling = require('../src/services/scheduling');

test('WhatsApp Dynamic Flow: End-to-end appointment booking', async () => {
  const waNumber = '919555666777';
  db.prepare('DELETE FROM whatsapp_messages WHERE wa_number = ?').run(waNumber);
  db.prepare('DELETE FROM enquiries WHERE phone = ?').run(waNumber);
  db.prepare('DELETE FROM appointments WHERE guest_phone = ?').run(waNumber);
  db.prepare('DELETE FROM patients WHERE phone = ? OR whatsapp = ?').run(waNumber, waNumber);
  bot.setState(waNumber, 'idle', {});

  // 1. User sends "HI"
  const step1 = bot.handleIncoming(waNumber, 'HI');
  assert.match(step1, /SAMIHA POLYCLINIC/i);
  await new Promise((r) => setTimeout(r, 120));
  let msg1 = db.prepare("SELECT * FROM whatsapp_messages WHERE wa_number = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(waNumber);
  assert.strictEqual(msg1.message_type, 'interactive');
  let payload1 = JSON.parse(msg1.payload);
  assert.ok(payload1.action.buttons.some((b) => b.reply.id === 'cmd_book'));

  // 2. User selects "General Consult"
  const step2 = bot.handleIncoming(waNumber, 'General Consult', {
    interactiveId: 'dept_2',
    interactiveTitle: 'General Consult',
  });
  assert.match(step2, /choose the doctor number|Select Doctor/i);
  await new Promise((r) => setTimeout(r, 120));
  let msg2 = db.prepare("SELECT * FROM whatsapp_messages WHERE wa_number = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(waNumber);
  assert.strictEqual(msg2.message_type, 'interactive');
  let payload2 = JSON.parse(msg2.payload);
  assert.strictEqual(payload2.type, 'list');
  const doctorRows = payload2.action.sections[0].rows;
  assert.ok(doctorRows.some((r) => r.id === 'doc_9' && r.title.includes('Imran Sheikh')));

  // 3. User selects doctor (Dr. Imran Sheikh)
  const step3 = bot.handleIncoming(waNumber, 'Dr. Imran Sheikh', {
    interactiveId: 'doc_9',
    interactiveTitle: 'Dr. Imran Sheikh',
  });
  assert.match(step3, /Dr\. Imran Sheikh/);
  await new Promise((r) => setTimeout(r, 120));
  let msg3 = db.prepare("SELECT * FROM whatsapp_messages WHERE wa_number = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(waNumber);
  assert.strictEqual(msg3.message_type, 'interactive');
  let payload3 = JSON.parse(msg3.payload);
  assert.strictEqual(payload3.type, 'list');
  const slotRows = payload3.action.sections[0].rows;
  assert.ok(slotRows.length > 0, 'Doctor should have available visiting slots');

  const chosenSlot = slotRows[0];
  assert.match(chosenSlot.id, /^slot_\d{4}-\d{2}-\d{2}_\d{2}:\d{2}$/);

  // 4. User selects time slot -> bot directly asks for patient's full name (no mobile prompt)
  const step4 = bot.handleIncoming(waNumber, chosenSlot.title, {
    interactiveId: chosenSlot.id,
    interactiveTitle: chosenSlot.title,
  });
  assert.match(step4, /patient's full name/i);

  // 5. User provides patient's name -> bot asks for age and gender
  const step5 = bot.handleIncoming(waNumber, 'Sultan Mehmood');
  assert.match(step5, /age and gender/i);

  // 6. User provides age -> bot directly shows interactive confirmation card
  const step6 = bot.handleIncoming(waNumber, '45 male');
  assert.match(step6, /confirm your appointment/i);

  let session = bot.getSession(waNumber);
  assert.strictEqual(session.state, 'book_confirm');

  // 7. Verify confirmation card with Action Buttons
  await new Promise((r) => setTimeout(r, 120));
  let msgConfirm = db.prepare("SELECT * FROM whatsapp_messages WHERE wa_number = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(waNumber);
  assert.strictEqual(msgConfirm.message_type, 'interactive');
  let payloadConfirm = JSON.parse(msgConfirm.payload);
  assert.strictEqual(payloadConfirm.type, 'button');
  assert.ok(payloadConfirm.action.buttons.some((b) => b.reply.id === 'btn_confirm'));

  // 8. User taps "Confirm Booking"
  const stepFinal = bot.handleIncoming(waNumber, '✅ Confirm Booking', {
    interactiveId: 'btn_confirm',
    interactiveTitle: '✅ Confirm Booking',
  });
  assert.match(stepFinal, /Your appointment is booked/i);
  assert.match(stepFinal, /Reference: \*APT\d+\*/);
  assert.match(stepFinal, /Token: \*\d+\*/);

  // 9. Verify ERP Database persistence
  const appt = db.prepare(
    'SELECT * FROM appointments WHERE (guest_phone = ? OR guest_phone LIKE ?) ORDER BY id DESC LIMIT 1'
  ).get(waNumber, '%9555666777%');

  assert.ok(appt, 'Appointment must exist in MySQL database');
  assert.strictEqual(appt.doctor_id, 9);
  assert.strictEqual(appt.department_id, 2);
  assert.strictEqual(appt.source, 'whatsapp');
  assert.strictEqual(appt.status, 'confirmed');
  assert.ok(appt.token_no >= 1);
  assert.match(appt.appt_no, /^APT\d+$/);

  // 10. Verify enquiry converted
  const enquiry = db.prepare('SELECT * FROM enquiries WHERE appointment_id = ?').get(appt.id);
  assert.ok(enquiry, 'Enquiry record must be created and linked');
  assert.strictEqual(enquiry.status, 'converted');
  assert.strictEqual(enquiry.source, 'whatsapp');
});

test('WhatsApp Flow: Single existing patient selection', async () => {
  const waNumber = '919555666777'; // Now registered as "Sultan Mehmood" from previous test
  bot.setState(waNumber, 'idle', {});

  // 1. Choose slot directly
  const step = bot.handleIncoming(waNumber, 'slot_2026-11-20_10:00');
  assert.match(step, /Who is this appointment for/i);
  assert.match(step, /Sultan Mehmood/i);

  // 2. Select the existing patient (reply "1" or "pat_<id>")
  const stepConfirm = bot.handleIncoming(waNumber, '1');
  assert.match(stepConfirm, /Please confirm your appointment/i);
  assert.match(stepConfirm, /Sultan Mehmood/i);
});

test('WhatsApp Flow: Multiple existing patients and selecting a specific patient or adding new', async () => {
  const multiWa = '919812340001'; // Has "Salma Rehman" and "Salma R"
  db.prepare('UPDATE patients SET active = 1 WHERE phone = ? OR whatsapp = ?').run(multiWa, multiWa);
  bot.setState(multiWa, 'idle', {});

  // 1. Choose slot
  const step = bot.handleIncoming(multiWa, 'slot_2026-11-20_11:00');
  assert.match(step, /Who is this appointment for/i);
  assert.match(step, /Salma/i);

  // 2. Choose option to add new patient instead
  const stepNew = bot.handleIncoming(multiWa, 'NEW');
  assert.match(stepNew, /patient's full name/i);

  // 3. Enter new patient name
  const stepAge = bot.handleIncoming(multiWa, 'Baby Rehman');
  assert.match(stepAge, /age and gender/i);

  // 4. Enter age
  const stepConfirm = bot.handleIncoming(multiWa, '2 years male');
  assert.match(stepConfirm, /Please confirm your appointment/i);
  assert.match(stepConfirm, /Baby Rehman/i);
});

test('WhatsApp Flow: Patient lookup with active=0 or enquiry stage and appointment linking', async () => {
  const testPhone = '918610866200';
  db.prepare('DELETE FROM appointments WHERE guest_phone = ?').run(testPhone);
  db.prepare('DELETE FROM patients WHERE phone = ? OR whatsapp = ?').run(testPhone, testPhone);

  // Insert two patients with active = 0 (simulating MySQL default)
  db.prepare(`
    INSERT INTO patients (active, stage, uhid, first_name, last_name, phone, whatsapp)
    VALUES (0, 'enquiry', 'UHID-TEST-01', 'Sheik', 'Madhar', ?, ?)
  `).run(testPhone, testPhone);

  db.prepare(`
    INSERT INTO patients (active, stage, uhid, first_name, last_name, phone, whatsapp)
    VALUES (0, 'enquiry', 'UHID-TEST-02', 'Sheik', 'Madhar M', ?, ?)
  `).run(testPhone, testPhone);

  const found = bot.findPatients(testPhone);
  assert.strictEqual(found.length, 2, 'Must find both patients even if active=0');
  assert.ok(found.some((p) => p.first_name === 'Sheik' && p.last_name === 'Madhar M'));
  assert.ok(found.some((p) => p.first_name === 'Sheik' && p.last_name === 'Madhar'));

  // Test slot selection triggers patient selection prompt with both names
  bot.setState(testPhone, 'idle', {});
  const step = bot.handleIncoming(testPhone, 'slot_2026-11-20_18:30');
  assert.match(step, /Who is this appointment for/i);
  assert.match(step, /Sheik Madhar/i);
});

test('Timezone: Slot filtering in IST never returns past/expired slots for today', async () => {
  const clinicNow = scheduling.getClinicNow();
  const todayKey = scheduling.dateKey(clinicNow);
  const nowMins = clinicNow.getHours() * 60 + clinicNow.getMinutes();

  const slots = scheduling.availableSlots(9, todayKey);
  for (const slot of slots) {
    const [h, m] = slot.split(':').map(Number);
    const slotMins = h * 60 + m;
    assert.ok(slotMins > nowMins, `Slot ${slot} (${slotMins}m) must be after now (${nowMins}m IST)`);
  }
});

