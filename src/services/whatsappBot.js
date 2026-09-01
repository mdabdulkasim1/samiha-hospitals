'use strict';
const { db } = require('../db');
const config = require('../config');
const { generate } = require('../lib/ids');
const scheduling = require('./scheduling');
const whatsapp = require('./whatsapp');

/**
 * WhatsApp conversation engine.
 *
 * A patient books an appointment entirely inside WhatsApp:
 *   MENU → 1 (Book) → department → doctor → date → time → reason → confirm
 * Every inbound message advances a per-number state machine persisted in
 * `whatsapp_sessions`, so the conversation survives restarts and the front
 * desk can see exactly where a patient is stuck.
 */

const MENU = [
  { key: '1', label: 'Book an appointment', state: 'book_department' },
  { key: '2', label: 'My appointments', state: 'list_appointments' },
  { key: '3', label: 'Cancel an appointment', state: 'cancel_pick' },
  { key: '4', label: 'Diagnostic report status', state: 'report_status' },
  { key: '5', label: 'Medicine refill request', state: 'refill_request' },
  { key: '6', label: 'Clinic timings & location', state: 'clinic_info' },
  { key: '7', label: 'Talk to the front desk', state: 'human_handoff' },
];

// ------------------------------------------------------------------- session
function getSession(waNumber) {
  let row = db.prepare('SELECT * FROM whatsapp_sessions WHERE wa_number = ?').get(waNumber);
  if (!row) {
    db.prepare('INSERT INTO whatsapp_sessions (wa_number, state, context, expires_at) VALUES (?, ?, ?, ?)')
      .run(waNumber, 'idle', '{}', expiryStamp());
    row = db.prepare('SELECT * FROM whatsapp_sessions WHERE wa_number = ?').get(waNumber);
  }
  // An idle conversation resets rather than resuming half a booking hours later.
  if (row.expires_at && row.expires_at < new Date().toISOString() && row.state !== 'idle') {
    row = setState(waNumber, 'idle', {});
  }
  return row;
}

function expiryStamp() {
  return new Date(Date.now() + config.whatsapp.sessionTtlMinutes * 60_000).toISOString();
}

function setState(waNumber, state, context) {
  db.prepare(
    `UPDATE whatsapp_sessions
        SET state = ?, context = ?, last_message_at = datetime('now'), expires_at = ?
      WHERE wa_number = ?`
  ).run(state, JSON.stringify(context || {}), expiryStamp(), waNumber);
  return db.prepare('SELECT * FROM whatsapp_sessions WHERE wa_number = ?').get(waNumber);
}

function ctxOf(session) {
  try { return JSON.parse(session.context || '{}'); } catch { return {}; }
}

function findPatient(waNumber) {
  return db.prepare(
    'SELECT * FROM patients WHERE (whatsapp = ? OR phone = ?) AND active = 1 ORDER BY id DESC LIMIT 1'
  ).get(waNumber, waNumber) || null;
}

// -------------------------------------------------------------- message parts
const clinicHeader = () => `*${config.clinic.name}*`;

function menuText(patient) {
  const greeting = patient
    ? `Hello ${patient.first_name}! 👋 (UHID ${patient.uhid})`
    : 'Hello! 👋 Welcome to our appointment desk.';
  return `${clinicHeader()}\n\n${greeting}\n\nHow can we help you today?\n\n` +
    MENU.map((m) => `*${m.key}* — ${m.label}`).join('\n') +
    `\n\nReply with a number, or type *MENU* at any time to come back here.`;
}

function numberedList(items, render) {
  return items.map((it, i) => `*${i + 1}* — ${render(it)}`).join('\n');
}

function pickIndex(text, length) {
  const n = Number(String(text).trim());
  if (!Number.isInteger(n) || n < 1 || n > length) return null;
  return n - 1;
}

