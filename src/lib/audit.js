'use strict';
const { db } = require('../db');

let stmt = null;
const insert = () => (stmt ||= db.prepare(
  `INSERT INTO audit_logs (user_id, actor, action, entity, entity_id, details, ip)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
));

/**
 * Record an action. Never throws — an audit failure must not break the request.
 */
function log(req, action, entity, entityId, details) {
  try {
    const user = req && req.user;
    insert().run(
      user ? user.id : null,
      user ? `${user.name} (${user.role})` : 'system',
      action,
      entity || null,
      entityId || null,
      details ? JSON.stringify(details) : null,
      /*
       * Defensively, because a caller that spreads the request — `{...req,
       * user}` — hands us an object with no `headers` at all: on an Express
       * request that is a getter on the prototype, and a spread copies only
       * own properties. That silently threw away every sign-in this log was
       * supposed to be keeping.
       */
      (req && (req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress)) || null
    );
  } catch (err) {
    console.error('[audit] failed:', err.message);
  }
}

module.exports = { log };
