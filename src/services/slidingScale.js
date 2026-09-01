'use strict';
const { db } = require('../db');

/**
 * Financial screening maths, mirroring the "Determine Sliding Scale Position"
 * branch of the clinic workflow.
 *
 * FPL% = household annual income as a percentage of the poverty guideline for
 * that household size. Bands then map an FPL% to a discount and a flat
 * consultation fee.
 */

function povertyLineFor(householdSize) {
  const size = Math.max(1, Math.trunc(householdSize || 1));
  const exact = db.prepare('SELECT annual_income FROM poverty_guidelines WHERE household_size = ?').get(size);
  if (exact) return exact.annual_income;
  // Extrapolate beyond the table using the average increment per extra member.
  const rows = db.prepare('SELECT household_size, annual_income FROM poverty_guidelines ORDER BY household_size').all();
  if (!rows.length) return 0;
  const last = rows[rows.length - 1];
  const first = rows[0];
  const step = rows.length > 1
    ? (last.annual_income - first.annual_income) / (last.household_size - first.household_size)
    : 0;
  return last.annual_income + step * (size - last.household_size);
}

function fplPercent(annualIncome, householdSize) {
  const line = povertyLineFor(householdSize);
  if (!line) return null;
  return Math.round((Number(annualIncome || 0) / line) * 10000) / 100;
}

function bandFor(fplPct) {
  if (fplPct === null || fplPct === undefined) return null;
  return db.prepare(
    `SELECT * FROM sliding_scale_bands
      WHERE active = 1 AND fpl_min <= ? AND fpl_max >= ?
      ORDER BY fpl_min LIMIT 1`
  ).get(fplPct, fplPct) || null;
}

/** Programs the patient qualifies for, given their FPL% and insurance status. */
function eligiblePrograms(fplPct, uninsured) {
  const rows = db.prepare('SELECT * FROM assistance_programs WHERE active = 1 ORDER BY coverage_pct DESC').all();
  return rows.filter((p) => {
    if (p.max_fpl_pct !== null && p.max_fpl_pct !== undefined && fplPct !== null) {
      if (fplPct > p.max_fpl_pct) return false;
    }
    if (p.code === 'UNINS' && !uninsured) return false;
    return true;
  });
}

/**
 * Full assessment used by the counselor screen and the WhatsApp/self-serve flow.
 * Without proof of income the workflow cannot assign a band — the patient is
 * held at "docs_pending" instead.
 */
function assess({ annualIncome, householdSize, uninsured = true, hasProof = false }) {
  const fpl = fplPercent(annualIncome, householdSize);
  const band = hasProof ? bandFor(fpl) : null;
  const programs = eligiblePrograms(fpl, uninsured);
  return {
    povertyLine: povertyLineFor(householdSize),
    fplPct: fpl,
    band: band ? band.band : null,
    discountPct: band ? band.discount_pct : 0,
    flatConsultFee: band ? band.flat_consult_fee : null,
    eligiblePrograms: programs.map((p) => ({
      id: p.id, code: p.code, name: p.name,
      coveragePct: p.coverage_pct, description: p.description,
    })),
    requiresDocuments: !hasProof,
  };
}

module.exports = { povertyLineFor, fplPercent, bandFor, eligiblePrograms, assess };
