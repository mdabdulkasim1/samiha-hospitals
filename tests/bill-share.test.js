'use strict';
/**
 * Sending the bill instead of printing it.
 *
 * The clinic's reason for this is paper, but the thing that has to be right
 * is the copy. A bill that went to a patient's phone is a document they may
 * open a year later, show to an insurer, or bring back to the counter — so
 * what the link serves has to be the bill that was sent, byte for byte, and
 * not the bill as the system would draw it today.
 *
 * The rest is about who may send one, what a patient sees when the link has
 * run out, and whether a refusal by WhatsApp is reported or swallowed. A send
 * that fails quietly is the worst outcome here: the patient walks out with
 * neither paper nor file, and nobody knows until they telephone.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-share-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';
process.env.CLINIC_UPI_ID = 'samihapolyclinic@okicici';
process.env.APP_URL = 'https://samiha-hospitals-production.up.railway.app';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');
const config = require('../src/config');

let server;
let base;
const tokens = {};
const ids = {};

async function api(method, p, body, as = 'cashier') {
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

/** A raw fetch, for the things that are not JSON: the PDFs. */
async function raw(p, as = null) {
  const res = await fetch(`${base}${p}`, {
    headers: as ? { Authorization: `Bearer ${tokens[as]}` } : {},
  });
  return { status: res.status, type: res.headers.get('content-type'),
    disposition: res.headers.get('content-disposition'),
    body: Buffer.from(await res.arrayBuffer()) };
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['admin', 'cashier', 'reception', 'pharmacy']) {
    const r = await api('POST', '/api/auth/login',
      { username: `${who}@samiha.local`, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, who);
    tokens[who] = r.body.token;
  }

  ids.patient = db.prepare('SELECT id FROM patients ORDER BY id LIMIT 1').get().id;
  db.prepare("UPDATE patients SET phone = '919876543210', whatsapp = '919876543210' WHERE id = ?")
    .run(ids.patient);

  const inv = await api('POST', '/api/billing/invoices', { patientId: ids.patient, kind: 'opd' });
  assert.strictEqual(inv.status, 201, JSON.stringify(inv.body));
  ids.invoice = inv.body.id;
  ids.invoiceNo = inv.body.invoice_no;
  for (const [what, price] of [['Consultation — General Medicine', 300], ['Complete Blood Count', 200]]) {
    await api('POST', `/api/billing/invoices/${ids.invoice}/items`,
      { description: what, qty: 1, unitPrice: price, category: 'opd' });
  }
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const shares = () => db.prepare('SELECT * FROM document_shares ORDER BY id DESC').all();
const lastMessage = () => db.prepare(
  'SELECT * FROM whatsapp_messages WHERE direction = \'out\' ORDER BY id DESC LIMIT 1').get();

// ------------------------------------------------------------- the document
test('the bill comes out as a PDF with the invoice number in it', async () => {
  const r = await raw(`/api/billing/invoices/${ids.invoice}/pdf`, 'cashier');
  assert.strictEqual(r.status, 200);
  assert.match(r.type, /application\/pdf/);
  assert.strictEqual(r.body.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(r.body.includes(ids.invoiceNo), 'the bill names itself');
  assert.ok(r.body.includes('TAX INVOICE'), 'and says what it is');
  assert.ok(r.body.length > 1500, `a real document, got ${r.body.length} bytes`);
  assert.match(r.disposition, new RegExp(ids.invoiceNo));
});

test('money is written in a way the font can actually print', async () => {
  /*
   * The base-14 fonts a PDF can use without embedding one have no rupee
   * sign. Writing ₹ anyway puts a blank or a black box on a bill, so amounts
   * are written "Rs." — the thing that must never happen is a bill going out
   * with the number there and the unit missing.
   */
  const r = await raw(`/api/billing/invoices/${ids.invoice}/pdf`, 'cashier');
  const text = r.body.toString('latin1');
  assert.ok(text.includes('Rs. '), 'amounts carry their unit');
  assert.ok(!text.includes('₹'), 'and no rupee sign is written into the file');
});

// --------------------------------------------------------------- the sending
test('sending the bill stores a copy and puts a document in the chat', async () => {
  const before = shares().length;
  const r = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`,
    { to: '98765 43210' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.sent, true);
  assert.strictEqual(r.body.to, '919876543210', 'the country code is put on for us');
  assert.match(r.body.url, /^https:\/\/samiha-hospitals-production\.up\.railway\.app\/d\//);
  assert.match(r.body.filename, /^Invoice-INV\d+\.pdf$/);

  assert.strictEqual(shares().length, before + 1);
  const share = shares()[0];
  assert.strictEqual(share.kind, 'invoice');
  assert.strictEqual(share.ref_id, ids.invoice);
  assert.ok(share.bytes > 1500, 'the file itself is kept, not a promise to rebuild it');

  const msg = db.prepare('SELECT * FROM whatsapp_messages WHERE id = ?').get(share.message_id);
  assert.strictEqual(msg.message_type, 'document');
  assert.strictEqual(msg.status, 'sent');
  assert.match(JSON.parse(msg.payload).link, /\/d\//);
  assert.match(msg.body, /bill INV/, 'the caption says which bill');

  // And a line after it with the link, for a phone that will not open the file.
  const after = lastMessage();
  assert.strictEqual(after.message_type, 'text');
  assert.ok(after.body.includes(r.body.url), 'the link is in words too');
});

test('a number is dialled the way WhatsApp needs it, however it was typed', async () => {
  /*
   * WhatsApp will not deliver to a bare ten-digit number, and does not say
   * so loudly. The country code goes on here — from ten digits, from a
   * leading zero, from a pasted +91 — rather than being left to luck.
   */
  for (const typed of ['9876543210', '098765 43210', '+91 98765-43210', '919876543210']) {
    const r = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: typed });
    assert.strictEqual(r.body.to, '919876543210', `typed as "${typed}"`);
  }
  const msg = db.prepare('SELECT wa_number FROM whatsapp_messages ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(msg.wa_number, '919876543210', 'and that is what the record shows');
});

test('a number that is not a number is refused before anything is built', async () => {
  const before = shares().length;
  const r = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: '12345' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /WhatsApp number/i);
  assert.strictEqual(shares().length, before, 'and nothing is stored for a send that never happened');
});

// ------------------------------------------------------------- what patients get
test('the link serves the bill, and counts that it was opened', async () => {
  const sent = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: '9876543210' });
  const token = sent.body.token;

  const got = await raw(`/d/${token}`);
  assert.strictEqual(got.status, 200);
  assert.match(got.type, /application\/pdf/);
  assert.strictEqual(got.body.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(got.disposition, /inline/, 'a phone opens it rather than filing it away');

  const row = db.prepare('SELECT * FROM document_shares WHERE token = ?').get(token);
  assert.strictEqual(row.downloads, 1);
  assert.ok(row.last_seen_at, 'and when');
});

test('the copy that was sent does not change when the bill does', async () => {
  /*
   * This is the whole reason the file is stored rather than rebuilt. A
   * patient opening last month's link must see last month's bill.
   */
  const sent = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: '9876543210' });
  const first = (await raw(`/d/${sent.body.token}`)).body;

  const added = await api('POST', `/api/billing/invoices/${ids.invoice}/items`,
    { description: 'Dressing', qty: 1, unitPrice: 150, category: 'procedure' });
  assert.strictEqual(added.status, 201, JSON.stringify(added.body));

  const again = (await raw(`/d/${sent.body.token}`)).body;
  assert.deepStrictEqual(again, first, 'the sent copy is frozen');
  assert.ok(!again.includes('Dressing'), 'the later charge is not on it');

  // While today's bill does carry it.
  const fresh = await raw(`/api/billing/invoices/${ids.invoice}/pdf`, 'cashier');
  assert.ok(fresh.body.includes('Dressing'), 'the live bill is up to date');
});

test('a link that was never issued, and one that has run out', async () => {
  const missing = await fetch(`${base}/d/not-a-real-token`);
  assert.strictEqual(missing.status, 404);
  assert.match(await missing.text(), /could not find that bill/i);

  const sent = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: '9876543210' });
  db.prepare("UPDATE document_shares SET expires_at = datetime('now', '-1 day') WHERE token = ?")
    .run(sent.body.token);

  const old = await fetch(`${base}/d/${sent.body.token}`);
  assert.strictEqual(old.status, 410);
  const page = await old.text();
  assert.match(page, /expired/i, 'the patient is told why, not shown a blank page');
  assert.match(page, /call the clinic/i, 'and what to do about it');
});

test('a sent bill expires, rather than sitting on the internet for ever', async () => {
  const sent = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: '9876543210' });
  const row = db.prepare('SELECT * FROM document_shares WHERE token = ?').get(sent.body.token);
  assert.ok(row.expires_at, 'there is an end to it');
  const days = (new Date(row.expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 86400000;
  assert.ok(days > 30 && days < 400, `a sensible life, got ${Math.round(days)} days`);
  assert.ok(row.token.length >= 20, 'and the token is not guessable');
});

// ------------------------------------------------------------------- refusals
test('when WhatsApp refuses it, the counter is told at once', async () => {
  /*
   * WhatsApp will not deliver a free-form message to somebody who has not
   * written to the business in the last 24 hours, which is most patients at
   * a counter. The send comes back refused rather than throwing, because the
   * cashier has to hear it while paper is still an option — and the bill is
   * still stored, so it can be sent again or the link read out.
   */
  const was = config.whatsapp.provider;
  config.whatsapp.provider = 'meta';          // configured, but with no token
  try {
    const r = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: '9876543210' });
    assert.strictEqual(r.status, 200, 'not an error — an outcome');
    assert.strictEqual(r.body.sent, false);
    assert.ok(r.body.error, 'with the reason');
    assert.ok(r.body.url, 'and the link, which still works');

    const msg = db.prepare('SELECT * FROM whatsapp_messages ORDER BY id DESC LIMIT 1').get();
    assert.strictEqual(msg.status, 'failed');
    assert.strictEqual(msg.message_type, 'document',
      'the failure is recorded against the document, not a stray text');

    const served = await fetch(`${base}/d/${r.body.token}`);
    assert.strictEqual(served.status, 200, 'the stored bill is reachable even though the send failed');
  } finally {
    config.whatsapp.provider = was;
  }
});

// ---------------------------------------------------------------------- who
test('the counters may send a bill, and nobody else', async () => {
  assert.strictEqual((await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`,
    { to: '9876543210' }, 'reception')).status, 403, 'reception books, it does not bill');
  assert.strictEqual((await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`,
    { to: '9876543210' }, 'pharmacy')).status, 403, 'the chemist sends its own bills, not the clinic\'s');
  assert.strictEqual((await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`,
    { to: '9876543210' }, 'admin')).status, 200);
  assert.strictEqual((await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`,
    { to: '9876543210' }, 'cashier')).status, 200);
});

test('every send is on the record', async () => {
  const r = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: '9000000001' });
  assert.strictEqual(r.status, 200);
  const row = db.prepare(
    "SELECT * FROM audit_logs WHERE action = 'share' ORDER BY id DESC LIMIT 1").get();
  assert.strictEqual(row.entity, 'invoice');
  assert.strictEqual(row.entity_id, ids.invoice);
  const details = JSON.parse(row.details);
  assert.strictEqual(details.to, '919000000001');
  assert.strictEqual(details.sent, true);
  assert.ok(row.actor && row.actor !== 'system', 'and who sent it');

  // The counter can see what has gone out, and whether it landed.
  const list = await api('GET', `/api/billing/invoices/${ids.invoice}/shares`);
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.length >= 2, 'the history is kept');
  assert.ok(list.body[0].url.includes('/d/'));
  assert.ok('downloads' in list.body[0]);
});

// -------------------------------------------------------------- the pharmacy
test('the chemist sends its own tax invoice, with the batch numbers on it', async () => {
  const otc = db.prepare(
    `SELECT d.id FROM drugs d
      WHERE d.active = 1 AND d.schedule_type = 'OTC'
        AND EXISTS (SELECT 1 FROM drug_batches b
                     WHERE b.drug_id = d.id AND b.qty_available > 2 AND COALESCE(b.mrp, 0) > 0)
      LIMIT 2`).all();
  assert.ok(otc.length, 'the seeded shelf has something priced on it');

  const sale = await api('POST', '/api/pharmacy/counter-sale', {
    customerName: 'Fathima Begum', customerPhone: '9876500011',
    items: otc.map((d) => ({ drugId: d.id, qty: 1 })), paymentMode: 'cash',
  }, 'pharmacy');
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.body));
  const saleId = (sale.body.sale || sale.body).id;

  const pdf = await raw(`/api/pharmacy/sales/${saleId}/pdf`, 'pharmacy');
  assert.strictEqual(pdf.status, 200);
  assert.ok(pdf.body.includes('GST TAX INVOICE'));
  assert.ok(pdf.body.includes('B.No'), 'the batch is on the bill, as the rules require');

  const sent = await api('POST', `/api/pharmacy/sales/${saleId}/whatsapp`,
    { to: '9876500011' }, 'pharmacy');
  assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
  assert.strictEqual(sent.body.sent, true);
  assert.match(sent.body.filename, /^Pharmacy-bill-/);

  const served = await raw(`/d/${sent.body.token}`);
  assert.strictEqual(served.status, 200);
  assert.ok(served.body.includes('GST TAX INVOICE'));

  // The cashier may send it too — the same counter, settling the same sale.
  assert.strictEqual((await api('POST', `/api/pharmacy/sales/${saleId}/whatsapp`,
    { to: '9876500011' }, 'cashier')).status, 200);
  assert.strictEqual((await api('POST', `/api/pharmacy/sales/${saleId}/whatsapp`,
    { to: '9876500011' }, 'reception')).status, 403);
});

test('a bill that does not exist is a 404, not a blank PDF', async () => {
  assert.strictEqual((await raw('/api/billing/invoices/999999/pdf', 'cashier')).status, 404);
  assert.strictEqual((await api('POST', '/api/billing/invoices/999999/whatsapp',
    { to: '9876543210' })).status, 404);
});

test('a bill outlives the person who sent it', async () => {
  /*
   * Who pressed send is a clerical note, not a signature: the audit row keeps
   * their name in words whatever happens to the account. So a cashier who has
   * sent bills can still be removed when they leave, and the bills they sent
   * stay where they are and keep opening.
   */
  const hire = await api('POST', '/api/masters/staff',
    { name: 'Relief Cashier', role: 'cashier', password: 'Samiha#2026' }, 'admin');
  assert.strictEqual(hire.status, 201, JSON.stringify(hire.body));
  const code = db.prepare('SELECT staff_code FROM users WHERE id = ?').get(hire.body.id).staff_code;
  const login = await api('POST', '/api/auth/login',
    { username: code, password: 'Samiha#2026' }, null);
  assert.strictEqual(login.status, 200, JSON.stringify(login.body));
  tokens.relief = login.body.token;

  const sent = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`,
    { to: '9876543210' }, 'relief');
  assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));

  const gone = await api('DELETE', `/api/masters/staff/${hire.body.id}`, undefined, 'admin');
  assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));

  const still = await fetch(`${base}/d/${sent.body.token}`);
  assert.strictEqual(still.status, 200, 'the patient\'s link still works');
  const row = db.prepare('SELECT sent_by FROM document_shares WHERE token = ?').get(sent.body.token);
  assert.strictEqual(row.sent_by, null, 'the account is cut loose, the document is not');
  assert.strictEqual(db.pragma('foreign_key_check').length, 0);
});

