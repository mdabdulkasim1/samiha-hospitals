'use strict';

/*
 * The database is reached lazily. `src/db` calls in here while it is still
 * setting itself up (to stamp doctor codes on migration), and a top-level
 * require would hand back a half-built module.
 */
const database = () => require('../db').db;

/**
 * Atomic per-name counter. All human-facing document numbers come from here so
 * UHIDs, invoice numbers and IP numbers are gap-free and never collide.
 */
function nextSeq(name) {
  const row = database().prepare(
    `INSERT INTO counters (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1
     RETURNING value`
  ).get(name);
  return row.value;
}

function pad(n, width) { return String(n).padStart(width, '0'); }

/** Standard EAN-13 check digit, so scanners accept our own batch labels. */
function ean13CheckDigit(twelveDigits) {
  const digits = String(twelveDigits).split('').map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
}

const yy = () => String(new Date().getFullYear()).slice(-2);
const yymm = () => {
  const d = new Date();
  return `${String(d.getFullYear()).slice(-2)}${pad(d.getMonth() + 1, 2)}`;
};

/**
 * A doctor's code, e.g. **SPC-MHD-002**:
 *
 *   SPC  the clinic — Samiha Polyclinic (CLINIC_CODE)
 *   MHD  the doctor — a three-letter mnemonic of their name (Mohamed)
 *   002  the serial number in which they were appointed here
 *
 * The mnemonic keeps the first letter, then adds the consonants that have not
 * been used yet, which is how these abbreviations are written by hand: Mohamed
 * → M-H-D, Nafisa → N-F-S, Vikram → V-K-R.
 */
function nameMnemonic(name, length = 3) {
  const letters = String(name || '')
    .replace(/^\s*(dr|doctor|prof|mr|mrs|ms)\.?\s+/i, '')   // the title is not part of the name
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (!letters) return 'XXX';

  const out = [letters[0]];
  const isVowel = (ch) => 'AEIOU'.includes(ch);
  // Consonants first, because they are what makes a name recognisable.
  for (const ch of letters.slice(1)) {
    if (out.length >= length) break;
    if (!isVowel(ch) && !out.includes(ch)) out.push(ch);
  }
  // Then anything still unused, rather than padding a short name with filler.
  for (const ch of letters.slice(1)) {
    if (out.length >= length) break;
    if (!out.includes(ch)) out.push(ch);
  }
  while (out.length < length) out.push('X');
  return out.join('');
}

/** The next code for a doctor joining the clinic. */
function doctorCode(name, clinicCode = 'SPC', serial = null) {
  const n = serial === null ? nextSeq('doctor-serial') : serial;
  return `${String(clinicCode).toUpperCase()}-${nameMnemonic(name)}-${pad(n, 3)}`;
}

const generators = {
  uhid:        () => `SPD${yy()}${pad(nextSeq(`uhid-${yy()}`), 6)}`,
  enquiry:     () => `ENQ${yymm()}${pad(nextSeq(`enq-${yymm()}`), 4)}`,
  appointment: () => `APT${yymm()}${pad(nextSeq(`apt-${yymm()}`), 4)}`,
  visit:       () => `OP${yymm()}${pad(nextSeq(`visit-${yymm()}`), 5)}`,
  admission:   () => `IP${yymm()}${pad(nextSeq(`adm-${yymm()}`), 4)}`,
  labOrder:    () => `LAB${yymm()}${pad(nextSeq(`lab-${yymm()}`), 5)}`,
  sample:      () => `SMP${Date.now().toString(36).toUpperCase()}${pad(nextSeq('sample'), 4)}`,
  invoice:     () => `INV${yymm()}${pad(nextSeq(`inv-${yymm()}`), 5)}`,
  receipt:     () => `RCP${yymm()}${pad(nextSeq(`rcp-${yymm()}`), 5)}`,
  pharmacyBill:() => `PH${yymm()}${pad(nextSeq(`ph-${yymm()}`), 5)}`,
  screening:   () => `FS${yymm()}${pad(nextSeq(`fs-${yymm()}`), 4)}`,
  paymentPlan: () => `PPA${yymm()}${pad(nextSeq(`ppa-${yymm()}`), 4)}`,
  exitPass:    () => `EX${yymm()}${pad(nextSeq(`exit-${yymm()}`), 5)}`,
  staff:       () => `EMP${pad(nextSeq('staff'), 4)}`,
  preauth:     () => `PA${yymm()}${pad(nextSeq(`pa-${yymm()}`), 4)}`,
  claim:       () => `CLM${yymm()}${pad(nextSeq(`clm-${yymm()}`), 5)}`,
  grn:         () => `GRN${yymm()}${pad(nextSeq(`grn-${yymm()}`), 4)}`,
  stockTake:   () => `STK${yymm()}${pad(nextSeq(`stk-${yymm()}`), 4)}`,
  // Labels the pharmacy prints itself: checksummed internal codes in the "2"
  // range, which manufacturers never use, so ours can never collide with an
  // EAN-13 printed on a pack. 28… identifies a medicine, 29… a single batch.
  prescription: () => `RX${yymm()}${pad(nextSeq(`rx-${yymm()}`), 5)}`,
  drugBarcode: () => {
    const body = `28${pad(nextSeq('drug-barcode'), 10)}`;
    return body + ean13CheckDigit(body);
  },
  batchBarcode: () => {
    const body = `29${pad(nextSeq('batch-barcode'), 10)}`;
    return body + ean13CheckDigit(body);
  },
};

function generate(kind) {
  const fn = generators[kind];
  if (!fn) throw new Error(`Unknown id generator: ${kind}`);
  return fn();
}

module.exports = { generate, nextSeq, ean13CheckDigit, doctorCode, nameMnemonic };
