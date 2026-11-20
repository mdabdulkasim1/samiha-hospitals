'use strict';
/**
 * The code stuck to the thing itself.
 *
 *     SHC - WHLCH - 0326 - MPM - 001
 *      │      │       │      │     └─ the first wheelchair of that batch
 *      │      │       │      └─ Melapalayam
 *      │      │       └─ bought March 2026
 *      │      └─ wheelchair
 *      └─ Samiha Healthcare
 *
 * Every part of it is there so that somebody holding the object can answer a
 * question without a computer: what is this, when did we buy it, whose is
 * it. That is the whole argument for a readable code over a serial number —
 * a label reading AST0147 tells a person standing in the store room
 * nothing at all, and the one moment an asset register is actually used is
 * when somebody is standing in front of the asset.
 *
 * Two rules hold the scheme together, and both are enforced here rather than
 * trusted to whoever is typing:
 *
 *   - The same kind of thing always carries the same letters. Wheelchairs are
 *     WHLCH whoever enters them, because the codes are a list that is reused
 *     and not an abbreviation invented per asset.
 *   - A code, once minted, belongs to that object for good. It is never
 *     reissued, never recalculated, and never quietly changed because a
 *     purchase date was corrected afterwards — the sticker on the wheelchair
 *     cannot be edited from here.
 */
const { db } = require('../db');
const { badRequest, notFound, conflict } = require('../lib/http');

/** Samiha Healthcare. The one part of the code that is not a lookup. */
const PREFIX = process.env.ASSET_CODE_PREFIX || 'SHC';

const clean = (s) => String(s || '').trim();
const upper = (s) => clean(s).toUpperCase();

/*
 * The branches themselves live in src/services/branches.js.
 *
 * They started here, because the asset code was the first thing that needed
 * to know which building an item belonged to. They are now the backbone of
 * the whole system — everything recorded anywhere is stamped with one — so
 * the register reads them from there rather than keeping a second copy of
 * the rules. Two places deciding what a valid branch code is, is one place
 * too many.
 */
const branchService = require('./branches');
const branches = (opts) => branchService.list(opts);
const defaultBranch = () => branchService.defaultBranch();
const saveBranch = (id, fields) => branchService.save(id, fields);

// ------------------------------------------------------------- item codes
const itemCodes = ({ includeInactive = false, q } = {}) => db.prepare(
  `SELECT c.*, (SELECT COUNT(*) FROM assets a WHERE a.item_code = c.code) AS asset_count
     FROM asset_item_codes c
    WHERE 1 = 1 ${includeInactive ? '' : 'AND c.active = 1'}
      ${q ? 'AND (c.name LIKE ? OR c.code LIKE ?)' : ''}
    ORDER BY c.name`).all(...(q ? [`%${q}%`, `%${upper(q)}%`] : []));

/**
 * A short code suggested from the name of the thing.
 *
 * Vowels after the first letter go first, because that is what makes
 * "Wheelchair" into WHLCH rather than WHEEL — a reader recovers the word
 * from the consonants and cannot from the first five letters of a long one.
 * Only ever a suggestion: whoever is entering it can type over it, and from
 * then on it is the list's answer for that kind of thing.
 */
/**
 * The kind of thing, from the way the clinic writes an asset name.
 *
 * It writes them as "the thing — its specification": "Hospital cot — 2
 * function fully ABS manual, heavy duty IV pole". The code is for the
 * thing, so everything from the dash or the first bracket onwards is
 * dropped — and because two cots of different specification reduce to the
 * same head, they share one item code, which is what the scheme is for.
 */
