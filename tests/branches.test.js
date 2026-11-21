'use strict';
/**
 * The clinic as a group of places.
 *
 * Four things are tested here, and each one fails in a different way.
 *
 * The stamping, because it is the foundation and the only failure nobody
 * notices. A row written with no branch on it does not break a screen — it
 * simply stops appearing in the figures the owner reads, quietly and for
 * ever. So the tests sign in at one branch, record real work, and insist the
 * database has the right branch against it.
 *
 * The scoping, because a receptionist at Melapalayam reading a visit count
 * that silently included the other place would be looking at a number that
 * matches nothing in front of her.
 *
 * The door, because "all the users have to select the branch" is a rule, not
 * a convenience: somebody posted to one branch must not be able to stand in
 * another, and nobody may record anything before they have said where they
 * are.
 *
 * And the owner's comparison, because the whole reason for a second branch
 * is being able to tell whether it pays for itself. Group totals never say.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samiha-branches-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BACKUP_HOUR = '';

require('../src/db/seed');
require('../src/db/catalogue').sync({ quiet: true });
const { db } = require('../src/db');
const branches = require('../src/services/branches');
const app = require('../src/server');

let server;
let base;
const tokens = {};
const ids = {};

async function api(method, p, body, as = 'admin') {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(as && tokens[as] ? { Authorization: `Bearer ${tokens[as]}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const signIn = async (as, username, password = 'samiha@123') => {
  const r = await api('POST', '/api/auth/login', { username, password }, null);
  assert.strictEqual(r.status, 200, `${as} could not sign in: ${JSON.stringify(r.body)}`);
  tokens[as] = r.body.token;
  return r.body;
};

const stand = (as, branchId) => api('POST', '/api/auth/branch', { branchId }, as);

const DAY = '2026-03-10';

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await signIn('admin', 'admin@samiha.local');
  await signIn('reception', 'reception@samiha.local');
  await signIn('counselor', 'counselor@samiha.local');

  // The seed ships no owner — requireOwner does not let an administrator
  // through, which is the whole point of that gate.
  const made = await api('POST', '/api/masters/staff', {
    name: 'The owner', role: 'owner', email: 'owner@samiha.local', password: 'Samiha#2026',
  }, 'admin');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  await signIn('owner', 'owner@samiha.local', 'Samiha#2026');

  ids.home = branches.defaultBranch().id;
  ids.doctor = db.prepare("SELECT id, department_id FROM users WHERE role = 'doctor' AND active = 1").get();
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ============================================================ one place, today
test('the clinic starts as one place, and nobody is asked to choose', async () => {
  const me = await api('GET', '/api/auth/me', undefined, 'reception');
  assert.strictEqual(me.status, 200);
  assert.ok(me.body.branch, 'the receptionist should land somewhere');
  assert.strictEqual(me.body.needsBranch, false,
    'with one branch there is nothing to choose and nobody should be stopped');
  assert.strictEqual(me.body.branch.id, ids.home);
});

test('what is recorded is stamped with the branch it was recorded in', async () => {
  const made = await api('POST', '/api/patients', {
    firstName: 'Branch', lastName: 'One', gender: 'male', age: 30,
    phone: '9000000501', consentTreatment: true,
  }, 'reception');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  ids.patient = made.body.id;

  const row = db.prepare('SELECT branch_id FROM patients WHERE id = ?').get(ids.patient);
  assert.strictEqual(row.branch_id, ids.home,
    'a patient registered at the one branch there is belongs to it');
});

// ================================================================ a second place
test('a branch needs a short code, and the code has to be free', async () => {
  const bad = await api('POST', '/api/branches', { code: 'CHERANMAHADEVI', name: 'Too long' });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /two to four letters/i);

  const home = branches.defaultBranch();
  const clash = await api('POST', '/api/branches', { code: home.code, name: 'Another one' });
  assert.strictEqual(clash.status, 409);
});

test('the owner opens a second branch', async () => {
  const made = await api('POST', '/api/branches', {
    code: 'CH', name: 'Samiha Healthcare, Cheranmahadevi', address: 'Cheranmahadevi',
  }, 'owner');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  ids.ch = made.body.id;
  assert.strictEqual(made.body.code, 'CH');
  assert.strictEqual(made.body.active, 1);

  // The first branch stays where sign-ins land until somebody says otherwise.
  assert.strictEqual(branches.defaultBranch().id, ids.home);
});

test('the last branch open cannot be closed', async () => {
  const shut = await api('PATCH', `/api/branches/${ids.ch}`, { active: false });
  assert.strictEqual(shut.status, 200, 'a branch that closes may be marked closed');

  const last = await api('PATCH', `/api/branches/${ids.home}`, { active: false });
  assert.strictEqual(last.status, 409, 'there has to be somewhere to sign in tomorrow');
  assert.match(last.body.error, /only branch open/i);

  // Closing keeps the history: the patient registered there a moment ago is
  // still there, still attributed to it.
  assert.strictEqual(
    db.prepare('SELECT branch_id FROM patients WHERE id = ?').get(ids.patient).branch_id,
    ids.home);

  // And put the clinic back as it was, two branches, both open.
  assert.strictEqual((await api('PATCH', `/api/branches/${ids.ch}`, { active: true })).status, 200);
});

// ============================================================== who stands where
test('the owner and the administrator may stand in either branch', async () => {
  for (const as of ['owner', 'admin']) {
    const me = await api('GET', '/api/auth/me', undefined, as);
    assert.strictEqual(me.body.branches.length, 2, `${as} should see both branches`);
    assert.strictEqual((await stand(as, ids.ch)).status, 200);
    assert.strictEqual((await api('GET', '/api/auth/me', undefined, as)).body.branch.id, ids.ch);
    assert.strictEqual((await stand(as, ids.home)).status, 200);
  }
});

test('a receptionist posted to one branch cannot stand in the other', async () => {
  const reception = db.prepare("SELECT id FROM users WHERE email = 'reception@samiha.local'").get();
  const posted = await api('POST', `/api/branches/staff/${reception.id}`,
    { branchIds: [ids.home], homeId: ids.home });
  assert.strictEqual(posted.status, 200, JSON.stringify(posted.body));

  const refused = await stand('reception', ids.ch);
  assert.strictEqual(refused.status, 403, 'she does not work there');
  assert.match(refused.body.error, /not posted/i);

  const signin = await signIn('reception', 'reception@samiha.local');
  assert.strictEqual(signin.branches.length, 1);
  assert.strictEqual(signin.branch.id, ids.home, 'she lands where she is posted');
  assert.strictEqual(signin.needsBranch, false);
});

test('somebody who covers both branches is asked which, and may not record until they say',
  async () => {
    const doctor = db.prepare(
      "SELECT id, email FROM users WHERE role = 'doctor' AND email IS NOT NULL").get();
    assert.ok(doctor, 'the seed ships a doctor with an email');
    const posted = await api('POST', `/api/branches/staff/${doctor.id}`,
      { branchIds: [ids.home, ids.ch], homeId: null });
    assert.strictEqual(posted.status, 200, JSON.stringify(posted.body));

    const signin = await signIn('both', doctor.email);
    assert.strictEqual(signin.needsBranch, true,
      'two places and no home branch is a question, not a default');
    assert.strictEqual(signin.branch, null);
    assert.strictEqual(signin.branches.length, 2);

    // Nothing may be written in the meantime: an unstamped row would vanish
    // from the owner's figures and nothing would ever say so.
    const early = await api('POST', '/api/me/leave', { date: DAY, reason: 'Away' }, 'both');
    assert.strictEqual(early.status, 409, JSON.stringify(early.body));
    assert.strictEqual(early.body.needsBranch, true);

    assert.strictEqual((await stand('both', ids.ch)).status, 200);
    const after = await api('GET', '/api/auth/me', undefined, 'both');
    assert.strictEqual(after.body.branch.id, ids.ch);
    assert.strictEqual(after.body.needsBranch, false);
  });

// ================================================== what happens at each branch
test('a day at each branch is recorded against the branch it happened at', async () => {
  // Melapalayam: the patient registered earlier walks in.
  assert.strictEqual((await stand('admin', ids.home)).status, 200);
  const hereVisit = await api('POST', '/api/visits/arrive',
    { patientId: ids.patient, doctorId: ids.doctor.id }, 'admin');
  assert.strictEqual(hereVisit.status, 201, JSON.stringify(hereVisit.body));
  ids.homeVisit = hereVisit.body.visit.id;

  // Cheranmahadevi: a patient of its own, and a visit.
  assert.strictEqual((await stand('admin', ids.ch)).status, 200);
  const made = await api('POST', '/api/patients', {
    firstName: 'Branch', lastName: 'Two', gender: 'female', age: 41,
    phone: '9000000502', consentTreatment: true,
  }, 'admin');
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  ids.chPatient = made.body.id;
  const thereVisit = await api('POST', '/api/visits/arrive',
    { patientId: ids.chPatient, doctorId: ids.doctor.id }, 'admin');
  assert.strictEqual(thereVisit.status, 201, JSON.stringify(thereVisit.body));
  ids.chVisit = thereVisit.body.visit.id;

  const branchOf = (table, id) =>
    db.prepare(`SELECT branch_id FROM ${table} WHERE id = ?`).get(id).branch_id;

  assert.strictEqual(branchOf('visits', ids.homeVisit), ids.home);
  assert.strictEqual(branchOf('visits', ids.chVisit), ids.ch);
  assert.strictEqual(branchOf('patients', ids.chPatient), ids.ch,
    'a patient first seen at the new place is registered there');
});

test('the board at one branch does not show the other branch\'s patients', async () => {
  assert.strictEqual((await stand('admin', ids.home)).status, 200);
  const here = await api('GET', '/api/visits/board', undefined, 'admin');
  assert.strictEqual(here.status, 200);
  const ours = JSON.stringify(here.body);
  assert.ok(ours.includes('Branch One') || here.body.rows.some((r) => r.id === ids.homeVisit),
    'Melapalayam\'s own visit should be on Melapalayam\'s board');
  assert.ok(!here.body.rows.some((r) => r.id === ids.chVisit),
    'the other branch\'s visit has no business on this board');

  assert.strictEqual((await stand('admin', ids.ch)).status, 200);
  const there = await api('GET', '/api/visits/board', undefined, 'admin');
  assert.ok(there.body.rows.some((r) => r.id === ids.chVisit));
  assert.ok(!there.body.rows.some((r) => r.id === ids.homeVisit));
});

test('the dashboard counts the branch the person is standing in', async () => {
  const today = new Date().toISOString().slice(0, 10);

  assert.strictEqual((await stand('admin', ids.home)).status, 200);
  const here = await api('GET', `/api/reports/dashboard?date=${today}`, undefined, 'admin');
  assert.strictEqual(here.status, 200);

  assert.strictEqual((await stand('admin', ids.ch)).status, 200);
  const there = await api('GET', `/api/reports/dashboard?date=${today}`, undefined, 'admin');

  assert.strictEqual(here.body.opd.visits, 1, 'one visit at Melapalayam today');
  assert.strictEqual(there.body.opd.visits, 1, 'one visit at Cheranmahadevi today');
  assert.strictEqual(there.body.patients.registeredToday, 1,
    'and the new branch registered exactly its own one patient');
});

test('each waiting room calls its own numbers from 001', async () => {
  /*
   * Two branches sharing one series would have the new place opening its
   * morning by calling 08-014, and a patient holding 08-002 watching a
   * board that is never going to reach them.
   */
  const seqOf = (visitId) => db.prepare(
    `SELECT t.seq, t.label, t.branch_id FROM queue_tokens t WHERE t.visit_id = ?`).get(visitId);

  const here = seqOf(ids.homeVisit);
  const there = seqOf(ids.chVisit);
  assert.ok(here, 'the Melapalayam arrival was given a token');
  assert.ok(there, 'and so was the one at the new branch');
  assert.strictEqual(here.branch_id, ids.home);
  assert.strictEqual(there.branch_id, ids.ch);
  assert.strictEqual(here.seq, 1, 'the first of the day at Melapalayam');
  assert.strictEqual(there.seq, 1, 'and the first of the day at Cheranmahadevi');
  assert.strictEqual(here.label, there.label,
    'the same specialty, the same number — in two different waiting rooms');
});

