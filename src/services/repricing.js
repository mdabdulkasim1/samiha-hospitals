'use strict';
const { db } = require('../db');
const billing = require('./billing');

/**
 * Bringing bills that are still owing onto the current rate card.
 *
 * The rule is narrow on purpose. A settled bill is a document the patient
 * holds, against money the clinic actually took, and editing it would leave
 * the invoice, the receipt and the day book disagreeing with one another —
 * under GST a settled tax invoice is corrected with a credit note, not a
 * rewrite. So this touches only what is still owed.
 *
 * Two kinds of line are left alone even on an unpaid bill. A bed and the
 * nursing on it were priced when the patient was admitted and the stay is
 * still running; and a medicine is billed at the MRP printed on the pack that
 * was dispensed, which is a fact about that pack rather than a tariff.
 *
 * The interesting part is the concessions, and they divide by who agreed them:
 *
 *   sliding scale, assistance — the clinic's own, and held as a percentage.
 *                               Re-applied at the new figures, so a band-B
 *                               patient gets band B of the cheaper bill.
 *   insurer, cashier's own     — somebody else's agreement about a specific
 *                               rupee amount on the bill as it stood. Not
 *                               ours to recompute, so those bills are handed
 *                               back for a person to look at.
 */

/** What the rate card says a line should cost now, or null if it does not say. */
function tariffFor(item, invoice) {
  if (item.ref_type === 'service' && item.ref_id) {
    const row = db.prepare('SELECT price FROM services WHERE id = ? AND active = 1').get(item.ref_id);
    return row && row.price > 0 ? row.price : null;
  }
  if (item.ref_type === 'lab' && item.ref_id) {
    const row = db.prepare(
      `SELECT t.price FROM lab_order_items i JOIN lab_tests t ON t.id = i.test_id
        WHERE i.id = ? AND t.active = 1`
    ).get(item.ref_id);
    return row && row.price > 0 ? row.price : null;
  }
  if (item.ref_type === 'consultation') {
    // New patient or follow-up is a fact about the visit, not about the line.
    const visit = invoice.visit_id
      ? db.prepare('SELECT is_new_patient FROM visits WHERE id = ?').get(invoice.visit_id)
      : null;
    const code = visit && !visit.is_new_patient ? 'CONS-FU' : 'CONS-NEW';
    const row = db.prepare('SELECT price FROM services WHERE code = ? AND active = 1').get(code);
    return row && row.price > 0 ? row.price : null;
  }
  return null;
}

/** Thrown to unwind the rehearsal in plan(); never escapes this module. */
class Rehearsal extends Error {}

/**
 * Do the work. Called for real by apply(), and by plan() inside a transaction
 * that is then thrown away — so a preview is the same walk as the change, and
 * cannot promise a figure the apply then declines to produce.
 */
function reprice(actorId) {
  const invoices = db.prepare(
    `SELECT id, invoice_no, patient_id, visit_id, kind, net, paid, balance, status,
            bill_discount, sliding_discount, assistance_covered, insurance_covered
       FROM invoices
      WHERE status NOT IN ('cancelled', 'written_off') AND balance > 0.009
      ORDER BY id`
  ).all();

  const changed = [];
  const skipped = [];

  for (const inv of invoices) {
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(inv.id);
    const lines = [];
    for (const it of items) {
      const now = tariffFor(it, inv);
      if (now === null || Math.abs(now - it.unit_price) < 0.005) continue;
      lines.push({ itemId: it.id, refId: it.ref_id, refType: it.ref_type,
        description: it.description, was: it.unit_price, now, qty: it.qty });
    }
    if (!lines.length) continue;

    const patient = db.prepare(
      "SELECT uhid, (first_name || ' ' || COALESCE(last_name,'')) AS name FROM patients WHERE id = ?"
    ).get(inv.patient_id);
    const who = {
      id: inv.id, invoiceNo: inv.invoice_no, kind: inv.kind, status: inv.status,
      patient: patient ? patient.name : '—', uhid: patient ? patient.uhid : '—',
      net: inv.net, paid: inv.paid,
    };

    // Somebody else's rupee agreement about this bill as it stands.
    if (inv.insurance_covered > 0.009 || inv.bill_discount > 0.009) {
      skipped.push({ ...who, reason: inv.insurance_covered > 0.009
        ? 'An insurer approved a figure against this bill as it stands. Repricing it is between the clinic and the insurer.'
        : 'The counter agreed a rupee discount on this bill. Re-agree it with the patient at the new rates.' });
      continue;
    }

    for (const l of lines) {
      db.prepare('UPDATE invoice_items SET unit_price = ? WHERE id = ?').run(l.now, l.itemId);
      // A diagnostic's rate lives in two places; leaving them disagreeing
      // would have the lab order and the bill telling different stories.
      if (l.refType === 'lab' && l.refId) {
        db.prepare('UPDATE lab_order_items SET price = ? WHERE id = ?').run(l.now, l.refId);
      }
    }
    billing.recalc(inv.id);

    /*
     * The clinic's own concessions, agreed again at the new figures. Both are
     * held as a percentage on the patient's completed screening, so this is
     * re-applying what was agreed rather than inventing anything.
     */
    const screening = db.prepare(
      "SELECT * FROM financial_screenings WHERE patient_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1"
    ).get(inv.patient_id);
    if (inv.sliding_discount > 0.009 && screening && screening.discount_pct > 0) {
      billing.applySlidingScale(inv.id, screening.discount_pct);
    }
    if (inv.assistance_covered > 0.009 && screening && screening.assistance_program_id) {
      const program = db.prepare('SELECT * FROM assistance_programs WHERE id = ?')
        .get(screening.assistance_program_id);
      if (program && program.coverage_pct > 0) {
        const fresh = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
        const base = Math.max(fresh.gross - fresh.discount - fresh.sliding_discount, 0);
        billing.applyAssistance(inv.id, base * (program.coverage_pct / 100));
      }
    }

    const after = db.prepare('SELECT net, paid, balance FROM invoices WHERE id = ?').get(inv.id);
    changed.push({ ...who, newNet: after.net, delta: billing.round2(after.net - inv.net), lines });

    if (actorId && inv.visit_id) {
      db.prepare(
        "INSERT INTO visit_events (visit_id, stage, detail, actor_id) VALUES (?, 'repriced', ?, ?)"
      ).run(inv.visit_id, `${inv.invoice_no} brought onto the current rate card`, actorId);
    }
  }

  return {
    invoices: changed,
    skipped,
    totals: {
      invoices: changed.length,
      lines: changed.reduce((t, c) => t + c.lines.length, 0),
      was: billing.round2(changed.reduce((t, c) => t + c.net, 0)),
      becomes: billing.round2(changed.reduce((t, c) => t + c.newNet, 0)),
      delta: billing.round2(changed.reduce((t, c) => t + c.delta, 0)),
    },
  };
}

/** What would change, without changing it. */
function plan() {
  let result = null;
  try {
    db.transaction(() => { result = reprice(null); throw new Rehearsal(); })();
  } catch (err) {
    if (!(err instanceof Rehearsal)) throw err;
  }
  return result;
}

/** The same walk, kept. */
function apply(actorId) {
  return db.transaction(() => reprice(actorId))();
}

module.exports = { plan, apply, tariffFor };
