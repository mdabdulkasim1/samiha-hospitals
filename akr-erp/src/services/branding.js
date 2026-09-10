'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { badRequest } = require('../lib/http');

/*
 * The company's own artwork.
 *
 * A logo is not source code — it is a fact about the company, like its address
 * or its TRN — so it is uploaded and stored beside the database rather than
 * committed and deployed. Hand-drawing an approximation of somebody's mark and
 * shipping it is how a system ends up putting the wrong bird on every invoice
 * it prints.
 *
 * Two slots. `mark` is the badge on its own: the sidebar, the letterhead, the
 * watermark, the favicon. `full` is the mark with the wordmark, for the sign-in
 * page. Either falls back to the file in public/assets when nothing has been
 * uploaded.
 */
const SLOTS = {
  mark: { label: 'The mark on its own', fallback: '/assets/logo-icon.svg' },
  full: { label: 'The mark with the wordmark', fallback: '/assets/logo.svg' },
};

const TYPES = [
  { mime: 'image/svg+xml', ext: '.svg' },
  { mime: 'image/png', ext: '.png', magic: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/jpeg', ext: '.jpg', magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/webp', ext: '.webp', magic: [0x52, 0x49, 0x46, 0x46] },
];

/*
 * Where the artwork lives, and whether it will still be there tomorrow.
 *
 * With a volume mounted it sits beside the database and survives a deploy.
 * Without one it is inside the container, which Railway replaces on every
 * deploy — so a logo uploaded on Monday is the drawn placeholder again on
 * Tuesday, and the person who uploaded it is left thinking the upload failed.
 * The screen says so rather than letting that be discovered.
 */
const isEphemeral = () => !config.volumePath && config.isProd;

const dir = () => {
  const d = config.volumePath
    ? path.join(config.volumePath, 'branding')
    : path.resolve(config.root, './data/branding');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/*
 * How the artwork wants to be shown.
 *
 * A logo on a transparent background needs a light plate behind it or it
 * disappears into a dark sidebar. A logo that carries its own background — most
 * of them do — looks like a sticker on one. Only the person who uploaded it
 * knows which they have, so they say, once, and every screen follows.
 */
const settingsFile = () => path.join(dir(), 'settings.json');

function settings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return { plate: raw.plate !== false };
  } catch {
    return { plate: true };
  }
}

function setSettings(next) {
  const now = { ...settings(), ...next, plate: next.plate !== false };
  fs.writeFileSync(settingsFile(), JSON.stringify(now, null, 2));
  return now;
}

/** The stored file for a slot, or null. */
function find(slot) {
  if (!SLOTS[slot]) return null;
  const d = dir();
  for (const t of TYPES) {
    const file = path.join(d, `${slot}${t.ext}`);
    if (fs.existsSync(file)) return { file, mime: t.mime, slot };
  }
  return null;
}

/**
 * The file to serve for a slot: the one uploaded for it, or the other one.
 *
 * One upload should be enough. If only the badge has been given it stands in
 * for the lock-up on the sign-in page, and if only the lock-up has, it goes on
 * the documents — rather than half the system showing the company's mark and
 * the other half showing a drawing of it.
 */
function resolve(slot) {
  return find(slot) || find(slot === 'mark' ? 'full' : 'mark');
}

