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

test('the screen says how big the artwork is, and when it is too small', async () => {
  // The one-pixel PNG from above is as small as it gets.
  await admin.post('/api/masters/branding/mark',
    { data: PNG.toString('base64'), mime: 'image/png', filename: 'tiny.png' });
  const tiny = (await admin.get('/api/masters/branding')).slots.find((x) => x.slot === 'mark');
  assert.equal(tiny.width, 1, 'read from the file header, with no image library');
  assert.equal(tiny.height, 1);
  assert.equal(tiny.soft, true, 'and called out as too small to print well');

  // A vector has no pixels to run out of.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    + '<circle cx="32" cy="32" r="30" fill="#14663F"/></svg>';
  await admin.post('/api/masters/branding/mark',
    { data: Buffer.from(svg).toString('base64'), mime: 'image/svg+xml', filename: 'akr.svg' });
  const vector = (await admin.get('/api/masters/branding')).slots.find((x) => x.slot === 'mark');
  assert.equal(vector.vector, true);
  assert.equal(vector.soft, false, 'a drawing is sharp at every size');
  assert.equal(vector.mime, 'image/svg+xml');

  // And it is served as the vector it is, not converted to anything.
  const res = await fetch(`${h.base}/api/branding/mark`);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.match(await res.text(), /<circle/);
});

test('the placeholder is type, not somebody else\'s bird', () => {
  /*
   * This file used to be a drawing of the company's own mark, which is the one
   * thing a system must never put on an invoice: an approximation of a logo,
   * printed as though it were the logo. It is now plainly a stand-in.
   */
  for (const name of ['logo-icon.svg', 'logo.svg', 'favicon.svg']) {
    const svg = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', name), 'utf8');
    assert.match(svg, /LOGO NOT SET/, `${name} says it is a placeholder`);
    assert.ok(!/plume|feather|beak|bird/i.test(svg), `${name} draws nobody's mark`);
    assert.ok(!/<path/i.test(svg), `${name} is type and boxes, not artwork`);
  }
});

test('the screen warns when an upload would not survive a deploy', async () => {
  const data = await admin.get('/api/masters/branding');
  assert.equal(typeof data.ephemeral, 'boolean');
  // In this test run there is a data directory, so nothing is at risk.
  assert.equal(data.ephemeral, false);

  const health = await fetch(`${h.base}/api/health`).then((r) => r.json());
  assert.ok(['volume', 'local', 'ephemeral'].includes(health.uploads),
    'and the health check says where uploads are kept');
});

test('the artwork can be taken from the company\'s own website', async () => {
  /*
   * The logo is already on akr365.com. The server fetches it — the server,
   * because it is the one with a plain route to the internet — and checks the
   * bytes before keeping anything. A little site is stood up here to be that
   * website, so the test proves the fetch rather than the internet.
   */
  const http = require('http');
  const site = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><head>
        <meta property="og:image" content="/img/akr-logo.png">
        </head><body><h1>AKR General Trading</h1></body></html>`);
    }
    if (req.url === '/img/akr-logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    if (req.url === '/not-a-logo.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('this is not a picture');
    }
    res.writeHead(404); res.end('no');
  });
  await new Promise((r) => site.listen(0, r));
  const origin = `http://127.0.0.1:${site.address().port}`;

  try {
    // The address of the site: the logo it declares for itself is found.
    const fromSite = await admin.post('/api/masters/branding/mark/from-url', { url: origin + '/' });
    assert.match(fromSite.taken_from, /\/img\/akr-logo\.png$/, 'found through the page');
    assert.equal(fromSite.mime, 'image/png');
    const served = await fetch(`${h.base}/api/branding/mark`);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG, 'and kept byte for byte');

    // The address of the picture itself: taken as it stands.
    const direct = await admin.post('/api/masters/branding/full/from-url',
      { url: `${origin}/img/akr-logo.png` });
    assert.equal(direct.slot, 'full');

    // Anything that is not a picture is refused, whatever it is served as.
    await assert.rejects(
      () => admin.post('/api/masters/branding/mark/from-url', { url: `${origin}/not-a-logo.txt` }),
      (err) => err.status === 400);
    await assert.rejects(
      () => admin.post('/api/masters/branding/mark/from-url', { url: `${origin}/missing.png` }),
      (err) => err.status === 400 && /404/.test(err.message));
    await assert.rejects(
      () => admin.post('/api/masters/branding/mark/from-url', { url: 'file:///etc/passwd' }),
      (err) => err.status === 400 && /http/.test(err.message),
      'and only the web, not the filesystem');
  } finally {
    site.close();
  }
});

test('a page that declares no logo says so plainly', async () => {
  const http = require('http');
  const bare = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body>Nothing here</body></html>');
  });
  await new Promise((r) => bare.listen(0, r));
  try {
    await assert.rejects(
      () => admin.post('/api/masters/branding/mark/from-url',
        { url: `http://127.0.0.1:${bare.address().port}/` }),
      (err) => err.status === 400 && /No logo could be found/.test(err.message));
  } finally {
    bare.close();
  }
});
