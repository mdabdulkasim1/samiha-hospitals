'use strict';
/*
 * Paying the bill from the chair.
 *
 * A UPI QR is nothing more than a `upi://pay` link drawn as a square: the
 * patient's app reads the payee, the amount and a reference out of it, and all
 * they do is confirm. It is the difference between a patient walking to an ATM
 * and a bill being settled before they stand up.
 *
 * The spec is NPCI's UPI Linking Specification. Only what a bill needs is
 * built here — payee address, payee name, amount, currency, and the invoice
 * number as both the note and the transaction reference so the money that
 * lands can be matched to the bill it paid.
 */
const qrcode = require('qrcode-generator');

/** UPI reference fields are alphanumeric; an invoice number already is. */
const ref = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 35);

/**
 * The `upi://pay` link for one bill.
 *
 * The amount is fixed to two decimals because a UPI app reads `am` as rupees
 * and an unrounded float would ask for a fraction of a paisa and be refused.
 */
function link({ upiId, payeeName, amount, note, invoiceNo }) {
  if (!upiId) return null;
  const params = [
    ['pa', upiId],
    ['pn', payeeName || ''],
    ['am', Number(amount || 0).toFixed(2)],
    ['cu', 'INR'],
  ];
  if (invoiceNo) params.push(['tr', ref(invoiceNo)]);
  if (note) params.push(['tn', String(note).slice(0, 50)]);
  return 'upi://pay?' + params
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/**
 * The link as an SVG square, ready to be dropped into a printed bill.
 *
 * Error correction M: a bill is handled, folded and sometimes photographed off
 * a screen, and M recovers a fifth of a damaged code while staying small
 * enough to scan from a 25 mm square on paper. Version 0 lets the library pick
 * the smallest size the data fits in.
 */
function qrSvg(uri, { margin = 2 } = {}) {
  if (!uri) return null;
  const qr = qrcode(0, 'M');
  qr.addData(uri);
  qr.make();

  // One path for the whole code rather than a rectangle per module: the same
  // square in a twentieth of the bytes, which matters because this travels
  // inside a printed page rather than as a file of its own.
  const n = qr.getModuleCount();
  const runs = [];
  for (let row = 0; row < n; row += 1) {
    let start = -1;
    for (let col = 0; col <= n; col += 1) {
      const dark = col < n && qr.isDark(row, col);
      if (dark && start === -1) start = col;
      if (!dark && start !== -1) {
        runs.push(`M${start + margin} ${row + margin}h${col - start}v1h-${col - start}z`);
        start = -1;
      }
    }
  }
  const side = n + margin * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" `
    + `shape-rendering="crispEdges" role="img" aria-label="UPI payment code">`
    + `<rect width="${side}" height="${side}" fill="#fff"/>`
    + `<path d="${runs.join('')}" fill="#000"/></svg>`;
}

module.exports = { link, qrSvg };
