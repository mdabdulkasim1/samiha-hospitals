'use strict';
const express = require('express');
const { db, tx } = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const ids = require('../lib/ids');
const v = require('../lib/validate');
const { wrap, badRequest, notFound, conflict } = require('../lib/http');
const docs = require('../services/documents');
const enquiries = require('../services/enquiries');
const costing = require('../services/costing');
const pricing = require('../services/pricing');
const terms = require('../services/terms');
const stock = require('../services/stock');
const settlement = require('../services/settlement');
const notify = require('../services/notify');
const ledger = require('../services/ledger');
const clauses = require('../services/clauses');

const router = express.Router();

/*
 * The sell side, in the order the company works it:
 *
 *   1. the client asks                           (enquiry)
 *   2. we quote                                  (sales quotation)
 *   3. they confirm the price and send their LPO (sales order)     -> COMMITTED
 *   4. we deliver                                (delivery note)   -> OUT OF STOCK
 *   5. we invoice, with 5% VAT                   (tax invoice)
 *   6. they pay, on their terms                  (receipt)
 *
 * Some clients pay an advance before anything moves, some hand a cheque to the
 * driver against the delivery note, and some are on credit. That is one field
 * on the order — their payment terms — and it decides all three.
 */

const seller = auth.requireRole('sales', 'kam');
const shipper = auth.requireRole('logistics', 'kam');
const bookkeeper = auth.requireRole('accounts');

// ================================================================= enquiries
/*
 * What a client has asked us to price. The same screen, code and numbering
 * serve the enquiry we send a manufacturer — see /api/purchase/enquiries.
 */
router.get('/enquiries', wrap(async (req, res) => {
  res.json(enquiries.list('client', req.query));
}));

router.get('/enquiries/:id', wrap(async (req, res) => {
  const row = enquiries.get(req.params.id, 'client');
  if (!row) throw notFound('No such enquiry.');
  res.json(row);
}));

router.post('/enquiries', seller, wrap(async (req, res) => {
  const company = docs.companyFor(req, req.body);
  const made = enquiries.create('client', req.body, { company, user: req.user });
  audit.log(req, 'enquiry.created', 'enquiry', made.id, { enquiryNo: made.enquiryNo });
  res.status(201).json(made.row);
}));

router.patch('/enquiries/:id', seller, wrap(async (req, res) => {
  res.json(enquiries.update('client', req.params.id, req.body));
}));

/**
 * The client's enquiry a document belongs to.
 *
 * Given explicitly, or taken from the quotation it came off — the sell side
 * records the enquiry on the quotation, and everything after it inherits.
 */
function clientEnquiry(given, quotationId) {
  if (given) {
    const e = enquiries.get(given, 'client');
    if (!e) throw notFound('No such client enquiry.');
    return e.id;
  }
  if (!quotationId) return null;
  const q = db.prepare('SELECT enquiry_id FROM sales_quotations WHERE id = ?').get(quotationId);
  return q ? q.enquiry_id || null : null;
}

// ============================================================ the rate builder
/*
 * What a rate is made of.
 *
 * The sales desk works a selling rate up from the manufacturer's price:
 * shipping, customs duty, the freight, an allowance for risk, the bank's
 * charge, and then the margin. This does that arithmetic — the same code that
 * stores it on the line, so the figure on the screen and the figure kept
 * against the quotation can never disagree — and none of it is printed.
 */
router.get('/costing/charges', wrap(async (_req, res) => {
  res.json({ suggested: costing.SUGGESTED, bases: costing.BASES });
}));

router.post('/costing', seller, wrap(async (req, res) => {
  res.json(costing.build(req.body || {}));
}));

// ============================================================ our quotations
const SQ_SELECT = `
  SELECT q.*, p.name AS client_name, p.code AS client_code, p.trn AS client_trn,
         p.address AS client_address, p.contact_person AS client_contact,
         a.name AS application_name, a.code AS application_code,
         t.name AS terms_name, c.code AS company_code, c.name AS company_name,
         c.trn AS company_trn, c.address AS company_address,
         e.enquiry_no, u.name AS created_by_name
    FROM sales_quotations q
    JOIN partners p ON p.id = q.partner_id
    LEFT JOIN applications a ON a.id = q.application_id
    LEFT JOIN payment_terms t ON t.id = q.payment_terms_id
    LEFT JOIN companies c ON c.id = q.company_id
    LEFT JOIN enquiries e ON e.id = q.enquiry_id
    LEFT JOIN users u ON u.id = q.created_by`;

/** Cost and margin are not everyone's business — see src/lib/auth.js. */
function screenQuote(user, row, items) {
  if (auth.seesCost(user)) return { row, items };
  if (row) { row.cost_total = null; row.margin = null; row.margin_percent = null; }
  for (const i of items || []) i.cost_price = null;
  /*
   * The rate build-up stays, deliberately. What is withheld from a sales
   * officer is what the manufacturer charged us — the cost carried on the item
   * master and behind the margin. The build-up is the desk's own working on
   * this quotation, typed by them to arrive at a rate, and taking it away
   * would leave them unable to read back the figure they are about to quote.
   */
  return { row, items };
}

