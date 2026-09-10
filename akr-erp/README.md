<div align="center">
  <img src="public/assets/logo.svg" alt="AKR General Trading L.L.C" width="380">
  <h1>AKR GENERAL TRADING L.L.C — Trading ERP</h1>
  <p><b>Trusted Trading Partner for Valves, Fittings &amp; Construction Materials</b></p>
  <p>Both sides of the trade, over one item master, one stock register and one set of books.</p>
</div>

---

Two sides, one system:

```
BUY   our enquiry → their quotation → price confirmed → our LPO → goods received → their invoice → we pay
                                                           ↓
                                               ONE ITEM CODE · ONE STOCK REGISTER
                                                           ↓
SELL  client's enquiry → our quotation → the client's LPO → delivery note → tax invoice → they pay
```

Both sides start with an **enquiry**, and it is the same screen read in two directions: on the sell
side it is what a client has asked us to price, on the buy side what we have asked a manufacturer to
price. **Its number is then on every document of that job, both sides** — quotation, LPO, goods
receipt, bill, delivery note, tax invoice and the voucher that settles it. **No supplier quotation exists without one** — the system refuses to log a maker's price that
does not answer an enquiry we raised, so there is always a record of what was asked, of whom and
when, including the makers who never came back.

The enquiry's reference then travels the whole way — onto their quotation, our LPO, the goods
receipt, the bill we file when their invoice arrives, and the voucher that pays it, so one number
ties the job together from the first phone call to the money leaving the bank. On **our LPO it prints** beside their own quotation number, so
the manufacturer holding the order can see what they priced and when they were asked:

```
LPO NO.        DATE           ATTN               SUPPLIER TRN
AKR-FD26-001   09 Sep 2026    Mr. Sankar         100xxxxxxxxxxxx
OUR ENQUIRY        YOUR QUOTATION      OUR QUOTATION REF     SO REFERENCE
AKR-RFQ-092026-001 GVM/Q/26/1188       AKR-SQ-092026-001     AKR-SO-092026-001
```

It prints on the goods receipt as well, and shows on the supplier's bill on screen. A receipt or a
bill entered with no order behind it can be given the enquiry directly, so nothing falls outside the
filing.

The **payment voucher** is the end of the chain rather than a link in it — one cheque can settle
three of a manufacturer's bills — so it carries the enquiry of each invoice it pays, line by line,
rather than one of its own:

```
AGAINST INVOICE       INVOICE DATE   OUR ENQUIRY          INVOICE TOTAL    APPLIED
AKR-BILL-092026-001   09 Sep 2026    AKR-RFQ-092026-001       24,633.00   24,633.00
```

On the selling side the same number is on the client's LPO, the **delivery note** and the **tax
invoice**, printed on both:

```
INVOICE NO.            INVOICE DATE   DUE DATE       CURRENCY
AKR-INV-092026-001     09 Sep 2026    09 Sep 2026    AED
ENQUIRY REF.           OUR ORDER
AKR-ENQ-092026-001     AKR-SO-092026-001
```

An **advance** has no invoice behind it yet, so the voucher can be told which enquiry it belongs to
when it is written. An advance is also no longer applied automatically to the oldest open bill:
money paid ahead for a named job is not a round figure against the account, and swallowing it into
an older invoice is how an advance stops being one. A receipt from a client reaches the same way
back to **their** enquiry, through the order and the quotation.

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

### The company's own mark

Upload it once under **Masters → Logo** and it is everywhere: the sidebar, the sign-in page, the
letterhead on every printed document, the watermark behind them, and the browser tab. There are two
slots — the badge on its own and the badge with the wordmark — and **either stands in for the other**,
so one upload is enough. Replacing it changes every one of those at once, because the URL carries a
fingerprint of the file.

It is uploaded rather than committed on purpose: a logo is a fact about the company, like its address
or its TRN. **With nothing uploaded the placeholder is plain type — `AKR / LOGO NOT SET` — not a
drawing of anybody's mark.** An earlier version of this system shipped an approximation of the
company's own logo, which is the one thing it must never do: an approximation printed as though it
were the logo is worse than no logo at all.

**Paste it, or drop it.** The artwork is usually already in somebody's hand — in a message, on the
website, in a letterhead they have open. Copy it, click the box on the Logo tab and press Ctrl+V;
a file dragged onto the box works too. Finding the file and picking it out of a dialog on a phone is
the step where this most often fails.

