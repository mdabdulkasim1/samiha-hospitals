'use strict';
/**
 * Sending a bill to a patient's phone instead of printing it.
 *
 * The clinic prints two or three hundred bills a month, nearly all of which
 * are read once and thrown away before the patient reaches the gate. This is
 * the other way out of the counter: the same bill, as a PDF, sent to a
 * WhatsApp number the cashier types in.
 *
 * Three things matter here beyond the sending.
 *
 * The file is built once and kept. WhatsApp fetches the link to attach the
 * document, but the patient keeps that link in their chat and may open it a
 * year later; what they get then must be the bill that was sent, not the
 * bill as the system would draw it today.
 *
 * The link is the only key to it, so it is 22 random characters and it
 * expires. A patient's medical spending should not sit on the open internet
 * for ever because nobody thought about the end of it.
 *
 * And a send that fails has to be said out loud. WhatsApp will not deliver a
 * free-form message to somebody who has not written to the clinic in the last
 * 24 hours, which is most patients at a counter. When that happens the
 * cashier needs to know at once, while the patient is still standing there
 * and paper is still an option.
 */
const crypto = require('crypto');
const { db } = require('../db');
const config = require('../config');
const billing = require('./billing');
const clinic = require('./clinic');
const pharmacy = require('./pharmacy');
const upi = require('./upi');
const whatsapp = require('./whatsapp');
const invoicePdf = require('../lib/invoicePdf');
const { badRequest, notFound } = require('../lib/http');

/** How long a sent bill stays fetchable. Long enough for a reimbursement. */
const LINK_DAYS = Number(process.env.BILL_LINK_DAYS || 90);

const KINDS = {
  invoice: { label: 'Invoice', prefix: 'Invoice' },
  pharmacy_sale: { label: 'Pharmacy bill', prefix: 'Pharmacy-bill' },
};

/**
 * The number WhatsApp will accept.
 *
 * A cashier types what the patient reads off their phone: ten digits, or
 * with a zero in front, or with +91 already on it. WhatsApp wants the country
 * code and nothing else, and will silently fail to deliver to a bare
 * ten-digit number — the kind of failure nobody finds out about — so it is
 * put on here rather than hoped for.
 */
