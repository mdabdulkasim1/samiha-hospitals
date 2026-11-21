'use strict';
const fs = require('fs');
const path = require('path');

// Minimal .env loader — keeps the app dependency-free for configuration.
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

process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const env = process.env;

module.exports = {
  root,
  port: Number(env.PORT || 3000),
  nodeEnv: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  dbEngine: env.DB_ENGINE || (env.DB_FILE ? 'sqlite' : 'mysql'),         // 'mysql' (default) | 'sqlite' (deprecated)
  dbFile: path.resolve(root, env.DB_FILE || './data/samiha.db'),
  mysql: {
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT || 3306),
    database: env.DB_NAME || 'samiha-polyclinic',
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
  },
  session: {
    secret: env.SESSION_SECRET || 'samiha-dev-secret-change-me',
    ttlHours: Number(env.SESSION_TTL_HOURS || 12),
    cookieName: 'samiha_sid',
  },
  clinic: {
    name: env.CLINIC_NAME || 'SAMIHA POLYCLINIC & DIAGNOSTICS',
    address: env.CLINIC_ADDRESS || 'Nethaji Road, Melapalayam – 627 005',
    phone: env.CLINIC_PHONE || '+91 72007 50420',
    email: env.CLINIC_EMAIL || 'care@samihapolyclinic.com',
    gstin: env.CLINIC_GSTIN || '',
    // The number patients call or message. Quoted whenever a chat closes.
    whatsappNumber: env.CLINIC_WHATSAPP_NUMBER || env.CLINIC_PHONE || '+91 72007 50420',
    currency: env.CURRENCY || 'INR',
    currencySymbol: env.CURRENCY_SYMBOL || '₹',
    // The prefix on a doctor's code — SPC for Samiha Polyclinic.
    code: (env.CLINIC_CODE || 'SPC').toUpperCase(),
    state: env.CLINIC_STATE || 'Tamil Nadu',
    stateCode: env.CLINIC_STATE_CODE || '33',
    /*
     * Where a patient's UPI payment goes. A bill printed with a QR code is
     * paid from the chair, so this is the clinic's own collection VPA and the
     * name that will show in the payer's app before they confirm.
     *
     * Left empty until somebody sets it, here or under Account & System: a QR
     * pointing at the wrong account is worse than no QR at all, so nothing is
     * guessed and no code prints until there is an ID to print.
     */
    upiId: env.CLINIC_UPI_ID || '',
    upiName: env.CLINIC_UPI_NAME || env.CLINIC_NAME || 'SAMIHA POLYCLINIC & DIAGNOSTICS',
  },

  /**
   * The pharmacy bills in its own name, under its own GSTIN and drug licences,
   * because a retail chemist is a separate registration from the clinic.
   *
   * `mrpIncludesGst` is true because in India the MRP printed on a pack is the
   * maximum a patient may be charged, GST included. Tax is therefore extracted
   * out of the MRP, never added on top — adding it would sell above MRP, which
   * is an offence under the Legal Metrology rules.
   */
  pharmacy: {
    name: env.PHARMACY_NAME || 'SAMIHA PHARMACEUTICALS',
    tagline: env.PHARMACY_TAGLINE || 'Caring Beyond Medicine',
    address: env.PHARMACY_ADDRESS || env.CLINIC_ADDRESS || 'Nethaji Road, Melapalayam – 627 005',
    phone: env.PHARMACY_PHONE || env.CLINIC_PHONE || '+91 72007 50420',
    gstin: env.PHARMACY_GSTIN || env.CLINIC_GSTIN || '',
    dlNumbers: env.PHARMACY_DL_NUMBERS || '',      // e.g. "TN/CHN/20B/1234, TN/CHN/21B/1234"
    fssai: env.PHARMACY_FSSAI || '',
    pharmacistName: env.PHARMACIST_NAME || '',
    pharmacistRegNo: env.PHARMACIST_REG_NO || '',
    mrpIncludesGst: String(env.MRP_INCLUDES_GST || 'true').toLowerCase() !== 'false',
    // 80 mm roll: 72 mm of it is printable on most thermal heads.
    receiptWidthMm: Number(env.RECEIPT_WIDTH_MM || 72),
  },
  appUrl: (env.APP_URL || `http://localhost:${Number(env.PORT || 3000)}`).replace(/\/$/, ''),
  autoSeed: String(env.AUTO_SEED || 'true').toLowerCase() !== 'false',
  mail: {
    provider: env.MAIL_PROVIDER || 'mock',       // 'mock' | 'smtp'
    // Every recovery link and backup notice goes to this mailbox, and only
    // this one: most staff sign in with a staff code and have no inbox.
    recoveryEmail: env.RECOVERY_EMAIL || 'samihahospital@gmail.com',
    from: env.MAIL_FROM || `SAMIHA Healthcare <${env.RECOVERY_EMAIL || 'samihahospital@gmail.com'}>`,
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(env.SMTP_PORT || 587),
    secure: String(env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    user: env.SMTP_USER || env.RECOVERY_EMAIL || '',
    pass: env.SMTP_PASS || '',
    resetTtlMinutes: Number(env.RESET_TTL_MINUTES || 30),
  },
  backup: {
    dir: path.resolve(root, env.BACKUP_DIR || './data/backups'),
    retention: Number(env.BACKUP_RETENTION || 14),
    hour: env.BACKUP_HOUR === '' ? null : Number(env.BACKUP_HOUR ?? 2),
    // Which day the weekly workbook is written, 0 = Sunday. The clinic's
    // quietest morning, so a book of every table is built when nobody is
    // waiting on the database.
    workbookDay: Number(env.BACKUP_WORKBOOK_DAY ?? 0),
    emailAttach: String(env.BACKUP_EMAIL_ATTACH || 'false').toLowerCase() === 'true',
  },
  whatsapp: {
    provider: env.WHATSAPP_PROVIDER || 'mock',   // 'mock' | 'meta'
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || 'samiha-verify-token',
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    appId: env.WHATSAPP_APP_ID || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v21.0',
    sessionTtlMinutes: Number(env.WHATSAPP_SESSION_TTL_MINUTES || 30),
    // The WhatsApp Business Account the number belongs to. Only needed to
    // read back which message templates Meta has approved.
    wabaId: env.WHATSAPP_WABA_ID || '',
    /*
     * The approved template a bill is sent under when the free-form window
     * has closed.
     *
     * WhatsApp lets a business write to a patient freely only within 24
     * hours of that patient's own last message. A patient paying at the
     * counter has almost never written to the clinic, so without a template
     * the bill cannot be delivered at all — which is why this exists.
     *
     * `name` is the template as it was approved in Meta Business Manager.
     * `body` lists what goes into its {{1}}, {{2}}… in order, separated by
     * pipes, so a clinic whose approved template has three variables rather
     * than four does not need a code change. Leave `name` empty and nothing
     * changes: a bill is sent free-form, and a refusal is reported.
     */
    billTemplate: {
      name: env.WHATSAPP_BILL_TEMPLATE || '',
      language: env.WHATSAPP_TEMPLATE_LANG || 'en',
      body: env.WHATSAPP_BILL_TEMPLATE_BODY === undefined
        ? '{patient}|{billNo}|{total}|{balance}'
        : env.WHATSAPP_BILL_TEMPLATE_BODY,
    },
  },
};
