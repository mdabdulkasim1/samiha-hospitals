'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Run against a clean temp database
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-kiosk-test-')), 'test.db');
process.env.DB_ENGINE = 'sqlite';
process.env.DB_FILE = tmpDb;
process.env.SESSION_SECRET = 'test-secret';

// Seed starter data
require('../src/db/seed');
const { db } = require('../src/db');
const app = require('../src/server');

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch (_) {}
});

test('Kiosk API: GET /api/kiosk/queue returns structured token queue without authentication', async () => {
  const res = await fetch(`${base}/api/kiosk/queue`);
  assert.strictEqual(res.status, 200);

  const data = await res.json();
  assert.strictEqual(data.ok, true);
  assert.ok(data.clinic && data.clinic.name);
  assert.ok(Array.isArray(data.rooms));
  assert.ok(data.rooms.length > 0);

  const room = data.rooms[0];
  assert.ok(room.roomNo);
  assert.ok(room.doctorName);
  assert.ok(room.department);
  assert.ok('status' in room);
  assert.ok('totalWaiting' in room);
});

test('Kiosk UI: GET /kiosk and /tv serve the fullscreen 3x2 display page', async () => {
  const res1 = await fetch(`${base}/kiosk`);
  assert.strictEqual(res1.status, 200);
  const html1 = await res1.text();
  assert.ok(html1.includes('kiosk-grid'));
  assert.ok(html1.includes('Token Queue Display'));

  const res2 = await fetch(`${base}/tv`);
  assert.strictEqual(res2.status, 200);
  const html2 = await res2.text();
  assert.ok(html2.includes('kiosk-grid'));
});

test('Kiosk API: supports URL room filtering with ?rooms=...', async () => {
  const res = await fetch(`${base}/api/kiosk/queue?rooms=OPD-1`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.ok, true);
  assert.ok(data.rooms.every((r) => r.roomNo === 'OPD-1'));
});

