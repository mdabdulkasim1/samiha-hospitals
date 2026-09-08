'use strict';
const express = require('express');
const { db, tx } = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const ids = require('../lib/ids');
const v = require('../lib/validate');
const { wrap, badRequest, notFound, conflict } = require('../lib/http');
const docs = require('../services/documents');
const pricing = require('../services/pricing');
const terms = require('../services/terms');
const stock = require('../services/stock');
const settlement = require('../services/settlement');
const notify = require('../services/notify');
const clauses = require('../services/clauses');
const enquiries = require('../services/enquiries');

const router = express.Router();

/*
 * The buy side, in the order the company works it:
 *
 *   0. raise the enquiry                         (RFQ to the manufacturer)
 *   1. their price against it                    (supplier quotation)
 *   2. confirm the price                         (approve the quotation)
 *   3. send the LPO                              (purchase order)      -> ON ORDER
 *   4. take the material in                      (goods receipt note)  -> IN STOCK
 *   5. book their invoice, on their terms        (supplier invoice)
 *   6. pay them when it falls due                (payment out)
 *
 * Step 0 is the company's own rule: a manufacturer's quotation is always the
 * answer to an enquiry we raised, so there is a record of what was asked, when,
 * and of whom — including the makers who never came back. The rule is enforced
 * where the quotation is created, not left to the screen.
 *
 * Step 3 is the one that touches the stock register: the company treats
 * material on an outstanding LPO as stock it has coming, so the LPO writes it
 * into the "on order" bucket and the receipt moves it across into the yard.
 */

const buyer = auth.requireRole('kam');                    // negotiates and orders
const receiver = auth.requireRole('logistics', 'kam');    // takes the material in
const bookkeeper = auth.requireRole('accounts');          // books and pays
/*
 * Reading a supplier's bills is not the same as booking one. The key account
 * manager answers for what we owe a manufacturer and when — they need to see
 * the bills and what is falling due; entering and paying them stays with
 * accounts.
 */
const billReader = auth.requireRole('accounts', 'kam');

// ========================================================= enquiries we send
/*
 * The enquiry that starts the buying side. Same table, same shape and the same
 * screen as a client's enquiry — read the other way round: this is what we
 * have asked a manufacturer to price. Nothing but an enquiry can be quoted
 * against, so this is where the buy side begins.
 */
router.get('/enquiries', wrap(async (req, res) => {
  res.json(enquiries.list('supplier', req.query));
}));

router.get('/enquiries/:id', wrap(async (req, res) => {
  const row = enquiries.get(req.params.id, 'supplier');
  if (!row) throw notFound('No such enquiry.');
  res.json({
    enquiry: row,
    quotations: db.prepare(`SELECT id, quote_no, quote_date, supplier_ref, total, status
        FROM supplier_quotations WHERE enquiry_id = ? ORDER BY id`).all(row.id),
  });
}));

router.post('/enquiries', buyer, wrap(async (req, res) => {
  const company = docs.companyFor(req, req.body);
  const made = enquiries.create('supplier', req.body, { company, user: req.user });
  audit.log(req, 'supplier_enquiry.created', 'enquiry', made.id, { enquiryNo: made.enquiryNo });
  res.status(201).json(made.row);
}));

router.patch('/enquiries/:id', buyer, wrap(async (req, res) => {
  res.json(enquiries.update('supplier', req.params.id, req.body));
}));

// ============================================================ supplier quotes
const SQ_SELECT = `
  SELECT q.*, p.name AS supplier_name, p.code AS supplier_code, p.trn AS supplier_trn,
         e.enquiry_no, e.requirement AS enquiry_requirement, e.due_on AS enquiry_due_on,
         a.name AS application_name, a.code AS application_code,
         t.name AS terms_name, c.code AS company_code, c.name AS company_name,
         u.name AS created_by_name
    FROM supplier_quotations q
    JOIN partners p ON p.id = q.partner_id
    LEFT JOIN applications a ON a.id = q.application_id
    LEFT JOIN payment_terms t ON t.id = q.payment_terms_id
    LEFT JOIN companies c ON c.id = q.company_id
    LEFT JOIN users u ON u.id = q.created_by
    LEFT JOIN enquiries e ON e.id = q.enquiry_id`;

