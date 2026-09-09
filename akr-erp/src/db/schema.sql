-- =============================================================================
-- AKR GENERAL TRADING L.L.C — trading ERP schema
--
-- Two sides of the same trade, over one item master and one stock register:
--
--   BUY   supplier / manufacturer quotation -> our LPO -> goods received ->
--         their invoice -> our payment, on their payment terms
--   SELL  our quotation -> the client's LPO -> our delivery note ->
--         our tax invoice -> their payment, on their payment terms
--
-- Everything is stamped with the group company that issued it, the
-- application it belongs to (potable water, storm water, sewerage, district
-- cooling, irrigation) and 5% UAE VAT.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------ group & access
/*
 * The group's companies. AKR General Trading is one of them; the others share
 * this system, each with its own TRN, its own document numbers and its own
 * books, which is what keeps six companies' accounts apart.
 */
CREATE TABLE IF NOT EXISTS companies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,          -- AKR, and the five sister codes
  name         TEXT NOT NULL,
  legal_name   TEXT,
  trn          TEXT,                          -- Tax Registration Number
  address      TEXT,
  phone        TEXT,
  email        TEXT,
  website      TEXT,
  bank_name    TEXT,
  bank_account TEXT,
  iban         TEXT,
  swift        TEXT,
  currency     TEXT NOT NULL DEFAULT 'AED',
  vat_percent  REAL NOT NULL DEFAULT 5,
  is_default   INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_code    TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','kam','accounts','sales','logistics')),
  company_id    INTEGER REFERENCES companies(id),
  designation   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  actor      TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  details    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

-- ---------------------------------------------------------------- the trade
/*
 * The five applications the company trades into. Every item belongs to one,
 * and every document — quotation, LPO, delivery note, invoice — carries one
 * as its title, so a storm-water job and a potable-water job never share a
 * sheet of paper by accident.
 */
CREATE TABLE IF NOT EXISTS applications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,            -- PW, SW, SEW, DC, IRR
  name       TEXT NOT NULL,                   -- Potable Water, Storm Water, ...
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

/*
 * The product lines, as the company files them: a product group (valves,
 * geotextiles, mechanical fittings, fabrication, GRP ladders, fasteners),
 * usually paired with the application it is made for. The pair is what the
 * item code is built from — AKR-VLP-00001 is a potable-water valve.
 */
CREATE TABLE IF NOT EXISTS item_categories (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,        -- VLP, VLI, VLS, VLD, GTP, ...
  name           TEXT NOT NULL,               -- 'Valves — Potable Water'
  product_group  TEXT NOT NULL,               -- 'Valves'
  application_id INTEGER REFERENCES applications(id),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1
);

/*
 * The types within a product line.
 *
 * Fabrication in particular is not one thing: a strap, an air vent, a handle
 * bar, a C clamp, a grating, a chequered plate, an extension spindle. The
 * company files them under fabrication but orders, stocks and quotes them
 * separately, so the type is its own field on the item rather than words
 * buried in a description that nothing can be sorted by.
 */
CREATE TABLE IF NOT EXISTS item_subgroups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  product_group TEXT NOT NULL,          -- 'Misc. Fabrication', 'Valves', ...
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (product_group, code)
);

/*
 * The common item number. One code, used on our LPO to the manufacturer, on
 * the client's quotation, on the delivery note and in the stock register, so
 * a valve is the same valve everywhere it appears.
 */
CREATE TABLE IF NOT EXISTS items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_code      TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT,
  category_id    INTEGER NOT NULL REFERENCES item_categories(id),
  subgroup_id    INTEGER REFERENCES item_subgroups(id),
  application_id INTEGER REFERENCES applications(id),
  brand          TEXT,
  manufacturer_id INTEGER REFERENCES partners(id),
  mfr_part_no    TEXT,                        -- the maker's own number
  material       TEXT,                        -- Ductile Iron, GRP, SS316 ...
  size           TEXT,                        -- DN100, 4", 2000 mm
  pressure_class TEXT,                        -- PN16, Class 150
  standard       TEXT,                        -- BS EN 1074, AWWA C509
  uom            TEXT NOT NULL DEFAULT 'NOS',
  hs_code        TEXT,
  cost_price     REAL NOT NULL DEFAULT 0,     -- last landed cost
  sell_price     REAL NOT NULL DEFAULT 0,     -- list price to a client
  vat_percent    REAL NOT NULL DEFAULT 5,
  reorder_level  REAL NOT NULL DEFAULT 0,
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);

