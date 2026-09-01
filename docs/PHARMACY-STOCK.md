# Pharmacy barcodes and the stock register

The pharmacy keeps a second set of books to the rest of the ERP. The clinical
side asks *what did this patient receive*; the stock register answers *what did
we buy, what is on the shelf, and does the shelf agree with the book*. This
document covers the barcode scheme, goods-received notes, the register itself
and the physical stock take.

Everything here lives under `/api/stock` (`src/routes/stock.js`) and appears as
four tabs on the **Pharmacy** screen: *Barcodes*, *Purchases*, *Stock register*
and *Stock take*.

## Barcodes

Two kinds of code identify a medicine, and the scan box accepts both without the
counter needing to know which is which.

| Code | Where it comes from | Held on |
|---|---|---|
| Manufacturer's EAN | Printed on the strip or carton | `drugs.barcode` |
| `28…` medicine label | Printed by us for a medicine with no pack code | `drugs.barcode` |
| `29…` batch label | Printed by us for one batch of one medicine | `drug_batches.barcode` |

Our own codes are 13 digits with a standard EAN-13 check digit, in the `2` range
that manufacturers never use — so a code we print can never collide with a code
on a pack. The check digit means an off-the-shelf scanner accepts them exactly
like a real EAN.

A **medicine label** answers *what is this*. A **batch label** additionally
answers *which delivery and which expiry*, which is what the counter needs when
two boxes of the same medicine expire months apart.

### Printing

`Pharmacy → Barcodes` lists every medicine with its code, and marks the ones
still without one:

- **Generate for every medicine missing one** assigns a `28…` code to each
  medicine that has none, then opens the label sheet so the whole formulary can
  be labelled in one pass.
- **Print** on a row prints labels for that medicine alone.
- Ticking rows and pressing **Print label sheet** prints just those.
- **Scan pack** links the manufacturer's EAN instead of printing our own — always
  prefer this when the pack already has a barcode.

The print dialog asks for *copies of each* and *labels across the page*: use 3
across for an A4 sheet of stickers, and 1 across for a roll label printer. The
browser's own print dialog is where the label printer is selected, so any printer
the computer can see will work — no driver or plug-in is needed.

Barcodes are drawn as inline SVG (`public/js/barcode.js`, Code 128-B), so they
stay sharp at any label size and print without loading anything from the network.

### Scanning

`GET /api/stock/scan?code=…` is the single lookup. It tries batch labels first,
then the drug's pack code, then the drug code typed by hand, and returns the
medicine, the batch when the code identified one, whether that batch has expired,
and the quantity on hand.

The same lookup backs three places in the interface:

- **Counter sale** — scanning drops the medicine straight onto the bill. An
  expired batch or an out-of-stock medicine is refused with the reason.
- **Stock take** — scanning a batch label jumps to that batch's count box.
- **Barcodes → Test a scan** — confirms what a sticker reads as, before it goes
  on the shelf.

A barcode gun types the digits and presses Enter, so Enter is the whole
interaction everywhere: no button to click, no field to choose.

## Suppliers and goods received

Every delivery is booked as a **goods-received note** (GRN) against a supplier.
`POST /api/stock/purchases` takes the supplier, their invoice number, and one
line per batch delivered. In a single transaction it:

1. creates or tops up the batch, including free strips that were not invoiced;
2. prints a `29…` barcode for the batch unless the line carried one;
3. posts a `purchase` movement to `stock_ledger`, naming the GRN;
4. updates the medicine's cost and MRP to the latest delivery;
5. links the pack barcode to the medicine when the line supplies one;
6. totals gross, line and invoice discounts, tax and net.

Stock that has already expired, or an expiry that is not a date, is refused at
goods-in rather than corrected later.

Supplier payments run through `POST /api/stock/purchases/:id/pay`, which moves
the note from `received` to `partially_paid` to `paid` and refuses to pay more
than the invoice. What is still owed to each supplier shows on the supplier list.

## The stock register

`GET /api/stock/register?from=&to=` returns, for every medicine:

```
opening + received − issued = closing
```

Opening is everything in the ledger before the period; received and issued are
the positive and negative movements inside it. `on_hand` is read from the batches
themselves, so a disagreement between `closing` and `on_hand` is visible rather
than hidden. The row also carries stock value at cost, and the quantity of
expired stock still sitting on the shelf.

