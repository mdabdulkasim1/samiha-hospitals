'use strict';
const { db } = require('../db');

/*
 * Following a reference.
 *
 * A reference is only worth having if, a year later, somebody can type it in
 * and be shown the whole story: which enquiry it came from, what we quoted,
 * what the client ordered, who we bought it from, when it came in, when it
 * went out, what we invoiced and when we were paid.
 *
 * Every document in this system is linked to the one before it, so the chain
 * exists; this walks it from whichever end the reference happens to be.
 */

/** Where each reference lives, and what to call it on screen. */
const SOURCES = [
  { kind: 'enquiry', table: 'enquiries', col: 'enquiry_no', label: 'Enquiry',
    dateCol: 'received_on', route: 'enquiries' },
  { kind: 'salesQuotation', table: 'sales_quotations', col: 'quote_no', label: 'Our quotation',
    dateCol: 'quote_date', route: 'quotations' },
  { kind: 'salesOrder', table: 'sales_orders', col: 'so_no', label: "Client's LPO",
    dateCol: 'order_date', route: 'orders' },
  // A client's own LPO number is what they will quote on the telephone, so it
  // is searchable too.
  { kind: 'salesOrder', table: 'sales_orders', col: 'client_lpo_no', label: "Client's LPO",
    dateCol: 'order_date', route: 'orders' },
  { kind: 'deliveryNote', table: 'delivery_notes', col: 'dn_no', label: 'Delivery note',
    dateCol: 'delivery_date', route: 'deliveries' },
  { kind: 'salesInvoice', table: 'sales_invoices', col: 'invoice_no', label: 'Tax invoice',
    dateCol: 'invoice_date', route: 'invoices' },
  { kind: 'supplierQuotation', table: 'supplier_quotations', col: 'quote_no', label: "Supplier's quotation",
    dateCol: 'quote_date', route: 'supplier-quotations' },
  { kind: 'purchaseOrder', table: 'purchase_orders', col: 'lpo_no', label: 'Our LPO',
    dateCol: 'lpo_date', route: 'purchase-orders' },
  { kind: 'grn', table: 'grns', col: 'grn_no', label: 'Goods receipt',
    dateCol: 'received_date', route: 'goods-receipts' },
  { kind: 'supplierInvoice', table: 'supplier_invoices', col: 'bill_no', label: "Supplier's invoice",
    dateCol: 'invoice_date', route: 'supplier-bills' },
  { kind: 'supplierInvoice', table: 'supplier_invoices', col: 'supplier_inv_no', label: "Supplier's invoice",
    dateCol: 'invoice_date', route: 'supplier-bills' },
  { kind: 'payment', table: 'payments', col: 'payment_no', label: 'Payment voucher',
    dateCol: 'payment_date', route: 'payments' },
  { kind: 'expense', table: 'expenses', col: 'voucher_no', label: 'Expense voucher',
    dateCol: 'expense_date', route: 'expenses' },
];

/** Find every document whose reference matches, exactly or as a fragment. */
function find(reference) {
  const ref = String(reference || '').trim();
  if (!ref) return [];
  const hits = [];
  for (const src of SOURCES) {
    const rows = db.prepare(
      `SELECT id, ${src.col} AS ref, ${src.dateCol} AS on_date, partner_id
         FROM ${src.table} WHERE ${src.col} = ? COLLATE NOCASE`
    ).all(ref);
    for (const row of rows) hits.push({ ...src, id: row.id, ref: row.ref, on_date: row.on_date });
  }
  if (hits.length) return hits;

  // Nothing matched exactly — offer what looks close, so a half-remembered
  // number is still useful.
  for (const src of SOURCES) {
    const rows = db.prepare(
      `SELECT id, ${src.col} AS ref, ${src.dateCol} AS on_date FROM ${src.table}
        WHERE ${src.col} LIKE ? COLLATE NOCASE ORDER BY id DESC LIMIT 8`
    ).all(`%${ref}%`);
    for (const row of rows) {
      hits.push({ ...src, id: row.id, ref: row.ref, on_date: row.on_date, partial: true });
    }
  }
  return hits.slice(0, 25);
}

