'use strict';
/*
 * What the browser is served.
 *
 * A key account manager was shown VAT & Profit in the menu and then refused it
 * by the server: their browser was still running a cached copy of the menu from
 * before that screen became the administrator's alone. The page that names the
 * scripts must therefore never be cached, and the scripts it names must change
 * URL when they change content.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { freshEnv, start } = require('./helpers');

freshEnv('shell');
require('../src/db/seed');

const { buildStamp } = require('../src/lib/shell');
const publicDir = path.join(__dirname, '..', 'public');

let h;

test.before(async () => { h = await start(); });
test.after(async () => { if (h) await h.stop(); });

test('the page is served fresh, with every script stamped', async () => {
  const res = await fetch(h.base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /no-store/,
    'the shell itself is never cached, or the stamps never arrive');

  const html = await res.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/(?:js|css)\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(assets.length > 10, 'the shell names the front end');
  for (const url of assets) {
    assert.match(url, /\?v=[0-9a-f]{10}$/, `${url} carries a build stamp`);
  }
  assert.ok(assets.some((u) => u.startsWith('/js/app.js?v=')), 'the menu itself among them');
});

test('a stamped script is still served', async () => {
  const stamped = (await (await fetch(h.base + '/')).text())
    .match(/\/js\/app\.js\?v=[0-9a-f]{10}/)[0];
  const res = await fetch(h.base + stamped);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /const NAV = \[/);
});

test('the stamp moves when the front end does', () => {
  const before = buildStamp(publicDir);
  const file = path.join(publicDir, 'js', 'app.js');
  const times = fs.statSync(file);
  try {
    fs.utimesSync(file, times.atime, new Date(times.mtime.getTime() + 60_000));
    assert.notEqual(buildStamp(publicDir), before, 'an edited file gives a new stamp');
  } finally {
    fs.utimesSync(file, times.atime, times.mtime);
  }
  assert.equal(buildStamp(publicDir), before, 'and an unchanged front end keeps its own');
});

test('the menu keeps VAT & Profit to the administrator, as the server does', () => {
  const nav = fs.readFileSync(path.join(publicDir, 'js', 'app.js'), 'utf8');
  const entry = nav.match(/\{ id: 'vat',[^}]*\}/);
  assert.ok(entry, 'the VAT & Profit menu entry exists');
  assert.match(entry[0], /roles: \['admin'\]/,
    'nobody but the administrator is offered a door the server will not open');
});
