'use strict';
/*
 * How a selling rate is arrived at.
 *
 * A rate quoted to a client is not the manufacturer's price. It is that price
 * plus everything it costs to get the material to the job — shipping, customs
 * duty, the freight, an allowance for risk, the bank's charge — and then the
 * margin the company wants on it. The sales desk works that out on paper today
 * and types the answer in; this does the arithmetic instead, keeps the working,
 * and never puts any of it on the quotation the client receives.
 *
 * Each charge says how it is reckoned, because they are not reckoned the same
 * way: duty is a percentage of the material's value, a bank charge is usually a
 * percentage of the running total, sea freight is a lump sum for the shipment,
 * and inland transport is often so much per piece.
 *
 *   percent_of_material   a percentage of the material rate
 *   percent_of_running    a percentage of everything so far, in order
 *   per_unit              an amount on each piece
 *   lump_sum              an amount for the whole line, divided over the qty
 *
 * The order they are listed in is the order they are applied, which matters
 * for anything reckoned on the running total.
 */
const BASES = ['percent_of_material', 'percent_of_running', 'per_unit', 'lump_sum'];

/*
 * What the company costs into a rate, in its own words and its own order.
 *
 * These are the heads it works to at the quote stage. Each is set to the way
 * that charge is actually reckoned — a percentage of the material, a percentage
 * of everything so far, an amount a piece, or a lump sum for the shipment —
 * which the desk can change on any line, along with the figure.
 *
 * Margin is not on this list because it is not a charge: it is the profit
 * percent, applied to the landed cost after all of these, and it has its own
 * field on the builder.
 *
 * The same heads are booked against a job when the money actually goes out
 * (see the expense heads in src/db/seed.js), so what was allowed for at the
 * quote and what it really cost can be read side by side.
 */
const SUGGESTED = [
  { label: 'Exchange risk', basis: 'percent_of_running' },
  { label: 'Packing', basis: 'lump_sum' },
  { label: 'Shipping', basis: 'lump_sum' },
  { label: 'Insurance', basis: 'percent_of_running' },
  { label: 'Custom clearance', basis: 'lump_sum' },
  { label: 'PBG', basis: 'percent_of_running' },
  { label: 'Retention', basis: 'percent_of_running' },
];

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

/**
 * Work a rate out from its parts.
 *
 * Everything is per unit by the time it reaches the answer, because a rate is
 * per unit — a lump sum for the shipment is divided over the quantity, and a
 * quantity of nothing carries no lump sums at all rather than dividing by zero.
 */
function build({ material = 0, qty = 1, components = [], profit_percent = 0 } = {}) {
  const materialRate = round(material);
  const quantity = num(qty) > 0 ? num(qty) : 0;

  let running = materialRate;
  const steps = [];

  for (const raw of Array.isArray(components) ? components : []) {
    const basis = BASES.includes(raw.basis) ? raw.basis : 'per_unit';
    const value = num(raw.value);
    let amount = 0;
    if (basis === 'percent_of_material') amount = round((materialRate * value) / 100);
    else if (basis === 'percent_of_running') amount = round((running * value) / 100);
    else if (basis === 'per_unit') amount = round(value);
    else if (basis === 'lump_sum') amount = quantity ? round(value / quantity) : 0;

    running = round(running + amount);
    steps.push({
      label: String(raw.label || 'Charge').slice(0, 60),
      basis,
      value,
      // What it comes to on one piece, and what it comes to on the whole line.
      per_unit: amount,
      line_total: round(amount * quantity),
      running,
    });
  }

  const landed = running;                       // what one piece costs us, all in
  const profitPercent = num(profit_percent);
  const profitPerUnit = round((landed * profitPercent) / 100);
  const rate = round(landed + profitPerUnit);

  return {
    material_rate: materialRate,
    qty: quantity,
    steps,
    charges_per_unit: round(landed - materialRate),
    landed_cost: landed,
    profit_percent: profitPercent,
    profit_per_unit: profitPerUnit,
    rate,
    // The same figures for the line as a whole, which is what the desk checks
    // against the supplier's quotation.
    line_cost: round(landed * quantity),
    line_profit: round(profitPerUnit * quantity),
    line_total: round(rate * quantity),
    // Margin on the selling rate, which is the number the profit page reads.
    margin_percent: rate ? round(((rate - landed) / rate) * 100) : 0,
  };
}

/** What is worth keeping on the line: the working, not the answer alone. */
function normalise(input) {
  if (!input) return null;
  const built = build(input);
  return {
    material: built.material_rate,
    profit_percent: built.profit_percent,
    components: built.steps.map((s) => ({ label: s.label, basis: s.basis, value: s.value })),
  };
}

module.exports = { BASES, SUGGESTED, build, normalise };
