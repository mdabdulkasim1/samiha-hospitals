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
const dbFile = path.resolve(root, env.DB_FILE || defaultDbFile);

/*
 * Which commit is actually running.
 *
 * Three days were lost to a deployment that had not picked up any of the work
 * pushed for it, with nobody able to tell from the outside — the screens looked
 * the same, so the code was assumed to be the same. Railway hands the container
 * the commit it built, so the application can simply say. It goes in the
 * sidebar, under the person's name, and on the health check.
 */
const release = (env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT_SHA || env.SOURCE_COMMIT || '')
  .trim().slice(0, 7) || null;

module.exports = {
  root,
  release,
  releaseBranch: (env.RAILWAY_GIT_BRANCH || '').trim() || null,
  port: Number(env.PORT || 4000),
  nodeEnv: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  dbFile,
  volumePath,
  /*
   * Where uploaded paperwork is kept: beside the database, on the same volume,
   * so that backing one up backs up the other and neither can survive without
   * the other making sense.
   */
  attachmentsDir: path.resolve(root, env.ATTACHMENTS_DIR
    || (volumePath ? path.join(volumePath, 'attachments') : './data/attachments')),
  maxAttachmentMb: Number(env.MAX_ATTACHMENT_MB || 12),
  /*
   * True when the database sits inside the application directory in production
   * — which on a container platform means it is rebuilt away on the next
   * deploy, taking the books with it.
   *
   * A mounted volume settles it. Failing that, a DB_FILE pointing somewhere
   * outside the application is taken as somebody having made their own
   * arrangements; a path inside it is not, and is warned about loudly. A false
   * warning costs a moment's reading. The silence costs the ledgers.
   */
  get dbIsEphemeral() {
    if (env.NODE_ENV !== 'production') return false;
    if (volumePath) return false;
    return dbFile.startsWith(root + path.sep);
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

    /*
     * The company's mark, and where every screen and every printed document
     * goes to find it.
     *
     * Two files, referenced from one place: the mark on its own for the
     * sidebar, the letterhead and the watermark, and the mark with the wordmark
     * for the sign-in page. Drop the company's own artwork into public/assets
     * and point these at it — a PNG is as good as an SVG — and it appears on
     * everything at once. Nothing else in the system names a logo file.
     */
    logo: env.COMPANY_LOGO || '/assets/logo-icon.svg',
    logoFull: env.COMPANY_LOGO_FULL || '/assets/logo.svg',

    /*
     * The artwork, given to the deployment rather than uploaded to it.
     *
     * An upload is written beside the database, and on a platform with no
     * volume mounted that is inside the container it rebuilds on every deploy —
     * so the logo goes in on Monday and is gone on Tuesday, which is exactly
     * what happened here. An environment variable is not in the container: the
     * platform holds it and hands it back on every deploy. So either of these,
     * set once on the service, survives what an upload cannot.
     *
     *   COMPANY_LOGO_URL   a link to the file, fetched when the app starts
     *   COMPANY_LOGO_DATA  the file itself — SVG markup, or base64, or a
     *                      data: URI pasted straight in
     *
     * Neither overrides artwork somebody has uploaded by hand; they are what
     * the system falls back on instead of the drawing that ships with it.
     */
    logoUrl: (env.COMPANY_LOGO_URL || '').trim(),
    logoData: (env.COMPANY_LOGO_DATA || '').trim(),
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
