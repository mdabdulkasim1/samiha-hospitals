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

**The doctor code** (`DOC01`, the staff code) is printed beside the prescription
number. It means nothing to a patient and everything to the clinic: management
and the doctor can trace any sheet back to who wrote it, from the paper alone.

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
