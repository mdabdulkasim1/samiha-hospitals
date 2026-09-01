'use strict';
/**
 * The WhatsApp conversation as patients actually use it — numbered menus,
 * free-text dates and times, agent hand-off — and over-the-counter pharmacy
 * sales to people who are not our patients.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-wa-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
const app = require('../src/server');
const config = require('../src/config');
const scheduling = require('../src/services/scheduling');

let server;
let base;
const tokens = {};
const ids = {};

async function api(method, p, body, as = 'admin') {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tokens[as] ? { Authorization: `Bearer ${tokens[as]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const chat = (from) => async (text) =>
  (await api('POST', '/api/whatsapp/simulate', { from, text }, 'reception')).body;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['pharmacy', 'pharmacy@samiha.local'], ['nurse', 'nurse@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  const drugs = (await api('GET', '/api/pharmacy/drugs?limit=300', undefined, 'pharmacy')).body;
  ids.para = drugs.find((d) => d.code === 'PARA500').id;      // OTC
  ids.ors = drugs.find((d) => d.code === 'ORS').id;           // OTC
  ids.amox = drugs.find((d) => d.code === 'AMOX500').id;      // Schedule H
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the clinic number patients are given is 7200750420', () => {
  assert.match(config.clinic.whatsappNumber, /72007\s?50420/);
});

test('the greeting offers a numbered menu of services', async () => {
  const say = chat('919000100001');
  const hi = await say('Hai');
  assert.match(hi.reply, /SAMIHA POLYCLINIC/);
  assert.match(hi.reply, /How can we help you today/);
  for (const item of ['Book an appointment', 'My appointments', 'Reschedule or cancel',
                      'Diagnostic report status', 'Medicine refill', 'Feedback or complaint',
                      'Timings, location', 'Talk to our team']) {
    assert.ok(hi.reply.includes(item), `menu should offer "${item}"`);
  }
});

test('booking accepts a typed date and time, like a real chat line', async () => {
  const from = '919000100002';
  const say = chat(from);

  await say('Hi');
  const depts = await say('1');
  assert.match(depts.reply, /choose the department number/i);
  assert.match(depts.reply, /\*1\*\. Internal Medicine/);

  const doctors = await say('1');
  assert.match(doctors.reply, /choose the doctor number/i);
  assert.match(doctors.reply, /Dr\. Imran Sheikh/);
  assert.match(doctors.reply, /Consultation ₹500/);

  const datePrompt = await say('1');
  assert.match(datePrompt.reply, /Consulting hours/);
  assert.match(datePrompt.reply, /type the date/i);

  // A date it cannot read is met with an example, not an error.
  const nonsense = await say('sometime next week maybe');
  assert.match(nonsense.reply, /could not read that date/i);

  // Find a day the doctor actually sits.
  const doctors2 = (await api('GET', '/api/masters/staff?role=doctor', undefined, 'reception')).body;
  const imran = doctors2.find((d) => d.email === 'imran@samiha.local');
  const open = scheduling.nextAvailableDates(imran.id, 1)[0];
  const [y, m, d] = open.date.split('-');

  // Typed in the local style: DD.MM.YY
  const timePrompt = await say(`${d}.${m}.${y.slice(2)}`);
  assert.match(timePrompt.reply, /Free times/);
  assert.match(timePrompt.reply, /type the time/i);

  const slots = scheduling.availableSlots(imran.id, open.date);
  const wanted = slots[0];

  // A time it cannot read is also handled gracefully.
  const badTime = await say('whenever');
  assert.match(badTime.reply, /could not read that time/i);

  const registered = await say(wanted);
  assert.match(registered.reply, /already registered with us/i);

  await say('NO');
  const nameAsk = await say('9876543210');
  assert.match(nameAsk.reply, /full name/i);

  await say('Imran Qureshi');
  const summaryPrompt = await say('45 male');
  assert.match(summaryPrompt.reply, /Please confirm your appointment/);
  assert.match(summaryPrompt.reply, /Department: Internal Medicine/);
  assert.match(summaryPrompt.reply, /Doctor: Dr\. Imran Sheikh/);
  assert.match(summaryPrompt.reply, /Registered with us: No/);

  const done = await say('YES');
  assert.match(done.reply, /Your appointment is booked/);
  assert.match(done.reply, /report \*15 minutes before\*/);
  assert.match(done.reply, /carry a photo ID/i);
  assert.match(done.reply, /72007 50420/);
  const apptNo = done.reply.match(/APT\d+/)[0];

  // The booking is real: confirmed, tokenised and attached to a patient file.
  const appts = (await api('GET', '/api/appointments?status=confirmed', undefined, 'reception')).body;
  const booked = appts.rows.find((a) => a.appt_no === apptNo);
  assert.ok(booked, 'the appointment should exist');
  assert.strictEqual(booked.source, 'whatsapp');
  assert.ok(booked.patient_id, 'an enquiry-stage patient file was opened');
  assert.ok(booked.token_no > 0);
});