router.get('/quotations', wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 50);
  const where = [];
  const params = { limit, offset };
  if (req.query.status) { where.push('q.status = @status'); params.status = req.query.status; }
  if (req.query.partner_id) { where.push('q.partner_id = @partner_id'); params.partner_id = req.query.partner_id; }
  if (req.query.application_id) { where.push('q.application_id = @application_id'); params.application_id = req.query.application_id; }
  if (req.query.q) {
    where.push('(q.quote_no LIKE @q OR q.subject LIKE @q OR q.project LIKE @q OR p.name LIKE @q OR q.supplier_ref LIKE @q)');
    params.q = `%${String(req.query.q).trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({
    rows: db.prepare(`${SQ_SELECT} ${clause} ORDER BY q.quote_date DESC, q.id DESC LIMIT @limit OFFSET @offset`).all(params),
    total: db.prepare(`SELECT COUNT(*) AS c FROM supplier_quotations q JOIN partners p ON p.id = q.partner_id ${clause}`).get(params).c,
    page, limit,
  });
}));

router.get('/quotations/:id', wrap(async (req, res) => {
  const row = db.prepare(`${SQ_SELECT} WHERE q.id = ?`).get(req.params.id);
  if (!row) throw notFound('No such supplier quotation.');
  res.json({
    quotation: row,
    items: db.prepare(`
      SELECT i.*, a.name AS application_name FROM supplier_quotation_items i
        LEFT JOIN applications a ON a.id = i.application_id
       WHERE i.quotation_id = ? ORDER BY i.line_no`).all(row.id),
    termsText: terms.describe(row.payment_terms_id),
    orders: db.prepare('SELECT id, lpo_no, lpo_date, total, status FROM purchase_orders WHERE quotation_id = ?')
      .all(row.id),
  });
}));

router.post('/quotations', buyer, wrap(async (req, res) => {
  const b = req.body;
  // The company's rule: their price is the answer to an enquiry we raised.
  const enquiry = enquiries.forQuotation('supplier', b.enquiry_id);
  const company = docs.companyFor(req, b);
  const supplierId = b.partner_id || enquiry.partner_id;
  if (!supplierId) throw badRequest('Say which manufacturer has quoted.');
  const supplier = db.prepare('SELECT * FROM partners WHERE id = ?').get(supplierId);
  if (!supplier) throw notFound('No such supplier.');
  if (enquiry.partner_id && Number(enquiry.partner_id) !== supplier.id) {
    throw badRequest(`${enquiry.enquiry_no} was raised with somebody else. `
      + 'Raise an enquiry with this manufacturer, or log the price against theirs.');
  }

  // A request for a price may legitimately carry no prices at all yet.
  const rawLines = Array.isArray(b.items) ? b.items : [];
  const priced = rawLines.length
    ? docs.buildLines(rawLines, { side: 'buy' })
    : { lines: [], footer: { subtotal: 0, discount: 0, taxable: 0, vat_amount: 0, total: 0 } };

  const status = v.oneOf(b.status, ['requested', 'received'], 'status')
    || (priced.footer.total > 0 ? 'received' : 'requested');
  const quoteDate = v.date(b.quote_date) || v.today();

  const result = tx(() => {
    const quoteNo = ids.docNo('supplierQuotation', company.code);
    const info = db.prepare(`
      INSERT INTO supplier_quotations (company_id, quote_no, partner_id, enquiry_id, application_id,
        supplier_ref, subject, project, quote_date, valid_until, payment_terms_id, delivery_days,
        currency, subtotal, discount, vat_amount, total, status, notes, terms_text,
        linked_sales_quotation_id, created_by)
      VALUES (@company_id, @quote_no, @partner_id, @enquiry_id, @application_id, @supplier_ref,
        @subject, @project, @quote_date, @valid_until, @payment_terms_id, @delivery_days, @currency,
        @subtotal, @discount, @vat_amount, @total, @status, @notes, @terms_text,
        @linked_sales_quotation_id, @created_by)`).run({
      company_id: company.id,
      quote_no: quoteNo,
      partner_id: supplier.id,
      enquiry_id: enquiry.id,
      application_id: docs.resolveApplication(b.application_id, priced.lines)
        || enquiry.application_id || null,
      supplier_ref: v.str(b.supplier_ref),
      subject: v.str(b.subject) || enquiry.subject,
      project: v.str(b.project) || enquiry.project,
      quote_date: quoteDate,
      valid_until: v.date(b.valid_until) || v.addDays(quoteDate, 30),
      payment_terms_id: b.payment_terms_id || supplier.payment_terms_id || null,
      delivery_days: v.int(b.delivery_days, 0),
      currency: v.str(b.currency, supplier.currency || 'AED'),
      ...priced.footer,
      status,
      notes: v.str(b.notes),
      terms_text: v.str(b.terms_text),
      linked_sales_quotation_id: b.linked_sales_quotation_id || null,
      created_by: req.user.id,
    });
    docs.insertLines('supplier_quotation_items', 'quotation_id', info.lastInsertRowid,
      priced.lines, docs.LINE_COLUMNS.quotationBuy);
    enquiries.markQuoted(enquiry.id);
    return { id: info.lastInsertRowid, quoteNo };
  })();

  audit.log(req, 'supplier_quotation.created', 'supplier_quotation', result.id,
    { quoteNo: result.quoteNo, against: enquiry.enquiry_no });
  res.status(201).json(db.prepare(`${SQ_SELECT} WHERE q.id = ?`).get(result.id));
}));

/** Enter the manufacturer's prices when their quotation comes back. */
router.patch('/quotations/:id', buyer, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM supplier_quotations WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such supplier quotation.');
  if (['ordered'].includes(row.status)) {
    throw conflict('An LPO has already been raised against this quotation, so it can no longer be changed.');
  }
  const b = req.body;

  const run = tx(() => {
    if (Array.isArray(b.items)) {
      const priced = docs.buildLines(b.items, { side: 'buy' });
      db.prepare('DELETE FROM supplier_quotation_items WHERE quotation_id = ?').run(row.id);
      docs.insertLines('supplier_quotation_items', 'quotation_id', row.id,
        priced.lines, docs.LINE_COLUMNS.quotationBuy);
      db.prepare(`UPDATE supplier_quotations SET subtotal = @subtotal, discount = @discount,
        vat_amount = @vat_amount, total = @total, application_id = @application_id WHERE id = @id`)
        .run({ ...priced.footer, id: row.id,
          application_id: docs.resolveApplication(b.application_id || row.application_id, priced.lines) });

      // A price we have been given is worth keeping against the item, so the
      // next quotation starts from what this manufacturer last charged.
      for (const line of priced.lines) {
        if (!line.item_id || !line.unit_price) continue;
        db.prepare(`INSERT INTO item_suppliers (item_id, partner_id, last_price, last_quoted, lead_days)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(item_id, partner_id) DO UPDATE SET last_price = excluded.last_price,
            last_quoted = excluded.last_quoted, lead_days = excluded.lead_days`)
          .run(line.item_id, row.partner_id, line.unit_price, v.today(), line.lead_days || 0);
      }
    }
    db.prepare(`UPDATE supplier_quotations SET supplier_ref = @supplier_ref, subject = @subject,
        project = @project, valid_until = @valid_until, payment_terms_id = @payment_terms_id,
        delivery_days = @delivery_days, status = @status, notes = @notes, terms_text = @terms_text
      WHERE id = @id`).run({
      id: row.id,
      supplier_ref: v.str(b.supplier_ref, row.supplier_ref),
      subject: v.str(b.subject, row.subject),
      project: v.str(b.project, row.project),
      valid_until: v.date(b.valid_until) || row.valid_until,
      payment_terms_id: b.payment_terms_id === undefined ? row.payment_terms_id : (b.payment_terms_id || null),
      delivery_days: v.int(b.delivery_days, row.delivery_days),
      status: v.oneOf(b.status, ['requested', 'received', 'approved', 'rejected', 'expired'], 'status') || row.status,
      notes: v.str(b.notes, row.notes),
      terms_text: v.str(b.terms_text, row.terms_text),
    });
  });
  run();

  audit.log(req, 'supplier_quotation.updated', 'supplier_quotation', row.id, { quoteNo: row.quote_no });
  res.json(db.prepare(`${SQ_SELECT} WHERE q.id = ?`).get(row.id));
}));

/**
 * Confirm the price. Nothing may be ordered from a quotation until somebody
 * has said, on the record, that this is the price — which is the rule the
 * company already works to on paper.
 */
router.post('/quotations/:id/approve', buyer, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM supplier_quotations WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such supplier quotation.');
  if (row.total <= 0) throw badRequest('There are no prices on this quotation yet.');
  db.prepare("UPDATE supplier_quotations SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?")
    .run(req.user.id, row.id);
  audit.log(req, 'supplier_quotation.approved', 'supplier_quotation', row.id, { quoteNo: row.quote_no });
  res.json({ ok: true, message: `Price confirmed on ${row.quote_no}. You can raise the LPO from it now.` });
}));

/**
 * What a new LPO's conditions would say, clause by clause, with this
 * supplier's name already in them — so the form can show them ticked and
 * editable rather than as an opaque block of text.
 */
router.get('/terms/default', buyer, wrap(async (req, res) => {
  const supplier = req.query.partner_id
    ? db.prepare('SELECT * FROM partners WHERE id = ?').get(req.query.partner_id) : null;
  const company = docs.defaultCompany();
  const paymentTermsId = req.query.payment_terms_id
    || (supplier ? supplier.payment_terms_id : null);
  res.json({
    clauses: clauses.forDocument('purchase_order', {
      company: company ? company.name : null,
      supplier: supplier ? supplier.name : null,
      project: v.str(req.query.project),
      authority: v.str(req.query.authority),
      payment_terms: terms.describe(paymentTermsId),
    }),
    library: clauses.list('purchase_order'),
  });
}));

// ============================================================== the LPO we send
const PO_SELECT = `
  SELECT o.*, p.name AS supplier_name, p.code AS supplier_code, p.trn AS supplier_trn,
         p.address AS supplier_address, p.contact_person AS supplier_contact,
         p.phone AS supplier_phone, p.email AS supplier_email,
         a.name AS application_name, a.code AS application_code,
         t.name AS terms_name, t.kind AS terms_kind,
         c.code AS company_code, c.name AS company_name, c.trn AS company_trn,
         c.address AS company_address, c.phone AS company_phone, c.email AS company_email,
         l.name AS delivery_location, q.quote_no AS supplier_quote_no,
         so.so_no AS against_sales_order, so.client_lpo_no AS against_client_lpo,
         u.name AS created_by_name, ap.name AS approved_by_name
    FROM purchase_orders o
    JOIN partners p ON p.id = o.partner_id
    LEFT JOIN applications a ON a.id = o.application_id
    LEFT JOIN payment_terms t ON t.id = o.payment_terms_id
    LEFT JOIN companies c ON c.id = o.company_id
    LEFT JOIN locations l ON l.id = o.delivery_location_id
    LEFT JOIN supplier_quotations q ON q.id = o.quotation_id
    LEFT JOIN sales_orders so ON so.id = o.sales_order_id
    LEFT JOIN users u ON u.id = o.created_by
    LEFT JOIN users ap ON ap.id = o.approved_by`;

router.get('/orders', wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 50);
  const where = [];
  const params = { limit, offset };
  if (req.query.status) { where.push('o.status = @status'); params.status = req.query.status; }
  if (req.query.partner_id) { where.push('o.partner_id = @partner_id'); params.partner_id = req.query.partner_id; }
  if (req.query.application_id) { where.push('o.application_id = @application_id'); params.application_id = req.query.application_id; }
  if (v.bool(req.query.open)) where.push("o.status IN ('sent','acknowledged','partial')");
  if (req.query.q) {
    where.push('(o.lpo_no LIKE @q OR o.project LIKE @q OR p.name LIKE @q)');
    params.q = `%${String(req.query.q).trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({
    rows: db.prepare(`${PO_SELECT} ${clause} ORDER BY o.lpo_date DESC, o.id DESC LIMIT @limit OFFSET @offset`).all(params),
    total: db.prepare(`SELECT COUNT(*) AS c FROM purchase_orders o JOIN partners p ON p.id = o.partner_id ${clause}`).get(params).c,
    page, limit,
  });
}));

