'use strict';
const { db } = require('../db');

/**
 * Atomic per-name counter. All human-facing document numbers come from here so
 * UHIDs, invoice numbers and IP numbers are gap-free and never collide.
 */
function nextSeq(name) {
  const row = db.prepare(
    `INSERT INTO counters (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1
     RETURNING value`
  ).get(name);
  return row.value;
}

function pad(n, width) { return String(n).padStart(width, '0'); }

const yy = () => String(new Date().getFullYear()).slice(-2);
const yymm = () => {
  const d = new Date();
  return `${String(d.getFullYear()).slice(-2)}${pad(d.getMonth() + 1, 2)}`;
};

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
};

function generate(kind) {
  const fn = generators[kind];
  if (!fn) throw new Error(`Unknown id generator: ${kind}`);
  return fn();
}

module.exports = { generate, nextSeq };
