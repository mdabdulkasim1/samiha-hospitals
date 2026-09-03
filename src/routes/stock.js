'use strict';
/**
 * Pharmacy stock register — the purchase (goods-received) side of the pharmacy,
 * kept as its own book so the counter, the ward and the auditor all read the
 * same movement history. Every batch that comes in is labelled with a scannable
 * barcode, and every unit that leaves is already tracked in `stock_ledger`, so
 * opening → inward → outward → closing reconciles for any date range.
 */
const express = require('express');
const { db } = require('../db');
const { wrap, notFound, badRequest, conflict } = require('../lib/http');
const { requireRole } = require('../lib/auth');
const { required, str, int, num, money, oneOf, paging } = require('../lib/validate');
const { generate } = require('../lib/ids');
const pharmacy = require('../services/pharmacy');
const formulary = require('../db/formulary');
const audit = require('../lib/audit');

const router = express.Router();
const readRoles = requireRole('pharmacy', 'doctor', 'nurse', 'cashier');
const stockRoles = requireRole('pharmacy');

const round2 = pharmacy.round2;
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- suppliers
router.get('/suppliers', readRoles, wrap((req, res) => {
  const q = str(req.query.q, '');
  const like = `%${q}%`;
  res.json(db.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM stock_purchases p WHERE p.supplier_id = s.id) AS purchases,
            (SELECT COALESCE(SUM(p.net - p.paid), 0) FROM stock_purchases p
              WHERE p.supplier_id = s.id AND p.status <> 'cancelled') AS outstanding
       FROM suppliers s
      WHERE (? = '' OR s.name LIKE ? OR s.code LIKE ? OR COALESCE(s.phone,'') LIKE ?)
      ORDER BY s.active DESC, s.name`
  ).all(q, like, like, like));
}));

router.post('/suppliers', stockRoles, wrap((req, res) => {
  required(req.body, ['name']);
  const code = str(req.body.code) || `SUP${String(Date.now()).slice(-6)}`;
  const info = db.prepare(
    `INSERT INTO suppliers (code, name, contact_person, phone, email, address, gstin, dl_number, credit_days, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(code.toUpperCase(), str(req.body.name), str(req.body.contactPerson), str(req.body.phone),
        str(req.body.email), str(req.body.address), str(req.body.gstin), str(req.body.dlNumber),
        int(req.body.creditDays, 0), str(req.body.notes));
  audit.log(req, 'create', 'supplier', info.lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid));
}));

router.patch('/suppliers/:id', stockRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  if (!row) throw notFound('Supplier not found');
  const fields = {
    name: 'name', contactPerson: 'contact_person', phone: 'phone', email: 'email',
    address: 'address', gstin: 'gstin', dlNumber: 'dl_number', notes: 'notes',
  };
  const sets = [];
  const args = [];
  for (const [key, col] of Object.entries(fields)) {
    if (req.body[key] !== undefined) { sets.push(`${col} = ?`); args.push(str(req.body[key])); }
  }
  if (req.body.creditDays !== undefined) { sets.push('credit_days = ?'); args.push(int(req.body.creditDays, 0)); }
  if (req.body.active !== undefined) { sets.push('active = ?'); args.push(req.body.active ? 1 : 0); }
  if (!sets.length) throw badRequest('Nothing to update.');
  db.prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  audit.log(req, 'update', 'supplier', id);
  res.json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id));
}));

// ----------------------------------------------------------------- barcodes
/**
 * One scan box for the whole pharmacy. A pack label may be the manufacturer's
 * EAN printed on the strip (held on the drug) or the label we printed for a
 * particular batch — the counter should not have to know which.
 */
router.get('/scan', readRoles, wrap((req, res) => {
  const code = str(req.query.code);
  if (!code) throw badRequest('Scan or type a barcode.');

  const batch = db.prepare(
    `SELECT b.*, d.id AS drug_id, d.code AS drug_code, d.name AS drug_name, d.form, d.strength,
            d.schedule_type, d.tax_pct, d.barcode AS pack_barcode
       FROM drug_batches b JOIN drugs d ON d.id = b.drug_id
      WHERE b.barcode = ?`
  ).get(code);
  if (batch) {
    return res.json({
      match: 'batch',
      drug: db.prepare('SELECT * FROM drugs WHERE id = ?').get(batch.drug_id),
      batch,
      expired: batch.expiry_date < today(),
      onHand: pharmacy.stockOnHand(batch.drug_id),
    });
  }

  const drug = db.prepare('SELECT * FROM drugs WHERE barcode = ? OR code = ?').get(code, code.toUpperCase());
  if (!drug) throw notFound(`No medicine is linked to barcode ${code}. Link it from the drug master first.`);
  return res.json({
    match: 'drug',
    drug,
    batches: pharmacy.availableBatches(drug.id),
    onHand: pharmacy.stockOnHand(drug.id),
  });
}));