router.get('/orders/:id', wrap(async (req, res) => {
  const row = db.prepare(`${PO_SELECT} WHERE o.id = ?`).get(req.params.id);
  if (!row) throw notFound('No such LPO.');
  const items = db.prepare(`
    SELECT i.*, a.name AS application_name, (i.qty - i.received_qty) AS pending_qty
      FROM purchase_order_items i
      LEFT JOIN applications a ON a.id = i.application_id
     WHERE i.po_id = ? ORDER BY i.line_no`).all(row.id);
  res.json({
    order: row,
    items,
    termsText: terms.describe(row.payment_terms_id),
    // The conditions as they will print, and as a list the screen can edit.
    conditions: clauses.toLines(row.terms_text),
    amountInWords: pricing.inWords(row.total, row.currency),
    schedule: terms.schedule(row.payment_terms_id, row.total),
    receipts: db.prepare(
      'SELECT id, grn_no, received_date, supplier_dn_ref, status FROM grns WHERE po_id = ? ORDER BY received_date DESC')
      .all(row.id),
    invoices: db.prepare(
      `SELECT id, bill_no, supplier_inv_no, invoice_date, due_date, total, paid_amount, status
         FROM supplier_invoices WHERE po_id = ? ORDER BY invoice_date DESC`).all(row.id),
  });
}));

