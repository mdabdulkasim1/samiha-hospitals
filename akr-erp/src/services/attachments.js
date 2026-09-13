'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../db');
const config = require('../config');
const { badRequest, notFound } = require('../lib/http');

/*
 * Files kept against a document.
 *
 * The client's own LPO arrives as a PDF and somebody will want to see it a
 * year from now — the thing they signed, not our transcription of it. So it is
 * stored, beside the database on the same volume, and everything about the
 * file that came from outside is treated as untrusted: the name is kept for
 * display and never used as a path, the type is checked against the bytes
 * rather than the label, and the size is capped before any of it is written.
 */

/** What a trading office actually attaches, and how each one starts. */
const ALLOWED = [
  { mime: 'application/pdf', ext: '.pdf', magic: [0x25, 0x50, 0x44, 0x46] },            // %PDF
  { mime: 'image/jpeg', ext: '.jpg', magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png', ext: '.png', magic: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/webp', ext: '.webp', magic: [0x52, 0x49, 0x46, 0x46] },
  // The Office formats are all zip containers, so they share a signature.
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: '.docx', magic: [0x50, 0x4B] },
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: '.xlsx', magic: [0x50, 0x4B] },
];

const startsWith = (buf, magic) => magic.every((b, i) => buf[i] === b);

/**
 * Work out what a file really is.
 *
 * From the bytes, not from what the upload claimed: a name ending .pdf proves
 * nothing, and neither does a content type the browser was told to send.
 */
function identify(buffer, declaredMime) {
  const match = ALLOWED.find((t) => startsWith(buffer, t.magic)
    && (!declaredMime || t.mime === declaredMime
      || t.magic[0] === 0x50));            // any Office file looks like a zip
  if (!match) {
    throw badRequest('That file is not one this system stores. Attach a PDF, an image, '
      + 'or a Word or Excel document.');
  }
  return match;
}

/** The extension a stored file gets — ours, derived from the bytes. */
function safeExtension(buffer, declaredMime, filename) {
  const type = identify(buffer, declaredMime);
  if (type.ext !== '.docx' && type.ext !== '.xlsx') return type.ext;
  const given = path.extname(String(filename || '')).toLowerCase();
  return ['.docx', '.xlsx', '.pptx', '.zip'].includes(given) ? given : '.zip';
}

/** The display name, with anything that could be a path taken out of it. */
function cleanName(filename) {
  const base = path.basename(String(filename || 'attachment'));
  const safe = base.replace(/[^\w .()\-]+/g, '_').replace(/\s+/g, ' ').trim();
  return (safe || 'attachment').slice(0, 120);
}

function ensureDir() {
  fs.mkdirSync(config.attachmentsDir, { recursive: true });
  return config.attachmentsDir;
}

/** Save one file against a document. `data` is base64. */
function save({ entityType, entityId, data, filename, mime, kind = null, notes = null,
  companyId = null, userId = null }) {
  if (!data) throw badRequest('There is no file here.');

  const buffer = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buffer.length) throw badRequest('That file came through empty.');

  const limit = config.maxAttachmentMb * 1024 * 1024;
  if (buffer.length > limit) {
    throw badRequest(`That file is ${(buffer.length / 1048576).toFixed(1)} MB. `
      + `The limit is ${config.maxAttachmentMb} MB.`);
  }

  const ext = safeExtension(buffer, mime, filename);
  const storedName = `${entityType}-${entityId}-${crypto.randomBytes(10).toString('hex')}${ext}`;

  ensureDir();
  fs.writeFileSync(path.join(config.attachmentsDir, storedName), buffer);

  const info = db.prepare(`
    INSERT INTO attachments (company_id, entity_type, entity_id, kind, filename, stored_name,
      mime, size_bytes, notes, uploaded_by)
    VALUES (@company_id, @entity_type, @entity_id, @kind, @filename, @stored_name, @mime,
      @size_bytes, @notes, @uploaded_by)`).run({
    company_id: companyId,
    entity_type: entityType,
    entity_id: entityId,
    kind,
    filename: cleanName(filename),
    stored_name: storedName,
    mime: identify(buffer, mime).mime,
    size_bytes: buffer.length,
    notes,
    uploaded_by: userId,
  });
  return get(info.lastInsertRowid);
}

const get = (id) => db.prepare(`
  SELECT a.*, u.name AS uploaded_by_name FROM attachments a
    LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.id = ?`).get(id);

const listFor = (entityType, entityId) => db.prepare(`
  SELECT a.id, a.kind, a.filename, a.mime, a.size_bytes, a.notes, a.uploaded_at,
         u.name AS uploaded_by_name
    FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
   WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.uploaded_at DESC`)
  .all(entityType, entityId);

/**
 * The file on disk, for serving.
 *
 * The path is rebuilt from the store directory and the name we generated, and
 * then checked to be inside it — belt and braces, because a path that escapes
 * its directory is how a file server becomes a way to read the whole disk.
 */
function fileFor(id) {
  const row = get(id);
  if (!row) throw notFound('No such attachment.');
  const dir = path.resolve(config.attachmentsDir);
  const file = path.resolve(dir, path.basename(row.stored_name));
  if (!file.startsWith(dir + path.sep)) throw notFound('No such attachment.');
  if (!fs.existsSync(file)) throw notFound('That file is no longer on disk.');
  return { row, file };
}

function remove(id) {
  const row = get(id);
  if (!row) throw notFound('No such attachment.');
  try {
    const dir = path.resolve(config.attachmentsDir);
    const file = path.resolve(dir, path.basename(row.stored_name));
    if (file.startsWith(dir + path.sep) && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    console.error('[attachments] could not remove the file:', err.message);
  }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  return row;
}

module.exports = { ALLOWED, save, get, listFor, fileFor, remove, cleanName, identify };
