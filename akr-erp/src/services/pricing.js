'use strict';
const config = require('../config');
const v = require('../lib/validate');

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Price one line.
 *
 * The discount is taken off the line before VAT, because VAT is charged on
 * what the customer actually pays for the goods — charging it on the
 * undiscounted figure would overstate the tax on every discounted line and,
 * on the buy side, would have us reclaiming input tax the supplier never
 * charged.
 *
 * Everything is rounded once, here, to two decimals. A document's totals are
 * the sum of its rounded lines, so the invoice adds up in front of a client
 * with a calculator.
 */
function priceLine(line, { vatPercent = config.vat.percent } = {}) {
  const qty = v.qty(line.qty, 0);
  const unitPrice = round(line.unit_price !== undefined ? line.unit_price : line.unitPrice);
  const gross = round(qty * unitPrice);

  // A discount may be given as an amount or as a percentage of the line.
  let discount = round(line.discount || 0);
  const pct = Number(line.discount_percent || line.discountPercent || 0);
  if (pct) discount = round(gross * (pct / 100));
  if (discount > gross) discount = gross;

  const taxable = round(gross - discount);
  const rate = line.vat_percent !== undefined && line.vat_percent !== null && line.vat_percent !== ''
    ? Number(line.vat_percent)
    : (line.vatPercent !== undefined && line.vatPercent !== null && line.vatPercent !== ''
      ? Number(line.vatPercent) : Number(vatPercent));
  const vatAmount = round(taxable * (rate / 100));

  return {
    qty,
    unit_price: unitPrice,
    gross,
    discount,
    taxable,
    vat_percent: rate,
    vat_amount: vatAmount,
    total: round(taxable + vatAmount),
  };
}

/** Add up priced lines into a document's footer. */
function totals(lines) {
  const acc = lines.reduce((a, l) => ({
    gross: a.gross + (Number(l.gross) || (Number(l.taxable) || 0) + (Number(l.discount) || 0)),
    discount: a.discount + (Number(l.discount) || 0),
    taxable: a.taxable + (Number(l.taxable) || 0),
    vat_amount: a.vat_amount + (Number(l.vat_amount) || 0),
    total: a.total + (Number(l.total) || 0),
  }), { gross: 0, discount: 0, taxable: 0, vat_amount: 0, total: 0 });

  return {
    // `subtotal` is the goods value before discount, which is what the printed
    // documents show in their first footer line.
    subtotal: round(acc.gross),
    discount: round(acc.discount),
    taxable: round(acc.taxable),
    vat_amount: round(acc.vat_amount),
    total: round(acc.total),
  };
}

/**
 * The amount in words, as every UAE invoice carries it.
 * "AED One Thousand Two Hundred and 50/100 Fils Only".
 */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function threeDigits(n) {
  const out = [];
  if (n >= 100) { out.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)]); n %= 10; }
  if (n) out.push(ONES[n]);
  return out.join(' ');
}

function inWords(amount, currency = config.vat.currency) {
  const value = round(Math.abs(amount));
  const whole = Math.floor(value);
  const fils = Math.round((value - whole) * 100);
  if (whole === 0 && fils === 0) return `${currency} Zero Only`;

  const groups = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']];
  let rest = whole;
  const parts = [];
  for (const [size, label] of groups) {
    const count = Math.floor(rest / size);
    if (count) { parts.push(`${threeDigits(count)} ${label}`); rest %= size; }
  }
  if (rest) parts.push(threeDigits(rest));

  const words = parts.join(' ').trim() || 'Zero';
  const filsPart = fils ? ` and ${threeDigits(fils)} Fils` : '';
  return `${currency} ${words}${filsPart} Only`;
}

/** What a line, or a document, made over its cost. */
function margin(revenue, cost) {
  const r = round(revenue);
  const c = round(cost);
  const profit = round(r - c);
  return { revenue: r, cost: c, margin: profit, margin_percent: r ? round((profit / r) * 100) : 0 };
}

module.exports = { round, priceLine, totals, inWords, margin };
