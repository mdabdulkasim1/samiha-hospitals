# Insurance, TPA, pre-authorisation and claims

Covers empanelled insurers and TPAs, patient policies, cashless pre-authorisation
(including queries and enhancements), and claims from the hospital bill through to
settlement and reconciliation.

## The accounting model — read this first

Everything below depends on one rule:

> **`invoices.insurance_covered` holds what the insurer is standing behind *right now*.**
> It reduces the invoice's net, so a cashless patient owes only co-pay, disallowances and
> non-admissible items — which is what lets them be discharged. The insurer's actual money
> lives on the **claim**, not as a second payment against the invoice, so nothing is counted
> twice. If the insurer eventually pays **less** than it approved, the shortfall moves back
> onto the patient's balance automatically.

Reimbursement claims never touch the invoice: the patient pays the clinic in full and
recovers from their insurer themselves. The claim is still tracked, and the policy's
sum insured is still drawn down.

## The lifecycle

```
Policy on file
  └─ eligibility check ── blocked? (expired, exhausted, suspended)
       └─ PRE-AUTHORISATION
            draft ──(documents ticked)──► submitted
              ▲                              │
              └──── query_answered ◄── query_raised
                                             │
                        ┌────────────────────┼────────────────────┐
                    approved          partially_approved      rejected
                        │                    │                    │
                        └── invoice cover ◄──┘          cover = 0, patient pays
                                 │
                            enhancement (adds to the cover, never replaces it)
                                 │
                              DISCHARGE — patient settles only their own share
                                 │
                              CLAIM (built from the bill's own lines)
                            draft ──► submitted ◄── query_raised
                                        │
                              approved ─┴─ rejected → whole bill back to the patient
                                        │
                              settled / partially_settled
                                        │
                          shortfall against the approval → back to the patient
```

## Policies

A policy carries the four things that actually change the arithmetic:

| Field | Effect |
|---|---|
| **Sum insured** and **utilised** | The balance caps every approval; a policy is auto-marked *exhausted* when drawn down |
| **Co-pay %** | The patient's own share of every approved amount |
| **Room-rent cap per day** | Exceeding it triggers a **proportionate deduction across the whole bill**, exactly as TPAs apply it |
| **Valid from / to** | Outside the window, cover is blocked outright |

Registering a policy clears the patient's *uninsured* flag, so they stop being routed into
the sliding-scale screening lane.

**Eligibility check** (`GET /api/insurance/policies/:id/eligibility?estimate=&roomTariff=&stayDays=`)
answers "can we do this cashless, and for how much?" before anyone commits to an admission:

```
Estimate 120,000 · room 6,000/day vs a 4,000/day cap
  → 4000/6000 = 67% eligible        → 80,400
  → less 10% co-pay                 →  8,004
  → insurer could bear                72,036
  → patient would bear                47,964
```

It returns **blockers** (which stop a pre-auth outright) separately from **warnings**
(unverified card, waiting period, policy expiring soon, room-rent excess).

## Pre-authorisation

- A **document checklist** is seeded unticked. Submitting with papers outstanding is refused
  unless the desk explicitly overrides it — the single most common reason a cashless request
  bounces.
- A **query** from the insurer moves the request to `query_raised` and any extra papers they
  asked for become checklist rows of their own. Re-submitting records it as *query answered*.
- **Approval cannot exceed** either the amount requested or the sum insured left on the
  policy, allowing for other approvals already committed against it.
- Approval places the amount, **net of co-pay**, onto the episode's invoice immediately.
- An **enhancement** is a child request against the same episode, for when the stay overruns
  or the procedure changes. Enhancements **add to** the cover — the invoice is re-pointed at
  the root approval plus every approved enhancement, each net of co-pay.
- The patient is messaged on WhatsApp when a decision lands.

## Claims

- A claim is **built from the invoice's own lines**, so what is claimed always reconciles to
  what was billed. Obvious exclusions — registration, attendant charges, toiletries,
  documentation — are pre-marked non-admissible for the desk to confirm.
- Each line can be adjusted individually: admissible or not, amount claimed, amount approved,
  and a disallowance reason.
- Only one live claim per invoice.
- A **settlement due date** is set from the insurer's own turnaround, which drives the
  receivables ageing.
- **Settlements accumulate.** Insurers pay in tranches; each receipt adds to the total rather
  than replacing it, and the total can never exceed the approval.
- **Closing short is deliberate.** A tranche that falls short leaves the claim open with the
  balance *awaited*. Supplying a `disallowReason` closes the claim and moves the shortfall
  onto the patient — so nobody silently writes off a receivable.

## Receivables

`GET /api/insurance/receivables` gives ageing buckets (0–30, 31–60, 61–90, 90+ days),
outstanding by insurer with average days pending, and a list of claims past their
settlement date. This is the "where is our money stuck" screen.

## Who can do what

The TPA desk in a polyclinic is the billing counter, so no separate role was added:

| Action | Roles |
|---|---|
| Insurer / TPA master | admin, cashier |
| Policies, verification, eligibility | cashier, reception, counselor |
| Raise a pre-authorisation | cashier, reception, counselor, doctor, ward |
| Edit the clinical part of a pre-auth | cashier, reception, counselor, doctor |
| Submit, record queries and decisions | cashier, reception, counselor |
| Claims, settlement | cashier, reception, counselor |
| View everything | plus doctor, ward, nurse |

## Seeded insurers

Five insurers (Star Health, ICICI Lombard, Niva Bupa, HDFC ERGO, New India Assurance,
Oriental), four TPAs (Medi Assist, Paramount, Vidal Health, MDIndia) and three government
schemes (Ayushman Bharat PM-JAY, CGHS, ESIC), with realistic turnaround and settlement
periods. Where an insurer is administered by a TPA, the link is recorded so the desk knows
who to actually chase.

**Replace the seeded turnaround times, settlement periods and tariff discounts with the terms
in your own empanelment agreements** — the seeded figures are indicative.

## API

| Method | Path | Purpose |
|---|---|---|
| GET/POST/PATCH | `/insurance/insurers[/:id]` | Empanelment master |
| GET/POST/PATCH | `/insurance/policies[/:id]` | Patient policies |
| POST | `/insurance/policies/:id/verify` | Confirm against card or portal |
| GET | `/insurance/policies/:id/eligibility` | Cover, co-pay, room cap, ceiling |
| GET/POST/PATCH | `/insurance/preauths[/:id]` | Pre-authorisation requests |
| POST | `/insurance/preauths/:id/submit` · `/query` · `/decision` · `/enhance` · `/withdraw` | Lifecycle |
| GET/POST | `/insurance/claims[/:id]` | Claims |
| PATCH | `/insurance/claims/:id/items/:itemId` | Adjust one claim line |
| POST | `/insurance/claims/:id/submit` · `/query` · `/decision` · `/settle` · `/cancel` | Lifecycle |
| GET/POST/PATCH | `/insurance/documents[/:id]` | Document checklists |
| GET | `/insurance/receivables` | Ageing and overdue claims |
| GET | `/insurance/patient/:patientId` | Everything insurance-related for one patient |