router.post('/orders', buyer, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['partner_id', 'items']);
  const company = docs.companyFor(req, b);
  const supplier = db.prepare('SELECT * FROM partners WHERE id = ?').get(b.partner_id);
  if (!supplier) throw notFound('No such supplier.');

  // Ordering off an unconfirmed price is exactly what the company's own
  // sequence is designed to prevent.
  if (b.quotation_id) {
    const q = db.prepare('SELECT * FROM supplier_quotations WHERE id = ?').get(b.quotation_id);
    if (!q) throw notFound('No such supplier quotation.');
    if (q.status !== 'approved' && q.status !== 'ordered') {
      throw conflict(`Quotation ${q.quote_no} has not been price-confirmed yet. Approve it before raising the LPO.`);
    }
  }

  const priced = docs.buildLines(b.items, { side: 'buy' });
  const lpoDate = v.date(b.lpo_date) || v.today();
  const paymentTermsId = b.payment_terms_id || supplier.payment_terms_id || null;
  const location = b.delivery_location_id
    ? db.prepare('SELECT * FROM locations WHERE id = ?').get(b.delivery_location_id)
    : db.prepare('SELECT * FROM locations WHERE is_default = 1 AND active = 1').get();

  const result = tx(() => {
    const lpoNo = ids.docNo('purchaseOrder', company.code);

    /*
     * The conditions are written onto the order now, from the clause library,
     * with this order's own supplier and authority filled in. From here they
     * belong to the order: editing the library later cannot change what a
     * supplier has already been sent.
     */
    const termsText = v.str(b.terms_text) || clauses.textFor('purchase_order', {
      company: company.name,
      supplier: supplier.name,
      lpo_no: lpoNo,
      project: v.str(b.project),
      authority: v.str(b.authority),
      delivery_date: v.date(b.delivery_date),
      payment_terms: terms.describe(paymentTermsId),
    });
    const info = db.prepare(`
      INSERT INTO purchase_orders (company_id, lpo_no, partner_id, quotation_id, application_id,
        sales_order_id, project, attention, incoterms, authority, lpo_date, delivery_date,
        delivery_location_id, delivery_address, payment_terms_id, currency, subtotal, discount,
        vat_amount, total, status, notes, terms_text, created_by)
      VALUES (@company_id, @lpo_no, @partner_id, @quotation_id, @application_id, @sales_order_id,
        @project, @attention, @incoterms, @authority, @lpo_date, @delivery_date,
        @delivery_location_id, @delivery_address, @payment_terms_id, @currency, @subtotal, @discount,
        @vat_amount, @total, @status, @notes, @terms_text, @created_by)`).run({
      company_id: company.id,
      lpo_no: lpoNo,
      partner_id: supplier.id,
      quotation_id: b.quotation_id || null,
      application_id: docs.resolveApplication(b.application_id, priced.lines),
      sales_order_id: b.sales_order_id || null,
      project: v.str(b.project),
      attention: v.str(b.attention) || supplier.contact_person,
      incoterms: v.str(b.incoterms),
      authority: v.str(b.authority),
      lpo_date: lpoDate,
      delivery_date: v.date(b.delivery_date),
      delivery_location_id: location ? location.id : null,
      delivery_address: v.str(b.delivery_address) || (location ? location.address : null),
      payment_terms_id: paymentTermsId,
      currency: v.str(b.currency, supplier.currency || 'AED'),
      ...priced.footer,
      status: v.oneOf(b.status, ['draft', 'sent'], 'status') || 'draft',
      notes: v.str(b.notes),
      terms_text: termsText,
      created_by: req.user.id,
    });
    docs.insertLines('purchase_order_items', 'po_id', info.lastInsertRowid,
      priced.lines, docs.LINE_COLUMNS.purchaseOrder);
    if (b.quotation_id) {
      db.prepare("UPDATE supplier_quotations SET status = 'ordered' WHERE id = ?").run(b.quotation_id);
    }
    return { id: info.lastInsertRowid, lpoNo };
  })();

  audit.log(req, 'purchase_order.created', 'purchase_order', result.id, { lpoNo: result.lpoNo });
  res.status(201).json(db.prepare(`${PO_SELECT} WHERE o.id = ?`).get(result.id));
}));

