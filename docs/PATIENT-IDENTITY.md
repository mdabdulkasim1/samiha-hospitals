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

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/patients/by-phone?phone=` | The household on a number, with dues and next appointment |
| POST | `/patients` | 409 with the household in `details.family` when the number is known; `allowDuplicate: true` adds another person to it |