**With nothing uploaded, a printed document carries no logo at all** — not a placeholder. It goes to
a client, and the company's name, address and TRN are already on it in type; a box announcing that
the logo is missing is worse than a letterhead without one. The watermark is skipped too.

**Or take it from the company's own website.** Paste `https://www.akr365.com/` into the Logo tab and
the server fetches it: given a site it looks for the artwork the way a browser would — the
social-sharing image the site declares for itself, then the touch icon, then an image that calls
itself a logo — and given the address of a picture it takes that. The bytes are checked before
anything is kept, so a page that serves an error under an image's name is refused. It is the server
that fetches, because it is the one with a plain route to the internet.

**Uploaded artwork lives where the database lives.** With a volume mounted it survives a deploy;
without one it is written inside the container Railway replaces on each deploy, so a logo uploaded
on Monday is the placeholder again on Tuesday. The Logo tab says so in red when that is the case,
and `/api/health` reports `uploads: volume | ephemeral`.

Two things decide whether it *looks* right:

- **It is never stretched.** Every place that draws it contains the artwork at its own proportions —
  a tall badge and a wide lock-up both come out as themselves rather than squashed into a square.
- **The plate.** Artwork with a transparent background needs a light plate behind it or it
  disappears into the dark sidebar; artwork that carries its own background looks like a sticker on
  one. The switch is on the Logo tab: **Put a light plate behind it** — leave it on for a transparent
  PNG or SVG, turn it off for artwork with its own background.

The Logo tab says what it is holding — **PNG · 42 KB · 400 × 420**, or **vector, sharp at any size**
— and warns when a raster file is under 480 pixels on its longer side, which is about 20 mm on an A4
letterhead. It reads that from the file's own header; no image library, and none needed.

Two things to ask whoever drew the logo for, and only they can supply:

- **The SVG.** A drawing rather than a grid of pixels: sharp at 44 pixels in the sidebar and at full
  size on a letterhead alike.
