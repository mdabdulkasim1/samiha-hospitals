'use strict';
/*
 * An enquiry, on either side of the trade.
 *
 * A client asks us to price something; we ask a manufacturer to price
 * something. It is the same document read in two directions — somebody wants a
 * price, against a partner, an application and a project, and it stays open
 * until a quotation answers it — so it is one implementation with a side.
 *
 * The company's rule is that a manufacturer's quotation only exists against an
 * enquiry we raised. That rule is enforced where the supplier quotation is
 * raised (src/routes/purchase.js); what lives here is the enquiry itself.
 */
const { db } = require('../db');
const ids = require('../lib/ids');
const v = require('../lib/validate');
const { badRequest, notFound } = require('../lib/http');

const SIDES = {
  client: { series: 'enquiry', partnerType: 'client', noun: 'client' },
  supplier: { series: 'supplierEnquiry', partnerType: 'supplier', noun: 'manufacturer' },
};

const STATUSES = ['open', 'quoted', 'won', 'lost', 'closed'];

const SELECT = `
  SELECT e.*, p.name AS partner_name, p.code AS partner_code,
         a.name AS application_name, a.code AS application_code,
         u.name AS owner_name, c.code AS company_code
    FROM enquiries e
    LEFT JOIN partners p ON p.id = e.partner_id
    LEFT JOIN applications a ON a.id = e.application_id
    LEFT JOIN users u ON u.id = e.owner_id
    LEFT JOIN companies c ON c.id = e.company_id`;

/** One enquiry, or nothing. */
function get(id, side = null) {
  const row = db.prepare(`${SELECT} WHERE e.id = ?`).get(id);
  if (!row) return null;
  if (side && row.side !== side) return null;
  return row;
}

