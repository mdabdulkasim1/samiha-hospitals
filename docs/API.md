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
| GET | `/lab/orders?status=&visitId=` · `/lab/orders/:id` | lab, doctor, nurse, reception, cashier |
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

## Billing
| Method | Path | Roles |
|---|---|---|
| GET | `/billing/invoices[/:id]` · `/billing/daybook?date=` | cashier, reception, doctor, counselor, ward |
| POST | `/billing/invoices` · `/invoices/:id/items` | cashier, reception |
| POST | `/billing/invoices/:id/payments` | cashier, reception |
| POST | `/billing/invoices/:id/payment-plan` | cashier, reception |
| POST | `/billing/invoices/:id/exception` | cashier, counselor |
| POST | `/billing/invoices/:id/assistance-cover` | cashier, counselor |
| GET | `/billing/payment-plans` | cashier, reception, doctor, counselor, ward |
| POST | `/billing/payment-plans/:id/installments/:seq/pay` | cashier, reception |
| GET | `/billing/receipts/:receiptNo` | cashier, reception, doctor, counselor, ward |

## In-patient
| Method | Path | Roles |
|---|---|---|
| GET | `/ipd/wards` · `/ipd/admissions[?status=]` · `/ipd/admissions/:id` | clinical desks |
| POST | `/ipd/wards` · `/ipd/wards/:id/beds` | admin, ward |
| PATCH | `/ipd/beds/:id` | ward, nurse, doctor, reception |
| POST | `/ipd/admissions` | ward, nurse, doctor, reception |
| POST | `/ipd/admissions/:id/notes` · `/vitals` · `/charges` · `/transfer` | ward, nurse, doctor |
| POST | `/ipd/admissions/:id/medications` | doctor |
| GET | `/ipd/admissions/:id/mar?date=` · POST `/ipd/mar/:id` | nurse, ward, doctor |
| POST | `/ipd/admissions/:id/discharge` | doctor, ward, cashier |
| GET | `/ipd/admissions/:id/discharge-summary` | clinical desks |

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
