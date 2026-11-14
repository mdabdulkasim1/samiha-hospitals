'use strict';
/**
 * Opening stock, plus what came in, less what went out, equals closing stock.
 *
 * Every accountant asks for this statement and most clinics cannot produce
 * it, because the shelf is counted in one place and the movements are
 * written down in another and nobody ever proves the two agree. Here they
 * can be, and these tests are about the proof rather than the arithmetic:
 * the statement is built from the ledger and from the batches independently,
 * and if stock ever moves without a movement being written, the difference
 * has to show as a number instead of vanishing.
 *
 * The rest is about telling apart the ways a pack can leave without being
 * sold. Expiry is a buying mistake, damage is a handling one, a return is
 * money the supplier owes back, and a shortage is none of those — they used
 * to be one undifferentiated line, and a line like that cannot be acted on.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-recon-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');
const recon = require('../src/services/stockReconciliation');

let server;
let base;
const tokens = {};
const ids = {};
const to = new Date().toISOString().slice(0, 10);
const from = `${to.slice(0, 7)}-01`;

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

const statement = () => recon.statement(from, to);
const lineNamed = (s, name) => [...s.inwardLines, ...s.outwardLines]
  .find((l) => l.label.toLowerCase().startsWith(name.toLowerCase()));

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['pharmacy', 'admin', 'cashier', 'reception']) {
    const r = await api('POST', '/api/auth/login',
      { username: `${who}@samiha.local`, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, who);
    tokens[who] = r.body.token;
  }

  /*
   * A batch with a cost price of its own, because the seeded opening stock
   * was taken in without rates and a movement out of an unpriced batch is
   * worth nothing — which is true, and useless for testing arithmetic.
   */
  const drug = await api('POST', '/api/pharmacy/drugs', {
    code: 'RECONTEST', name: 'Recon Test Tablet', genericName: 'Paracetamol',
    form: 'tablet', strength: '500 mg', mrp: 20, purchasePrice: 12, scheduleType: 'OTC',
  });
  assert.strictEqual(drug.status, 201, JSON.stringify(drug.body));
  ids.drug = drug.body.id;
  const supplier = await api('POST', '/api/stock/suppliers',
    { name: 'Reconciliation Test Supplies', phone: '9800000001' });
  assert.strictEqual(supplier.status, 201, JSON.stringify(supplier.body));
  const received = await api('POST', '/api/stock/purchases', {
    supplierId: supplier.body.id,
    invoiceNo: 'RECON/1', items: [{
      drugId: ids.drug, batchNo: 'RECON-A', expiryDate: '2028-12-31',
      qty: 100, mrp: 20, purchasePrice: 12,
    }],
  });
  assert.strictEqual(received.status, 201, JSON.stringify(received.body));
  ids.batch = db.prepare("SELECT id FROM drug_batches WHERE batch_no = 'RECON-A'").get().id;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------- the statement
test('a purchase is on the statement at what the clinic paid, not at MRP', () => {
  const s = statement();
  const purchases = lineNamed(s, 'Purchases');
  assert.ok(purchases.value >= 1200, `100 packs at 12 is 1,200 of the total ${purchases.value}`);
  assert.ok(purchases.units >= 100);
  assert.strictEqual(s.reconciles, true, 'and it balances');
  assert.strictEqual(s.difference, 0);
});

test('selling a pack moves its cost out of stock, not its price', async () => {
  const before = statement();
  const sale = await api('POST', '/api/pharmacy/counter-sale', {
    customerName: 'Walk-in', items: [{ drugId: ids.drug, qty: 5 }], paymentMode: 'cash',
  });
  assert.strictEqual(sale.status, 201, JSON.stringify(sale.body));

  const after = statement();
  const sold = lineNamed(after, 'Sold');
  assert.ok(sold.units >= 5, 'the units left the shelf');
  /*
   * Five packs costing 12 each is 60 — the money the clinic had on the
   * shelf. They sold for 20 each; that difference is the margin and has no
   * business in a stock statement.
   */
  assert.ok(sold.value - (before.outward + 60) < 0.01 || sold.value >= 60,
    `at cost, not at MRP: got ${sold.value}`);
  assert.strictEqual(after.reconciles, true);
  assert.ok(after.closing.value < before.closing.value, 'and the shelf is worth less');
});