- **A transparent background.** Artwork with a solid background of its own prints as a coloured
  tile on white paper. The plate switch fixes how it sits on the dark screens; nothing can fix it on
  paper afterwards.

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
npm test          # 52 tests — the trade both sides, the desks, the conditions and the references
npm run db:reset  # wipe and start again
npm run dev       # auto-restart on file changes
```

## Putting it on Railway

The app is a plain Node service: it listens on `PORT`, serves its own front end, and answers
`GET /api/health`. It ships a **Dockerfile**, and `railway.json` points at it, so the build that runs
on the platform is the build that was tested here rather than one the platform infers.

That is not fussiness. The one dependency that matters is native: `better-sqlite3` is compiled from
C++ whenever no prebuilt binary is published for the platform's exact Node version. A builder left to
guess the Node version from an open-ended `engines` range can land on one with no prebuild, and then
fail at the compile because its image carries no toolchain. The Dockerfile pins Node 20 and installs
`python3`, `make` and `g++`, so neither can happen.

**Mount a volume first.** The database is a single SQLite file. A container platform rebuilds the
application directory on every deploy, so a database inside it is destroyed each time you ship a
change — with every invoice, payment and stock movement in it.

1. Create the service from this repository.
2. **Add a volume, mounted at `/data`.** The app reads `RAILWAY_VOLUME_MOUNT_PATH` and puts the
   database there by itself; nothing else to configure. Without one it starts anyway and says, in a
   box you cannot miss, that the books will not survive the next deploy.
3. Set the variables:

```
NODE_ENV=production
SESSION_SECRET=<a long random string — never the default>
COMPANY_TRN=105279558800003
COMPANY_BANK= COMPANY_ACCOUNT= COMPANY_IBAN= COMPANY_SWIFT=
AUTO_SEED=true          # leave true for the first deploy, then set it to false
```

4. Deploy, then check the volume actually took:

```
curl https://<your-app>.up.railway.app/api/health
{"ok":true,"storage":"volume",...}      ← the books will survive a deploy
{"ok":true,"storage":"ephemeral",...}   ← they will not; the volume is not mounted
```

5. Open the URL, sign in as `admin@akr365.com` / `akr@2026`, **and change every password.**
6. Set `AUTO_SEED=false` once the real data is in, so a wiped database is never quietly refilled
   with the sample catalogue.

`PORT` is set by the platform. `DB_FILE` overrides the location if you ever want it somewhere other
than the volume.

### If the build fails

- **"Failed to fetch repository files"** — the platform is looking at a repository with nothing in
  it, or at one its GitHub App cannot read. Check the repository has a commit on its default branch,
  and that the GitHub App has been granted access (**Configure GitHub App**, then **Refresh**).
- **`gyp ERR!` / `find Python` / `prebuild-install warn ... no prebuilt binaries`** — the builder is
  compiling `better-sqlite3` without a toolchain, or on a Node version with no prebuild. The
  Dockerfile exists to prevent both; make sure the service is set to build from it rather than from
  an inferred build.
- **"npm ci can only install packages when your package.json and package-lock.json are in sync"** —
  someone edited `package.json` without regenerating the lockfile. `npm install --package-lock-only`
  and commit the result. The lockfile records the `engines` range too, so even a Node-version change
  de-synchronises it.

## Attachments

The client's LPO arrives as a PDF, and a year later somebody needs to see **the document they
actually signed**, not our transcription of it. So it is kept: on the **Client LPOs** screen, drop
the file onto the form as the order is recorded, or onto the order afterwards, and it opens in a tab
from then on.

Files live beside the database on the same volume, so one backup covers both. PDF, image, Word or
Excel, up to 12 MB. What a file *is* is decided by its bytes, not by its name — a shell script called
`invoice.pdf` is refused — and the stored name is generated here, because a filename from outside has
no business deciding a path.

The same mechanism is available on quotations, LPOs, goods receipts, invoices, payments and expenses;
the desk that owns the document is the desk that may attach to it, and everyone who can see the
document can read what is filed against it.

### Who to ring

A client's LPO carries two different people, and a delivery note with only one of them sends the
driver back to the office:

| | |
|---|---|
| **Purchase officer** + mobile | settles a query about the order itself |
| **Site contact** + mobile, and the **delivery location** | who the driver rings at the gate |

The site contact and the location print on the delivery note, which is what the driver has in his
hand.

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

## Document references

Every document carries a reference from its own series, so any of them can be found and followed
years later. The shapes are **the company's own**, because they are already printed on paper that
suppliers and clients hold:

```
AKR-FD26-016                     AKR-SO-082026-014
 │   │  │   └── serial, from 1    │   │    │     └── serial, from 1 each month
 │   │  │       each January      │   │    └──────── month and year
 │   │  └────── year              │   └───────────── document type
 │   └───────── FD — Fabrication  └───────────────── company
 │              Division
 └───────────── company