/** A short fingerprint of a file, for the query string. */
function fingerprint(file) {
  const stat = fs.statSync(file);
  return crypto.createHash('sha1')
    .update(`${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 10);
}

/**
 * The bundled artwork, fingerprinted.
 *
 * Static files are served with an hour of cache in production, and this path
 * never changes — so a browser that fetched the old file goes on showing it
 * after a deploy has replaced it, which reads exactly like "the logo is still
 * not there". The fingerprint changes when the file does, and a container
 * rebuild changes every file's timestamp, so a deploy always wins.
 */
function fallbackUrl(slot) {
  const rel = SLOTS[slot].fallback;
  try {
    return `${rel}?v=${fingerprint(path.join(config.root, 'public', rel.replace(/^\//, '')))}`;
  } catch {
    return rel;
  }
}

/**
 * What a screen or a document should point at for this slot.
 *
 * The uploaded file is served through the API with a fingerprint on the query,
 * because a logo that has just been replaced and still shows the old one for a
 * week is the same bug as not replacing it.
 */
function urlFor(slot) {
  const found = resolve(slot);
  if (!found) return fallbackUrl(slot);
  return `/api/branding/${found.slot}?v=${fingerprint(found.file)}`;
}

/** Work out what an uploaded file really is, from its bytes. */
function identify(buffer, declaredMime) {
  const head = buffer.slice(0, 400).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) {
    if (!head.includes('<svg') && !buffer.toString('utf8', 0, 2000).toLowerCase().includes('<svg')) {
      throw badRequest('That XML file does not contain an SVG.');
    }
    return TYPES[0];
  }
  const match = TYPES.find((t) => t.magic && t.magic.every((b, i) => buffer[i] === b));
  if (!match) {
    throw badRequest('That is not an image this system can use. Upload an SVG, PNG, JPG or WebP.');
  }
  if (declaredMime && match.mime !== declaredMime && declaredMime !== 'application/octet-stream') {
    // The bytes win; the label is only a hint.
  }
  return match;
}

/**
 * An SVG is markup, and markup can carry script. What goes on every screen and
 * every printed document is not the place to find that out, so an uploaded SVG
 * with a script in it is refused rather than sanitised — a rejection somebody
 * can act on beats a silent edit of their artwork.
 */
function checkSvg(buffer) {
  const text = buffer.toString('utf8');
  if (/<script[\s>]/i.test(text) || /\son\w+\s*=/i.test(text) || /javascript:/i.test(text)) {
    throw badRequest('That SVG contains a script, so it will not be used as the logo. '
      + 'Export it again from the design file, or upload a PNG.');
  }
}

function save(slot, { data, mime, filename }, { fromEnv = false } = {}) {
  if (!SLOTS[slot]) throw badRequest(`There is no "${slot}" logo.`);
  const buffer = Buffer.from(String(data || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buffer.length) throw badRequest('That file came through empty.');
  if (buffer.length > 3 * 1024 * 1024) {
    throw badRequest('A logo over 3 MB is far larger than it needs to be — it is printed at '
      + 'about 20 mm. Export it smaller.');
  }

  const type = identify(buffer, mime);
  if (type.ext === '.svg') checkSvg(buffer);

  // One file per slot: the old one goes, so nothing stale can be served.
  const d = dir();
  for (const t of TYPES) {
    const old = path.join(d, `${slot}${t.ext}`);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  fs.writeFileSync(path.join(d, `${slot}${type.ext}`), buffer);
  // An upload by hand is a person's decision, and it stops the deployment's
  // setting from ever overwriting it.
  if (!fromEnv) forgetEnvMark();

  return { slot, mime: type.mime, size_bytes: buffer.length, url: urlFor(slot),
    filename: path.basename(String(filename || '')) };
}

function clear(slot) {
  if (!SLOTS[slot]) throw badRequest(`There is no "${slot}" logo.`);
  const d = dir();
  let removed = false;
  for (const t of TYPES) {
    const file = path.join(d, `${slot}${t.ext}`);
    if (fs.existsSync(file)) { fs.unlinkSync(file); removed = true; }
  }
  forgetEnvMark();
  return removed;
}

/** What both slots currently point at, for the screen that manages them. */

/**
 * How big the artwork actually is.
 *
 * Read from the file's own header — no image library, and none needed: every
 * format worth uploading says its size in the first few dozen bytes. It is
 * worth knowing because a logo that looks fine at 44 pixels in the sidebar can
 * be a blur across a letterhead, and nothing in the system can undo that after
 * the fact. Better to say so on the screen where it was uploaded.
 */
function dimensions(file, mime) {
  try {
    const buf = fs.readFileSync(file);
    if (mime === 'image/svg+xml') {
      // A vector has no pixels: it is sharp at any size, which is the point.
      return { vector: true };
    }
    if (mime === 'image/png' && buf.length > 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/webp' && buf.length > 30 && buf.toString('ascii', 12, 16) === 'VP8X') {
      return {
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
    if (mime === 'image/jpeg') {
      // Walk the segments to the frame header, which carries the size.
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i += 1; continue; }
        const marker = buf[i + 1];
        const length = buf.readUInt16BE(i + 2);
        // SOF0..SOF15, skipping the four that are not frame headers.
        if (marker >= 0xC0 && marker <= 0xCF
            && ![0xC4, 0xC8, 0xCC, 0xD8].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + length;
      }
    }
  } catch { /* an unreadable file is reported as no size, not as a crash */ }
  return {};
}

/*
 * Under this, across the longer side, a raster logo is too small for the head
 * of an A4 document — it is about 20 mm wide there at 300 dpi.
 */
const SHARP_ENOUGH = 480;


/* --------------------------------------------------------- from a web address
 * The company's logo is already on its website. Rather than ask somebody to
 * find the file, save it and upload it from a phone, the server fetches it —
 * the server, because it is the one with a plain route to the internet.
 *
 * Give it the address of the site and it looks for the artwork the way a
 * browser would: the social-sharing image a site declares for itself, then the
 * touch icon, then the first image in the page that calls itself a logo. Give
 * it the address of an image and it takes that. Either way the bytes are
 * checked before anything is written — a page that serves an HTML error with
 * an image's name is not an image.
 */
const FETCH_LIMIT_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;

async function download(url) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw badRequest('Give a web address beginning with http:// or https://');
  }
  let res;
  try {
    res = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'AKR-ERP/1.0 (+logo fetch)', Accept: 'image/*,text/html;q=0.8' },
    });
  } catch (err) {
    throw badRequest(`That address could not be reached: ${err.message}`);
  }
  if (!res.ok) throw badRequest(`That address answered ${res.status}.`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > FETCH_LIMIT_BYTES) throw badRequest('That file is larger than 4 MB.');
  return { buf, url: res.url || target.href, type: res.headers.get('content-type') || '' };
}

/** The artwork a page declares for itself. */
function logoInPage(html, pageUrl) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? m[1] : null;
  };
  const candidate =
    pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    || pick(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i)
    || pick(/<img[^>]+(?:class|id|alt)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i)
    || pick(/<img[^>]+src=["']([^"']*logo[^"']*)["']/i)
    || pick(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i);
  if (!candidate) return null;
  try {
    return new URL(candidate, pageUrl).href;
  } catch {
    return null;
  }
}

