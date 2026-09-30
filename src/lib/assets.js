'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

/**
 * Making a deploy reach the browser.
 *
 * The page loads a stylesheet and twenty-six scripts by plain path, and the
 * browser is told it may keep them for an hour. Nothing in those paths ever
 * changes, so after a release a browser holds whichever files it happened to
 * have — an old `app.js` beside a new `account.js`, in any combination. The
 * halves disagree, and what the clinic sees is a screen that renders its
 * sidebar and nothing else. No error, no clue, and it clears itself an hour
 * later, which is the worst way for a fault to behave.
 *
 * So every asset URL carries a stamp taken from what is actually in those
 * files. Change nothing and the stamp is the same and the browser reuses what
 * it has; change one line and every URL changes and the whole set is fetched
 * together. There is no half-and-half state left to be in.
 *
 * Taken from the contents rather than from a version number or the clock: a
 * number has to be remembered and a timestamp throws away a perfectly good
 * cache on every restart.
 */

const INDEX = path.join(config.root, 'public', 'index.html');
const ASSET_DIRS = [
  path.join(config.root, 'public', 'js'),
  path.join(config.root, 'public', 'css'),
];

/** Every .js and .css under the served directories, sorted so the hash is stable. */
function assetFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|css)$/.test(e.name)) out.push(full);
    }
  };
  for (const dir of ASSET_DIRS) walk(dir);
  return out;
}

function computeStamp() {
  const hash = crypto.createHash('sha256');
  for (const file of assetFiles()) {
    // The name as well as the body: renaming a file is a change too.
    hash.update(path.relative(config.root, file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * The page with every local script and stylesheet stamped. Anything with a
 * host in it is somebody else's and is left alone.
 */
function buildPage(stamp) {
  return fs.readFileSync(INDEX, 'utf8').replace(
    /(<(?:script|link)[^>]*\s(?:src|href)=")(\/[^"?#]+\.(?:js|css))(")/g,
    (_m, before, url, after) => `${before}${url}?v=${stamp}${after}`
  );
}

let cached = null;

/** The stamped page. Rebuilt per request in development so editing works. */
function page() {
  if (config.isProd && cached) return cached;
  const stamp = computeStamp();
  const html = buildPage(stamp);
  cached = html;
  return html;
}

/** The current stamp, for anything that wants to report the running build. */
function stamp() {
  return computeStamp();
}

module.exports = { page, stamp, computeStamp, buildPage };