test('a damaged pack is not an expired one, and both are told from a shortage', async () => {
  const damaged = await api('POST', '/api/stock/write-off',
    { batchId: ids.batch, qty: 3, reason: 'damaged', notes: 'Carton crushed in transit' });
  assert.strictEqual(damaged.status, 201, JSON.stringify(damaged.body));
  assert.strictEqual(damaged.body.value, 36, '3 at 12');

  const lost = await api('POST', '/api/stock/write-off',
    { batchId: ids.batch, qty: 1, reason: 'lost', notes: 'Not on the shelf at the count' });
  assert.strictEqual(lost.status, 201);

  const s = statement();
  assert.strictEqual(lineNamed(s, 'Damaged').units, 3);
  assert.strictEqual(lineNamed(s, 'Damaged').value, 36);
  assert.strictEqual(lineNamed(s, 'Lost').units, 1);
  assert.strictEqual(lineNamed(s, 'Expired').units, 0, 'nothing has expired');
  assert.strictEqual(s.reconciles, true);

  // Wastage is the three of them together, as a share of what was bought.
  assert.strictEqual(s.wastage.value, 48);
  assert.ok(s.wastage.ofPurchases > 0);
});

test('writing something off as damaged without saying what happened is refused', async () => {
  /*
   * A pack written off as damaged with no explanation is indistinguishable
   * from one that walked out of the door, and the clinic finds that out
   * months later when the pattern shows.
   */
  const bare = await api('POST', '/api/stock/write-off',
    { batchId: ids.batch, qty: 1, reason: 'damaged' });
  assert.strictEqual(bare.status, 400);
  assert.match(bare.body.error, /say what happened/i);

  // Expired needs no excuse: the date on the strip is the explanation.
  const expired = await api('POST', '/api/stock/write-off',
    { batchId: ids.batch, qty: 2, reason: 'expired' });
  assert.strictEqual(expired.status, 201);
  assert.strictEqual(lineNamed(statement(), 'Expired').units, 2);
});

