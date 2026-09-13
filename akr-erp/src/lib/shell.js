'use strict';
/*
 * The single page that loads everything else.
 *
 * A browser that has cached yesterday's app.js against today's server shows
 * yesterday's menu — which is how a key account manager came to be offered a
 * screen the server then refused them. So the shell is never cached, and every
 * script and stylesheet it names carries a build stamp: change a file, the URL
 * changes, and the browser fetches it instead of guessing.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ASSET = /(src|href)="(\/(?:js|css)\/[^"?#]+)"/g;

/** A stamp that changes whenever any front-end file does. */
function buildStamp(publicDir) {
  const hash = crypto.createHash('sha1');
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const stat = fs.statSync(full);
      hash.update(`${full}:${stat.size}:${stat.mtimeMs}\n`);
    }
  };
  walk(path.join(publicDir, 'js'));
  walk(path.join(publicDir, 'css'));
  walk(path.join(publicDir, 'assets'));
  return hash.digest('hex').slice(0, 10);
}

/**
 * Reads index.html once, stamps every local asset URL it names, and points the
 * browser-tab icon at the company's own mark where one has been uploaded — so
 * one upload covers the tab as well as the sidebar and the documents.
 */
function shellHtml(publicDir) {
  const stamp = buildStamp(publicDir);
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    .replace(ASSET, (_m, attr, url) => `${attr}="${url}?v=${stamp}"`);

  const branding = require('../services/branding');
  const mark = branding.resolve('mark');
  // The tab icon follows the same rule as everything else: the uploaded mark
  // where there is one, and otherwise the bundled favicon — fingerprinted, so a
  // deploy that changes the artwork is not defeated by an hour of cache.
  return html.replace(
    /<link rel="icon"[^>]*>/,
    mark
      ? `<link rel="icon" href="${branding.urlFor('mark')}" type="${mark.mime}">`
      : `<link rel="icon" href="/assets/favicon.svg?v=${stamp}" type="image/svg+xml">`);
}

module.exports = { shellHtml, buildStamp };
