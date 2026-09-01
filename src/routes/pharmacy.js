'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, badRequest, conflict } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, num, money, phone, paging } = require('../lib/validate');
const { generate } = require('../lib/ids');
const pharmacy = require('../services/pharmacy');
const billing = require('../services/billing');
const whatsapp = require('../services/whatsapp');
const audit = require('../lib/audit');
const config = require('../config');

const router = express.Router();
const rxRoles = requireRole('pharmacy', 'doctor', 'nurse', 'reception', 'cashier');

// -------------------------------------------------------------- drug master
router.get('/drugs', rxRoles, wrap((req, res) => {
  const q = str(req.query.q, '');
  const { limit, offset } = paging(req.query, 50);
  const like = `%${q}%`;
  const rows = db.prepare(
    `SELECT d.*,
            COALESCE((SELECT SUM(b.qty_available) FROM drug_batches b
                       WHERE b.drug_id = d.id AND date(b.expiry_date) >= date('now')), 0) AS on_hand,
            (SELECT MIN(b.expiry_date) FROM drug_batches b
              WHERE b.drug_id = d.id AND b.qty_available > 0 AND date(b.expiry_date) >= date('now')) AS next_expiry
       FROM drugs d
      WHERE d.active = 1 AND (d.name LIKE ? OR d.generic_name LIKE ? OR d.code LIKE ?)
      ORDER BY d.name LIMIT ? OFFSET ?`
  ).all(like, like, like, limit, offset);
  res.json(rows);
}));

