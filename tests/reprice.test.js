'use strict';
/**
 * Bringing bills that are still owing onto the current rate card.
 *
 * The line this draws is between a bill that is still a question and one that
 * is already an answer. An unpaid bill can be repriced; a settled one is a
 * document the patient holds against money the clinic took, and rewriting it
 * would leave the invoice, the receipt and the day book disagreeing with each
 * other — under GST it is a credit note, not an edit.
 *
 * The other half is the concessions, which divide by who agreed them. The
 * clinic's own are held as a percentage and can be agreed again at the new
 * figures. An insurer's approval, or a rupee discount the counter shook hands
 * on, are somebody else's agreement about the bill as it stood, and those
 * bills are handed back rather than guessed at.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-reprice-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_HOUR = '';
process.env.SESSION_SECRET = 'test-secret';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');

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

/** A bill for one service, at whatever rate we say rather than the card's. */
async function billFor(name, unitPrice) {
  const patientId = (await api('POST', '/api/patients', {
    firstName: name, lastName: 'Reprice', phone: `984${String(Date.now()).slice(-7)}`,
    gender: 'male', age: 40, consentTreatment: true,
  }, 'reception')).body.id;
  const inv = (await api('POST', '/api/billing/invoices', { patientId, kind: 'opd' }, 'cashier')).body;
  await api('POST', `/api/billing/invoices/${inv.id}/items`, {
    refType: 'service', refId: ids.service.id, description: ids.service.name, qty: 1, unitPrice,
  }, 'cashier');
  return { patientId, invoiceId: inv.id };
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [
    ['admin', 'admin@samiha.local'], ['reception', 'reception@samiha.local'],
    ['cashier', 'cashier@samiha.local'],
  ]) {
    const r = await api('POST', '/api/auth/login', { username: email, password: 'samiha@123' }, null);
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
  ids.service = db.prepare("SELECT id, name, price FROM services WHERE code = 'PROC-NEB'").get();
  assert.ok(ids.service && ids.service.price > 0, 'the tariff prices nebulisation');
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an unpaid bill at an old rate is brought onto the card', async () => {
  const { invoiceId } = await billFor('Owing', 500);

  const plan = await api('GET', '/api/billing/tariff/repricing', undefined, 'admin');
  assert.strictEqual(plan.status, 200, JSON.stringify(plan.body));
  const mine = plan.body.invoices.find((i) => i.id === invoiceId);
  assert.ok(mine, 'the bill is offered for repricing');
  assert.strictEqual(mine.lines[0].was, 500);
  assert.strictEqual(mine.lines[0].now, ids.service.price);
  assert.strictEqual(mine.newNet, ids.service.price);

  // The preview changed nothing: it is a rehearsal that is thrown away.
  assert.strictEqual(db.prepare('SELECT net FROM invoices WHERE id = ?').get(invoiceId).net, 500);

  const done = await api('POST', '/api/billing/tariff/reprice', {}, 'admin');
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  assert.strictEqual(db.prepare('SELECT net FROM invoices WHERE id = ?').get(invoiceId).net, ids.service.price);

  // And it is idempotent: nothing is left to do.
  const after = (await api('GET', '/api/billing/tariff/repricing', undefined, 'admin')).body;
  assert.ok(!after.invoices.some((i) => i.id === invoiceId));
});

test('a settled bill is never offered, and never touched', async () => {
  const { invoiceId } = await billFor('Settled', 500);
  await api('POST', `/api/billing/invoices/${invoiceId}/payments`, { amount: 500, mode: 'cash' }, 'cashier');

  const plan = (await api('GET', '/api/billing/tariff/repricing', undefined, 'admin')).body;
  assert.ok(!plan.invoices.some((i) => i.id === invoiceId), 'not offered');
  assert.ok(!plan.skipped.some((i) => i.id === invoiceId), 'not even mentioned — it is finished');

  await api('POST', '/api/billing/tariff/reprice', {}, 'admin');
  const after = db.prepare('SELECT net, paid, balance FROM invoices WHERE id = ?').get(invoiceId);
  assert.strictEqual(after.net, 500, 'the invoice still says what the patient was charged');
  assert.strictEqual(after.paid, 500, 'and what they handed over');
  assert.strictEqual(after.balance, 0);
});

test('a rupee discount the counter agreed is handed back, not recomputed', async () => {
  const { invoiceId } = await billFor('Handshake', 500);
  await api('POST', `/api/billing/invoices/${invoiceId}/bill-discount`, { amount: 100 }, 'cashier');

  const plan = (await api('GET', '/api/billing/tariff/repricing', undefined, 'admin')).body;
  const skipped = plan.skipped.find((i) => i.id === invoiceId);
  assert.ok(skipped, 'it is raised rather than quietly repriced');
  assert.match(skipped.reason, /agreed a rupee discount/i);

  await api('POST', '/api/billing/tariff/reprice', {}, 'admin');
  assert.strictEqual(db.prepare('SELECT net FROM invoices WHERE id = ?').get(invoiceId).net, 400,
    'left exactly as the counter agreed it');
});

test('repricing is the administrator\'s, not the counter\'s', async () => {
  for (const as of ['cashier', 'reception']) {
    assert.strictEqual((await api('GET', '/api/billing/tariff/repricing', undefined, as)).status, 403);
    assert.strictEqual((await api('POST', '/api/billing/tariff/reprice', {}, as)).status, 403);
  }
});