function dial(value) {
  const digits = String(value === null || value === undefined ? '' : value).replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

/** 128 bits of randomness, URL-safe: the only thing guarding the document. */
const newToken = () => crypto.randomBytes(16).toString('base64url');

const money = (v) => `${config.clinic.currencySymbol}${Number(v || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})}`;

/**
 * The clinic's tax invoice as a PDF, with its UPI square if anything is owed.
 */
function buildInvoice(id) {
  const inv = billing.fullInvoice(id);
  if (!inv) throw notFound('Invoice not found');

  const profile = clinic.profile();
  const amount = billing.round2(Math.max(inv.balance, 0));
  const uri = amount > 0 && profile.upiId ? upi.link({
    upiId: profile.upiId, payeeName: profile.upiName, amount,
    invoiceNo: inv.invoice_no, note: `${inv.invoice_no} ${profile.name || ''}`.trim(),
  }) : null;

  return {
    docNo: inv.invoice_no,
    filename: `${KINDS.invoice.prefix}-${inv.invoice_no}.pdf`,
    content: invoicePdf.clinicInvoice(inv, {
      clinic: profile,
      pay: uri ? {
        matrix: upi.qrMatrix(uri), amount, upiId: profile.upiId, payee: profile.upiName,
      } : null,
    }),
    patientName: `${inv.first_name || ''} ${inv.last_name || ''}`.trim(),
    suggestedNumber: inv.whatsapp || inv.phone || null,
    net: inv.net,
    balance: inv.balance,
  };
}

/**
 * The pharmacy's GST tax invoice as a PDF.
 *
 * Assembled the same way the printed one is — rate-wise tax split and all —
 * rather than read off the sale row, because a bill raised before the stored
 * split existed still has to come out right.
 */
function buildPharmacySale(id) {
  const sale = db.prepare(
    `SELECT s.*, u.name AS billed_by, p.uhid, p.address AS patient_address,
            (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            p.phone AS patient_phone, p.whatsapp AS patient_whatsapp, v.visit_no
       FROM pharmacy_sales s
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN patients p ON p.id = s.patient_id
       LEFT JOIN visits v ON v.id = s.visit_id
      WHERE s.id = ?`
  ).get(id);
  if (!sale) throw notFound('Pharmacy bill not found');

  const items = db.prepare(
    `SELECT i.*, dr.generic_name, dr.form, dr.strength, dr.manufacturer, dr.schedule_type,
            COALESCE(i.hsn, dr.hsn, '3004') AS hsn_code
       FROM pharmacy_sale_items i LEFT JOIN drugs dr ON dr.id = i.drug_id
      WHERE i.sale_id = ? ORDER BY i.id`
  ).all(id);

  for (const it of items) {
    if (!it.taxable) {
      const g = pharmacy.gstOnLine({ mrp: it.mrp, qty: it.qty, taxPct: it.tax_pct });
      Object.assign(it, { taxable: g.taxable, cgst: g.cgst, sgst: g.sgst });
    }
    it.tax = pharmacy.round2(it.cgst + it.sgst);
  }

  const summary = items.reduce((a, i) => ({
    taxable: pharmacy.round2(a.taxable + i.taxable),
    cgst: pharmacy.round2(a.cgst + i.cgst),
    sgst: pharmacy.round2(a.sgst + i.sgst),
  }), { taxable: 0, cgst: 0, sgst: 0 });

  const byRate = new Map();
  for (const i of items) {
    const key = `${i.tax_pct}|${i.hsn_code || ''}`;
    const row = byRate.get(key)
      || { rate: i.tax_pct, hsn: i.hsn_code || '3004', taxable: 0, cgst: 0, sgst: 0 };
    row.taxable = pharmacy.round2(row.taxable + i.taxable);
    row.cgst = pharmacy.round2(row.cgst + i.cgst);
    row.sgst = pharmacy.round2(row.sgst + i.sgst);
    byRate.set(key, row);
  }

  const data = {
    supplier: {
      ...config.pharmacy,
      state: config.clinic.state,
      stateCode: config.clinic.stateCode,
    },
    sale,
    items,
    summary,
    hsnSummary: [...byRate.values()].sort((a, b) => a.rate - b.rate),
    amountInWords: pharmacy.amountInWords(sale.net),
    placeOfSupply: `${config.clinic.state} (${config.clinic.stateCode})`,
    reverseCharge: 'No',
  };

  return {
    docNo: sale.bill_no,
    filename: `${KINDS.pharmacy_sale.prefix}-${sale.bill_no}.pdf`,
    content: invoicePdf.pharmacyInvoice(data),
    patientName: (sale.patient_name || '').trim() || sale.customer_name || '',
    suggestedNumber: sale.patient_whatsapp || sale.patient_phone || sale.customer_phone || null,
    net: sale.net,
    balance: pharmacy.round2(Number(sale.net || 0) - Number(sale.paid_amount || 0)),
  };
}

/** The PDF for a bill of either kind, built fresh. */
function build(kind, refId) {
  if (kind === 'invoice') return buildInvoice(refId);
  if (kind === 'pharmacy_sale') return buildPharmacySale(refId);
  throw badRequest(`Unknown document kind: ${kind}`);
}

const linkFor = (token) => `${config.appUrl}/d/${token}`;

/**
 * Empty out the bills whose links have run out.
 *
 * The row stays, so the counter can still see that a bill was sent, to whom
 * and when. The document itself goes: once nobody can open it there is no
 * reason for the clinic to keep a copy of a patient's bill in a column, and
 * a few hundred a month would otherwise grow the database for ever.
 */
function prune() {
  return db.prepare(
    `UPDATE document_shares SET content = NULL
      WHERE content IS NOT NULL AND expires_at IS NOT NULL
        AND datetime(expires_at) < datetime('now')`
  ).run().changes;
}

/** Store a built bill against a fresh token and return the row. */
function store({ kind, refId, doc, waNumber, channel, userId }) {
  prune();
  const token = newToken();
  const expires = new Date(Date.now() + LINK_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const info = db.prepare(
    `INSERT INTO document_shares
       (token, kind, ref_id, doc_no, filename, content, bytes, wa_number, channel, sent_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(token, kind, refId, doc.docNo, doc.filename, doc.content, doc.content.length,
    waNumber || null, channel, userId || null, expires);
  return db.prepare('SELECT * FROM document_shares WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * What the patient reads above the attachment.
 *
 * It says what is still owed, because a bill sent to a phone is often read
 * after the patient has left, and "nothing further to pay" is the single
 * thing they most want to know.
 */
function caption(kind, doc) {
  const name = clinic.profile().name;
  const head = kind === 'pharmacy_sale'
    ? `${config.pharmacy.name} — bill ${doc.docNo}`
    : `${name} — bill ${doc.docNo}`;
  const owed = Number(doc.balance) > 0.009
    ? `Balance to pay: ${money(doc.balance)}.`
    : 'Paid in full — nothing further to pay.';
  return `${head}\nTotal ${money(doc.net)}. ${owed}\nThe bill is attached as a PDF.`;
}

/**
 * Send a bill to a number.
 *
 * The document goes first and a short line follows it with the link, so the
 * bill is still reachable if the patient clears the attachment or reads it on
 * a device that will not open one. Both are recorded in the conversation.
 */
async function sendToWhatsApp({ kind, refId, to, userId }) {
  const number = dial(to);
  if (!number) throw badRequest('Enter the patient\'s WhatsApp number — ten digits, or with its country code.');

  const doc = build(kind, refId);
  const share = store({ kind, refId, doc, waNumber: number, channel: 'whatsapp', userId });
  const url = linkFor(share.token);

  const message = await whatsapp.sendDocument(number, {
    link: url, filename: doc.filename, caption: caption(kind, doc),
  });
  if (message) {
    db.prepare('UPDATE document_shares SET message_id = ? WHERE id = ?').run(message.id, share.id);
  }
  const failed = Boolean(message && message.status === 'failed');
  if (!failed) {
    // The link in words, for a phone that will not open the attachment.
    await whatsapp.send(number, `Your bill ${doc.docNo} can also be opened here:\n${url}\n`
      + `The link works for ${LINK_DAYS} days.`);
  }

  return {
    sent: !failed,
    token: share.token,
    url,
    filename: doc.filename,
    docNo: doc.docNo,
    to: number,
    provider: config.whatsapp.provider,
    expiresAt: share.expires_at,
    error: failed ? message.error : null,
  };
}

/** A link with nothing sent: the counter shows the patient a QR, or copies it. */
function linkOnly({ kind, refId, userId }) {
  const doc = build(kind, refId);
  const share = store({ kind, refId, doc, waNumber: null, channel: 'link', userId });
  return {
    token: share.token, url: linkFor(share.token), filename: doc.filename,
    docNo: doc.docNo, expiresAt: share.expires_at,
  };
}

/**
 * The stored file behind a token, if the link is still good.
 *
 * Expiry is checked in SQLite rather than in JavaScript so it is decided by
 * the same clock that wrote the row.
 */
function fetch(token) {
  const row = db.prepare(
    `SELECT * FROM document_shares
      WHERE token = ? AND content IS NOT NULL
        AND (expires_at IS NULL OR datetime(expires_at) >= datetime('now'))`
  ).get(String(token || ''));
  if (!row) return null;
  db.prepare(
    "UPDATE document_shares SET downloads = downloads + 1, last_seen_at = datetime('now') WHERE id = ?"
  ).run(row.id);
  return row;
}

/** Whether a token exists at all — so an expired link can say so. */
const expired = (token) => Boolean(
  db.prepare('SELECT 1 FROM document_shares WHERE token = ?').get(String(token || ''))
);

/** Every copy of one bill that has gone out, newest first. */
function history(kind, refId) {
  return db.prepare(
    `SELECT s.id, s.token, s.wa_number, s.channel, s.created_at, s.expires_at, s.downloads,
            s.last_seen_at, u.name AS sent_by, m.status, m.error
       FROM document_shares s
       LEFT JOIN users u ON u.id = s.sent_by
       LEFT JOIN whatsapp_messages m ON m.id = s.message_id
      WHERE s.kind = ? AND s.ref_id = ?
      ORDER BY s.id DESC`
  ).all(kind, refId).map((r) => ({ ...r, url: linkFor(r.token) }));
}

module.exports = {
  build, sendToWhatsApp, linkOnly, fetch, expired, history, linkFor, dial, prune, LINK_DAYS,
};