// ============================================================== the owner's board
test('the owner is shown each branch beside the other', async () => {
  // A trading day at each place, planted directly so the arithmetic is
  // checkable: Melapalayam takes 1,000 and spends 400; the new branch takes
  // 500 and spends 600, so it loses 100 on its first day.
  const money = (branchId, takings, spend, ref) => {
    db.prepare(`INSERT INTO cash_book (ref_no, direction, category, amount, entry_date, mode, branch_id)
                VALUES (?, 'in', 'Other income', ?, ?, 'cash', ?)`)
      .run(`BR-IN-${ref}`, takings, DAY, branchId);
    db.prepare(`INSERT INTO cash_book (ref_no, direction, category, amount, entry_date, mode, branch_id)
                VALUES (?, 'out', 'Rent', ?, ?, 'cash', ?)`)
      .run(`BR-OUT-${ref}`, spend, DAY, branchId);
  };
  money(ids.home, 1000, 400, 'MPM');
  money(ids.ch, 500, 600, 'CH');

  const board = await api('GET',
    `/api/owner/overview?by=day&from=${DAY}&to=${DAY}`, undefined, 'owner');
  assert.strictEqual(board.status, 200, JSON.stringify(board.body));

  const rows = board.body.byBranch;
  assert.strictEqual(rows.length, 2, 'both branches, whatever the filter is set to');
  const mpm = rows.find((r) => r.id === ids.home);
  const ch = rows.find((r) => r.id === ids.ch);

  assert.strictEqual(mpm.sale, 1000);
  assert.strictEqual(mpm.cost, 400);
  assert.strictEqual(mpm.profit, 600);
  assert.strictEqual(ch.sale, 500);
  assert.strictEqual(ch.cost, 600);
  assert.strictEqual(ch.profit, -100, 'the new branch lost money on its first day, and says so');

  // The two together are the headline, so the owner cannot be shown a
  // comparison that disagrees with the total above it.
  assert.strictEqual(board.body.totals.sale, 1500);
  assert.strictEqual(board.body.totals.profit, 500);
});