/**
 * Take the artwork for a slot from a web address.
 *
 * Returns what was saved, and the address it was actually taken from — which
 * matters when a site address was given and the picture came from somewhere
 * inside it.
 */
async function fromUrl(slot, url, opts = {}) {
  if (!SLOTS[slot]) throw badRequest('There is no such logo.');
  let got = await download(url);

  // An HTML page: find the artwork it declares, and fetch that instead.
  const looksHtml = got.type.includes('text/html')
    || got.buf.slice(0, 200).toString('utf8').trim().toLowerCase().startsWith('<!doctype html')
    || got.buf.slice(0, 200).toString('utf8').toLowerCase().includes('<html');
  if (looksHtml) {
    const found = logoInPage(got.buf.toString('utf8'), got.url);
    if (!found) {
      throw badRequest('No logo could be found on that page. Open the logo itself in the browser, '
        + 'copy that address, and paste it here.');
    }
    got = await download(found);
  }

  const saved = save(slot, { data: got.buf.toString('base64'),
    filename: path.basename(new URL(got.url).pathname) || `${slot}` }, opts);
  return { ...saved, taken_from: got.url };
}

/* ------------------------------------------------------- given by the deploy
 * Artwork that comes from the environment rather than from an upload.
 *
 * With no volume mounted, an upload lives inside the container the platform
 * rebuilds on every deploy, so it cannot survive one. An environment variable
 * can: the platform holds it and hands it back each time. Set COMPANY_LOGO_URL
 * or COMPANY_LOGO_DATA on the service and the mark is installed at startup,
 * every startup, for as long as the variable is set.
 *
 * It never overwrites artwork somebody uploaded by hand — that is a deliberate
 * act by a person and outranks a setting.
 */
