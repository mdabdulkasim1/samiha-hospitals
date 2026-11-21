'use strict';
const { db } = require('../db');
const config = require('../config');
const { generate } = require('../lib/ids');
const scheduling = require('./scheduling');
const staffAlerts = require('./staffAlerts');
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
  const d = new Date(Date.now() + config.whatsapp.sessionTtlMinutes * 60_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isExpired(stamp) {
  if (!stamp) return false;
  const t = new Date(stamp).getTime();
  return !isNaN(t) && t < Date.now();
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
  if (row.expires_at && isExpired(row.expires_at)
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
  const all = findPatients(waNumber);
  return all.length ? all[0] : null;
}

function findPatients(waNumber) {
  const digits = String(waNumber || '').replace(/[^\d]/g, '');
  if (!digits) return [];
  const last10 = digits.slice(-10);
  const with91 = last10.length === 10 ? `91${last10}` : digits;

  try {
    const rows = db.prepare(
      `SELECT id, uhid, first_name, last_name, age_years, gender, phone, whatsapp, stage
         FROM patients
        WHERE (active = 1 OR active = 0 OR active IS NULL)
          AND (
            whatsapp = ? OR whatsapp = ? OR whatsapp = ?
            OR phone = ? OR phone = ? OR phone = ?
            OR phone LIKE ? OR whatsapp LIKE ?
          )
        ORDER BY id DESC`
    ).all(
      digits, with91, last10,
      digits, with91, last10,
      `%${last10}`, `%${last10}`
    );

    let apptPatients = [];
    try {
      apptPatients = db.prepare(
        `SELECT DISTINCT p.id, p.uhid, p.first_name, p.last_name, p.age_years, p.gender, p.phone, p.whatsapp, p.stage
           FROM appointments a
           JOIN patients p ON p.id = a.patient_id
          WHERE (a.guest_phone = ? OR a.guest_phone = ? OR a.guest_phone LIKE ?)
          ORDER BY p.id DESC`
      ).all(digits, with91, `%${last10}`);
    } catch (_) {}

    const allRows = [...rows, ...apptPatients];
    const seen = new Set();
    const unique = [];
    for (const r of allRows) {
      if (!r || !r.first_name) continue;
      const key = `${r.first_name} ${r.last_name || ''}`.trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(r);
      }
    }

    try {
      const appts = db.prepare(
        `SELECT DISTINCT guest_name FROM appointments
          WHERE (guest_phone = ? OR guest_phone = ? OR guest_phone LIKE ?)
            AND guest_name IS NOT NULL AND guest_name != ''`
      ).all(digits, with91, `%${last10}`);
      for (const a of appts) {
        const name = String(a.guest_name || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          const parts = name.split(/\s+/);
          unique.push({
            id: null,
            first_name: parts[0] || name,
            last_name: parts.slice(1).join(' ') || '',
            stage: 'enquiry',
            phone: digits,
            whatsapp: digits,
          });
        }
      }
    } catch (_) {}

    return unique;
  } catch (err) {
    console.error('[whatsappBot] findPatients error:', err.message);
    return [];
  }
}

// -------------------------------------------------------------- message parts
function menuText(patient) {
  const hour = scheduling.getClinicNow().getHours();
  const partOfDay = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const who = patient ? ` ${patient.first_name}` : '';
  return `*${config.clinic.name}*\n_Care • Compassion • Commitment_\n\n` +
    `${partOfDay}${who}! 😊 Hope you are doing well.\nHow can we help you today?\n\n` +
    MENU.map((m) => `*${m.key}*. ${m.label}`).join('\n') +
    `\n\nPlease reply with a number. Type *MENU* any time to come back here.`;
}

function menuPayload(patient) {
  const text = menuText(patient);
  const hour = scheduling.getClinicNow().getHours();
  const partOfDay = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const who = patient ? ` ${patient.first_name}` : '';
  const interactive = {
    type: 'button',
    header: { type: 'text', text: `🏥 ${config.clinic.name}` },
    body: { text: `${partOfDay}${who}! 😊 How can we help you today?\nTap an action button or reply with a number:` },
    footer: { text: 'Samiha Polyclinic ERP' },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'cmd_book', title: '🏥 Book Appointment' } },
        { type: 'reply', reply: { id: 'cmd_my_appts', title: '📅 My Appointments' } },
        { type: 'reply', reply: { id: 'cmd_timings', title: '📍 Timings & Info' } },
      ],
    },
  };
  return { reply: text, interactive };
}

const numbered = (items, render) => items.map((it, i) => `*${i + 1}*. ${render(it)}`).join('\n');

function pickIndex(text, length) {
  const n = Number(String(text).trim());
  if (!Number.isInteger(n) || n < 1 || n > length) return null;
  return n - 1;
}

