'use strict';
const { db } = require('../db');
const config = require('../config');

/**
 * Outbound message templates. Every patient-facing message the ERP sends
 * (WhatsApp by default) is written here so wording stays consistent and
 * translatable in one place.
 */
const templates = {
  appointment_confirmed: (d) =>
    `✅ *Appointment confirmed*\n\n${config.clinic.name}\n\n` +
    `Ref: ${d.apptNo}\nPatient: ${d.patientName}\nDoctor: ${d.doctorName}\n` +
    `When: ${d.when}\nToken: ${d.token || '—'}\n\n` +
    `Please arrive 15 minutes early and carry a photo ID.\n` +
    `Reply *CANCEL ${d.apptNo}* to cancel or *MENU* for other options.`,

  appointment_reminder: (d) =>
    `⏰ *Reminder* — you have an appointment tomorrow.\n\n` +
    `Ref: ${d.apptNo}\nDoctor: ${d.doctorName}\nWhen: ${d.when}\n\n` +
    `Reply *CONFIRM ${d.apptNo}* to confirm or *CANCEL ${d.apptNo}* to cancel.`,

  appointment_cancelled: (d) =>
    `❌ Appointment ${d.apptNo} has been cancelled.\n` +
    `Reply *BOOK* if you would like to reschedule.`,

  checked_in: (d) =>
    `🏥 You are checked in.\n\nVisit: ${d.visitNo}\nToken: ${d.token}\n` +
    `Doctor: ${d.doctorName}\n\nPlease wait in the waiting area — the vitals station will call your token.`,

  lab_ready: (d) =>
    `🧪 Your diagnostic report is ready.\n\nOrder: ${d.orderNo}\nTests: ${d.tests}\n` +
    `Collect it from the diagnostics desk or ask the front desk to email it.`,

  invoice_created: (d) =>
    `🧾 Bill ${d.invoiceNo} for ${config.clinic.currencySymbol}${d.net}\n` +
    `Paid: ${config.clinic.currencySymbol}${d.paid} · Balance: ${config.clinic.currencySymbol}${d.balance}\n\n` +
    `Please settle at the check-out desk before you leave.`,

  payment_receipt: (d) =>
    `✅ Payment received: ${config.clinic.currencySymbol}${d.amount} (${d.mode})\n` +
    `Receipt: ${d.receiptNo}\nBill: ${d.invoiceNo} · Balance: ${config.clinic.currencySymbol}${d.balance}\n\n` +
    `Thank you for choosing ${config.clinic.name}.`,

  payment_plan: (d) =>
    `📄 Payment plan ${d.agreementNo} recorded.\n` +
    `${d.installments} instalment(s) of ${config.clinic.currencySymbol}${d.installmentAmount}, ${d.frequency}, starting ${d.startDate}.\n` +
    `We will remind you before each due date.`,

  pharmacy_ready: (d) =>
    `💊 Your medicines are ready at the pharmacy counter.\nBill: ${d.billNo} · Items: ${d.items}`,

  visit_summary: (d) =>
    `👋 Thank you for visiting ${config.clinic.name}.\n\n` +
    `Visit: ${d.visitNo}\nDoctor: ${d.doctorName}\n` +
    (d.followUp ? `Next review: ${d.followUp}\n` : '') +
    `\nGet well soon. Reply *BOOK* any time to schedule your next appointment.`,

  admission_confirmed: (d) =>
    `🛏️ Admission confirmed.\n\nIP No: ${d.ipNo}\nPatient: ${d.patientName}\n` +
    `Ward/Bed: ${d.ward} / ${d.bed}\nConsultant: ${d.doctorName}\n\n` +
    `Visiting hours: 11:00–12:00 and 17:00–19:00. One attendant pass per patient.`,

  discharge_summary: (d) =>
    `🏠 Discharge completed for IP ${d.ipNo}.\n` +
    `Final diagnosis: ${d.diagnosis || '—'}\n` +
    (d.followUp ? `Review on: ${d.followUp}\n` : '') +
    `\nPlease collect the discharge summary and medicines before leaving.`,

  financial_assistance: (d) =>
    `💚 Financial assistance screening (${d.screeningNo})\n` +
    `Sliding-scale band: ${d.band || 'pending documents'}\n` +
    `Discount: ${d.discountPct}%\n` +
    (d.programs ? `Programs you may qualify for: ${d.programs}\n` : '') +
    `\nOur counselor will walk you through the options at the desk.`,

  // The doctor's own copy — short enough to read on a phone lock screen.
  doctor_new_appointment: (d) =>
    `👨‍⚕️ *New appointment* — ${config.clinic.name}\n\n` +
    `Patient: ${d.patientName}\n` +
    (d.phone ? `Mobile: ${d.phone}\n` : '') +
    `When: ${d.when}\nToken: ${d.token || '—'}\nRef: ${d.apptNo}\n` +
    (d.reason ? `Reason: ${d.reason}\n` : '') +
    `\nYou have *${d.total}* patient(s) booked that day. Open the ERP to see the full list.`,

  generic: (d) => d.body,
};

function render(template, data) {
  const fn = templates[template] || templates.generic;
  return fn(data || {});
}

/** Queue a message. The dispatcher (whatsapp service) drains this table. */
function queue({ channel = 'whatsapp', to, template, data, refType = null, refId = null, scheduledAt = null }) {
  if (!to) return null;
  const body = render(template, data);
  const info = db.prepare(
    `INSERT INTO notifications (channel, to_addr, template, body, ref_type, ref_id, scheduled_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
  ).run(channel, to, template, body, refType, refId, scheduledAt);
  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(info.lastInsertRowid);
}

function pending(limit = 50) {
  return db.prepare(
    `SELECT * FROM notifications
      WHERE status = 'queued' AND scheduled_at <= datetime('now')
      ORDER BY id LIMIT ?`
  ).all(limit);
}

function markSent(id) {
  db.prepare("UPDATE notifications SET status = 'sent', sent_at = datetime('now'), attempts = attempts + 1 WHERE id = ?").run(id);
}

function markFailed(id, error) {
  db.prepare("UPDATE notifications SET status = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?")
    .run(String(error).slice(0, 500), id);
}

module.exports = { templates, render, queue, pending, markSent, markFailed };