router.get('/quotations', wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 50);
  const where = [];
  const params = { limit, offset };
  if (req.query.status) { where.push('q.status = @status'); params.status = req.query.status; }
  if (req.query.partner_id) { where.push('q.partner_id = @partner_id'); params.partner_id = req.query.partner_id; }
  if (req.query.application_id) { where.push('q.application_id = @application_id'); params.application_id = req.query.application_id; }
  if (v.bool(req.query.open)) where.push("q.status IN ('draft','sent','under_review')");
  if (req.query.q) {
    where.push('(q.quote_no LIKE @q OR q.subject LIKE @q OR q.project LIKE @q OR p.name LIKE @q)');
    params.q = `%${String(req.query.q).trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`${SQ_SELECT} ${clause} ORDER BY q.quote_date DESC, q.id DESC LIMIT @limit OFFSET @offset`)
    .all(params);
  for (const r of rows) screenQuote(req.user, r, []);
  res.json({
    rows,
    total: db.prepare(`SELECT COUNT(*) AS c FROM sales_quotations q JOIN partners p ON p.id = q.partner_id ${clause}`).get(params).c,
    page, limit,
  });
}));

router.get('/quotations/:id', wrap(async (req, res) => {
  const row = db.prepare(`${SQ_SELECT} WHERE q.id = ?`).get(req.params.id);
  if (!row) throw notFound('No such quotation.');
  const items = db.prepare(`
    SELECT i.*, a.name AS application_name FROM sales_quotation_items i
      LEFT JOIN applications a ON a.id = i.application_id
     WHERE i.quotation_id = ? ORDER BY i.line_no`).all(row.id);

  for (const line of items) {
    // Worked out again on the way out rather than stored as an answer: if the
    // arithmetic is ever corrected, every quotation reads correctly with it.
    line.cost_build = line.cost_build
      ? costing.build({ ...JSON.parse(line.cost_build), qty: line.qty }) : null;
  }
  const margin = pricing.margin(row.subtotal - row.discount, row.cost_total);
  screenQuote(req.user, row, items);
  res.json({
    quotation: row,
    items,
    termsText: terms.describe(row.payment_terms_id),
    conditions: clauses.toLines(row.terms_text),
    amountInWords: pricing.inWords(row.total, row.currency),
    margin: auth.seesCost(req.user) ? margin : null,
    orders: db.prepare('SELECT id, so_no, client_lpo_no, order_date, total, status FROM sales_orders WHERE quotation_id = ?')
      .all(row.id),
    // What we would have to buy to honour it, and what is already on the shelf.
    availability: items.filter((i) => i.item_id).map((i) => ({
      item_id: i.item_id, item_code: i.item_code, description: i.description,
      qty: i.qty, ...stock.balance(i.item_id),
    })),
  });
}));

router.post('/quotations', seller, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['partner_id', 'items']);
  const company = docs.companyFor(req, b);
  const client = db.prepare('SELECT * FROM partners WHERE id = ?').get(b.partner_id);
  if (!client) throw notFound('No such client.');

  const priced = docs.buildLines(b.items, { side: 'sell' });
  const costTotal = pricing.round(priced.lines.reduce((a, l) => a + l.cost_price * l.qty, 0));
  const quoteDate = v.date(b.quote_date) || v.today();

  const result = tx(() => {
    const quoteNo = ids.docNo('salesQuotation', company.code);

    // The same clause library the LPOs draw on, kept under Masters → Terms &
    // conditions, with this client's own details filled in.
    const termsText = v.str(b.terms_text) || clauses.textFor('sales_quotation', {
      company: company.name,
      client: client.name,
      doc_no: quoteNo,
      project: v.str(b.project),
      payment_terms: terms.describe(b.payment_terms_id || client.payment_terms_id || null),
    });
    const info = db.prepare(`
      INSERT INTO sales_quotations (company_id, quote_no, revision, partner_id, enquiry_id,
        application_id, project, subject, attention, quote_date, valid_until, payment_terms_id,
        delivery_days, delivery_terms, currency, subtotal, discount, vat_amount, total, cost_total,
        status, notes, terms_text, created_by)
      VALUES (@company_id, @quote_no, 0, @partner_id, @enquiry_id, @application_id, @project,
        @subject, @attention, @quote_date, @valid_until, @payment_terms_id, @delivery_days,
        @delivery_terms, @currency, @subtotal, @discount, @vat_amount, @total, @cost_total,
        @status, @notes, @terms_text, @created_by)`).run({
      company_id: company.id,
      quote_no: quoteNo,
      partner_id: client.id,
      enquiry_id: b.enquiry_id || null,
      application_id: docs.resolveApplication(b.application_id, priced.lines),
      project: v.str(b.project),
      subject: v.str(b.subject),
      attention: v.str(b.attention) || client.contact_person,
      quote_date: quoteDate,
      valid_until: v.date(b.valid_until) || v.addDays(quoteDate, 30),
      payment_terms_id: b.payment_terms_id || client.payment_terms_id || null,
      delivery_days: v.int(b.delivery_days, 0),
      delivery_terms: v.str(b.delivery_terms),
      currency: v.str(b.currency, client.currency || 'AED'),
      ...priced.footer,
      cost_total: costTotal,
      status: v.oneOf(b.status, ['draft', 'sent'], 'status') || 'draft',
      notes: v.str(b.notes),
      terms_text: termsText,
      created_by: req.user.id,
    });
    docs.insertLines('sales_quotation_items', 'quotation_id', info.lastInsertRowid,
      priced.lines, docs.LINE_COLUMNS.quotationSell);
    if (b.enquiry_id) db.prepare("UPDATE enquiries SET status = 'quoted' WHERE id = ?").run(b.enquiry_id);
    return { id: info.lastInsertRowid, quoteNo };
  })();

  audit.log(req, 'sales_quotation.created', 'sales_quotation', result.id, { quoteNo: result.quoteNo });
  res.status(201).json(db.prepare(`${SQ_SELECT} WHERE q.id = ?`).get(result.id));
}));

router.patch('/quotations/:id', seller, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM sales_quotations WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such quotation.');
  if (row.status === 'converted') {
    throw conflict('The client has already placed an order against this quotation, so it can no longer be changed. Raise a revision instead.');
  }
  const b = req.body;

  tx(() => {
    if (Array.isArray(b.items)) {
      const priced = docs.buildLines(b.items, { side: 'sell' });
      db.prepare('DELETE FROM sales_quotation_items WHERE quotation_id = ?').run(row.id);
      docs.insertLines('sales_quotation_items', 'quotation_id', row.id,
        priced.lines, docs.LINE_COLUMNS.quotationSell);
      db.prepare(`UPDATE sales_quotations SET subtotal = @subtotal, discount = @discount,
          vat_amount = @vat_amount, total = @total, cost_total = @cost_total,
          application_id = @application_id WHERE id = @id`).run({
        ...priced.footer, id: row.id,
        cost_total: pricing.round(priced.lines.reduce((a, l) => a + l.cost_price * l.qty, 0)),
        application_id: docs.resolveApplication(b.application_id || row.application_id, priced.lines),
      });
    }
    db.prepare(`UPDATE sales_quotations SET subject = @subject, project = @project, attention = @attention,
        valid_until = @valid_until, payment_terms_id = @payment_terms_id, delivery_days = @delivery_days,
        delivery_terms = @delivery_terms, status = @status, notes = @notes, terms_text = @terms_text
      WHERE id = @id`).run({
      id: row.id,
      subject: v.str(b.subject, row.subject),
      project: v.str(b.project, row.project),
      attention: v.str(b.attention, row.attention),
      valid_until: v.date(b.valid_until) || row.valid_until,
      payment_terms_id: b.payment_terms_id === undefined ? row.payment_terms_id : (b.payment_terms_id || null),
      delivery_days: v.int(b.delivery_days, row.delivery_days),
      delivery_terms: v.str(b.delivery_terms, row.delivery_terms),
      status: v.oneOf(b.status, ['draft', 'sent', 'under_review', 'approved', 'rejected', 'expired'], 'status') || row.status,
      notes: v.str(b.notes, row.notes),
      terms_text: v.str(b.terms_text, row.terms_text),
    });
  })();

  audit.log(req, 'sales_quotation.updated', 'sales_quotation', row.id, { quoteNo: row.quote_no });
  res.json(db.prepare(`${SQ_SELECT} WHERE q.id = ?`).get(row.id));
}));

router.post('/quotations/:id/send', seller, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM sales_quotations WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such quotation.');
  db.prepare("UPDATE sales_quotations SET status = 'sent', sent_at = datetime('now') WHERE id = ? AND status = 'draft'")
    .run(row.id);
  audit.log(req, 'sales_quotation.sent', 'sales_quotation', row.id, { quoteNo: row.quote_no });
  res.json({ ok: true, message: `${row.quote_no} marked as sent to the client.` });
}));

/**
 * A revision, when the client comes back on price.
 *
 * The original is kept exactly as it was sent rather than edited: the client
 * is holding a copy of it, and a quotation that quietly changed under a
 * reference they already have is how a dispute starts.
 */
router.post('/quotations/:id/revise', seller, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM sales_quotations WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such quotation.');
  const items = db.prepare('SELECT * FROM sales_quotation_items WHERE quotation_id = ? ORDER BY line_no').all(row.id);
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(row.company_id);

  const result = tx(() => {
    const revision = row.revision + 1;
    const quoteNo = `${row.quote_no}-R${revision}`;
    const info = db.prepare(`
      INSERT INTO sales_quotations (company_id, quote_no, revision, partner_id, enquiry_id,
        application_id, project, subject, attention, quote_date, valid_until, payment_terms_id,
        delivery_days, delivery_terms, currency, subtotal, discount, vat_amount, total, cost_total,
        status, notes, terms_text, created_by)
      SELECT company_id, @quote_no, @revision, partner_id, enquiry_id, application_id, project,
        subject, attention, date('now'), date('now', '+30 days'), payment_terms_id, delivery_days,
        delivery_terms, currency, subtotal, discount, vat_amount, total, cost_total,
        'draft', notes, terms_text, @created_by
        FROM sales_quotations WHERE id = @id`).run({
      id: row.id, quote_no: quoteNo, revision, created_by: req.user.id,
    });
    const newId = info.lastInsertRowid;
    for (const i of items) {
      db.prepare(`INSERT INTO sales_quotation_items (quotation_id, line_no, item_id, item_code,
          description, application_id, qty, uom, cost_price, unit_price, discount, taxable,
          vat_percent, vat_amount, total, lead_days, cost_build, remarks)
        VALUES (@quotation_id, @line_no, @item_id, @item_code, @description, @application_id, @qty,
          @uom, @cost_price, @unit_price, @discount, @taxable, @vat_percent, @vat_amount, @total,
          @lead_days, @cost_build, @remarks)`).run({ ...i, id: undefined, quotation_id: newId });
    }
    db.prepare("UPDATE sales_quotations SET status = 'expired' WHERE id = ? AND status != 'converted'").run(row.id);
    return { id: newId, quoteNo, company };
  })();

  audit.log(req, 'sales_quotation.revised', 'sales_quotation', result.id,
    { from: row.quote_no, to: result.quoteNo });
  res.status(201).json(db.prepare(`${SQ_SELECT} WHERE q.id = ?`).get(result.id));
}));

// ==================================================== the client's LPO to us
const SO_SELECT = `
  SELECT o.*, p.name AS client_name, p.code AS client_code, p.trn AS client_trn,
         p.address AS client_address, p.credit_limit,
         a.name AS application_name, a.code AS application_code,
         t.name AS terms_name, t.kind AS terms_kind,
         c.code AS company_code, c.name AS company_name,
         q.quote_no, u.name AS created_by_name,
         COALESCE(e.enquiry_no, qe.enquiry_no) AS enquiry_no
    FROM sales_orders o
    JOIN partners p ON p.id = o.partner_id
    LEFT JOIN applications a ON a.id = o.application_id
    LEFT JOIN payment_terms t ON t.id = o.payment_terms_id
    LEFT JOIN companies c ON c.id = o.company_id
    LEFT JOIN sales_quotations q ON q.id = o.quotation_id
    LEFT JOIN enquiries e ON e.id = o.enquiry_id
    LEFT JOIN enquiries qe ON qe.id = q.enquiry_id
    LEFT JOIN users u ON u.id = o.created_by`;

router.get('/orders', wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 50);
  const where = [];
  const params = { limit, offset };
  if (req.query.status) { where.push('o.status = @status'); params.status = req.query.status; }
  if (req.query.partner_id) { where.push('o.partner_id = @partner_id'); params.partner_id = req.query.partner_id; }
  if (v.bool(req.query.open)) where.push("o.status IN ('confirmed','partial')");
  if (req.query.q) {
    where.push('(o.so_no LIKE @q OR o.client_lpo_no LIKE @q OR o.project LIKE @q OR p.name LIKE @q)');
    params.q = `%${String(req.query.q).trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({
    rows: db.prepare(`${SO_SELECT} ${clause} ORDER BY o.order_date DESC, o.id DESC LIMIT @limit OFFSET @offset`).all(params),
    total: db.prepare(`SELECT COUNT(*) AS c FROM sales_orders o JOIN partners p ON p.id = o.partner_id ${clause}`).get(params).c,
    page, limit,
  });
}));