-- Which manufacturers make an item, and what each last quoted for it.
CREATE TABLE IF NOT EXISTS item_suppliers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  partner_id   INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  supplier_ref TEXT,
  last_price   REAL NOT NULL DEFAULT 0,
  last_quoted  TEXT,
  lead_days    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (item_id, partner_id)
);

-- ------------------------------------------------------------ payment terms
/*
 * How a partner pays, or is paid. Kept as a master rather than free text
 * because the due date on an invoice, the advance a client owes before
 * anything is ordered and the cheque a driver collects at the gate are all
 * derived from it — and every supplier and client has their own.
 */
CREATE TABLE IF NOT EXISTS payment_terms (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,             -- '60 days from invoice date'
  kind             TEXT NOT NULL DEFAULT 'credit'
                     CHECK (kind IN ('advance','on_delivery','credit','pdc','milestone','lc')),
  credit_days      INTEGER NOT NULL DEFAULT 0,
  advance_percent  REAL NOT NULL DEFAULT 0,   -- taken before the order is placed
  on_delivery_percent REAL NOT NULL DEFAULT 0,-- cheque handed over at delivery
  retention_percent   REAL NOT NULL DEFAULT 0,
  applies_to       TEXT NOT NULL DEFAULT 'both' CHECK (applies_to IN ('supplier','client','both')),
  description      TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1
);

-- -------------------------------------------------------- suppliers/clients
CREATE TABLE IF NOT EXISTS partners (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL UNIQUE,      -- SUP-0001 / CLI-0001
  type             TEXT NOT NULL CHECK (type IN ('supplier','client','both')),
  name             TEXT NOT NULL,
  trade_name       TEXT,
  trn              TEXT,
  contact_person   TEXT,
  designation      TEXT,
  phone            TEXT,
  mobile           TEXT,
  email            TEXT,
  address          TEXT,
  city             TEXT,
  emirate          TEXT,
  country          TEXT NOT NULL DEFAULT 'United Arab Emirates',
  payment_terms_id INTEGER REFERENCES payment_terms(id),
  credit_limit     REAL NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'AED',
  bank_name        TEXT,
  iban             TEXT,
  account_manager_id INTEGER REFERENCES users(id),
  opening_balance  REAL NOT NULL DEFAULT 0,   -- + they owe us, - we owe them
  notes            TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_partners_type ON partners(type);

CREATE TABLE IF NOT EXISTS partner_contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id  INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  designation TEXT,
  phone       TEXT,
  email       TEXT,
  is_primary  INTEGER NOT NULL DEFAULT 0
);

-- Where stock sits. One yard to begin with; add as many as the company keeps.
CREATE TABLE IF NOT EXISTS locations (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  code     TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  address  TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  active   INTEGER NOT NULL DEFAULT 1
);

-- =============================================================================
-- BUY SIDE — manufacturer / supplier to AKR
-- =============================================================================

/*
 * What we asked a manufacturer for, and what they came back with. A quotation
 * starts as a request (nothing priced), becomes received when their prices are
 * entered, and is approved before an LPO may be raised from it — which is the
 * rule the company works to: the price is confirmed first, the LPO second.
 */