// ------------------------------------------------------------------- handlers
function departmentsWithDoctors() {
  return db.prepare(
    `SELECT d.* FROM departments d
      WHERE d.active = 1 AND d.kind = 'specialist'
        AND EXISTS (SELECT 1 FROM users u WHERE u.department_id = d.id AND u.role = 'doctor' AND u.active = 1)
      ORDER BY d.sort_order, d.name`
  ).all();
}

function doctorsIn(departmentId) {
  return db.prepare(
    `SELECT u.id, u.name, dp.qualification, dp.specialization, dp.consult_fee
       FROM users u LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
      WHERE u.role = 'doctor' AND u.active = 1 AND u.department_id = ?
      ORDER BY u.name`
  ).all(departmentId);
}

function startBooking(waNumber, patient) {
  const departments = departmentsWithDoctors();
  if (!departments.length) {
    return { reply: 'No consulting departments are open for online booking right now. Please call the front desk.', state: 'idle', context: {} };
  }
  return {
    reply: `🏥 *Book an appointment*\n\nWhich department do you need?\n\n${numberedList(departments, (d) => d.name)}\n\nReply with a number.`,
    state: 'book_department',
    context: { departments: departments.map((d) => ({ id: d.id, name: d.name })), patientId: patient ? patient.id : null },
  };
}

function bookingSummary(ctx) {
  return `📋 *Please confirm*\n\n` +
    `Patient: ${ctx.patientName}\n` +
    (ctx.age ? `Age/Gender: ${ctx.age} / ${ctx.gender || '—'}\n` : '') +
    `Department: ${ctx.departmentName}\n` +
    `Doctor: ${ctx.doctorName}\n` +
    `When: ${scheduling.humanDate(ctx.date)} at ${scheduling.to12h(ctx.time)}\n` +
    `Reason: ${ctx.reason}\n\n` +
    `Reply *YES* to confirm or *NO* to start over.`;
}

/** Creates the enquiry + appointment pair and returns the confirmation text. */
function commitBooking(waNumber, ctx) {
  const scheduledAt = `${ctx.date} ${ctx.time}:00`;
  if (!scheduling.isSlotFree(ctx.doctorId, scheduledAt)) {
    return {
      reply: '⚠️ That slot was just taken by someone else. Let us start again — reply *BOOK*.',
      state: 'idle', context: {},
    };
  }

  const patient = ctx.patientId ? db.prepare('SELECT * FROM patients WHERE id = ?').get(ctx.patientId) : null;
  const token = scheduling.nextToken(ctx.doctorId, ctx.date);
  const apptNo = generate('appointment');

  const result = db.transaction(() => {
    const enquiryNo = generate('enquiry');
    const enq = db.prepare(
      `INSERT INTO enquiries (ref_no, source, name, phone, patient_id, department_id, doctor_id, subject, notes, status)
       VALUES (?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?, 'converted')`
    ).run(enquiryNo, ctx.patientName, waNumber, ctx.patientId || null, ctx.departmentId, ctx.doctorId,
          'Appointment request via WhatsApp', ctx.reason);

    const appt = db.prepare(
      `INSERT INTO appointments
         (appt_no, patient_id, guest_name, guest_phone, doctor_id, department_id, scheduled_at,
          slot_minutes, token_no, visit_kind, source, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp', 'confirmed', ?)`
    ).run(apptNo, ctx.patientId || null, patient ? null : ctx.patientName, waNumber, ctx.doctorId,
          ctx.departmentId, scheduledAt, ctx.slotMinutes || 15, token,
          patient ? 'follow_up' : 'new', ctx.reason);

    db.prepare('UPDATE enquiries SET appointment_id = ?, closed_at = datetime(\'now\') WHERE id = ?')
      .run(appt.lastInsertRowid, enq.lastInsertRowid);

    return { appointmentId: appt.lastInsertRowid, enquiryId: enq.lastInsertRowid };
  })();

  // Reminder the evening before the appointment.
  const reminderAt = `${ctx.date} 18:00:00`;
  const reminderDate = new Date(`${ctx.date}T${ctx.time}:00`);
  reminderDate.setDate(reminderDate.getDate() - 1);
  whatsapp.notify({
    to: waNumber,
    template: 'appointment_reminder',
    data: { apptNo, doctorName: ctx.doctorName, when: `${scheduling.humanDate(ctx.date)} at ${scheduling.to12h(ctx.time)}` },
    refType: 'appointment',
    refId: result.appointmentId,
    scheduledAt: `${scheduling.dateKey(reminderDate)} 18:00:00`,
  });
  void reminderAt;

  const reply =
    `✅ *Appointment confirmed*\n\n` +
    `Ref: *${apptNo}*\nToken: *${token}*\n` +
    `Patient: ${ctx.patientName}\n` +
    `Doctor: ${ctx.doctorName} (${ctx.departmentName})\n` +
    `When: ${scheduling.humanDate(ctx.date)} at ${scheduling.to12h(ctx.time)}\n\n` +
    (patient ? '' : `You are booked as a *new patient* — please reach 15 minutes early to complete registration.\n\n`) +
    `📍 ${config.clinic.address}\n☎️ ${config.clinic.phone}\n\n` +
    `Reply *CANCEL ${apptNo}* to cancel, or *MENU* for more options.`;

  return { reply, state: 'idle', context: {}, appointmentId: result.appointmentId };
}

