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

/**
 * What a screen or a document should point at for this slot.
 *
 * The uploaded file is served through the API with a fingerprint on the query,
 * because a logo that has just been replaced and still shows the old one for a
 * week is the same bug as not replacing it.
 */
function urlFor(slot) {
  const found = resolve(slot);
  if (!found) return SLOTS[slot].fallback;
  const stat = fs.statSync(found.file);
  const stamp = crypto.createHash('sha1')
    .update(`${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 10);
  return `/api/branding/${found.slot}?v=${stamp}`;
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

function save(slot, { data, mime, filename }) {
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

module.exports = { SLOTS, SHARP_ENOUGH, find, resolve, urlFor, save, clear, status,
  dimensions, isSoft, isEphemeral, dir, settings, setSettings };