CREATE TABLE IF NOT EXISTS supplier_quotations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  quote_no         TEXT NOT NULL UNIQUE,
  partner_id       INTEGER NOT NULL REFERENCES partners(id),
  application_id   INTEGER REFERENCES applications(id),
  enquiry_id       INTEGER REFERENCES enquiries(id),  -- the RFQ it answers
  supplier_ref     TEXT,                      -- their own quotation number
  subject          TEXT,
  project          TEXT,
  quote_date       TEXT NOT NULL DEFAULT (date('now')),
  valid_until      TEXT,
  payment_terms_id INTEGER REFERENCES payment_terms(id),
  delivery_days    INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'AED',
  subtotal         REAL NOT NULL DEFAULT 0,
  discount         REAL NOT NULL DEFAULT 0,
  vat_amount       REAL NOT NULL DEFAULT 0,
  total            REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'requested'
                     CHECK (status IN ('requested','received','approved','rejected','expired','ordered')),
  notes            TEXT,
  terms_text       TEXT,
  linked_sales_quotation_id INTEGER REFERENCES sales_quotations(id),
  created_by       INTEGER REFERENCES users(id),
  approved_by      INTEGER REFERENCES users(id),
  approved_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_quotation_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id   INTEGER NOT NULL REFERENCES supplier_quotations(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL DEFAULT 1,
  item_id        INTEGER REFERENCES items(id),
  item_code      TEXT,
  description    TEXT NOT NULL,
  application_id INTEGER REFERENCES applications(id),
  qty            REAL NOT NULL DEFAULT 0,
  uom            TEXT NOT NULL DEFAULT 'NOS',
  unit_price     REAL NOT NULL DEFAULT 0,
  discount       REAL NOT NULL DEFAULT 0,
  taxable        REAL NOT NULL DEFAULT 0,
  vat_percent    REAL NOT NULL DEFAULT 5,
  vat_amount     REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL DEFAULT 0,
  lead_days      INTEGER NOT NULL DEFAULT 0,
  remarks        TEXT
);

/*
 * Our LPO to the manufacturer. Placing it is what puts the material on order
 * in the stock register — the company treats an outstanding LPO as stock it
 * has coming, and the register says so in as many words.
 */
CREATE TABLE IF NOT EXISTS purchase_orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id),
  lpo_no            TEXT NOT NULL UNIQUE,
  partner_id        INTEGER NOT NULL REFERENCES partners(id),
  quotation_id      INTEGER REFERENCES supplier_quotations(id),
  -- The enquiry the whole order came out of, carried onto the LPO itself so
  -- the reference is on the paper the supplier holds.
  enquiry_id        INTEGER REFERENCES enquiries(id),
  application_id    INTEGER REFERENCES applications(id),
  sales_order_id    INTEGER REFERENCES sales_orders(id),   -- back-to-back
  project           TEXT,
  attention         TEXT,                     -- 'Attn: Mr. Sankar'
  incoterms         TEXT,                     -- 'Delivery to site in DXB'
  -- The end client's approving authority — DEWA, Dubai Municipality, Etisalat.
  -- Their inspection is a condition of several of the standard clauses, so it
  -- is a field on the order rather than a phrase retyped into the conditions.
  authority         TEXT,
  lpo_date          TEXT NOT NULL DEFAULT (date('now')),
  delivery_date     TEXT,
  delivery_location_id INTEGER REFERENCES locations(id),
  delivery_address  TEXT,
  payment_terms_id  INTEGER REFERENCES payment_terms(id),
  currency          TEXT NOT NULL DEFAULT 'AED',
  subtotal          REAL NOT NULL DEFAULT 0,
  discount          REAL NOT NULL DEFAULT 0,
  vat_amount        REAL NOT NULL DEFAULT 0,
  total             REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','sent','acknowledged','partial','received','closed','cancelled')),
  notes             TEXT,
  terms_text        TEXT,
  created_by        INTEGER REFERENCES users(id),
  approved_by       INTEGER REFERENCES users(id),
  approved_at       TEXT,
  sent_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_po_partner ON purchase_orders(partner_id);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id          INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL DEFAULT 1,
  item_id        INTEGER REFERENCES items(id),
  item_code      TEXT,
  description    TEXT NOT NULL,
  application_id INTEGER REFERENCES applications(id),
  qty            REAL NOT NULL DEFAULT 0,
  uom            TEXT NOT NULL DEFAULT 'NOS',
  unit_price     REAL NOT NULL DEFAULT 0,
  discount       REAL NOT NULL DEFAULT 0,
  taxable        REAL NOT NULL DEFAULT 0,
  vat_percent    REAL NOT NULL DEFAULT 5,
  vat_amount     REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL DEFAULT 0,
  received_qty   REAL NOT NULL DEFAULT 0,
  invoiced_qty   REAL NOT NULL DEFAULT 0,
  remarks        TEXT
);