const itemName = (name) => clean(clean(name).split(/[—–(,]|\s-\s/)[0]);

function suggestCode(name) {
  const words = itemName(name).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const squeeze = (w) => w[0] + w.slice(1).replace(/[AEIOU]/g, '');

  let code;
  if (words.length === 1) code = squeeze(words[0]).slice(0, 5);
  else if (words.length === 2) code = (squeeze(words[0]).slice(0, 3) + squeeze(words[1]).slice(0, 2));
  else code = words.map((w) => w[0]).join('').slice(0, 5);
  if (code.length < 3) code = words.join('').slice(0, 3);

  // Not already somebody else's: BPAPP, then BPAP2, BPAP3 …
  let candidate = code;
  let n = 2;
  while (db.prepare('SELECT 1 FROM asset_item_codes WHERE code = ?').get(candidate)) {
    const taken = db.prepare('SELECT name FROM asset_item_codes WHERE code = ?').get(candidate);
    if (taken && taken.name.toUpperCase() === itemName(name).toUpperCase()) return candidate;
    candidate = `${code.slice(0, 4)}${n}`;
    n += 1;
  }
  return candidate;
}

/** Find the code for this kind of thing, making one if the clinic has none. */
function itemCodeFor(name, { code, category = null, userId = null } = {}) {
  const wanted = upper(code) || null;
  if (wanted) {
    if (!/^[A-Z0-9]{2,6}$/.test(wanted)) {
      throw badRequest('An item code is two to six letters or digits, such as WHLCH.');
    }
    const found = db.prepare('SELECT * FROM asset_item_codes WHERE code = ?').get(wanted);
    if (found) return found;
    db.prepare('INSERT INTO asset_item_codes (code, name, category, created_by) VALUES (?, ?, ?, ?)')
      .run(wanted, itemName(name) || wanted, category, userId);
    return db.prepare('SELECT * FROM asset_item_codes WHERE code = ?').get(wanted);
  }

  const byName = db.prepare('SELECT * FROM asset_item_codes WHERE UPPER(name) = ?')
    .get(upper(itemName(name)));
  if (byName) return byName;

  const minted = suggestCode(name);
  if (!minted) throw badRequest('Give the item a name, or an item code of your own.');
  db.prepare('INSERT INTO asset_item_codes (code, name, category, created_by) VALUES (?, ?, ?, ?)')
    .run(minted, itemName(name), category, userId);
  return db.prepare('SELECT * FROM asset_item_codes WHERE code = ?').get(minted);
}

// ------------------------------------------------------------- the code
/** 'March 2026' → '0326', the way the clinic writes it on a label. */
function monthStamp(date) {
  const s = clean(date);
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  return `${m[2]}${m[1].slice(2)}`;
}

const format = ({ itemCode, month, branch, serial }) =>
  `${PREFIX}-${itemCode}-${month}-${branch}-${String(serial).padStart(3, '0')}`;

/**
 * Mint the code for one asset.
 *
 * The serial counts within the item and the branch, so the number on the
 * label is the sixth wheelchair at Melapalayam rather than the six hundred
 * and forty-first thing the clinic has ever bought. Past 999 it carries on
 * to 1000 rather than wrapping, for the same reason the queue's tokens do.
 *
 * Minting is refused for an asset that already carries a code. The sticker
 * is on the object; a second code for the same object is how a register
 * stops matching the store room.
 */
function mint(assetId, { userId = null, branchId = null, itemCode = null } = {}) {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  if (!asset) throw notFound('Asset not found');
  if (asset.asset_code) {
    throw conflict(`${asset.name} already carries ${asset.asset_code}. `
      + 'Reprint the label rather than minting a second code.');
  }
  if (!asset.purchase_date) {
    throw badRequest('The code carries the month it was bought, so the purchase date is needed first.');
  }
  const month = monthStamp(asset.purchase_date);
  if (!month) throw badRequest(`"${asset.purchase_date}" is not a date the code can carry.`);

  const branch = branchId
    ? db.prepare('SELECT * FROM branches WHERE id = ? AND active = 1').get(branchId)
    : (asset.branch_id
      ? db.prepare('SELECT * FROM branches WHERE id = ?').get(asset.branch_id)
      : defaultBranch());
  if (!branch) throw badRequest('Add a branch first — the code carries which branch owns the asset.');

  const item = itemCodeFor(asset.name, {
    code: itemCode || asset.item_code, category: asset.category, userId,
  });

  const write = db.transaction(() => {
    const highest = db.prepare(
      `SELECT MAX(code_serial) AS m FROM assets
        WHERE item_code = ? AND branch_id = ?`).get(item.code, branch.id).m;
    const serial = (highest || 0) + 1;
    const code = format({ itemCode: item.code, month, branch: branch.code, serial });
    db.prepare(
      `UPDATE assets SET asset_code = ?, item_code = ?, branch_id = ?, code_serial = ?,
              code_minted_at = datetime('now'), code_minted_by = ?
        WHERE id = ?`).run(code, item.code, branch.id, serial, userId, assetId);
    return code;
  });

  const code = write();
  return { code, asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId), item, branch };
}

/**
 * Mint for everything that has no code yet.
 *
 * The clinic is labelling a store room that already has things in it, so
 * the first run is a batch and not one asset at a time. Anything that
 * cannot be coded — no purchase date, most often — is reported rather than
 * guessed at, and the rest still get theirs.
 */
function mintMissing({ userId = null, branchId = null, ids = null } = {}) {
  const rows = db.prepare(
    `SELECT id, name, purchase_date FROM assets
      WHERE asset_code IS NULL AND active = 1
        ${ids && ids.length ? `AND id IN (${ids.map(() => '?').join(',')})` : ''}
      ORDER BY id`).all(...(ids && ids.length ? ids : []));

  const minted = [];
  const skipped = [];
  for (const row of rows) {
    try { minted.push(mint(row.id, { userId, branchId })); }
    catch (err) { skipped.push({ id: row.id, name: row.name, reason: err.message }); }
  }
  return { minted: minted.map((m) => ({ id: m.asset.id, name: m.asset.name, code: m.code })), skipped };
}

/** What a scanner read, back to the asset it is stuck to. */
function byCode(code) {
  const wanted = upper(code);
  return db.prepare(
    `SELECT a.*, b.name AS branch_name, b.code AS branch_code, d.name AS department_name
       FROM assets a
       LEFT JOIN branches b ON b.id = a.branch_id
       LEFT JOIN departments d ON d.id = a.department_id
      WHERE UPPER(a.asset_code) = ? OR UPPER(a.asset_no) = ?`).get(wanted, wanted) || null;
}

module.exports = {
  PREFIX, branches, defaultBranch, saveBranch,
  itemCodes, itemCodeFor, suggestCode, itemName,
  monthStamp, format, mint, mintMissing, byCode,
};
