<div align="center">
  <img src="public/assets/logo.svg" alt="AKR General Trading L.L.C" width="380">
  <h1>AKR GENERAL TRADING L.L.C — Trading ERP</h1>
  <p><b>Trusted Trading Partner for Valves, Fittings &amp; Construction Materials</b></p>
  <p>Both sides of the trade, over one item master, one stock register and one set of books.</p>
</div>

---

Two sides, one system:

```
BUY   manufacturer's quotation → price confirmed → our LPO → goods received → their invoice → we pay
                                                      ↓
                                          ONE ITEM CODE · ONE STOCK REGISTER
                                                      ↓
SELL  our quotation → the client's LPO → delivery note → tax invoice → they pay
```

Every document carries the **application** it belongs to — potable water, storm water, sewerage,
district cooling or irrigation — and 5% UAE VAT. Payment terms are chosen per document from a list
the company keeps, and they decide the advance an order waits for, the cheque the driver collects at
the gate, and the due date on the invoice.

## Quick start

```bash
cd akr-erp
npm install
cp .env.example .env          # optional — the defaults work as they are
npm run setup                 # create the database and load the starter data
npm run demo                  # optional: write a worked example of the trade
npm start                     # → http://localhost:4000
```

Sign in with any of the desks below and the starter password **`akr@2026`**.

| Desk | Email | What they do |
|---|---|---|
| Administrator | `admin@akr365.com` | Everything, plus staff, companies, masters and the audit trail |
| Key Account Manager | `kam@akr365.com` | Supplier quotations, price confirmation, LPOs, client accounts, margins |
| Accounts | `accounts@akr365.com` | Invoices both ways, payments, cheques, expenses, VAT, the ledgers |
| Sales Officer | `sales@akr365.com` | Enquiries, quotations to clients, their LPOs. Prices, not costs |
| Logistics | `logistics@akr365.com` | Goods receipts, deliveries, the stock register. Quantities, not money |

> **Change every one of those passwords before this touches real trading data,** and set a real
> `SESSION_SECRET` and `COMPANY_TRN` in `.env`. A tax invoice without a TRN is not a valid one.

### Setting the company's own details

`COMPANY_TRN`, the address, the telephone and the bank details in `.env` are copied onto the default
company when the database is first seeded — and on every boot after that they fill in any field the
company has still left blank. So a TRN added to `.env` a week later still reaches the invoices; there
is no need to reseed. Anything already entered under **Masters → Companies** is never overwritten by
`.env`, because once a detail has been typed in the app it belongs to the company rather than to a
file on the server, and a stale `.env` must not be able to put an old TRN back on a live tax invoice.

The server says on start-up what is still missing:

```
  ▸ Company:     AKR GENERAL TRADING L.L.C
  ▸ TRN:         (not set)

  ⚠ A tax invoice still needs: TRN, bank details.
    Set them in .env and restart, or under Masters → Companies.
```

```bash
npm test          # 31 tests — the whole trade, both sides, and who may see what
npm run db:reset  # wipe and start again
npm run dev       # auto-restart on file changes
```

## The five applications

Everything the company trades is for one of five jobs, and that is a field on the item and a title on
every document:

**Potable Water** (PW) · **Storm Water** (SW) · **Sewerage** (SEW) · **District Cooling** (DC) ·
**Irrigation** (IRR)

A quotation, an LPO, a delivery note and a tax invoice each carry one, printed under the document
title, so a storm-water job and a potable-water job never share a sheet of paper by accident. A
document left blank takes its application from its lines when they all agree.

## The fourteen product lines, and the item code

| Code | Product line | Code | Product line |
|---|---|---|---|
| `VLP` | Valves — Potable Water | `MFO` | Misc. Fabrication — Other |
| `VLI` | Valves — Irrigation | `GRL` | GRP Ladders |
| `VLS` | Valves — Storm & Sewerage | `FST` | Fasteners |
| `VLD` | Valves — District Cooling | `MFP` | Mechanical Fittings — Potable Water |
| `GTP` | Geotextiles — Potable Water | `MFI` | Mechanical Fittings — Irrigation |
| `GTI` | Geotextile — Irrigation | `MFS` | Mechanical Fittings — Stormwater & Sewerage |
| `GTS` | Geotextile — Storm & Sewerage | | |
| `MFW` | Misc. Fabrication — Water | | |

