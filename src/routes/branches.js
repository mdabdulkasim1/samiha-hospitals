'use strict';
/**
 * The branches themselves.
 *
 * Reading the list is open to everybody signed in: the name of the place
 * they are standing in appears at the top of every screen, and the people
 * who may stand in more than one need to see which. Opening, renaming or
 * closing a branch is the owner's and the administrator's, because it is a
 * decision about the business rather than about today.
 */
const express = require('express');
const { wrap, badRequest } = require('../lib/http');
const { requireAuth, requireRole } = require('../lib/auth');
const { int } = require('../lib/validate');
const audit = require('../lib/audit');
const branches = require('../services/branches');

const router = express.Router();

router.get('/', requireAuth, wrap((req, res) => {
  res.json({
    rows: branches.list({ includeInactive: req.query.all === '1' }),
    mine: branches.forUser(req.user),
    current: branches.byId(req.branchId),
  });
}));

router.post('/', requireRole(), wrap((req, res) => {
  const row = branches.save(null, req.body);
  audit.log(req, 'branch.create', 'branch', row.id, { code: row.code, name: row.name });
  res.status(201).json(row);
}));

router.patch('/:id', requireRole(), wrap((req, res) => {
  const row = branches.save(int(req.params.id), req.body);
  audit.log(req, 'branch.update', 'branch', row.id, req.body);
  res.json(row);
}));

/**
 * Where a member of staff is posted.
 *
 * `homeId: null` means ask them every morning, which is the right answer for
 * somebody who genuinely splits their week between two places: a home branch
 * they have to notice and change is a home branch they will forget to
 * change, and a day's work filed under the wrong building.
 */
router.post('/staff/:id', requireRole(), wrap((req, res) => {
  const ids = Array.isArray(req.body.branchIds) ? req.body.branchIds : [];
  if (!ids.length) throw badRequest('Post them to at least one branch.');
  const homeId = req.body.homeId === null ? null : (int(req.body.homeId) || ids[0]);
  if (homeId && !ids.includes(homeId)) {
    throw badRequest('Their home branch has to be one of the branches they are posted to.');
  }
  const out = branches.setUserBranches(int(req.params.id), ids, { homeId });
  audit.log(req, 'branch.post_staff', 'user', int(req.params.id), out);
  res.json(out);
}));

module.exports = router;
