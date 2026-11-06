'use strict';
const { db } = require('../db');

let stmt = null;
const insert = () => (stmt ||= db.prepare(
  `INSERT INTO audit_logs (user_id, actor, action, entity, entity_id, details, ip)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
));

/**
 * Record an action. Never throws — an audit failure must not break the
 * request.
 *
 * `actor` is for the handful of places where the person acting is not yet on
 * the request: signing in and completing a password reset both establish who
 * the user is as their last act, so there is no req.user to read. They used
 * to pass `{ ...req, user }` instead, and that quietly cost the clinic every
 * login record it should have had — spreading an Express request copies only
 * its own properties, and Node defines `headers` as a getter on the
 * prototype, so the copy had none. Reading one threw, the catch below
 * swallowed it, and the audit trail simply had no logins in it.
 */
function log(req, action, entity, entityId, details, actor) {
  try {
    const user = actor || (req && req.user);
    insert().run(
      user ? user.id : null,
      user ? `${user.name} (${user.role})` : 'system',
      action,
      entity || null,
      entityId || null,
      details ? JSON.stringify(details) : null,
      // Defensively, because the thing an audit log must never do is lose a
      // row over a missing header.
      (req && (req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress)) || null
    );
  } catch (err) {
    console.error('[audit] failed:', action, err.message);
  }
}

module.exports = { log };