// ------------------------------------------------------- the approved template
/*
 * WhatsApp will not carry a free-form message to somebody who has not written
 * to the clinic in the last 24 hours, which is nearly every patient paying at
 * a counter. An approved template is the only thing it will carry, so the
 * fallback is the difference between a bill that arrives and one that cannot.
 *
 * These tests stand in for Meta: `fetch` is replaced so the refusal and the
 * second attempt can be watched, because the one thing that must be right is
 * what is sent on the second attempt — a template name, a document header
 * carrying the PDF, and the body variables in the order the clinic's own
 * approved wording expects.
 */
function withMeta(handler, run) {
  const realFetch = global.fetch;
  const was = { provider: config.whatsapp.provider, token: config.whatsapp.token,
    phoneNumberId: config.whatsapp.phoneNumberId };
  config.whatsapp.provider = 'meta';
  config.whatsapp.token = 'test-token';
  config.whatsapp.phoneNumberId = '1234567890';
  const calls = [];
  global.fetch = async (url, init) => {
    // Only Meta is intercepted; the test's own calls to the ERP go through.
    if (!String(url).includes('graph.facebook.com')) return realFetch(url, init);
    // A read (listing templates) carries no body; a send does.
    const sent = init && init.body ? JSON.parse(init.body) : { type: 'GET', url: String(url) };
    calls.push(sent);
    return handler(sent, calls.length);
  };
  return Promise.resolve(run(calls)).finally(() => {
    global.fetch = realFetch;
    Object.assign(config.whatsapp, was);
  });
}

