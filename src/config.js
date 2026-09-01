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
    address: env.CLINIC_ADDRESS || 'Main Road, Your City',
    phone: env.CLINIC_PHONE || '+91 00000 00000',
    email: env.CLINIC_EMAIL || 'care@samihapolyclinic.com',
    gstin: env.CLINIC_GSTIN || '',
    currency: env.CURRENCY || 'INR',
    currencySymbol: env.CURRENCY_SYMBOL || '₹',
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