function myAppointments(waNumber, patient) {
  const rows = db.prepare(
    `SELECT a.*, u.name AS doctor_name, d.name AS dept_name
       FROM appointments a
       LEFT JOIN users u ON u.id = a.doctor_id
       LEFT JOIN departments d ON d.id = a.department_id
      WHERE (a.guest_phone = ? OR a.patient_id = ?)
        AND a.status IN ('booked','confirmed','checked_in')
        AND datetime(a.scheduled_at) >= datetime('now', '-1 day')
      ORDER BY a.scheduled_at LIMIT 10`
  ).all(waNumber, patient ? patient.id : -1);

  if (!rows.length) {
    return `You have no upcoming appointments.\n\nReply *BOOK* to schedule one, or *MENU* for options.`;
  }
  return `📅 *Your upcoming appointments*\n\n` + rows.map((r) =>
    `*${r.appt_no}* — ${scheduling.humanDateTime(r.scheduled_at)}\n` +
    `${r.doctor_name} · ${r.dept_name || '—'} · Token ${r.token_no || '—'} · _${r.status}_`
  ).join('\n\n') + `\n\nReply *CANCEL <ref>* to cancel one.`;
}

function cancelAppointment(waNumber, apptNo) {
  const appt = db.prepare(
    `SELECT a.*, u.name AS doctor_name FROM appointments a LEFT JOIN users u ON u.id = a.doctor_id
      WHERE UPPER(a.appt_no) = UPPER(?) AND (a.guest_phone = ? OR a.patient_id IN
            (SELECT id FROM patients WHERE whatsapp = ? OR phone = ?))`
  ).get(apptNo, waNumber, waNumber, waNumber);

  if (!appt) return `We could not find appointment *${apptNo}* on this number. Reply *2* to list your appointments.`;
  if (['completed', 'cancelled'].includes(appt.status)) {
    return `Appointment *${appt.appt_no}* is already ${appt.status}.`;
  }
  db.prepare("UPDATE appointments SET status = 'cancelled', cancel_reason = 'Cancelled by patient via WhatsApp' WHERE id = ?")
    .run(appt.id);
  return `❌ Appointment *${appt.appt_no}* (${scheduling.humanDateTime(appt.scheduled_at)}) has been cancelled.\n\nReply *BOOK* to reschedule.`;
}

