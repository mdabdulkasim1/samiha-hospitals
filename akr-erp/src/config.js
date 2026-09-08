'use strict';
const fs = require('fs');
const path = require('path');

// Minimal .env loader — keeps configuration dependency-free.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const root = path.resolve(__dirname, '..');
loadEnvFile(path.join(root, '.env'));

const env = process.env;

/*
 * Where the database file lives.
 *
 * On a container platform the application directory is rebuilt on every
 * deploy, so a database sitting inside it is destroyed each time the company
 * ships a change — with every invoice, payment and stock movement in it. The
 * only safe place is a mounted volume that survives the rebuild.
 *
 * Railway names the mount in RAILWAY_VOLUME_MOUNT_PATH, so when a volume is
 * attached it is used without anybody having to remember to point at it. Set
 * DB_FILE to override. Locally, neither exists and the file sits under ./data
 * as it always has.
 */
const volumePath = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || null;
const defaultDbFile = volumePath ? path.join(volumePath, 'akr.db') : './data/akr.db';

module.exports = {
  root,
  port: Number(env.PORT || 4000),
  nodeEnv: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  dbFile: path.resolve(root, env.DB_FILE || defaultDbFile),
  volumePath,
  /*
   * True when the database is inside the application directory, which on a
   * container platform means it will not survive the next deploy.
   */
  get dbIsEphemeral() {
    return !path.resolve(root, env.DB_FILE || defaultDbFile).startsWith(path.sep + 'data')
      && !volumePath
      && (env.NODE_ENV === 'production');
  },
  autoSeed: String(env.AUTO_SEED || 'true').toLowerCase() !== 'false',

  session: {
    secret: env.SESSION_SECRET || 'akr-dev-secret-change-me',
    ttlHours: Number(env.SESSION_TTL_HOURS || 12),
    cookieName: 'akr_sid',
  },

  /*
   * The group's own details. The trading company is the default company, but
   * every document is stamped with whichever of the group's companies issued
   * it, so six companies can share one set of books without sharing a
   * document number.
   */
  group: {
    name: env.GROUP_NAME || 'AKR GROUP',
    defaultCompany: (env.DEFAULT_COMPANY || 'AKR').toUpperCase(),
  },

  company: {
    name: env.COMPANY_NAME || 'AKR GENERAL TRADING L.L.C',
    tagline: env.COMPANY_TAGLINE || 'Trusted Trading Partner for Valves, Fittings & Construction Materials',
    address: env.COMPANY_ADDRESS
      || '206 & 706 Park Avenue Tower, Dubai Silicon Oasis, Dubai, UAE — P.O. Box 19556',
    phone: env.COMPANY_PHONE || '+971 4 000 0000',
    email: env.COMPANY_EMAIL || 'sales@akr365.com',
    website: env.COMPANY_WEBSITE || 'www.akr365.com',
    // The Tax Registration Number that must appear on every tax invoice.
    trn: env.COMPANY_TRN || '105279558800003',
    bankName: env.COMPANY_BANK || '',
    bankAccount: env.COMPANY_ACCOUNT || '',
    iban: env.COMPANY_IBAN || '',
    swift: env.COMPANY_SWIFT || '',
  },

  /*
   * UAE VAT. Five per cent on both sides of the trade — charged to the client
   * on our tax invoice (output tax) and paid to the supplier on theirs (input
   * tax) — and the return is the difference between the two.
   */
  vat: {
    percent: Number(env.VAT_PERCENT || 5),
    currency: env.CURRENCY || 'AED',
    currencySymbol: env.CURRENCY_SYMBOL || 'AED',
    // Fils: everything is rounded to two decimals, once, at the line.
    decimals: 2,
  },

  // The prefix every item code starts with — AKR-VLV-00001.
  itemCodePrefix: (env.ITEM_CODE_PREFIX || 'AKR').toUpperCase(),

  appUrl: (env.APP_URL || `http://localhost:${Number(env.PORT || 4000)}`).replace(/\/$/, ''),
};
