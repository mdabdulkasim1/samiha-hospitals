'use strict';
const { db } = require('../db');
const v = require('../lib/validate');
const { round } = require('./pricing');

/**
 * Payment terms, and what they mean in dates and money.
 *
 * Every supplier and every client is on their own terms — some are paid the
 * day the lorry arrives, some hand over a cheque against the delivery note,
 * some want half up front before anything is ordered, and the rest are on
 * thirty, sixty or ninety days. The terms are a master record rather than a
 * sentence typed onto a document, so the due date on an invoice, the advance
 * a sales order is waiting for and the cheque the driver has to collect all
 * come from the same place.
 */

const get = (id) => (id ? db.prepare('SELECT * FROM payment_terms WHERE id = ?').get(id) : null);

/** When an invoice on these terms falls due. */
function dueDate(termsId, invoiceDate) {
  const base = v.date(invoiceDate) || v.today();
  const t = get(termsId);
  if (!t) return base;
  switch (t.kind) {
    case 'advance':
    case 'on_delivery':
      // Payable at once: the goods do not leave, or do not arrive, without it.
      return base;
    case 'pdc':
    case 'credit':
    case 'milestone':
    case 'lc':
    default:
      return v.addDays(base, t.credit_days || 0);
  }
}

/**
 * How an order's value is split under these terms: what is wanted before the
 * order is placed, what is collected at the gate, and what is left on credit.
 */
function schedule(termsId, total) {
  const t = get(termsId);
  const amount = round(total);
  if (!t) return { advance: 0, on_delivery: 0, credit: amount, retention: 0, credit_days: 0 };

  const advance = round(amount * ((t.advance_percent || 0) / 100));
  const onDelivery = round(amount * ((t.on_delivery_percent || 0) / 100));
  const retention = round(amount * ((t.retention_percent || 0) / 100));
  const credit = round(amount - advance - onDelivery - retention);

  return {
    advance,
    on_delivery: onDelivery,
    retention,
    credit: credit < 0 ? 0 : credit,
    credit_days: t.credit_days || 0,
  };
}

/**
 * The sentence that goes on the printed document. Written out rather than
 * printing the code, because the client's accounts department reads the
 * paper, not our master data.
 */
function describe(termsId) {
  const t = get(termsId);
  if (!t) return 'As agreed';
  if (t.description) return t.description;
  const bits = [];
  if (t.advance_percent) bits.push(`${t.advance_percent}% advance with order`);
  if (t.on_delivery_percent) bits.push(`${t.on_delivery_percent}% against delivery`);
  if (t.retention_percent) bits.push(`${t.retention_percent}% retention`);
  if (t.credit_days) bits.push(`balance ${t.credit_days} days from invoice date`);
  else if (!bits.length) bits.push(t.name);
  if (t.kind === 'pdc') bits.push('by post-dated cheque');
  if (t.kind === 'lc') bits.push('under letter of credit');
  return bits.join(', ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Whether an order may be released for delivery yet.
 *
 * A client on advance terms does not get the material until the advance is in;
 * a client paying by cheque against delivery does, because the cheque is
 * collected at the gate. This is the rule the logistics desk is stopped by.
 */
function releaseCheck(order) {
  const t = get(order.payment_terms_id);
  if (!t) return { ok: true };
  const required = round(order.advance_required || 0);
  const received = round(order.advance_received || 0);
  if (required > 0 && received + 0.005 < required) {
    return {
      ok: false,
      reason: `This order is on ${t.name}. ${required.toFixed(2)} is due as an advance and `
        + `${received.toFixed(2)} has been received — short by ${round(required - received).toFixed(2)}.`,
      shortfall: round(required - received),
    };
  }
  return { ok: true };
}

/** True when the terms say a cheque is collected at the point of delivery. */
function collectsAtDelivery(termsId) {
  const t = get(termsId);
  return Boolean(t && (t.kind === 'on_delivery' || t.on_delivery_percent > 0));
}

module.exports = { get, dueDate, schedule, describe, releaseCheck, collectsAtDelivery };