router.get('/orders/:id', wrap(async (req, res) => {
  const row = db.prepare(`${SO_SELECT} WHERE o.id = ?`).get(req.params.id);
  if (!row) throw notFound('No such order.');
  const items = db.prepare(`
    SELECT i.*, a.name AS application_name, (i.qty - i.delivered_qty) AS pending_qty
      FROM sales_order_items i
      LEFT JOIN applications a ON a.id = i.application_id
     WHERE i.so_id = ? ORDER BY i.line_no`).all(row.id);
  if (!auth.seesCost(req.user)) for (const i of items) i.cost_price = null;

  res.json({
    order: row,
    items,
    termsText: terms.describe(row.payment_terms_id),
    schedule: terms.schedule(row.payment_terms_id, row.total),
    release: terms.releaseCheck(row),
    deliveries: db.prepare(
      'SELECT id, dn_no, delivery_date, vehicle_no, received_by, status FROM delivery_notes WHERE so_id = ? ORDER BY delivery_date DESC')
      .all(row.id),
    invoices: db.prepare(
      `SELECT id, invoice_no, invoice_date, due_date, total, paid_amount, status FROM sales_invoices
        WHERE so_id = ? ORDER BY invoice_date DESC`).all(row.id),
    // What we would have to buy in to deliver it.
    availability: items.filter((i) => i.item_id).map((i) => ({
      item_id: i.item_id, item_code: i.item_code, description: i.description,
      qty: i.qty, pending: i.qty - i.delivered_qty, ...stock.balance(i.item_id),
    })),
    purchaseOrders: db.prepare('SELECT id, lpo_no, lpo_date, status, total FROM purchase_orders WHERE sales_order_id = ?')
      .all(row.id),
  });
}));