CREATE TABLE IF NOT EXISTS grns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id),
  grn_no         TEXT NOT NULL UNIQUE,
  po_id          INTEGER REFERENCES purchase_orders(id),
  enquiry_id     INTEGER REFERENCES enquiries(id),   -- where the whole job began
  partner_id     INTEGER NOT NULL REFERENCES partners(id),
  location_id    INTEGER REFERENCES locations(id),
  received_date  TEXT NOT NULL DEFAULT (date('now')),
  supplier_dn_ref TEXT,
  vehicle_no     TEXT,
  inspected_by   TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','cancelled')),
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS grn_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_id       INTEGER NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
  po_item_id   INTEGER REFERENCES purchase_order_items(id),
  item_id      INTEGER REFERENCES items(id),
  item_code    TEXT,
  description  TEXT,
  qty          REAL NOT NULL DEFAULT 0,       -- accepted into stock
  rejected_qty REAL NOT NULL DEFAULT 0,
  uom          TEXT NOT NULL DEFAULT 'NOS',
  rate         REAL NOT NULL DEFAULT 0,
  remarks      TEXT
);

/*
 * The manufacturer's invoice, and what we still owe on it. The due date is
 * derived from their payment terms when the bill is entered, which is what
 * the payables ageing and the payment run read.
 */
CREATE TABLE IF NOT EXISTS supplier_invoices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  bill_no          TEXT NOT NULL UNIQUE,      -- ours, for filing
  supplier_inv_no  TEXT NOT NULL,             -- theirs, as printed
  partner_id       INTEGER NOT NULL REFERENCES partners(id),
  po_id            INTEGER REFERENCES purchase_orders(id),
  grn_id           INTEGER REFERENCES grns(id),
  enquiry_id       INTEGER REFERENCES enquiries(id),  -- where the whole job began
  application_id   INTEGER REFERENCES applications(id),
  invoice_date     TEXT NOT NULL DEFAULT (date('now')),
  received_date    TEXT NOT NULL DEFAULT (date('now')),
  due_date         TEXT,
  payment_terms_id INTEGER REFERENCES payment_terms(id),
  currency         TEXT NOT NULL DEFAULT 'AED',
  subtotal         REAL NOT NULL DEFAULT 0,
  discount         REAL NOT NULL DEFAULT 0,
  vat_amount       REAL NOT NULL DEFAULT 0,   -- input tax, recoverable
  total            REAL NOT NULL DEFAULT 0,
  paid_amount      REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'unpaid'
                     CHECK (status IN ('unpaid','partial','paid','disputed','cancelled')),
  notes            TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_invoice_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  line_no      INTEGER NOT NULL DEFAULT 1,
  item_id      INTEGER REFERENCES items(id),
  item_code    TEXT,
  description  TEXT NOT NULL,
  qty          REAL NOT NULL DEFAULT 0,
  uom          TEXT NOT NULL DEFAULT 'NOS',
  unit_price   REAL NOT NULL DEFAULT 0,
  discount     REAL NOT NULL DEFAULT 0,
  taxable      REAL NOT NULL DEFAULT 0,
  vat_percent  REAL NOT NULL DEFAULT 5,
  vat_amount   REAL NOT NULL DEFAULT 0,
  total        REAL NOT NULL DEFAULT 0
);

-- =============================================================================
-- SELL SIDE — AKR to the client
-- =============================================================================

/*
 * An enquiry, on either side of the trade.
 *
 *   side = 'client'   — what a client has asked us to price
 *   side = 'supplier' — what we have asked a manufacturer to price (an RFQ)
 *
 * They are the same document read in two directions, so they are one table:
 * somebody wants a price, it is logged against a partner and an application,
 * and it stays open until a quotation answers it. The company's rule is that
 * no manufacturer's quotation exists without one, which is enforced where the
 * supplier quotation is raised.
 */
CREATE TABLE IF NOT EXISTS enquiries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id),
  enquiry_no     TEXT NOT NULL UNIQUE,
  side           TEXT NOT NULL DEFAULT 'client' CHECK (side IN ('client','supplier')),
  partner_id     INTEGER REFERENCES partners(id),
  client_name    TEXT,                        -- before they are on the books
  contact_person TEXT,
  phone          TEXT,
  email          TEXT,
  application_id INTEGER REFERENCES applications(id),
  project        TEXT,
  subject        TEXT,
  requirement    TEXT,
  received_on    TEXT NOT NULL DEFAULT (date('now')),
  due_on         TEXT,
  owner_id       INTEGER REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','quoted','won','lost','closed')),
  lost_reason    TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
 * Our quotation to the client. It carries the cost behind every line as well
 * as the price, so the margin is visible to the people allowed to see it
 * while the price is still being decided — and nowhere else.
 */
