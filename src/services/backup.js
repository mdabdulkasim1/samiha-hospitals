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
 * The weekly workbook.
 *
 * The nightly `.db` snapshot is what you restore from; this is what you can
 * open. They answer different questions — one gets the clinic running again
 * after a disk dies, the other lets somebody look at a year of takings on a
 * laptop with no ERP on it — and a clinic wants both.
 *
 * Written as the administrator, so it carries everything: the audit log and
 * the staff list are in this book and in no other.
 */
async function createWorkbook({ kind = 'scheduled', userId = null } = {}) {
  ensureDir();
  const filename = `samiha-full-${stamp()}.xlsx`;
  const target = path.join(config.backup.dir, filename);

  try {
    // Required here rather than at the top: the exports service reads every
    // table, and loading it with the database module would be a cycle.
    const sheets = require('./exports').everything({ role: 'admin' });
    const book = require('../lib/xlsx').build(sheets);
    fs.writeFileSync(target, book);

    const info = db.prepare(
      'INSERT INTO backups (filename, size_bytes, kind, status, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(filename, book.length, kind, 'ok', userId);
    return {
      id: info.lastInsertRowid, filename, sheets: sheets.length,
      sizeMb: Math.round((book.length / 1048576) * 100) / 100,
    };
  } catch (err) {
    db.prepare(
      'INSERT INTO backups (filename, size_bytes, kind, status, error, created_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(filename, 0, kind, 'failed', err.message, userId);
    throw err;
  }
}

/** The ISO week a date falls in, so "once a week" survives a restart. */
function weekKey(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Daily snapshot at the configured hour, and the workbook once a week on the
 * same tick. Checked every 15 minutes rather than scheduled once, so a restart
 * never skips the window — and both are keyed on the day or the week they
 * belong to rather than on a timer, so a restart never doubles one either.
 */
function startSchedule() {
  if (config.backup.hour === null || Number.isNaN(config.backup.hour)) return null;
  let lastRunDay = null;
  let lastRunWeek = null;

  const tick = () => {
    const now = new Date();
    if (now.getHours() !== config.backup.hour) return;

    const day = now.toISOString().slice(0, 10);
    if (day !== lastRunDay) {
      lastRunDay = day;
      create({ kind: 'scheduled' })
        .then((b) => console.log(`[backup] scheduled snapshot ${b.filename} (${b.sizeMb} MB)`))
        .catch((err) => console.error('[backup] scheduled snapshot failed:', err.message));
    }

    const week = weekKey(now);
    if (week !== lastRunWeek && now.getDay() === config.backup.workbookDay) {
      lastRunWeek = week;
      createWorkbook({ kind: 'scheduled' })
        .then((b) => console.log(`[backup] weekly workbook ${b.filename} — ${b.sheets} sheets (${b.sizeMb} MB)`))
        .catch((err) => console.error('[backup] weekly workbook failed:', err.message));
    }
  };

  const timer = setInterval(tick, 15 * 60_000);
  timer.unref();
  tick();
  return timer;
}

module.exports = { create, createWorkbook, prune, list, fileFor, startSchedule, ensureDir, weekKey };