/**
 * Send the LPO — and, with it, put the material on order in the stock register.
 *
 * This is the step the company asked for by name: once the LPO is with the
 * manufacturer, the material counts as stock the company has coming, and the
 * register says so against every line.
 */
router.post('/orders/:id/send', buyer, wrap(async (req, res) => {
  const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!order) throw notFound('No such LPO.');
  if (order.status !== 'draft') throw conflict(`This LPO has already been sent (${order.status}).`);

  const items = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(order.id);

  tx(() => {
    db.prepare(`UPDATE purchase_orders SET status = 'sent', sent_at = datetime('now'),
        approved_by = ?, approved_at = datetime('now') WHERE id = ?`).run(req.user.id, order.id);
    for (const line of items) {
      stock.post({
        companyId: order.company_id, itemId: line.item_id, locationId: order.delivery_location_id,
        bucket: 'ordered', kind: 'lpo_placed', qty: line.qty, rate: line.unit_price,
        refType: 'purchase_order', refId: order.id, refNo: order.lpo_no,
        partnerId: order.partner_id, movedOn: order.lpo_date, userId: req.user.id,
        notes: `On order against ${order.lpo_no}`,
      });
    }
  })();

  notify.toRole('logistics', {
    title: `LPO ${order.lpo_no} placed`,
    body: 'Material is on order and expected into the yard.',
    route: `#/purchase-orders?id=${order.id}`,
  });
  audit.log(req, 'purchase_order.sent', 'purchase_order', order.id, { lpoNo: order.lpo_no });
  res.json({ ok: true, message: `${order.lpo_no} sent. The material is now shown on order in the stock register.` });
}));

/**
 * Change an order's conditions, or its header details.
 *
 * The lines and the prices are not editable here: a supplier is working to
 * them, and a quiet change to a price on an order already acknowledged is how
 * an invoice arrives that nobody recognises. What the key account manager can
 * change is the paperwork around them — who it is addressed to, the incoterms,
 * the authority, and the conditions — and every change is written to the audit
 * trail with what it said before.
 */
router.patch('/orders/:id', buyer, wrap(async (req, res) => {
  const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!order) throw notFound('No such LPO.');
  if (['received', 'closed', 'cancelled'].includes(order.status)) {
    throw conflict(`This LPO is ${order.status} — its conditions can no longer be changed.`);
  }
  const b = req.body;

  // Sent as a list of points, or as one block; either way it is stored as the
  // block that prints.
  const termsText = Array.isArray(b.terms)
    ? clauses.fromLines(b.terms)
    : v.str(b.terms_text, order.terms_text);

  db.prepare(`UPDATE purchase_orders SET attention = @attention, incoterms = @incoterms,
      authority = @authority, project = @project, delivery_date = @delivery_date,
      delivery_address = @delivery_address, notes = @notes, terms_text = @terms_text
    WHERE id = @id`).run({
    id: order.id,
    attention: v.str(b.attention, order.attention),
    incoterms: v.str(b.incoterms, order.incoterms),
    authority: v.str(b.authority, order.authority),
    project: v.str(b.project, order.project),
    delivery_date: v.date(b.delivery_date) || order.delivery_date,
    delivery_address: v.str(b.delivery_address, order.delivery_address),
    notes: v.str(b.notes, order.notes),
    terms_text: termsText,
  });

  if (termsText !== order.terms_text) {
    audit.log(req, 'purchase_order.terms_changed', 'purchase_order', order.id, {
      lpoNo: order.lpo_no, status: order.status, was: order.terms_text, now: termsText,
    });
  } else {
    audit.log(req, 'purchase_order.updated', 'purchase_order', order.id, { lpoNo: order.lpo_no });
  }
  res.json(db.prepare(`${PO_SELECT} WHERE o.id = ?`).get(order.id));
}));

router.post('/orders/:id/cancel', buyer, wrap(async (req, res) => {
  const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!order) throw notFound('No such LPO.');
  if (order.status === 'received' || order.status === 'closed') {
    throw conflict('This LPO has already been received against, so it cannot be cancelled.');
  }
  tx(() => {
    // Whatever was put on order comes back off it.
    stock.reverse({ refType: 'purchase_order', refId: order.id, kind: 'lpo_cancelled',
      userId: req.user.id, notes: `LPO ${order.lpo_no} cancelled` });
    db.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?").run(order.id);
  })();
  audit.log(req, 'purchase_order.cancelled', 'purchase_order', order.id,
    { lpoNo: order.lpo_no, reason: v.str(req.body.reason) });
  res.json({ ok: true, message: `${order.lpo_no} cancelled and taken off order.` });
}));