/**
 * Take the client's LPO onto the books.
 *
 * Confirming it commits the material in the stock register — nobody can then
 * promise the same valve to a second client — and works out what advance the
 * client's terms call for before anything is ordered or released.
 */
router.post('/orders', seller, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['partner_id', 'client_lpo_no', 'items']);
  const company = docs.companyFor(req, b);
  const client = db.prepare('SELECT * FROM partners WHERE id = ?').get(b.partner_id);
  if (!client) throw notFound('No such client.');

  const duplicate = db.prepare(
    "SELECT so_no FROM sales_orders WHERE partner_id = ? AND client_lpo_no = ? AND status != 'cancelled'")
    .get(client.id, v.str(b.client_lpo_no));
  if (duplicate) {
    throw conflict(`LPO ${b.client_lpo_no} from ${client.name} is already on the books as ${duplicate.so_no}.`);
  }

  const priced = docs.buildLines(b.items, { side: 'sell' });
  const paymentTermsId = b.payment_terms_id || client.payment_terms_id || null;
  const schedule = terms.schedule(paymentTermsId, priced.footer.total);
  const orderDate = v.date(b.order_date) || v.today();
  // The client's enquiry travels from the quotation onto the order, and from
  // there onto the delivery note and the tax invoice, so one number runs the
  // length of the job on this side too.
  const enquiryId = clientEnquiry(b.enquiry_id, b.quotation_id);

  const result = tx(() => {
    const soNo = ids.docNo('salesOrder', company.code);
    const info = db.prepare(`
      INSERT INTO sales_orders (company_id, so_no, client_lpo_no, client_lpo_date, partner_id,
        quotation_id, enquiry_id, application_id, project, order_date, delivery_date, purchase_officer,
        purchase_officer_mobile, delivery_contact, delivery_mobile, delivery_location,
        delivery_address, payment_terms_id, currency, subtotal, discount, vat_amount, total,
        advance_required, notes, created_by)
      VALUES (@company_id, @so_no, @client_lpo_no, @client_lpo_date, @partner_id, @quotation_id,
        @enquiry_id, @application_id, @project, @order_date, @delivery_date, @purchase_officer,
        @purchase_officer_mobile, @delivery_contact, @delivery_mobile, @delivery_location,
        @delivery_address, @payment_terms_id, @currency, @subtotal, @discount, @vat_amount, @total,
        @advance_required, @notes, @created_by)`).run({
      company_id: company.id,
      so_no: soNo,
      enquiry_id: enquiryId,
      client_lpo_no: v.str(b.client_lpo_no),
      client_lpo_date: v.date(b.client_lpo_date),
      partner_id: client.id,
      quotation_id: b.quotation_id || null,
      application_id: docs.resolveApplication(b.application_id, priced.lines),
      project: v.str(b.project),
      order_date: orderDate,
      delivery_date: v.date(b.delivery_date),
      purchase_officer: v.str(b.purchase_officer) || client.contact_person,
      purchase_officer_mobile: v.phone(b.purchase_officer_mobile) || client.mobile,
      delivery_contact: v.str(b.delivery_contact),
      delivery_mobile: v.phone(b.delivery_mobile),
      delivery_location: v.str(b.delivery_location),
      delivery_address: v.str(b.delivery_address) || client.address,
      payment_terms_id: paymentTermsId,
      currency: v.str(b.currency, client.currency || 'AED'),
      ...priced.footer,
      advance_required: schedule.advance,
      notes: v.str(b.notes),
      created_by: req.user.id,
    });
    const soId = info.lastInsertRowid;
    docs.insertLines('sales_order_items', 'so_id', soId, priced.lines, docs.LINE_COLUMNS.salesOrder);

    for (const line of priced.lines) {
      stock.post({
        companyId: company.id, itemId: line.item_id, bucket: 'committed', kind: 'order_committed',
        qty: line.qty, rate: line.unit_price, refType: 'sales_order', refId: soId, refNo: soNo,
        partnerId: client.id, movedOn: orderDate, userId: req.user.id,
        notes: `Committed to ${client.name} on ${soNo}`,
      });
    }
    if (b.quotation_id) {
      db.prepare("UPDATE sales_quotations SET status = 'converted' WHERE id = ?").run(b.quotation_id);
      const q = db.prepare('SELECT enquiry_id FROM sales_quotations WHERE id = ?').get(b.quotation_id);
      if (q && q.enquiry_id) db.prepare("UPDATE enquiries SET status = 'won' WHERE id = ?").run(q.enquiry_id);
    }
    return { id: soId, soNo, schedule };
  })();

  notify.toRole('logistics', {
    title: `Client LPO received — ${result.soNo}`,
    body: `${client.name}, LPO ${b.client_lpo_no}. Material is committed in the stock register.`,
    route: `#/sales-orders?id=${result.id}`,
  });
  if (result.schedule.advance > 0) {
    notify.toRole('accounts', {
      title: `Advance due on ${result.soNo}`,
      body: `${result.schedule.advance.toFixed(2)} is due from ${client.name} before delivery.`,
      route: `#/sales-orders?id=${result.id}`,
    });
  }

  audit.log(req, 'sales_order.created', 'sales_order', result.id,
    { soNo: result.soNo, clientLpo: b.client_lpo_no, total: priced.footer.total });
  res.status(201).json(db.prepare(`${SO_SELECT} WHERE o.id = ?`).get(result.id));
}));