function confirmAppointment(waNumber, apptNo) {
  const appt = db.prepare(
    `SELECT * FROM appointments WHERE UPPER(appt_no) = UPPER(?) AND (guest_phone = ? OR patient_id IN
       (SELECT id FROM patients WHERE whatsapp = ? OR phone = ?))`
  ).get(apptNo, waNumber, waNumber, waNumber);
  if (!appt) return `We could not find appointment *${apptNo}* on this number.`;
  db.prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ? AND status = 'booked'").run(appt.id);
  return `👍 Thank you — appointment *${appt.appt_no}* is confirmed for ${scheduling.humanDateTime(appt.scheduled_at)}.`;
}

function reportStatus(waNumber, patient) {
  if (!patient) return `We could not match this number to a registered patient. Please contact the front desk on ${config.clinic.phone}.`;
  const rows = db.prepare(
    `SELECT o.order_no, o.status, o.ordered_at, o.reported_at,
            (SELECT GROUP_CONCAT(test_name, ', ') FROM lab_order_items WHERE order_id = o.id) AS tests
       FROM lab_orders o WHERE o.patient_id = ?
      ORDER BY o.id DESC LIMIT 5`
  ).all(patient.id);
  if (!rows.length) return 'No diagnostic orders found for you yet.';
  const label = { ordered: 'awaiting sample', sample_collected: 'sample collected', in_process: 'in process',
    result_entered: 'awaiting verification', verified: 'ready ✅', reported: 'ready ✅', cancelled: 'cancelled' };
  return `🧪 *Your diagnostic orders*\n\n` + rows.map((r) =>
    `*${r.order_no}* — ${label[r.status] || r.status}\n${r.tests || ''}`
  ).join('\n\n') + `\n\nReports can be collected at the diagnostics desk.`;
}

function refillRequest(waNumber, patient, text) {
  const enquiryNo = generate('enquiry');
  db.prepare(
    `INSERT INTO enquiries (ref_no, source, name, phone, patient_id, subject, notes, status)
     VALUES (?, 'whatsapp', ?, ?, ?, 'Medicine refill request', ?, 'new')`
  ).run(enquiryNo, patient ? `${patient.first_name} ${patient.last_name || ''}`.trim() : 'WhatsApp patient',
        waNumber, patient ? patient.id : null, text);
  return `💊 Refill request *${enquiryNo}* logged. Our pharmacist will review your last prescription and message you back.\n\n` +
    `Note: Schedule H medicines need a valid prescription.`;
}

function humanHandoff(waNumber, patient, text) {
  const enquiryNo = generate('enquiry');
  db.prepare(
    `INSERT INTO enquiries (ref_no, source, name, phone, patient_id, subject, notes, status, follow_up_at)
     VALUES (?, 'whatsapp', ?, ?, ?, 'Call-back request', ?, 'new', datetime('now'))`
  ).run(enquiryNo, patient ? `${patient.first_name} ${patient.last_name || ''}`.trim() : 'WhatsApp visitor',
        waNumber, patient ? patient.id : null, text);
  return `🙋 Request *${enquiryNo}* raised. A member of our front-desk team will call you on this number shortly.\n\n` +
    `For emergencies please call ${config.clinic.phone} directly.`;
}

function clinicInfo() {
  return `${clinicHeader()}\n\n📍 ${config.clinic.address}\n☎️ ${config.clinic.phone}\n✉️ ${config.clinic.email}\n\n` +
    `*OPD timings*\nMon–Sat: 9:00 AM – 1:00 PM and 5:00 PM – 8:00 PM\nSunday: 9:00 AM – 12:00 PM\n\n` +
    `*Specialities*\nInternal Medicine · Pediatrics · Gynecology · Cardiology · Dentist · Dermatology · Orthopedics\n\n` +
    `*Diagnostics*: Lab, X-Ray and USG — 7:00 AM – 8:00 PM (fasting samples until 10:00 AM)\n` +
    `*Pharmacy*: 8:00 AM – 9:00 PM\n*Day care & ward*: 24×7\n\nReply *MENU* for options.`;
}

