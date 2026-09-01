'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const { db } = require('./db');
const auth = require('./lib/auth');
const { ApiError } = require('./lib/http');
const whatsapp = require('./services/whatsapp');
const backup = require('./services/backup');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// Minimal cookie helpers (avoids pulling in cookie-parser for two functions).
app.use((req, res, next) => {
  res.cookie = (name, value, opts = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    if (opts.sameSite) parts.push(`SameSite=${opts.sameSite === true ? 'Strict' : opts.sameSite}`);
    if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    res.append('Set-Cookie', parts.join('; '));
    return res;
  };
  res.clearCookie = (name) => res.append('Set-Cookie', `${name}=; Path=/; Max-Age=0`);
  next();
});

app.use(auth.attachUser);

// ------------------------------------------------------------------- routing
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: config.clinic.name,
    time: new Date().toISOString(),
    whatsappProvider: config.whatsapp.provider,
    patients: db.prepare('SELECT COUNT(*) AS c FROM patients').get().c,
  });
});

// The WhatsApp webhook is called by Meta and must stay unauthenticated.
app.use('/api/whatsapp', require('./routes/whatsapp'));
app.use('/api/auth', require('./routes/auth'));

app.use('/api', auth.requireAuth);
app.use('/api/masters', require('./routes/masters'));
app.use('/api/patients', require('./routes/patients'));
app.use('/api/enquiries', require('./routes/enquiries'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/visits', require('./routes/visits'));
app.use('/api/financial', require('./routes/financial'));
app.use('/api/lab', require('./routes/lab'));
app.use('/api/pharmacy', require('./routes/pharmacy'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/ipd', require('./routes/ipd'));
app.use('/api/insurance', require('./routes/insurance'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/admin', require('./routes/admin'));

// --------------------------------------------------------------- static + SPA
app.use(express.static(path.join(config.root, 'public'), { index: false, maxAge: config.isProd ? '1h' : 0 }));
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));

// --------------------------------------------------------------- error handler
app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

app.use((err, req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ error: 'That record already exists (unique constraint).', details: err.message });
  }
  if (err && String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
    return res.status(400).json({ error: 'The data does not satisfy a database constraint.', details: err.message });
  }
  console.error('[error]', err);
  res.status(500).json({ error: config.isProd ? 'Internal server error' : err.message });
});

// -------------------------------------------------------------- housekeeping
function startBackgroundJobs() {
  // Drain the WhatsApp outbox (reminders, queued receipts) every minute.
  setInterval(() => {
    whatsapp.dispatchPending(50).catch((err) => console.error('[outbox]', err.message));
  }, 60_000).unref();

  // Expire stale sessions and overdue payment-plan instalments hourly.
  setInterval(() => {
    try {
      auth.purgeExpiredSessions();
      auth.purgeExpiredResets();
      db.prepare(
        "UPDATE payment_plan_installments SET status = 'overdue' WHERE status = 'due' AND date(due_date) < date('now')"
      ).run();
      db.prepare(
        `UPDATE appointments SET status = 'no_show'
          WHERE status IN ('booked','confirmed') AND datetime(scheduled_at) < datetime('now', '-2 hours')`
      ).run();
    } catch (err) {
      console.error('[housekeeping]', err.message);
    }
  }, 3_600_000).unref();

  // Nightly database snapshot, with a notice to the recovery mailbox.
  backup.startSchedule();
}

/**
 * A fresh deployment starts with an empty database and nobody can sign in.
 * Seeding once, only when there are no users at all, turns that into a working
 * install without ever touching an existing one.
 */
function seedIfEmpty() {
  if (!config.autoSeed) return;
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (users > 0) return;
  console.log('[setup] No accounts found — creating the starter data.');
  try {
    require('./db/seed');
    console.log('[setup] Done. Sign in as admin@samiha.local with the seeded password.');
    console.warn('[setup] ⚠ Change every seeded password before using this with real patient data.');
  } catch (err) {
    console.error('[setup] Seeding failed:', err.message);
  }
}

if (require.main === module) {
  seedIfEmpty();
  const server = app.listen(config.port, () => {
    console.log(`\n  ${config.clinic.name} — ERP`);
    console.log(`  ▸ http://localhost:${config.port}`);
    console.log(`  ▸ environment: ${config.nodeEnv}`);
    console.log(`  ▸ database:    ${config.dbFile}`);
    console.log(`  ▸ WhatsApp:    ${config.whatsapp.provider}` +
      (config.whatsapp.provider === 'mock' ? ' (simulator — no messages leave this machine)' : ''));
    console.log(`  ▸ Email:       ${config.mail.provider} → recovery copies to ${config.mail.recoveryEmail}` +
      (config.mail.provider === 'mock' ? ' (offline — reset links appear in the outbox)' : ''));
    console.log(`  ▸ Backups:     ${config.backup.dir}` +
      (config.backup.hour !== null ? ` (daily at ${String(config.backup.hour).padStart(2, '0')}:00)` : ' (automatic backup off)') + '\n');
  });
  startBackgroundJobs();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`\n${signal} received — shutting down.`);
      server.close(() => { db.close(); process.exit(0); });
    });
  }
}

module.exports = app;
