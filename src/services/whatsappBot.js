'use strict';
const { db } = require('../db');
const config = require('../config');
const { generate } = require('../lib/ids');
const scheduling = require('./scheduling');
const whatsapp = require('./whatsapp');

/**
 * WhatsApp conversation engine.
 *
 * The shape follows what patients already expect from a hospital line:
 * a numbered main menu, numbered department and doctor lists, then free-text
 * date and time ("25.05.26", "3 pm"), a confirmation summary, and a hand-off
 * to a real person whenever the patient asks or the bot cannot help.
 *
 * Unlike a bot that just takes a request and leaves an agent to sort it out,
 * this one books against live availability: if the time asked for is taken it
 * offers the nearest free slots rather than promising a call back.
 */

const MENU = [
  { key: '1', label: 'Book an appointment' },
  { key: '2', label: 'My appointments' },
  { key: '3', label: 'Reschedule or cancel' },
  { key: '4', label: 'Diagnostic report status' },
  { key: '5', label: 'Medicine refill' },
  { key: '6', label: 'Feedback or complaint' },
  { key: '7', label: 'Timings, location & services' },
  { key: '8', label: 'Talk to our team' },
];

const CLOSING = () =>
  `Thank you for choosing *${config.clinic.name}*.\n\n` +
  `If you need anything else, message or call us on ${config.clinic.whatsappNumber}. ` +
  `Stay well. 🙏`;

// ------------------------------------------------------------------- session
function expiryStamp() {
  return new Date(Date.now() + config.whatsapp.sessionTtlMinutes * 60_000).toISOString();
}

function getSession(waNumber) {
  let row = db.prepare('SELECT * FROM whatsapp_sessions WHERE wa_number = ?').get(waNumber);
  if (!row) {
    db.prepare('INSERT INTO whatsapp_sessions (wa_number, state, context, expires_at) VALUES (?, ?, ?, ?)')
      .run(waNumber, 'idle', '{}', expiryStamp());
    row = db.prepare('SELECT * FROM whatsapp_sessions WHERE wa_number = ?').get(waNumber);
  }
  // A conversation left half-finished resets rather than resuming hours later.
  // An agent hand-off is left alone; a person is dealing with it.
  if (row.expires_at && row.expires_at < new Date().toISOString()
      && !['idle', 'agent'].includes(row.state)) {
    row = setState(waNumber, 'idle', {});
  }
  return row;
}

function setState(waNumber, state, context) {
  db.prepare(
    `UPDATE whatsapp_sessions
        SET state = ?, context = ?, last_message_at = datetime('now'), expires_at = ?
      WHERE wa_number = ?`
  ).run(state, JSON.stringify(context || {}), expiryStamp(), waNumber);
  return db.prepare('SELECT * FROM whatsapp_sessions WHERE wa_number = ?').get(waNumber);
}

const ctxOf = (session) => { try { return JSON.parse(session.context || '{}'); } catch { return {}; } };

function findPatient(waNumber) {
  return db.prepare(
    'SELECT * FROM patients WHERE (whatsapp = ? OR phone = ?) AND active = 1 ORDER BY id DESC LIMIT 1'
  ).get(waNumber, waNumber) || null;
}

// -------------------------------------------------------------- message parts
function menuText(patient) {
  const hour = new Date().getHours();
  const partOfDay = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const who = patient ? ` ${patient.first_name}` : '';
  return `*${config.clinic.name}*\n_Care • Compassion • Commitment_\n\n` +
    `${partOfDay}${who}! 😊 Hope you are doing well.\nHow can we help you today?\n\n` +
    MENU.map((m) => `*${m.key}*. ${m.label}`).join('\n') +
    `\n\nPlease reply with a number. Type *MENU* any time to come back here.`;
}

const numbered = (items, render) => items.map((it, i) => `*${i + 1}*. ${render(it)}`).join('\n');

function pickIndex(text, length) {
  const n = Number(String(text).trim());
  if (!Number.isInteger(n) || n < 1 || n > length) return null;
  return n - 1;
}

