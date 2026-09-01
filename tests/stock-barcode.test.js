'use strict';
/**
 * The pharmacy's own book: suppliers, goods received, barcodes printed for
 * every medicine and batch, the stock register that has to reconcile, and the
 * physical stock take.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-stock-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
const app = require('../src/server');

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

const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [['admin', 'admin@samiha.local'], ['pharmacy', 'pharmacy@samiha.local'],
    ['reception', 'reception@samiha.local']]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  // Two medicines of our own, so the register maths is not entangled with
  // whatever the seed already put on the shelf.
  ids.para = (await api('POST', '/api/pharmacy/drugs', {
    code: 'STKTEST1', name: 'Testonium', strength: '500 mg', form: 'tablet',
    mrp: 2, purchasePrice: 1.2, taxPct: 12, reorderLevel: 20,
  })).body.id;
  ids.ors = (await api('POST', '/api/pharmacy/drugs', {
    code: 'STKTEST2', name: 'Rehydra Salt', form: 'sachet',
    mrp: 22, purchasePrice: 14, taxPct: 5, reorderLevel: 10,
  })).body.id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a supplier can be added and is listed with nothing outstanding', async () => {
  const created = await api('POST', '/api/stock/suppliers', {
    name: 'Chennai Medical Distributors', contactPerson: 'S. Kumar',
    phone: '9840012345', gstin: '33AABCS1234F1Z5', creditDays: 30,
  });
  assert.strictEqual(created.status, 201);
  ids.supplier = created.body.id;
  assert.ok(created.body.code, 'a code is generated when none is given');

  const list = (await api('GET', '/api/stock/suppliers')).body;
  const row = list.find((s) => s.id === ids.supplier);
  assert.strictEqual(row.purchases, 0);
  assert.strictEqual(row.outstanding, 0);
});

test('a goods-received note takes stock in, prices it and labels every batch', async () => {
  const res = await api('POST', '/api/stock/purchases', {
    supplierId: ids.supplier,
    invoiceNo: 'CMD/2026/4411',
    invoiceDate: '2026-09-01',
    paid: 0,
    items: [
      { drugId: ids.para, batchNo: 'PB-201', expiryDate: future(400), qty: 200, freeQty: 10,
        purchasePrice: 1.2, mrp: 2, taxPct: 12, discountPct: 10, packBarcode: '8901234567894' },
      { drugId: ids.ors, batchNo: 'OB-77', expiryDate: future(300), qty: 50,
        purchasePrice: 14, mrp: 22, taxPct: 5 },
    ],
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  ids.purchase = res.body.purchase.id;
  ids.grnNo = res.body.purchase.grn_no;
  assert.match(ids.grnNo, /^GRN\d{8}$/);

  // 200 × 1.2 = 240, less 10% = 216, +12% tax = 241.92
  //  50 × 14  = 700, +5% tax = 735
  assert.strictEqual(res.body.purchase.gross, 940);
  assert.strictEqual(res.body.purchase.discount, 24);
  assert.strictEqual(res.body.purchase.net, 976.92);
  assert.strictEqual(res.body.purchase.status, 'received');

  // Every batch got a scannable label without anyone asking for one.
  assert.strictEqual(res.body.batches.length, 2);
  for (const b of res.body.batches) {
    assert.match(b.barcode, /^29\d{11}$/, 'batch labels use the internal 29… range');
  }
  ids.paraBatch = res.body.batches.find((b) => b.drug_id === ids.para).id;

  // The free strips are on the shelf even though they were not invoiced.
  const batches = (await api('GET', `/api/pharmacy/drugs/${ids.para}/batches`)).body;
  const batch = batches.find((b) => b.batch_no === 'PB-201');
  assert.strictEqual(batch.qty_available, 210);
  assert.strictEqual(batch.mrp, 2);
});

test('an expired or badly dated batch is refused at goods-in', async () => {
  const expired = await api('POST', '/api/stock/purchases', {
    supplierId: ids.supplier,
    items: [{ drugId: ids.ors, batchNo: 'OLD-1', expiryDate: '2020-01-01', qty: 5 }],
  });
  assert.strictEqual(expired.status, 400);
  assert.match(expired.body.error, /do not take expired stock in/i);

  const malformed = await api('POST', '/api/stock/purchases', {
    supplierId: ids.supplier,
    items: [{ drugId: ids.ors, batchNo: 'ODD-1', expiryDate: 'next year', qty: 5 }],
  });
  assert.strictEqual(malformed.status, 400);
});

test('scanning finds the medicine by pack code and the batch by our own label', async () => {
  const byPack = (await api('GET', '/api/stock/scan?code=8901234567894')).body;
  assert.strictEqual(byPack.match, 'drug');
  assert.strictEqual(byPack.drug.id, ids.para);
  assert.strictEqual(byPack.onHand, 210);

  const batches = (await api('GET', `/api/pharmacy/drugs/${ids.para}/batches`)).body;
  const label = batches.find((b) => b.batch_no === 'PB-201').barcode;
  const byBatch = (await api('GET', `/api/stock/scan?code=${label}`)).body;
  assert.strictEqual(byBatch.match, 'batch');
  assert.strictEqual(byBatch.batch.batch_no, 'PB-201');
  assert.strictEqual(byBatch.expired, false);

  const nothing = await api('GET', '/api/stock/scan?code=0000000000000');
  assert.strictEqual(nothing.status, 404);
});

test('every medicine can be given a printable code, and none is printed twice', async () => {
  const before = (await api('GET', '/api/stock/barcodes')).body;
  assert.ok(before.missing > 0, 'the seed formulary starts without barcodes');

  const filled = (await api('POST', '/api/stock/barcodes/generate-missing', {})).body;
  assert.strictEqual(filled.generated, before.missing);

  const after = (await api('GET', '/api/stock/barcodes')).body;
  assert.strictEqual(after.missing, 0);
  const codes = after.rows.map((r) => r.barcode);
  assert.strictEqual(new Set(codes).size, codes.length, 'no two medicines share a barcode');

  // The pack code we already linked is left alone.
  assert.strictEqual(after.rows.find((r) => r.id === ids.para).barcode, '8901234567894');

  // Running it again finds nothing left to do.
  assert.strictEqual((await api('POST', '/api/stock/barcodes/generate-missing', {})).body.generated, 0);

  const labels = (await api('GET', `/api/stock/labels/drugs?drugIds=${ids.ors}`)).body;
  assert.strictEqual(labels.length, 1);
  assert.match(labels[0].barcode, /^28\d{11}$/, 'our own medicine labels use the 28… range');
});

test('a barcode cannot be pointed at two different medicines', async () => {
  const clash = await api('POST', `/api/stock/barcodes/drug/${ids.ors}`, { barcode: '8901234567894' });
  assert.strictEqual(clash.status, 409);
  assert.match(clash.body.error, /already linked/i);
});

test('the stock register reconciles opening, received, issued and closing', async () => {
  const sale = await api('POST', '/api/pharmacy/counter-sale', {
    customerName: 'Walk-in', items: [{ drugId: ids.para, qty: 10 }],
  });
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.body));

  const reg = (await api('GET', `/api/stock/register?from=${future(-1)}&to=${future(1)}`)).body;
  const row = reg.rows.find((r) => r.drug_id === ids.para);
  assert.strictEqual(row.inward, 210);
  assert.strictEqual(row.outward, 10);
  assert.strictEqual(row.closing, row.opening + row.inward - row.outward);
  assert.strictEqual(row.on_hand, 200, 'the register agrees with the shelf');
  assert.strictEqual(row.stock_value, 240, '200 strips still costed at 1.20');

  const movements = (await api('GET', `/api/stock/register/${ids.para}/movements`)).body;
  assert.strictEqual(movements.movements[0].txn_type, 'sale');
  assert.strictEqual(movements.movements[0].qty_delta, -10);
  assert.strictEqual(movements.movements.at(-1).txn_type, 'purchase');
  assert.ok(movements.movements.some((m) => (m.notes || '').includes(ids.grnNo)),
    'the goods-received note is named on the movement it created');
});

test('a stock take writes the difference to the ledger instead of hiding it', async () => {
  const sheet = (await api('GET', '/api/stock/takes/new/sheet')).body;
  const line = sheet.find((r) => r.batch_id === ids.paraBatch);
  assert.strictEqual(line.book_qty, 200);

  const take = await api('POST', '/api/stock/takes', {
    notes: 'Monthly count',
    items: [{ batchId: ids.paraBatch, countedQty: 196, reason: 'damaged in the rain' }],
  });
  assert.strictEqual(take.status, 201);
  assert.strictEqual(take.body.variances, 1);

  const detail = (await api('GET', `/api/stock/takes/${take.body.id}`)).body;
  assert.strictEqual(detail.items[0].variance, -4);

  const movements = (await api('GET', `/api/stock/register/${ids.para}/movements`)).body;
  assert.strictEqual(movements.movements[0].txn_type, 'adjustment');
  assert.strictEqual(movements.movements[0].qty_delta, -4);
  assert.match(movements.movements[0].notes, /damaged in the rain/);
  assert.strictEqual(movements.batches.find((b) => b.id === ids.paraBatch).qty_available, 196);
});

test('supplier payments run the invoice down to paid', async () => {
  const part = (await api('POST', `/api/stock/purchases/${ids.purchase}/pay`, { amount: 500 })).body;
  assert.strictEqual(part.status, 'partially_paid');

  const tooMuch = await api('POST', `/api/stock/purchases/${ids.purchase}/pay`, { amount: 5000 });
  assert.strictEqual(tooMuch.status, 400);

  const rest = (await api('POST', `/api/stock/purchases/${ids.purchase}/pay`, { amount: 476.92 })).body;
  assert.strictEqual(rest.status, 'paid');

  const list = (await api('GET', '/api/stock/suppliers')).body.find((s) => s.id === ids.supplier);
  assert.strictEqual(list.purchases, 1);
  assert.strictEqual(list.outstanding, 0);
});

test('only the pharmacy may take stock in; everyone at the desk may scan', async () => {
  const blocked = await api('POST', '/api/stock/purchases', {
    supplierId: ids.supplier, items: [{ drugId: ids.ors, batchNo: 'X1', expiryDate: future(200), qty: 1 }],
  }, 'reception');
  assert.strictEqual(blocked.status, 403);

  const scan = await api('GET', '/api/stock/scan?code=8901234567894', undefined, 'reception');
  assert.strictEqual(scan.status, 403, 'reception is not on the pharmacy counter');

  const admin = await api('GET', '/api/stock/scan?code=8901234567894', undefined, 'admin');
  assert.strictEqual(admin.status, 200, 'the administrator always gets through');
});