test('the owner can look at one branch on its own', async () => {
  const only = await api('GET',
    `/api/owner/overview?by=day&from=${DAY}&to=${DAY}&branchId=${ids.ch}`, undefined, 'owner');
  assert.strictEqual(only.status, 200);
  assert.strictEqual(only.body.branch.id, ids.ch);
  assert.strictEqual(only.body.totals.sale, 500, 'only the new branch\'s takings');
  assert.strictEqual(only.body.totals.profit, -100);
  assert.strictEqual(only.body.byBranch.length, 2,
    'the comparison stays whole — a one-row comparison answers nothing');
});

// =============================================================== the cash book
test('the day book is the branch\'s day book', async () => {
  assert.strictEqual((await stand('counselor', ids.ch)).status, 403,
    'the counsellor has not been posted to the second branch');

  const asOwnerHere = await stand('owner', ids.home);
  assert.strictEqual(asOwnerHere.status, 200);
  const here = await api('GET',
    `/api/accounts/summary?by=day&from=${DAY}&to=${DAY}`, undefined, 'owner');
  assert.strictEqual(here.status, 200);
  assert.strictEqual(here.body.totals.otherIncome, 1000);
  assert.strictEqual(here.body.totals.expense, 400);
  assert.strictEqual(here.body.branch.id, ids.home);

  assert.strictEqual((await stand('owner', ids.ch)).status, 200);
  const there = await api('GET',
    `/api/accounts/summary?by=day&from=${DAY}&to=${DAY}`, undefined, 'owner');
  assert.strictEqual(there.body.totals.otherIncome, 500);
  assert.strictEqual(there.body.totals.expense, 600);
  assert.strictEqual(there.body.totals.net, -100);

  const group = await api('GET',
    `/api/accounts/summary?by=day&from=${DAY}&to=${DAY}&branchId=all`, undefined, 'owner');
  assert.strictEqual(group.body.totals.otherIncome, 1500);
  assert.strictEqual(group.body.totals.expense, 1000);
  assert.strictEqual(group.body.branch, null);
});

