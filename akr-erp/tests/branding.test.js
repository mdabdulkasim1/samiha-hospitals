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

test('the bundled artwork is real, safe and says what it is', () => {
  /*
   * The company's mark ships in the source. A logo is not source code, and the
   * long way round would be an upload — but an upload needs a volume to survive
   * a deploy, and until there is one the ERP would go back to a blank plate
   * every release. So the mark is here, drawn, and every file says in its own
   * comment that it is a rendition to be replaced under Masters -> Logo.
   *
   * What must not be here: a placeholder that announces itself on a client's
   * copy of an invoice, and anything executable in artwork that goes on every
   * screen and every printed page.
   */
  for (const name of ['logo-icon.svg', 'logo.svg', 'favicon.svg']) {
    const svg = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', name), 'utf8');
    assert.ok(!/LOGO NOT SET/i.test(svg), `${name} does not announce a missing logo`);
    assert.match(svg, /<path/i, `${name} is artwork, not an apology`);
    assert.match(svg, /Masters -> Logo/, `${name} says how to replace it`);
    assert.ok(!/<script[\s>]/i.test(svg), `${name} carries no script`);
    assert.ok(!/\son\w+\s*=/i.test(svg), `${name} carries no event handler`);
  }

  // The lock-up carries the wordmark; the mark on its own does not.
  const full = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'logo.svg'), 'utf8');
  assert.match(full, /GENERAL TRADING LLC/);
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

test('every document is printed on a letterhead, uploaded or not', async () => {
  /*
   * A quotation goes to a client, so what goes on it has to be the mark or
   * nothing at all — never a box announcing that the logo has not been set.
   * With the artwork bundled there is always a mark to print, so the page is
   * told so whether or not anything has been uploaded; the Logo screen keeps
   * the separate question of whose file it is.
   */
  for (const slot of ['mark', 'full']) branding.clear(slot);
  const bare = await admin.get('/api/auth/me');
  assert.equal(bare.company.logoSet, true, 'there is always a mark to print');
  assert.equal(bare.company.logoUploaded, false, 'and it is the bundled one');
  // Fingerprinted, because the static file is cached for an hour in production
  // and a deploy that changes it must not be defeated by that cache.
  assert.match(bare.company.logo, /^\/assets\/logo-icon\.svg\?v=[0-9a-f]{10}$/);

  const printer = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'print.js'), 'utf8');
  assert.match(printer, /const watermark = \(\) => \(hasLogo\(\)/,
    'the watermark is only drawn when there is artwork to draw');
  assert.match(printer, /\$\{hasLogo\(\) \? `<div class="logo">/,
    'and so is the mark on the letterhead');

  await admin.post('/api/masters/branding/mark',
    { data: PNG.toString('base64'), mime: 'image/png', filename: 'akr.png' });
  const after = await admin.get('/api/auth/me');
  assert.equal(after.company.logoUploaded, true, 'the company\'s own file takes over');
  assert.match(after.company.logo, /^\/api\/branding\/mark\?v=/);
});

test('the health check says which build is running and what it shows', async () => {
  /*
   * "The logo is still not showing" has three causes that look identical from
   * a screenshot: the deploy has not landed, the browser is holding the old
   * file, or something uploaded is overriding the artwork in the build. This
   * endpoint separates them, from outside, without a sign-in.
   */
  for (const slot of ['mark', 'full']) branding.clear(slot);
  let health = await fetch(`${h.base}/api/health`).then((r) => r.json());
  assert.match(health.build, /^[0-9a-f]{10}$/, 'the build that is running');
  assert.equal(health.branding.mark, 'bundled');
  assert.match(health.branding.markUrl, /^\/assets\/logo-icon\.svg\?v=/);

  await admin.post('/api/masters/branding/mark',
    { data: PNG.toString('base64'), mime: 'image/png', filename: 'akr.png' });
  health = await fetch(`${h.base}/api/health`).then((r) => r.json());
  assert.equal(health.branding.mark, 'uploaded', 'and when an upload is overriding it');
  assert.match(health.branding.markUrl, /^\/api\/branding\/mark\?v=/);
});

test('an admin is told on screen when the books are not being kept', async () => {
  /*
   * This was a warning in the server's console, and nobody reads a container's
   * console. The context carries it now, and the shell paints it across the top
   * of every screen for the person who can act on it.
   */
  const me = await admin.get('/api/auth/me');
  assert.ok(['ephemeral', 'volume', 'local'].includes(me.storage));
  assert.notEqual(me.storage, 'ephemeral', 'in a test run the books are kept');

  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(shell, /APP\.storage === 'ephemeral' && APP\.user\.role === 'admin'/,
    'and the banner is shown to the one person who can mount a volume');
  assert.match(shell, /storage-warning/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  assert.match(css, /\.storage-warning \{/, 'and it is styled to be read, not skimmed past');
});

test('the logo can be given to the deployment, so a deploy cannot lose it', async (t) => {
  /*
   * With no volume mounted an upload lives inside the container the platform
   * rebuilds on every deploy — which is why the logo kept disappearing on the
   * live service. An environment variable is held by the platform, not by the
   * container, so it comes back on every start.
   */
  const config = require('../src/config');
  const original = { url: config.company.logoUrl, data: config.company.logoData };
  t.after(() => {
    config.company.logoUrl = original.url;
    config.company.logoData = original.data;
    for (const slot of ['mark', 'full']) branding.clear(slot);
  });

  // 1. plain SVG markup, pasted straight into the setting
  for (const slot of ['mark', 'full']) branding.clear(slot);
  config.company.logoData = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">'
    + '<rect width="8" height="8" fill="#12563C"/></svg>';
  config.company.logoUrl = '';
  let done = await branding.installFromEnv();
  assert.equal(done.source, 'COMPANY_LOGO_DATA');
  assert.equal(branding.source('mark'), 'environment');
  assert.equal(branding.find('mark').mime, 'image/svg+xml');
  assert.match((await admin.get('/api/auth/me')).company.logo, /^\/api\/branding\/mark\?v=/);

  // 2. the same thing as a data: URI, which is what a browser copies
  for (const slot of ['mark', 'full']) branding.clear(slot);
  config.company.logoData = `data:image/png;base64,${PNG.toString('base64')}`;
  done = await branding.installFromEnv();
  assert.equal(done.source, 'COMPANY_LOGO_DATA');
  assert.equal(branding.find('mark').mime, 'image/png');

  // 3. an upload by hand outranks it — a person's act beats a setting
  const already = await branding.installFromEnv();
  assert.ok(already.skipped, 'and it does not overwrite what is already there');

  // 4. rubbish in the setting is reported, not fatal — the books still open
  for (const slot of ['mark', 'full']) branding.clear(slot);
  config.company.logoData = Buffer.from('this is not a picture').toString('base64');
  const bad = await branding.installFromEnv();
  assert.ok(bad.error, 'it says what went wrong');
  assert.equal(branding.source('mark'), 'bundled', 'and falls back to the bundled mark');
  const health = await fetch(`${h.base}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.branding.mark, 'bundled');
});

