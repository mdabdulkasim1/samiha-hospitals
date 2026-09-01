'use strict';
/**
 * The pharmacy's tax invoice. MRP printed on a pack already contains GST, so
 * the tax has to come out of it and never on top — and the bill has to carry
 * what Rule 46 of the CGST Rules and the Drugs & Cosmetics Rules require.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-gst-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';
process.env.PHARMACY_GSTIN = '33AABCS1234F1Z5';
process.env.PHARMACY_DL_NUMBERS = 'TN/CHN/20B/1234, TN/CHN/21B/1234';
process.env.PHARMACIST_NAME = 'S. Kavitha, B.Pharm';
process.env.PHARMACIST_REG_NO = 'TN/PH/44120';

require('../src/db/seed');
const app = require('../src/server');
const pharmacy = require('../src/services/pharmacy');

let server;
let base;
const tokens = {};
const ids = {};

async function api(method, p, body, as = 'pharmacy') {
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

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [['admin', 'admin@samiha.local'], ['pharmacy', 'pharmacy@samiha.local']]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200);
    tokens[as] = r.body.token;
  }
  const drugs = (await api('GET', '/api/pharmacy/drugs?limit=300')).body;
  ids.para = drugs.find((d) => d.code === 'PARA500');   // 12% GST
  ids.ors = drugs.find((d) => d.code === 'ORS');        // 5% GST
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the maths
test('GST comes out of the MRP, never on top of it', () => {
  // ₹20 at 12%: 20 × 100/112 = 17.86 taxable, 2.14 tax — and 17.86 + 2.14 = 20.
  const line = pharmacy.gstOnLine({ mrp: 2, qty: 10, taxPct: 12 });
  assert.strictEqual(line.taxable, 17.86);
  assert.strictEqual(line.tax, 2.14);
  assert.strictEqual(pharmacy.round2(line.taxable + line.tax), 20,
    'the patient pays the printed MRP and not a paisa more');
  assert.strictEqual(pharmacy.round2(line.cgst + line.sgst), line.tax, 'the tax splits in two');
  assert.strictEqual(line.cgst, 1.07);
});

test('an exempt medicine carries no tax at all', () => {
  const line = pharmacy.gstOnLine({ mrp: 50, qty: 1, taxPct: 0 });
  assert.strictEqual(line.taxable, 50);
  assert.strictEqual(line.tax, 0);
  assert.strictEqual(line.cgst, 0);
});

test('the total is stated in words, the way an invoice must', () => {
  assert.strictEqual(pharmacy.amountInWords(66), 'Sixty Six Rupees Only');
  assert.strictEqual(pharmacy.amountInWords(0), 'Zero Rupees Only');
  assert.strictEqual(pharmacy.amountInWords(1), 'One Rupees Only');
  assert.strictEqual(pharmacy.amountInWords(43.79), 'Forty Three Rupees and Seventy Nine Paise Only');
  assert.strictEqual(pharmacy.amountInWords(125430.5),
    'One Lakh Twenty Five Thousand Four Hundred Thirty Rupees and Fifty Paise Only');
  assert.match(pharmacy.amountInWords(10000000), /^One Crore Rupees Only$/);
});

// ------------------------------------------------------------------ the bill
test('a counter sale charges exactly the MRP and rounds to the rupee', async () => {
  const sale = await api('POST', '/api/pharmacy/counter-sale', {
    customerName: 'Ramesh Kumar', customerPhone: '9845012345',
    items: [{ drugId: ids.para.id, qty: 10 }, { drugId: ids.ors.id, qty: 2 }],
    paymentMode: 'cash',
  });
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.body));
  ids.sale = sale.body.sale.id;

  const s = sale.body.sale;
  const mrpTotal = pharmacy.round2(ids.para.mrp * 10 + ids.ors.mrp * 2);
  assert.strictEqual(pharmacy.round2(s.gross + s.tax), mrpTotal,
    'taxable plus GST is the MRP total — nothing is added on top');
  assert.strictEqual(s.net, Math.round(mrpTotal), 'cash bills settle to the rupee');
  assert.strictEqual(s.round_off, pharmacy.round2(s.net - mrpTotal));
  assert.strictEqual(sale.body.balance, 0);
});

test('the tax invoice carries everything the law asks for', async () => {
  const inv = (await api('GET', `/api/pharmacy/sales/${ids.sale}/invoice`)).body;

  // Rule 46: supplier identity and registration.
  assert.strictEqual(inv.supplier.name, 'SAMIHA PHARMACEUTICALS');
  assert.strictEqual(inv.supplier.gstin, '33AABCS1234F1Z5');
  assert.ok(inv.supplier.address);
  assert.strictEqual(inv.supplier.stateCode, '33');

  // Drugs & Cosmetics Rules: licences and the pharmacist who handed it over.
  assert.match(inv.supplier.dlNumbers, /TN\/CHN\/20B/);
  assert.strictEqual(inv.supplier.pharmacistName, 'S. Kavitha, B.Pharm');
  assert.strictEqual(inv.supplier.pharmacistRegNo, 'TN/PH/44120');

  // A consecutive serial number and its date.
  assert.match(inv.sale.bill_no, /^PH\d{9}$/);
  assert.ok(inv.sale.created_at);

  // Place of supply and reverse charge are stated.
  assert.strictEqual(inv.placeOfSupply, 'Tamil Nadu (33)');
  assert.strictEqual(inv.reverseCharge, 'No');

  // Every line shows HSN, batch, expiry and its own tax split.
  for (const i of inv.items) {
    assert.ok(i.hsn_code, 'a GST invoice must show an HSN code');
    assert.ok(i.batch_no, 'a medicine bill must show the batch');
    assert.ok(i.expiry_date, 'a medicine bill must show the expiry');
    assert.strictEqual(pharmacy.round2(i.taxable + i.cgst + i.sgst),
      pharmacy.round2(i.mrp * i.qty), 'the line reconciles to its MRP');
  }

  // The rate-wise summary adds up to the invoice.
  const fromHsn = inv.hsnSummary.reduce((a, h) => ({
    taxable: pharmacy.round2(a.taxable + h.taxable),
    tax: pharmacy.round2(a.tax + h.cgst + h.sgst),
  }), { taxable: 0, tax: 0 });
  assert.strictEqual(fromHsn.taxable, inv.summary.taxable);
  assert.strictEqual(fromHsn.tax, pharmacy.round2(inv.summary.cgst + inv.summary.sgst));
  assert.deepStrictEqual(inv.hsnSummary.map((h) => h.rate), [5, 12], 'grouped by rate');

  // Intra-state, so CGST and SGST — never IGST.
  assert.strictEqual(inv.summary.cgst, inv.summary.sgst);

  // And the total in words.
  assert.strictEqual(inv.amountInWords, pharmacy.amountInWords(inv.sale.net));
});

test('a bill reprints exactly as it was issued', async () => {
  const first = (await api('GET', `/api/pharmacy/sales/${ids.sale}/invoice`)).body;
  // Change today's prices; yesterday's invoice must not move.
  await api('POST', '/api/pharmacy/drugs', {
    code: 'GSTTEST', name: 'Repriced Tablet', mrp: 99, taxPct: 18,
  });
  const again = (await api('GET', `/api/pharmacy/sales/${ids.sale}/invoice`)).body;
  assert.deepStrictEqual(again.items.map((i) => [i.taxable, i.cgst, i.sgst]),
    first.items.map((i) => [i.taxable, i.cgst, i.sgst]));
  assert.strictEqual(again.sale.net, first.sale.net);
});

test('a dispensed prescription is taxed the same way, to the paisa', async () => {
  const patient = (await api('POST', '/api/patients', {
    firstName: 'Gst', lastName: 'Check', phone: '9845077777', gender: 'female',
    dateOfBirth: '1990-01-01', consentTreatment: true,
  }, 'admin')).body;

  const dispensed = await api('POST', '/api/pharmacy/dispense', {
    patientId: patient.id, items: [{ drugId: ids.para.id, qty: 10 }],
  });
  assert.strictEqual(dispensed.status, 201, JSON.stringify(dispensed.body));

  const s = dispensed.body.sale;
  assert.strictEqual(pharmacy.round2(s.gross + s.tax), pharmacy.round2(ids.para.mrp * 10));
  assert.strictEqual(s.net, pharmacy.round2(ids.para.mrp * 10),
    'no rupee rounding — the visit bill settles to the paisa');

  const inv = (await api('GET', `/api/pharmacy/sales/${s.id}/invoice`)).body;
  assert.strictEqual(inv.sale.sale_type, 'prescription');
  assert.ok(inv.items.every((i) => i.hsn_code));
});