// ------------------------------------------------------------------ lookups
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
    `SELECT u.id, u.name, dp.qualification, dp.specialization, dp.consult_fee, dp.slot_minutes
       FROM users u LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
      WHERE u.role = 'doctor' AND u.active = 1 AND u.department_id = ?
      ORDER BY u.name`
  ).all(departmentId);
}

/** A plain-English line describing when a doctor sits, for the date prompt. */
function scheduleSummary(doctorId) {
  const rows = db.prepare(
    'SELECT * FROM doctor_schedules WHERE doctor_id = ? AND active = 1 ORDER BY weekday, start_time'
  ).all(doctorId);
  if (!rows.length) return null;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byWindow = {};
  for (const r of rows) {
    const key = `${scheduling.to12h(r.start_time)} – ${scheduling.to12h(r.end_time)}`;
    (byWindow[key] ||= []).push(names[r.weekday]);
  }
  return Object.entries(byWindow).map(([window, days]) => `${days.join(', ')}: ${window}`).join('\n');
}

// ------------------------------------------------------------- booking steps
function startBooking(patient) {
  const departments = departmentsWithDoctors();
  if (!departments.length) {
    return {
      reply: `Online booking is not open at the moment. Please call us on ${config.clinic.whatsappNumber}.`,
      state: 'idle', context: {},
    };
  }
  return {
    reply: `🏥 *Book an appointment*\n\nPlease choose the department number from the list below:\n\n` +
      numbered(departments, (d) => d.name) +
      `\n\nReply with the number.`,
    state: 'book_department',
    context: {
      departments: departments.map((d) => ({ id: d.id, name: d.name })),
      patientId: patient ? patient.id : null,
    },
  };
}

function datePrompt(ctx) {
  const summary = scheduleSummary(ctx.doctorId);
  const open = scheduling.nextAvailableDates(ctx.doctorId, 3);
  return `📅 *${ctx.doctorName}*\n` +
    (summary ? `\n_Consulting hours_\n${summary}\n` : '') +
    (open.length ? `\nNext open days: ${open.map((d) => d.label).join(' · ')}\n` : '') +
    `\nPlease type the date you would like.\nFor example: *tomorrow*, *05.09.26* or *5th of September*.`;
}

function timePrompt(ctx) {
  const slots = scheduling.availableSlots(ctx.doctorId, ctx.date);
  const shown = slots.slice(0, 14).map((s) => scheduling.to12h(s)).join(' · ');
  return `🕒 *${scheduling.humanDate(ctx.date)}*\n\n` +
    (slots.length
      ? `Free times: ${shown}${slots.length > 14 ? ' …' : ''}\n\n` +
        `Please type the time you would like — for example *15:00* or *3 pm*.`
      : `Sorry, ${ctx.doctorName} has no free slots that day.\nPlease type another date.`);
}

function summaryText(ctx) {
  return `📋 *Please confirm your appointment*\n\n` +
    `Department: ${ctx.departmentName}\n` +
    `Doctor: ${ctx.doctorName}\n` +
    `Date: ${scheduling.humanDate(ctx.date)}\n` +
    `Time: ${scheduling.to12h(ctx.time)}\n` +
    `Patient: ${ctx.patientName}\n` +
    (ctx.age ? `Age / Gender: ${ctx.age} / ${ctx.gender || '—'}\n` : '') +
    `Mobile: ${ctx.mobile}\n` +
    `Registered with us: ${ctx.isRegistered ? 'Yes' : 'No — first visit'}\n` +
    `Location: ${config.clinic.address}\n\n` +
    `Reply *YES* to confirm, or *NO* to start again.`;
}

