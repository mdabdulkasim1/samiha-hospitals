'use strict';
/*
 * Who may open what.
 *
 * A role says what somebody's job is; it should not be the last word on which
 * screens they are given. One sales officer works the buying side as well as
 * the selling; another company's accounts clerk is trusted with the profit
 * page. So the role sets a sensible default and the administrator adjusts it
 * one person at a time, under Staff.
 *
 * The division that matters, and the one this file keeps:
 *
 *   a screen grant says what somebody may OPEN and READ
 *   their role still says what they may DO
 *
 * Granting the payments screen to a sales officer lets them see what has been
 * received; it does not let them book a receipt, because that is still gated on
 * the accounts role where the route is written. Nothing here widens what any
 * desk can change.
 */
const { db } = require('../db');

/** Every screen the application has, in the order the menu shows them. */
const SCREENS = [
  { id: 'dashboard', label: 'Dashboard', group: 'Overview' },

  { id: 'enquiries', label: 'Enquiries', group: 'Selling' },
  { id: 'quotations', label: 'Our Quotations', group: 'Selling' },
  { id: 'orders', label: 'Client LPOs', group: 'Selling' },
  { id: 'deliveries', label: 'Deliveries', group: 'Selling' },
  { id: 'invoices', label: 'Tax Invoices', group: 'Selling' },

  { id: 'supplier-enquiries', label: 'Enquiries to Manufacturers', group: 'Buying' },
  { id: 'supplier-quotations', label: 'Supplier Quotations', group: 'Buying' },
  { id: 'purchase-orders', label: 'Our LPOs', group: 'Buying' },
  { id: 'goods-receipts', label: 'Goods Receipts', group: 'Buying' },
  { id: 'supplier-bills', label: 'Supplier Bills', group: 'Buying' },

  { id: 'stock', label: 'Stock Register', group: 'Stock' },
  { id: 'catalogue', label: 'Item Master', group: 'Stock' },

  { id: 'payments', label: 'Payments & Receipts', group: 'Money' },
  { id: 'cheques', label: 'Cheque Register', group: 'Money' },
  { id: 'expenses', label: 'Expenses & Income', group: 'Money' },
  { id: 'ledgers', label: 'Ledgers & Ageing', group: 'Money' },
  { id: 'vat', label: 'VAT & Profit', group: 'Money' },

  { id: 'partners', label: 'Suppliers & Clients', group: 'Accounts & setup' },
  { id: 'trace', label: 'Trace a Reference', group: 'Accounts & setup' },
  { id: 'reports', label: 'Reports', group: 'Accounts & setup' },
  { id: 'masters', label: 'Masters', group: 'Accounts & setup' },
  { id: 'staff', label: 'Staff', group: 'Accounts & setup' },
  { id: 'account', label: 'My Account', group: 'Accounts & setup' },
];

const ALL = SCREENS.map((s) => s.id);
const IDS = new Set(ALL);

/** Screens everybody has, whatever their desk. */
const COMMON = ['dashboard', 'stock', 'catalogue', 'partners', 'trace', 'reports', 'account'];

/*
 * What each desk starts with.
 *
 * The sales officer carries both sides of the trade: they log what a client
 * asked for and what we asked a manufacturer, and they follow the order in.
 * What they are not given by default is the money — the bills, the payments,
 * the ledgers — which stays with accounts until the administrator says
 * otherwise.
 */
const DEFAULTS = {
  admin: ALL,
  kam: ALL.filter((id) => !['staff', 'vat'].includes(id)),
  accounts: [...COMMON, 'quotations', 'orders', 'deliveries', 'invoices',
    'supplier-enquiries', 'supplier-quotations', 'purchase-orders', 'goods-receipts',
    'supplier-bills', 'payments', 'cheques', 'expenses', 'ledgers'],
  sales: [...COMMON, 'enquiries', 'quotations', 'orders', 'deliveries', 'invoices',
    'supplier-enquiries', 'supplier-quotations', 'purchase-orders', 'goods-receipts'],
  logistics: [...COMMON, 'orders', 'deliveries', 'purchase-orders', 'goods-receipts'],
};

const inOrder = (ids) => ALL.filter((id) => ids.includes(id));

/** What the role alone would give. */
function forRole(role) {
  return inOrder(DEFAULTS[role] || COMMON);
}

/** The exceptions an administrator has recorded for one person. */
function overridesFor(userId) {
  const rows = db.prepare('SELECT screen, allowed FROM user_screens WHERE user_id = ?').all(userId);
  const map = {};
  for (const r of rows) if (IDS.has(r.screen)) map[r.screen] = Boolean(r.allowed);
  return map;
}

/**
 * What this person may open: their desk's default, with the administrator's
 * exceptions applied over it. My Account is never taken away — somebody who
 * cannot change their own password has no way back in.
 */
function effective(user) {
  if (!user) return [];
  const base = new Set(forRole(user.role));
  for (const [screen, allowed] of Object.entries(overridesFor(user.id))) {
    if (allowed) base.add(screen);
    else base.delete(screen);
  }
  base.add('account');
  return inOrder([...base]);
}

const can = (user, screen) => effective(user).includes(screen);

/**
 * Record an administrator's choice for one person.
 *
 * Only the difference from their desk's default is kept, so a change to what a
 * desk is given by default still reaches everybody who was left on it. Handing
 * back exactly the default clears the exceptions rather than freezing them.
 */
function set(userId, role, wanted) {
  const want = new Set(inOrder((wanted || []).filter((id) => IDS.has(id))));
  want.add('account');
  const base = new Set(forRole(role));

  const write = db.transaction(() => {
    db.prepare('DELETE FROM user_screens WHERE user_id = ?').run(userId);
    const stmt = db.prepare(
      'INSERT INTO user_screens (user_id, screen, allowed) VALUES (?, ?, ?)');
    for (const id of ALL) {
      const wantIt = want.has(id);
      if (wantIt !== base.has(id)) stmt.run(userId, id, wantIt ? 1 : 0);
    }
  });
  write();
  return inOrder([...want]);
}

/** Put somebody back on their desk's default. */
function reset(userId) {
  db.prepare('DELETE FROM user_screens WHERE user_id = ?').run(userId);
}

module.exports = { SCREENS, ALL, DEFAULTS, forRole, effective, can, set, reset, overridesFor };
