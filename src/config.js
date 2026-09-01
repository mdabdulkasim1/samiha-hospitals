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

const env = process.env;

module.exports = {
  root,
  port: Number(env.PORT || 3000),
  nodeEnv: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  dbFile: path.resolve(root, env.DB_FILE || './data/samiha.db'),
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
    state: env.CLINIC_STATE || 'Tamil Nadu',
    stateCode: env.CLINIC_STATE_CODE || '33',
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
    // Every recovery link and backup notice is copied to this mailbox.
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
    emailAttach: String(env.BACKUP_EMAIL_ATTACH || 'false').toLowerCase() === 'true',
  },
  whatsapp: {
    provider: env.WHATSAPP_PROVIDER || 'mock',   // 'mock' | 'meta'
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || 'samiha-verify-token',
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v21.0',
    sessionTtlMinutes: Number(env.WHATSAPP_SESSION_TTL_MINUTES || 30),
  },
};