router.post('/orders/:id/cancel', seller, wrap(async (req, res) => {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) throw notFound('No such order.');
  if (['delivered', 'invoiced', 'closed'].includes(order.status)) {
    throw conflict('This order has already been delivered against, so it cannot be cancelled.');
  }
  tx(() => {
    stock.reverse({ refType: 'sales_order', refId: order.id, kind: 'order_cancelled',
      userId: req.user.id, notes: `Order ${order.so_no} cancelled` });
    db.prepare("UPDATE sales_orders SET status = 'cancelled' WHERE id = ?").run(order.id);
  })();
  audit.log(req, 'sales_order.cancelled', 'sales_order', order.id,
    { soNo: order.so_no, reason: v.str(req.body.reason) });
  res.json({ ok: true, message: `${order.so_no} cancelled and the material released back into free stock.` });
}));

/** Raise the LPO to the manufacturer straight off a client's order. */
router.post('/orders/:id/purchase-plan', auth.requireRole('kam'), wrap(async (req, res) => {
  const order = db.prepare(`${SO_SELECT} WHERE o.id = ?`).get(req.params.id);
  if (!order) throw notFound('No such order.');
  const items = db.prepare('SELECT * FROM sales_order_items WHERE so_id = ? ORDER BY line_no').all(order.id);
  const plan = items.map((i) => {
    const balance = i.item_id ? stock.balance(i.item_id) : { free: 0, on_order: 0, on_hand: 0 };
    /*
     * `free` already has this order's own commitment taken out of it, so what
     * is still to be bought is the pending quantity less whatever is sitting
     * uncommitted in the yard and whatever is already on its way in.
     */
    const pending = pricing.round(i.qty - i.delivered_qty);
    const coverable = pricing.round(Math.max(0, balance.free + i.qty) + balance.on_order);
    const toBuy = Math.max(0, pricing.round(pending - coverable));
    const preferred = i.item_id ? db.prepare(`
      SELECT s.*, p.name AS partner_name FROM item_suppliers s JOIN partners p ON p.id = s.partner_id
       WHERE s.item_id = ? ORDER BY s.last_price LIMIT 1`).get(i.item_id) : null;
    return {
      item_id: i.item_id, item_code: i.item_code, description: i.description, uom: i.uom,
      ordered_qty: i.qty, pending_qty: pending, free_stock: balance.free,
      on_hand: balance.on_hand, on_order: balance.on_order, to_buy: toBuy,
      suggested_supplier: preferred ? { id: preferred.partner_id, name: preferred.partner_name,
        last_price: auth.seesCost(req.user) ? preferred.last_price : null } : null,
    };
  });
  res.json({ order, plan: plan.filter((p) => p.to_buy > 0), all: plan });
}));

// ================================================================= deliveries
router.get('/deliveries', wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 50);
  const rows = db.prepare(`
    SELECT d.*, p.name AS client_name, o.so_no, o.client_lpo_no, a.name AS application_name,
           u.name AS created_by_name,
           COALESCE(e.enquiry_no, oe.enquiry_no, qe.enquiry_no) AS enquiry_no,
           (SELECT COALESCE(SUM(qty), 0) FROM delivery_note_items di WHERE di.dn_id = d.id) AS total_qty
      FROM delivery_notes d
      JOIN partners p ON p.id = d.partner_id
      LEFT JOIN sales_orders o ON o.id = d.so_id
      LEFT JOIN enquiries e ON e.id = d.enquiry_id
      LEFT JOIN enquiries oe ON oe.id = o.enquiry_id
      LEFT JOIN sales_quotations oq ON oq.id = o.quotation_id
      LEFT JOIN enquiries qe ON qe.id = oq.enquiry_id
      LEFT JOIN applications a ON a.id = d.application_id
      LEFT JOIN users u ON u.id = d.created_by
     ORDER BY d.delivery_date DESC, d.id DESC LIMIT ? OFFSET ?`).all(limit, offset);
  res.json({ rows, total: db.prepare('SELECT COUNT(*) AS c FROM delivery_notes').get().c, page, limit });
}));

router.get('/deliveries/:id', wrap(async (req, res) => {
  const row = db.prepare(`
    SELECT d.*, p.name AS client_name, p.code AS client_code, p.trn AS client_trn,
           p.address AS client_address, o.so_no, o.client_lpo_no, o.project,
           o.delivery_contact, o.delivery_mobile, o.delivery_location,
           o.purchase_officer, o.purchase_officer_mobile,
           a.name AS application_name, c.name AS company_name, c.code AS company_code,
           c.trn AS company_trn, c.address AS company_address, c.phone AS company_phone,
           t.name AS terms_name, u.name AS created_by_name,
           COALESCE(e.enquiry_no, oe.enquiry_no, qe.enquiry_no) AS enquiry_no
      FROM delivery_notes d
      JOIN partners p ON p.id = d.partner_id
      LEFT JOIN sales_orders o ON o.id = d.so_id
      LEFT JOIN enquiries e ON e.id = d.enquiry_id
      LEFT JOIN enquiries oe ON oe.id = o.enquiry_id
      LEFT JOIN sales_quotations oq ON oq.id = o.quotation_id
      LEFT JOIN enquiries qe ON qe.id = oq.enquiry_id
      LEFT JOIN applications a ON a.id = d.application_id
      LEFT JOIN companies c ON c.id = d.company_id
      LEFT JOIN payment_terms t ON t.id = o.payment_terms_id
      LEFT JOIN users u ON u.id = d.created_by
     WHERE d.id = ?`).get(req.params.id);
  if (!row) throw notFound('No such delivery note.');
  res.json({
    delivery: row,
    items: db.prepare('SELECT * FROM delivery_note_items WHERE dn_id = ? ORDER BY id').all(row.id),
    invoice: db.prepare('SELECT id, invoice_no, total, status FROM sales_invoices WHERE dn_id = ?').get(row.id) || null,
    // The driver needs to know whether a cheque is to be collected at the gate.
    collectCheque: row.so_id
      ? terms.collectsAtDelivery(
        (db.prepare('SELECT payment_terms_id FROM sales_orders WHERE id = ?').get(row.so_id) || {}).payment_terms_id)
      : false,
  });
}));

