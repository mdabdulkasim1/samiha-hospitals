'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const { db } = require('./db');
const auth = require('./lib/auth');
const { ApiError } = require('./lib/http');
const { shellHtml } = require('./lib/shell');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Room for a pasted item list, and for an LPO scanned to PDF arriving as base64.
app.use(express.json({ limit: '32mb' }));
app.use(express.text({ type: 'text/csv', limit: '8mb' }));
app.use(express.urlencoded({ extended: false }));

// Minimal cookie helpers — two functions, rather than another dependency.
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
    app: config.company.name,
    time: new Date().toISOString(),
    items: db.prepare('SELECT COUNT(*) AS c FROM items').get().c,
    companies: db.prepare('SELECT COUNT(*) AS c FROM companies WHERE active = 1').get().c,
    /*
     * Whether the books will survive the next deploy.
     *
     * On the health check because that is the one thing about a fresh
     * deployment worth knowing from outside it, and because a volume that was
     * meant to be mounted and is not looks exactly like one that is until the
     * day it matters. The path itself is not reported — this endpoint is open.
     */
    storage: config.dbIsEphemeral ? 'ephemeral' : (config.volumePath ? 'volume' : 'local'),
    // The logo and the attachments live wherever the database does.
    uploads: config.volumePath ? 'volume' : (config.isProd ? 'ephemeral' : 'local'),
  });
});

app.use('/api/auth', require('./routes/auth'));
// The logo is served before anybody signs in — it is on the sign-in page.
app.use('/api/branding', require('./routes/branding'));

app.use('/api', auth.requireAuth);
app.use('/api/me', require('./routes/me'));
app.use('/api/masters', require('./routes/masters'));
app.use('/api/items', require('./routes/items'));
app.use('/api/partners', require('./routes/partners'));
app.use('/api/purchase', require('./routes/purchase'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/stock', require('./routes/stock'));
app.use('/api/attachments', require('./routes/attachments'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/admin', require('./routes/admin'));

// --------------------------------------------------------------- static + SPA
const publicDir = path.join(config.root, 'public');
app.use(express.static(publicDir, { index: false, maxAge: config.isProd ? '1h' : 0 }));

// The shell is read fresh in development so an edit shows on reload, and read
// once in production because it cannot change under a running process.
let cachedShell = null;
app.get(/^\/(?!api\/).*/, (_req, res) => {
  if (!cachedShell || !config.isProd) cachedShell = shellHtml(publicDir);
  res.set('Cache-Control', 'no-store');
  res.type('html').send(cachedShell);
});

// --------------------------------------------------------------- error handler
app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

app.use((err, req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ error: 'That record already exists.', details: err.message });
  }
  if (err && String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
    return res.status(400).json({ error: 'The data does not satisfy a database constraint.', details: err.message });
  }
  console.error('[error]', err);
  res.status(500).json({ error: config.isProd ? 'Internal server error' : err.message });
});

// -------------------------------------------------------------- housekeeping
function startBackgroundJobs() {
  setInterval(() => {
    try {
      auth.purgeExpiredSessions();
      // An invoice past its due date says so, without anybody having to notice.
      db.prepare(
        `UPDATE sales_invoices SET status = 'overdue'
          WHERE status = 'unpaid' AND due_date IS NOT NULL AND date(due_date) < date('now')`).run();
      // A post-dated cheque whose date has come round is ready to bank.
      db.prepare(
        `UPDATE payments SET status = 'deposited'
          WHERE mode = 'cheque' AND status = 'pending' AND cheque_date IS NOT NULL
            AND date(cheque_date) <= date('now')`).run();
    } catch (err) {
      console.error('[housekeeping]', err.message);
    }
  }, 3_600_000).unref();
}

/**
 * A fresh deployment starts with an empty database and nobody can sign in.
 * Seeding once, only when there are no accounts at all, turns that into a
 * working install without ever touching an existing one.
 */
function seedIfEmpty() {
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (users > 0) return;
  if (!config.autoSeed) return;
  console.log('[setup] No accounts found — creating the starter data.');
  try {
    require('./db/seed');
    console.warn('[setup] ⚠ Change every seeded password before this touches real trading data.');
  } catch (err) {
    console.error('[setup] Seeding failed:', err.message);
  }
}

if (require.main === module) {
  seedIfEmpty();

  /*
   * Anything set in .env that the company has not filled in for itself is
   * copied onto the default company, so a TRN added after the first run still
   * reaches the invoices. Nothing already entered is touched.
   */
  const filled = require('./db/company').applyEnvDefaults();
  if (filled.length) console.log(`[setup] Filled from .env: ${filled.join(', ')}.`);
  const gaps = require('./db/company').missingForInvoice();
  const server = app.listen(config.port, () => {
    console.log(`\n  ${config.company.name} — ERP`);
    console.log(`  ▸ http://localhost:${config.port}`);
    console.log(`  ▸ environment: ${config.nodeEnv}`);
    console.log(`  ▸ database:    ${config.dbFile}`
      + (config.volumePath ? '  (on a mounted volume)' : ''));
    console.log(`  ▸ VAT:         ${config.vat.percent}%  ·  currency ${config.vat.currency}`);
    const company = db.prepare('SELECT * FROM companies WHERE is_default = 1').get() || {};
    console.log(`  ▸ Company:     ${company.name || config.company.name}`);
    console.log(`  ▸ TRN:         ${company.trn || '(not set)'}`);
    /*
     * The one that loses the company its books.
     *
     * A container platform rebuilds the application directory on every deploy.
     * A database inside it is destroyed with it — quietly, and only noticed
     * when somebody looks for last month's invoices. Said loudly, at every
     * start, until a volume is mounted.
     */
    if (config.dbIsEphemeral) {
      console.warn('\n  ╔══════════════════════════════════════════════════════════════════╗');
      console.warn('  ║  THE DATABASE IS NOT ON A PERSISTENT VOLUME                      ║');
      console.warn('  ║                                                                  ║');
      console.warn('  ║  It is inside the application directory, which this platform     ║');
      console.warn('  ║  rebuilds on every deploy. Every invoice, payment and stock      ║');
      console.warn('  ║  movement will be destroyed the next time you ship a change.     ║');
      console.warn('  ║                                                                  ║');
      console.warn('  ║  Mount a volume and the database moves there by itself.          ║');
      console.warn('  ║  On Railway: the service → Variables → + Volume, mount at /data. ║');
      console.warn('  ╚══════════════════════════════════════════════════════════════════╝\n');
    }
    if (gaps.length) {
      console.warn(`\n  ⚠ A tax invoice still needs: ${gaps.join(', ')}.`);
      console.warn('    Set them in .env and restart, or under Masters → Companies.\n');
    } else {
      console.log('');
    }
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