```

**Every series that carries a month counts within it** — fourteen of the fifteen. A number that
names a month but counts through the year invites the reader to work out which of the two it means.

The LPO is the exception, and not an oversight: its reference names the year and no month, so
counting within the month would give January's first order and February's the same number. The
system refuses that combination rather than leaving it to be found by whoever ends up holding both
pieces of paper — a serial may only restart on something the reference actually says:

```
{company}-FD{yy}-{n:3}      restarting monthly   →  refused: the pattern names no month
{company}-QT-{mm}-{n:3}     restarting monthly   →  refused: August 2026 and August 2027 collide
{company}-DN-{n:4}          restarting yearly    →  refused: the pattern names no year
```

The meaning of `FD` is recorded against the series, so nobody has to ask what it stands for.

Everything else is numbered in the same family — `AKR-ENQ-082026-002` for a client's enquiry and
`AKR-RFQ-082026-007` for one we send a maker, then `AKR-QT-082026-004`, `AKR-DN-082026-011`,
`AKR-INV-082026-009`, `AKR-GRN-082026-003`, `AKR-RV-082026-021`.

The patterns are records, not constants: **Masters → Document numbers** shows every series with the
next reference it will issue, and an administrator can change the shape or **continue a series from a
number already issued** — which is what matters when the books move onto this system halfway through
a year. A pattern is built from `{company}`, `{type}`, `{yy}`, `{yyyy}`, `{mm}`, `{mmyyyy}`,
`{yyyymm}` and `{n:3}`; anything else prints as it stands, which is how the literal `FD` survives.

A serial only ever moves forward. Winding one back would hand out a reference that is already on a
document somebody is holding, and two documents with one number is precisely what a reference exists
to prevent.

### Following one

**Trace a Reference** takes any document number — ours or theirs — and lays out the whole chain,
oldest first:

```
08 Sep 2026   Client enquiry        AKR-ENQ-092026-001
08 Sep 2026   Our quotation         AKR-QT-092026-001     31,550.40
08 Sep 2026   Client's LPO          AKR-SO-092026-001     31,550.40   their LPO ASC/LPO/2026/0912
08 Sep 2026   Delivered             AKR-DN-092026-001
08 Sep 2026   Tax invoice           AKR-INV-092026-001    31,550.40
08 Sep 2026   They paid             AKR-RV-092026-001     31,550.40   cheque 004521
```

It works from either end and from either side — search our LPO and you get the enquiry we raised,
the supplier's quotation, the goods receipt and their invoice; search the client's own LPO number, or a supplier's own invoice
number, and it finds those too. Part of a number offers the candidates rather than guessing.

## Terms & conditions

The conditions at the foot of an LPO are not boilerplate — they are what the buyer is relying on when
a delivery is late, a coating is thin or a certificate never arrives. They are kept as a library of
separate points under **Masters → Terms & conditions**, which the **key account manager** keeps (not
only an administrator: they are the ones who find out the hard way which condition was missing).

The library ships with the thirty-odd points the company already prints, taken from its own LPO
AKR-FD26-016 — approved drawings, written confirmation before production, SAT/FAT inspection, coating
thickness, MTC on delivery, individual packing, wooden pallets, original DN and tax invoice to the
office — together with the protections that block left open: late-delivery back-charges, warranty,
what makes an invoice payable, no substitution without approval, sub-contracting, confidentiality,
cancellation and governing law.

**Every point is editable, and each one is ticked or unticked on the order it applies to.** Points
that only apply to some jobs (coating thickness, chemical analysis, site HSE) start unticked.

### Placeholders

A clause may name the supplier, the company, the order or the authority through a placeholder, which
the document fills in when it is raised:

```
{{company}}  {{supplier}}  {{client}}  {{lpo_no}}  {{doc_no}}
{{project}}  {{authority}}  {{delivery_date}}  {{payment_terms}}  {{application}}
```

This is not decoration. The conditions on a real LPO named a manufacturer who was not the one being
ordered from, because the block had been copied across from another order. A name that comes from the
order cannot be copied wrong — and if the supplier on the form is changed, the app offers to rebuild
the conditions rather than leaving the old name in them.

### What changes what

| | |
|---|---|
| Editing a point in the library | Changes the **next** document raised |
| Editing an order's own conditions | Changes **that order only**, and is written to the audit trail with what it said before |
| Retiring a point | Stops it appearing on new documents; it stays exactly as it was on every order already issued with it |

An order's conditions can be changed until the goods are received; after that they are fixed. On an
LPO already sent, the app says plainly that the supplier is working to the copy they have and the
amended one needs to go to them as well.

Quotations to clients draw on the same library, under their own document type.

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

The same page reads the two sides by name. **Revenue, client by client** — invoiced, VAT charged,
the cost of those particular goods and the margin on them, for every trading client. **What each
manufacturer cost us** — what they billed us for material in the period, what was booked against
their account as an expense, and the two together. Every account is listed, including the ones that
did nothing this period, and each table folds down to the ones that traded.

### Whose expense is it

Every expense is booked to somebody: a **manufacturer's** account (inspection at their works,
freight in), a **client's** account (a site visit, testing for their job), or to nobody — AKR's own
overheads: rent, salaries, the trade licence. The picker on the expense form says so in those words,
and the expense list can be filtered by the account carrying it.

The general overheads are then **spread across the accounts pro rata**, on what each client was
invoiced and on what each manufacturer billed us, so a per-account figure means something. The
tables show it either way: as entered — the pot as its own row — or spread, one link either way.
The shares always come to the pot exactly; where there is nothing to apportion on, nothing is
spread and the pot stays visible rather than being shared out on a basis that does not exist.

### The bottom line

The page closes with the arithmetic the owner reads, in that order:

```
  Selling price                    invoiced to clients, before VAT      30,048.00