/**
 * Deliver.
 *
 * The material leaves the yard and comes off the committed list at the same
 * moment. A client whose terms call for an advance does not get the load until
 * the advance is in — that is checked here, at the gate, rather than
 * discovered later by accounts.
 */
router.post('/deliveries', shipper, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['partner_id', 'items']);
  const company = docs.companyFor(req, b);
  const order = b.so_id ? db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(b.so_id) : null;
  if (b.so_id && !order) throw notFound('No such order.');
  if (order && order.status === 'cancelled') throw conflict('That order has been cancelled.');

  if (order && !v.bool(b.override_hold)) {
    const check = terms.releaseCheck(order);
    if (!check.ok) throw conflict(check.reason);
  }

  const location = b.location_id
    ? db.prepare('SELECT * FROM locations WHERE id = ?').get(b.location_id)
    : db.prepare('SELECT * FROM locations WHERE is_default = 1 AND active = 1').get();

  const lines = b.items.map((raw, i) => {
    const soItem = raw.so_item_id
      ? db.prepare('SELECT * FROM sales_order_items WHERE id = ?').get(raw.so_item_id) : null;
    if (raw.so_item_id && !soItem) throw notFound(`Order line ${raw.so_item_id} no longer exists.`);
    const qty = v.qty(raw.qty, 0);
    if (qty <= 0) throw badRequest(`Line ${i + 1} needs a quantity.`);
    if (soItem) {
      const pending = soItem.qty - soItem.delivered_qty;
      if (qty - 0.005 > pending) {
        throw badRequest(
          `Line ${i + 1}: only ${pending} ${soItem.uom} of ${soItem.item_code || soItem.description} `
          + 'is still to be delivered on this order.');
      }
    }
    return {
      so_item_id: soItem ? soItem.id : null,
      item_id: raw.item_id || (soItem ? soItem.item_id : null),
      item_code: raw.item_code || (soItem ? soItem.item_code : null),
      description: v.str(raw.description) || (soItem ? soItem.description : null),
      qty,
      uom: v.str(raw.uom) || (soItem ? soItem.uom : 'NOS'),
      remarks: v.str(raw.remarks),
    };
  });

  const result = tx(() => {
    const dnNo = ids.docNo('deliveryNote', company.code);
    const deliveredOn = v.date(b.delivery_date) || v.today();
    const info = db.prepare(`
      INSERT INTO delivery_notes (company_id, dn_no, so_id, enquiry_id, partner_id, location_id,
        application_id, delivery_date, delivery_address, vehicle_no, driver_name, received_by, notes,
        status, created_by)
      VALUES (@company_id, @dn_no, @so_id, @enquiry_id, @partner_id, @location_id, @application_id,
        @delivery_date, @delivery_address, @vehicle_no, @driver_name, @received_by, @notes, @status,
        @created_by)`).run({
      company_id: company.id,
      dn_no: dnNo,
      so_id: order ? order.id : null,
      enquiry_id: clientEnquiry(b.enquiry_id) || (order ? order.enquiry_id : null),
      partner_id: b.partner_id,
      location_id: location ? location.id : null,
      application_id: b.application_id || (order ? order.application_id : null),
      delivery_date: deliveredOn,
      delivery_address: v.str(b.delivery_address)
        || (order ? [order.delivery_location, order.delivery_address].filter(Boolean).join(' — ') : null),
      vehicle_no: v.str(b.vehicle_no),
      driver_name: v.str(b.driver_name),
      received_by: v.str(b.received_by),
      notes: v.str(b.notes),
      status: v.oneOf(b.status, ['draft', 'delivered'], 'status') || 'delivered',
      created_by: req.user.id,
    });
    const dnId = info.lastInsertRowid;

    for (const line of lines) {
      db.prepare(`INSERT INTO delivery_note_items (dn_id, so_item_id, item_id, item_code, description,
          qty, uom, remarks) VALUES (@dn_id, @so_item_id, @item_id, @item_code, @description, @qty,
          @uom, @remarks)`).run({ ...line, dn_id: dnId });

      stock.post({
        companyId: company.id, itemId: line.item_id, locationId: location ? location.id : null,
        bucket: 'onhand', kind: 'delivered', qty: -line.qty, refType: 'delivery_note', refId: dnId,
        refNo: dnNo, partnerId: b.partner_id, movedOn: deliveredOn, userId: req.user.id,
        notes: order ? `Delivered against ${order.so_no}` : 'Delivered',
      });
      if (line.so_item_id) {
        stock.post({
          companyId: company.id, itemId: line.item_id, bucket: 'committed', kind: 'delivered',
          qty: -line.qty, refType: 'delivery_note', refId: dnId, refNo: dnNo,
          partnerId: b.partner_id, movedOn: deliveredOn, userId: req.user.id,
          notes: `Released from ${order.so_no}`,
        });
        db.prepare('UPDATE sales_order_items SET delivered_qty = delivered_qty + ? WHERE id = ?')
          .run(line.qty, line.so_item_id);
      }
    }

    if (order) {
      const pending = db.prepare(
        'SELECT COALESCE(SUM(qty - delivered_qty), 0) AS p FROM sales_order_items WHERE so_id = ?')
        .get(order.id).p;
      db.prepare('UPDATE sales_orders SET status = ? WHERE id = ?')
        .run(pending > 0.005 ? 'partial' : 'delivered', order.id);
    }
    return { id: dnId, dnNo };
  })();

  notify.toRole('accounts', {
    title: `Delivered — ${result.dnNo}`,
    body: order ? `Against ${order.so_no}. The tax invoice can be raised.` : 'Delivered.',
    route: `#/deliveries?id=${result.id}`,
  });
  audit.log(req, 'delivery_note.created', 'delivery_note', result.id, { dnNo: result.dnNo });
  res.status(201).json({ id: result.id, dn_no: result.dnNo });
}));