**Movements** on a row opens the drill-down: every batch with its label, and
every movement — purchase, sale, return, adjustment, expiry, ward issue — with
the running balance, the note, and who did it.

**Write off expired** clears expired batches off the shelf and books the loss to
the ledger as an `expiry` movement, so the write-off is a recorded event rather
than a quiet edit.

## Stock take

`Pharmacy → Stock take` prints the book position for every batch with stock. The
counter enters what is physically there — or scans the batch label to jump to its
box — and any difference demands a reason before the count can be posted.

Posting adjusts the batch to the counted quantity and writes an `adjustment`
movement carrying the reason and the stock-take reference. Differences are never
absorbed silently: the ledger keeps both the count and the explanation, and past
counts are listed with how many differences each one found.

## Tables

| Table | Holds |
|---|---|
| `suppliers` | Distributors, their GSTIN, drug licence and credit terms |
| `stock_purchases` | One goods-received note: totals, payment status |
| `stock_purchase_items` | One line per batch delivered |
| `stock_takes` | One physical count |
| `stock_take_items` | Book vs counted quantity per batch, with the reason |
| `stock_ledger` | Every movement of every batch (shared with dispensing) |
| `drugs.barcode`, `drug_batches.barcode` | The scannable codes |

## Who can do what

Taking stock in, printing codes, adjusting and counting are **pharmacy** actions.
Scanning and reading the register are open to the counter roles — pharmacy,
doctor, nurse and cashier — because a doctor asking "do we have this in stock"
should not need the stock keeper. Reception is deliberately not on that list: the
front desk does not work the pharmacy counter. The administrator, as everywhere
in the ERP, passes every check.


# The pharmacy bill

The counter prints on an **80 mm thermal roll** (72 mm of it is printable), and
the bill it prints is a **GST tax invoice** — it has to satisfy two rulebooks at
once, and it carries what both ask for.

| Required by | On the bill |
|---|---|
| CGST Rules, r. 46 | "TAX INVOICE" heading; supplier name, address and **GSTIN**; a consecutive serial number and its date; the recipient; **HSN** per line; taxable value; the rate-wise **CGST/SGST** split; the total **in words**; **place of supply**; whether **reverse charge** applies; the supplier's signature block |
| Drugs & Cosmetics Rules | **Batch number** and **expiry** on every line; the **drug licence numbers**; the **registered pharmacist** who handed it over; the Schedule H notice when one is on the bill |

## MRP already contains the GST

This is the part worth reading twice. The MRP printed on a pack is the most a
patient may legally be charged, and it is **inclusive of GST**. So the tax is
extracted out of it:

```
taxable = MRP × qty × 100 / (100 + rate)
tax     = MRP × qty − taxable
```

₹2.20 × 10 strips at 12% is ₹22.00 to the patient: ₹19.64 taxable and ₹2.36 tax
— never ₹24.64. Adding GST on top of MRP would sell above MRP, which is an
offence, so the ERP does not do it. Intra-state, the tax splits into CGST and
SGST at half the rate each; the clinic's own state is the place of supply for
anyone who walks up to the counter.

Set `MRP_INCLUDES_GST=false` only if your prices are genuinely quoted before tax.

Counter bills round to the rupee (cash has no paisa) and **declare the round-off
on the invoice**. Dispensed prescriptions do not round: they go onto the visit
bill, which the cashier settles to the paisa.

## Printing

`Pharmacy → Bills → Print` on any bill, or straight after a counter sale or a
dispense. The browser's own print dialog is where the thermal printer is
selected, so any printer the computer can see works — no driver, no plug-in.

A bill **reprints exactly as it was issued**: the GST split is stored on each
line rather than recomputed, so changing a price today does not alter yesterday's
invoice.

## Before you issue real bills

These must be set, or the bill is not a valid tax invoice — the ERP prints it
but warns you every time:

```
PHARMACY_GSTIN=...
PHARMACY_DL_NUMBERS=...       # retail and wholesale drug licences
PHARMACIST_NAME=...
PHARMACIST_REG_NO=...
CLINIC_STATE / CLINIC_STATE_CODE
```

The pharmacy bills in its own name (`PHARMACY_NAME`, default *SAMIHA
PHARMACEUTICALS*) under its own logo, because a retail chemist is a separate GST
registration from the clinic.