CREATE TABLE IF NOT EXISTS sales_quotations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  quote_no         TEXT NOT NULL UNIQUE,
  revision         INTEGER NOT NULL DEFAULT 0,
  partner_id       INTEGER NOT NULL REFERENCES partners(id),
  enquiry_id       INTEGER REFERENCES enquiries(id),
  application_id   INTEGER REFERENCES applications(id),
  project          TEXT,
  subject          TEXT,
  attention        TEXT,
  quote_date       TEXT NOT NULL DEFAULT (date('now')),
  valid_until      TEXT,
  payment_terms_id INTEGER REFERENCES payment_terms(id),
  delivery_days    INTEGER NOT NULL DEFAULT 0,
  delivery_terms   TEXT,
  currency         TEXT NOT NULL DEFAULT 'AED',
  subtotal         REAL NOT NULL DEFAULT 0,
  discount         REAL NOT NULL DEFAULT 0,
  vat_amount       REAL NOT NULL DEFAULT 0,
  total            REAL NOT NULL DEFAULT 0,
  cost_total       REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','sent','under_review','approved','rejected','expired','converted')),
  notes            TEXT,
  terms_text       TEXT,
  created_by       INTEGER REFERENCES users(id),
  sent_at          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales_quotation_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id   INTEGER NOT NULL REFERENCES sales_quotations(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL DEFAULT 1,
  item_id        INTEGER REFERENCES items(id),
  item_code      TEXT,
  description    TEXT NOT NULL,
  application_id INTEGER REFERENCES applications(id),
  qty            REAL NOT NULL DEFAULT 0,
  uom            TEXT NOT NULL DEFAULT 'NOS',
  cost_price     REAL NOT NULL DEFAULT 0,
  unit_price     REAL NOT NULL DEFAULT 0,
  discount       REAL NOT NULL DEFAULT 0,
  taxable        REAL NOT NULL DEFAULT 0,
  vat_percent    REAL NOT NULL DEFAULT 5,
  vat_amount     REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL DEFAULT 0,
  lead_days      INTEGER NOT NULL DEFAULT 0,
  remarks        TEXT
);

/*
 * The client's LPO — their purchase order to us, which is our sales order.
 * Confirming it commits the material in the stock register, so nobody sells
 * the same valve twice.
 */
CREATE TABLE IF NOT EXISTS sales_orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  so_no            TEXT NOT NULL UNIQUE,
  client_lpo_no    TEXT NOT NULL,
  client_lpo_date  TEXT,
  partner_id       INTEGER NOT NULL REFERENCES partners(id),
  quotation_id     INTEGER REFERENCES sales_quotations(id),
  -- The client's enquiry that started it, carried onto the order so the
  -- delivery note and the tax invoice can take it from here.
  enquiry_id       INTEGER REFERENCES enquiries(id),
  application_id   INTEGER REFERENCES applications(id),
  project          TEXT,
  order_date       TEXT NOT NULL DEFAULT (date('now')),
  delivery_date    TEXT,
  /*
   * Who to ring, on each side of the order.
   *
   * The client's purchase officer settles a query about the order itself; the
   * site contact is who the driver rings when he is at the gate and nobody is
   * expecting him. They are different people, and a delivery note carrying
   * only one of them sends the driver back to the office.
   */
  purchase_officer        TEXT,
  purchase_officer_mobile TEXT,
  delivery_contact        TEXT,
  delivery_mobile         TEXT,
  delivery_location       TEXT,           -- 'Mirdif, Dubai' — where, in short
  delivery_address TEXT,
  payment_terms_id INTEGER REFERENCES payment_terms(id),
  currency         TEXT NOT NULL DEFAULT 'AED',
  subtotal         REAL NOT NULL DEFAULT 0,
  discount         REAL NOT NULL DEFAULT 0,
  vat_amount       REAL NOT NULL DEFAULT 0,
  total            REAL NOT NULL DEFAULT 0,
  advance_required REAL NOT NULL DEFAULT 0,   -- from the payment terms
  advance_received REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('confirmed','partial','delivered','invoiced','closed','cancelled')),
  notes            TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_so_partner ON sales_orders(partner_id);

