'use strict';
/**
 * Making a deploy reach the browser.
 *
 * The page loads a stylesheet and twenty-six scripts by plain path. Cached
 * for an hour with nothing in the URL to distinguish one release from the
 * next, a browser ends up holding whichever files it happened to have — an
 * old app.js beside a new account.js, in any combination. The halves
 * disagree and the clinic gets a screen with its sidebar and nothing else:
 * no error, no clue, and it clears itself an hour later, which is the worst
 * way for a fault to behave.
 *
 * The fix is that every asset URL carries a stamp taken from the contents of
 * those files, so there is no half-and-half state left to be in.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-assets-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
const app = require('../src/server');
const assets = require('../src/lib/assets');
const config = require('../src/config');

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const refs = (html) =>
  [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);

test('every script and stylesheet the page loads carries a stamp', async () => {
  const html = await (await fetch(base)).text();
  const code = refs(html).filter((u) => /\.(js|css)(\?|$)/.test(u));

  assert.ok(code.length >= 25, `the page loads the whole app, got ${code.length}`);
  for (const url of code) {
    assert.match(url, /\?v=[a-f0-9]{8,}$/, `${url} is not stamped`);
  }

  // One release, one stamp — so the set can only be fetched together.
  const stamps = new Set(code.map((u) => u.split('?v=')[1]));
  assert.strictEqual(stamps.size, 1, `one stamp for the build, got ${[...stamps].join(', ')}`);
});

test('anything that is not ours is left alone', async () => {
  const html = await (await fetch(base)).text();
  const favicon = refs(html).find((u) => u.includes('favicon'));
  assert.ok(favicon, 'the favicon is still referenced');
  assert.ok(!favicon.includes('?v='), 'an image nobody caches wrongly needs no stamp');
});

test('the stamp follows what is in the files', () => {
  const before = assets.computeStamp();
  const file = path.join(config.root, 'public', 'js', 'app.js');
  const original = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n// changed\n')]));
    assert.notStrictEqual(assets.computeStamp(), before,
      'a changed file must move every URL, or the browser keeps the old one');
  } finally {
    fs.writeFileSync(file, original);
  }
  assert.strictEqual(assets.computeStamp(), before,
    'and an unchanged build must keep the same URLs, or every deploy throws the cache away');
});

test('the page itself is never cached, or the new stamps never arrive', async () => {
  for (const at of ['/', '/index.html', '/#/account']) {
    const res = await fetch(base + at);
    assert.match(res.headers.get('cache-control') || '', /no-store/,
      `${at} must not be held by the browser`);
  }
});

test('a stamped asset is served, and told it may be kept', async () => {
  const html = await (await fetch(base)).text();
  const url = refs(html).find((u) => u.includes('/js/app.js'));
  assert.ok(url, 'app.js is on the page');

  const res = await fetch(base + url);
  assert.strictEqual(res.status, 200, 'the query string does not confuse the server');
  assert.match(res.headers.get('content-type') || '', /javascript/);
  assert.ok((await res.text()).length > 1000, 'and it is the real file');

  /*
   * In production it may be kept for a long time, safely, precisely because
   * the URL moves when the contents do. In development it must not be kept
   * at all, or editing a file would show nothing until the cache expired.
   */
  const cache = res.headers.get('cache-control') || '';
  if (config.isProd) assert.match(cache, /max-age=\d{6,}/, `expected a long cache, got "${cache}"`);
  else assert.match(cache, /max-age=0/, `expected no caching while developing, got "${cache}"`);
});

test('the unstamped path still works, for anything that asks for it', async () => {
  const res = await fetch(`${base}/js/app.js`);
  assert.strictEqual(res.status, 200, 'a bookmark or an old page must not 404');
});

test('in production the assets are cached hard', async () => {
  /*
   * The behaviour above is only worth having if production actually sets the
   * long cache, and the suite does not run in production — so the rule is
   * read from where it is written rather than inferred from a response.
   */
  const server = fs.readFileSync(path.join(config.root, 'src', 'server.js'), 'utf8');
  assert.match(server, /maxAge:\s*config\.isProd\s*\?\s*'365d'/,
    'a stamped URL may be kept for a year');
  assert.match(server, /index\.html.*no-store/s,
    'and the page carrying the stamps never may be');
});
