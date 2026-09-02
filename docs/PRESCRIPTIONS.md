# Prescriptions and the patient chart

## Writing a prescription

A doctor signs in and writes from **My Clinic** — either straight off their
patient list (**℞ Prescribe** on the row) or from **℞ Write a prescription**,
which searches their own patients: anyone booked with them, seen by them, or
prescribed for by them before. A doctor never searches the whole register.

Medicines come from the pharmacy's **own formulary**, with live stock shown as
you type, so what is written is what the counter can actually hand over. Each
line takes dose, frequency, route, duration and instructions; the quantity is
worked out from frequency × duration and can be overridden.

**Allergies are checked before anything is saved**, by name, by generic name and
by **drug class** — a patient whose file says "penicillin" is stopped from being
given amoxicillin, because that is how allergies are actually recorded and it is
the one that matters most at an OPD counter. The classes are listed in
`src/services/pharmacy.js`; extend them with whatever your own patients react
to. The prescriber can override deliberately, and the override is kept with the
prescription.

### With a visit, or without one

| | What happens |
|---|---|
| Written against a **visit** | Lines are `pending` and appear in the pharmacy queue — the counter dispenses without re-typing anything. |
| Written **without a visit** | Lines are `external` — a paper prescription the patient can take to any chemist, ours included (the Rx number goes in the counter sale's prescription field). |

## The printed sheet

A5, portrait — the size prescription pads are cut to.

**What is on it:** the polyclinic's name and address, the patient's name, age,
sex, UHID and date, the prescription number, the complaints, findings and
diagnosis, the ℞ and the medicines, the advice and the review date, and a blank
box at the bottom.

**What is deliberately not on it:** any doctor's name, qualification,
registration number, room or contact detail. A prescription leaves the building;
nothing on it should let a patient reach a doctor directly, or identify who they
saw beyond what they already know.

**The doctor stamps and signs it by hand** after it comes off the printer — the
blank box is left for exactly that. That signature is what makes the sheet
theirs, not anything the ERP prints.

**The doctor code** is printed beside the prescription number. It means nothing
to a patient and everything to the clinic: management and the doctor can trace
any sheet back to who wrote it, from the paper alone. See
[the doctor code](#the-doctor-code) below.

Anything already signed reprints unchanged from **My Clinic → My prescriptions**.

## Who may see what

| | Can |
|---|---|
| The prescriber | Write, read, reprint and cancel their own |
| Another doctor | Nothing — a colleague's prescriptions return 403, and their list is empty |
| Pharmacy, nurse, reception | Read, in order to dispense and to answer the patient |
| Admin | Everything |

A doctor is scoped to themselves at the source, not in the interface: passing
another doctor's id changes nothing.

## The patient chart

`Patients → open a patient → Vitals chart` is the dated record: **weight,
height, BMI, blood pressure, pulse, temperature, SpO₂, blood sugar and the
purpose of the visit**, newest first, with a sparkline for weight and for
systolic pressure.

- **+ Record a reading** takes them at the desk without opening a visit. The
  purpose is required — that is what makes the row mean something a year later.
- **Height carries forward.** Take only the weight and the BMI still computes
  from the last height on file.
- Readings taken during a visit borrow that visit's reason as their purpose.
- Values are read against ordinary adult ranges as they are typed, so an
  out-of-range blood pressure is noticed at the desk rather than a week later.
  These are a prompt to look, never a diagnosis.


# The doctor code

Every doctor is issued one code, and it is the **only** thing that identifies
them on anything the patient takes home — a prescription or a diagnostic report.

```
SPC - MHD - 002
 |     |     |
 |     |     the serial number in which they were appointed here
 |     a three-letter mnemonic of their name (Mohamed)
 the clinic — Samiha Polyclinic (CLINIC_CODE)
```

**The mnemonic** keeps the first letter, then adds the consonants not yet used —
which is how these abbreviations get written by hand:

| Name | Code |
|---|---|
| Mohamed | `MHD` |
| Nafisa Rahman | `NFS` |
| Vikram Rao | `VKR` |
| Imran Sheikh | `IMR` |
| Arif Hussain | `ARF` |

A short name is filled out from its own remaining letters rather than padded
(Neha → `NHE`).

**The serial** is the order the doctor joined, taken once on appointment and
never reused — a doctor who leaves does not free their number, because their
code is already on printed sheets in patients' homes.

## Issuing and changing it

A code is generated when the doctor is created, and shown on the doctors list
and on their record under **Staff & Doctors**. Admin may set or correct it in
the doctor's form; a code already belonging to somebody else is refused, and the
database will not hold two the same.

Change it only **before the first sheet is printed**. After that, the code out
in the world no longer matches the file.

## Where it appears

Everything the patient takes home carries the code and no doctor's name:

| Document | Shows |
|---|---|
| **Prescription** | The code beside the prescription number, and a blank box for the stamp |
| **Investigation request** | The ordering doctor's code, the tests and which sample each needs, the sample barcode once collected, and a blank box for whoever draws it |
| **Diagnostic report** | The referring doctor's code beside the order number, and a blank box |
| **Bill / tax invoice** | The treating doctor's code, taken from the visit or admission the bill was raised against |
| **Payment receipt** | The same code as the bill it settles. The cashier who took the money still signs it — they are the clinic's own counter |
| **Discharge summary** | The consultant's code, and a blank box for their stamp |

A bill raised against neither a visit nor an admission — a straight pharmacy
counter sale, for instance — has no treating doctor and leaves the field empty
rather than guessing at one.

## Why the code and not the name

A prescription and a lab report leave the building. Neither carries a doctor's
name, qualification, registration number, room or contact detail — nothing on
the page should let a patient reach a doctor directly, or identify who they saw
beyond what they already know.

The doctor stamps and signs the printed sheet by hand. That signature is what
makes it theirs; the code is how the clinic knows, from the paper alone, whose
it was.