/** The list behind both enquiry screens. */
function list(side, query) {
  const { limit, offset, page } = v.paging(query, 50);
  const where = ['e.side = @side'];
  const params = { side, limit, offset };
  if (query.status) { where.push('e.status = @status'); params.status = query.status; }
  else if (v.bool(query.open)) where.push("e.status IN ('open','quoted')");
  if (query.owner_id) { where.push('e.owner_id = @owner_id'); params.owner_id = query.owner_id; }
  if (query.partner_id) { where.push('e.partner_id = @partner_id'); params.partner_id = query.partner_id; }
  if (query.application_id) {
    where.push('e.application_id = @application_id');
    params.application_id = query.application_id;
  }
  if (query.q) {
    where.push(`(e.enquiry_no LIKE @q OR e.subject LIKE @q OR e.project LIKE @q
                 OR e.client_name LIKE @q OR p.name LIKE @q)`);
    params.q = `%${String(query.q).trim()}%`;
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  return {
    rows: db.prepare(`${SELECT} ${clause} ORDER BY e.received_on DESC, e.id DESC
                        LIMIT @limit OFFSET @offset`).all(params),
    total: db.prepare(`SELECT COUNT(*) AS c FROM enquiries e
                         LEFT JOIN partners p ON p.id = e.partner_id ${clause}`).get(params).c,
    page,
    limit,
  };
}

/** Log one. `company` is the row the caller resolved. */
function create(side, body, { company, user }) {
  const shape = SIDES[side];
  if (!shape) throw badRequest(`Unknown enquiry side: ${side}`);
  if (!body.partner_id && !v.str(body.client_name)) {
    throw badRequest(side === 'supplier'
      ? 'Say which manufacturer the enquiry goes to — pick one, or type their name.'
      : 'Say who the enquiry is from — pick a client, or type their name.');
  }
  const enquiryNo = ids.docNo(shape.series, company.code);
  const info = db.prepare(`
    INSERT INTO enquiries (company_id, enquiry_no, side, partner_id, client_name, contact_person,
      phone, email, application_id, project, subject, requirement, received_on, due_on, owner_id,
      created_by)
    VALUES (@company_id, @enquiry_no, @side, @partner_id, @client_name, @contact_person, @phone,
      @email, @application_id, @project, @subject, @requirement, @received_on, @due_on, @owner_id,
      @created_by)`).run({
    company_id: company.id,
    enquiry_no: enquiryNo,
    side,
    partner_id: body.partner_id || null,
    client_name: v.str(body.client_name),
    contact_person: v.str(body.contact_person),
    phone: v.str(body.phone),
    email: v.str(body.email),
    application_id: body.application_id || null,
    project: v.str(body.project),
    subject: v.str(body.subject),
    requirement: v.str(body.requirement),
    received_on: v.date(body.received_on) || v.today(),
    due_on: v.date(body.due_on),
    owner_id: body.owner_id || user.id,
    created_by: user.id,
  });
  return { id: info.lastInsertRowid, enquiryNo, row: get(info.lastInsertRowid) };
}

/** Amend one. Only the side it was logged on may amend it. */
function update(side, id, body) {
  const row = get(id, side);
  if (!row) throw notFound('No such enquiry.');
  db.prepare(`UPDATE enquiries SET partner_id = @partner_id, client_name = @client_name,
      contact_person = @contact_person, phone = @phone, email = @email, subject = @subject,
      project = @project, requirement = @requirement, application_id = @application_id,
      due_on = @due_on, owner_id = @owner_id, status = @status, lost_reason = @lost_reason
    WHERE id = @id`).run({
    id: row.id,
    partner_id: body.partner_id === undefined ? row.partner_id : (body.partner_id || null),
    client_name: v.str(body.client_name, row.client_name),
    contact_person: v.str(body.contact_person, row.contact_person),
    phone: v.str(body.phone, row.phone),
    email: v.str(body.email, row.email),
    subject: v.str(body.subject, row.subject),
    project: v.str(body.project, row.project),
    requirement: v.str(body.requirement, row.requirement),
    application_id: body.application_id === undefined
      ? row.application_id : (body.application_id || null),
    due_on: v.date(body.due_on) || row.due_on,
    owner_id: body.owner_id === undefined ? row.owner_id : (body.owner_id || null),
    status: v.oneOf(body.status, STATUSES, 'status') || row.status,
    lost_reason: v.str(body.lost_reason, row.lost_reason),
  });
  return get(row.id);
}

/**
 * The enquiry a quotation is being raised against. Refuses anything that is
 * not an open enquiry of the right side, which is what keeps a supplier
 * quotation from appearing out of nowhere.
 */
function forQuotation(side, enquiryId) {
  const shape = SIDES[side];
  if (!enquiryId) {
    throw badRequest(side === 'supplier'
      ? 'Raise the enquiry to the manufacturer first — their quotation is logged against it.'
      : 'Say which enquiry this quotation answers.');
  }
  const row = get(enquiryId, side);
  if (!row) throw notFound(`No such ${shape.noun} enquiry.`);
  if (['lost', 'closed'].includes(row.status)) {
    throw badRequest(`${row.enquiry_no} is ${row.status}. Reopen it, or raise a new enquiry.`);
  }
  return row;
}

/** A quotation has answered it. */
function markQuoted(enquiryId) {
  if (!enquiryId) return;
  db.prepare("UPDATE enquiries SET status = 'quoted' WHERE id = ? AND status = 'open'")
    .run(enquiryId);
}


/*
 * The enquiry behind an invoice, on either side of the trade.
 *
 * A payment voucher is the end of a chain rather than a link in it: a cheque
 * can settle three of a manufacturer's bills at once, so the voucher carries
 * the enquiries of whatever it actually pays rather than one of its own. On the
 * buy side the bill knows its enquiry; on the sell side it is reached through
 * the order and the quotation, which is where a client's enquiry is recorded.
 */
const INVOICE_ENQUIRY = {
  purchase: `
    SELECT COALESCE(e.enquiry_no, oe.enquiry_no) AS enquiry_no
      FROM supplier_invoices i
      LEFT JOIN enquiries e ON e.id = i.enquiry_id
      LEFT JOIN purchase_orders o ON o.id = i.po_id
      LEFT JOIN enquiries oe ON oe.id = o.enquiry_id
     WHERE i.id = ?`,
  sales: `
    SELECT e.enquiry_no AS enquiry_no
      FROM sales_invoices i
      LEFT JOIN sales_orders so ON so.id = i.so_id
      LEFT JOIN sales_quotations q ON q.id = so.quotation_id
      LEFT JOIN enquiries e ON e.id = q.enquiry_id
     WHERE i.id = ?`,
};

/** The enquiry number an invoice belongs to, or null. */
function forInvoice(side, invoiceId) {
  const sql = INVOICE_ENQUIRY[side];
  if (!sql || !invoiceId) return null;
  const row = db.prepare(sql).get(invoiceId);
  return row ? row.enquiry_no : null;
}

/*
 * The same two chains as one correlated subquery, for a list of payments:
 * every enquiry a payment touches, comma-separated. `p` is the payments alias.
 */
const PAYMENT_ENQUIRIES_SQL = `(
  SELECT group_concat(ref) FROM (
    SELECT DISTINCT COALESCE(be.enquiry_no, boe.enquiry_no, se.enquiry_no) AS ref
      FROM payment_allocations a
      LEFT JOIN supplier_invoices bi ON a.invoice_side = 'purchase' AND bi.id = a.invoice_id
      LEFT JOIN enquiries be ON be.id = bi.enquiry_id
      LEFT JOIN purchase_orders bo ON bo.id = bi.po_id
      LEFT JOIN enquiries boe ON boe.id = bo.enquiry_id
      LEFT JOIN sales_invoices si ON a.invoice_side = 'sales' AND si.id = a.invoice_id
      LEFT JOIN sales_orders so ON so.id = si.so_id
      LEFT JOIN sales_quotations sq ON sq.id = so.quotation_id
      LEFT JOIN enquiries se ON se.id = sq.enquiry_id
     WHERE a.payment_id = p.id
       AND COALESCE(be.enquiry_no, boe.enquiry_no, se.enquiry_no) IS NOT NULL
  ))`;

module.exports = { SIDES, STATUSES, SELECT, PAYMENT_ENQUIRIES_SQL,
  get, list, create, update, forQuotation, forInvoice, markQuoted };