/** Link the barcode printed on the manufacturer's pack to a medicine. */
router.post('/barcodes/drug/:id', stockRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const drug = db.prepare('SELECT * FROM drugs WHERE id = ?').get(id);
  if (!drug) throw notFound('Medicine not found');
  const code = str(req.body.barcode);
  if (!code) throw badRequest('Scan the barcode on the pack.');
  const clash = db.prepare('SELECT id, name FROM drugs WHERE barcode = ? AND id <> ?').get(code, id);
  if (clash) throw conflict(`Barcode ${code} is already linked to ${clash.name}.`);
  db.prepare('UPDATE drugs SET barcode = ? WHERE id = ?').run(code, id);
  audit.log(req, 'link_barcode', 'drug', id, { barcode: code });
  res.json(db.prepare('SELECT * FROM drugs WHERE id = ?').get(id));
}));

/** Print our own label for a batch that arrived without a scannable code. */
router.post('/barcodes/batch/:id', stockRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const batch = db.prepare('SELECT * FROM drug_batches WHERE id = ?').get(id);
  if (!batch) throw notFound('Batch not found');
  let code = str(req.body.barcode);
  if (code) {
    const clash = db.prepare('SELECT id FROM drug_batches WHERE barcode = ? AND id <> ?').get(code, id);
    if (clash) throw conflict(`Barcode ${code} is already on another batch.`);
  } else {
    code = generate('batchBarcode');
  }
  db.prepare('UPDATE drug_batches SET barcode = ? WHERE id = ?').run(code, id);
  audit.log(req, 'label_batch', 'drug_batch', id, { barcode: code });
  res.json(db.prepare(
    `SELECT b.*, d.name AS drug_name, d.form, d.strength FROM drug_batches b
       JOIN drugs d ON d.id = b.drug_id WHERE b.id = ?`
  ).get(id));
}));

/**
 * Print a code for a medicine that arrived without a scannable pack barcode.
 * The clinic sticks this label on every strip so the counter identifies the
 * medicine by scanning it, exactly like a manufacturer's EAN.
 */
router.post('/barcodes/drug/:id/generate', stockRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const drug = db.prepare('SELECT * FROM drugs WHERE id = ?').get(id);
  if (!drug) throw notFound('Medicine not found');
  if (drug.barcode && !req.body.replace) {
    throw conflict(`${drug.name} already carries barcode ${drug.barcode}.`);
  }
  const code = generate('drugBarcode');
  db.prepare('UPDATE drugs SET barcode = ? WHERE id = ?').run(code, id);
  audit.log(req, 'generate_barcode', 'drug', id, { barcode: code });
  res.json(db.prepare('SELECT * FROM drugs WHERE id = ?').get(id));
}));

/** One pass over the formulary so nothing is left without a scannable code. */
router.post('/barcodes/generate-missing', stockRoles, wrap((req, res) => {
  const pending = db.prepare(
    "SELECT id, name FROM drugs WHERE active = 1 AND (barcode IS NULL OR barcode = '') ORDER BY name"
  ).all();
  const done = db.transaction(() => pending.map((d) => {
    const code = generate('drugBarcode');
    db.prepare('UPDATE drugs SET barcode = ? WHERE id = ?').run(code, d.id);
    return { id: d.id, name: d.name, barcode: code };
  }))();
  audit.log(req, 'generate_barcodes', 'drug', null, { count: done.length });
  res.json({ generated: done.length, drugs: done });
}));

/** Which medicines can be scanned today, and which still need a label. */
router.get('/barcodes', readRoles, wrap((req, res) => {
  const q = str(req.query.q, '');
  const like = `%${q}%`;
  const rows = db.prepare(
    `SELECT d.id, d.code, d.name, d.generic_name, d.form, d.strength, d.manufacturer,
            d.mrp, d.schedule_type, d.barcode,
            COALESCE((SELECT SUM(b.qty_available) FROM drug_batches b WHERE b.drug_id = d.id), 0) AS on_hand,
            (SELECT COUNT(*) FROM drug_batches b WHERE b.drug_id = d.id AND b.barcode IS NOT NULL) AS labelled_batches
       FROM drugs d
      WHERE d.active = 1 AND (? = '' OR d.name LIKE ? OR d.code LIKE ?
                              OR COALESCE(d.generic_name,'') LIKE ? OR COALESCE(d.barcode,'') LIKE ?)
      ORDER BY d.name`
  ).all(q, like, like, like, like);
  const missing = rows.filter((r) => !r.barcode).length;
  res.json({ rows, total: rows.length, missing });
}));

/** Everything needed to print a sheet of medicine labels. */
router.get('/labels/drugs', readRoles, wrap((req, res) => {
  const ids = str(req.query.drugIds, '').split(',').map((v) => parseInt(v, 10)).filter(Boolean);
  const rows = ids.length
    ? db.prepare(
        `SELECT id, code, name, generic_name, form, strength, manufacturer, mrp, barcode
           FROM drugs WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`
      ).all(...ids)
    : db.prepare(
        "SELECT id, code, name, generic_name, form, strength, manufacturer, mrp, barcode " +
        "FROM drugs WHERE active = 1 AND barcode IS NOT NULL ORDER BY name"
      ).all();
  const unlabelled = rows.filter((r) => !r.barcode).map((r) => r.name);
  if (unlabelled.length) {
    throw badRequest(`These medicines have no barcode yet: ${unlabelled.join(', ')}. Generate one first.`);
  }
  res.json(rows);
}));