CREATE TABLE IF NOT EXISTS sales_order_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  so_id          INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL DEFAULT 1,
  item_id        INTEGER REFERENCES items(id),
  item_code      TEXT,
  description    TEXT NOT NULL,
  application_id INTEGER REFERENCES applications(id),
  qty            REAL NOT NULL DEFAULT 0,
  uom            TEXT NOT NULL DEFAULT 'NOS',
  unit_price     REAL NOT NULL DEFAULT 0,
  cost_price     REAL NOT NULL DEFAULT 0,
  discount       REAL NOT NULL DEFAULT 0,
  taxable        REAL NOT NULL DEFAULT 0,
  vat_percent    REAL NOT NULL DEFAULT 5,
  vat_amount     REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL DEFAULT 0,
  delivered_qty  REAL NOT NULL DEFAULT 0,
  invoiced_qty   REAL NOT NULL DEFAULT 0,
  remarks        TEXT
);

CREATE TABLE IF NOT EXISTS delivery_notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id),
  dn_no          TEXT NOT NULL UNIQUE,
  so_id          INTEGER REFERENCES sales_orders(id),
  enquiry_id     INTEGER REFERENCES enquiries(id),
  partner_id     INTEGER NOT NULL REFERENCES partners(id),
  location_id    INTEGER REFERENCES locations(id),
  application_id INTEGER REFERENCES applications(id),
  delivery_date  TEXT NOT NULL DEFAULT (date('now')),
  delivery_address TEXT,
  vehicle_no     TEXT,
  driver_name    TEXT,
  received_by    TEXT,
  received_on    TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'delivered'
                   CHECK (status IN ('draft','delivered','acknowledged','cancelled')),
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS delivery_note_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dn_id       INTEGER NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
  so_item_id  INTEGER REFERENCES sales_order_items(id),
  item_id     INTEGER REFERENCES items(id),
  item_code   TEXT,
  description TEXT,
  qty         REAL NOT NULL DEFAULT 0,
  uom         TEXT NOT NULL DEFAULT 'NOS',
  remarks     TEXT
);

/*
 * The tax invoice. Everything the UAE requires on one is stored on the
 * invoice rather than looked up when it prints, so a reissued copy is the
 * document that was issued, not today's version of it.
 */
CREATE TABLE IF NOT EXISTS sales_invoices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  invoice_no       TEXT NOT NULL UNIQUE,
  partner_id       INTEGER NOT NULL REFERENCES partners(id),
  so_id            INTEGER REFERENCES sales_orders(id),
  dn_id            INTEGER REFERENCES delivery_notes(id),
  enquiry_id       INTEGER REFERENCES enquiries(id),
  application_id   INTEGER REFERENCES applications(id),
  project          TEXT,
  invoice_date     TEXT NOT NULL DEFAULT (date('now')),
  due_date         TEXT,
  payment_terms_id INTEGER REFERENCES payment_terms(id),
  currency         TEXT NOT NULL DEFAULT 'AED',
  -- Snapshotted at issue, because a tax invoice must reprint as it was issued.
  company_name     TEXT,
  company_trn      TEXT,
  company_address  TEXT,
  client_name      TEXT,
  client_trn       TEXT,
  client_address   TEXT,
  client_lpo_no    TEXT,
  place_of_supply  TEXT,
  subtotal         REAL NOT NULL DEFAULT 0,
  discount         REAL NOT NULL DEFAULT 0,
  vat_amount       REAL NOT NULL DEFAULT 0,   -- output tax
  total            REAL NOT NULL DEFAULT 0,
  paid_amount      REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'unpaid'
                     CHECK (status IN ('draft','unpaid','partial','paid','overdue','cancelled')),
  notes            TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sinv_partner ON sales_invoices(partner_id);

