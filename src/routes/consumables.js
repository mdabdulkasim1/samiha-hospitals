'use strict';
/**
 * The consumables store, over the wire.
 *
 * Who touches it: the owner, the administrator and the nursing staff. The
 * nurses are the point — they are the people who open the last box of
 * gauze and the only ones in a position to write it down at the moment it
 * happens. A store only a manager can update is a store that is updated
 * once a month from memory, which is the same as not being updated.
 *
 * Everybody else is kept out. The pharmacy has its own stock, the counter
 * has no business in the ward's cupboard, and a list of what the clinic
 * holds is not something a visitor to the system needs.
 */
const express = require('express');
const { wrap, badRequest } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { str, int } = require('../lib/validate');
const audit = require('../lib/audit');
const store = require('../services/consumables');

const router = express.Router();

/** The owner, the administrator and the nurses — owner and admin by bypass. */
const storeRoles = requireRole('nurse');

router.get('/', storeRoles, wrap((req, res) => {
  res.json({
    ...store.list({
      area: str(req.query.area), q: str(req.query.q),
      low: req.query.low === '1', out: req.query.out === '1',
      includeInactive: req.query.all === '1',
    }),
    areas: store.areas(),
    kinds: Object.entries(store.KINDS).map(([key, m]) => ({ key, label: m.label })),
  });
}));

/** What the store did over a period: opening, in, out, closing, and where to. */
router.get('/usage', storeRoles, wrap((req, res) => {
  res.json(store.usage(str(req.query.from), str(req.query.to)));
}));

router.get('/:id', storeRoles, wrap((req, res) => res.json(store.detail(int(req.params.id)))));

/**
 * One movement: a delivery taken in, a box issued to a room, something
 * damaged, something counted.
 */
router.post('/:id/movements', storeRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const out = store.move(id, req.body || {}, req.user.id);
  if (!out.unchanged) {
    audit.log(req, 'stock_move', 'consumable', id, {
      code: out.code, kind: str(req.body.kind), qty: out.applied,
      onHand: out.on_hand, issuedTo: str(req.body.issuedTo), reason: str(req.body.reason),
    });
  }
  res.status(out.unchanged ? 200 : 201).json(out);
}));

/**
 * A whole delivery at once, which is how a delivery actually arrives: one
 * supplier, one invoice, one date, many lines.
 */
router.post('/deliveries', storeRoles, wrap((req, res) => {
  const out = store.receiveDelivery(req.body || {}, req.user.id);
  audit.log(req, 'stock_receive', 'consumable', null, {
    supplier: out.supplier, invoiceNo: out.invoiceNo, lines: out.received, on: out.movedOn,
  });
  res.status(201).json(out);
}));

/**
 * Take the purchase-order quantities as the opening stock, once.
 *
 * Management's, not the counter's: it writes an opening balance against
 * every item in the store in one press, and that is a decision about what
 * the clinic's books say rather than a day's work in the cupboard.
 */
router.post('/adopt-indent', requireRole(), wrap((req, res) => {
  const out = store.adoptIndent({ movedOn: str(req.body.movedOn), userId: req.user.id });
  audit.log(req, 'stock_opening', 'consumable', null,
    { items: out.opened, on: out.movedOn, from: 'purchase order' });
  res.status(201).json(out);
}));

/** Something the clinic keeps that was not on the purchase order. */
router.post('/', storeRoles, wrap((req, res) => {
  const row = store.createItem(req.body || {}, req.user.id);
  audit.log(req, 'create', 'consumable', row.id, { code: row.code, name: row.name, area: row.area });
  res.status(201).json(row);
}));

/**
 * Correcting an item: its name, its unit, the level to re-order at.
 *
 * Not its quantity — that is only ever moved, never set, so that what is
 * on the shelf always has a trail behind it.
 */
router.patch('/:id', storeRoles, wrap((req, res) => {
  if (req.body && (req.body.onHand !== undefined || req.body.qty !== undefined)) {
    throw badRequest('Stock is not typed in. Record what was received, issued or counted, '
      + 'and the figure follows from it.');
  }
  const row = store.updateItem(int(req.params.id), req.body || {});
  audit.log(req, 'update', 'consumable', row.id, { code: row.code, name: row.name, active: row.active });
  res.json(row);
}));

module.exports = router;
