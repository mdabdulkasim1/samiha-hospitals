'use strict';
/**
 * The shelf itself: every report, in one list, with the six already built
 * into the Commercial eye cross-referenced rather than duplicated.
 *
 * A report that exists in two places drifts into two answers, and the owner
 * has no way to tell which is right. So the department board, the budget
 * comparison, the indicators, break-even and the pharmacy margin stay where
 * they were built and appear here only as a pointer.
 */
const registry = require('./registry');
const money = require('./money');

const { T, GROUPS } = registry;

/**
 * Reports that live on the Commercial eye tab. Listed so the shelf is a
 * complete answer to "what can this system tell me", and marked so nobody
 * goes looking for a second copy.
 */
const ELSEWHERE = [
  { key: 'ce-departments', group: 'money', title: 'Department-wise cost vs revenue',
    subtitle: 'Contribution and operating profit by department', at: 'commercial' },
  { key: 'ce-pharmacy', group: 'money', title: 'Pharmacy gross profit and margin',
    subtitle: 'The one margin measured exactly, from the batch each pack left', at: 'commercial' },
  { key: 'ce-budget', group: 'accounts', title: 'Budget vs actual revenue and expenses',
    subtitle: 'Every line, against budget and against last month', at: 'commercial' },
  { key: 'ce-breakeven', group: 'accounts', title: 'Break-even revenue and profitability',
    subtitle: 'What the month had to earn before the clinic earned anything', at: 'commercial' },
  { key: 'ce-indicators', group: 'accounts', title: 'Cost-to-revenue indicators',
    subtitle: 'Nine ratios, each with the figures behind it', at: 'commercial' },
  { key: 'ce-overview', group: 'operations', title: 'Owner\'s dashboard — daily, weekly, monthly',
    subtitle: 'Sale against cost, visits, and what the clinic is worth', at: 'overview' },
];

const ALL = [
  ...registry.OPERATIONS,
  ...registry.CLINICAL,
  ...money.STOCK,
  ...money.PEOPLE,
  ...money.MONEY,
  ...money.ACCOUNTS,
];

const byKey = {};
for (const r of ALL) byKey[r.key] = r;

/** The shelf as the screen draws it: groups, with what each report needs. */
function index() {
  const cards = ALL.map((r) => {
    let needs = null;
    try { needs = r.needs ? r.needs() : null; } catch (err) { needs = `Could not be checked: ${err.message}`; }
    return { key: r.key, group: r.group, title: r.title, subtitle: r.subtitle, needs };
  }).concat(ELSEWHERE.map((r) => ({ ...r, needs: null })));

  return GROUPS.map((g) => ({
    ...g,
    reports: cards.filter((c) => c.group === g.key),
  })).filter((g) => g.reports.length);
}

/** Run one report over a window. Throws if the key is not on the shelf. */
function run(key, { from, to, period }) {
  const report = byKey[key];
  if (!report) return null;
  const needs = report.needs ? report.needs() : null;
  if (needs) {
    return { key, title: report.title, subtitle: report.subtitle, needs, columns: [], rows: [] };
  }
  const out = report.run({ from, to, period });
  return {
    key,
    title: report.title,
    subtitle: report.subtitle,
    from,
    to,
    period,
    tiles: [],
    lists: [],
    notes: [],
    ...out,
  };
}

module.exports = { T, GROUPS, ALL, ELSEWHERE, index, run, POSITION_LINES: money.POSITION_LINES };