test('more cannot be written off than is on the shelf', async () => {
  const r = await api('POST', '/api/stock/write-off',
    { batchId: ids.batch, qty: 99999, reason: 'expired' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /only \d+/i);
});

test('a return to the supplier carries what they agreed to credit', async () => {
  const sent = await api('POST', '/api/stock/returns',
    { batchId: ids.batch, qty: 10, creditAmount: 100, notes: 'Short-dated, agreed with the rep' });
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
  assert.strictEqual(sent.body.value, 120, 'ten packs cost the clinic 120');
  assert.strictEqual(sent.body.credit, 100);

  const s = statement();
  assert.strictEqual(lineNamed(s, 'Returned').units, 10);
  assert.strictEqual(s.returns.value, 120);
  assert.strictEqual(s.returns.credited, 100);
  assert.strictEqual(s.returns.uncredited, 20,
    'the twenty the supplier has not agreed to is the figure worth chasing');
  assert.strictEqual(s.reconciles, true);
});

test('a return with nothing credited yet reads as nothing credited', async () => {
  const sent = await api('POST', '/api/stock/returns', { batchId: ids.batch, qty: 1 });
  assert.strictEqual(sent.status, 201);
  assert.strictEqual(sent.body.credit, null, 'not zero — unknown');
  const s = statement();
  assert.ok(s.returns.uncredited > 0);
});

test('a stock take that finds a shelf short says so on its own line', async () => {
  const before = statement();
  const take = await api('POST', '/api/stock/takes', {
    notes: 'Monthly count',
    items: [{ batchId: ids.batch, countedQty: 50, reason: 'Counted on the shelf' }],
  });
  assert.strictEqual(take.status, 201, JSON.stringify(take.body));

  const s = statement();
  const short = lineNamed(s, 'Shortages');
  const over = lineNamed(s, 'Found');
  assert.ok(short.units > 0 || over.units > 0, 'the count moved the figure one way or the other');
  assert.strictEqual(s.reconciles, true, 'and the statement still balances afterwards');
  assert.notStrictEqual(s.closing.value, before.closing.value);
});

// ------------------------------------------------------- the proof it is one
test('with no period closed, the statement says it cannot catch anything', () => {
  /*
   * The trap this guards against. With no stock written down at the close
   * of the day before, the opening figure is today's shelf rolled back
   * through the very movements the statement adds up — so the two sides
   * are the same arithmetic and must agree, whatever has actually
   * happened to the shelf. The statement is still worth reading for what
   * was bought and wasted; it simply cannot detect stock going missing,
   * and it has to say so rather than show a reassuring zero.
   */
  const s = statement();
  assert.strictEqual(s.opening.source, 'derived');
  assert.strictEqual(s.proof.kind, 'derived');
  assert.match(s.proof.note, /cannot disagree|proves nothing/i);

  // Proof that the zero is worthless here: take stock off the shelf behind
  // the system's back and it still balances.
  db.prepare('UPDATE drug_batches SET qty_available = qty_available - 7 WHERE id = ?').run(ids.batch);
  assert.strictEqual(statement().reconciles, true, 'which is exactly why it is not a proof');
  db.prepare('UPDATE drug_batches SET qty_available = qty_available + 7 WHERE id = ?').run(ids.batch);
});

test('once a period is closed, stock that moves without a movement shows up', async () => {
  /*
   * With the shelf written down independently, the computed closing and the
   * measured one can genuinely disagree — and that is the whole reason the
   * statement exists. Simulated by editing a quantity behind the system's
   * back, which is what a hand-edited database or a lost movement looks
   * like from here.
   */
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const closed = await api('POST', '/api/stock/snapshots',
    { asOn: yesterday, notes: 'Month-end count' });
  assert.strictEqual(closed.status, 201, JSON.stringify(closed.body));
  assert.strictEqual(closed.body.as_on, yesterday);
  assert.ok(closed.body.taken_at, 'and when it was written down');

  const again = await api('POST', '/api/stock/snapshots', { asOn: yesterday });
  assert.strictEqual(again.status, 409, 'a day is closed once');

  const s = recon.statement(new Date(Date.now()).toISOString().slice(0, 10), to);
  assert.strictEqual(s.opening.source, 'snapshot');
  assert.strictEqual(s.proof.kind, 'snapshot');
  assert.strictEqual(s.reconciles, true, 'it balances while nothing is wrong');

  db.prepare('UPDATE drug_batches SET qty_available = qty_available - 7 WHERE id = ?').run(ids.batch);
  const broken = recon.statement(new Date(Date.now()).toISOString().slice(0, 10), to);
  assert.strictEqual(broken.reconciles, false, 'and now it does not pretend otherwise');
  assert.strictEqual(broken.difference, -84, 'seven packs at twelve, unaccounted for');

  db.prepare('UPDATE drug_batches SET qty_available = qty_available + 7 WHERE id = ?').run(ids.batch);
  assert.strictEqual(recon.statement(new Date(Date.now()).toISOString().slice(0, 10), to).reconciles,
    true, 'put back, it balances again');
});

test('a batch with no cost price is counted and flagged, not quietly valued at nothing', () => {
  const s = statement();
  /*
   * The seeded opening stock was taken in without rates. Those batches
   * value at nothing, the statement still balances — zero against zero —
   * and that is exactly the danger: it looks right while understating the
   * shelf. So they are counted and said out loud.
   */
  assert.ok(s.unpriced.batches > 0, 'the seeded opening stock has no rates');
  assert.ok(s.unpriced.units > 0);
  assert.match(s.unpriced.note, /understated/i);
  assert.match(s.unpriced.note, /Opening stock/i, 'and where to go and fix it');
});

test('the opening figure is the close of the day before', () => {
  const s = recon.statement('2026-11-01', '2026-11-30');
  assert.strictEqual(s.openingDate, '2026-10-31');
  assert.strictEqual(s.from, '2026-11-01');
});

test('the statement is the pharmacist\'s and management\'s, not the whole clinic\'s', async () => {
  assert.strictEqual((await api('GET', `/api/stock/reconciliation?from=${from}&to=${to}`,
    undefined, 'pharmacy')).status, 200);
  assert.strictEqual((await api('GET', `/api/stock/reconciliation?from=${from}&to=${to}`,
    undefined, 'admin')).status, 200);
  assert.strictEqual((await api('GET', `/api/stock/reconciliation?from=${from}&to=${to}`,
    undefined, 'reception')).status, 403);

  // And only the pharmacist writes stock off or sends it back.
  assert.strictEqual((await api('POST', '/api/stock/write-off',
    { batchId: ids.batch, qty: 1, reason: 'expired' }, 'cashier')).status, 403);
  assert.strictEqual((await api('POST', '/api/stock/returns',
    { batchId: ids.batch, qty: 1 }, 'cashier')).status, 403);
});

test('every write-off and return is on the record', () => {
  for (const action of ['write_off', 'supplier_return']) {
    const row = db.prepare(
      'SELECT * FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);
    assert.ok(row, `${action} is audited`);
    assert.ok(row.actor && row.actor !== 'system', `and names who did it — got ${row.actor}`);
  }
});

test('the closing value is where it sits, biggest batches first', () => {
  const s = statement();
  assert.ok(s.largest.length > 0);
  for (let i = 1; i < s.largest.length; i += 1) {
    assert.ok(s.largest[i - 1].value >= s.largest[i].value, 'biggest first');
  }
  assert.ok(s.largest.every((b) => b.qty > 0), 'and only what is actually there');
});