/** Creates the enquiry, the patient record if needed, and the appointment. */
function commitBooking(waNumber, ctx) {
  const scheduledAt = `${ctx.date} ${ctx.time}:00`;
  if (!scheduling.isSlotFree(ctx.doctorId, scheduledAt)) {
    const near = scheduling.nearestSlots(ctx.doctorId, ctx.date, ctx.time);
    return {
      reply: `⚠️ Sorry, ${scheduling.to12h(ctx.time)} has just been taken.\n\n` +
        (near.alternatives.length
          ? `Still free that day: ${near.alternatives.map((s) => scheduling.to12h(s)).join(' · ')}\n\n` +
            `Please type one of those times.`
          : `There is nothing left that day. Please type another date.`),
      state: near.alternatives.length ? 'book_time' : 'book_date',
      context: ctx,
    };
  }

  let patient = ctx.patientId ? db.prepare('SELECT * FROM patients WHERE id = ?').get(ctx.patientId) : null;
  const wasKnown = Boolean(patient);

  // An unknown caller becomes an enquiry-stage record now, so the front desk
  // has a file to open when they walk in rather than a loose name on a booking.
  if (!patient) {
    const parts = String(ctx.patientName || '').trim().split(/\s+/);
    const info = db.prepare(
      `INSERT INTO patients (stage, enquiry_at, uhid, first_name, last_name, age_years, gender, phone, whatsapp)
       VALUES ('enquiry', datetime('now'), ?, ?, ?, ?, ?, ?, ?)`
    ).run(generate('uhid'), parts[0] || 'Unknown', parts.slice(1).join(' ') || null,
          ctx.age || null, ctx.gender || null, ctx.mobile || waNumber, waNumber);
    patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(info.lastInsertRowid);
  }

  const token = scheduling.nextToken(ctx.doctorId, ctx.date);
  const apptNo = generate('appointment');

  const result = db.transaction(() => {
    const enquiryNo = generate('enquiry');
    const enq = db.prepare(
      `INSERT INTO enquiries (ref_no, source, name, phone, patient_id, department_id, doctor_id, subject, notes, status)
       VALUES (?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?, 'converted')`
    ).run(enquiryNo, ctx.patientName, ctx.mobile || waNumber, patient.id, ctx.departmentId, ctx.doctorId,
          'Appointment booked on WhatsApp', ctx.reason || null);

    const appt = db.prepare(
      `INSERT INTO appointments
         (appt_no, patient_id, guest_name, guest_phone, doctor_id, department_id, scheduled_at,
          slot_minutes, token_no, visit_kind, source, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp', 'confirmed', ?)`
    ).run(apptNo, patient.id, wasKnown ? null : ctx.patientName, ctx.mobile || waNumber, ctx.doctorId,
          ctx.departmentId, scheduledAt, ctx.slotMinutes || 15, token,
          wasKnown ? 'follow_up' : 'new', ctx.reason || null);

    db.prepare("UPDATE enquiries SET appointment_id = ?, closed_at = datetime('now') WHERE id = ?")
      .run(appt.lastInsertRowid, enq.lastInsertRowid);
    return { appointmentId: appt.lastInsertRowid };
  })();

  // Reminder the evening before.
  const reminderDate = new Date(`${ctx.date}T${ctx.time}:00`);
  reminderDate.setDate(reminderDate.getDate() - 1);
  whatsapp.notify({
    to: waNumber,
    template: 'appointment_reminder',
    data: { apptNo, doctorName: ctx.doctorName,
            when: `${scheduling.humanDate(ctx.date)} at ${scheduling.to12h(ctx.time)}` },
    refType: 'appointment',
    refId: result.appointmentId,
    scheduledAt: `${scheduling.dateKey(reminderDate)} 18:00:00`,
  });

  const reply =
    `✅ *Your appointment is booked.*\n\n` +
    `Reference: *${apptNo}*\nToken: *${token}*\n` +
    `Department: ${ctx.departmentName}\n` +
    `Doctor: ${ctx.doctorName}\n` +
    `Date: ${scheduling.humanDate(ctx.date)}\n` +
    `Time: ${scheduling.to12h(ctx.time)}\n` +
    `Patient: ${ctx.patientName}\n\n` +
    `📍 ${config.clinic.address}\n☎️ ${config.clinic.whatsappNumber}\n\n` +
    `Please report *15 minutes before* your appointment time to avoid rescheduling.\n` +
    `Kindly carry a photo ID and your insurance card on every visit.\n` +
    (wasKnown ? '' : `As this is your first visit, our front desk will complete your registration when you arrive.\n`) +
    `\nReply *CANCEL ${apptNo}* to cancel, or *MENU* for anything else.`;

  return { reply, state: 'idle', context: {}, appointmentId: result.appointmentId };
}

