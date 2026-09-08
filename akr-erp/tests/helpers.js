'use strict';
/* A live server on an ephemeral port, and a tiny signed-in client. */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** Each test file gets its own database, seeded from scratch. */
function freshEnv(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akr-${name}-`));
  process.env.DB_FILE = path.join(dir, 'test.db');
  process.env.AUTO_SEED = 'false';
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'test-secret';
  return dir;
}

async function start() {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const client = (token = null) => {
    const call = async (method, url, body) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(base + url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) {
        const err = new Error((data && data.error) || `HTTP ${res.status}`);
        err.status = res.status;
        err.payload = data;
        throw err;
      }
      return data;
    };
    return {
      get: (u) => call('GET', u),
      post: (u, b) => call('POST', u, b || {}),
      patch: (u, b) => call('PATCH', u, b || {}),
      del: (u) => call('DELETE', u),
      raw: call,
    };
  };

  const signIn = async (username, password = 'akr@2026') => {
    const res = await client().post('/api/auth/login', { username, password });
    return { ...client(res.token), me: res };
  };

  return { app, server, base, client, signIn, stop: () => new Promise((r) => server.close(r)) };
}

module.exports = { freshEnv, start };