const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);

/**
 * The whole chain around a document.
 *
 * Both sides are walked from whatever the reference names: the sell side hangs
 * off the client's order, the buy side off our LPO, and the two meet where an
 * LPO was raised against a client's order.
 */
function chain(kind, id) {
  const out = { steps: [], partner: null };
  const push = (label, row, extra = {}) => {
    if (!row) return;
    out.steps.push({ label, ...row, ...extra });
  };

  // ---------------------------------------------------------------- anchors
  let salesOrder = null;
  let purchaseOrder = null;

  if (kind === 'salesOrder') salesOrder = one('SELECT * FROM sales_orders WHERE id = ?', id);
  if (kind === 'purchaseOrder') purchaseOrder = one('SELECT * FROM purchase_orders WHERE id = ?', id);

  if (kind === 'salesQuotation') {
    const q = one('SELECT * FROM sales_quotations WHERE id = ?', id);
    salesOrder = q && one('SELECT * FROM sales_orders WHERE quotation_id = ?', q.id);
    if (!salesOrder && q) out.quotationOnly = q;
  }
  if (kind === 'enquiry') {
    const q = one('SELECT * FROM sales_quotations WHERE enquiry_id = ? ORDER BY id DESC', id);
    if (q) salesOrder = one('SELECT * FROM sales_orders WHERE quotation_id = ?', q.id);
  }
  if (kind === 'deliveryNote') {
    const d = one('SELECT * FROM delivery_notes WHERE id = ?', id);
    salesOrder = d && d.so_id ? one('SELECT * FROM sales_orders WHERE id = ?', d.so_id) : null;
  }
  if (kind === 'salesInvoice') {
    const i = one('SELECT * FROM sales_invoices WHERE id = ?', id);
    salesOrder = i && i.so_id ? one('SELECT * FROM sales_orders WHERE id = ?', i.so_id) : null;
  }
  if (kind === 'supplierQuotation') {
    const q = one('SELECT * FROM supplier_quotations WHERE id = ?', id);
    purchaseOrder = q && one('SELECT * FROM purchase_orders WHERE quotation_id = ?', q.id);
  }
  if (kind === 'grn') {
    const g = one('SELECT * FROM grns WHERE id = ?', id);
    purchaseOrder = g && g.po_id ? one('SELECT * FROM purchase_orders WHERE id = ?', g.po_id) : null;
  }
  if (kind === 'supplierInvoice') {
    const i = one('SELECT * FROM supplier_invoices WHERE id = ?', id);
    purchaseOrder = i && i.po_id ? one('SELECT * FROM purchase_orders WHERE id = ?', i.po_id) : null;
  }

  // The two sides meet here: an LPO raised to fill a client's order.
  if (salesOrder && !purchaseOrder) {
    purchaseOrder = one('SELECT * FROM purchase_orders WHERE sales_order_id = ? ORDER BY id', salesOrder.id);
  }
  if (purchaseOrder && !salesOrder && purchaseOrder.sales_order_id) {
    salesOrder = one('SELECT * FROM sales_orders WHERE id = ?', purchaseOrder.sales_order_id);
  }

  // ------------------------------------------------------------- the buy side
  if (purchaseOrder) {
    const supplier = one('SELECT * FROM partners WHERE id = ?', purchaseOrder.partner_id);
    if (purchaseOrder.quotation_id) {
      const sq = one('SELECT * FROM supplier_quotations WHERE id = ?', purchaseOrder.quotation_id);
      push("Supplier's quotation", sq && {
        kind: 'supplierQuotation', id: sq.id, ref: sq.quote_no, on_date: sq.quote_date,
        who: supplier && supplier.name, amount: sq.total, status: sq.status,
        route: 'supplier-quotations',
      });
    }
    push('Our LPO', {
      kind: 'purchaseOrder', id: purchaseOrder.id, ref: purchaseOrder.lpo_no,
      on_date: purchaseOrder.lpo_date, who: supplier && supplier.name,
      amount: purchaseOrder.total, status: purchaseOrder.status, route: 'purchase-orders',
    });
    for (const g of all('SELECT * FROM grns WHERE po_id = ? ORDER BY received_date', purchaseOrder.id)) {
      push('Goods received', {
        kind: 'grn', id: g.id, ref: g.grn_no, on_date: g.received_date,
        who: supplier && supplier.name, status: g.status, route: 'goods-receipts',
        note: g.supplier_dn_ref ? `their DN ${g.supplier_dn_ref}` : null,
      });
    }
    for (const b of all('SELECT * FROM supplier_invoices WHERE po_id = ? ORDER BY invoice_date', purchaseOrder.id)) {
      push("Supplier's invoice", {
        kind: 'supplierInvoice', id: b.id, ref: b.bill_no, on_date: b.invoice_date,
        who: supplier && supplier.name, amount: b.total, status: b.status,
        route: 'supplier-bills', note: `their invoice ${b.supplier_inv_no}`,
      });
      for (const p of paymentsFor('purchase', b.id)) push('We paid', p);
    }
  }

  // ------------------------------------------------------------ the sell side
  if (salesOrder) {
    const client = one('SELECT * FROM partners WHERE id = ?', salesOrder.partner_id);
    out.partner = client || null;
    const quote = salesOrder.quotation_id
      ? one('SELECT * FROM sales_quotations WHERE id = ?', salesOrder.quotation_id) : null;
    if (quote && quote.enquiry_id) {
      const e = one('SELECT * FROM enquiries WHERE id = ?', quote.enquiry_id);
      push('Client enquiry', e && {
        kind: 'enquiry', id: e.id, ref: e.enquiry_no, on_date: e.received_on,
        who: client && client.name, status: e.status, route: 'enquiries',
      });
    }
    push('Our quotation', quote && {
      kind: 'salesQuotation', id: quote.id, ref: quote.quote_no, on_date: quote.quote_date,
      who: client && client.name, amount: quote.total, status: quote.status, route: 'quotations',
    });
    push("Client's LPO", {
      kind: 'salesOrder', id: salesOrder.id, ref: salesOrder.so_no, on_date: salesOrder.order_date,
      who: client && client.name, amount: salesOrder.total, status: salesOrder.status,
      route: 'orders', note: `their LPO ${salesOrder.client_lpo_no}`,
    });
    for (const d of all('SELECT * FROM delivery_notes WHERE so_id = ? ORDER BY delivery_date', salesOrder.id)) {
      push('Delivered', {
        kind: 'deliveryNote', id: d.id, ref: d.dn_no, on_date: d.delivery_date,
        who: client && client.name, status: d.status, route: 'deliveries',
        note: d.received_by ? `signed by ${d.received_by}` : null,
      });
    }
    for (const i of all('SELECT * FROM sales_invoices WHERE so_id = ? ORDER BY invoice_date', salesOrder.id)) {
      push('Tax invoice', {
        kind: 'salesInvoice', id: i.id, ref: i.invoice_no, on_date: i.invoice_date,
        who: client && client.name, amount: i.total, status: i.status, route: 'invoices',
      });
      for (const p of paymentsFor('sales', i.id)) push('They paid', p);
    }
  }

  if (!out.partner && purchaseOrder) {
    out.partner = one('SELECT * FROM partners WHERE id = ?', purchaseOrder.partner_id);
  }

  // Oldest first — the story reads forwards.
  out.steps.sort((a, b) => (a.on_date < b.on_date ? -1 : a.on_date > b.on_date ? 1 : a.id - b.id));
  return out;
}

function paymentsFor(side, invoiceId) {
  return all(
    `SELECT p.*, a.amount AS applied FROM payment_allocations a
       JOIN payments p ON p.id = a.payment_id
      WHERE a.invoice_side = ? AND a.invoice_id = ? ORDER BY p.payment_date`, side, invoiceId
  ).map((p) => ({
    kind: 'payment', id: p.id, ref: p.payment_no, on_date: p.payment_date,
    amount: p.applied, status: p.status, route: 'payments',
    note: p.mode === 'cheque' ? `cheque ${p.cheque_no || ''} dated ${p.cheque_date || ''}`.trim() : p.mode,
  }));
}

module.exports = { SOURCES, find, chain };