The line is *in* the item code, so anyone reading an LPO, a delivery note or a rack label can tell
what the item is without looking it up:

```
AKR - VLP - 00001
 │     │      └── the serial within that line, counted from one
 │     └───────── the product line: a potable-water valve
 └─────────────── the group's prefix
```

The same code appears on the LPO to the manufacturer, on the quotation to the client, on the delivery
note and in the stock register. That is the whole point of it.

### Types within a line

Fabrication in particular is not one thing, so the type is its own field, sortable and countable:
**Strap · Air Vent · Handle Bar · C Clamp · MS Clamp · Spider Clamp · Gratings · Chequered Plate ·
Ladder · Protection Barrier · Extension Spindles · Others.** Valves, mechanical fittings, geotextiles,
GRP and fasteners have their own type lists, all editable under **Masters → Types**.

### Loading the company's own list

The catalogue already exists — on the website, in a price list, in somebody's workbook. **Item Master
→ Import a list** takes it as CSV: a row whose `item_code` is already here updates that item, a row
without one is created and given the next code in its line. There is a dry run that tells you what
would happen before anything does, and a template to download.

```
item_code,name,description,category_code,application_code,product_group,subgroup,brand,
mfr_part_no,material,size,pressure_class,standard,uom,hs_code,cost_price,sell_price,
vat_percent,reorder_level,lead_time_days
```

Only `name` and `category_code` are required. **Export CSV** gives the same columns back.

## The stock register

The register answers four questions about every item, and it is built from movements rather than a
running figure, so it can always show its working — every receipt and every delivery with the
document behind it.

| | What it means | What puts it there |
|---|---|---|
| **On order** | Bought and coming in | **Sending an LPO** to a manufacturer |
| **In the yard** | Received and on the shelf | A goods receipt note |
| **Committed** | Promised to a client | Recording the client's LPO |
| **Free** | In the yard, not promised | on hand − committed |

Sending an LPO is what puts material on order — a draft LPO is not a commitment and moves nothing.
Receiving takes it off "on order" and into the yard in one step. Delivering takes it out of the yard
and off the committed list. Cancelling an LPO or an order reverses exactly what it wrote.

**Receiving** and **Delivery** each have their own register tab, so "what came in this month" and
"what went out this month" are one click apart.

## Payment terms

Seventeen sets of terms ship with the system and any number can be added. One is chosen on every
quotation, LPO and invoice — and per supplier and per client as their default.

| | |
|---|---|
| `ADV100` 100% advance with order | `NET30` / `NET45` / `NET60` / `NET90` / `NET120` |
| `ADV50` 50% advance, 50% against delivery | `PDC30` / `PDC60` / `PDC90` post-dated cheque |
| `ADV30` 30% advance, balance 30 days | `RET10` 90 days with 10% retention |
| `CAD` cash against delivery | `LCSGT` letter of credit at sight |
| `CHQD` cheque against delivery | `LC90` letter of credit, 90 days |
| `NET0` payable on invoice | |

The terms are not decoration:

- **An advance is a gate.** An order on `ADV50` will not release for delivery until the advance is
  in — the logistics desk is stopped at the point of delivery, not discovered by accounts a week
  later. A manager can override it, and the override is recorded.
- **A cheque against delivery is printed on the delivery note**, so the driver does not come back
  without it.
- **The due date on an invoice is derived from the terms**, both ways, which is what the ageing and
  the payment run read.

## VAT

5% on both sides. Output tax on our tax invoices, input tax on the manufacturers' invoices and on
recoverable expenses, and **VAT & Profit** shows the return as the difference.

The tax invoice carries what the UAE requires — both TRNs, both addresses, the client's own LPO
number, the taxable value, the tax and the total, and the amount in words — and every one of those is
written onto the invoice when it is issued rather than looked up when it prints, so a reissued copy is
the document that was issued. **A tax invoice cannot be edited afterwards:** the correction for a
wrong one is a credit note and a fresh invoice, not a quiet edit of something the client has already
filed with their return.

## Six companies, one set of books

The group's companies each have their own TRN, their own document numbers and their own books:

```
AKR/LPO/2026/0042
 │   │    │    └── the serial, counted from one each January
 │   │    └─────── the year
 │   └──────────── the document type
 └──────────────── the company that issued it
```

