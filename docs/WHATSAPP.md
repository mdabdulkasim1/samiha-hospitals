# WhatsApp appointment booking

Patients book appointments by messaging the clinic — no app, no login, no web form.
The ERP implements the conversation as a state machine, so a patient can be interrupted and
pick up where they left off, and the front desk can see exactly where anyone is stuck.

## Trying it without a WhatsApp account

The default `WHATSAPP_PROVIDER=mock` runs a full simulator inside the app: **WhatsApp →
Conversations**. Type a phone number, then chat as the patient. Nothing leaves the machine,
and the bot driving it is byte-for-byte the same one the live webhook drives.

## The booking conversation

```
Patient  Hi
Clinic   SAMIHA POLYCLINIC & DIAGNOSTICS
         Hello! 👋 Welcome to our appointment desk.
         How can we help you today?
         1 — Book an appointment          5 — Medicine refill request
         2 — My appointments              6 — Clinic timings & location
         3 — Cancel an appointment        7 — Talk to the front desk
         4 — Diagnostic report status

Patient  1
Clinic   🏥 Book an appointment — Which department do you need?
         1 — Cardiology   2 — Dermatology   3 — ENT   4 — General Medicine  …

Patient  4
Clinic   👨‍⚕️ General Medicine — choose a doctor:
         1 — Dr. Imran Sheikh (MBBS, MD) — ₹500

Patient  1
Clinic   📅 Dr. Imran Sheikh — pick a day:
         1 — Tue, 2 Sep (tomorrow) · 27 slot(s)
         2 — Wed, 3 Sep · 31 slot(s)   …

Patient  1
Clinic   🕒 Tue, 2 Sep — pick a time:
         1 — 9:00 AM   2 — 9:15 AM   3 — 9:30 AM  …

Patient  2
Clinic   🧑 We could not find you in our records. What is the patient's full name?
Patient  Zainab Hussain
Clinic   🎂 Patient age and gender? For example: 34 female
Patient  41 female
Clinic   📝 What is the reason for your visit?
Patient  Persistent cough for two weeks
Clinic   📋 Please confirm
         Patient: Zainab Hussain · Age/Gender: 41 / female
         Department: General Medicine · Doctor: Dr. Imran Sheikh
         When: Tue, 2 Sep at 9:15 AM
         Reason: Persistent cough for two weeks
         Reply YES to confirm or NO to start over.

Patient  YES
Clinic   ✅ Appointment confirmed
         Ref: APT26090012 · Token: 3
         …
         Reply CANCEL APT26090012 to cancel, or MENU for more options.
```

A recognised number skips the name/age questions and books against the existing record.
Confirming creates **an enquiry and a confirmed appointment with a token number**, and queues
a reminder for the evening before.

## Commands that work from anywhere in the conversation

| Command | Effect |
|---|---|
| `MENU` / `HI` / `HELP` | Back to the main menu |
| `BOOK` | Start a booking |
| `CONFIRM <ref>` | Confirm an appointment (usually replying to the reminder) |
| `CANCEL <ref>` | Cancel — the slot is released immediately |
| `STOP` | Opt out of automated messages |

## What the clinic sends automatically

Queued in an outbox and retried on failure — visible under **WhatsApp → Outbox**.

| Trigger | Message |
|---|---|
| Appointment booked | Confirmation with reference, token, doctor, time, directions |
| Evening before | Reminder, with confirm/cancel replies |
| Appointment cancelled | Cancellation notice with a rebooking prompt |
| Patient checked in | Visit number and queue token |
| Diagnostic report verified | Report ready for collection |
| Medicines dispensed | Pharmacy bill ready |
| Payment received | Receipt number, amount, remaining balance |
| Payment plan agreed | Instalment schedule |
| Visit checked out | Visit summary and next review date |
| Patient admitted | IP number, ward and bed, visiting hours |
| Patient discharged | Final diagnosis and follow-up date |
| Screening completed | Sliding-scale band and eligible programmes |

## Going live on the Meta Cloud API

1. **Create the app.** At `developers.facebook.com`, create a Meta Business account and a
   *Business* app, add the **WhatsApp** product, and register the clinic's phone number.
2. **Get the credentials.** Copy the **Phone number ID** and generate a permanent
   **system user access token**.
3. **Point the webhook here.**
   - Callback URL: `https://your-domain/api/whatsapp/webhook`
   - Verify token: whatever you set as `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the `messages` field.

   Meta calls the URL with a challenge; the ERP answers it automatically.
4. **Set the environment and restart.**

   ```bash
   WHATSAPP_PROVIDER=meta
   WHATSAPP_TOKEN=EAAG...your-permanent-token
   WHATSAPP_PHONE_NUMBER_ID=123456789012345
   WHATSAPP_VERIFY_TOKEN=samiha-verify-token
   ```

The banner on the WhatsApp page turns green when the app is live.

### Notes on running it in production

- **The webhook must be publicly reachable over HTTPS.** Meta will not deliver to plain HTTP.
- **Answer fast.** The webhook returns `200` immediately and processes the message after, so
  Meta never retries a message that was actually handled.
- **The 24-hour window.** Outside 24 hours from the patient's last message, WhatsApp only
  permits pre-approved *template* messages. Reminders sent long after the booking need an
  approved template in Meta Business Manager.
- **Delivery receipts** update each message's status automatically.
- **Consent.** Get the patient's permission to message them, and honour `STOP`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Webhook verification fails | `WHATSAPP_VERIFY_TOKEN` does not match what you typed in Meta |
| Messages arrive but nothing replies | Not subscribed to the `messages` field |
| Outbox shows *failed* | Token expired, or outside the 24-hour window without a template |
| A patient is stuck mid-booking | **WhatsApp → Live bookings in progress → Reset to menu** |
