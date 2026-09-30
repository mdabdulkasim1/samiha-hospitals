'use strict';
/**
 * A way into the clinic that cannot be lost.
 *
 * Seeding runs once, on an empty database, and never again — which is right,
 * or a re-deploy would undo the clinic's own edits. But it means the accounts
 * a database was born with are the only ones it ever gets by itself, and a
 * database that outlives the install which made it can be left with no
 * password anybody remembers. That happened here the moment a volume was
 * attached: the database survived, so seeding never ran again, and the
 * accounts the clinic was expecting were never created.
 *
 * Losing the way in means losing the appointment book, the day's takings and
 * the patients' records. So ADMIN_EMAIL and ADMIN_PASSWORD are applied at
 * every startup, whatever the database already holds.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-access-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const { db } = require('../src/db');
const { verifyPassword } = require('../src/lib/auth');

// Loaded after the seed so the module picks up this database.
const server = require('../src/server');

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Re-run the startup step under a given environment. */
function boot({ email, password }) {
  const had = { e: process.env.ADMIN_EMAIL, p: process.env.ADMIN_PASSWORD };
  if (email === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = email;
  if (password === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = password;
  try { server.ensureAdministrator(); }
  finally {
    if (had.e === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = had.e;
    if (had.p === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = had.p;
  }
}

const adminRow = (email) =>
  db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(String(email).toLowerCase());

test('with neither variable set, nothing is touched', () => {
  const before = db.prepare('SELECT id, email, password_hash FROM users ORDER BY id').all();
  boot({});
  const after = db.prepare('SELECT id, email, password_hash FROM users ORDER BY id').all();
  assert.deepStrictEqual(after, before, 'a clinic that sets nothing keeps what it has');
});

test('one without the other does nothing either', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  boot({ email: 'half@clinic.example' });
  boot({ password: 'Half#Pass123' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, before);
  assert.ok(!adminRow('half@clinic.example'), 'an address with no password is not an account');
});

test('the password is applied to the administrator already on the database', () => {
  const existing = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  assert.ok(existing, 'the seeded administrator');

  boot({ email: existing.email, password: 'Known#Pass2026' });

  const after = adminRow(existing.email);
  assert.strictEqual(after.id, existing.id, 'the same account, not a second one');
  assert.ok(verifyPassword('Known#Pass2026', after.password_hash), 'and it is the chosen password');
});

test('changing it in the environment changes it here', () => {
  const email = db.prepare("SELECT email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get().email;
  boot({ email, password: 'Changed#Later7' });

  const after = adminRow(email);
  assert.ok(verifyPassword('Changed#Later7', after.password_hash), 'the new one works');
  assert.ok(!verifyPassword('Known#Pass2026', after.password_hash), 'and the old one does not');
});

test('a new address moves the administrator rather than making a second', () => {
  const admins = () => db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
  const before = admins();

  boot({ email: 'owner@samihapolyclinic.com', password: 'Owner#Pass2026' });

  assert.strictEqual(admins(), before, 'no extra administrator appears');
  const moved = adminRow('owner@samihapolyclinic.com');
  assert.ok(moved, 'the account is on the new address');
  assert.ok(verifyPassword('Owner#Pass2026', moved.password_hash));
});

test('on a database with no administrator at all, one is created', () => {
  // The case that locked the clinic out: a volume kept the database, seeding
  // never ran again, and nothing created the account they expected.
  db.prepare("UPDATE users SET role = 'reception' WHERE role = 'admin'").run();
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c, 0);

  boot({ email: 'rescue@samihapolyclinic.com', password: 'Rescue#Pass22' });

  const made = adminRow('rescue@samihapolyclinic.com');
  assert.ok(made, 'there is a way in again');
  assert.strictEqual(made.role, 'admin');
  assert.strictEqual(made.active, 1);
  assert.ok(verifyPassword('Rescue#Pass22', made.password_hash));
});

test('a disabled administrator is switched back on', () => {
  db.prepare("UPDATE users SET active = 0 WHERE email = 'rescue@samihapolyclinic.com'").run();
  boot({ email: 'rescue@samihapolyclinic.com', password: 'Rescue#Pass22' });
  assert.strictEqual(adminRow('rescue@samihapolyclinic.com').active, 1,
    'the clinic must not be able to switch off its own way in');
});