test('a time already taken is met with the nearest free ones', async () => {
  const doctors = (await api('GET', '/api/masters/staff?role=doctor', undefined, 'reception')).body;
  const sara = doctors.find((d) => d.email === 'sara@samiha.local');
  const open = scheduling.nextAvailableDates(sara.id, 1)[0];
  const slots = scheduling.availableSlots(sara.id, open.date);
  const taken = slots[0];

  // Someone else takes that slot first.
  const first = await api('POST', '/api/appointments', {
    doctorId: sara.id, scheduledAt: `${open.date} ${taken}:00`,
    guestName: 'Early Bird', guestPhone: '9811100000',
  }, 'reception');
  assert.strictEqual(first.status, 201);

  const say = chat('919000100003');
  await say('Hi');
  await say('1');
  const deptIdx = (await api('GET', '/api/masters/departments?kind=specialist', undefined, 'reception'))
    .body.findIndex((x) => x.code === 'PED') + 1;
  await say(String(deptIdx));
  await say('1');
  await say(open.date);
  const clash = await say(taken);
  assert.match(clash.reply, /is not free/i);
  assert.match(clash.reply, /Closest available/);
});

test('a patient can ask for a person, and the bot then stays quiet', async () => {
  const from = '919000100004';
  const say = chat(from);

  await say('Hi');
  const handoff = await say('8');
  assert.match(handoff.reply, /Connecting you to our team/);
  assert.match(handoff.reply, /72007 50420/);

  // While an agent owns the chat the bot does not answer.
  const silent = await say('Is Dr Imran available today?');
  assert.strictEqual(silent.reply, null);
  assert.strictEqual(silent.handledByAgent, true);

  // The message is still captured for the desk to read.
  const conv = (await api('GET', `/api/whatsapp/conversations/${from}`, undefined, 'reception')).body;
  assert.ok(conv.messages.some((m) => m.direction === 'in' && /Dr Imran available/.test(m.body)));
  assert.strictEqual(conv.session.state, 'agent');

  // A call-back enquiry is waiting for the team.
  const enquiries = (await api('GET', '/api/enquiries?status=new', undefined, 'reception')).body;
  assert.ok(enquiries.rows.some((e) => e.phone === from && /speak to the team/i.test(e.subject)));

  // Handing it back lets the bot answer again.
  await api('POST', `/api/whatsapp/conversations/${from}/release`, {}, 'reception');
  const back = await say('Hello');
  assert.match(back.reply, /How can we help you today/);
});

test('feedback and complaints are captured as enquiries', async () => {
  const say = chat('919000100005');
  await say('Hi');
  const kinds = await say('6');
  assert.match(kinds.reply, /Compliment or feedback/);

  await say('2');   // complaint
  const done = await say('Waited two hours at the diagnostics desk on Monday.');
  assert.match(done.reply, /complaint is recorded/i);
  assert.match(done.reply, /patient-relations team/);

  const enquiries = (await api('GET', '/api/enquiries?status=new', undefined, 'reception')).body;
  const complaint = enquiries.rows.find((e) => e.subject === 'Complaint');
  assert.ok(complaint, 'the complaint should be logged');
  assert.match(complaint.notes, /Waited two hours/);
  assert.ok(complaint.follow_up_at, 'a complaint is flagged for follow-up');
});

test('the timings reply lists the real specialities and services', async () => {
  const say = chat('919000100006');
  await say('Hi');
  const info = await say('7');
  assert.match(info.reply, /Internal Medicine/);
  assert.match(info.reply, /Ultrasound \(USG\)/);
  assert.match(info.reply, /72007 50420/);
});