const metaOk = () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.TEST' }] }) });
const metaWindowClosed = () => ({
  ok: false,
  json: async () => ({ error: {
    code: 131047,
    message: 'Re-engagement message',
    error_data: { details: 'Message failed to send because more than 24 hours have passed.' },
  } }),
});

test('inside the 24-hour window a bill goes as a plain document', async () => {
  await withMeta(() => metaOk(), async (calls) => {
    config.whatsapp.billTemplate.name = 'samiha_bill';
    const r = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: '9876543210' });
    assert.strictEqual(r.body.sent, true);
    assert.strictEqual(r.body.via, 'document', 'the free one, which also reads better');
    assert.strictEqual(calls[0].type, 'document');
    assert.ok(!calls.some((c) => c.type === 'template'), 'the template is not spent when it need not be');
    config.whatsapp.billTemplate.name = '';
  });
});

test('outside it, the bill goes again under the approved template', async () => {
  await withMeta((sent) => (sent.type === 'document' ? metaWindowClosed() : metaOk()), async (calls) => {
    config.whatsapp.billTemplate.name = 'samiha_bill';
    config.whatsapp.billTemplate.language = 'en_US';
    const r = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: '9876543210' });

    assert.strictEqual(r.body.sent, true, 'the patient gets their bill');
    assert.strictEqual(r.body.via, 'template');
    assert.strictEqual(r.body.windowClosed, true);

    const used = calls.find((c) => c.type === 'template');
    assert.ok(used, 'it was tried the cheap way first, then under the template');
    assert.strictEqual(used.template.name, 'samiha_bill');
    assert.strictEqual(used.template.language.code, 'en_US');

    // The header is the only place a PDF can ride on a template.
    const header = used.template.components.find((c) => c.type === 'header');
    assert.strictEqual(header.parameters[0].type, 'document');
    assert.match(header.parameters[0].document.link, /\/d\//);
    assert.match(header.parameters[0].document.filename, /^Invoice-INV/);

    // And the body variables, in the order the clinic's wording declares.
    const body = used.template.components.find((c) => c.type === 'body');
    assert.strictEqual(body.parameters.length, 4);
    assert.ok(body.parameters[1].text.startsWith('INV'), 'the bill number is the second');
    assert.match(body.parameters[2].text, /Rs|₹|\d/, 'and the total the third');
    for (const p of body.parameters) {
      assert.ok(!/\n|\t|\s{4}/.test(p.text),
        `"${p.text}" has no newline or run of spaces — Meta rejects the whole message for one`);
    }

    config.whatsapp.billTemplate.name = '';
    config.whatsapp.billTemplate.language = 'en';
  });
});