**Expenses & Income** books the group's overheads — rent, salaries, visas, freight, transport, the
trade licence — against whichever company paid, and **VAT & Profit** gives each company's revenue,
cost of sales, gross margin and net, with the group total underneath. Rename the five placeholder
companies under **Masters → Companies**.

## What each desk sees

Money is not everybody's business, and the rule is enforced on the server, not just hidden on screen:

| | Prices | Cost & margin | The books |
|---|---|---|---|
| Administrator | ✓ | ✓ | ✓ |
| Key Account Manager | ✓ | ✓ | ✓ |
| Accounts | ✓ | ✓ | ✓ |
| Sales Officer | ✓ | — | — |
| Logistics | — | — | — |

A sales officer works to a price list and never sees what the manufacturer charged. A driver's
delivery note carries quantities and part numbers and no prices at all — a priced one in the wrong
hands tells a client's storeman what we paid.

## The documents it prints

A4, on the company's letterhead, with the application title under the document title:

| Document | Carries |
|---|---|
| **Quotation** | Lines, rates, VAT, validity, delivery, payment terms, terms & conditions |
| **Local Purchase Order** | Supplier, deliver-to, your-quotation reference, conditions of order, acknowledgement |
| **Delivery Note** | Quantities and part numbers, no prices; a signature block; a payment-on-delivery warning where the terms call for one |
| **Tax Invoice** | Both TRNs, the client's LPO, the delivery note, taxable value, 5% VAT, total, amount in words, bank details |
| **Receipt / Payment Voucher** | What was received or paid, against which invoices, cheque details |
| **Goods Receipt Note** | Accepted and rejected quantities, the supplier's own delivery note reference |
| **Statement of Account** | Every entry with a running balance, and the ageing underneath |

## How the code is laid out

```
akr-erp/
├── src/
│   ├── server.js              express app, routing, housekeeping
│   ├── config.js              .env, company details, VAT rate
│   ├── db/
│   │   ├── schema.sql         the whole schema, idempotent
│   │   └── seed.js            applications, product lines, terms, users, starter catalogue
│   ├── lib/                   http errors, validation, auth & who-sees-what, audit, id generation
│   ├── services/
│   │   ├── pricing.js         line arithmetic, VAT, amount in words
│   │   ├── terms.js           due dates, advances, release checks
│   │   ├── stock.js           the three buckets and the register
│   │   ├── documents.js       the parts every document shares
│   │   ├── settlement.js      matching money to invoices
│   │   └── ledger.js          ledgers, ageing, VAT return, profit
│   └── routes/                auth, masters, items, partners, purchase, sales, stock, accounts, reports, admin
├── public/
│   ├── js/doclines.js         the line editor every document form shares
│   ├── js/print.js            the printed documents
│   └── js/views/              one file per screen
└── tests/                     the trade, the desks, and the arithmetic
```

## The API, in short

Everything under `/api` needs a session except `/api/health` and `/api/auth/*`.

| | |
|---|---|
| `GET /api/masters/bootstrap` | every dropdown's contents in one call |
| `GET/POST /api/items`, `POST /api/items/import/csv` | the item master |
| `GET/POST /api/partners`, `/:id/ledger`, `/:id/statement` | suppliers and clients |
| `/api/purchase/quotations`, `/orders`, `/grns`, `/invoices` | the buy side |
| `/api/sales/enquiries`, `/quotations`, `/orders`, `/deliveries`, `/invoices` | the sell side |
| `/api/stock`, `/api/stock/items/:id`, `/receipts`, `/deliveries`, `/adjustments` | the register |
| `/api/accounts/payments`, `/cheques`, `/expenses`, `/ageing/:side`, `/vat-return`, `/profit-and-loss` | the books |
| `/api/reports/dashboard`, `/by-application`, `/top-partners`, `/item-movement` | the reports |

## Notes on the starter data

The catalogue that ships with this is **a starting point in the company's own shape — 154 items across
all fourteen lines — not the company's real price list.** It could not be taken from
[akr365.com](https://www.akr365.com/): that domain is blocked by the network policy this system was
built under, so nothing on it could be read. Load the real list over the top with **Item Master →
Import a list**; it matches on item code and updates rather than duplicating, so importing the real
catalogue replaces these prices without creating a second code for the same valve.

The suppliers and clients in the starter data are examples with plausible names, not real accounts.
Five of the six group companies are deliberately named as placeholders, because nobody should be
issuing an invoice under a company name this system invented.
