'use strict';
/**
 * The stock reconciliation statement.
 *
 * Opening stock, plus what came in, less what went out, equals closing
 * stock. Every clinic's accountant asks for it and most cannot produce it,
 * because the stock on the shelf is counted in one place and the movements
 * are written down in another, and nobody ever proves the two agree.
 *
 * Here they can be proved, because every pack that moves writes a ledger
 * row against the batch it moved from. So the statement is built twice over
 * and the two are put side by side:
 *
 *   computed  — opening value, plus purchases, less everything that left
 *   measured  — what the batches actually hold, rolled back to the date
 *
 * If those two disagree, stock changed without a movement being recorded,
 * which is a fault in the system or somebody editing the database by hand.
 * The figure is printed either way. A reconciliation that cannot come out
 * wrong is not a reconciliation.
 *
 * Everything is at cost, never at MRP: this answers "what is the clinic's
 * money sitting on the shelf", and the margin is somebody else's question.
 * A batch is valued at the cost on its most recent receipt, which is what
 * the batch record holds — where the same batch number is topped up at a
 * new price, the newer price applies to all of it.
 *
 * One thing this does NOT cover, and the omission is the point: reagents,
 * dressings, films and the rest are not inventoried by this ERP. They are
 * counted as a cost when they are bought, which is why the expense book
 * keeps them as operating costs and the pharmacy's purchases sit on a
 * schedule instead. Counting both would charge the clinic twice.
 */
const { db } = require('../db');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Stock on hand, by batch, as it stood at the end of a given day.
 *
 * Worked backwards from what is on the shelf now: take the current
 * quantity, and add back everything that has moved since. Rolling forward
 * from a historical opening figure instead would need an opening snapshot
 * that was never taken.
 */
function heldAt(dateStr) {
  return db.prepare(
    `SELECT b.id, b.drug_id, b.batch_no, b.purchase_price, b.expiry_date,
            d.name AS drug_name,
            b.qty_available - COALESCE((
              SELECT SUM(l.qty_delta) FROM stock_ledger l
               WHERE l.batch_id = b.id AND date(l.created_at) > date(?)), 0) AS qty
       FROM drug_batches b JOIN drugs d ON d.id = b.drug_id`
  ).all(dateStr);
}

const valueOf = (rows) => rows.reduce((t, b) => t + (Number(b.qty) || 0) * (Number(b.purchase_price) || 0), 0);
const unitsOf = (rows) => rows.reduce((t, b) => t + (Number(b.qty) || 0), 0);

/**
 * The movements in the window, valued at the cost of the batch they moved
 * from, split into the lines a reconciliation is read in.
 */
function movements(from, to) {
  return db.prepare(
    `SELECT l.txn_type, l.reason, l.qty_delta, l.credit_amount,
            COALESCE(b.purchase_price, 0) AS cost
       FROM stock_ledger l LEFT JOIN drug_batches b ON b.id = l.batch_id
      WHERE date(l.created_at) BETWEEN date(?) AND date(?)`
  ).all(from, to);
}

/** A line of the statement: how many units, what they cost, how many rows. */
const line = (rows, label, note) => ({
  label,
  note: note || null,
  units: r2(rows.reduce((t, m) => t + Math.abs(m.qty_delta), 0)),
  value: r2(rows.reduce((t, m) => t + Math.abs(m.qty_delta) * m.cost, 0)),
  entries: rows.length,
});

/**
 * Write the shelf down as it stands, so a later statement has something
 * independent to start from.
 *
 * Taken at the close of a day. Batch by batch rather than as one total,
 * because a figure nobody can take apart is a figure nobody can check.
 */