test('the clinic chooses what fills the template, without a code change', async () => {
  await withMeta((sent) => (sent.type === 'document' ? metaWindowClosed() : metaOk()), async (calls) => {
    config.whatsapp.billTemplate.name = 'samiha_bill';
    config.whatsapp.billTemplate.body = '{billNo}|{total}';   // an approved wording with two
    const r = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: '9876543210' });
    assert.strictEqual(r.body.sent, true);

    const body = calls.find((c) => c.type === 'template').template.components
      .find((c) => c.type === 'body');
    assert.strictEqual(body.parameters.length, 2, 'two variables, because that is what was approved');
    assert.ok(body.parameters[0].text.startsWith('INV'));

    config.whatsapp.billTemplate.body = '{patient}|{billNo}|{total}|{balance}';
    config.whatsapp.billTemplate.name = '';
  });
});

test('with no template set up, the refusal is reported and says what would fix it', async () => {
  await withMeta(() => metaWindowClosed(), async (calls) => {
    const r = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: '9876543210' });
    assert.strictEqual(r.body.sent, false);
    assert.strictEqual(r.body.windowClosed, true, 'the counter is told which refusal this was');
    assert.strictEqual(r.body.templateReady, false, 'and that the one cure is not in place');
    assert.ok(r.body.url, 'while the bill itself is still there to print or read out');
    assert.strictEqual(calls.length, 1, 'nothing is tried that cannot work');
  });
});