/** Everything needed to print a sheet of batch labels. */
router.get('/labels', readRoles, wrap((req, res) => {
  const ids = str(req.query.batchIds, '').split(',').map((v) => parseInt(v, 10)).filter(Boolean);
  if (!ids.length) throw badRequest('Choose at least one batch to print.');
  const rows = db.prepare(
    `SELECT b.id, b.batch_no, b.expiry_date, b.mrp, b.barcode, b.qty_available,
            d.name AS drug_name, d.form, d.strength, d.manufacturer
       FROM drug_batches b JOIN drugs d ON d.id = b.drug_id
      WHERE b.id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  res.json(rows);
}));

// ------------------------------------------------- goods received (purchase)
router.get('/purchases', readRoles, wrap((req, res) => {
  const { limit, offset } = paging(req.query, 50);
  const supplierId = req.query.supplierId ? int(req.query.supplierId) : null;
  const status = oneOf(req.query.status, ['received', 'partially_paid', 'paid', 'cancelled'], 'status');
  const rows = db.prepare(
    `SELECT p.*, s.name AS supplier_name, u.name AS received_by,
            (SELECT COUNT(*) FROM stock_purchase_items i WHERE i.purchase_id = p.id) AS lines
       FROM stock_purchases p JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN users u ON u.id = p.created_by
      WHERE (? IS NULL OR p.supplier_id = ?) AND (? IS NULL OR p.status = ?)
      ORDER BY p.id DESC LIMIT ? OFFSET ?`
  ).all(supplierId, supplierId, status, status, limit, offset);
  const totals = db.prepare(
    `SELECT COALESCE(SUM(net), 0) AS net, COALESCE(SUM(net - paid), 0) AS outstanding
       FROM stock_purchases WHERE status <> 'cancelled'`
  ).get();
  res.json({ rows, totals });
}));

router.get('/purchases/:id', readRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const purchase = db.prepare(
    `SELECT p.*, s.name AS supplier_name, s.gstin, s.phone AS supplier_phone, u.name AS received_by
       FROM stock_purchases p JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?`
  ).get(id);
  if (!purchase) throw notFound('Goods-received note not found');
  purchase.items = db.prepare(
    `SELECT i.*, d.name AS drug_name, d.form, d.strength, b.barcode
       FROM stock_purchase_items i JOIN drugs d ON d.id = i.drug_id
       LEFT JOIN drug_batches b ON b.id = i.batch_id
      WHERE i.purchase_id = ? ORDER BY i.id`
  ).all(id);
  res.json(purchase);
}));

/**
 * Book a supplier invoice. Each line creates or tops up a batch, prints a
 * barcode for it when the pack has none, and posts a `purchase` movement to the
 * ledger — all in one transaction so a bad line never leaves half a delivery in.
 */
router.post('/purchases', stockRoles, wrap((req, res) => {
  required(req.body, ['supplierId', 'items']);
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(int(req.body.supplierId));
  if (!supplier) throw notFound('Supplier not found');
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw badRequest('Add at least one medicine to the goods-received note.');

  for (const it of items) {
    required(it, ['drugId', 'batchNo', 'expiryDate', 'qty']);
    pharmacy.assertPositive(num(it.qty), 'Quantity');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str(it.expiryDate, ''))) {
      throw badRequest(`Expiry for batch ${it.batchNo} must be a date (YYYY-MM-DD).`);
    }
    if (str(it.expiryDate) <= today()) {
      throw badRequest(`Batch ${it.batchNo} expires on ${it.expiryDate} — do not take expired stock in.`);
    }
  }

  const grnNo = generate('grn');
  const out = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO stock_purchases (grn_no, supplier_id, invoice_no, invoice_date, due_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(grnNo, supplier.id, str(req.body.invoiceNo), str(req.body.invoiceDate),
          str(req.body.dueDate), str(req.body.notes), req.user.id);
    const purchaseId = info.lastInsertRowid;

    let gross = 0;
    let tax = 0;
    let lineDiscount = 0;
    const batches = [];

    for (const it of items) {
      const drug = db.prepare('SELECT * FROM drugs WHERE id = ?').get(int(it.drugId));
      if (!drug) throw notFound(`Medicine #${it.drugId} not found`);
      const qty = num(it.qty);
      const freeQty = num(it.freeQty, 0);
      const purchasePrice = money(it.purchasePrice, drug.purchase_price);
      const mrp = money(it.mrp, drug.mrp);
      const taxPct = num(it.taxPct, drug.tax_pct);
      const discountPct = num(it.discountPct, 0);

      const lineGross = purchasePrice * qty;
      const lineDisc = round2(lineGross * (discountPct / 100));
      const lineTax = round2((lineGross - lineDisc) * (taxPct / 100));
      gross += lineGross;
      lineDiscount += lineDisc;
      tax += lineTax;

      const batch = pharmacy.receiveStock({
        drugId: drug.id, batchNo: str(it.batchNo), expiryDate: str(it.expiryDate),
        qty: qty + freeQty, mrp, purchasePrice, supplier: supplier.name, userId: req.user.id,
        barcode: str(it.barcode) || generate('batchBarcode'),
        refType: 'purchase', refId: purchaseId, notes: `GRN ${grnNo} — ${supplier.name}`,
      });
      batches.push(batch);

      db.prepare(
        `INSERT INTO stock_purchase_items (purchase_id, drug_id, batch_id, batch_no, expiry_date, qty,
                                           free_qty, purchase_price, mrp, tax_pct, discount_pct, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(purchaseId, drug.id, batch.id, str(it.batchNo), str(it.expiryDate), qty, freeQty,
            purchasePrice, mrp, taxPct, discountPct, round2(lineGross - lineDisc + lineTax));

      // Keep the drug master's prices current with the latest delivery.
      db.prepare('UPDATE drugs SET mrp = ?, purchase_price = ? WHERE id = ?').run(mrp, purchasePrice, drug.id);
      if (str(it.packBarcode)) {
        const clash = db.prepare('SELECT id FROM drugs WHERE barcode = ? AND id <> ?').get(str(it.packBarcode), drug.id);
        if (clash) throw conflict(`Pack barcode ${it.packBarcode} is already linked to another medicine.`);
        db.prepare('UPDATE drugs SET barcode = ? WHERE id = ?').run(str(it.packBarcode), drug.id);
      }
    }

    const headDiscount = money(req.body.discount, 0);
    const discount = round2(lineDiscount + headDiscount);
    const net = round2(gross - discount + tax);
    const paid = money(req.body.paid, 0);
    if (paid > net + 0.009) throw badRequest('Amount paid is more than the invoice total.');
    const status = paid <= 0 ? 'received' : paid >= net - 0.009 ? 'paid' : 'partially_paid';

    db.prepare(
      `UPDATE stock_purchases SET gross = ?, discount = ?, tax = ?, net = ?, paid = ?, status = ?
        WHERE id = ?`
    ).run(round2(gross), discount, round2(tax), net, paid, status, purchaseId);

    return { purchaseId, grnNo, net, batches };
  })();

  audit.log(req, 'goods_received', 'stock_purchase', out.purchaseId, { grnNo: out.grnNo, net: out.net });
  res.status(201).json({
    purchase: db.prepare('SELECT * FROM stock_purchases WHERE id = ?').get(out.purchaseId),
    items: db.prepare('SELECT * FROM stock_purchase_items WHERE purchase_id = ?').all(out.purchaseId),
    batches: out.batches,
  });
}));

router.post('/purchases/:id/pay', stockRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const purchase = db.prepare('SELECT * FROM stock_purchases WHERE id = ?').get(id);
  if (!purchase) throw notFound('Goods-received note not found');
  if (purchase.status === 'cancelled') throw conflict('This goods-received note was cancelled.');
  const amount = money(req.body.amount);
  pharmacy.assertPositive(amount, 'Payment');
  const paid = round2(purchase.paid + amount);
  if (paid > purchase.net + 0.009) throw badRequest('That would pay more than the invoice total.');
  const status = paid >= purchase.net - 0.009 ? 'paid' : 'partially_paid';
  db.prepare('UPDATE stock_purchases SET paid = ?, status = ? WHERE id = ?').run(paid, status, id);
  audit.log(req, 'pay_supplier', 'stock_purchase', id, { amount });
  res.json(db.prepare('SELECT * FROM stock_purchases WHERE id = ?').get(id));
}));

// ------------------------------------------------------------ stock register
/**
 * The register proper: for every medicine, what we held at the start of the
 * period, what came in, what went out and by which route, and what is left.
 */
router.get('/register', readRoles, wrap((req, res) => {
  const from = str(req.query.from) || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const to = str(req.query.to) || today();
  const drugId = req.query.drugId ? int(req.query.drugId) : null;
  const q = str(req.query.q, '');
  const like = `%${q}%`;

  const rows = db.prepare(
    `SELECT d.id AS drug_id, d.code, d.name, d.form, d.strength, d.schedule_type, d.barcode,
            d.reorder_level, d.mrp, d.purchase_price,
            COALESCE((SELECT SUM(l.qty_delta) FROM stock_ledger l
                       WHERE l.drug_id = d.id AND date(l.created_at) < date(?)), 0) AS opening,
            COALESCE((SELECT SUM(l.qty_delta) FROM stock_ledger l
                       WHERE l.drug_id = d.id AND date(l.created_at) BETWEEN date(?) AND date(?)
                         AND l.qty_delta > 0), 0) AS inward,
            COALESCE((SELECT -SUM(l.qty_delta) FROM stock_ledger l
                       WHERE l.drug_id = d.id AND date(l.created_at) BETWEEN date(?) AND date(?)
                         AND l.qty_delta < 0), 0) AS outward,
            COALESCE((SELECT SUM(b.qty_available) FROM drug_batches b WHERE b.drug_id = d.id), 0) AS on_hand,
            COALESCE((SELECT SUM(b.qty_available * b.purchase_price) FROM drug_batches b
                       WHERE b.drug_id = d.id), 0) AS stock_value,
            COALESCE((SELECT SUM(b.qty_available) FROM drug_batches b
                       WHERE b.drug_id = d.id AND date(b.expiry_date) < date('now')), 0) AS expired_qty
       FROM drugs d
      WHERE (? IS NULL OR d.id = ?)
        AND (? = '' OR d.name LIKE ? OR d.code LIKE ? OR COALESCE(d.generic_name,'') LIKE ?)
      ORDER BY d.name`
  ).all(from, from, to, from, to, drugId, drugId, q, like, like, like);

  for (const r of rows) r.closing = round2(r.opening + r.inward - r.outward);

  const totals = rows.reduce((a, r) => ({
    medicines: a.medicines + 1,
    inward: round2(a.inward + r.inward),
    outward: round2(a.outward + r.outward),
    onHand: round2(a.onHand + r.on_hand),
    stockValue: round2(a.stockValue + r.stock_value),
    expiredQty: round2(a.expiredQty + r.expired_qty),
  }), { medicines: 0, inward: 0, outward: 0, onHand: 0, stockValue: 0, expiredQty: 0 });

  res.json({ from, to, rows, totals });
}));

/** Every movement of one medicine, newest first, for the drill-down. */
router.get('/register/:drugId/movements', readRoles, wrap((req, res) => {
  const drugId = int(req.params.drugId);
  const drug = db.prepare('SELECT * FROM drugs WHERE id = ?').get(drugId);
  if (!drug) throw notFound('Medicine not found');
  const from = str(req.query.from);
  const to = str(req.query.to);
  const movements = db.prepare(
    `SELECT l.*, b.batch_no, b.expiry_date, b.barcode, u.name AS by_name
       FROM stock_ledger l LEFT JOIN drug_batches b ON b.id = l.batch_id
       LEFT JOIN users u ON u.id = l.created_by
      WHERE l.drug_id = ?
        AND (? IS NULL OR date(l.created_at) >= date(?))
        AND (? IS NULL OR date(l.created_at) <= date(?))
      ORDER BY l.id DESC LIMIT 500`
  ).all(drugId, from, from, to, to);
  const batches = db.prepare(
    'SELECT * FROM drug_batches WHERE drug_id = ? ORDER BY date(expiry_date)'
  ).all(drugId);
  res.json({ drug, batches, movements });
}));

/**
 * Set what is actually on the shelf for one medicine.
 *
 * The register's "opening" is not a number anyone can edit: it is worked out
 * from the ledger up to the start of the window, so writing over it would
 * leave a total that no longer matches the movements it is supposed to
 * summarise. What a pharmacist actually wants is to say how many there are,
 * which is what this does — and it does it the same way a stock take does, by
 * writing the difference to the ledger with a reason attached, so the register
 * still reconciles afterwards and the change can be traced to whoever made it.
 *
 * Stock cannot exist apart from a batch, because a batch is what carries the
 * expiry and the printed price. So the first count on a medicine that has none
 * asks for a batch number, an expiry and the MRP off the pack, and later counts
 * adjust the batch already there.
 */
router.post('/opening', stockRoles, wrap((req, res) => {
  required(req.body, ['drugId', 'qty']);
  const drugId = int(req.body.drugId);
  const drug = db.prepare('SELECT * FROM drugs WHERE id = ? AND active = 1').get(drugId);
  if (!drug) throw notFound('Medicine not found');

  const qty = num(req.body.qty);
  if (!(qty >= 0)) throw badRequest('A count cannot be negative.');

  const batchNo = str(req.body.batchNo);
  let batch = batchNo
    ? db.prepare('SELECT * FROM drug_batches WHERE drug_id = ? AND batch_no = ?').get(drugId, batchNo)
    : db.prepare(
        `SELECT * FROM drug_batches WHERE drug_id = ?
          ORDER BY (qty_available > 0) DESC, date(expiry_date) LIMIT 1`
      ).get(drugId);

  const out = db.transaction(() => {
    if (!batch) {
      // A new batch needs the two things only the pack can tell us.
      for (const field of ['batchNo', 'expiryDate']) {
        if (!str(req.body[field])) {
          throw badRequest('A first count needs the batch number and expiry printed on the pack.');
        }
      }
      const expiry = str(req.body.expiryDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw badRequest('Expiry must be a date (YYYY-MM-DD).');
      if (expiry <= today()) throw badRequest(`That batch expired on ${expiry} — do not take it into stock.`);

      /*
       * A first count may be taken before the medicine is priced. Stock
       * arriving and stock being priced are two different jobs, often done by
       * two different people on two different days, and refusing the count
       * until somebody knows the MRP leaves the shelf full and the register
       * empty. What an unpriced medicine cannot do is be sold: the counter
       * refuses it by name until a rate is set.
       */
      const mrp = num(req.body.mrp, drug.mrp || 0);
      if (mrp < 0) throw badRequest('A price cannot be negative.');
      const info = db.prepare(
        `INSERT INTO drug_batches (drug_id, batch_no, expiry_date, qty_received, qty_available,
                                   mrp, purchase_price, supplier)
         VALUES (?, ?, ?, 0, 0, ?, ?, ?)`
      ).run(drugId, str(req.body.batchNo), expiry, mrp,
            num(req.body.purchasePrice, drug.purchase_price || 0), str(req.body.supplier) || 'Opening stock');
      batch = db.prepare('SELECT * FROM drug_batches WHERE id = ?').get(info.lastInsertRowid);

      // The drug's default price follows the first pack that arrives, so the
      // formulary stops reading zero the moment there is stock to sell.
      if (!drug.mrp) db.prepare('UPDATE drugs SET mrp = ? WHERE id = ?').run(mrp, drugId);
    } else if (req.body.mrp !== undefined && num(req.body.mrp) > 0) {
      db.prepare('UPDATE drug_batches SET mrp = ? WHERE id = ?').run(num(req.body.mrp), batch.id);
    }

    const delta = round2(qty - batch.qty_available);
    if (delta) {
      db.prepare(
        `UPDATE drug_batches
            SET qty_available = ?,
                qty_received = CASE WHEN ? > 0 THEN qty_received + ? ELSE qty_received END
          WHERE id = ?`
      ).run(qty, delta, delta, batch.id);
      pharmacy.writeLedger({
        drugId, batchId: batch.id, txnType: 'adjustment', qtyDelta: delta,
        refType: 'opening_stock', refId: batch.id, userId: req.user.id,
        notes: str(req.body.reason) || 'Counted on the shelf',
      });
    }
    return { batchId: batch.id, delta };
  })();

  audit.log(req, 'set_stock', 'drug', drugId,
    { batchId: out.batchId, to: qty, delta: out.delta, reason: str(req.body.reason) || null });

  res.json({
    drug: db.prepare('SELECT * FROM drugs WHERE id = ?').get(drugId),
    batch: db.prepare('SELECT * FROM drug_batches WHERE id = ?').get(out.batchId),
    delta: out.delta,
    onHand: db.prepare(
      'SELECT COALESCE(SUM(qty_available), 0) AS q FROM drug_batches WHERE drug_id = ?'
    ).get(drugId).q,
  });
}));

/**
 * The opening-stock sheet: every medicine on the formulary, what is on the
 * shelf now, and what the clinic's own starter list suggested ordering.
 *
 * A new pharmacy is stocked in one sitting, not one medicine at a time, and
 * the suggested quantity is the number the clinic already wrote down when it
 * planned the shelf. Putting it in front of the pharmacist as a proposal —
 * theirs to overwrite with what they actually counted — is the difference
 * between an afternoon's typing and a morning's.
 */
router.get('/opening/sheet', readRoles, wrap((_req, res) => {
  const suggested = new Map(formulary.map((f) => [f[0], f[8]]));
  const packs = new Map(formulary.map((f) => [f[0], f[7]]));

  const rows = db.prepare(
    `SELECT d.id, d.code, d.name, d.generic_name, d.form, d.strength, d.category,
            d.schedule_type AS schedule, d.pack_size, d.mrp, d.purchase_price, d.reorder_level,
            COALESCE(SUM(b.qty_available), 0) AS on_hand,
            COUNT(b.id) AS batches
       FROM drugs d LEFT JOIN drug_batches b ON b.drug_id = d.id
      WHERE d.active = 1
      GROUP BY d.id
      ORDER BY d.category, d.name`
  ).all();

  for (const r of rows) {
    r.suggested = suggested.has(r.code) ? suggested.get(r.code) : null;
    r.pack = packs.get(r.code) || r.pack_size || null;
    r.needsCount = r.on_hand <= 0;
    r.needsRate = !(r.mrp > 0);
  }

  res.json({
    rows,
    totals: {
      medicines: rows.length,
      needCount: rows.filter((r) => r.needsCount).length,
      needRate: rows.filter((r) => r.needsRate).length,
      onShelf: rows.filter((r) => !r.needsCount).length,
    },
  });
}));

/**
 * Take the whole sheet into stock in one go.
 *
 * Every line goes through the same first-count path a single medicine does, so
 * the ledger reads the same whether the shelf was filled one row at a time or
 * all at once. The lot is one transaction: a sheet that fails half way through
 * would leave nobody able to say what had been counted and what had not.
 */
router.post('/opening/bulk', stockRoles, wrap((req, res) => {
  const lines = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!lines.length) throw badRequest('Nothing to take into stock.');
  if (lines.length > 500) throw badRequest('Take the sheet in at most 500 medicines at a time.');

  const stamp = today();
  const defaultBatch = str(req.body.batchNo) || `OPEN-${stamp.slice(0, 7).replace('-', '')}`;
  const defaultExpiry = str(req.body.expiryDate)
    || new Date(Date.now() + 730 * 86400000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(defaultExpiry)) throw badRequest('Expiry must be a date (YYYY-MM-DD).');
  if (defaultExpiry <= stamp) throw badRequest(`That expiry is in the past — do not take stock in against it.`);

  const out = db.transaction(() => {
    const done = [];
    const skipped = [];

    for (const line of lines) {
      const drugId = int(line.drugId);
      const drug = db.prepare('SELECT * FROM drugs WHERE id = ? AND active = 1').get(drugId);
      if (!drug) { skipped.push({ drugId, why: 'not on the formulary' }); continue; }

      const qty = num(line.qty, 0);
      if (!(qty > 0)) { skipped.push({ drugId, name: drug.name, why: 'no quantity given' }); continue; }

      const expiry = str(line.expiryDate) || defaultExpiry;
      const mrp = line.mrp === undefined || line.mrp === '' ? (drug.mrp || 0) : num(line.mrp);
      if (mrp < 0) throw badRequest(`A price cannot be negative (${drug.name}).`);
      const cost = line.purchasePrice === undefined || line.purchasePrice === ''
        ? (drug.purchase_price || 0) : num(line.purchasePrice);

      /*
       * Which batch the count belongs to. A named batch is taken at its word.
       * Otherwise a medicine that already has one is being recounted, so the
       * count corrects that batch rather than stacking a second one beside it
       * and doubling what the shelf appears to hold; only a medicine with no
       * batch at all gets this take-in's opening label.
       */
      const batchNo = str(line.batchNo) || null;
      let batch = batchNo
        ? db.prepare('SELECT * FROM drug_batches WHERE drug_id = ? AND batch_no = ?').get(drugId, batchNo)
        : db.prepare(
            `SELECT * FROM drug_batches WHERE drug_id = ?
              ORDER BY (qty_available > 0) DESC, date(expiry_date) LIMIT 1`
          ).get(drugId);

      if (!batch) {
        if (expiry <= stamp) { skipped.push({ drugId, name: drug.name, why: 'that batch has expired' }); continue; }
        const info = db.prepare(
          `INSERT INTO drug_batches (drug_id, batch_no, expiry_date, qty_received, qty_available,
                                     mrp, purchase_price, supplier)
           VALUES (?, ?, ?, 0, 0, ?, ?, 'Opening stock')`
        ).run(drugId, batchNo || defaultBatch, expiry, mrp, cost);
        batch = db.prepare('SELECT * FROM drug_batches WHERE id = ?').get(info.lastInsertRowid);
      } else if (mrp > 0 && mrp !== batch.mrp) {
        db.prepare('UPDATE drug_batches SET mrp = ? WHERE id = ?').run(mrp, batch.id);
      }

      // The count on the shelf replaces whatever the register held for this
      // batch; the difference is the adjustment, so the ledger still adds up.
      const delta = round2(qty - batch.qty_available);
      if (delta) {
        db.prepare(
          `UPDATE drug_batches
              SET qty_available = ?,
                  qty_received = CASE WHEN ? > 0 THEN qty_received + ? ELSE qty_received END
            WHERE id = ?`
        ).run(qty, delta, delta, batch.id);
        pharmacy.writeLedger({
          drugId, batchId: batch.id, txnType: 'adjustment', qtyDelta: delta,
          refType: 'opening_stock', refId: batch.id, userId: req.user.id,
          notes: str(req.body.reason) || 'Opening stock counted onto the shelf',
        });
      }

      // A medicine with no rate anywhere gets the one entered here, so the
      // formulary stops reading zero the moment there is stock to sell.
      if (mrp > 0 && !(drug.mrp > 0)) {
        db.prepare('UPDATE drugs SET mrp = ?, purchase_price = COALESCE(NULLIF(purchase_price, 0), ?) WHERE id = ?')
          .run(mrp, cost, drugId);
      }

      done.push({ drugId, name: drug.name, qty, delta, batchNo: batch.batch_no, priced: mrp > 0 });
    }

    return { done, skipped };
  })();

  audit.log(req, 'opening_stock_bulk', 'drug', null,
    { taken: out.done.length, skipped: out.skipped.length, batchNo: defaultBatch });

  res.json({
    batchNo: defaultBatch,
    expiryDate: defaultExpiry,
    taken: out.done.length,
    units: round2(out.done.reduce((t, d) => t + d.qty, 0)),
    unpriced: out.done.filter((d) => !d.priced).map((d) => d.name),
    skipped: out.skipped,
  });
}));

// ----------------------------------------------------------------- stocktake
router.get('/takes', readRoles, wrap((req, res) => {
  const { limit, offset } = paging(req.query, 25);
  res.json(db.prepare(
    `SELECT t.*, u.name AS counted_by_name FROM stock_takes t
       LEFT JOIN users u ON u.id = t.counted_by
      ORDER BY t.id DESC LIMIT ? OFFSET ?`
  ).all(limit, offset));
}));

router.get('/takes/:id', readRoles, wrap((req, res) => {
  const id = int(req.params.id);
  const take = db.prepare(
    `SELECT t.*, u.name AS counted_by_name FROM stock_takes t
       LEFT JOIN users u ON u.id = t.counted_by WHERE t.id = ?`
  ).get(id);
  if (!take) throw notFound('Stock take not found');
  take.items = db.prepare(
    `SELECT i.*, d.name AS drug_name, b.batch_no, b.expiry_date
       FROM stock_take_items i JOIN drugs d ON d.id = i.drug_id
       JOIN drug_batches b ON b.id = i.batch_id
      WHERE i.take_id = ? ORDER BY i.id`
  ).all(id);
  res.json(take);
}));

/** The physical count sheet: what the system thinks is on the shelf. */
router.get('/takes/new/sheet', stockRoles, wrap((req, res) => {
  const q = str(req.query.q, '');
  const like = `%${q}%`;
  res.json(db.prepare(
    `SELECT b.id AS batch_id, b.batch_no, b.expiry_date, b.barcode, b.qty_available AS book_qty,
            d.id AS drug_id, d.code, d.name AS drug_name, d.form, d.strength
       FROM drug_batches b JOIN drugs d ON d.id = b.drug_id
      WHERE b.qty_available > 0 AND (? = '' OR d.name LIKE ? OR d.code LIKE ? OR COALESCE(b.barcode,'') LIKE ?)
      ORDER BY d.name, date(b.expiry_date)`
  ).all(q, like, like, like));
}));

/**
 * Post a physical count. Any difference against the book is written to the
 * ledger as an adjustment with the counter's reason, never silently absorbed.
 */
router.post('/takes', stockRoles, wrap((req, res) => {
  required(req.body, ['items']);
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw badRequest('Count at least one batch.');

  const reference = generate('stockTake');
  const out = db.transaction(() => {
    const info = db.prepare(
      'INSERT INTO stock_takes (reference, notes, counted_by) VALUES (?, ?, ?)'
    ).run(reference, str(req.body.notes), req.user.id);
    const takeId = info.lastInsertRowid;

    let variances = 0;
    for (const it of items) {
      required(it, ['batchId', 'countedQty']);
      const batch = db.prepare('SELECT * FROM drug_batches WHERE id = ?').get(int(it.batchId));
      if (!batch) throw notFound(`Batch #${it.batchId} not found`);
      const counted = num(it.countedQty);
      if (counted < 0) throw badRequest('A counted quantity cannot be negative.');
      const bookQty = batch.qty_available;
      const variance = round2(counted - bookQty);

      db.prepare(
        `INSERT INTO stock_take_items (take_id, drug_id, batch_id, book_qty, counted_qty, variance, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(takeId, batch.drug_id, batch.id, bookQty, counted, variance, str(it.reason));

      if (variance !== 0) {
        variances += 1;
        db.prepare('UPDATE drug_batches SET qty_available = ? WHERE id = ?').run(counted, batch.id);
        pharmacy.writeLedger({
          drugId: batch.drug_id, batchId: batch.id, txnType: 'adjustment', qtyDelta: variance,
          refType: 'stock_take', refId: takeId, userId: req.user.id,
          notes: `Stock take ${reference}${it.reason ? ` — ${str(it.reason)}` : ''}`,
        });
      }
    }

    db.prepare('UPDATE stock_takes SET lines = ?, variances = ? WHERE id = ?')
      .run(items.length, variances, takeId);
    return { takeId, variances };
  })();

  audit.log(req, 'stock_take', 'stock_take', out.takeId, { reference, variances: out.variances });
  res.status(201).json(db.prepare('SELECT * FROM stock_takes WHERE id = ?').get(out.takeId));
}));

/** Write expired batches off the shelf so the register stops counting them. */
router.post('/write-off-expired', stockRoles, wrap((req, res) => {
  const batches = db.prepare(
    "SELECT * FROM drug_batches WHERE qty_available > 0 AND date(expiry_date) < date('now')"
  ).all();
  if (!batches.length) return res.json({ written: 0, value: 0, batches: [] });

  const out = db.transaction(() => {
    let value = 0;
    for (const b of batches) {
      value += b.qty_available * b.purchase_price;
      db.prepare('UPDATE drug_batches SET qty_available = 0 WHERE id = ?').run(b.id);
      pharmacy.writeLedger({
        drugId: b.drug_id, batchId: b.id, txnType: 'expiry', qtyDelta: -b.qty_available,
        refType: 'expiry', refId: b.id, userId: req.user.id,
        notes: `Expired ${b.expiry_date} — batch ${b.batch_no}`,
      });
    }
    return round2(value);
  })();

  audit.log(req, 'write_off_expired', 'drug_batch', null, { batches: batches.length, value: out });
  res.json({ written: batches.length, value: out, batches });
}));

module.exports = router;