// ---------------------------------------------------------------- main router
/**
 * Handle one inbound message. Returns the reply text (already logged and sent).
 */
function handleIncoming(waNumber, rawText) {
  const text = String(rawText || '').trim();
  const upper = text.toUpperCase();
  const patient = findPatient(waNumber);
  let session = getSession(waNumber);
  let ctx = ctxOf(session);

  whatsapp.logMessage({ waNumber, direction: 'in', body: text, status: 'received' });

  const respond = (reply, state = 'idle', context = {}) => {
    setState(waNumber, state, context);
    whatsapp.send(waNumber, reply).catch((err) => console.error('[bot] send:', err.message));
    return reply;
  };

  // --- global commands, valid from any state ---------------------------------
  if (['MENU', 'HI', 'HELLO', 'HEY', 'START', 'HELP', 'NAMASTE'].includes(upper)) {
    return respond(menuText(patient));
  }
  if (upper === 'BOOK') {
    const r = startBooking(waNumber, patient);
    return respond(r.reply, r.state, r.context);
  }
  if (upper.startsWith('CANCEL')) {
    const ref = text.split(/\s+/)[1];
    if (ref) return respond(cancelAppointment(waNumber, ref));
  }
  if (upper.startsWith('CONFIRM')) {
    const ref = text.split(/\s+/)[1];
    if (ref) return respond(confirmAppointment(waNumber, ref));
  }
  if (upper === 'STOP' || upper === 'UNSUBSCRIBE') {
    return respond('You will no longer receive automated messages from us. Reply *START* to opt back in.');
  }

  // --- state machine ---------------------------------------------------------
  switch (session.state) {
    case 'idle': {
      const choice = MENU.find((m) => m.key === text);
      if (!choice) return respond(menuText(patient));
      switch (choice.state) {
        case 'book_department': {
          const r = startBooking(waNumber, patient);
          return respond(r.reply, r.state, r.context);
        }
        case 'list_appointments': return respond(myAppointments(waNumber, patient));
        case 'cancel_pick':
          return respond(`${myAppointments(waNumber, patient)}\n\nType *CANCEL <ref>* — for example \`CANCEL APT25090001\`.`);
        case 'report_status': return respond(reportStatus(waNumber, patient));
        case 'refill_request':
          return respond('💊 Please type the medicine name(s) and quantity you need.', 'refill_text', {});
        case 'clinic_info': return respond(clinicInfo());
        case 'human_handoff':
          return respond('🙋 Please type your question in one message and we will pass it to the front desk.', 'handoff_text', {});
        default: return respond(menuText(patient));
      }
    }

    case 'refill_text':
      return respond(refillRequest(waNumber, patient, text));

    case 'handoff_text':
      return respond(humanHandoff(waNumber, patient, text));

    case 'book_department': {
      const idx = pickIndex(text, (ctx.departments || []).length);
      if (idx === null) {
        return respond(`Please reply with a number between 1 and ${(ctx.departments || []).length}.`, 'book_department', ctx);
      }
      const dept = ctx.departments[idx];
      const doctors = doctorsIn(dept.id);
      if (!doctors.length) {
        return respond(`No doctors are available in ${dept.name} right now. Reply *BOOK* to pick another department.`);
      }
      ctx = { ...ctx, departmentId: dept.id, departmentName: dept.name,
        doctors: doctors.map((d) => ({ id: d.id, name: d.name, qualification: d.qualification, fee: d.consult_fee })) };
      return respond(
        `👨‍⚕️ *${dept.name}* — choose a doctor:\n\n` +
        numberedList(ctx.doctors, (d) => `${d.name}${d.qualification ? ` (${d.qualification})` : ''} — ${config.clinic.currencySymbol}${d.fee || 0}`) +
        `\n\nReply with a number.`,
        'book_doctor', ctx
      );
    }

    case 'book_doctor': {
      const idx = pickIndex(text, (ctx.doctors || []).length);
      if (idx === null) return respond(`Please reply with a number between 1 and ${(ctx.doctors || []).length}.`, 'book_doctor', ctx);
      const doc = ctx.doctors[idx];
      const dates = scheduling.nextAvailableDates(doc.id, 5);
      if (!dates.length) {
        return respond(`${doc.name} has no open slots in the next 30 days. Reply *BOOK* to choose another doctor.`);
      }
      ctx = { ...ctx, doctorId: doc.id, doctorName: doc.name, dates };
      return respond(
        `📅 *${doc.name}* — pick a day:\n\n` +
        numberedList(dates, (d) => `${d.label} · ${d.slots} slot(s)`) +
        `\n\nReply with a number.`,
        'book_date', ctx
      );
    }

    case 'book_date': {
      const idx = pickIndex(text, (ctx.dates || []).length);
      if (idx === null) return respond(`Please reply with a number between 1 and ${(ctx.dates || []).length}.`, 'book_date', ctx);
      const chosen = ctx.dates[idx];
      const slots = scheduling.availableSlots(ctx.doctorId, chosen.date).slice(0, 12);
      if (!slots.length) return respond('That day just filled up. Reply *BOOK* to start again.');
      ctx = { ...ctx, date: chosen.date, slots };
      return respond(
        `🕒 *${chosen.label}* — pick a time:\n\n` +
        numberedList(slots, (s) => scheduling.to12h(s)) +
        `\n\nReply with a number.`,
        'book_slot', ctx
      );
    }

    case 'book_slot': {
      const idx = pickIndex(text, (ctx.slots || []).length);
      if (idx === null) return respond(`Please reply with a number between 1 and ${(ctx.slots || []).length}.`, 'book_slot', ctx);
      ctx = { ...ctx, time: ctx.slots[idx] };
      if (patient) {
        ctx.patientId = patient.id;
        ctx.patientName = `${patient.first_name} ${patient.last_name || ''}`.trim();
        return respond('📝 What is the reason for your visit? (a short line is enough)', 'book_reason', ctx);
      }
      return respond('🧑 We could not find you in our records. What is the *patient\'s full name*?', 'book_name', ctx);
    }

    case 'book_name': {
      if (text.length < 2) return respond('Please type the patient\'s full name.', 'book_name', ctx);
      ctx = { ...ctx, patientName: text };
      return respond('🎂 Patient age and gender? For example: `34 female`', 'book_age', ctx);
    }

    case 'book_age': {
      const m = text.match(/(\d{1,3})\s*[,/ ]?\s*(male|female|other|m|f)?/i);
      if (!m) return respond('Please reply like `34 female`.', 'book_age', ctx);
      const g = (m[2] || '').toLowerCase();
      ctx = { ...ctx, age: Number(m[1]),
        gender: g.startsWith('m') ? 'male' : g.startsWith('f') ? 'female' : g ? 'other' : null };
      return respond('📝 What is the reason for your visit? (a short line is enough)', 'book_reason', ctx);
    }

    case 'book_reason': {
      ctx = { ...ctx, reason: text || 'General consultation' };
      return respond(bookingSummary(ctx), 'book_confirm', ctx);
    }

    case 'book_confirm': {
      if (['YES', 'Y', 'CONFIRM', 'OK'].includes(upper)) {
        const r = commitBooking(waNumber, ctx);
        return respond(r.reply, r.state, r.context);
      }
      if (['NO', 'N', 'CANCEL'].includes(upper)) {
        return respond('No problem — booking discarded. Reply *BOOK* to start again or *MENU* for options.');
      }
      return respond('Please reply *YES* to confirm or *NO* to discard.', 'book_confirm', ctx);
    }

    default:
      return respond(menuText(patient));
  }
}

module.exports = { handleIncoming, getSession, setState, findPatient, menuText, MENU };