test('a refusal that is not the window is not papered over with a template', async () => {
  /*
   * A bad token and a closed window both come back as a failed send. Sending
   * a template after a bad token would spend a paid message on a call that
   * cannot succeed, and would hide the real fault.
   */
  const badToken = () => ({ ok: false, json: async () => ({ error: { code: 190, message: 'Invalid OAuth access token' } }) });
  await withMeta(() => badToken(), async (calls) => {
    config.whatsapp.billTemplate.name = 'samiha_bill';
    const r = await api('POST', `/api/billing/invoices/${ids.invoice}/whatsapp`, { to: '9876543210' });
    assert.strictEqual(r.body.sent, false);
    assert.strictEqual(r.body.windowClosed, false);
    assert.match(r.body.error, /190/, 'the real reason survives, with its code');
    assert.strictEqual(calls.length, 1, 'and no template was spent on it');
    config.whatsapp.billTemplate.name = '';
  });
});

test('the clinic can ask Meta whether its template is actually ready', async () => {
  const approved = {
    data: [{
      name: 'samiha_bill', status: 'APPROVED', category: 'UTILITY', language: 'en',
      components: [
        { type: 'HEADER', format: 'DOCUMENT' },
        { type: 'BODY', text: 'Hello {{1}}, here is your bill {{2}}. Total {{3}}. {{4}}.' },
      ],
    }],
  };
  await withMeta(() => ({ ok: true, json: async () => approved }), async () => {
    config.whatsapp.wabaId = '99887766';
    config.whatsapp.billTemplate.name = 'samiha_bill';

    const r = await api('GET', '/api/whatsapp/templates', undefined, 'admin');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ready, true);
    assert.strictEqual(r.body.templates[0].hasDocumentHeader, true);
    assert.strictEqual(r.body.templates[0].variables, 4);

    // The two ways a template can exist and still not work.
    approved.data[0].status = 'PENDING';
    const pending = await api('GET', '/api/whatsapp/templates', undefined, 'admin');
    assert.strictEqual(pending.body.ready, false);
    assert.match(pending.body.verdict, /not approved yet/i);

    approved.data[0].status = 'APPROVED';
    approved.data[0].components[0].format = 'TEXT';
    const noHeader = await api('GET', '/api/whatsapp/templates', undefined, 'admin');
    assert.strictEqual(noHeader.body.ready, false);
    assert.match(noHeader.body.verdict, /document header/i);

    // And it is the administrator's question, not the counter's.
    assert.strictEqual((await api('GET', '/api/whatsapp/templates', undefined, 'cashier')).status, 403);

    config.whatsapp.wabaId = '';
    config.whatsapp.billTemplate.name = '';
  });
});