// ================================================================== receiving
router.get('/grns', wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 50);
  const rows = db.prepare(`
    SELECT g.*, p.name AS supplier_name, o.lpo_no, l.name AS location_name, u.name AS received_by_name,
           (SELECT COALESCE(SUM(qty), 0) FROM grn_items gi WHERE gi.grn_id = g.id) AS total_qty
      FROM grns g
      JOIN partners p ON p.id = g.partner_id
      LEFT JOIN purchase_orders o ON o.id = g.po_id
      LEFT JOIN locations l ON l.id = g.location_id
      LEFT JOIN users u ON u.id = g.created_by
     ORDER BY g.received_date DESC, g.id DESC LIMIT ? OFFSET ?`).all(limit, offset);
  res.json({ rows, total: db.prepare('SELECT COUNT(*) AS c FROM grns').get().c, page, limit });
}));

router.get('/grns/:id', wrap(async (req, res) => {
  const row = db.prepare(`
    SELECT g.*, p.name AS supplier_name, p.code AS supplier_code, o.lpo_no, o.project,
           l.name AS location_name, c.name AS company_name, c.code AS company_code,
           u.name AS received_by_name
      FROM grns g
      JOIN partners p ON p.id = g.partner_id
      LEFT JOIN purchase_orders o ON o.id = g.po_id
      LEFT JOIN locations l ON l.id = g.location_id
      LEFT JOIN companies c ON c.id = g.company_id
      LEFT JOIN users u ON u.id = g.created_by
     WHERE g.id = ?`).get(req.params.id);
  if (!row) throw notFound('No such goods receipt.');
  res.json({
    grn: row,
    items: db.prepare('SELECT * FROM grn_items WHERE grn_id = ? ORDER BY id').all(row.id),
  });
}));

/**
 * Take the material in.
 *
 * Receiving moves each line out of "on order" and into the yard, and short
 * deliveries are the normal case rather than the exception — a manufacturer
 * sends what is ready and follows with the rest — so the LPO stays open at
 * "partial" until every line is complete.
 */
router.post('/grns', receiver, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['partner_id', 'items']);
  const company = docs.companyFor(req, b);
  const order = b.po_id ? db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(b.po_id) : null;
  if (b.po_id && !order) throw notFound('No such LPO.');
  if (order && order.status === 'cancelled') throw conflict('That LPO has been cancelled.');
  if (order && order.status === 'draft') {
    throw conflict('That LPO has not been sent yet — send it before receiving against it.');
  }

  const location = b.location_id
    ? db.prepare('SELECT * FROM locations WHERE id = ?').get(b.location_id)
    : db.prepare('SELECT * FROM locations WHERE is_default = 1 AND active = 1').get();

  const lines = b.items.map((raw, i) => {
    const poItem = raw.po_item_id
      ? db.prepare('SELECT * FROM purchase_order_items WHERE id = ?').get(raw.po_item_id) : null;
    if (raw.po_item_id && !poItem) throw notFound(`LPO line ${raw.po_item_id} no longer exists.`);
    const qty = v.qty(raw.qty, 0);
    const rejected = v.qty(raw.rejected_qty, 0);
    if (qty <= 0 && rejected <= 0) throw badRequest(`Line ${i + 1} has nothing on it.`);
    if (poItem) {
      const pending = poItem.qty - poItem.received_qty;
      if (qty - 0.005 > pending) {
        throw badRequest(
          `Line ${i + 1}: only ${pending} ${poItem.uom} of ${poItem.item_code || poItem.description} `
          + `is still outstanding on this LPO, but ${qty} was entered.`);
      }
    }
    return {
      po_item_id: poItem ? poItem.id : null,
      item_id: raw.item_id || (poItem ? poItem.item_id : null),
      item_code: raw.item_code || (poItem ? poItem.item_code : null),
      description: v.str(raw.description) || (poItem ? poItem.description : null),
      qty,
      rejected_qty: rejected,
      uom: v.str(raw.uom) || (poItem ? poItem.uom : 'NOS'),
      rate: v.money(raw.rate, poItem ? poItem.unit_price : 0),
      remarks: v.str(raw.remarks),
    };
  });

  const result = tx(() => {
    const grnNo = ids.docNo('grn', company.code);
    const info = db.prepare(`
      INSERT INTO grns (company_id, grn_no, po_id, partner_id, location_id, received_date,
        supplier_dn_ref, vehicle_no, inspected_by, notes, created_by)
      VALUES (@company_id, @grn_no, @po_id, @partner_id, @location_id, @received_date,
        @supplier_dn_ref, @vehicle_no, @inspected_by, @notes, @created_by)`).run({
      company_id: company.id,
      grn_no: grnNo,
      po_id: order ? order.id : null,
      partner_id: b.partner_id,
      location_id: location ? location.id : null,
      received_date: v.date(b.received_date) || v.today(),
      supplier_dn_ref: v.str(b.supplier_dn_ref),
      vehicle_no: v.str(b.vehicle_no),
      inspected_by: v.str(b.inspected_by) || req.user.name,
      notes: v.str(b.notes),
      created_by: req.user.id,
    });
    const grnId = info.lastInsertRowid;
    const receivedOn = v.date(b.received_date) || v.today();

    for (const line of lines) {
      db.prepare(`INSERT INTO grn_items (grn_id, po_item_id, item_id, item_code, description, qty,
          rejected_qty, uom, rate, remarks)
        VALUES (@grn_id, @po_item_id, @item_id, @item_code, @description, @qty, @rejected_qty,
          @uom, @rate, @remarks)`).run({ ...line, grn_id: grnId });

      if (line.qty > 0) {
        // Out of "on order" and into the yard — two movements, one event.
        if (line.po_item_id) {
          stock.post({
            companyId: company.id, itemId: line.item_id, locationId: location ? location.id : null,
            bucket: 'ordered', kind: 'goods_received', qty: -line.qty, rate: line.rate,
            refType: 'grn', refId: grnId, refNo: grnNo, partnerId: b.partner_id,
            movedOn: receivedOn, userId: req.user.id,
            notes: order ? `Received against ${order.lpo_no}` : 'Received',
          });
        }
        stock.post({
          companyId: company.id, itemId: line.item_id, locationId: location ? location.id : null,
          bucket: 'onhand', kind: 'goods_received', qty: line.qty, rate: line.rate,
          refType: 'grn', refId: grnId, refNo: grnNo, partnerId: b.partner_id,
          movedOn: receivedOn, userId: req.user.id,
          notes: order ? `Received against ${order.lpo_no}` : 'Received without an LPO',
        });
        // The landed cost of the most recent receipt is the cost the next
        // quotation is priced from.
        if (line.item_id && line.rate) {
          db.prepare('UPDATE items SET cost_price = ? WHERE id = ?').run(line.rate, line.item_id);
        }
      }
      if (line.po_item_id) {
        db.prepare('UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?')
          .run(line.qty, line.po_item_id);
      }
    }

    if (order) {
      const outstanding = db.prepare(
        'SELECT COALESCE(SUM(qty - received_qty), 0) AS pending FROM purchase_order_items WHERE po_id = ?')
        .get(order.id).pending;
      db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?')
        .run(outstanding > 0.005 ? 'partial' : 'received', order.id);
    }
    return { id: grnId, grnNo };
  })();

  notify.toRole('accounts', {
    title: `Goods received — ${result.grnNo}`,
    body: order ? `Against ${order.lpo_no}. The supplier's invoice can be booked.` : 'Received without an LPO.',
    route: `#/goods-receipts?id=${result.id}`,
  });
  audit.log(req, 'grn.created', 'grn', result.id, { grnNo: result.grnNo, poId: order ? order.id : null });
  res.status(201).json({ id: result.id, grn_no: result.grnNo });
}));

