# API reference

All endpoints are under `/api`. Everything except `/api/health`, `/api/auth/login` and
`/api/whatsapp/webhook` requires authentication.

**Authenticating:** `POST /api/auth/login` sets an HTTP-only session cookie and returns a
bearer token. Send either.

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"reception@samiha.local","password":"samiha@123"}' | jq -r .token)

curl localhost:3000/api/patients?q=ayesha -H "Authorization: Bearer $TOKEN"
```

**Errors** are always `{ "error": "human-readable reason", "details": … }` with a meaningful
status: `400` invalid input · `401` not signed in · `403` wrong role · `404` missing ·
`409` conflicts with the current state (double booking, insufficient stock, unpaid balance).

## Auth
| Method | Path | Roles |
|---|---|---|
| POST | `/auth/login` | public |
| POST | `/auth/logout` | any |
| GET | `/auth/me` | any |
| POST | `/auth/change-password` | any |
| POST | `/auth/forgot-password` | **public** — always answers the same, rate-limited |
| GET | `/auth/reset-password/:token` | **public** — checks a link before showing the form |
| POST | `/auth/reset-password` | **public** — single-use token |

## Account & system
| Method | Path | Roles |
|---|---|---|
| GET | `/admin/system` | admin — recovery mailbox, mail health, backup state |
| POST | `/admin/system/test-email` | admin |
| GET/POST | `/admin/backups` | admin — list, take a snapshot |
| GET | `/admin/backups/:filename/download` | admin |
| DELETE | `/admin/backups/:filename` | admin |
| POST | `/admin/users/:id/send-reset` | admin — email a staff member a reset link |

## Masters
| Method | Path | Roles |
|---|---|---|
| GET/POST | `/masters/departments` | any / admin |
| GET | `/masters/staff?role=doctor` | any |
| POST/PATCH | `/masters/staff[/:id]` | admin |
| GET/POST | `/masters/doctors/:id/schedule` | any / admin, reception |
| POST | `/masters/doctors/:id/leave` | admin, reception |
| GET/POST | `/masters/services` | any / admin |
| GET/POST | `/masters/lab-tests` | any / admin, lab |
| GET | `/masters/icd?q=` | any |
| GET | `/masters/assistance-programs`, `/masters/sliding-scale` | any |

## Patients
| Method | Path | Roles |
|---|---|---|
| GET | `/patients?q=&page=` | clinical desks |
| POST | `/patients` | reception |
| GET | `/patients/:id` | clinical desks — full 360° record |
| PATCH | `/patients/:id` | reception, nurse, doctor, counselor |
| POST | `/patients/:id/history` | reception, nurse, doctor |
| GET | `/patients/:id/screening-status` | clinical desks |

## Enquiries and appointments
| Method | Path | Roles |
|---|---|---|
| GET/POST | `/enquiries` · `/enquiries/stats` | reception, counselor, cashier |
| PATCH | `/enquiries/:id` | reception, counselor, cashier |
| GET | `/appointments?date=&status=&doctorId=` | clinical desks |
| GET | `/appointments/availability?doctorId=&date=` | clinical desks |
| GET | `/appointments/board?date=` | clinical desks |
| POST | `/appointments` | clinical desks |
| PATCH | `/appointments/:id` | clinical desks — reschedule, confirm, cancel, no-show |

## Visits — the workflow
| Method | Path | Roles | Workflow step |
|---|---|---|---|
| GET | `/visits/board?date=` | clinical desks | The live queue board |
| POST | `/visits/arrive` | reception | Patient walk-in; answers the new-patient, financial-change and screening-due decisions |
| POST | `/visits/:id/check-in` | reception | Check in · ask reason for visit |
| POST | `/visits/:id/vitals` | nurse, doctor | Check vitals — returns BMI and clinical alerts |
| POST | `/visits/:id/consultation` | doctor | Clinical care — SOAP note, diagnoses, prescriptions |
| POST | `/visits/:id/consultation/sign` | doctor | Sign and route onward |
| GET | `/visits/:id/results-page` | clinical desks | The results page the patient carries |
| POST | `/visits/:id/prepare-bill` | cashier, reception | Assemble charges at the check-out desk |
| POST | `/visits/:id/check-out` | cashier, reception | Patient leaves — books the follow-up, issues the exit pass |

## Financial screening
| Method | Path | Roles |
|---|---|---|
| GET | `/financial/screenings?status=` | counselor, reception, cashier |
| POST | `/financial/screenings` | counselor, reception, cashier |
| POST | `/financial/screenings/:id/claim` | counselor |
| POST | `/financial/screenings/:id/assess` | counselor, reception, cashier |
| POST | `/financial/screenings/:id/decide` | counselor, reception, cashier |
| POST | `/financial/sliding-scale/preview` | counselor, reception, cashier |

## Diagnostics
| Method | Path | Roles |
|---|---|---|
| GET | `/lab/orders?status=&visitId=&gate=released\|awaiting` | lab, doctor, nurse, reception, cashier |
| GET | `/lab/orders/:id` | lab, doctor, nurse, reception, cashier |
| POST | `/lab/orders` | doctor, lab, nurse |
| POST | `/lab/orders/:id/collect` · `/start` | lab (collect: also nurse) |
| POST | `/lab/orders/:id/results` | lab |
| POST | `/lab/orders/:id/verify` | lab, doctor |
| GET | `/lab/orders/:id/report` | lab, doctor, nurse, reception, cashier |

## Pharmacy
| Method | Path | Roles |
|---|---|---|
| GET/POST | `/pharmacy/drugs` | any clinical / pharmacy |
| POST | `/pharmacy/stock/receive` · `/stock/adjust` | pharmacy |
| GET | `/pharmacy/stock/alerts` · `/stock/ledger` | any clinical / pharmacy |
| GET | `/pharmacy/queue` · `/prescriptions/:visitId` | any clinical |
| POST | `/pharmacy/dispense` | pharmacy |
| GET | `/pharmacy/sales[/:id]` | any clinical |
| POST | `/pharmacy/counter-sale` | pharmacy |
| GET/POST | `/stock/suppliers` · PATCH `/stock/suppliers/:id` | pharmacy (read: counter roles) |
| GET | `/stock/scan?code=` | counter roles |
| GET | `/stock/barcodes` | counter roles |
| POST | `/stock/barcodes/drug/:id` · `/drug/:id/generate` · `/generate-missing` · `/batch/:id` | pharmacy |
| GET | `/stock/labels/drugs?drugIds=` · `/stock/labels?batchIds=` | counter roles |
| GET/POST | `/stock/purchases` · GET `/stock/purchases/:id` · POST `/stock/purchases/:id/pay` | pharmacy (read: counter roles) |
| GET | `/stock/register` · `/stock/register/:drugId/movements` | counter roles |
| PATCH | `/stock/drugs/:id/rate` | **admin only** — what one unit is worth for stock valuation |
| GET/POST | `/stock/takes` · GET `/stock/takes/:id` · `/stock/takes/new/sheet` | pharmacy (read: counter roles) |
| POST | `/stock/write-off-expired` | pharmacy |
| GET | `/pharmacy/sales/:id/invoice` | any clinical / pharmacy |
| GET/POST | `/masters/doctors/:id/availability` · DELETE `/masters/availability/:id` | read: any; write: admin, reception |
| GET | `/appointments/my-day?date=&doctorId=` | the doctor themselves; desk roles for others |
| GET | `/reports/doctor-monthly?months=&to=` | admin, reception, cashier |
| GET | `/me/notifications` · `/me/notifications/count` | the signed-in user |
| POST | `/me/notifications/:id/read` · `/me/notifications/read-all` | the signed-in user |
| GET/PATCH | `/me/alert-settings` | the signed-in user |
| POST | `/me/leave` · DELETE `/me/leave/:date` | doctors |
| GET/POST | `/prescriptions` · GET `/prescriptions/:id` | write: doctor; read: doctor (own), pharmacy, nurse, reception |
| POST | `/prescriptions/:id/cancel` | the prescriber |
| GET | `/prescriptions/patients/search?q=` | doctor (their own patients) |
| POST | `/patients/:id/vitals` | reception, nurse, doctor |
| GET | `/patients/by-phone?phone=` | desk roles |
| GET | `/patients/:id/notes` | desk roles — why they came, on the hospital record |
| POST | `/patients/:id/notes` | doctor, nurse, reception — never printed on the prescription |

## Billing
Only the cashier raises a bill or takes money. The counsellor reads bills and
records concessions, plans and exceptions; the ward reads a running in-patient
bill. Reception quotes rates but does not touch the till, and a doctor is not
on this table at all.

| Method | Path | Roles |
|---|---|---|
| GET | `/billing/invoices[/:id]` · `/billing/daybook?date=` | cashier, counselor, ward |
| POST | `/billing/invoices` · `/invoices/:id/items` | cashier |
| POST | `/billing/invoices/:id/payments` | cashier |
| POST | `/billing/invoices/:id/payment-plan` | cashier |
| POST | `/billing/invoices/:id/exception` | cashier, counselor |
| POST | `/billing/invoices/:id/assistance-cover` | cashier, counselor |
| GET | `/billing/payment-plans` | cashier, counselor, ward |
| POST | `/billing/payment-plans/:id/installments/:seq/pay` | cashier |
| GET | `/billing/receipts/:receiptNo` | cashier, counselor, ward |
| GET | `/billing/diagnostics/pending` | cashier — ordered tests waiting to be priced |
| POST | `/billing/diagnostics/:orderId/bill` | cashier — set a rate per line and post to the bill |
| POST | `/billing/diagnostics/:orderId/release` | cashier — send through unpaid, with a reason |
| GET | `/billing/tariff/repricing` | **admin only** — what repricing unpaid bills would do |
| POST | `/billing/tariff/reprice` | **admin only** — bring unpaid bills onto the current card |

## In-patient
| Method | Path | Roles |
|---|---|---|
| GET | `/ipd/wards` · `/ipd/admissions[?status=]` · `/ipd/admissions/:id` | clinical desks |
| POST | `/ipd/wards` · `/ipd/wards/:id/beds` | admin, ward |
| PATCH | `/ipd/beds/:id` | ward, nurse, reception |
| POST | `/ipd/admissions` | ward, nurse, reception |
| POST | `/ipd/admissions/:id/notes` · `/vitals` | ward, nurse, doctor |
| POST | `/ipd/admissions/:id/charges` · `/transfer` | ward, nurse, cashier |
| POST | `/ipd/admissions/:id/medications` | doctor |
| GET | `/ipd/admissions/:id/mar?date=` · POST `/ipd/mar/:id` | nurse, ward, doctor |
| POST | `/ipd/admissions/:id/discharge` | doctor, ward, cashier |
| GET | `/ipd/admissions/:id/discharge-summary` | clinical desks |

## Insurance / TPA
Full detail and the accounting model in [`INSURANCE.md`](INSURANCE.md).

| Method | Path | Roles |
|---|---|---|
| GET | `/insurance/insurers?kind=` | cashier, reception, counselor, doctor, ward, nurse |
| POST/PATCH | `/insurance/insurers[/:id]` | admin, cashier |
| GET | `/insurance/policies?patientId=` | view roles |
| POST/PATCH | `/insurance/policies[/:id]` | cashier, reception, counselor |
| POST | `/insurance/policies/:id/verify` | cashier, reception, counselor |
| GET | `/insurance/policies/:id/eligibility?estimate=&roomTariff=&stayDays=` | view roles |
| GET | `/insurance/preauths?status=&patientId=` · `/preauths/:id` | view roles |
| POST | `/insurance/preauths` | cashier, reception, counselor, doctor, ward |
| PATCH | `/insurance/preauths/:id` | cashier, reception, counselor, doctor |
| POST | `/insurance/preauths/:id/submit` · `/query` · `/decision` · `/enhance` · `/withdraw` | cashier, reception, counselor |
| GET | `/insurance/claims?status=&insurerId=&patientId=` · `/claims/:id` | view roles |
| POST | `/insurance/claims` | cashier, reception, counselor |
| PATCH | `/insurance/claims/:id/items/:itemId` | cashier, reception, counselor |
| POST | `/insurance/claims/:id/submit` · `/query` · `/decision` · `/settle` · `/cancel` | cashier, reception, counselor |
| GET/POST/PATCH | `/insurance/documents[/:id]` | view roles |
| GET | `/insurance/receivables` · `/insurance/patient/:patientId` | view roles |

## WhatsApp
| Method | Path | Roles |
|---|---|---|
| GET/POST | `/whatsapp/webhook` | **public** — Meta Cloud API |
| POST | `/whatsapp/simulate` | any signed-in user |
| GET | `/whatsapp/conversations[/:number]` · `/sessions` | any |
| POST | `/whatsapp/send` | all desks except doctor/admin-only |
| GET | `/whatsapp/outbox` · POST `/outbox/dispatch` · `/outbox/:id/retry` | any |

## Reports
| Method | Path | Roles |
|---|---|---|
| GET | `/reports/dashboard?date=` · `/reports/trend?days=` | any |
| GET | `/reports/turnaround?from=&to=` | any |
| GET | `/reports/revenue` | admin, cashier, reception |
| GET | `/reports/doctor-productivity` | admin, reception, cashier |
| GET | `/reports/audit?entity=&limit=` | admin |