function takeSnapshot({ asOn, notes, userId } = {}) {
  const date = asOn || today();
  const existing = db.prepare('SELECT * FROM stock_snapshots WHERE as_on = ?').get(date);
  if (existing) return { ...existing, alreadyTaken: true };

  const batches = heldAt(date).filter((b) => Number(b.qty) > 0);
  const units = r2(unitsOf(batches));
  const value = r2(valueOf(batches));
  const unpriced = batches.filter((b) => !(Number(b.purchase_price) > 0)).length;

  const id = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO stock_snapshots (as_on, units, value, batches, unpriced, notes, taken_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(date, units, value, batches.length, unpriced, notes || null, userId || null);
    const line = db.prepare(
      `INSERT INTO stock_snapshot_lines (snapshot_id, batch_id, drug_id, qty, cost, value)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const b of batches) {
      line.run(info.lastInsertRowid, b.id, b.drug_id, r2(b.qty), b.purchase_price,
        r2(b.qty * b.purchase_price));
    }
    return info.lastInsertRowid;
  })();

  return db.prepare('SELECT * FROM stock_snapshots WHERE id = ?').get(id);
}

const snapshots = () => db.prepare(
  `SELECT s.*, u.name AS taken_by_name FROM stock_snapshots s
     LEFT JOIN users u ON u.id = s.taken_by ORDER BY date(s.as_on) DESC LIMIT 24`).all();

function statement(fromInput, toInput) {
  const to = toInput || today();
  const from = fromInput || `${to.slice(0, 7)}-01`;
  // The opening figure is the close of the day before the window starts.
  const dayBefore = new Date(`${from}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const openingDate = dayBefore.toISOString().slice(0, 10);

  /*
   * Where the opening figure comes from decides whether this statement can
   * ever be wrong.
   *
   * A snapshot is an independent record of the shelf on that date, so the
   * computed closing and the measured one can genuinely disagree, and a
   * difference means something moved without being written down.
   *
   * Without one, the opening is rolled back from today's shelf through the
   * same movements the statement adds up — the two sides are then the same
   * arithmetic and must agree, whatever has actually happened. The statement
   * is still worth reading for what it spends on and wastes; it just cannot
   * catch stock going missing, and it says so rather than implying it can.
   */
  const snapshot = db.prepare('SELECT * FROM stock_snapshots WHERE as_on = ?').get(openingDate);
  const openingBatches = heldAt(openingDate);
  const closingBatches = heldAt(to);
  const opening = snapshot
    ? { units: r2(snapshot.units), value: r2(snapshot.value), source: 'snapshot',
      takenAt: snapshot.taken_at }
    : { units: r2(unitsOf(openingBatches)), value: r2(valueOf(openingBatches)), source: 'derived' };
  const closing = { units: r2(unitsOf(closingBatches)), value: r2(valueOf(closingBatches)) };

  const all = movements(from, to);
  const of = (type, pick) => all.filter((m) => m.txn_type === type && (!pick || pick(m)));

  const purchases = line(of('purchase'), 'Purchases — stock received',
    'From the goods-received notes, at what the clinic paid.');
  const sold = line(of('sale'), 'Sold at the pharmacy counter',
    'At cost, from the batch each pack left. This is the figure that belongs in the margin.');
  const issued = line(of('ip_issue'), 'Issued to inpatients',
    'Charged to the admission rather than sold over the counter.');
  const returned = line(of('return'), 'Returned to the supplier');
  const expired = line(of('expiry', (m) => !m.reason || m.reason === 'expired'), 'Expired');
  const damaged = line(of('expiry', (m) => m.reason === 'damaged'), 'Damaged');
  const lost = line(of('expiry', (m) => ['lost', 'recalled'].includes(m.reason)), 'Lost or recalled');

  /*
   * A stock-take correction cuts both ways, so the two directions are kept
   * apart. Netting them would hide a shelf that is 40 short of one medicine
   * and 40 over on another, which is two errors and not none.
   */
  const adjustUp = of('adjustment', (m) => m.qty_delta > 0);
  const adjustDown = of('adjustment', (m) => m.qty_delta < 0);
  const foundOver = line(adjustUp, 'Found on the shelf — counted over');
  const shortages = line(adjustDown, 'Shortages — counted short');

  const inward = r2(purchases.value + foundOver.value);
  const outward = r2(sold.value + issued.value + returned.value + expired.value
    + damaged.value + lost.value + shortages.value);
  const computed = r2(opening.value + inward - outward);
  const difference = r2(closing.value - computed);

  // What the supplier has agreed to credit against what went back to them.
  const credited = r2(of('return').reduce((t, m) => t + (Number(m.credit_amount) || 0), 0));

  return {
    from,
    to,
    openingDate,
    opening,
    inwardLines: [purchases, foundOver],
    outwardLines: [sold, issued, returned, expired, damaged, lost, shortages],
    inward,
    outward,
    computed,
    closing,
    difference,
    /*
     * The one number a reader should check first. Anything but zero means
     * stock moved without the ledger being told, and the statement says so
     * in words rather than leaving a reader to subtract two columns.
     */
    reconciles: Math.abs(difference) < 0.01,
    /*
     * Whether the difference above is evidence of anything. Said plainly,
     * because a reader who takes a derived statement for a proof has been
     * misled by it.
     */
    proof: snapshot ? {
      kind: 'snapshot',
      note: `Opening stock is the count written down on ${openingDate}, so the two sides are `
        + 'independent and a difference means stock moved without a movement being recorded.',
    } : {
      kind: 'derived',
      note: `No stock was written down at the close of ${openingDate}, so the opening figure here `
        + 'is today\'s shelf rolled back through these same movements. The two sides cannot '
        + 'disagree, and the difference line proves nothing. Close a period — the button on this '
        + 'screen — and from the next one it will.',
    },
    returns: {
      value: returned.value,
      credited,
      uncredited: r2(returned.value - credited),
      note: 'What the supplier has agreed to credit, against what was sent back at cost.',
    },
    wastage: {
      value: r2(expired.value + damaged.value + lost.value),
      ofPurchases: purchases.value > 0
        ? r2(((expired.value + damaged.value + lost.value) / purchases.value) * 100) : 0,
      note: 'Expired, damaged, lost or recalled, as a share of what was bought in the window.',
    },
    /*
     * Where the money on the shelf is sitting, because a closing figure on
     * its own does not say whether it is about to be written off.
     */
    atRisk: (() => {
      const soon = new Date(`${to}T00:00:00Z`);
      soon.setUTCDate(soon.getUTCDate() + 90);
      const limit = soon.toISOString().slice(0, 10);
      const expiring = closingBatches.filter((b) => b.qty > 0 && b.expiry_date <= limit);
      return {
        value: r2(valueOf(expiring)),
        batches: expiring.length,
        note: 'On the shelf at the closing date and out of date within ninety days of it.',
      };
    })(),
    // The handful of batches that make up most of the closing value, which
    // is what anybody checking a count actually walks to the shelf with.
    largest: closingBatches
      .filter((b) => b.qty > 0)
      .map((b) => ({
        drug: b.drug_name, batch: b.batch_no, qty: r2(b.qty),
        cost: b.purchase_price, value: r2(b.qty * b.purchase_price), expiry: b.expiry_date,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12),
    /*
     * The caveat that decides whether the value column means anything.
     *
     * A batch taken in without a cost price values at nothing, so every
     * pack of it that moves is free and every pack of it on the shelf is
     * worth nothing. The statement still balances — zero against zero —
     * and that is precisely the danger: it looks right and understates the
     * clinic's stock by whatever those batches are really worth. So the
     * count is reported beside the figure rather than left to be noticed.
     */
    unpriced: (() => {
      const held = closingBatches.filter((b) => b.qty > 0 && !(Number(b.purchase_price) > 0));
      const moved = all.filter((m) => !(Number(m.cost) > 0)).length;
      return {
        batches: held.length,
        units: r2(unitsOf(held)),
        movements: moved,
        note: held.length
          ? 'These have no cost price on the batch, so they are valued at nothing here and the '
            + 'closing figure is understated. Put the rate against them under Pharmacy → '
            + 'Opening stock → "No rate set".'
          : null,
      };
    })(),
    note: 'At cost, never at MRP. Medicines only: reagents, films and dressings are not '
      + 'inventoried — they are counted as a cost when they are bought.',
  };
}

module.exports = { statement, heldAt, takeSnapshot, snapshots };
