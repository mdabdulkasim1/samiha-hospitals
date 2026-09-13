'use strict';

/**
 * Reading a reference range that was written for a human.
 *
 * Most of the catalogue carries a numeric low and high, and results are
 * flagged against those. But a good many tests publish their range as the
 * clinical cut-off instead — "< 150 normal · 150–199 borderline high" for
 * triglycerides, "> 90" for eGFR — because that is how the guideline states
 * it and how the report should print it.
 *
 * Those tests had no numeric bounds at all, and the flagging code only
 * compares against numbers. So every value came back "normal": an LDL of 250
 * printed with a green Normal beside it. Deriving the bounds from the text the
 * clinic already publishes fixes that without asking anybody to retype a
 * catalogue, and without replacing the text, which stays as what prints.
 *
 * The direction of a cut-off cannot be taken from the operator alone. For
 * cholesterol "< 200" is the desirable end; for HDL "< 34.7 undesirable, high
 * risk" the same operator marks the dangerous end, because low HDL is the
 * problem. The word attached to the number is what settles it.
 */

// Words that mark a clause as describing the abnormal side of a cut-off.
const BAD = /\b(undesirable|borderline|high risk|very high|high|low risk|low|abnormal|elevated|deficient|positive|risk)\b/i;
// …and the desirable side. Checked first: "low risk" is a good thing to be at.
const GOOD = /\b(desirable|optimal|normal|adequate|sufficient|target)\b/i;

const NUM = '(-?\\d+(?:\\.\\d+)?)';

/** Split on the separators the catalogue uses between clauses. */
const clausesOf = (text) => String(text).split(/·|;|•/).map((s) => s.trim()).filter(Boolean);

/**
 * Which side of the cut-off this clause is describing.
 * Returns 'good' when the clause names the acceptable region, 'bad' when it
 * names the abnormal one, and 'good' by default — an unqualified "< 55" is the
 * ordinary way to write an upper limit of normal.
 *
 * The whole clause is read, because the qualifier sits on either side of the
 * number depending on how the guideline is phrased: "Desirable < 200" puts it
 * first, "< 34.7 undesirable" puts it last.
 *
 * "low risk" and "high risk" both contain a word this would otherwise read as
 * abnormal, so the desirable test runs first: "> 77.3 desirable, low risk" is
 * the good end of an HDL.
 */
function sideOf(clause) {
  if (GOOD.test(clause)) return 'good';
  if (BAD.test(clause)) return 'bad';
  return 'good';
}

/**
 * Derive `{ low, high }` from a written range, or nulls where it says nothing
 * numeric. Qualitative ranges — "Negative", "Clear and transparent" — yield
 * nothing, which is right: those results are words and are not flagged by
 * comparison.
 */
function parse(text) {
  const out = { low: null, high: null };
  if (!text) return out;

  for (const clause of clausesOf(text)) {
    // "0.9 – 1.2", "100–129": a bounded interval. Only the first is taken as
    // the normal one; the rest of a banded range describes worsening grades.
    const band = clause.match(new RegExp(`${NUM}\\s*[–—-]\\s*${NUM}`));
    if (band && out.low === null && out.high === null && !BAD.test(clause)) {
      out.low = Number(band[1]);
      out.high = Number(band[2]);
      continue;
    }

    const below = clause.match(new RegExp(`[<≤]\\s*${NUM}([^·;]*)`));
    if (below) {
      const n = Number(below[1]);
      // Below the cut-off is good → it is a ceiling. Below it is bad → a floor.
      if (sideOf(clause) === 'good') {
        if (out.high === null) out.high = n;
      } else if (out.low === null) out.low = n;
      continue;
    }

    const above = clause.match(new RegExp(`[>≥]\\s*${NUM}([^·;]*)`));
    if (above) {
      const n = Number(above[1]);
      // Above the cut-off is good → it is a floor. Above it is bad → a ceiling.
      if (sideOf(clause) === 'good') {
        if (out.low === null) out.low = n;
      } else if (out.high === null) out.high = n;
    }
  }
  return out;
}

module.exports = { parse };