router.post('/drugs', requireRole('pharmacy'), wrap((req, res) => {
  required(req.body, ['code', 'name']);
  const info = db.prepare(
    `INSERT INTO drugs (code, name, generic_name, form, strength, manufacturer, hsn, tax_pct, mrp,
                        purchase_price, reorder_level, schedule_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(str(req.body.code).toUpperCase(), str(req.body.name), str(req.body.genericName), str(req.body.form),
        str(req.body.strength), str(req.body.manufacturer), str(req.body.hsn), num(req.body.taxPct, 12),
        num(req.body.mrp, 0), num(req.body.purchasePrice, 0), num(req.body.reorderLevel, 10), str(req.body.scheduleType));
  audit.log(req, 'create', 'drug', info.lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM drugs WHERE id = ?').get(info.lastInsertRowid));
}));

router.get('/drugs/:id/batches', rxRoles, wrap((req, res) => {
  res.json(db.prepare(
    'SELECT * FROM drug_batches WHERE drug_id = ? ORDER BY date(expiry_date)'
  ).all(int(req.params.id)));
}));

// ------------------------------------------------------------------- stock
router.post('/stock/receive', requireRole('pharmacy'), wrap((req, res) => {
  required(req.body, ['drugId', 'batchNo', 'expiryDate', 'qty']);
  const qty = num(req.body.qty);
  pharmacy.assertPositive(qty, 'Quantity');
  const drug = db.prepare('SELECT * FROM drugs WHERE id = ?').get(int(req.body.drugId));
  if (!drug) throw notFound('Drug not found');

  const batch = pharmacy.receiveStock({
    drugId: drug.id, batchNo: str(req.body.batchNo), expiryDate: str(req.body.expiryDate), qty,
    mrp: num(req.body.mrp, drug.mrp), purchasePrice: num(req.body.purchasePrice, drug.purchase_price),
    supplier: str(req.body.supplier), userId: req.user.id,
  });
  audit.log(req, 'receive_stock', 'drug_batch', batch.id, { qty });
  res.status(201).json(batch);
}));

router.post('/stock/adjust', requireRole('pharmacy'), wrap((req, res) => {
  required(req.body, ['batchId', 'qtyDelta', 'reason']);
  const batchId = int(req.body.batchId);
  const delta = num(req.body.qtyDelta);
  const batch = db.prepare('SELECT * FROM drug_batches WHERE id = ?').get(batchId);
  if (!batch) throw notFound('Batch not found');
  if (batch.qty_available + delta < 0) throw badRequest('Adjustment would make stock negative.');

  db.prepare('UPDATE drug_batches SET qty_available = qty_available + ? WHERE id = ?').run(delta, batchId);
  pharmacy.writeLedger({
    drugId: batch.drug_id, batchId, txnType: 'adjustment', qtyDelta: delta,
    refType: 'manual', refId: null, notes: str(req.body.reason), userId: req.user.id,
  });
  audit.log(req, 'adjust_stock', 'drug_batch', batchId, { delta, reason: req.body.reason });
  res.json(db.prepare('SELECT * FROM drug_batches WHERE id = ?').get(batchId));
}));

router.get('/stock/alerts', rxRoles, wrap((_req, res) => {
  res.json({ lowStock: pharmacy.lowStock(), expiringSoon: pharmacy.expiringSoon(90) });
}));

router.get('/stock/ledger', requireRole('pharmacy'), wrap((req, res) => {
  const drugId = req.query.drugId ? int(req.query.drugId) : null;
  res.json(db.prepare(
    `SELECT l.*, d.name AS drug_name, b.batch_no, u.name AS by_name
       FROM stock_ledger l JOIN drugs d ON d.id = l.drug_id
       LEFT JOIN drug_batches b ON b.id = l.batch_id LEFT JOIN users u ON u.id = l.created_by
      WHERE (? IS NULL OR l.drug_id = ?)
      ORDER BY l.id DESC LIMIT 200`
  ).all(drugId, drugId));
}));

// -------------------------------------------------------------- dispensing
/** The pharmacy work queue: prescriptions written but not yet handed over. */
router.get('/queue', rxRoles, wrap((_req, res) => {
  const rows = db.prepare(
    `SELECT v.id AS visit_id, v.visit_no, v.status, v.token_no, p.id AS patient_id, p.uhid,
            (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name, p.allergies,
            p.pharmacy_name, u.name AS doctor_name,
            COUNT(rx.id) AS pending_items
       FROM prescriptions rx
       JOIN visits v ON v.id = rx.visit_id
       JOIN patients p ON p.id = rx.patient_id
       LEFT JOIN users u ON u.id = v.doctor_id
      WHERE rx.status IN ('pending','partially_dispensed')
      GROUP BY v.id
      ORDER BY v.token_no, v.id`
  ).all();
  res.json(rows);
}));

router.get('/prescriptions/:visitId', rxRoles, wrap((req, res) => {
  const visitId = int(req.params.visitId);
  const rows = db.prepare(
    `SELECT rx.*, d.name AS master_name, d.form, d.strength, d.mrp, d.tax_pct, d.schedule_type,
            COALESCE((SELECT SUM(b.qty_available) FROM drug_batches b
                       WHERE b.drug_id = rx.drug_id AND date(b.expiry_date) >= date('now')), 0) AS on_hand
       FROM prescriptions rx LEFT JOIN drugs d ON d.id = rx.drug_id
      WHERE rx.visit_id = ? ORDER BY rx.id`
  ).all(visitId);
  const visit = db.prepare(
    `SELECT v.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name, p.allergies
       FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = ?`
  ).get(visitId);
  res.json({ visit, prescriptions: rows });
}));

/**
 * Dispense against a prescription. Stock is allocated FEFO, a pharmacy bill is
 * raised, and the amount is pushed onto the visit invoice so the patient
 * settles everything at one desk.
 */
router.post('/dispense', requireRole('pharmacy'), wrap((req, res) => {
  required(req.body, ['patientId', 'items']);
  const patientId = int(req.body.patientId);
  const visitId = int(req.body.visitId) || null;
  const admissionId = int(req.body.admissionId) || null;
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw badRequest('Nothing to dispense.');

  const warnings = pharmacy.safetyCheck(patientId, items.map((i) => int(i.drugId)));
  if (warnings.length && !req.body.acknowledgeWarnings) {
    throw conflict(`Safety check: ${warnings.join(' ')} Resend with acknowledgeWarnings=true to proceed.`);
  }

  const billNo = generate('pharmacyBill');
  const out = db.transaction(() => {
    const saleInfo = db.prepare(
      `INSERT INTO pharmacy_sales (bill_no, patient_id, visit_id, admission_id, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(billNo, patientId, visitId, admissionId, req.user.id);
    const saleId = saleInfo.lastInsertRowid;

    let gross = 0;
    let tax = 0;
    for (const it of items) {
      const drugId = int(it.drugId);
      const qty = num(it.qty);
      pharmacy.assertPositive(qty, `Quantity for drug #${drugId}`);
      const drug = db.prepare('SELECT * FROM drugs WHERE id = ?').get(drugId);
      if (!drug) throw notFound(`Drug #${drugId} not found`);

      for (const pick of pharmacy.allocate(drugId, qty)) {
        const unitPrice = pick.batch.mrp || drug.mrp;
        const g = pharmacy.gstOnLine({ mrp: unitPrice, qty: pick.qty, taxPct: drug.tax_pct });
        gross += g.taxable;
        tax += g.tax;

        db.prepare(
          `INSERT INTO pharmacy_sale_items (sale_id, prescription_id, drug_id, batch_id, drug_name,
                                            batch_no, expiry_date, qty, mrp, tax_pct, amount,
                                            hsn, taxable, cgst, sgst)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(saleId, int(it.prescriptionId) || null, drugId, pick.batch.id, drug.name,
              pick.batch.batch_no, pick.batch.expiry_date, pick.qty, unitPrice, drug.tax_pct,
              g.lineTotal, drug.hsn, g.taxable, g.cgst, g.sgst);

        pharmacy.consume(pick.batch.id, pick.qty);
        pharmacy.writeLedger({
          drugId, batchId: pick.batch.id, txnType: admissionId ? 'ip_issue' : 'sale',
          qtyDelta: -pick.qty, refType: 'pharmacy_sale', refId: saleId, userId: req.user.id,
          notes: `Bill ${billNo}`,
        });
      }

      if (it.prescriptionId) {
        const rx = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(int(it.prescriptionId));
        if (rx) {
          const dispensed = rx.dispensed_qty + qty;
          db.prepare('UPDATE prescriptions SET dispensed_qty = ?, status = ? WHERE id = ?')
            .run(dispensed, dispensed >= rx.quantity ? 'dispensed' : 'partially_dispensed', rx.id);
        }
      }
    }

    const discount = num(req.body.discount, 0);
    // Dispensed medicines go onto the visit invoice, which is settled to the
    // paisa at the cashier — so no rupee rounding here.
    const net = pharmacy.round2(gross + tax - discount);
    db.prepare('UPDATE pharmacy_sales SET gross = ?, discount = ?, tax = ?, net = ? WHERE id = ?')
      .run(pharmacy.round2(gross), discount, pharmacy.round2(tax), net, saleId);
    return { saleId, net };
  })();

  // Fold the pharmacy amount into the visit invoice, or raise a standalone one.
  let invoice = null;
  if (visitId) {
    invoice = db.prepare("SELECT * FROM invoices WHERE visit_id = ? AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 1").get(visitId);
  }
  if (!invoice) {
    invoice = billing.createInvoice({
      patientId, visitId, admissionId, kind: visitId ? 'opd' : 'pharmacy', createdBy: req.user.id,
    });
  }
  billing.addItem(invoice.id, {
    refType: 'pharmacy', refId: out.saleId, description: `Pharmacy — bill ${billNo}`, qty: 1, unitPrice: out.net,
  });
  db.prepare('UPDATE pharmacy_sales SET invoice_id = ? WHERE id = ?').run(invoice.id, out.saleId);

  if (visitId) {
    db.prepare("INSERT INTO visit_events (visit_id, stage, detail, actor_id) VALUES (?, 'medicines_dispensed', ?, ?)")
      .run(visitId, `${billNo} — ${items.length} item(s)`, req.user.id);
    const stillPending = db.prepare("SELECT COUNT(*) AS c FROM prescriptions WHERE visit_id = ? AND status = 'pending'").get(visitId).c;
    if (!stillPending) {
      db.prepare("UPDATE visits SET status = 'billing_pending' WHERE id = ? AND status = 'pharmacy_pending'").run(visitId);
    }
  }

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  const to = patient.whatsapp || patient.phone;
  if (to) {
    whatsapp.notify({ to, template: 'pharmacy_ready', refType: 'pharmacy_sale', refId: out.saleId,
      data: { billNo, items: items.length } });
  }

  audit.log(req, 'dispense', 'pharmacy_sale', out.saleId, { billNo, net: out.net });
  res.status(201).json({
    sale: db.prepare('SELECT * FROM pharmacy_sales WHERE id = ?').get(out.saleId),
    items: db.prepare('SELECT * FROM pharmacy_sale_items WHERE sale_id = ?').all(out.saleId),
    invoice: billing.fullInvoice(invoice.id),
    warnings,
  });
}));

/**
 * Counter sale — a walk-in buying medicines who is not our patient.
 *
 * No visit, no patient record and no clinic invoice: the pharmacy bill stands
 * on its own and is settled at the counter. Schedule H medicines still need a
 * prescription reference, because selling them without one is not lawful.
 */
router.post('/counter-sale', requireRole('pharmacy'), wrap((req, res) => {
  required(req.body, ['items']);
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw badRequest('Add at least one medicine to the bill.');

  // Schedule H cannot go over the counter on a nod.
  const scheduled = [];
  for (const it of items) {
    const drug = db.prepare('SELECT * FROM drugs WHERE id = ?').get(int(it.drugId));
    if (!drug) throw notFound(`Medicine #${it.drugId} not found`);
    if (['H', 'H1', 'X'].includes(String(drug.schedule_type || '').toUpperCase())) scheduled.push(drug.name);
  }
  const rxReference = str(req.body.rxReference);
  if (scheduled.length && !rxReference) {
    throw conflict(
      `${scheduled.join(', ')} ${scheduled.length > 1 ? 'are' : 'is'} a prescription-only medicine. ` +
      'Record the prescribing doctor and prescription date before selling it over the counter.'
    );
  }

  const billNo = generate('pharmacyBill');
  const out = db.transaction(() => {
    const saleInfo = db.prepare(
      `INSERT INTO pharmacy_sales (bill_no, sale_type, customer_name, customer_phone, rx_reference, created_by)
       VALUES (?, 'counter', ?, ?, ?, ?)`
    ).run(billNo, str(req.body.customerName), phone(req.body.customerPhone), rxReference, req.user.id);
    const saleId = saleInfo.lastInsertRowid;

    let gross = 0;
    let tax = 0;
    for (const it of items) {
      const drugId = int(it.drugId);
      const qty = num(it.qty);
      pharmacy.assertPositive(qty, `Quantity for medicine #${drugId}`);
      const drug = db.prepare('SELECT * FROM drugs WHERE id = ?').get(drugId);

      for (const pick of pharmacy.allocate(drugId, qty)) {
        const unitPrice = pick.batch.mrp || drug.mrp;
        // MRP already contains the GST, so it is extracted, never added on top.
        const g = pharmacy.gstOnLine({ mrp: unitPrice, qty: pick.qty, taxPct: drug.tax_pct });
        gross += g.taxable;
        tax += g.tax;

        db.prepare(
          `INSERT INTO pharmacy_sale_items (sale_id, drug_id, batch_id, drug_name, batch_no,
                                            expiry_date, qty, mrp, tax_pct, amount, hsn, taxable, cgst, sgst)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(saleId, drugId, pick.batch.id, drug.name, pick.batch.batch_no, pick.batch.expiry_date,
              pick.qty, unitPrice, drug.tax_pct, g.lineTotal, drug.hsn, g.taxable, g.cgst, g.sgst);

        pharmacy.consume(pick.batch.id, pick.qty);
        pharmacy.writeLedger({
          drugId, batchId: pick.batch.id, txnType: 'sale', qtyDelta: -pick.qty,
          refType: 'counter_sale', refId: saleId, userId: req.user.id,
          notes: `Counter bill ${billNo}`,
        });
      }
    }

    const discount = money(req.body.discount, 0);
    const payable = pharmacy.round2(gross + tax - discount);
    // Thermal bills are settled in cash, so the total is rounded to the rupee
    // and the adjustment is declared on the invoice rather than hidden.
    const net = Math.round(payable);
    const roundOff = pharmacy.round2(net - payable);
    const paid = req.body.paidAmount === undefined ? net : money(req.body.paidAmount);
    if (paid > net + 0.009) throw badRequest('Amount paid is more than the bill total.');

    db.prepare(
      `UPDATE pharmacy_sales SET gross = ?, discount = ?, tax = ?, net = ?, round_off = ?,
              paid_amount = ?, payment_mode = ?, payment_reference = ?,
              customer_gstin = ?, customer_address = ?
        WHERE id = ?`
    ).run(pharmacy.round2(gross), discount, pharmacy.round2(tax), net, roundOff,
          paid, str(req.body.paymentMode, 'cash'), str(req.body.paymentReference),
          str(req.body.customerGstin), str(req.body.customerAddress), saleId);

    return { saleId, net, paid };
  })();

  audit.log(req, 'counter_sale', 'pharmacy_sale', out.saleId, { billNo, net: out.net });
  res.status(201).json({
    sale: db.prepare('SELECT * FROM pharmacy_sales WHERE id = ?').get(out.saleId),
    items: db.prepare('SELECT * FROM pharmacy_sale_items WHERE sale_id = ?').all(out.saleId),
    balance: pharmacy.round2(out.net - out.paid),
    scheduledMedicines: scheduled,
  });
}));

router.get('/sales', rxRoles, wrap((req, res) => {
  const { limit, offset } = paging(req.query, 50);
  const type = str(req.query.type);
  const rows = db.prepare(
    `SELECT s.*, p.uhid, (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name, u.name AS by_name,
            (SELECT COUNT(*) FROM pharmacy_sale_items i WHERE i.sale_id = s.id) AS item_count
       FROM pharmacy_sales s LEFT JOIN patients p ON p.id = s.patient_id LEFT JOIN users u ON u.id = s.created_by
      WHERE (? IS NULL OR s.sale_type = ?)
      ORDER BY s.id DESC LIMIT ? OFFSET ?`
  ).all(type, type, limit, offset);

  const today = db.prepare(
    `SELECT sale_type, COUNT(*) AS bills, COALESCE(SUM(net), 0) AS total
       FROM pharmacy_sales WHERE date(created_at) = date('now') GROUP BY sale_type`
  ).all().reduce((a, r) => ({ ...a, [r.sale_type]: { bills: r.bills, total: r.total } }), {});

  res.json({
    rows,
    today: {
      prescription: today.prescription || { bills: 0, total: 0 },
      counter: today.counter || { bills: 0, total: 0 },
    },
  });
}));

router.get('/sales/:id', rxRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const sale = db.prepare(
    `SELECT s.*, p.uhid, p.first_name, p.last_name, p.phone FROM pharmacy_sales s
       LEFT JOIN patients p ON p.id = s.patient_id WHERE s.id = ?`
  ).get(id);
  if (!sale) throw notFound('Pharmacy bill not found');
  sale.items = db.prepare('SELECT * FROM pharmacy_sale_items WHERE sale_id = ? ORDER BY id').all(id);
  res.json(sale);
}));

/**
 * Everything a GST tax invoice must carry, assembled server-side so the printed
 * bill and the books can never drift apart. Rule 46 of the CGST Rules wants the
 * supplier's name/address/GSTIN, a consecutive serial number and date, the
 * recipient's details, HSN, taxable value, the rate-wise tax split, the total
 * in words, the place of supply and whether reverse charge applies. A chemist
 * additionally shows batch, expiry and the drug licence numbers.
 */
router.get('/sales/:id/invoice', rxRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const sale = db.prepare(
    `SELECT s.*, u.name AS billed_by,
            p.uhid, p.address AS patient_address,
            (p.first_name || ' ' || COALESCE(p.last_name,'')) AS patient_name,
            p.phone AS patient_phone, v.visit_no, d.name AS doctor_name
       FROM pharmacy_sales s
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN patients p ON p.id = s.patient_id
       LEFT JOIN visits v ON v.id = s.visit_id
       LEFT JOIN users d ON d.id = v.doctor_id
      WHERE s.id = ?`
  ).get(id);
  if (!sale) throw notFound('Pharmacy bill not found');

  const items = db.prepare(
    `SELECT i.*, dr.generic_name, dr.form, dr.strength, dr.manufacturer, dr.schedule_type,
            COALESCE(i.hsn, dr.hsn, '3004') AS hsn_code   -- medicaments, if none is set
       FROM pharmacy_sale_items i LEFT JOIN drugs dr ON dr.id = i.drug_id
      WHERE i.sale_id = ? ORDER BY i.id`
  ).all(id);

  // Older bills predate the stored split; derive it so they still print.
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
    mrpTotal: pharmacy.round2(a.mrpTotal + i.mrp * i.qty),
    qty: pharmacy.round2(a.qty + i.qty),
  }), { taxable: 0, cgst: 0, sgst: 0, mrpTotal: 0, qty: 0 });

  // Rate-wise HSN table, from what was actually charged.
  const byRate = new Map();
  for (const i of items) {
    const key = `${i.tax_pct}|${i.hsn_code || ''}`;
    const row = byRate.get(key) || { rate: i.tax_pct, hsn: i.hsn_code || '3004', taxable: 0, cgst: 0, sgst: 0 };
    row.taxable = pharmacy.round2(row.taxable + i.taxable);
    row.cgst = pharmacy.round2(row.cgst + i.cgst);
    row.sgst = pharmacy.round2(row.sgst + i.sgst);
    byRate.set(key, row);
  }

  res.json({
    supplier: {
      ...config.pharmacy,
      state: config.clinic.state,
      stateCode: config.clinic.stateCode,
      clinicName: config.clinic.name,
    },
    sale,
    items,
    summary,
    hsnSummary: [...byRate.values()].sort((a, b) => a.rate - b.rate),
    amountInWords: pharmacy.amountInWords(sale.net),
    placeOfSupply: `${config.clinic.state} (${config.clinic.stateCode})`,
    reverseCharge: 'No',
    currencySymbol: config.clinic.currencySymbol,
  });
}));

module.exports = router;