// ============================================================ counter sales
test('a walk-in who is not our patient can buy over the counter', async () => {
  const before = (await api('GET', `/api/pharmacy/drugs?q=Dolo`, undefined, 'pharmacy')).body[0].on_hand;

  const sale = await api('POST', '/api/pharmacy/counter-sale', {
    customerName: 'Ramesh Kumar', customerPhone: '9845012345',
    items: [{ drugId: ids.para, qty: 10 }, { drugId: ids.ors, qty: 2 }],
    paymentMode: 'upi', paymentReference: 'UPI-COUNTER-1',
  }, 'pharmacy');
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.body));
  assert.strictEqual(sale.body.sale.sale_type, 'counter');
  assert.strictEqual(sale.body.sale.patient_id, null, 'no patient record is invented');
  assert.strictEqual(sale.body.sale.customer_name, 'Ramesh Kumar');
  assert.ok(sale.body.sale.net > 0);
  assert.strictEqual(sale.body.balance, 0, 'paid in full by default');
  assert.strictEqual(sale.body.sale.payment_mode, 'upi');
  assert.strictEqual(sale.body.items.length, 2);

  // Stock really moved.
  const after = (await api('GET', `/api/pharmacy/drugs?q=Dolo`, undefined, 'pharmacy')).body[0].on_hand;
  assert.strictEqual(after, before - 10);

  // No clinic invoice was raised for a non-patient.
  const invoices = (await api('GET', '/api/billing/invoices', undefined, 'cashier' in tokens ? 'cashier' : 'admin')).body;
  assert.ok(!invoices.rows.some((i) => i.patient_name && /Ramesh Kumar/.test(i.patient_name)));
});

test('a prescription-only medicine cannot go over the counter unrecorded', async () => {
  const refused = await api('POST', '/api/pharmacy/counter-sale', {
    customerName: 'Walk In', items: [{ drugId: ids.amox, qty: 10 }],
  }, 'pharmacy');
  assert.strictEqual(refused.status, 409);
  assert.match(refused.body.error, /prescription-only/i);
  assert.match(refused.body.error, /prescribing doctor/i);

  // With the outside prescription recorded, it is allowed.
  const allowed = await api('POST', '/api/pharmacy/counter-sale', {
    customerName: 'Walk In', customerPhone: '9845099999',
    rxReference: 'Dr. A. Rahman, City Clinic — 28.08.2026',
    items: [{ drugId: ids.amox, qty: 10 }],
  }, 'pharmacy');
  assert.strictEqual(allowed.status, 201, JSON.stringify(allowed.body));
  assert.match(allowed.body.sale.rx_reference, /Dr\. A\. Rahman/);
  assert.deepStrictEqual(allowed.body.scheduledMedicines, ['Mox 500']);
});

test('counter sales respect stock, part payment and the day total', async () => {
  const short = await api('POST', '/api/pharmacy/counter-sale', {
    customerName: 'Greedy', items: [{ drugId: ids.para, qty: 999999 }],
  }, 'pharmacy');
  assert.strictEqual(short.status, 409);
  assert.match(short.body.error, /Insufficient stock/);

  const stockBefore = (await api('GET', '/api/pharmacy/drugs?q=ORS', undefined, 'pharmacy')).body[0].on_hand;
  const overpaid = await api('POST', '/api/pharmacy/counter-sale', {
    customerName: 'Overpay', items: [{ drugId: ids.ors, qty: 1 }], paidAmount: 99999,
  }, 'pharmacy');
  assert.strictEqual(overpaid.status, 400);
  assert.match(overpaid.body.error, /more than the bill total/);

  // A rejected sale must not quietly consume stock.
  const stockAfter = (await api('GET', '/api/pharmacy/drugs?q=ORS', undefined, 'pharmacy')).body[0].on_hand;
  assert.strictEqual(stockAfter, stockBefore, 'a refused bill rolls the stock back');

  const part = await api('POST', '/api/pharmacy/counter-sale', {
    customerName: 'Part Payer', items: [{ drugId: ids.ors, qty: 2 }],
    paidAmount: 10, paymentMode: 'cash',
  }, 'pharmacy');
  assert.strictEqual(part.status, 201);
  assert.ok(part.body.balance > 0, 'the unpaid remainder is reported');

  // The counter and prescription takings are reported apart.
  const sales = (await api('GET', '/api/pharmacy/sales', undefined, 'pharmacy')).body;
  // Three counter bills actually completed; the refused ones left no trace.
  assert.strictEqual(sales.today.counter.bills, 3);
  assert.ok(sales.today.counter.total > 0);
  assert.ok(sales.rows.every((r) => r.sale_type));

  const onlyCounter = (await api('GET', '/api/pharmacy/sales?type=counter', undefined, 'pharmacy')).body;
  assert.strictEqual(onlyCounter.rows.length, 3);
  assert.ok(onlyCounter.rows.every((r) => r.sale_type === 'counter'));
});

test('only the pharmacy can ring up a counter sale', async () => {
  const denied = await api('POST', '/api/pharmacy/counter-sale', {
    customerName: 'X', items: [{ drugId: ids.para, qty: 1 }],
  }, 'nurse');
  assert.strictEqual(denied.status, 403);
});