/** The client's storeman signed for it. */
router.post('/deliveries/:id/acknowledge', shipper, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM delivery_notes WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such delivery note.');
  db.prepare("UPDATE delivery_notes SET status = 'acknowledged', received_by = ?, received_on = ? WHERE id = ?")
    .run(v.str(req.body.received_by, row.received_by), v.date(req.body.received_on) || v.today(), row.id);
  audit.log(req, 'delivery_note.acknowledged', 'delivery_note', row.id, { dnNo: row.dn_no });
  res.json({ ok: true });
}));

// =============================================================== tax invoices
const SI_SELECT = `
  SELECT i.*, p.name AS partner_name, p.code AS partner_code,
         a.name AS application_name, a.code AS application_code,
         t.name AS terms_name, o.so_no, d.dn_no, c.code AS company_code,
         (i.total - i.paid_amount) AS outstanding, u.name AS created_by_name,
         COALESCE(e.enquiry_no, oe.enquiry_no, qe.enquiry_no) AS enquiry_no
    FROM sales_invoices i
    JOIN partners p ON p.id = i.partner_id
    LEFT JOIN applications a ON a.id = i.application_id
    LEFT JOIN payment_terms t ON t.id = i.payment_terms_id
    LEFT JOIN sales_orders o ON o.id = i.so_id
    LEFT JOIN enquiries e ON e.id = i.enquiry_id
    LEFT JOIN enquiries oe ON oe.id = o.enquiry_id
    LEFT JOIN sales_quotations oq ON oq.id = o.quotation_id
    LEFT JOIN enquiries qe ON qe.id = oq.enquiry_id
    LEFT JOIN delivery_notes d ON d.id = i.dn_id
    LEFT JOIN companies c ON c.id = i.company_id
    LEFT JOIN users u ON u.id = i.created_by`;

