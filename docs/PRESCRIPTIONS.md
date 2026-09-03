# Prescriptions and the patient chart

## Writing a prescription

A doctor signs in and writes from **My Clinic** — either straight off their
patient list (**℞ Prescribe** on the row) or from **℞ Write a prescription**,
which searches their own patients: anyone booked with them, seen by them, or
prescribed for by them before. A doctor never searches the whole register.

Medicines come from the pharmacy's **own formulary**, with live stock shown as
you type, so what is written is what the counter can actually hand over.

### How to take it

A prescription is only as good as the patient's understanding of it, so each
medicine is written the way it is read across India:

| | |
|---|---|
| **Morning · Noon · Night** | A dose for each — the familiar **1 - 0 - 1** |
| **Food** | Before food, after food, with food, on an empty stomach, at bedtime, any time |
| **For how many days** | And the total to dispense, worked out from the two but overridable |
| **Note for the patient** | "Finish the full course", "plenty of water", "do not chew" |

The clinical shorthand follows from the slots rather than being typed — one slot
is OD, two is BD, three is TDS — and the unit follows the medicine's form, so a
syrup is prescribed in **ml** and a tablet in **tablets**. A medicine taken only
when needed has no slots and keeps **SOS** or **STAT** instead.

As the doctor types, the line reads back in plain words:

> **1 - 1 - 1**  1 tablet in the morning, 1 tablet in the noon and 1 tablet in
> the night, after food · for 3 day(s) · 9 tablets in all

and that is what prints, so the patient reads exactly what the doctor meant.

### Save, Sign, Print

Three separate things, because they are:

| | |
|---|---|
| **Save** | The prescription exists and **the pharmacy can see it**. Written against a visit it joins the dispensing queue; without one it appears under Pharmacy → Prescriptions. |
| **Sign** | The doctor's own signature goes onto it. The first time, they draw it or upload a scan; after that it is stamped on with one press. |
| **Print** | The patient walks out with the paper. |

Saving happens once — signing and printing act on the sheet that was saved, so a
doctor can save now and sign or print later without a second prescription being
created for the same consultation.

A signature is stored per doctor and **stamped onto the sheet at the moment of
signing**, so changing or removing it later never rewrites a prescription
already in a patient's hands. Unsigned sheets still print the blank box for a
physical stamp.

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
| **Imaging report** (X-ray, USG) | The same, reported as findings and impression in prose rather than a results table |
| **Cardiology report** (ECG, Echo) | The same again, headed and worded as a tracing rather than as images |
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


# Reported in words: X-ray, ultrasound, ECG and echo

An X-ray, a scan or a tracing is reported in words, not in numbers, so none of
them belonged in the results table the blood tests use. Anything in the
**radiology** or **cardiology** category of the test catalogue is reported this
way.

**Reporting one.** Open the order in Diagnostics. Instead of a value box, each
study gets a **Findings** area and a one-line **Impression**, which is the line
the referring doctor reads first. The prompt follows the modality: an X-ray asks
for technique and what is seen; an ECG asks for rate, rhythm, axis, intervals
and ST-T changes.

**The printed report** heads itself by what it holds:

| The order holds | Heading |
|---|---|
| Ultrasound or Doppler only | Ultrasound Report |
| X-rays only | Radiology Report |
| ECG or echo only | Cardiology Report |
| A mix of imaging | Imaging Report |
| Measured tests as well | Diagnostic Report |

Each study prints as its own section with the findings as prose and the
impression in bold. An order mixing bloods and imaging prints the table first
and the narrative below it.

The footnote follows the modality too: an imaging report says it is an opinion
on the images acquired; a cardiology report says it is an interpretation of the
tracing recorded at the time. Neither is a diagnosis on its own.

Everything else is the same as any other report — the polyclinic's name and
address, the referring doctor's code, and a blank box for the reporting doctor
to stamp and sign.

## Correcting a prescription

A consultation is not filled in one pass. The dose is revised when the weight
comes back from the nurse, a medicine is dropped when the patient says what
they are already taking, a duration typed as 5 was meant as 15. Cancelling the
sheet and writing it again loses the number the pharmacy is holding and leaves
two prescriptions in the record for one consultation.

**My Clinic → My prescriptions → Correct** reopens the pad on the sheet itself:
complaints, findings, coded diagnoses, advice, review date and every medicine
come back as they were written. `PATCH /api/prescriptions/:id` saves it. The Rx
number does not change, and the sheet records `amended_at` and `amended_by`.

Three rules hold.

**What the pharmacy has handed over cannot be rewritten.** A line with any
quantity dispensed, or one the patient filled elsewhere, is locked: it comes
back disabled on the pad, refuses a change with 409, and survives an edit that
leaves it out. The medicine is in the patient's hand and the record has to say
what they were actually given. The response names those lines in
`lockedLines`.

**A signed sheet loses its signature.** The paper the patient is carrying no
longer matches the record, so the doctor signs and prints again; the response
says so in `signatureCleared`. A signature is a statement about a particular
set of medicines.

**Only the prescriber may correct their own prescription**, and not once it is
cancelled — the same rule signing and cancelling already follow.

The allergy check runs against what the sheet will say afterwards, untouched
lines included: a medicine kept is still a medicine given.