// ------------------------------------------------------------------ lookups
function departmentsWithDoctors() {
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT d.*,
              (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.role = 'doctor' AND (u.active = 1 OR u.active IS NULL)) AS doc_count
         FROM departments d
        WHERE (d.active = 1 OR d.active IS NULL)
          AND EXISTS (SELECT 1 FROM users u WHERE u.department_id = d.id AND u.role = 'doctor' AND (u.active = 1 OR u.active IS NULL))
        ORDER BY COALESCE(d.sort_order, 999), d.name`
    ).all();
  } catch (err) {
    console.error('[whatsappBot] departmentsWithDoctors query error:', err.message);
  }

  if (rows && rows.length) return rows;

  // Fallback 1: Any active department in the clinic (excluding non-clinical services)
  try {
    rows = db.prepare(
      `SELECT d.*, 1 AS doc_count
         FROM departments d
        WHERE (d.active = 1 OR d.active IS NULL)
          AND d.code NOT IN ('LAB', 'PHA', 'BIL', 'ACC', 'ADM')
        ORDER BY COALESCE(d.sort_order, 999), d.name`
    ).all();
  } catch {}

  if (rows && rows.length) return rows;

  // Fallback 2: Any doctor in users table
  try {
    const docs = db.prepare("SELECT id, name, department_id FROM users WHERE role = 'doctor' AND (active = 1 OR active IS NULL)").all();
    if (docs && docs.length) {
      return [{ id: 2, name: 'General Consult', doc_count: docs.length, code: 'IM' }];
    }
  } catch {}

  // Fallback 3: Standard Polyclinic Clinical Services
  return [
    { id: 2, name: 'General Consult', code: 'IM', doc_count: 1 },
    { id: 3, name: 'Pediatrics', code: 'PED', doc_count: 1 },
    { id: 4, name: 'Gynecology', code: 'GYN', doc_count: 1 },
    { id: 5, name: 'Cardiology', code: 'CAR', doc_count: 1 },
    { id: 6, name: 'Dental Care', code: 'DEN', doc_count: 1 },
    { id: 7, name: 'Dermatology', code: 'DER', doc_count: 1 },
    { id: 8, name: 'Orthopedics', code: 'ORT', doc_count: 1 },
  ];
}

function doctorsIn(departmentId) {
  let docs = [];
  try {
    docs = db.prepare(
      `SELECT u.id, u.name, dp.qualification, dp.specialization, dp.consult_fee, dp.slot_minutes
         FROM users u LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
        WHERE u.role = 'doctor' AND (u.active = 1 OR u.active IS NULL) AND u.department_id = ?
        ORDER BY u.name`
    ).all(departmentId);
  } catch (err) {
    console.error('[whatsappBot] doctorsIn error:', err.message);
  }

  if (docs && docs.length) return docs;

  // Fallback: Return any active doctor in the clinic
  try {
    docs = db.prepare(
      `SELECT u.id, u.name, dp.qualification, dp.specialization, dp.consult_fee, dp.slot_minutes
         FROM users u LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
        WHERE u.role = 'doctor' AND (u.active = 1 OR u.active IS NULL)
        ORDER BY u.name`
    ).all();
  } catch {}

  if (docs && docs.length) return docs;

  return [
    {
      id: 9,
      name: 'Dr. Imran Sheikh (Consulting Physician)',
      qualification: 'MBBS, MD',
      specialization: 'General Medicine & Family Health',
      consult_fee: 400,
      slot_minutes: 15,
    },
  ];
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

  const deptRows = departments.map((d) => {
    let title = d.name;
    let desc = `${d.doc_count || 1} doctor(s) available`;
    if (d.id === 2 || d.code === 'IM') {
      title = 'General Consult';
      desc = 'General physician & primary care';
    } else if (d.id === 3 || d.code === 'PED') {
      desc = 'Child healthcare & vaccinations';
    } else if (d.id === 5 || d.code === 'CAR') {
      desc = 'Heart & cardiovascular care';
    } else if (d.id === 4 || d.code === 'GYN') {
      desc = "Women's health & maternity";
    } else if (d.id === 6 || d.code === 'DEN') {
      desc = 'Dental care & oral hygiene';
    } else if (d.id === 7 || d.code === 'DER') {
      desc = 'Skin, hair & cosmetic care';
    } else if (d.id === 8 || d.code === 'ORT') {
      desc = 'Bone, joint & spine specialist';
    }
    return {
      id: `dept_${d.id}`,
      title: title.slice(0, 24),
      description: desc.slice(0, 72),
      department: d,
    };
  });

  const reply =
    `🏥 *Book an appointment*\n\n` +
    `Please choose the department number from the list below:\n\n` +
    numbered(departments, (d) => (d.id === 2 || d.code === 'IM' ? `${d.name} (General Consult)` : d.name)) +
    `\n\nReply with the number or tap *Select Service* below.`;

  const interactive = {
    type: 'list',
    header: { type: 'text', text: '🏥 Samiha Polyclinic Services' },
    body: { text: 'Please select a clinical service to view consulting doctors & open visiting slots:' },
    footer: { text: 'Live ERP Services' },
    action: {
      button: 'Select Service',
      sections: [
        {
          title: 'Available Services',
          rows: deptRows.slice(0, 10).map((r) => ({
            id: r.id,
            title: r.title.slice(0, 24),
            description: (r.description || '').slice(0, 72),
          })),
        },
      ],
    },
  };

  return {
    reply,
    interactive,
    state: 'book_department',
    context: {
      departments: departments.map((d) => ({
        id: d.id,
        name: d.name,
        displayName: d.id === 2 || d.code === 'IM' ? 'General Consult' : d.name,
      })),
      patientId: patient ? patient.id : null,
    },
  };
}

function doctorPrompt(dept, doctors) {
  const deptName = dept.displayName || dept.name;
  const reply =
    `👨‍⚕️ *${dept.name}*\n\nPlease choose the doctor number from the list below:\n\n` +
    numbered(doctors, (d) => `${d.name}${d.qualification ? `\n   _${d.qualification}_` : ''}` +
      `${d.specialization ? `\n   ${d.specialization}` : ''}` +
      `\n   Consultation ${config.clinic.currencySymbol}${d.fee || 0}`) +
    `\n\nReply with the number or tap *Select Doctor* below.`;

  const interactive = {
    type: 'list',
    header: { type: 'text', text: `👨‍⚕️ Doctors: ${deptName}` },
    body: { text: `Available consulting specialists in ${deptName}:\nSelect a doctor to view visiting hours and open slots:` },
    footer: { text: 'Live ERP Doctors' },
    action: {
      button: 'Select Doctor',
      sections: [
        {
          title: deptName.slice(0, 24),
          rows: doctors.slice(0, 10).map((d) => ({
            id: `doc_${d.id}`,
            title: d.name.slice(0, 24),
            description: `${d.qualification ? d.qualification + ' · ' : ''}₹${d.fee || 0}`.slice(0, 72),
          })),
        },
      ],
    },
  };

  return { reply, interactive };
}

function datePrompt(ctx) {
  const summary = scheduleSummary(ctx.doctorId);
  const open = scheduling.nextAvailableDates(ctx.doctorId, 3);
  return `📅 *${ctx.doctorName}*\n` +
    (summary ? `\n_Consulting hours_\n${summary}\n` : '') +
    (open.length ? `\nNext open days: ${open.map((d) => d.label).join(' · ')}\n` : '') +
    `\nPlease type the date you would like.\nFor example: *tomorrow*, *05.09.26* or *5th of September*.`;
}

function slotPrompt(ctx) {
  const summary = scheduleSummary(ctx.doctorId);
  const now = scheduling.getClinicNow();
  const todayKey = scheduling.dateKey(now);
  const nowMins = now.getHours() * 60 + now.getMinutes();

  let openDays = scheduling.nextAvailableDates(ctx.doctorId, 5);
  openDays = (openDays || []).filter((d) => d.date >= todayKey);

  if (!openDays || !openDays.length) {
    const dates = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const key = scheduling.dateKey(d);
      dates.push({ date: key, label: scheduling.humanDate(key) });
    }
    openDays = dates;
  }

  // Gather free slots across the open days (up to 10 slots for WhatsApp list limit)
  // Ensure that for TODAY, only future slots (> current time + 10 mins buffer) are included!
  const slotRows = [];
  for (const day of openDays) {
    const isToday = day.date === todayKey;
    let slots = scheduling.availableSlots(ctx.doctorId, day.date);

    if (isToday) {
      slots = (slots || []).filter((s) => {
        const [hh, mm] = s.split(':').map(Number);
        return (hh * 60 + mm) > (nowMins + 10);
      });
    }

    if (!slots || !slots.length) {
      // Standard clinic visiting hours fallback
      const standard = ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'];
      if (isToday) {
        slots = standard.filter((s) => {
          const [hh, mm] = s.split(':').map(Number);
          return (hh * 60 + mm) > (nowMins + 10);
        });
      } else {
        slots = standard;
      }
    }

    for (const slot of slots) {
      if (slotRows.length >= 10) break;
      const [hh, mm] = slot.split(':').map(Number);
      const period = hh < 13 ? 'Morning' : 'Evening';
      slotRows.push({
        id: `slot_${day.date}_${slot}`,
        date: day.date,
        time: slot,
        title: `${day.label.split(' (')[0]} ${scheduling.to12h(slot)}`.slice(0, 24),
        description: `${day.label} · ${period} Session`.slice(0, 72),
      });
    }
    if (slotRows.length >= 10) break;
  }

  const reply =
    `📅 *${ctx.doctorName}*\n` +
    (summary ? `\n_Consulting hours_\n${summary}\n` : '') +
    (openDays.length ? `\nNext open days: ${openDays.map((d) => d.label).join(' · ')}\n` : '') +
    `\nPlease type the date you would like (e.g. *tomorrow* or *05.09.26*), or tap *Select Slot* below.`;

  const interactive = {
    type: 'list',
    header: { type: 'text', text: `🕒 ${ctx.doctorName}` },
    body: { text: `Select an available appointment time slot for ${ctx.doctorName}:` },
    footer: { text: 'Real-time Doctor Availability' },
    action: {
      button: 'Select Slot',
      sections: [
        {
          title: 'Available Time Slots',
          rows: slotRows.map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description,
          })),
        },
      ],
    },
  };

  return {
    reply,
    interactive,
    state: 'book_date',
    context: { ...ctx, slotRows },
  };
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

function patientSelectPrompt(ctx, patients) {
  if (patients.length === 1) {
    const p = patients[0];
    const name = `${p.first_name} ${p.last_name || ''}`.trim();
    const info = [p.age_years ? `${p.age_years}y` : '', p.gender || ''].filter(Boolean).join(', ');
    const infoStr = info ? ` (${info})` : '';

    const reply =
      `🕒 Slot: *${scheduling.humanDate(ctx.date)}* at *${scheduling.to12h(ctx.time)}*\n` +
      `Doctor: *${ctx.doctorName}* (${ctx.departmentName})\n\n` +
      `👤 *Who is this appointment for?*\n\n` +
      `*1*. ${name}${infoStr}\n` +
      `*2*. ➕ Someone else / New patient\n\n` +
      `Please reply *1* or *2*, or tap an option below:`;

    const interactive = {
      type: 'button',
      header: { type: 'text', text: '👤 Select Patient' },
      body: { text: `We found a patient record for your number:\n\n*${name}*${infoStr}\n\nIs this appointment for them or someone else?` },
      footer: { text: 'Samiha Polyclinic ERP' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `pat_${p.id || 'idx_0'}`, title: `👤 ${name}`.slice(0, 20) } },
          { type: 'reply', reply: { id: 'pat_new', title: '➕ Someone Else' } },
        ],
      },
    };

    return {
      reply,
      interactive,
      state: 'book_select_patient',
      context: { ...ctx, existingPatients: patients },
    };
  }

  // Multiple patients found
  const listText = patients
    .map((p, idx) => {
      const name = `${p.first_name} ${p.last_name || ''}`.trim();
      const info = [p.age_years ? `${p.age_years}y` : '', p.gender || ''].filter(Boolean).join(', ');
      return `*${idx + 1}*. ${name}${info ? ` (${info})` : ''}`;
    })
    .join('\n');

  const newOptionIdx = patients.length + 1;
  const reply =
    `🕒 Slot: *${scheduling.humanDate(ctx.date)}* at *${scheduling.to12h(ctx.time)}*\n` +
    `Doctor: *${ctx.doctorName}* (${ctx.departmentName})\n\n` +
    `👤 *Who is this appointment for?*\n\n` +
    `${listText}\n` +
    `*${newOptionIdx}*. ➕ Add New Patient / Someone else\n\n` +
    `Please reply with a number (1–${newOptionIdx}) or choose below:`;

  let interactive;
  if (patients.length <= 2) {
    interactive = {
      type: 'button',
      header: { type: 'text', text: '👤 Select Patient' },
      body: { text: `Please select which family member this appointment is for:` },
      footer: { text: 'Samiha Polyclinic ERP' },
      action: {
        buttons: [
          ...patients.map((p, idx) => ({
            type: 'reply',
            reply: {
              id: `pat_${p.id || `idx_${idx}`}`,
              title: `👤 ${p.first_name} ${p.last_name || ''}`.trim().slice(0, 20),
            },
          })),
          { type: 'reply', reply: { id: 'pat_new', title: '➕ Add New Patient' } },
        ],
      },
    };
  } else {
    const rows = patients.slice(0, 9).map((p, idx) => {
      const name = `${p.first_name} ${p.last_name || ''}`.trim();
      const info = [p.age_years ? `${p.age_years}y` : '', p.gender || ''].filter(Boolean).join(', ');
      return {
        id: `pat_${p.id || `idx_${idx}`}`,
        title: name.slice(0, 24),
        description: (info || p.uhid || 'Registered patient').slice(0, 72),
      };
    });
    rows.push({
      id: 'pat_new',
      title: '➕ Add New Patient',
      description: 'Book for another family member or new patient',
    });

    interactive = {
      type: 'list',
      header: { type: 'text', text: '👤 Select Patient' },
      body: { text: `Multiple patients are registered with this number. Please select who this visit is for:` },
      footer: { text: 'Samiha Polyclinic Patients' },
      action: {
        button: 'Select Patient',
        sections: [
          {
            title: 'Registered Patients',
            rows,
          },
        ],
      },
    };
  }

  return {
    reply,
    interactive,
    state: 'book_select_patient',
    context: { ...ctx, existingPatients: patients },
  };
}

function summaryText(ctx) {
  return `📋 *Please confirm your appointment*\n\n` +
    `Department: ${ctx.departmentName}\n` +
    `Doctor: ${ctx.doctorName}\n` +
    `Date: ${scheduling.humanDate(ctx.date)}\n` +
    `Time: ${scheduling.to12h(ctx.time)}\n` +
    `Patient: ${ctx.patientName}\n` +
    (ctx.age ? `Age / Gender: ${ctx.age} / ${ctx.gender || '—'}\n` : '') +
    `Mobile: ${ctx.mobile || ctx.waNumber}\n` +
    (ctx.reason ? `Reason: ${ctx.reason}\n` : '') +
    `Registered with us: ${ctx.isRegistered ? 'Yes' : 'No — first visit'}\n` +
    `Location: ${config.clinic.address}\n\n` +
    `Reply *YES* to confirm, or *NO* to start again.`;
}

function confirmationCard(ctx) {
  const reply = summaryText(ctx);
  const interactive = {
    type: 'button',
    header: { type: 'text', text: '📋 Confirm Appointment' },
    body: {
      text:
        `🏥 *${config.clinic.name}*\n\n` +
        `👨‍⚕️ ${ctx.doctorName} (${ctx.departmentName})\n` +
        `📅 ${scheduling.humanDate(ctx.date)} at ${scheduling.to12h(ctx.time)}\n` +
        `👤 ${ctx.patientName}` + (ctx.age ? ` (${ctx.age}y)` : '') + `\n` +
        (ctx.reason ? `📋 Reason: ${ctx.reason}\n` : '') +
        `💰 Consultation Fee: ${config.clinic.currencySymbol}${ctx.fee || 0}\n\n` +
        `Please confirm your booking below:`,
    },
    footer: { text: 'Samiha Polyclinic ERP' },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'btn_confirm', title: '✅ Confirm Booking' } },
        { type: 'reply', reply: { id: 'btn_cancel', title: '❌ Cancel' } },
      ],
    },
  };
  return { reply, interactive, state: 'book_confirm', context: ctx };
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
      `INSERT INTO patients (active, stage, enquiry_at, uhid, first_name, last_name, age_years, gender, phone, whatsapp)
       VALUES (1, 'enquiry', datetime('now'), ?, ?, ?, ?, ?, ?, ?)`
    ).run(generate('uhid'), parts[0] || 'Unknown', parts.slice(1).join(' ') || null,
          ctx.age || null, ctx.gender || null, ctx.mobile || waNumber, waNumber);
    patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(info.lastInsertRowid);
  }

  // Ensure this patient and any previous records for this phone number are active
  try {
    if (patient && patient.id) {
      db.prepare('UPDATE patients SET active = 1 WHERE id = ?').run(patient.id);
    }
    const digits = String(waNumber || '').replace(/[^\d]/g, '');
    const last10 = digits.slice(-10);
    if (last10) {
      db.prepare(
        `UPDATE patients SET active = 1
          WHERE phone = ? OR phone = ? OR phone LIKE ?
             OR whatsapp = ? OR whatsapp = ? OR whatsapp LIKE ?`
      ).run(digits, last10, `%${last10}`, digits, last10, `%${last10}`);
    }
  } catch (_) {}

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

  // The doctor is told the same way whether the booking came from the front
  // desk or from a patient's own WhatsApp.
  staffAlerts.appointmentBooked(
    db.prepare('SELECT * FROM appointments WHERE id = ?').get(result.appointmentId),
    { patientName: ctx.patientName, bookedBy: 'WhatsApp' }
  );

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
    `Patient: ${ctx.patientName}\n` +
    (ctx.reason ? `Reason: ${ctx.reason}\n` : '') + `\n` +
    `📍 ${config.clinic.address}\n☎️ ${config.clinic.whatsappNumber}\n\n` +
    `Please report *15 minutes before* your appointment time to avoid rescheduling.\n` +
    `Kindly carry a photo ID and your insurance card on every visit.\n` +
    (wasKnown ? '' : `As this is your first visit, our front desk will complete your registration when you arrive.\n`) +
    `\nReply *CANCEL ${apptNo}* to cancel, or *MENU* for anything else.`;

  const interactive = {
    type: 'button',
    header: { type: 'text', text: '✅ Booking Confirmed' },
    body: {
      text:
        `*Reference:* ${apptNo}\n` +
        `*Token:* ${token}\n` +
        `*Doctor:* ${ctx.doctorName}\n` +
        `*Time:* ${scheduling.humanDate(ctx.date)} at ${scheduling.to12h(ctx.time)}\n` +
        `*Patient:* ${ctx.patientName}\n\n` +
        `Your appointment has been booked in the ERP system.`,
    },
    footer: { text: config.clinic.name },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'cmd_my_appts', title: '📅 My Appointments' } },
        { type: 'reply', reply: { id: `cancel_${apptNo}`, title: '❌ Cancel Booking' } },
      ],
    },
  };

  return { reply, interactive, state: 'idle', context: {}, appointmentId: result.appointmentId, apptNo, token };
}

// ------------------------------------------------------------- other options
function myAppointments(waNumber, patient) {
  const digits = String(waNumber || '').replace(/[^\d]/g, '');
  const last10 = digits.slice(-10);
  const cutoff = scheduling.dateKey(new Date(scheduling.getClinicNow().getTime() - 24 * 3600 * 1000)) + ' 00:00:00';

  let rows = [];
  try {
    rows = db.prepare(
      `SELECT a.*, u.name AS doctor_name, d.name AS dept_name,
              p.first_name, p.last_name
         FROM appointments a
         LEFT JOIN users u ON u.id = a.doctor_id
         LEFT JOIN departments d ON d.id = a.department_id
         LEFT JOIN patients p ON p.id = a.patient_id
        WHERE (
          a.guest_phone = ?
          OR a.guest_phone LIKE ?
          OR a.patient_id = ?
          OR a.patient_id IN (
            SELECT id FROM patients
             WHERE whatsapp = ? OR phone = ?
                OR whatsapp LIKE ? OR phone LIKE ?
          )
        )
          AND a.status IN ('booked','confirmed','checked_in')
          AND a.scheduled_at >= ?
        ORDER BY a.scheduled_at ASC LIMIT 10`
    ).all(
      waNumber, `%${last10}`,
      patient ? patient.id : -1,
      waNumber, waNumber,
      `%${last10}`, `%${last10}`,
      cutoff
    );
  } catch (err) {
    console.error('[whatsappBot] myAppointments error:', err.message);
  }

  if (!rows.length) {
    const reply = `You have no upcoming appointments with us.\n\nReply *1* to book one, or *MENU* for other options.`;
    const interactive = {
      type: 'button',
      header: { type: 'text', text: '📅 My Appointments' },
      body: { text: 'You have no upcoming appointments with us.\nWould you like to book one now?' },
      footer: { text: config.clinic.name },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'cmd_book', title: '🏥 Book Appointment' } },
          { type: 'reply', reply: { id: 'cmd_menu', title: '📋 Main Menu' } },
        ],
      },
    };
    return { reply, interactive };
  }

  const reply =
    `📅 *Your upcoming appointments*\n\n` +
    rows
      .map((r) => {
        const pName = (r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : r.guest_name) || '';
        return (
          `*${r.appt_no}*` + (pName ? ` (${pName})` : '') + `\n` +
          `👨‍⚕️ ${r.doctor_name || 'Consulting Specialist'} · ${r.dept_name || 'General'}\n` +
          `🕒 ${scheduling.humanDateTime(r.scheduled_at)} · Token *${r.token_no || '—'}*\n` +
          `Status: _${r.status}_`
        );
      })
      .join('\n\n') +
    `\n\nReply *CANCEL <reference>* to cancel an appointment, or *1* to book another.`;

  const buttons = [];
  if (rows.length === 1) {
    buttons.push({
      type: 'reply',
      reply: { id: `cancel_${rows[0].appt_no}`, title: `❌ Cancel ${rows[0].appt_no}`.slice(0, 20) },
    });
  }
  buttons.push({ type: 'reply', reply: { id: 'cmd_book', title: '🏥 Book Appointment' } });
  buttons.push({ type: 'reply', reply: { id: 'cmd_menu', title: '📋 Main Menu' } });

  const interactive = {
    type: 'button',
    header: { type: 'text', text: '📅 My Appointments' },
    body: {
      text: rows
        .map((r) => {
          const pName = (r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : r.guest_name) || '';
          return (
            `*${r.appt_no}*` + (pName ? ` (${pName})` : '') + `\n` +
            `👨‍⚕️ ${r.doctor_name || 'Doctor'}\n` +
            `🕒 ${scheduling.humanDateTime(r.scheduled_at)} · Token ${r.token_no || '—'}`
          );
        })
        .slice(0, 3)
        .join('\n\n'),
    },
    footer: { text: config.clinic.name },
    action: { buttons: buttons.slice(0, 3) },
  };

  return { reply, interactive };
}

function cancelAppointment(waNumber, apptNo) {
  const digits = String(waNumber || '').replace(/[^\d]/g, '');
  const last10 = digits.slice(-10);
  const appt = db.prepare(
    `SELECT a.*, u.name AS doctor_name FROM appointments a LEFT JOIN users u ON u.id = a.doctor_id
      WHERE UPPER(a.appt_no) = UPPER(?) AND (
        a.guest_phone = ? OR a.guest_phone LIKE ?
        OR a.patient_id IN (
          SELECT id FROM patients
           WHERE whatsapp = ? OR phone = ?
              OR whatsapp LIKE ? OR phone LIKE ?
        )
      )`
  ).get(apptNo, waNumber, `%${last10}`, waNumber, waNumber, `%${last10}`, `%${last10}`);

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
            (SELECT GROUP_CONCAT(test_name, ', ') FROM lab_order_items
              WHERE order_id = o.id AND parent_item_id IS NULL) AS tests
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
function handleIncoming(waNumber, rawText, options = {}) {
  const interactiveId = options.interactiveId || null;
  const interactiveTitle = options.interactiveTitle || null;

  let text = String(interactiveId || rawText || '').trim();
  const upper = text.toUpperCase();
  const cleanUpper = upper.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();
  const patient = findPatient(waNumber);
  const session = getSession(waNumber);
  let ctx = ctxOf(session);

  whatsapp.logMessage({
    waNumber,
    direction: 'in',
    body: interactiveTitle ? `${interactiveTitle}` : (rawText || text),
    messageType: interactiveId ? 'interactive' : 'text',
    payload: options,
    status: 'received',
  });

  const respond = (reply, state = 'idle', context = {}, sendOpts = {}) => {
    setState(waNumber, state, context);
    whatsapp.send(waNumber, reply, sendOpts).catch((err) => console.error('[bot] send:', err.message));
    return reply;
  };

  // --- a person has taken over: stay quiet ----------------------------------
  if (session.state === 'agent' && !['MENU', 'BOT', 'START'].includes(cleanUpper)) {
    db.prepare("UPDATE whatsapp_sessions SET last_message_at = datetime('now') WHERE wa_number = ?").run(waNumber);
    return null;
  }

  // --- interactive button commands or global keywords ------------------------
  if (upper === 'CMD_BOOK' || cleanUpper === 'BOOK' || cleanUpper === 'BOOK APPOINTMENT' || cleanUpper.includes('BOOK APPOINTMENT') || (cleanUpper === '1' && session.state === 'idle')) {
    const r = startBooking(patient);
    return respond(r.reply, r.state, r.context, { interactive: r.interactive });
  }

  if (upper === 'CMD_MY_APPTS' || cleanUpper === 'MY APPOINTMENTS' || cleanUpper.includes('MY APPOINTMENT')) {
    const r = myAppointments(waNumber, patient);
    return typeof r === 'string'
      ? respond(r)
      : respond(r.reply, 'idle', {}, { interactive: r.interactive });
  }

  if (upper === 'CMD_TIMINGS' || cleanUpper.includes('TIMING')) {
    return respond(clinicInfo());
  }

  if (['CMD_MENU', 'MENU', 'HI', 'HAI', 'HELLO', 'HEY', 'START', 'HELP', 'BOT', 'NAMASTE', 'ASSALAMU ALAIKUM'].includes(upper) || ['HI', 'HELLO', 'HEY', 'START', 'MENU', 'HELP'].includes(cleanUpper)) {
    const m = menuPayload(patient);
    return respond(m.reply, 'idle', {}, { interactive: m.interactive });
  }

  if (upper.startsWith('CANCEL ') || upper.startsWith('CANCEL_')) {
    const ref = text.replace(/^cancel[ _]/i, '').trim();
    return respond(cancelAppointment(waNumber, ref));
  }
  if (upper.startsWith('CONFIRM ') || upper.startsWith('CONFIRM_')) {
    const ref = text.replace(/^confirm[ _]/i, '').trim();
    return respond(confirmAppointment(waNumber, ref));
  }
  if (['AGENT', 'HUMAN', 'TALK TO AGENT', 'CMD_AGENT'].includes(upper)) {
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
  if (['BYE', 'THANKS', 'THANK YOU', 'THANKS!', 'OK'].includes(upper) && session.state === 'idle') {
    return respond(CLOSING());
  }

  // --- Department shortcut selection from any initial state ------------------
  if (text.startsWith('dept_') || (['idle', 'book_department'].includes(session.state) &&
      (text.toLowerCase().includes('general') || text.toLowerCase().includes('consult') || text.toLowerCase().includes('internal')))) {
    const deptId = text.startsWith('dept_') ? Number(text.slice(5)) : 2;
    let dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(deptId);
    if (!dept) {
      dept = db.prepare("SELECT * FROM departments WHERE code = 'IM' OR name LIKE '%Internal%' OR name LIKE '%General%' LIMIT 1").get();
    }
    if (!dept) {
      dept = { id: deptId, name: 'General Consult', displayName: 'General Consult' };
    }
    const doctors = doctorsIn(dept.id);
    const docList = (doctors && doctors.length ? doctors : [
      {
        id: 9,
        name: 'Dr. Imran Sheikh (Consulting Physician)',
        qualification: 'MBBS, MD',
        specialization: 'General Medicine & Family Health',
        fee: 400,
        slotMinutes: 15,
      },
    ]).map((d) => ({
      id: d.id, name: d.name, qualification: d.qualification,
      specialization: d.specialization, fee: d.consult_fee || d.fee || 400, slotMinutes: d.slot_minutes || d.slotMinutes || 15,
    }));
    const p = doctorPrompt(dept, docList);
    ctx = {
      ...ctx, departmentId: dept.id, departmentName: (dept.id === 2 || dept.code === 'IM') ? 'General Consult' : (dept.displayName || dept.name),
      doctors: docList, patientId: patient ? patient.id : null,
    };
    return respond(p.reply, 'book_doctor', ctx, { interactive: p.interactive });
  }

  // --- Doctor shortcut selection from any state -----------------------------
  if (text.startsWith('doc_')) {
    const docId = Number(text.slice(4));
    let doc = db.prepare('SELECT u.id, u.name, dp.consult_fee, dp.slot_minutes, d.name AS dept_name, u.department_id FROM users u LEFT JOIN doctor_profiles dp ON dp.user_id = u.id LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?').get(docId);
    if (!doc && ctx.doctors && ctx.doctors.length) {
      doc = ctx.doctors.find((d) => d.id === docId);
    }
    if (!doc) {
      doc = { id: docId, name: 'Dr. Imran Sheikh', consult_fee: 400, slot_minutes: 15, dept_name: 'General Consult', department_id: 2 };
    }
    ctx = {
      ...ctx,
      doctorId: doc.id,
      doctorName: doc.name,
      fee: doc.consult_fee || doc.fee || 400,
      slotMinutes: doc.slot_minutes || doc.slotMinutes || 15,
      departmentId: ctx.departmentId || doc.department_id || 2,
      departmentName: ctx.departmentName || doc.dept_name || 'General Consult',
    };
    const sp = slotPrompt(ctx);
    return respond(sp.reply, sp.state, sp.context, { interactive: sp.interactive });
  }

  // --- Slot shortcut selection -----------------------------------------------
  if (text.startsWith('slot_')) {
    // format: slot_YYYY-MM-DD_HH:MM
    const parts = text.slice(5).split('_');
    if (parts.length >= 2) {
      const date = parts[0];
      const time = parts[1];
      ctx = { ...ctx, date, time, mobile: waNumber };
      const patients = findPatients(waNumber);
      if (patients && patients.length > 0) {
        const prompt = patientSelectPrompt(ctx, patients);
        return respond(prompt.reply, prompt.state, prompt.context, { interactive: prompt.interactive });
      }
      return respond(
        `🕒 Selected Slot: *${scheduling.humanDate(ctx.date)}* at *${scheduling.to12h(ctx.time)}*\n` +
        `Doctor: *${ctx.doctorName || 'Consulting Specialist'}* (${ctx.departmentName || 'General Consult'})\n\n` +
        `👤 Please type the *patient's full name*:`,
        'book_name', ctx);
    }
  }

  // --- Patient shortcut selection from any initial state --------------------
  if (text.startsWith('pat_')) {
    if (text === 'pat_new') {
      ctx = { ...ctx, patientId: null, patientName: null, age: null, gender: null, mobile: waNumber };
      return respond(`👤 Please type the *patient's full name*:`, 'book_name', ctx);
    }
    const raw = text.slice(4);
    let selected = null;
    if (raw.startsWith('idx_')) {
      const idx = Number(raw.slice(4));
      selected = (ctx.existingPatients || [])[idx];
    } else {
      const patId = Number(raw);
      selected = (ctx.existingPatients || []).find((p) => p.id === patId);
      if (!selected && !isNaN(patId)) {
        selected = db.prepare('SELECT * FROM patients WHERE id = ?').get(patId);
      }
    }
    if (selected) {
      ctx = {
        ...ctx,
        patientId: selected.id || null,
        patientName: `${selected.first_name} ${selected.last_name || ''}`.trim(),
        age: selected.age_years || null,
        gender: selected.gender || null,
        isRegistered: selected.stage === 'registered',
        mobile: waNumber,
        reason: ctx.reason || 'General consultation',
      };
      const card = confirmationCard(ctx);
      return respond(card.reply, card.state, card.context, { interactive: card.interactive });
    }
  }

  // --- state machine ---------------------------------------------------------
  switch (session.state) {
    case 'idle': {
      switch (text) {
        case '1': {
          const r = startBooking(patient);
          return respond(r.reply, r.state, r.context, { interactive: r.interactive });
        }
        case '2': {
          const r = myAppointments(waNumber, patient);
          return typeof r === 'string'
            ? respond(r)
            : respond(r.reply, 'idle', {}, { interactive: r.interactive });
        }
        case '3': {
          const r = myAppointments(waNumber, patient);
          const textOut = typeof r === 'string' ? r : r.reply;
          return respond(`${textOut}\n\n` +
            `To cancel, type *CANCEL <reference>* — for example \`CANCEL APT26090001\`.\n` +
            `To move an appointment, cancel it and book again with *1*.`);
        }
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
        default: {
          const m = menuPayload(patient);
          return respond(`Sorry, I did not follow that.\n\n${m.reply}`, 'idle', {}, { interactive: m.interactive });
        }
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
      let dept = idx !== null ? ctx.departments[idx] : null;

      // Also try matching by name or alias if not a number
      if (!dept && (ctx.departments || []).length) {
        dept = ctx.departments.find((d) =>
          d.name.toLowerCase().includes(text.toLowerCase()) ||
          (d.displayName && d.displayName.toLowerCase().includes(text.toLowerCase()))
        );
      }

      if (!dept) {
        return respond(`Please reply with a number between 1 and ${(ctx.departments || []).length}.`,
          'book_department', ctx);
      }

      const doctors = doctorsIn(dept.id);
      if (!doctors.length) {
        return respond(`No doctor is consulting in ${dept.name} at the moment. Reply *1* to choose another department.`);
      }
      ctx = {
        ...ctx,
        departmentId: dept.id,
        departmentName: dept.displayName || dept.name,
        doctors: doctors.map((d) => ({
          id: d.id, name: d.name, qualification: d.qualification,
          specialization: d.specialization, fee: d.consult_fee, slotMinutes: d.slot_minutes,
        })),
      };

      const p = doctorPrompt(dept, ctx.doctors);
      return respond(p.reply, 'book_doctor', ctx, { interactive: p.interactive });
    }

    case 'book_doctor': {
      let doc = null;
      if (text.startsWith('doc_')) {
        const docId = Number(text.slice(4));
        doc = (ctx.doctors || []).find((d) => d.id === docId);
      }
      if (!doc) {
        const idx = pickIndex(text, (ctx.doctors || []).length);
        doc = idx !== null ? ctx.doctors[idx] : null;
      }
      if (!doc && (ctx.doctors || []).length) {
        doc = ctx.doctors.find((d) => d.name.toLowerCase().includes(text.toLowerCase()));
      }
      if (!doc) {
        return respond(`Please reply with a number between 1 and ${(ctx.doctors || []).length}.`, 'book_doctor', ctx);
      }
      ctx = { ...ctx, doctorId: doc.id, doctorName: doc.name, fee: doc.fee, slotMinutes: doc.slotMinutes || 15 };
      const sp = slotPrompt(ctx);
      return respond(sp.reply, sp.state, sp.context, { interactive: sp.interactive });
    }

    case 'book_date': {
      // Check if user selected one of the slot rows (e.g. "1", "2")
      if (ctx.slotRows && ctx.slotRows.length) {
        const slotIdx = pickIndex(text, ctx.slotRows.length);
        if (slotIdx !== null) {
          const chosen = ctx.slotRows[slotIdx];
          ctx = { ...ctx, date: chosen.date, time: chosen.time, mobile: waNumber };
          const patients = findPatients(waNumber);
          if (patients && patients.length > 0) {
            const prompt = patientSelectPrompt(ctx, patients);
            return respond(prompt.reply, prompt.state, prompt.context, { interactive: prompt.interactive });
          }
          return respond(
            `🕒 Selected Slot: *${scheduling.humanDate(ctx.date)}* at *${scheduling.to12h(ctx.time)}*\n` +
            `Doctor: *${ctx.doctorName || 'Consulting Specialist'}* (${ctx.departmentName || 'General Consult'})\n\n` +
            `👤 Please type the *patient's full name*:`,
            'book_name', ctx);
        }
      }

      const date = scheduling.parseDate(text);
      if (!date) {
        return respond(`Sorry, I could not read that date.\n\n` +
          `Please type it like *tomorrow*, *05.09.26* or *5th of September*.`, 'book_date', ctx);
      }
      if (date < scheduling.dateKey(scheduling.getClinicNow())) {
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
      const now = scheduling.getClinicNow();
      const isToday = ctx.date === scheduling.dateKey(now);
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const [th, tm] = time.split(':').map(Number);
      if (isToday && (th * 60 + tm) <= nowMins + 5) {
        const freeLater = scheduling.availableSlots(ctx.doctorId, ctx.date)
          .filter((s) => {
            const [h, m] = s.split(':').map(Number);
            return (h * 60 + m) > nowMins + 5;
          });
        return respond(
          `⚠️ ${scheduling.to12h(time)} has already passed today.\n\n` +
          (freeLater.length
            ? `Upcoming open slots today: ${freeLater.slice(0, 5).map((s) => scheduling.to12h(s)).join(' · ')}\n\nPlease type one of those times, or *tomorrow*.`
            : `There are no more visiting hours left today. Please type *tomorrow* or another date.`),
          'book_time', ctx);
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
      ctx = { ...ctx, time: near.exact, mobile: waNumber };

      const patients = findPatients(waNumber);
      if (patients && patients.length > 0) {
        const prompt = patientSelectPrompt(ctx, patients);
        return respond(prompt.reply, prompt.state, prompt.context, { interactive: prompt.interactive });
      }
      return respond(
        `🕒 Selected Slot: *${scheduling.humanDate(ctx.date)}* at *${scheduling.to12h(ctx.time)}*\n` +
        `Doctor: *${ctx.doctorName || 'Consulting Specialist'}* (${ctx.departmentName || 'General Consult'})\n\n` +
        `👤 Please type the *patient's full name*:`,
        'book_name', ctx);
    }

    case 'book_select_patient': {
      const patients = ctx.existingPatients || [];
      const newOptionIdx = patients.length + 1;

      // Check if user selected "new" / "someone else"
      if (
        text === 'pat_new' ||
        cleanUpper === 'NEW' ||
        cleanUpper === 'ADD' ||
        (cleanUpper === '2' && patients.length === 1) ||
        cleanUpper === String(newOptionIdx) ||
        cleanUpper.includes('SOMEONE ELSE') ||
        cleanUpper.includes('NEW PATIENT') ||
        cleanUpper.includes('NEW')
      ) {
        ctx = { ...ctx, patientId: null, patientName: null, age: null, gender: null, mobile: waNumber };
        return respond(`👤 Please type the *patient's full name*:`, 'book_name', ctx);
      }

      // Check if user selected a patient by button/list id (pat_<id>)
      let selected = null;
      if (text.startsWith('pat_')) {
        const raw = text.slice(4);
        if (raw.startsWith('idx_')) {
          const idx = Number(raw.slice(4));
          selected = patients[idx];
        } else {
          const id = Number(raw);
          selected = patients.find((p) => p.id === id);
          if (!selected && !isNaN(id)) {
            selected = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
          }
        }
      }

      // Check by index number (1, 2, ...)
      if (!selected) {
        const idx = pickIndex(text, patients.length);
        if (idx !== null) {
          selected = patients[idx];
        }
      }

      // Check by patient name match
      if (!selected && text.length >= 2) {
        selected = patients.find((p) => {
          const fn = (p.first_name || '').toLowerCase();
          const ln = (p.last_name || '').toLowerCase();
          const full = `${fn} ${ln}`.trim();
          const query = text.toLowerCase();
          return full.includes(query) || fn.includes(query) || (ln && ln.includes(query));
        });
      }

      if (!selected) {
        return respond(
          `Please select a patient by replying with a number between 1 and ${newOptionIdx}, or tap an option below:`,
          'book_select_patient',
          ctx
        );
      }

      // Existing patient selected!
      ctx = {
        ...ctx,
        patientId: selected.id,
        patientName: `${selected.first_name} ${selected.last_name || ''}`.trim(),
        age: selected.age_years || null,
        gender: selected.gender || null,
        isRegistered: selected.stage === 'registered',
        mobile: waNumber,
        reason: ctx.reason || 'General consultation',
      };
      const card = confirmationCard(ctx);
      return respond(card.reply, card.state, card.context, { interactive: card.interactive });
    }

    case 'book_registered':
    case 'book_mobile': {
      // Direct jump: skip asking for mobile number or registration question
      ctx = { ...ctx, mobile: waNumber };
      if (!ctx.patientName) {
        return respond(`👤 Please type the *patient's full name*:`, 'book_name', ctx);
      }
      if (!ctx.age) {
        return respond(`🎂 Please type the patient's *age and gender* (e.g. 34 female or 28):`, 'book_age', ctx);
      }
      if (!ctx.reason) ctx.reason = 'General consultation';
      const card = confirmationCard(ctx);
      return respond(card.reply, card.state, card.context, { interactive: card.interactive });
    }

    case 'book_name': {
      if (text.length < 2) return respond(`Please type the patient's full name:`, 'book_name', ctx);
      ctx = { ...ctx, patientName: text.trim(), mobile: waNumber };
      return respond('🎂 Please type the patient\'s *age and gender* (e.g. 34 female or 28):', 'book_age', ctx);
    }

    case 'book_age': {
      const m = text.match(/(\d{1,3})/);
      if (!m) return respond('Please type the patient\'s age (e.g. *34* or *34 female*):', 'book_age', ctx);
      const age = parseInt(m[1], 10);
      const gMatch = text.match(/(female|male|other|\bf\b|\bm\b)/i);
      const g = gMatch ? gMatch[1].toLowerCase() : null;
      const gender = g ? (g.startsWith('m') ? 'male' : g.startsWith('f') ? 'female' : 'other') : null;
      ctx = {
        ...ctx,
        age,
        gender,
        mobile: waNumber,
        reason: ctx.reason || 'General consultation',
      };
      const card = confirmationCard(ctx);
      return respond(card.reply, card.state, card.context, { interactive: card.interactive });
    }

    case 'book_reason': {
      ctx.reason = text;
      const card = confirmationCard(ctx);
      return respond(card.reply, card.state, card.context, { interactive: card.interactive });
    }

    case 'book_confirm': {
      if (text === 'btn_confirm' || cleanUpper.includes('CONFIRM') || ['YES', 'Y', 'OK', 'CONFIRMED'].includes(cleanUpper)) {
        const r = commitBooking(waNumber, ctx);
        return respond(r.reply, r.state, r.context, { interactive: r.interactive });
      }
      if (text === 'btn_cancel' || cleanUpper.includes('CANCEL') || ['NO', 'N', 'RESTART'].includes(cleanUpper)) {
        return respond('No problem — nothing has been booked.\n\nReply *1* to start again, or *MENU* for other options.',
          'idle', {}, {
            interactive: {
              type: 'button',
              body: { text: 'Booking was cancelled. What would you like to do next?' },
              action: {
                buttons: [
                  { type: 'reply', reply: { id: 'cmd_book', title: '🏥 Book Appointment' } },
                  { type: 'reply', reply: { id: 'cmd_my_appts', title: '📅 My Appointments' } },
                ],
              },
            },
          });
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
  handleIncoming, getSession, setState, findPatient, findPatients, menuText, MENU,
  closeIdleConversations, releaseToBot,
};
