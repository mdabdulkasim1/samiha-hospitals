# Learning the system on one patient

The fastest way to understand this ERP is to follow one patient through it. This
walks Mohamed Kasim — 54, diabetic, sugars high — from the phone call that
brought him in to the medicines he walks out with.

Run it against a seeded server and it does the whole thing for real:

```bash
npm run setup          # once: schema and seed data
npm start              # the server, on :3000
npm run demo           # in another terminal
```

It prints each step, who did it and which screen to look at. Sign in as each
person named (password `samiha@123`) and search the UHID it gives you at the
end. Run it twice and you get a second patient, not an error.

---

## The lanes

```
front desk  →  nurse station  →  doctor  →  lab (if anything was ordered)
            →  cash counter   →  pharmacy
```

Each lane hands the patient to the next. Nobody has to remember to move them
along: signing a consultation sends them to the lab, verifying the last report
sends them to the cashier, and checking out releases them.

The pharmacy is the exception, and deliberately so. It is the last lane but it
is not a gate: it raises its own bill and takes its own money, so a patient who
does not want their medicines today can go home and come back for them.

---

## 1 · Front desk — the enquiry

*reception@samiha.local · Enquiries*

He rings up. The desk raises an enquiry and a file opens at **enquiry stage** —
a lead, not a patient. Nothing has been charged and nothing promised.

## 2 · Front desk — registration

*Patients → the enquiry → Register*

Name, age, phone, address and Aadhaar. The same row is promoted to a registered
patient and gets a UHID, so the record runs unbroken from the first phone call.
The enquiry is marked converted, not deleted.

Aadhaar prints on the prescription and the lab report, so what the patient
carries out matches what the record holds.

## 3 · Front desk — appointment and arrival

*Appointments, then Queue → Arrived*

Booked with a token, or taken as a walk-in. Either way a **visit** opens.

From this moment the cashier can see him on **Billing → Today's collections**
with no bill yet, so the counter knows there is money still to come.

## 4 · Nurse station

*nurse@samiha.local · Nurse Station*

Every reading is taken here, with the normal range printed beside each box:

| | |
|---|---|
| Blood pressure | under 120/80 mmHg |
| Pulse | 60–100 bpm |
| Respiratory rate | 12–20 /min |
| Temperature | 36.1–37.2 °C |
| SpO₂ | 95–100 % |
| Height, weight | BMI is worked out for you |
| Blood sugar | fasting 70–100 mg/dL |
| Pain score | 0–10 |

Anything outside range is flagged on the screen for escalation. BMI uses the
Indian cut-offs — overweight at 23, obese at 25 — not the WHO ones, and height,
weight and BMI follow him onto the prescription and the lab report.

The station also takes walk-ins: search a patient by name, UHID or mobile and
record readings without a visit.

## 5 · Doctor

*imran@samiha.local · My Clinic → the patient*

Notes, then two things raised on their own:

- **A coded diagnosis.** E11.65 *Type 2 diabetes mellitus with hyperglycaemia*
  as primary, I10 *hypertension* as secondary. The wording is copied onto the
  sheet, so revising a code later never rewrites a prescription already in a
  patient's hand.
- **Diagnostics.** HbA1c, fasting sugar, lipids, creatinine, urine routine.
- **A prescription**, with dose, duration, advice and a review date.

Signing sends him to the lab. Had nothing been ordered he would have gone
straight to the cashier.

## 6 · Lab

*lab@samiha.local · Laboratory*

Collect the sample, enter the results, verify the report. Out-of-range values
are flagged on the printed report against the reference range.

Verifying the **last** open order moves the patient on to the cashier by itself.

## 7 · Cash counter

*cashier@samiha.local · Billing → Today's collections → Collect*

**Assemble bill** pulls the consultation and every diagnostic onto one bill.
Anything else the patient had — a dressing, an injection, a counter sugar check
— goes on by pressing it on the charge board: groups across the top, items
below, each with the rate management set under **Services & Rates**. Nothing is
typed in, so the same dressing costs the same whoever bills it.

Then a **discount** if one is being given — rupees off or a percentage, with a
reason recorded — and the money, by cash, UPI, card or anything else. Print the
tax invoice and hand it over.

**Medicines are not on this bill.** An out-patient pays for those at the
pharmacy.

**Complete check-out** issues the exit pass. An uncollected prescription does
not hold it up; the desk is told what is still to collect.

### A bill with no visit behind it

Somebody walks in for a dressing, or comes back for a report they paid for.
**Billing → + New bill**: search the patient, and the same charge board opens
against a fresh bill. Add, remove, discount, collect, print. It is the same
screen an invoice opens in, so any bill in the list can be picked up and worked
on.

## 8 · Pharmacy

*pharmacy@samiha.local · Pharmacy → To dispense*

The prescription is already there, with the patient, the doctor and the
diagnosis. It stays there after check-out — if he goes home and comes back on
Thursday, it is still waiting, with how many days it has been waiting shown
against it.

Before anything is handed over there is a step a new clinic meets once. The
shelf comes stocked from the starter list, but nothing on it is priced — an MRP
is printed on the pack that arrives, and the system will not guess one. So the
counter refuses an unpriced medicine by name, and **Pharmacy → Opening stock →
No rate set** is where the prices go in. It saves on its own: the counts stay
as they are.

Then: tick what is being handed over, give a discount if any, take the money.
Stock comes off oldest-expiry-first and the batch's own MRP is what is charged. MRP
already includes GST, so tax is *extracted* from the price and never added on
top; the discount is apportioned across the lines before the tax is worked out,
as §15(3)(a) of the CGST Act requires.

The bill is the pharmacy's own and is settled at this counter, with its own
receipt. The one exception is an in-patient: their medicines go onto the
admission's running bill and are settled once, at discharge.

If the patient is buying elsewhere, **Not here** records why. The record
survives either way — a prescription is never silently dropped.

---

## What the demo leaves behind

An enquiry, a patient, a visit, a lab order, a prescription and two bills — the
hospital's and the pharmacy's — all searchable by the UHID it prints. Open each
screen in turn and the whole chain is there to read.
