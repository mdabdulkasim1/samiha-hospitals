'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db } = require('../db');
const mailer = require('./mailer');

/**
 * Database backups.
 *
 * SQLite's own online backup API is used, so a snapshot is consistent even
 * while the clinic is mid-transaction — copying the file by hand is not safe
 * with WAL journalling.
 */

function ensureDir() {
  fs.mkdirSync(config.backup.dir, { recursive: true });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Take a snapshot. Returns the row written to `backups`. */
async function create({ kind = 'manual', userId = null, notify = true } = {}) {
  ensureDir();
  const filename = `samiha-${stamp()}.db`;
  const target = path.join(config.backup.dir, filename);
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19);

  try {
    // better-sqlite3 exposes SQLite's online backup; it is safe under WAL.
    await db.backup(target);
    const size = fs.statSync(target).size;

    const info = db.prepare(
      'INSERT INTO backups (filename, size_bytes, kind, created_by) VALUES (?, ?, ?, ?)'
    ).run(filename, size, kind, userId);

    const pruned = prune();
    const sizeMb = Math.round((size / 1048576) * 100) / 100;

    if (notify) {
      const msg = mailer.templates.backupNotice({
        filename, sizeMb, when, kind, retention: config.backup.retention,
      });
      await mailer.send({
        to: config.mail.recoveryEmail,
        subject: msg.subject,
        text: msg.text,
        attachments: config.backup.emailAttach && size < 20 * 1048576
          ? [{ filename, path: target }] : undefined,
      });
      db.prepare('UPDATE backups SET emailed_to = ? WHERE id = ?')
        .run(config.mail.recoveryEmail, info.lastInsertRowid);
    }

    return {
      ...db.prepare('SELECT * FROM backups WHERE id = ?').get(info.lastInsertRowid),
      sizeMb, pruned, path: target,
    };
  } catch (err) {
    db.prepare(
      "INSERT INTO backups (filename, kind, status, error, created_by) VALUES (?, ?, 'failed', ?, ?)"
    ).run(filename, kind, err.message, userId);
    if (notify) {
      const msg = mailer.templates.backupFailed({ error: err.message, when });
      await mailer.send({ to: config.mail.recoveryEmail, subject: msg.subject, text: msg.text });
    }
    throw err;
  }
}

/** Keep only the newest `retention` files; delete the rest from disk and index. */
function prune() {
  const keep = Math.max(config.backup.retention, 1);
  const rows = db.prepare(
    "SELECT * FROM backups WHERE status = 'ok' ORDER BY id DESC"
  ).all();
  const removed = [];
  for (const row of rows.slice(keep)) {
    const file = path.join(config.backup.dir, row.filename);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* leave the index entry */ }
    db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
    removed.push(row.filename);
  }
  return removed;
}

function list() {
  return db.prepare(
    `SELECT b.*, u.name AS created_by_name FROM backups b
       LEFT JOIN users u ON u.id = b.created_by
      ORDER BY b.id DESC LIMIT 60`
  ).all().map((b) => ({
    ...b,
    sizeMb: Math.round((b.size_bytes / 1048576) * 100) / 100,
    onDisk: fs.existsSync(path.join(config.backup.dir, b.filename)),
  }));
}

function fileFor(filename) {
  // Defend against a crafted filename reaching outside the backup directory.
  const safe = path.basename(String(filename));
  const full = path.join(config.backup.dir, safe);
  if (!full.startsWith(config.backup.dir) || !fs.existsSync(full)) return null;
  return full;
}

/**
 * Daily snapshot at the configured hour. Checked every 15 minutes rather than
 * scheduled once, so a restart never skips the window.
 */
function startSchedule() {
  if (config.backup.hour === null || Number.isNaN(config.backup.hour)) return null;
  let lastRunDay = null;
  const tick = () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (day === lastRunDay || now.getHours() !== config.backup.hour) return;
    lastRunDay = day;
    create({ kind: 'scheduled' })
      .then((b) => console.log(`[backup] scheduled snapshot ${b.filename} (${b.sizeMb} MB)`))
      .catch((err) => console.error('[backup] scheduled snapshot failed:', err.message));
  };
  const timer = setInterval(tick, 15 * 60_000);
  timer.unref();
  tick();
  return timer;
}

module.exports = { create, prune, list, fileFor, startSchedule, ensureDir };
