'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const config = require('../config');

/**
 * Whether this clinic's records actually survive a restart.
 *
 * A container's own filesystem is thrown away when it is redeployed, so a
 * database sitting inside one lasts until the next release. That failure is
 * silent and total: the clinic finds out on the morning the register is
 * blank, by which time the patients, the bills and the day book are gone.
 *
 * The proof is simple and needs no knowledge of the host. Record when the
 * database was first opened; if that moment is older than the process reading
 * it, the file outlived a restart and is being kept. If the two are the same,
 * this database was created just now — which on a clinic that has been
 * running means the last one was thrown away.
 */

const KEY = 'install.first_boot';

/** Note when this database was first opened. Returns true the first time. */
function mark() {
  try {
    if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(KEY)) return false;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(KEY, new Date().toISOString());
    return true;
  } catch { return false; }
}

function status() {
  let firstBoot = null;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
    firstBoot = row ? row.value : null;
  } catch { /* settings not ready */ }

  const startedAt = new Date(Date.now() - process.uptime() * 1000);
  // A second of slack: the mark is written moments after the process starts.
  const olderThanThisProcess = Boolean(firstBoot)
    && new Date(firstBoot).getTime() < startedAt.getTime() - 1000;

  /*
   * Where the file sits is a hint rather than an answer — a volume can be
   * mounted anywhere — so it is reported as what it is and the verdict rests
   * on the dates.
   */
  const dir = path.dirname(config.dbFile);
  let writable = true;
  try { fs.accessSync(dir, fs.constants.W_OK); } catch { writable = false; }

  return {
    database: config.dbFile,
    directory: dir,
    writable,
    firstBoot,
    processStarted: startedAt.toISOString(),
    // survived — proven to outlive a restart. unproven — created this boot,
    // which is expected on a first install and a warning on any later one.
    persistence: olderThanThisProcess ? 'survived' : 'unproven',
  };
}

module.exports = { mark, status, KEY };