/*
 * A note beside the artwork saying the deployment put it there, and from what.
 *
 * Without it, the first start writes the logo onto the volume and every later
 * start finds a file already sitting there and leaves it alone — so changing
 * the setting does nothing, for ever, with no way to tell why. That is the same
 * "the logo will not change" this whole exercise began with. The note records a
 * fingerprint of the setting, so a changed setting is installed and an
 * unchanged one is left alone.
 */
const markFile = () => path.join(dir(), 'from-env.json');
const fingerprintOf = (source, value) => crypto.createHash('sha1')
  .update(`${source}:${value}`).digest('hex').slice(0, 16);

function envMark() {
  try {
    return JSON.parse(fs.readFileSync(markFile(), 'utf8'));
  } catch {
    return null;
  }
}

function forgetEnvMark() {
  try { fs.unlinkSync(markFile()); } catch { /* there was none */ }
}

/** Where the mark currently comes from: the deployment, an upload, or the source. */
const source = (slot = 'mark') => {
  if (!find(slot) && !find(slot === 'mark' ? 'full' : 'mark')) return 'bundled';
  return envMark() ? 'environment' : 'uploaded';
};

async function installFromEnv() {
  const { logoData, logoUrl } = config.company;
  const setting = logoData
    ? { name: 'COMPANY_LOGO_DATA', value: logoData }
    : (logoUrl ? { name: 'COMPANY_LOGO_URL', value: logoUrl } : null);
  const mark = envMark();

  // The setting was there and has been taken away: so should the artwork it
  // put in, or removing it would have no effect either.
  if (!setting) {
    if (mark) { for (const slot of Object.keys(SLOTS)) clear(slot); return { removed: true }; }
    return null;
  }

  const want = fingerprintOf(setting.name, setting.value);
  // Unchanged, and already installed: nothing to do, and nothing to re-fetch on
  // every restart.
  if (mark && mark.fingerprint === want && (find('mark') || find('full'))) {
    return { skipped: 'already installed', source: setting.name };
  }
  // Somebody uploaded artwork by hand. That outranks a setting.
  if (!mark && (find('mark') || find('full'))) {
    return { skipped: 'something was uploaded by hand', source: setting.name };
  }

  try {
    let saved;
    if (logoData) {
      // Markup, a data: URI, or plain base64 — all three get pasted into a
      // settings box by somebody who should not have to know the difference.
      const raw = logoData.replace(/^data:[^;]+;base64,/, '');
      const looksMarkup = /^\s*<(\?xml|svg)/i.test(logoData);
      saved = save('mark', {
        data: looksMarkup ? Buffer.from(logoData, 'utf8').toString('base64') : raw,
        filename: 'logo-from-settings',
      }, { fromEnv: true });
    } else {
      saved = await fromUrl('mark', logoUrl, { fromEnv: true });
    }
    fs.writeFileSync(markFile(), JSON.stringify(
      { source: setting.name, fingerprint: want, at: new Date().toISOString() }, null, 2));
    return { source: setting.name, ...saved };
  } catch (err) {
    // A logo that will not load must not stop the books opening.
    return { error: err.message, source: setting.name };
  }
}

const status = () => Object.entries(SLOTS).map(([slot, meta]) => {
  const found = find(slot);
  return {
    slot,
    label: meta.label,
    url: urlFor(slot),
    uploaded: Boolean(found),
    mime: found ? found.mime : null,
    size_bytes: found ? fs.statSync(found.file).size : null,
    ...(found ? dimensions(found.file, found.mime) : {}),
    // Said plainly, where it was uploaded, rather than discovered on a printed
    // invoice: this file is too small to print well.
    soft: found ? isSoft(dimensions(found.file, found.mime)) : false,
  };
});

/** Whether a raster file is too small to hold up on a letterhead. */
function isSoft(d) {
  if (!d || d.vector) return false;
  if (!d.width || !d.height) return false;
  return Math.max(d.width, d.height) < SHARP_ENOUGH;
}

module.exports = { SLOTS, SHARP_ENOUGH, find, resolve, urlFor, fallbackUrl, save, clear, status,
  installFromEnv, source,
  dimensions, isSoft, isEphemeral, dir, settings, setSettings, fromUrl, logoInPage };
