'use strict';
/**
 * The clinic as a group.
 *
 * One building today — Melapalayam — and another planned. The owner's
 * question is not "how did the clinic do" but "how did each one do", which
 * makes the branch a fact about everything that happens rather than a
 * setting: a visit happened somewhere, a payment was taken somewhere, an
 * expense was incurred somewhere.
 *
 * Three rules hold the whole thing together, and the rest of the system
 * leans on them:
 *
 *   - The branch is stamped on a record when it is made, from the branch
 *     the person is signed in to. Never worked out afterwards from who
 *     entered it — staff move between branches, and a figure that changes
 *     when somebody transfers is not a figure anybody can act on.
 *   - Everybody works in exactly one branch at a time, chosen at sign-in.
 *     The owner and the administrator may stand in any of them; everybody
 *     else is where they are posted.
 *   - Patients belong to the group, not to a branch. A family registered at
 *     Melapalayam that walks into the new place is the same family with the
 *     same UHID and the same history. Only what happens to them is
 *     attributed.
 */
const { db } = require('../db');
const { badRequest, notFound, conflict } = require('../lib/http');

const clean = (s) => String(s || '').trim();

/** Owner and administrator stand in any branch; everyone else is posted. */
const SEES_ALL = ['owner', 'admin'];

const BRANCH = 'SELECT id, code, name, address, is_default, active FROM branches';

const list = ({ includeInactive = false } = {}) => db.prepare(
  `${BRANCH} ${includeInactive ? '' : 'WHERE active = 1'}
    ORDER BY is_default DESC, code`).all();

const byId = (id) => (id ? db.prepare(`${BRANCH} WHERE id = ?`).get(id) || null : null);

const defaultBranch = () => db.prepare(
  `${BRANCH} WHERE active = 1 ORDER BY is_default DESC, id LIMIT 1`).get() || null;