// ======================================================== the supplier's bill
const SI_SELECT = `
  SELECT i.*, p.name AS supplier_name, p.code AS supplier_code, p.trn AS supplier_trn,
         o.lpo_no, g.grn_no, t.name AS terms_name, c.code AS company_code, c.name AS company_name,
         (i.total - i.paid_amount) AS outstanding
    FROM supplier_invoices i
    JOIN partners p ON p.id = i.partner_id
    LEFT JOIN purchase_orders o ON o.id = i.po_id
    LEFT JOIN grns g ON g.id = i.grn_id
    LEFT JOIN payment_terms t ON t.id = i.payment_terms_id
    LEFT JOIN companies c ON c.id = i.company_id`;

router.get('/invoices', billReader, wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 50);
  const where = [];
  const params = { limit, offset };
  if (req.query.status) { where.push('i.status = @status'); params.status = req.query.status; }
  if (req.query.partner_id) { where.push('i.partner_id = @partner_id'); params.partner_id = req.query.partner_id; }
  if (v.bool(req.query.due)) where.push("i.status IN ('unpaid','partial') AND i.due_date <= date('now')");
  if (v.bool(req.query.open)) where.push("i.status IN ('unpaid','partial')");
  if (req.query.q) {
    where.push('(i.bill_no LIKE @q OR i.supplier_inv_no LIKE @q OR p.name LIKE @q)');
    params.q = `%${String(req.query.q).trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({
    rows: db.prepare(`${SI_SELECT} ${clause} ORDER BY i.due_date, i.id DESC LIMIT @limit OFFSET @offset`).all(params),
    total: db.prepare(`SELECT COUNT(*) AS c FROM supplier_invoices i JOIN partners p ON p.id = i.partner_id ${clause}`).get(params).c,
    page, limit,
  });
}));

router.get('/invoices/:id', billReader, wrap(async (req, res) => {
  const row = db.prepare(`${SI_SELECT} WHERE i.id = ?`).get(req.params.id);
  if (!row) throw notFound('No such supplier invoice.');
  res.json({
    invoice: row,
    items: db.prepare('SELECT * FROM supplier_invoice_items WHERE invoice_id = ? ORDER BY line_no').all(row.id),
    payments: db.prepare(`
      SELECT p.id, p.payment_no, p.payment_date, p.mode, p.cheque_no, p.cheque_date, p.status, a.amount
        FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
       WHERE a.invoice_side = 'purchase' AND a.invoice_id = ? ORDER BY p.payment_date`).all(row.id),
    termsText: terms.describe(row.payment_terms_id),
  });
}));

/**
 * Book the manufacturer's invoice.
 *
 * The due date comes from their payment terms rather than being typed in, so
 * that the payables ageing and the payment run are working from the same rule
 * the buyer agreed to — and a supplier on ninety days is never chased at
 * thirty by mistake.
 */
router.post('/invoices', bookkeeper, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['partner_id', 'supplier_inv_no', 'items']);
  const company = docs.companyFor(req, b);
  const supplier = db.prepare('SELECT * FROM partners WHERE id = ?').get(b.partner_id);
  if (!supplier) throw notFound('No such supplier.');

  const duplicate = db.prepare(
    'SELECT bill_no FROM supplier_invoices WHERE partner_id = ? AND supplier_inv_no = ? AND status != ?')
    .get(supplier.id, v.str(b.supplier_inv_no), 'cancelled');
  if (duplicate) {
    throw conflict(`Invoice ${b.supplier_inv_no} from ${supplier.name} is already booked as ${duplicate.bill_no}.`);
  }

  const priced = docs.buildLines(b.items, { side: 'buy' });
  const invoiceDate = v.date(b.invoice_date) || v.today();
  const paymentTermsId = b.payment_terms_id
    || (b.po_id ? (db.prepare('SELECT payment_terms_id FROM purchase_orders WHERE id = ?').get(b.po_id) || {}).payment_terms_id : null)
    || supplier.payment_terms_id || null;

  const result = tx(() => {
    const billNo = ids.docNo('supplierInvoice', company.code);
    const info = db.prepare(`
      INSERT INTO supplier_invoices (company_id, bill_no, supplier_inv_no, partner_id, po_id, grn_id,
        application_id, invoice_date, received_date, due_date, payment_terms_id, currency,
        subtotal, discount, vat_amount, total, notes, created_by)
      VALUES (@company_id, @bill_no, @supplier_inv_no, @partner_id, @po_id, @grn_id, @application_id,
        @invoice_date, @received_date, @due_date, @payment_terms_id, @currency,
        @subtotal, @discount, @vat_amount, @total, @notes, @created_by)`).run({
      company_id: company.id,
      bill_no: billNo,
      supplier_inv_no: v.str(b.supplier_inv_no),
      partner_id: supplier.id,
      po_id: b.po_id || null,
      grn_id: b.grn_id || null,
      application_id: docs.resolveApplication(b.application_id, priced.lines),
      invoice_date: invoiceDate,
      received_date: v.date(b.received_date) || v.today(),
      due_date: v.date(b.due_date) || terms.dueDate(paymentTermsId, invoiceDate),
      payment_terms_id: paymentTermsId,
      currency: v.str(b.currency, supplier.currency || 'AED'),
      ...priced.footer,
      notes: v.str(b.notes),
      created_by: req.user.id,
    });
    docs.insertLines('supplier_invoice_items', 'invoice_id', info.lastInsertRowid,
      priced.lines, docs.LINE_COLUMNS.supplierInvoice);
    if (b.po_id) {
      for (const line of priced.lines) {
        if (!line.item_id) continue;
        db.prepare(`UPDATE purchase_order_items SET invoiced_qty = invoiced_qty + ?
          WHERE po_id = ? AND item_id = ?`).run(line.qty, b.po_id, line.item_id);
      }
    }
    return { id: info.lastInsertRowid, billNo };
  })();

  const saved = db.prepare(`${SI_SELECT} WHERE i.id = ?`).get(result.id);
  audit.log(req, 'supplier_invoice.created', 'supplier_invoice', result.id,
    { billNo: result.billNo, supplierInvNo: b.supplier_inv_no, total: saved.total });
  res.status(201).json(saved);
}));

router.patch('/invoices/:id', bookkeeper, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM supplier_invoices WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such supplier invoice.');
  if (row.paid_amount > 0 && v.str(req.body.status) === 'cancelled') {
    throw conflict('This invoice has been paid against — reverse the payment before cancelling it.');
  }
  db.prepare(`UPDATE supplier_invoices SET supplier_inv_no = @supplier_inv_no, invoice_date = @invoice_date,
      due_date = @due_date, payment_terms_id = @payment_terms_id, status = @status, notes = @notes
    WHERE id = @id`).run({
    id: row.id,
    supplier_inv_no: v.str(req.body.supplier_inv_no, row.supplier_inv_no),
    invoice_date: v.date(req.body.invoice_date) || row.invoice_date,
    due_date: v.date(req.body.due_date) || row.due_date,
    payment_terms_id: req.body.payment_terms_id === undefined
      ? row.payment_terms_id : (req.body.payment_terms_id || null),
    status: v.oneOf(req.body.status, ['unpaid', 'partial', 'paid', 'disputed', 'cancelled'], 'status') || row.status,
    notes: v.str(req.body.notes, row.notes),
  });
  if (row.status !== 'cancelled') settlement.refreshInvoice('purchase', row.id);
  audit.log(req, 'supplier_invoice.updated', 'supplier_invoice', row.id, { billNo: row.bill_no });
  res.json(db.prepare(`${SI_SELECT} WHERE i.id = ?`).get(row.id));
}));

/** What is due to be paid, and when — the payment run. */
router.get('/payables/due', billReader, wrap(async (req, res) => {
  const asOf = v.date(req.query.asOf) || v.today();
  const rows = db.prepare(`
    SELECT i.id, i.bill_no, i.supplier_inv_no, i.invoice_date, i.due_date, i.total, i.paid_amount,
           (i.total - i.paid_amount) AS outstanding, p.name AS supplier_name, p.id AS partner_id,
           t.name AS terms_name,
           CAST(julianday(?) - julianday(i.due_date) AS INTEGER) AS days_overdue
      FROM supplier_invoices i
      JOIN partners p ON p.id = i.partner_id
      LEFT JOIN payment_terms t ON t.id = i.payment_terms_id
     WHERE i.status IN ('unpaid','partial') AND i.total - i.paid_amount > 0.005
     ORDER BY i.due_date, p.name`).all(asOf);
  res.json({ as_of: asOf, rows, total: pricing.round(rows.reduce((a, r) => a + r.outstanding, 0)) });
}));

module.exports = router;
