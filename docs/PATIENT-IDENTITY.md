# Finding a patient: the mobile number

The mobile number is the primary way a patient is identified at SAMIHA. It is
the one thing everybody knows by heart, it is what they give on the phone and on
WhatsApp, and it is what the front desk asks for first — so it is the first
thing on the **Patients** screen, above the name search.

## One number, one household

An Indian family shares a number as a matter of course: the father's mobile
covers his wife, his children and often his parents. So a number is not an
identity — **it is a household**, and the desk picks the person who has come in.

Searching a number lists everyone on it as a card each, showing:

- name, UHID, age and sex
- how they relate to the number (spouse, son, daughter, guardian…)
- when they were last seen and how many visits they have
- **any appointment already booked**
- **anything outstanding on their bill**

Clicking a card opens that person's record. Everyone keeps their **own UHID,
their own file, their own chart and their own bill** — the number is only how
they are found.

## Registering on a number that already exists

This is the ordinary case, not an error. Registering with a known number returns
the household and names it, and the desk chooses:

- **Open one of them** — the person is already on file, which is usually what
  happened.
- **+ Add another person on this number** — a new family member. The shared
  address is carried across, and the desk records how they relate to the others.

A duplicate is only forced through deliberately (`allowDuplicate: true`), so
nobody registers the same patient twice by accident.

## How the number is matched

The last ten digits, so every way a number gets written finds the same family:

```
9845020001   09845020001   919845020001   +91 98450 20001
```

Six digits is the minimum before a search runs. Both the mobile and the WhatsApp
number on a file are matched, because patients give whichever they use.

## The file is permanent

One patient, one register number, for life. Entering it on **Patients** opens
their file directly — the number identifies a person, so there is nothing to
pick from, which is the difference between it and the mobile number above.

What the file holds does not expire and is not trimmed to a recent slice. Every
visit, consultation, prescription and diagnostic result stays on it, so a doctor
seeing the patient after three years has the same record as the doctor who saw
them last week.

### Diagnostics on the record

The **Diagnostics** tab is the results themselves, not a list of orders. Each
result carries the value, the unit, **the reference range it was read against at
the time**, and the flag the lab put on it. The range is stored with the result
rather than looked up in today's catalogue: a lab that changes its analyser
changes its ranges, and a value from 2023 has to be read against the range that
was printed beside it in 2023.

Results outside their range are tinted, and the tab opens with a count of how
many there are across the whole file.

### How these have moved

Where a test has been done more than once, the file shows it over time — the
readings oldest first, the direction of travel, and a line where the results are
numbers. This is what a follow-up actually turns on: one HbA1c is a number, five
of them over three years is whether the patient is getting better.

Only results that are genuinely numeric are charted. An echocardiogram is a
paragraph and a culture is "no growth"; those are reported in prose below,
where they are read, rather than charted into nonsense.

### Studies reported in words

ECG, echocardiography, X-ray and ultrasound are written up by the technician as
**Findings** and a one-line **Impression**, and both stay on the patient's file.
The Findings box is prompted with the checklist for that particular study — an
echocardiogram is not reported in the language of an ECG — matched on the
catalogue code, so renaming a test does not change what the technician is asked
for.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/patients/by-phone?phone=` | The household on a number, with dues and next appointment |
| GET | `/patients?q=` | Matches the register number, the name and either phone number |
| GET | `/patients/:id` | The whole file: visits, consultations, prescriptions, and every diagnostic result with its trend |
| POST | `/patients` | 409 with the household in `details.family` when the number is known; `allowDuplicate: true` adds another person to it |
