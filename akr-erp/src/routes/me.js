'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap } = require('../lib/http');
const v = require('../lib/validate');

const router = express.Router();

router.get('/notifications', wrap(async (req, res) => {
  const { limit } = v.paging(req.query, 30, 100);
  const rows = db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(req.user.id, limit);
  const unread = db.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).c;
  res.json({ rows, unread });
}));

router.get('/notifications/count', wrap(async (req, res) => {
  const unread = db.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).c;
  res.json({ unread });
}));

router.post('/notifications/:id/read', wrap(async (req, res) => {
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.user.id);
  res.json({ ok: true });
}));

router.post('/notifications/read-all', wrap(async (req, res) => {
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL")
    .run(req.user.id);
  res.json({ ok: true });
}));

module.exports = router;