// ------------------------------------------------------------- other options
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
    return `You have no upcoming appointments with us.\n\nReply *1* to book one, or *MENU* for other options.`;
  }
  return `📅 *Your upcoming appointments*\n\n` + rows.map((r) =>
    `*${r.appt_no}*\n${r.doctor_name} · ${r.dept_name || '—'}\n` +
    `${scheduling.humanDateTime(r.scheduled_at)} · Token ${r.token_no || '—'}\n_${r.status}_`
  ).join('\n\n') + `\n\nReply *CANCEL <reference>* to cancel one, or *1* to book another.`;
}

function cancelAppointment(waNumber, apptNo) {
  const appt = db.prepare(
    `SELECT a.*, u.name AS doctor_name FROM appointments a LEFT JOIN users u ON u.id = a.doctor_id
      WHERE UPPER(a.appt_no) = UPPER(?) AND (a.guest_phone = ? OR a.patient_id IN
            (SELECT id FROM patients WHERE whatsapp = ? OR phone = ?))`
  ).get(apptNo, waNumber, waNumber, waNumber);

  if (!appt) return `We could not find appointment *${apptNo}* on this number.\nReply *2* to see your appointments.`;
  if (['completed', 'cancelled'].includes(appt.status)) {
    return `Appointment *${appt.appt_no}* is already ${appt.status}.`;
  }
  db.prepare("UPDATE appointments SET status = 'cancelled', cancel_reason = 'Cancelled by patient on WhatsApp' WHERE id = ?")
    .run(appt.id);
  return `❌ Appointment *${appt.appt_no}* on ${scheduling.humanDateTime(appt.scheduled_at)} has been cancelled.\n\n` +
    `Reply *1* if you would like to book another time.`;
}

function confirmAppointment(waNumber, apptNo) {
  const appt = db.prepare(
    `SELECT * FROM appointments WHERE UPPER(appt_no) = UPPER(?) AND (guest_phone = ? OR patient_id IN
       (SELECT id FROM patients WHERE whatsapp = ? OR phone = ?))`
  ).get(apptNo, waNumber, waNumber, waNumber);
  if (!appt) return `We could not find appointment *${apptNo}* on this number.`;
  db.prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ? AND status = 'booked'").run(appt.id);
  return `👍 Thank you — *${appt.appt_no}* is confirmed for ${scheduling.humanDateTime(appt.scheduled_at)}.\n\n` +
    `Please report 15 minutes early and carry a photo ID.`;
}

function reportStatus(patient) {
  if (!patient) {
    return `We could not match this number to a patient record.\n\n` +
      `Please call us on ${config.clinic.whatsappNumber} and we will look it up for you.`;
  }
  const rows = db.prepare(
    `SELECT o.order_no, o.status, o.ordered_at,
            (SELECT GROUP_CONCAT(test_name, ', ') FROM lab_order_items WHERE order_id = o.id) AS tests
       FROM lab_orders o WHERE o.patient_id = ? ORDER BY o.id DESC LIMIT 5`
  ).all(patient.id);
  if (!rows.length) return 'You have no diagnostic orders with us yet.\n\nReply *MENU* for other options.';
  const label = {
    ordered: '🕐 waiting for the sample', sample_collected: '🧪 sample collected',
    in_process: '⚙️ in process', result_entered: '📝 awaiting verification',
    verified: '✅ ready to collect', reported: '✅ ready to collect', cancelled: 'cancelled',
  };
  return `🧪 *Your diagnostic orders*\n\n` + rows.map((r) =>
    `*${r.order_no}* — ${label[r.status] || r.status}\n_${r.tests || ''}_`
  ).join('\n\n') + `\n\nReports can be collected from the diagnostics desk during working hours.`;
}

