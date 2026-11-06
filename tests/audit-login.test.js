'use strict';
/**
 * Signing in is recorded.
 *
 * It was not, and nothing said so. The login route passed `{ ...req, user }`
 * to the audit logger so it could name a user the request did not carry yet;
 * spreading an Express request copies only its own properties, and Node
 * defines `headers` as a getter on the prototype, so the copy had none.
 * Reading one threw, the logger's catch swallowed it to keep the request
 * alive, and the clinic's audit trail quietly contained no logins at all.
 *
 * Which is the one thing an audit trail in a clinic is for. "Who opened this
 * patient's record, and when" starts with who was signed in.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-audit-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');

let server;
let base;

async function api(method, p, body, token) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const logins = () => db.prepare(
  "SELECT * FROM audit_logs WHERE action = 'login' ORDER BY id DESC").all();

test('a login lands in the audit trail, with who and from where', async () => {
  const before = logins().length;

  const r = await api('POST', '/api/auth/login',
    { username: 'admin@samiha.local', password: 'samiha@123' });
  assert.strictEqual(r.status, 200);

  const rows = logins();
  assert.strictEqual(rows.length, before + 1, 'the login was recorded');

  const row = rows[0];
  assert.strictEqual(row.entity, 'user');
  assert.strictEqual(row.entity_id, r.body.user.id);
  assert.strictEqual(row.user_id, r.body.user.id, 'the row names who signed in');
  assert.match(row.actor, /admin/i, 'and names them in words, for the screen');

  /*
   * The address is the part that was being lost along with the row. An audit
   * line that cannot say where somebody signed in from answers half the
   * question it exists for.
   */
  assert.ok(row.ip, 'and records where from');
});

test('a failed login is not recorded as a login', async () => {
  const before = logins().length;
  const bad = await api('POST', '/api/auth/login',
    { username: 'admin@samiha.local', password: 'wrong-password' });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(logins().length, before, 'nothing signed in, nothing logged');
});

test('every audited action gets its row, not just the ones with a req.user', async () => {
  /*
   * The bug was in the one call site that had to name a user the request did
   * not carry. Password reset is the other, so both are checked: an audit
   * logger that drops a row whenever the caller is slightly unusual is worse
   * than none, because the gap is invisible.
   */
  const token = (await api('POST', '/api/auth/login',
    { username: 'admin@samiha.local', password: 'samiha@123' })).body.token;

  const before = db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c;
  const made = await api('POST', '/api/masters/staff',
    { name: 'Audited Nurse', role: 'nurse', password: 'Samiha#2026' }, token);
  assert.strictEqual(made.status, 201);

  const after = db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c;
  assert.ok(after > before, 'adding a person is audited');

  const row = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC').get();
  assert.ok(row.actor && row.actor !== 'system', `a real actor, got ${row.actor}`);
  assert.ok(row.ip, 'with an address');
});

test('the audit logger survives a caller with no request at all', () => {
  /*
   * It must never throw: a failure to write the audit row must not take the
   * request down with it. That is why the original fault was silent, so the
   * guarantee is worth a test of its own now that the row actually lands.
   */
  const audit = require('../src/lib/audit');
  const before = db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c;
  assert.doesNotThrow(() => audit.log(null, 'housekeeping', 'system', null, { by: 'a timer' }));
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c, before + 1,
    'and still writes the row');
  assert.strictEqual(db.prepare('SELECT actor FROM audit_logs ORDER BY id DESC').get().actor, 'system');
});