function save(id, fields) {
  const code = fields.code === undefined ? undefined : clean(fields.code).toUpperCase();
  if (code !== undefined) {
    // Two to four letters: MPM, CH. It is printed in the middle of every
    // asset code, so it has to stay short and has to stay stable.
    if (!/^[A-Z]{2,4}$/.test(code)) {
      throw badRequest('A branch code is two to four letters, such as MPM or CH.');
    }
    const clash = db.prepare('SELECT id, name FROM branches WHERE code = ? AND id IS NOT ?')
      .get(code, id || null);
    if (clash) throw conflict(`${code} is already ${clash.name}.`);
  }

  const row = {
    code,
    name: fields.name === undefined ? undefined : clean(fields.name),
    address: fields.address === undefined ? undefined : clean(fields.address),
    is_default: fields.isDefault === undefined ? undefined : (fields.isDefault ? 1 : 0),
    active: fields.active === undefined ? undefined : (fields.active ? 1 : 0),
  };
  const given = Object.keys(row).filter((k) => row[k] !== undefined);
  if (!given.length) throw badRequest('Nothing to change.');

  const write = db.transaction(() => {
    let branchId = id;
    if (id) {
      if (!db.prepare('SELECT 1 FROM branches WHERE id = ?').get(id)) throw notFound('Branch not found');
      /*
       * A branch is never deleted and the last active one cannot be closed:
       * the records of everything that happened there point at it, and
       * somebody has to be able to sign in somewhere tomorrow.
       */
      if (row.active === 0) {
        const others = db.prepare(
          'SELECT COUNT(*) AS c FROM branches WHERE active = 1 AND id <> ?').get(id).c;
        if (!others) throw conflict('This is the only branch open — there would be nowhere to sign in.');
      }
      db.prepare(`UPDATE branches SET ${given.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...given.map((k) => row[k]), id);
    } else {
      if (!row.code || !row.name) throw badRequest('A branch needs a code and a name.');
      branchId = db.prepare(
        `INSERT INTO branches (${given.join(', ')}) VALUES (${given.map(() => '?').join(', ')})`
      ).run(...given.map((k) => row[k])).lastInsertRowid;
    }
    // Only one default, or where a new sign-in lands is a coin toss.
    if (row.is_default) db.prepare('UPDATE branches SET is_default = 0 WHERE id <> ?').run(branchId);
    return branchId;
  });
  return byId(write());
}

// =========================================================================
// Who may work where
// =========================================================================

/**
 * The branches this person may sign in to.
 *
 * The owner and the administrator see the group, because their job is the
 * group. Everybody else gets the branches they have been posted to, which
 * is normally the one on their staff record.
 */
function forUser(user) {
  if (!user) return [];
  if (SEES_ALL.includes(user.role)) return list();

  const posted = db.prepare(
    `${BRANCH.replace('SELECT', 'SELECT b.').replace(/\bFROM branches\b/, 'FROM branches b')
      .replace('b.id, b.code', 'b.id, b.code')}
       JOIN user_branches ub ON ub.branch_id = b.id
      WHERE ub.user_id = ? AND b.active = 1
      ORDER BY b.is_default DESC, b.code`).all(user.id);
  if (posted.length) return posted;

  const home = byId(user.branch_id);
  if (home && home.active) return [home];
  // Nobody has said where they work: the clinic's own branch, so that a
  // new account is not locked out of a one-branch clinic.
  const fallback = defaultBranch();
  return fallback ? [fallback] : [];
}

const mayUse = (user, branchId) => forUser(user).some((b) => b.id === Number(branchId));

/** Post a member of staff to a set of branches. */
function setUserBranches(userId, branchIds, { homeId } = {}) {
  const ids = [...new Set((branchIds || []).map(Number).filter(Boolean))];
  for (const id of ids) if (!byId(id)) throw notFound('Branch not found');

  const write = db.transaction(() => {
    db.prepare('DELETE FROM user_branches WHERE user_id = ?').run(userId);
    for (const id of ids) {
      db.prepare('INSERT OR IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)')
        .run(userId, id);
    }
    const home = homeId !== undefined ? homeId : (ids.length === 1 ? ids[0] : null);
    if (home !== undefined) {
      db.prepare('UPDATE users SET branch_id = ? WHERE id = ?').run(home || null, userId);
    }
  });
  write();
  return { branches: ids, homeId };
}

/** Where this sign-in should land before anybody has chosen. */
function landingFor(user) {
  const allowed = forUser(user);
  if (!allowed.length) return null;
  const home = allowed.find((b) => b.id === user.branch_id);
  if (home) return home;
  // One choice is not a choice; more than one and the person picks.
  return allowed.length === 1 ? allowed[0] : null;
}

/**
 * The branch this request is happening in, read back from the database.
 *
 * `attachUser` writes it into `request_context` at the start of every
 * request so the triggers can stamp it (see src/db/index.js). Anything that
 * has to know the branch before a row exists — a token's number, which
 * starts again at 001 in each waiting room — reads it back from the same
 * place rather than having it threaded through every caller.
 *
 * Safe because better-sqlite3 is synchronous and this process holds one
 * connection: nothing else can be between a request's start and its writes.
 */
function current() {
  const row = db.prepare("SELECT value FROM request_context WHERE key = 'branch_id'").get();
  const id = row && row.value ? Number(row.value) : null;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Which branch a report should cover.
 *
 * The books belong to a building. A counselor at Melapalayam asking for
 * today's takings means Melapalayam's, so the default is simply the branch
 * they are signed in to — no filter to remember, no way to read the wrong
 * place's figures by accident.
 *
 * `branchId=all` asks for the group instead, and only the owner and the
 * administrator may ask: comparing the branches is their job, and nobody
 * else's day depends on the answer.
 */
function scope(req) {
  const asked = String((req.query && req.query.branchId) || '').trim();
  const seesAll = req.user && SEES_ALL.includes(req.user.role);

  if (asked === 'all') {
    if (!seesAll) throw badRequest('You can only see your own branch.');
    return { branchId: null, all: true, branch: null };
  }
  if (asked) {
    const id = Number(asked);
    const row = byId(id);
    if (!row) throw notFound('Branch not found');
    if (!mayUse(req.user, id)) throw badRequest('You are not posted to that branch.');
    return { branchId: id, all: false, branch: row };
  }
  const here = byId(req.branchId);
  return { branchId: here ? here.id : null, all: !here, branch: here };
}

/**
 * ` AND x.branch_id = 2`, or nothing at all for the whole group.
 *
 * The number comes from `scope`, which has already checked it is a branch
 * this person may read, so putting it in the text of the statement rather
 * than binding it adds no risk and keeps the existing positional parameters
 * of every query it is appended to undisturbed.
 */
const clause = (branchId, alias) => (branchId
  ? ` AND ${alias ? `${alias}.` : ''}branch_id = ${Number(branchId)}`
  : '');

// =========================================================================
// Bringing the existing records forward
// =========================================================================

/**
 * Everything that happened before there were branches happened here.
 *
 * Run once. Each row gets the clinic's own branch, because that is where it
 * happened — the alternative is a pile of unattributed history that makes
 * every total wrong by exactly the amount the clinic earned before it
 * opened a second place.
 */
const TABLES = ['patients', 'appointments', 'visits', 'queue_tokens', 'invoices',
  'payments', 'pharmacy_sales', 'cash_book', 'expenses',
  'lab_orders', 'enquiries', 'admissions'];

function attributeExisting() {
  const home = defaultBranch();
  if (!home) return { attributed: 0 };
  const KEY = 'branches.backfilled';
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(KEY)) return { attributed: 0 };

  let total = 0;
  for (const table of TABLES) {
    const { changes } = db.prepare(`UPDATE ${table} SET branch_id = ? WHERE branch_id IS NULL`)
      .run(home.id);
    total += changes;
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(KEY, new Date().toISOString());
  return { attributed: total, branch: home.code };
}

/**
 * A record with no branch belongs to the clinic's own.
 *
 * Used by the reports rather than by a nightly repair, so a row that slips
 * through unstamped still lands in a total somewhere instead of silently
 * vanishing from every figure the owner reads.
 */
const fallbackSql = (col = 'branch_id') => {
  const home = defaultBranch();
  return home ? `COALESCE(${col}, ${home.id})` : col;
};

module.exports = {
  SEES_ALL, list, byId, defaultBranch, save,
  forUser, mayUse, setUserBranches, landingFor, current, scope, clause,
  attributeExisting, fallbackSql, TABLES,
};
