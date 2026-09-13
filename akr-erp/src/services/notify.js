'use strict';
const { db } = require('../db');

/**
 * A line on somebody's bell. Work in this system moves between desks — a
 * quotation approved by the KAM has to reach the sales officer, a client's LPO
 * has to reach logistics, an invoice falling due has to reach accounts — and
 * nobody should have to keep refreshing a list to find out.
 */
function toUser(userId, { title, body = null, route = null }) {
  if (!userId) return;
  try {
    db.prepare('INSERT INTO notifications (user_id, title, body, route) VALUES (?, ?, ?, ?)')
      .run(userId, title, body, route);
  } catch (err) { console.error('[notify]', err.message); }
}

/** Everyone on a desk — 'accounts', 'logistics', 'kam'. */
function toRole(role, { title, body = null, route = null }) {
  try {
    const users = db.prepare('SELECT id FROM users WHERE role = ? AND active = 1').all(role);
    for (const u of users) toUser(u.id, { title, body, route });
  } catch (err) { console.error('[notify]', err.message); }
}

module.exports = { toUser, toRole };