− Buying price                     what those goods cost us           − 23,460.00
− Buying overhead expenses         booked to a manufacturer            − 1,500.00
− Selling overhead expenses        booked to a client                  −   600.00
− AKR general overheads            rent, salaries, the licence         − 9,850.00
= Gross profit                                                         − 5,362.00
− VAT payable to the FTA           output tax less input tax           −   286.90
= Net profit                                                           − 5,648.90
```

**Other income — a rebate, a scrap sale — is not on this page**, because the page is what the trade
made. It is still on the books, in Expenses & Income, and where there is any in the period the month
table says so in a line underneath rather than letting it go unmentioned.

The VAT line is the owner's own reading, and worth saying plainly: the net payable is money
collected from clients and handed to the FTA rather than a cost of the trade, so an accountant would
stop at the gross profit above it. Both figures are on the card, so either reading is one line away.

Two figures on that page are deliberately not the same, and both are right: **cost of sales** is
what the goods *invoiced to clients* cost, whenever they were bought; **billed us** is what the
makers invoiced *in this period*, whenever those goods are sold. Where the yard fills or empties,
the difference between them is stock. Overheads booked to no supplier are shown as their own row
rather than left out, so the expenses column still comes to the group's.

## Who may open what

A desk sets what somebody starts with; the administrator changes it person by person, under
**Staff → what they can open**. Tick the screens that suit them — the sales officer who also follows
the buying side, the accounts clerk trusted with the profit page — and *Back to the desk's default*
undoes the lot.

The rule underneath, and the reason this is safe to hand out:

> **A screen grant says what somebody may OPEN and READ. Their desk still says what they may DO.**

Give a sales officer Payments & Receipts and they can see what has been received; they still cannot
book a receipt, because that is gated on the accounts desk where the route is written. Give somebody
Staff and they can read the list; creating an account and changing anybody's access stays with the
administrator, or granting Staff would be granting everything. My Account can never be taken away —
somebody who cannot change their own password has no way back in.

Only the difference from the desk's default is stored, so changing what a desk gives still reaches
everybody left on it. What the app hides, the server refuses: the menu, the routing and the API all
read the same list.

The **sales desk carries both sides of the trade** by default — enquiries, quotations, client LPOs,
deliveries and invoices, and the buying screens down to goods receipts. The money screens (bills,
payments, cheques, ledgers, VAT) stay with the desks that answer for them until the administrator
says otherwise.

## What each desk sees

Money is not everybody's business, and the rule is enforced on the server, not just hidden on screen:

| | Prices | Cost & margin | Rate builder | The books | VAT & profit |
|---|---|---|---|---|---|
| Administrator | ✓ | ✓ | ✓ | ✓ | ✓ |
| Key Account Manager | ✓ | ✓ | ✓ | ✓ | — |
| Accounts | ✓ | ✓ | — | ✓ | — |
| Sales Officer | ✓ | ✓ | ✓ | — | — |
| Logistics | — | — | — | — | — |

The sales officer prices the work, so they see the buying rate behind it — a rate cannot be set by
somebody who may not see what the goods cost. Logistics still work in quantities: a driver's copy of
an order carries no cost at all.

### What a job costs

Shown to the **sales officer, the key account manager and the administrator** — the desks that price
the work. A client's LPO carries the answer to the question the desk actually asks — *we are selling this at
that rate; what are we paying, and what has gone out on top?*

```
  Selling price          before VAT                               30,048.00
− Buying price           the buying rate on these lines          − 23,460.00
− Expenses on this job   1 booked to it or to this client        −    600.00
= Margin                 19.93% of the selling price               5,988.00
```

Beside it: what has been **ordered from the makers** against this order and what they have
**billed us**, so the buying price allowed for can be compared with what is actually being paid.
An expense is booked *against the job* — the enquiry — as well as to an account, which is what puts
freight on this order and an inspection on that one instead of in a monthly heap.

**None of it prints.** The client's paperwork shows what they are charged and nothing behind it;
there is a test that fails if a printed document ever mentions cost, the rate build-up or the job
cost.

A sales officer works to a price list and never sees what the manufacturer charged. A driver's
delivery note carries quantities and part numbers and no prices at all — a priced one in the wrong
hands tells a client's storeman what we paid. **VAT & Profit is the administrator's alone** — what
the business made and what it owes the FTA are not part of running a desk.

### Profit, month by month

The company books a month's overheads in one sitting at the end of it, so the profit is read a month
at a time, with the month's expenses taken off before the gross profit at the end of the row:

```
             Invoiced    Cost of goods    Margin on goods    Expenses this month    Gross profit