function logEnquiry({ waNumber, patient, subject, notes, followUp = false }) {
  const enquiryNo = generate('enquiry');
  db.prepare(
    `INSERT INTO enquiries (ref_no, source, name, phone, patient_id, subject, notes, status, follow_up_at)
     VALUES (?, 'whatsapp', ?, ?, ?, ?, ?, 'new', ${followUp ? "datetime('now')" : 'NULL'})`
  ).run(enquiryNo, patient ? `${patient.first_name} ${patient.last_name || ''}`.trim() : 'WhatsApp visitor',
        waNumber, patient ? patient.id : null, subject, notes);
  return enquiryNo;
}

function clinicInfo() {
  const departments = departmentsWithDoctors();
  return `*${config.clinic.name}*\n_Care • Compassion • Commitment_\n\n` +
    `📍 ${config.clinic.address}\n☎️ ${config.clinic.whatsappNumber}\n✉️ ${config.clinic.email}\n\n` +
    `*Specialities*\n${departments.map((d) => `• ${d.name}`).join('\n')}\n\n` +
    `*Diagnostics*\n• Laboratory  • X-Ray  • Ultrasound (USG)\n\n` +
    `*OPD timings*\nMon–Sat: 9:00 AM – 1:00 PM and 5:00 PM – 8:00 PM\nSunday: 9:00 AM – 12:00 PM\n\n` +
    `*Diagnostics*: 7:00 AM – 8:00 PM (fasting samples until 10:00 AM)\n` +
    `*Pharmacy*: 8:00 AM – 9:00 PM\n*Day care & ward*: 24×7\n\nReply *MENU* for other options.`;
}

// ---------------------------------------------------------------- main router
/**
 * Handle one inbound message. Returns the reply text (already logged and sent),
 * or null when a human has taken the conversation over.
 */