CREATE TABLE IF NOT EXISTS sales_invoice_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  line_no      INTEGER NOT NULL DEFAULT 1,
  item_id      INTEGER REFERENCES items(id),
  item_code    TEXT,
  description  TEXT NOT NULL,
  application_id INTEGER REFERENCES applications(id),
  qty          REAL NOT NULL DEFAULT 0,
  uom          TEXT NOT NULL DEFAULT 'NOS',
  unit_price   REAL NOT NULL DEFAULT 0,
  cost_price   REAL NOT NULL DEFAULT 0,
  discount     REAL NOT NULL DEFAULT 0,
  taxable      REAL NOT NULL DEFAULT 0,
  vat_percent  REAL NOT NULL DEFAULT 5,
  vat_amount   REAL NOT NULL DEFAULT 0,
  total        REAL NOT NULL DEFAULT 0
);

-- =============================================================================
-- MONEY — payments both ways, expenses, and the cheque book
-- =============================================================================

/*
 * One table for money in and money out, because a cheque is a cheque whichever
 * way it is written, and the cheque register has to show both.
 */
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id),
  payment_no    TEXT NOT NULL UNIQUE,
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  partner_id    INTEGER REFERENCES partners(id),
  -- An advance paid before any invoice exists still belongs to a job, so the
  -- voucher can name the enquiry itself. Where the payment settles invoices,
  -- their own enquiries are what the voucher prints.
  enquiry_id    INTEGER REFERENCES enquiries(id),
  payment_date  TEXT NOT NULL DEFAULT (date('now')),
  mode          TEXT NOT NULL DEFAULT 'bank_transfer'
                  CHECK (mode IN ('cash','cheque','bank_transfer','card','lc','adjustment')),
  amount        REAL NOT NULL DEFAULT 0,
  allocated     REAL NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'AED',
  reference     TEXT,
  bank_name     TEXT,
  cheque_no     TEXT,
  cheque_date   TEXT,                          -- post-dated cheques live here
  status        TEXT NOT NULL DEFAULT 'cleared'
                  CHECK (status IN ('pending','deposited','cleared','bounced','cancelled')),
  kind          TEXT NOT NULL DEFAULT 'settlement'
                  CHECK (kind IN ('advance','settlement','refund')),
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_partner ON payments(partner_id, direction);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id   INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_side TEXT NOT NULL CHECK (invoice_side IN ('sales','purchase')),
  invoice_id   INTEGER NOT NULL,
  amount       REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alloc_invoice ON payment_allocations(invoice_side, invoice_id);

/*
 * Everything the group spends that is not a supplier's invoice — rent, salaries,
 * fuel, trade licence, transport. Six companies' overheads in one book, each
 * row owned by the company that paid it.
 */
CREATE TABLE IF NOT EXISTS expense_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS expenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id),
  voucher_no    TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
  category_id   INTEGER REFERENCES expense_categories(id),
  partner_id    INTEGER REFERENCES partners(id),
  payee         TEXT,
  expense_date  TEXT NOT NULL DEFAULT (date('now')),
  description   TEXT NOT NULL,
  project       TEXT,
  amount        REAL NOT NULL DEFAULT 0,       -- net of VAT
  vat_amount    REAL NOT NULL DEFAULT 0,
  total         REAL NOT NULL DEFAULT 0,
  recoverable_vat INTEGER NOT NULL DEFAULT 1,
  mode          TEXT NOT NULL DEFAULT 'cash'
                  CHECK (mode IN ('cash','cheque','bank_transfer','card','petty_cash')),
  reference     TEXT,
  attachment_ref TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(company_id, expense_date);

-- =============================================================================
-- STOCK — one register, four buckets
-- =============================================================================
/*
 * Every movement is a signed quantity in one of three buckets:
 *
 *   ordered    material on an LPO we have placed and not yet received
 *   onhand     material in the yard
 *   committed  material a client's LPO has spoken for and not yet taken
 *
 * Free stock is on hand minus committed; what is coming is ordered. Keeping
 * movements rather than a running figure means the register can always show
 * its working — every receipt and every delivery, with the document that
 * caused it.
 */
CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id),
  item_id     INTEGER NOT NULL REFERENCES items(id),
  location_id INTEGER REFERENCES locations(id),
  bucket      TEXT NOT NULL CHECK (bucket IN ('ordered','onhand','committed')),
  kind        TEXT NOT NULL CHECK (kind IN
                ('lpo_placed','lpo_cancelled','goods_received','goods_returned',
                 'order_committed','order_cancelled','delivered','delivery_returned',
                 'adjustment','opening')),
  qty         REAL NOT NULL,                   -- signed
  rate        REAL NOT NULL DEFAULT 0,
  ref_type    TEXT,                            -- purchase_order, grn, sales_order, delivery_note
  ref_id      INTEGER,
  ref_no      TEXT,
  partner_id  INTEGER REFERENCES partners(id),
  moved_on    TEXT NOT NULL DEFAULT (date('now')),
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_item ON stock_movements(item_id, bucket);
CREATE INDEX IF NOT EXISTS idx_stock_ref ON stock_movements(ref_type, ref_id);

/*
 * The clauses that go at the foot of a document.
 *
 * The company's LPOs already carry a block of conditions, and they are not
 * boilerplate — they are what the buyer is relying on if a delivery is late,
 * a coating is thin or a certificate never arrives. Kept as separate clauses
 * rather than one lump of text so that the key account manager can edit a
 * point, add one, drop one for a particular order, or put them in a different
 * order, without retyping the rest.
 *
 * A clause may carry placeholders — {{supplier}}, {{lpo_no}}, {{authority}} —
 * which are filled in from the document itself. That is deliberate: the
 * conditions on a real LPO named a supplier who was not the one being ordered
 * from, because the block had been copied from another order.
 */
CREATE TABLE IF NOT EXISTS terms_clauses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type     TEXT NOT NULL CHECK (doc_type IN
                 ('purchase_order','sales_quotation','sales_order','sales_invoice')),
  clause_group TEXT,                          -- how the list is grouped on screen
  text         TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  -- Whether it is ticked when a new document is raised. A clause that applies
  -- to some orders and not others lives here unticked rather than being
  -- remembered by somebody.
  is_default   INTEGER NOT NULL DEFAULT 1,
  active       INTEGER NOT NULL DEFAULT 1,
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_terms_doc ON terms_clauses(doc_type, sort_order);

/*
 * How each kind of document is numbered.
 *
 * The company's references are not one shape: an LPO reads AKR-FD26-016 and a
 * sales order AKR-SO-082026-014. Both are already printed on paper suppliers
 * and clients hold, so the system follows them rather than the other way
 * round — and the pattern is a record here rather than a constant in the code,
 * so a series can be changed, or continued from a number already issued,
 * without a deployment.
 *
 * The serial itself still comes from the atomic counter, keyed by whatever
 * the reset rule makes a series: never, the year, or the month.
 */
CREATE TABLE IF NOT EXISTS document_series (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  doc_kind    TEXT NOT NULL,               -- purchaseOrder, salesOrder, ...
  pattern     TEXT NOT NULL,               -- '{company}-FD{yy}-{n:3}'
  reset_on    TEXT NOT NULL DEFAULT 'yearly'
                CHECK (reset_on IN ('never','yearly','monthly')),
  note        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, doc_kind)
);

/*
 * The paperwork behind a document.
 *
 * A client's LPO arrives as a PDF, and a year later somebody needs to see the
 * thing they actually signed — not our transcription of it. The file is kept
 * beside the database on the same volume, so a backup of one is a backup of
 * both, and the row here records what it is and who put it there.
 *
 * `stored_name` is generated, never the name the file arrived with: a filename
 * from outside is untrusted input, and it has no business deciding a path.
 */
CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   INTEGER REFERENCES companies(id),
  entity_type  TEXT NOT NULL,              -- sales_order, purchase_order, ...
  entity_id    INTEGER NOT NULL,
  kind         TEXT,                       -- 'Client LPO', 'Signed DN', ...
  filename     TEXT NOT NULL,              -- as it arrived, for display only
  stored_name  TEXT NOT NULL UNIQUE,       -- what it is called on disk
  mime         TEXT,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  uploaded_by  INTEGER REFERENCES users(id),
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);

-- Notifications: work arriving at somebody's desk.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT,
  title      TEXT NOT NULL,
  body       TEXT,
  route      TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);