test('only the owner and the administrator may ask for the group total', async () => {
  const refused = await api('GET',
    `/api/accounts/summary?by=day&from=${DAY}&to=${DAY}&branchId=all`, undefined, 'counselor');
  assert.strictEqual(refused.status, 400);
  assert.match(refused.body.error, /your own branch/i);
});

// ================================================== bringing the history forward
test('history from before there were branches is brought forward, once', () => {
  const orphans = () => branches.TABLES.reduce((total, table) => total
    + db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE branch_id IS NULL`).get().c, 0);

  /*
   * The clinic has been running for months before any of this existed, so
   * its records carry no branch. They are not "unknown" — they happened at
   * Melapalayam — and left as they are they would be missing from every
   * figure the owner reads, silently and for ever.
   *
   * This runs at boot in a real deployment (seedIfEmpty in src/server.js);
   * here it is called directly, which is also the only way to watch it do
   * its work.
   */
  assert.ok(orphans() > 0, 'the seeded history starts out unattributed');
  const first = branches.attributeExisting();
  assert.ok(first.attributed > 0, 'and the backfill claims it');
  assert.strictEqual(first.branch, branches.defaultBranch().code);
  assert.strictEqual(orphans(), 0, 'every record now belongs to a branch');

  // And it does not run twice, or a record moved to the new branch by hand
  // would be dragged home again at the next restart.
  assert.deepStrictEqual(branches.attributeExisting(), { attributed: 0 });
  assert.strictEqual(orphans(), 0);
});