router.get('/invoices', wrap(async (req, res) => {
  const { limit, offset, page } = v.paging(req.query, 50);
  const where = [];
  const params = { limit, offset };
  if (req.query.status) { where.push('i.status = @status'); params.status = req.query.status; }
  if (req.query.partner_id) { where.push('i.partner_id = @partner_id'); params.partner_id = req.query.partner_id; }
  if (v.bool(req.query.open)) where.push("i.status IN ('unpaid','partial','overdue')");
  if (v.bool(req.query.overdue)) where.push("i.status IN ('unpaid','partial','overdue') AND i.due_date < date('now')");
  if (req.query.from) { where.push('i.invoice_date >= @from'); params.from = v.date(req.query.from); }
  if (req.query.to) { where.push('i.invoice_date <= @to'); params.to = v.date(req.query.to); }
  if (req.query.q) {
    where.push('(i.invoice_no LIKE @q OR p.name LIKE @q OR i.client_lpo_no LIKE @q OR i.project LIKE @q)');
    params.q = `%${String(req.query.q).trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`${SI_SELECT} ${clause} ORDER BY i.invoice_date DESC, i.id DESC LIMIT @limit OFFSET @offset`)
    .all(params);
  if (!auth.seesPrices(req.user)) for (const r of rows) { r.total = null; r.paid_amount = null; r.outstanding = null; }
  res.json({
    rows,
    total: db.prepare(`SELECT COUNT(*) AS c FROM sales_invoices i JOIN partners p ON p.id = i.partner_id ${clause}`).get(params).c,
    page, limit,
  });
}));

router.get('/invoices/:id', wrap(async (req, res) => {
  const row = db.prepare(`${SI_SELECT} WHERE i.id = ?`).get(req.params.id);
  if (!row) throw notFound('No such invoice.');
  const items = db.prepare(`
    SELECT i.*, a.name AS application_name FROM sales_invoice_items i
      LEFT JOIN applications a ON a.id = i.application_id
     WHERE i.invoice_id = ? ORDER BY i.line_no`).all(row.id);
  if (!auth.seesCost(req.user)) for (const i of items) i.cost_price = null;

  res.json({
    invoice: row,
    items,
    termsText: terms.describe(row.payment_terms_id),
    amountInWords: pricing.inWords(row.total, row.currency),
    receipts: db.prepare(`
      SELECT p.id, p.payment_no, p.payment_date, p.mode, p.cheque_no, p.cheque_date, p.status, a.amount
        FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
       WHERE a.invoice_side = 'sales' AND a.invoice_id = ? ORDER BY p.payment_date`).all(row.id),
    margin: auth.seesCost(req.user)
      ? pricing.margin(row.subtotal - row.discount,
        items.reduce((a, i) => a + (i.cost_price || 0) * i.qty, 0))
      : null,
  });
}));

/**
 * Raise the tax invoice.
 *
 * Every particular the UAE requires on one — both TRNs, the addresses, the
 * client's own LPO number, the tax charged and the total in words — is written
 * onto the invoice at the moment it is issued rather than looked up when it
 * prints. A copy reissued next year is then the document that was issued, not
 * today's version of it.
 */
router.post('/invoices', bookkeeper, wrap(async (req, res) => {
  const b = req.body;
  v.required(b, ['partner_id']);
  const company = docs.companyFor(req, b);
  const client = db.prepare('SELECT * FROM partners WHERE id = ?').get(b.partner_id);
  if (!client) throw notFound('No such client.');

  const order = b.so_id ? db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(b.so_id) : null;
  const delivery = b.dn_id ? db.prepare('SELECT * FROM delivery_notes WHERE id = ?').get(b.dn_id) : null;

  /*
   * Invoicing straight off a delivery note is the normal case — the goods have
   * gone, the note says what went, and the invoice should say the same. So if
   * no lines are given, they are taken from the delivery, priced from the
   * order it was delivered against.
   */
  let rawLines = Array.isArray(b.items) ? b.items : null;
  if (!rawLines && delivery) {
    rawLines = db.prepare('SELECT * FROM delivery_note_items WHERE dn_id = ? ORDER BY id').all(delivery.id)
      .map((d) => {
        const soItem = d.so_item_id
          ? db.prepare('SELECT * FROM sales_order_items WHERE id = ?').get(d.so_item_id) : null;
        return {
          item_id: d.item_id, item_code: d.item_code, description: d.description, qty: d.qty, uom: d.uom,
          unit_price: soItem ? soItem.unit_price : 0,
          cost_price: soItem ? soItem.cost_price : 0,
          discount: soItem && soItem.qty ? pricing.round(soItem.discount * (d.qty / soItem.qty)) : 0,
          vat_percent: soItem ? soItem.vat_percent : undefined,
          application_id: soItem ? soItem.application_id : null,
        };
      });
  }
  if (!rawLines || !rawLines.length) {
    throw badRequest('There is nothing to invoice — give the lines, or invoice against a delivery note.');
  }

  const priced = docs.buildLines(rawLines, { side: 'sell' });
  const invoiceDate = v.date(b.invoice_date) || v.today();
  const paymentTermsId = b.payment_terms_id || (order ? order.payment_terms_id : null)
    || client.payment_terms_id || null;

  const result = tx(() => {
    const invoiceNo = ids.docNo('salesInvoice', company.code);
    const info = db.prepare(`
      INSERT INTO sales_invoices (company_id, invoice_no, partner_id, so_id, dn_id, enquiry_id,
        application_id,
        project, invoice_date, due_date, payment_terms_id, currency, company_name, company_trn,
        company_address, client_name, client_trn, client_address, client_lpo_no, place_of_supply,
        subtotal, discount, vat_amount, total, status, notes, created_by)
      VALUES (@company_id, @invoice_no, @partner_id, @so_id, @dn_id, @enquiry_id, @application_id,
        @project,
        @invoice_date, @due_date, @payment_terms_id, @currency, @company_name, @company_trn,
        @company_address, @client_name, @client_trn, @client_address, @client_lpo_no,
        @place_of_supply, @subtotal, @discount, @vat_amount, @total, 'unpaid', @notes, @created_by)`).run({
      company_id: company.id,
      invoice_no: invoiceNo,
      partner_id: client.id,
      so_id: order ? order.id : null,
      dn_id: delivery ? delivery.id : null,
      enquiry_id: clientEnquiry(b.enquiry_id)
        || (order ? order.enquiry_id : null) || (delivery ? delivery.enquiry_id : null),
      application_id: docs.resolveApplication(
        b.application_id || (order ? order.application_id : null), priced.lines),
      project: v.str(b.project) || (order ? order.project : null),
      invoice_date: invoiceDate,
      due_date: v.date(b.due_date) || terms.dueDate(paymentTermsId, invoiceDate),
      payment_terms_id: paymentTermsId,
      currency: v.str(b.currency, client.currency || 'AED'),
      company_name: company.name,
      company_trn: company.trn,
      company_address: company.address,
      client_name: client.name,
      client_trn: client.trn,
      client_address: v.str(b.client_address) || client.address,
      client_lpo_no: v.str(b.client_lpo_no) || (order ? order.client_lpo_no : null),
      place_of_supply: v.str(b.place_of_supply) || client.emirate || 'Dubai',
      ...priced.footer,
      notes: v.str(b.notes),
      created_by: req.user.id,
    });
    const invoiceId = info.lastInsertRowid;
    docs.insertLines('sales_invoice_items', 'invoice_id', invoiceId,
      priced.lines, docs.LINE_COLUMNS.salesInvoice);

    if (order) {
      for (const line of priced.lines) {
        if (!line.item_id) continue;
        db.prepare('UPDATE sales_order_items SET invoiced_qty = invoiced_qty + ? WHERE so_id = ? AND item_id = ?')
          .run(line.qty, order.id, line.item_id);
      }
      const uninvoiced = db.prepare(
        'SELECT COALESCE(SUM(qty - invoiced_qty), 0) AS p FROM sales_order_items WHERE so_id = ?')
        .get(order.id).p;
      if (uninvoiced <= 0.005) {
        db.prepare("UPDATE sales_orders SET status = 'invoiced' WHERE id = ?").run(order.id);
      }
    }
    return { id: invoiceId, invoiceNo };
  })();

  const saved = db.prepare(`${SI_SELECT} WHERE i.id = ?`).get(result.id);
  audit.log(req, 'sales_invoice.created', 'sales_invoice', result.id,
    { invoiceNo: result.invoiceNo, total: saved.total, vat: saved.vat_amount });
  res.status(201).json(saved);
}));

router.patch('/invoices/:id', bookkeeper, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('No such invoice.');
  const wantsCancel = v.str(req.body.status) === 'cancelled';
  if (wantsCancel && row.paid_amount > 0) {
    throw conflict('Money has been received against this invoice — reverse the receipt before cancelling it.');
  }
  /*
   * A tax invoice's figures are not editable once issued. Under UAE VAT the
   * correction for a wrong amount is a credit note and a fresh invoice, not a
   * quiet edit of a document the client has already filed with their return.
   */
  db.prepare(`UPDATE sales_invoices SET due_date = @due_date, payment_terms_id = @payment_terms_id,
      notes = @notes, status = @status, client_lpo_no = @client_lpo_no WHERE id = @id`).run({
    id: row.id,
    due_date: v.date(req.body.due_date) || row.due_date,
    payment_terms_id: req.body.payment_terms_id === undefined
      ? row.payment_terms_id : (req.body.payment_terms_id || null),
    notes: v.str(req.body.notes, row.notes),
    client_lpo_no: v.str(req.body.client_lpo_no, row.client_lpo_no),
    status: v.oneOf(req.body.status, ['unpaid', 'partial', 'paid', 'overdue', 'cancelled'], 'status') || row.status,
  });
  if (!wantsCancel) settlement.refreshInvoice('sales', row.id);
  audit.log(req, 'sales_invoice.updated', 'sales_invoice', row.id, { invoiceNo: row.invoice_no });
  res.json(db.prepare(`${SI_SELECT} WHERE i.id = ?`).get(row.id));
}));

/** What clients owe, and how long they have owed it. */
router.get('/receivables/ageing', auth.requireRole('kam', 'accounts'), wrap(async (req, res) => {
  res.json(ledger.ageing('receivable', {
    companyId: req.query.company_id || null,
    asOf: v.date(req.query.asOf),
    partnerId: req.query.partner_id || null,
  }));
}));

module.exports = router;