function handleIncoming(waNumber, rawText) {
  const text = String(rawText || '').trim();
  const upper = text.toUpperCase();
  const patient = findPatient(waNumber);
  const session = getSession(waNumber);
  let ctx = ctxOf(session);

  whatsapp.logMessage({ waNumber, direction: 'in', body: text, status: 'received' });

  const respond = (reply, state = 'idle', context = {}) => {
    setState(waNumber, state, context);
    whatsapp.send(waNumber, reply).catch((err) => console.error('[bot] send:', err.message));
    return reply;
  };

  // --- a person has taken over: stay quiet ----------------------------------
  if (session.state === 'agent' && !['MENU', 'BOT', 'START'].includes(upper)) {
    db.prepare("UPDATE whatsapp_sessions SET last_message_at = datetime('now') WHERE wa_number = ?").run(waNumber);
    return null;
  }

  // --- global commands, valid from any state --------------------------------
  if (['MENU', 'HI', 'HAI', 'HELLO', 'HEY', 'START', 'HELP', 'BOT', 'NAMASTE', 'ASSALAMU ALAIKUM'].includes(upper)) {
    return respond(menuText(patient));
  }
  if (['BOOK', 'APPOINTMENT', 'BOOK APPOINTMENT'].includes(upper)) {
    const r = startBooking(patient);
    return respond(r.reply, r.state, r.context);
  }
  if (upper.startsWith('CANCEL ')) {
    return respond(cancelAppointment(waNumber, text.split(/\s+/)[1]));
  }
  if (upper.startsWith('CONFIRM ')) {
    return respond(confirmAppointment(waNumber, text.split(/\s+/)[1]));
  }
  if (['AGENT', 'HUMAN', 'TALK TO AGENT'].includes(upper)) {
    const ref = logEnquiry({ waNumber, patient, subject: 'Asked to speak to the team',
      notes: 'Requested a human on WhatsApp', followUp: true });
    return respond(
      `🙋 One moment — I am connecting you to our team (ref *${ref}*).\n\n` +
      `Someone will reply here shortly. For anything urgent, please call ${config.clinic.whatsappNumber}.`,
      'agent', {});
  }
  if (['STOP', 'UNSUBSCRIBE'].includes(upper)) {
    return respond('You will no longer receive automated messages from us. Reply *START* to opt back in.');
  }
  if (['BYE', 'THANKS', 'THANK YOU', 'THANKS!', 'OK'].includes(upper)) {
    return respond(CLOSING());
  }

  // --- state machine ---------------------------------------------------------
  switch (session.state) {
    case 'idle': {
      switch (text) {
        case '1': {
          const r = startBooking(patient);
          return respond(r.reply, r.state, r.context);
        }
        case '2': return respond(myAppointments(waNumber, patient));
        case '3':
          return respond(`${myAppointments(waNumber, patient)}\n\n` +
            `To cancel, type *CANCEL <reference>* — for example \`CANCEL APT26090001\`.\n` +
            `To move an appointment, cancel it and book again with *1*.`);
        case '4': return respond(reportStatus(patient));
        case '5':
          return respond('💊 Please type the medicine names and quantities you need, in one message.',
            'refill_text', {});
        case '6':
          return respond(`🗣️ *Feedback or complaint*\n\nWhich is it?\n\n` +
            `*1*. Compliment or feedback\n*2*. Complaint about a service\n*3*. Suggestion`,
            'feedback_kind', {});
        case '7': return respond(clinicInfo());
        case '8': {
          const ref = logEnquiry({ waNumber, patient, subject: 'Asked to speak to the team',
            notes: 'Requested a human on WhatsApp', followUp: true });
          return respond(
            `🙋 Connecting you to our team (ref *${ref}*).\n\nPlease type your question — someone will reply here.\n` +
            `For anything urgent, call ${config.clinic.whatsappNumber}.`, 'agent', {});
        }
        default:
          return respond(`Sorry, I did not follow that.\n\n${menuText(patient)}`);
      }
    }

    case 'refill_text': {
      const ref = logEnquiry({ waNumber, patient, subject: 'Medicine refill request', notes: text });
      return respond(
        `💊 Refill request *${ref}* logged.\n\nOur pharmacist will check your last prescription and reply here.\n` +
        `Please note: Schedule H medicines need a valid prescription.\n\n${CLOSING()}`);
    }

    case 'feedback_kind': {
      const kinds = { 1: 'Compliment or feedback', 2: 'Complaint', 3: 'Suggestion' };
      const kind = kinds[text.trim()];
      if (!kind) return respond('Please reply *1*, *2* or *3*.', 'feedback_kind', ctx);
      return respond(`Thank you. Please type your ${kind.toLowerCase()} in one message — ` +
        `include the department or doctor if it helps us look into it.`, 'feedback_text', { kind });
    }

    case 'feedback_text': {
      const ref = logEnquiry({ waNumber, patient, subject: ctx.kind || 'Feedback',
        notes: text, followUp: ctx.kind === 'Complaint' });
      return respond(
        `🙏 Thank you — your ${(ctx.kind || 'feedback').toLowerCase()} is recorded as *${ref}*.\n\n` +
        (ctx.kind === 'Complaint'
          ? `Our patient-relations team will look into it and get back to you.\n\n`
          : `We share every message with the team it concerns.\n\n`) + CLOSING());
    }

    // ------------------------------------------------------- booking steps
    case 'book_department': {
      const idx = pickIndex(text, (ctx.departments || []).length);
      if (idx === null) {
        return respond(`Please reply with a number between 1 and ${(ctx.departments || []).length}.`,
          'book_department', ctx);
      }
      const dept = ctx.departments[idx];
      const doctors = doctorsIn(dept.id);
      if (!doctors.length) {
        return respond(`No doctor is consulting in ${dept.name} at the moment. Reply *1* to choose another department.`);
      }
      ctx = { ...ctx, departmentId: dept.id, departmentName: dept.name,
        doctors: doctors.map((d) => ({ id: d.id, name: d.name, qualification: d.qualification,
          specialization: d.specialization, fee: d.consult_fee, slotMinutes: d.slot_minutes })) };
      return respond(
        `👨‍⚕️ *${dept.name}*\n\nPlease choose the doctor number from the list below:\n\n` +
        numbered(ctx.doctors, (d) => `${d.name}${d.qualification ? `\n   _${d.qualification}_` : ''}` +
          `${d.specialization ? `\n   ${d.specialization}` : ''}` +
          `\n   Consultation ${config.clinic.currencySymbol}${d.fee || 0}`) +
        `\n\nReply with the number.`,
        'book_doctor', ctx);
    }

    case 'book_doctor': {
      const idx = pickIndex(text, (ctx.doctors || []).length);
      if (idx === null) {
        return respond(`Please reply with a number between 1 and ${(ctx.doctors || []).length}.`, 'book_doctor', ctx);
      }
      const doc = ctx.doctors[idx];
      ctx = { ...ctx, doctorId: doc.id, doctorName: doc.name, slotMinutes: doc.slotMinutes || 15 };
      if (!scheduling.nextAvailableDates(doc.id, 1).length) {
        return respond(`${doc.name} has no open slots in the next 30 days.\n\n` +
          `Please call ${config.clinic.whatsappNumber} and we will find you a time.`);
      }
      return respond(datePrompt(ctx), 'book_date', ctx);
    }

    case 'book_date': {
      const date = scheduling.parseDate(text);
      if (!date) {
        return respond(`Sorry, I could not read that date.\n\n` +
          `Please type it like *tomorrow*, *05.09.26* or *5th of September*.`, 'book_date', ctx);
      }
      if (date < scheduling.dateKey(new Date())) {
        return respond('That date has already passed. Please type a date from today onwards.', 'book_date', ctx);
      }
      if (scheduling.isOnLeave(ctx.doctorId, date)) {
        const open = scheduling.nextAvailableDates(ctx.doctorId, 3);
        return respond(`${ctx.doctorName} is not available on ${scheduling.humanDate(date)}.\n\n` +
          (open.length ? `Next open days: ${open.map((d) => d.label).join(' · ')}\n\nPlease type another date.`
                       : 'Please type another date.'), 'book_date', ctx);
      }
      const slots = scheduling.availableSlots(ctx.doctorId, date);
      if (!slots.length) {
        const open = scheduling.nextAvailableDates(ctx.doctorId, 3);
        return respond(`Sorry, ${ctx.doctorName} is fully booked on ${scheduling.humanDate(date)}.\n\n` +
          (open.length ? `Next open days: ${open.map((d) => d.label).join(' · ')}\n\nPlease type another date.`
                       : 'Please type another date.'), 'book_date', ctx);
      }
      ctx = { ...ctx, date };
      return respond(timePrompt(ctx), 'book_time', ctx);
    }

    case 'book_time': {
      const time = scheduling.parseTime(text);
      if (!time) {
        return respond(`Sorry, I could not read that time.\n\n` +
          `Please type it like *15:00* or *3 pm*.`, 'book_time', ctx);
      }
      const near = scheduling.nearestSlots(ctx.doctorId, ctx.date, time);
      if (!near.exact) {
        if (!near.alternatives.length) {
          return respond(`There are no free times left on ${scheduling.humanDate(ctx.date)}.\n\nPlease type another date.`,
            'book_date', ctx);
        }
        return respond(
          `${scheduling.to12h(time)} is not free on ${scheduling.humanDate(ctx.date)}.\n\n` +
          `Closest available: ${near.alternatives.map((s) => scheduling.to12h(s)).join(' · ')}\n\n` +
          `Please type one of those times, or another date.`, 'book_time', ctx);
      }
      ctx = { ...ctx, time: near.exact };

      if (patient) {
        ctx.patientId = patient.id;
        ctx.patientName = `${patient.first_name} ${patient.last_name || ''}`.trim();
        ctx.mobile = patient.phone || waNumber;
        ctx.isRegistered = patient.stage === 'registered';
        return respond(summaryText(ctx), 'book_confirm', ctx);
      }
      return respond(`Are you already registered with us?\n\nReply *YES* or *NO*.`, 'book_registered', ctx);
    }

    case 'book_registered': {
      if (!['YES', 'Y', 'NO', 'N'].includes(upper)) {
        return respond('Please reply *YES* or *NO*.', 'book_registered', ctx);
      }
      ctx = { ...ctx, isRegistered: upper.startsWith('Y') };
      return respond(
        ctx.isRegistered
          ? 'Please type your *registered mobile number*.'
          : 'Please type the *mobile number* to reach you on.',
        'book_mobile', ctx);
    }

    case 'book_mobile': {
      const digits = text.replace(/[^\d]/g, '');
      if (digits.length < 10) {
        return respond('Please type a valid mobile number (at least 10 digits).', 'book_mobile', ctx);
      }
      const normalised = digits.length === 10 ? `91${digits}` : digits;
      ctx = { ...ctx, mobile: normalised };

      // A registered patient may be messaging from a different handset.
      const known = db.prepare(
        'SELECT * FROM patients WHERE (phone = ? OR whatsapp = ?) AND active = 1 ORDER BY id DESC LIMIT 1'
      ).get(normalised, normalised);
      if (known) {
        ctx.patientId = known.id;
        ctx.patientName = `${known.first_name} ${known.last_name || ''}`.trim();
        ctx.isRegistered = known.stage === 'registered';
        return respond(summaryText(ctx), 'book_confirm', ctx);
      }
      if (ctx.isRegistered) {
        return respond(
          `We could not find that number in our records — we will register you at the desk.\n\n` +
          `Please type the *patient's full name*.`, 'book_name', ctx);
      }
      return respond(`Please type the *patient's full name*.`, 'book_name', ctx);
    }

    case 'book_name': {
      if (text.length < 2) return respond(`Please type the patient's full name.`, 'book_name', ctx);
      ctx = { ...ctx, patientName: text };
      return respond('🎂 Please type the age and gender — for example `34 female`.', 'book_age', ctx);
    }

    case 'book_age': {
      const m = text.match(/(\d{1,3})\s*[,/ ]?\s*(male|female|other|m|f)?/i);
      if (!m) return respond('Please reply like `34 female`.', 'book_age', ctx);
      const g = (m[2] || '').toLowerCase();
      ctx = { ...ctx, age: Number(m[1]),
        gender: g.startsWith('m') ? 'male' : g.startsWith('f') ? 'female' : g ? 'other' : null };
      return respond(summaryText(ctx), 'book_confirm', ctx);
    }

    case 'book_confirm': {
      if (['YES', 'Y', 'CONFIRM', 'OK', 'CONFIRMED'].includes(upper)) {
        const r = commitBooking(waNumber, ctx);
        return respond(r.reply, r.state, r.context);
      }
      if (['NO', 'N', 'CANCEL', 'RESTART'].includes(upper)) {
        return respond('No problem — nothing has been booked.\n\nReply *1* to start again, or *MENU* for other options.');
      }
      return respond('Please reply *YES* to confirm or *NO* to start again.', 'book_confirm', ctx);
    }

    default:
      return respond(menuText(patient));
  }
}

/**
 * Close conversations nobody has replied to, quoting the clinic number — the
 * same courtesy a staffed chat line extends before it hangs up.
 */
async function closeIdleConversations(minutes = 30) {
  const stale = db.prepare(
    `SELECT * FROM whatsapp_sessions
      WHERE state NOT IN ('idle')
        AND last_message_at < datetime('now', '-' || ? || ' minutes')`
  ).all(minutes);

  for (const s of stale) {
    await whatsapp.send(s.wa_number,
      `As there has been no reply, I will close this chat for now.\n\n` +
      `If you still need help, just message again or call us on ${config.clinic.whatsappNumber}. ` +
      `Thank you for choosing ${config.clinic.name}. 🙏`).catch(() => {});
    setState(s.wa_number, 'idle', {});
  }
  return stale.length;
}

/** Hand a conversation back to the bot after a person has finished with it. */
function releaseToBot(waNumber) {
  setState(waNumber, 'idle', {});
}

module.exports = {
  handleIncoming, getSession, setState, findPatient, menuText, MENU,
  closeIdleConversations, releaseToBot,
};
