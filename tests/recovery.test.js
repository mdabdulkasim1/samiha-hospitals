'use strict';
/**
 * Account recovery and backups: the forgot-password flow, its guardrails, and
 * the snapshot/retention behaviour.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-rec-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.BACKUP_DIR = path.join(dir, 'backups');
process.env.BACKUP_RETENTION = '3';
process.env.BACKUP_HOUR = '';           // no scheduled snapshots during tests
process.env.SESSION_SECRET = 'test-secret';
process.env.MAIL_PROVIDER = 'mock';
process.env.APP_URL = 'https://clinic.example';

require('../src/db/seed');
const app = require('../src/server');
const config = require('../src/config');

let server;
let base;
const tokens = {};

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

const login = async (username, password) =>
  api('POST', '/api/auth/login', { username, password }, null);

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [as, email] of [['admin', 'admin@samiha.local'], ['nurse', 'nurse@samiha.local']]) {
    const r = await login(email, 'samiha@123');
    assert.strictEqual(r.status, 200, `login failed for ${email}`);
    tokens[as] = r.body.token;
  }
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the recovery mailbox is the configured clinic address', () => {
  assert.strictEqual(config.mail.recoveryEmail, 'samihahospital@gmail.com');
});

test('forgot-password answers identically for real and unknown accounts', async () => {
  const real = await api('POST', '/api/auth/forgot-password', { username: 'cashier@samiha.local' }, null);
  const fake = await api('POST', '/api/auth/forgot-password', { username: 'nobody@nowhere.test' }, null);

  assert.strictEqual(real.status, 200);
  assert.strictEqual(fake.status, 200);
  // The wording must not betray whether the account exists.
  assert.strictEqual(real.body.message, fake.body.message);
  assert.match(real.body.message, /samihahospital@gmail\.com/);

  // Only the real request actually mints a link.
  assert.ok(real.body.devLink, 'offline mode surfaces the link to the administrator');
  assert.ok(!fake.body.devLink);
  assert.match(real.body.devLink, /^https:\/\/clinic\.example\/#\/reset\?token=/);
});

test('a reset link changes the password, once, and signs other sessions out', async () => {
  // A second session that must be killed by the reset.
  const other = await login('pharmacy@samiha.local', 'samiha@123');
  assert.strictEqual(other.status, 200);
  const otherToken = other.body.token;

  const req = await api('POST', '/api/auth/forgot-password', { username: 'pharmacy@samiha.local' }, null);
  const token = new URL(req.body.devLink).hash.split('token=')[1];

  // The screen can check the link before asking for a password.
  const check = await api('GET', `/api/auth/reset-password/${token}`, undefined, null);
  assert.strictEqual(check.status, 200);
  assert.strictEqual(check.body.valid, true);
  assert.match(check.body.email, /^ph•+@samiha\.local$/,
    'the address is masked to first two characters, not published in full');

  // Weak passwords are refused, with the reason.
  const weak = await api('POST', '/api/auth/reset-password', { token, newPassword: 'abc' }, null);
  assert.strictEqual(weak.status, 400);
  assert.match(weak.body.error, /at least 8 characters/);

  const common = await api('POST', '/api/auth/reset-password', { token, newPassword: 'password' }, null);
  assert.strictEqual(common.status, 400);
  assert.match(common.body.error, /commonly used/);

  // A good one is accepted.
  const done = await api('POST', '/api/auth/reset-password', { token, newPassword: 'Clinic2026x' }, null);
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));

  // The old password no longer works; the new one does.
  assert.strictEqual((await login('pharmacy@samiha.local', 'samiha@123')).status, 401);
  assert.strictEqual((await login('pharmacy@samiha.local', 'Clinic2026x')).status, 200);

  // The session opened before the reset is gone.
  const stale = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${otherToken}` } });
  assert.strictEqual(stale.status, 401);

  // The link cannot be replayed.
  const replay = await api('POST', '/api/auth/reset-password', { token, newPassword: 'Another2026x' }, null);
  assert.strictEqual(replay.status, 400);
  assert.match(replay.body.error, /expired or has already been used/);
});

test('requesting a new link invalidates the previous one', async () => {
  const first = await api('POST', '/api/auth/forgot-password', { username: 'lab@samiha.local' }, null);
  const firstToken = new URL(first.body.devLink).hash.split('token=')[1];

  const second = await api('POST', '/api/auth/forgot-password', { username: 'lab@samiha.local' }, null);
  const secondToken = new URL(second.body.devLink).hash.split('token=')[1];
  assert.notStrictEqual(firstToken, secondToken);

  assert.strictEqual((await api('GET', `/api/auth/reset-password/${firstToken}`, undefined, null)).status, 400);
  assert.strictEqual((await api('GET', `/api/auth/reset-password/${secondToken}`, undefined, null)).status, 200);
});

test('a garbage token is rejected', async () => {
  const r = await api('GET', '/api/auth/reset-password/not-a-real-token', undefined, null);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.valid, false);
});

test('repeated requests for the same account are throttled', async () => {
  let lastWithLink = 0;
  for (let i = 0; i < 8; i += 1) {
    const r = await api('POST', '/api/auth/forgot-password', { username: 'ward@samiha.local' }, null);
    assert.strictEqual(r.status, 200, 'throttling must stay silent, not error');
    if (r.body.devLink) lastWithLink = i + 1;
  }
  // The limit is 5 in the window; later requests stop minting links.
  assert.ok(lastWithLink <= 5, `expected throttling after 5 requests, saw links up to ${lastWithLink}`);
});

test('changing a password enforces the rules and signs other sessions out', async () => {
  const first = await login('counselor@samiha.local', 'samiha@123');
  const second = await login('counselor@samiha.local', 'samiha@123');
  tokens.counselor = second.body.token;

  const weak = await api('POST', '/api/auth/change-password',
    { currentPassword: 'samiha@123', newPassword: '1234567890' }, 'counselor');
  assert.strictEqual(weak.status, 400);
  assert.match(weak.body.error, /contain a letter|only numbers/);

  const wrongCurrent = await api('POST', '/api/auth/change-password',
    { currentPassword: 'not-it', newPassword: 'Counsel2026x' }, 'counselor');
  assert.strictEqual(wrongCurrent.status, 400);

  const ok = await api('POST', '/api/auth/change-password',
    { currentPassword: 'samiha@123', newPassword: 'Counsel2026x' }, 'counselor');
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));

  // The session that made the change survives; the other does not.
  assert.strictEqual((await api('GET', '/api/auth/me', undefined, 'counselor')).status, 200);
  const stale = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${first.body.token}` } });
  assert.strictEqual(stale.status, 401);
});

test('backups snapshot the database, prune to the retention limit and stay admin-only', async () => {
  const denied = await api('POST', '/api/admin/backups', {}, 'nurse');
  assert.strictEqual(denied.status, 403);

  const made = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await api('POST', '/api/admin/backups', {}, 'admin');
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.sizeMb > 0, 'a snapshot should not be empty');
    assert.ok(fs.existsSync(r.body.path), 'the file should exist on disk');
    made.push(r.body.filename);
    await new Promise((res) => setTimeout(res, 1100));  // distinct second-resolution names
  }

  const list = await api('GET', '/api/admin/backups', undefined, 'admin');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.rows.length, 3, 'retention of 3 should have pruned the rest');

  // The oldest files are the ones gone.
  const kept = list.body.rows.map((r) => r.filename);
  assert.deepStrictEqual(kept, made.slice(-3).reverse());
  for (const gone of made.slice(0, 2)) {
    assert.ok(!fs.existsSync(path.join(process.env.BACKUP_DIR, gone)), `${gone} should have been pruned`);
  }

  // A snapshot is a real, openable database.
  const Database = require('better-sqlite3');
  const snap = new Database(path.join(process.env.BACKUP_DIR, kept[0]), { readonly: true });
  assert.ok(snap.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0);
  snap.close();
});

test('a backup filename cannot escape the backup directory', async () => {
  const res = await fetch(`${base}/api/admin/backups/${encodeURIComponent('../../package.json')}/download`, {
    headers: { Authorization: `Bearer ${tokens.admin}` },
  });
  assert.strictEqual(res.status, 404);
});

test('the system panel reports where recovery and backups point', async () => {
  const s = await api('GET', '/api/admin/system', undefined, 'admin');
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.body.recoveryEmail, 'samihahospital@gmail.com');
  assert.strictEqual(s.body.mail.provider, 'mock');
  assert.strictEqual(s.body.mail.health.ok, true);
  assert.ok(s.body.backup.last, 'the last successful backup is reported');
  assert.ok(s.body.counts.users > 0);

  const denied = await api('GET', '/api/admin/system', undefined, 'nurse');
  assert.strictEqual(denied.status, 403);
});

test('an administrator can send a staff member a reset link', async () => {
  const staff = (await api('GET', '/api/masters/staff?role=doctor', undefined, 'admin')).body;
  const doctor = staff.find((d) => d.email === 'imran@samiha.local');

  const r = await api('POST', `/api/admin/users/${doctor.id}/send-reset`, {}, 'admin');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.message, /samihahospital@gmail\.com/);
  assert.ok(r.body.devLink);

  const token = new URL(r.body.devLink).hash.split('token=')[1];
  const done = await api('POST', '/api/auth/reset-password', { token, newPassword: 'Doctor2026x' }, null);
  assert.strictEqual(done.status, 200);
  assert.strictEqual((await login('imran@samiha.local', 'Doctor2026x')).status, 200);
});

test('every outbound recovery message is copied to the clinic mailbox', async () => {
  const outbox = (await api('GET', '/api/whatsapp/outbox', undefined, 'admin')).body;
  const emails = outbox.filter((n) => n.channel === 'email');
  assert.ok(emails.length > 0, 'recovery emails should be recorded');
  assert.ok(emails.every((n) => n.to_addr.includes('samihahospital@gmail.com')),
    'the recovery mailbox must be on every message');
});