test('changing the setting changes the logo, and a hand upload still wins', async (t) => {
  /*
   * The trap this closes: the first start writes the logo onto the volume, and
   * every later start finds a file already there and leaves it alone — so
   * correcting a wrong COMPANY_LOGO_URL does nothing, for ever, with no way to
   * tell why. A note beside the artwork records which setting put it there.
   */
  const config = require('../src/config');
  const original = { url: config.company.logoUrl, data: config.company.logoData };
  const svg = (colour) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">'
    + `<rect width="8" height="8" fill="${colour}"/></svg>`;
  const served = async () => (await fetch(`${h.base}/api/branding/mark`)).text();
  t.after(() => {
    config.company.logoUrl = original.url;
    config.company.logoData = original.data;
    for (const slot of ['mark', 'full']) branding.clear(slot);
  });

  for (const slot of ['mark', 'full']) branding.clear(slot);
  config.company.logoUrl = '';
  config.company.logoData = svg('#111111');
  await branding.installFromEnv();
  assert.match(await served(), /#111111/);
  assert.equal(branding.source('mark'), 'environment');

  // A restart with the setting unchanged does not re-fetch or re-write.
  const again = await branding.installFromEnv();
  assert.equal(again.skipped, 'already installed');
  assert.equal(branding.source('mark'), 'environment', 'and it still knows where it came from');

  // The setting is corrected: the new artwork must take over.
  config.company.logoData = svg('#222222');
  await branding.installFromEnv();
  assert.match(await served(), /#222222/, 'a changed setting is installed');

  // Somebody uploads by hand: that is a person's decision and outranks it.
  await admin.post('/api/masters/branding/mark',
    { data: Buffer.from(svg('#333333')).toString('base64'), mime: 'image/svg+xml', filename: 'a.svg' });
  assert.equal(branding.source('mark'), 'uploaded');
  config.company.logoData = svg('#444444');
  const held = await branding.installFromEnv();
  assert.equal(held.skipped, 'something was uploaded by hand');
  assert.match(await served(), /#333333/, 'the upload stands');

  // The setting is taken away entirely: so is what it put in.
  for (const slot of ['mark', 'full']) branding.clear(slot);
  config.company.logoData = svg('#555555');
  await branding.installFromEnv();
  assert.match(await served(), /#555555/);
  config.company.logoData = '';
  const gone = await branding.installFromEnv();
  assert.equal(gone.removed, true);
  assert.equal(branding.source('mark'), 'bundled', 'and the bundled mark comes back');
});

test('the app says which commit it is running', async () => {
  /*
   * Days were spent on a deployment that had not picked up any of the work
   * pushed for it, with nobody able to tell from the outside: the screens
   * looked the same, so the code was assumed to be the same. The platform
   * hands the container the commit it built, so the application says so —
   * under the person's name in the sidebar, and on the health check.
   */
  const config = require('../src/config');
  const health = await fetch(`${h.base}/api/health`).then((r) => r.json());
  assert.ok('release' in health, 'the health check reports the commit');
  assert.equal(health.release, config.release);

  const me = await admin.get('/api/auth/me');
  assert.equal(me.release, config.release, 'and every signed-in screen is told');

  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(shell, /APP\.release/, 'and the sidebar shows it');

  // Where the platform says nothing, nothing is claimed.
  assert.ok(config.release === null || /^[0-9a-f]{7}$/.test(config.release));
});

test('the version is readable without signing in', async () => {
  /*
   * Which version is live turned out to be the hardest question to answer about
   * this system: a stale deployment looks exactly like a current one. Answering
   * it should not need a password, or a laptop — it is in the corner of the
   * sign-in page, and on the open endpoint that page reads.
   */
  const config = require('../src/config');
  const look = await fetch(`${h.base}/api/auth/look`).then((r) => r.json());
  assert.ok('release' in look, 'the sign-in page is told');
  assert.equal(look.release, config.release);

  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /class="build-badge"/, 'and it puts it on the page');
});
