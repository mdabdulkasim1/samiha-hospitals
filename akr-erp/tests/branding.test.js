'use strict';
/*
 * The company's own mark.
 *
 * It is uploaded rather than committed — hand-drawing an approximation of
 * somebody's logo and shipping it is how the wrong bird ends up on every
 * invoice. What these hold is that one upload is enough: the badge on its own
 * stands in for the lock-up and the other way about, so the sidebar, the
 * sign-in page, every printed document, the watermark and the browser tab all
 * show the same artwork.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { freshEnv, start } = require('./helpers');

const dir = freshEnv('branding');
process.env.DATA_DIR = dir;
require('../src/db/seed');

const branding = require('../src/services/branding');
const { shellHtml } = require('../src/lib/shell');

// A real one-pixel PNG: the magic bytes matter, so it cannot be a fake string.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

let h;
let admin;

test.before(async () => {
  h = await start();
  admin = await h.signIn('admin@akr365.com');
  for (const slot of ['mark', 'full']) branding.clear(slot);
});

test.after(async () => {
  for (const slot of ['mark', 'full']) branding.clear(slot);
  if (h) await h.stop();
});

test('with nothing uploaded, the bundled file is served rather than a 404', async () => {
  for (const slot of ['mark', 'full']) {
    const res = await fetch(`${h.base}/api/branding/${slot}`, { redirect: 'manual' });
    assert.equal(res.status, 302, `${slot} points somewhere real`);
    assert.match(res.headers.get('location'), /^\/assets\//);
  }
});

test('one upload covers both slots', async () => {
  await admin.post('/api/masters/branding/mark',
    { data: PNG.toString('base64'), mime: 'image/png', filename: 'akr.png' });

  assert.match(branding.urlFor('mark'), /^\/api\/branding\/mark\?v=/,
    'the badge is the badge');
  assert.match(branding.urlFor('full'), /^\/api\/branding\/mark\?v=/,
    'and it stands in for the lock-up the sign-in page asks for');

  const res = await fetch(`${h.base}/api/branding/full`);
  assert.equal(res.status, 200, 'which is served, not refused');
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG, 'byte for byte what was uploaded');
});

test('the browser tab takes the same mark', async () => {
  const html = shellHtml(path.join(__dirname, '..', 'public'));
  assert.match(html, /<link rel="icon" href="\/api\/branding\/mark\?v=[0-9a-f]+" type="image\/png">/,
    'the tab icon is the company mark, not the bundled drawing');
});

test('replacing it changes every URL at once', async () => {
  const before = branding.urlFor('mark');
  const OTHER = Buffer.concat([PNG, Buffer.from([0])]);
  await admin.post('/api/masters/branding/mark',
    { data: OTHER.toString('base64'), mime: 'image/png', filename: 'akr-2.png' });
  assert.notEqual(branding.urlFor('mark'), before,
    'a new fingerprint, so nobody is served last week’s logo');
  assert.equal(branding.urlFor('full'), branding.urlFor('mark'));
});

test('what is uploaded has to be an image', async () => {
  await assert.rejects(
    () => admin.post('/api/masters/branding/mark',
      { data: Buffer.from('<?php echo "not a logo"; ?>').toString('base64'), mime: 'image/png' }),
    (err) => err.status === 400);
});

test('artwork that carries its own background says so, once', async () => {
  // The default suits a transparent PNG: a light plate, or it vanishes into a
  // dark sidebar.
  const before = await admin.get('/api/masters/branding');
  assert.equal(before.settings.plate, true);
  assert.equal((await admin.get('/api/auth/me')).company.logoPlate, true);
  assert.equal((await fetch(`${h.base}/api/auth/look`).then((r) => r.json())).logoPlate, true,
    'and the sign-in page can ask before anybody has signed in');

  const after = await admin.patch('/api/masters/branding', { plate: false });
  assert.equal(after.settings.plate, false);
  assert.equal((await admin.get('/api/auth/me')).company.logoPlate, false,
    'every screen follows from the session');
  assert.equal((await fetch(`${h.base}/api/auth/look`).then((r) => r.json())).logoPlate, false);

  await admin.patch('/api/masters/branding', { plate: true });
});

test('the artwork is never stretched to fit', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const brandMark = css.match(/\.brand \.mark img \{[^}]+\}/)[0];
  assert.match(brandMark, /object-fit: contain/, 'the sidebar contains it');
  assert.ok(!/\bwidth: 100%; height: 100%/.test(brandMark),
    'rather than squashing it into a square');
  assert.match(css.match(/\.login-hero \.logo-full \{[^}]+\}/)[0], /object-fit: contain/);

  const printer = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'print.js'), 'utf8');
  assert.match(printer.match(/\.head \.logo img \{[^}]+\}/)[0], /object-fit: contain/,
    'and so does the letterhead');
});