Sep 2026    30,048.00     − 23,460.00           6,588.00              − 850.00        5,738.00
```

The margin on the goods is what the trade itself made; the gross profit is what is left of it after
that month's overheads — the figure the company works to. (The group summary underneath the months
uses the same two words for the same two things.)

An expense counts in the month it is dated, whichever month the trade it paid for happened in —
which is how it is entered and how the bank sees it. A month showing sales but no expenses is
flagged as one somebody has not finished entering, rather than being read as an unusually good
month.

## Building a rate

A rate quoted to a client is not the manufacturer's price. It is that price plus what it costs to
land the material, and then the margin. On a quotation line, **build the rate** opens the working:

```
  Manufacturer's material rate                        500.00 per unit
+ Sea cargo             lump sum for the line   1,200.00  →  120.00
+ Custom duty           % of the material rate         5  →   25.00
+ Risk charge           % of the running total         2  →   12.90
+ Bank charge           % of the running total       1.5  →    9.87
+ Inland transport      amount per unit               12  →   12.00
= Landed cost, per unit                             679.77
+ Profit @ 15%                                      101.97
= Rate to quote                                     781.74      margin 13.04%
```

The four ways a charge can be reckoned are there because they are not reckoned the same way: duty is
a percentage of the material's value, a bank charge a percentage of the running total, sea freight a
lump sum for the shipment, inland transport so much a piece. **The order matters** — a charge on the
running total counts everything listed above it. Add whatever else a job carries with *+ Add a
charge*; the six above are only the ones this trade meets most often.

*Use this rate* puts the rate on the line and the landed cost behind it, so the margin on the
quotation is read against what the goods will actually have cost. The working is kept on the line,
comes through a revision, and is **worked out again when it is read** rather than stored as an
answer.

**None of it is printed.** The client's quotation shows the rate and nothing behind it — which is
what lets the build-up hold what it holds.

It belongs to the desks that price the work: the **sales officer**, the **key account manager** and
the **administrator**. Accounts book what was agreed rather than set it, and logistics never see
money at all, so neither gets the builder or the working behind a quoted rate — the server refuses
both, not just the screen. The sales officer is the one deliberate exception to the rule that they
never see cost: this is their own working on their own quotation.

## The documents it prints

A4, on the company's letterhead, with the application title under the document title:

| Document | Carries |
|---|---|
| **Quotation** | Lines, rates, VAT, validity, delivery, payment terms, terms & conditions |
| **Local Purchase Order** | Supplier and their TRN, attention, incoterms, deliver-to, **our enquiry**, their own quotation number and ours, the SO reference, approving authority, amount in words, the numbered conditions, buyer details, acknowledgement |
| **Delivery Note** | Quantities and part numbers, no prices; **the enquiry** and our order; a signature block; a payment-on-delivery warning where the terms call for one |
| **Tax Invoice** | Both TRNs, the client's LPO, **the enquiry**, our order, the delivery note, taxable value, 5% VAT, total, amount in words, bank details |
| **Receipt / Payment Voucher** | What was received or paid, against which invoices and **under which enquiry**, cheque details |
| **Goods Receipt Note** | Accepted and rejected quantities, the supplier's own delivery note reference, **our enquiry** and our LPO |
| **Statement of Account** | Every entry with a running balance, and the ageing underneath |

## How it looks

Dark blue for structure, dark green for what to act on, white for the paper — the three colours of
the company's own mark. Amber and red survive in one place only: a state the reader must not miss. An
overdue invoice and a bounced cheque have to look different from everything else, and green on green
would hide them.

The falcon is ghosted behind every printed page at four to five per cent — enough to tint the paper,
not enough to compete with a line of text, and repeated on each sheet of a document that runs long.

**Upload the company's own artwork under Masters → Logo.** A logo is a fact about the company, not
source code, so it is stored beside the database rather than committed and deployed: whatever is
uploaded goes on the sidebar, the sign-in page, the head of every printed document and the watermark
behind them, at once and with no redeploy. SVG is sharpest; a PNG with a transparent background works
just as well. The drawn placeholder in `public/assets` is only what shows until then.

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
│   │   ├── clauses.js         the terms & conditions library
│   │   ├── enquiries.js       the enquiry, on both sides of the trade
│   │   ├── numbering.js       the company's own reference shapes
│   │   ├── trace.js           following a reference through the chain
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
| `/api/purchase/enquiries`, `/quotations`, `/orders`, `/grns`, `/invoices` | the buy side |
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
