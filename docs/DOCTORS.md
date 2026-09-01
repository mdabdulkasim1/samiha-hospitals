# Doctors: visiting hours, their own sign-in, and booking alerts

Our consultants are not resident. They sit for two or three hours on days that
are agreed, and they are somewhere else the rest of the week. Three things
follow from that, and this document covers all three:

1. Admin fixes **exactly when each doctor sits**, and that is what the front
   desk and the WhatsApp bot may offer.
2. Every doctor has **their own sign-in** and a screen built for a phone, so
   they can see their list before they leave home.
3. When the front desk books a patient, **the doctor is told** — on their phone,
   not only on the screen at the desk.

## 1. Fixing visiting hours

`Staff & Doctors → open a doctor → Visiting hours`.

A window is a date, a start time and an end time, plus how long each patient
gets and (optionally) a ceiling on how many the doctor will see. The screen
states the consequence before you save it: *"2 hour(s) per day — room for 8
patient(s) each day."*

Two ways to enter them:

- **One day** — for a camp, a stand-in, or a one-off evening clinic.
- **Repeat over a range** — pick the weekdays and a from/to date, and
  "Tuesdays and Fridays, 6 to 8, for the next month" goes in as one entry.
  Re-running it adds nothing and reports the days it skipped, so it is safe to
  repeat.

### Fixed hours replace the weekly rota

Each doctor still has a **weekly rota** (`doctor_schedules`) as a fallback. The
rule is deliberately simple:

> If a date has any fixed visiting hours, those hours **are** that doctor's day.
> The weekly rota is ignored for that date entirely.

Admin naming a date is the stronger statement, so a doctor whose rota says
"mornings and evenings" but whose Friday is fixed at 6–8 PM is bookable from
6 to 8 PM on that Friday and at no other time. With no fixed hours for a date,
the weekly rota applies as before.

A **blocked day** (leave) beats both: nothing is bookable, whatever is set.

### What the front desk then sees

The appointment screen offers only what was fixed, and says so — each day button
carries the window ("6:00 PM – 8:00 PM") next to the number of free slots. The
WhatsApp bot draws on the same source, so a patient can never be offered a time
the doctor is not there.

`max_tokens` is a ceiling on patients, not on slots: a three-hour window at
fifteen minutes holds twelve, but a doctor who will see six gets six offered and
the rest of the window stays closed.

### Removing hours

Removing a window with patients already booked is refused, and the message says
how many. Confirming a second time removes it anyway and leaves those
appointments in place — the desk then has to move or cancel them, which is the
right way round: the ERP does not silently cancel a patient.

## 2. Each doctor's own sign-in

Admin creates a doctor in `Staff & Doctors → + Add doctor` with a temporary
password. That account is a real sign-in: email and password, the same as any
other member of staff, with a doctor's permissions.

Signing in, a doctor gets **My Clinic** — the screen this was built for:

- how many patients are booked that day, how many have arrived, how many are
  seen, and how many cancelled or did not come;
- the list itself: token, time, patient, mobile, reason, new or follow-up, and
  an allergy flag;
- their visiting hours for that day, and their next seven clinic days with how
  many are booked and how many are still free;
- **Block a day** — a doctor who knows on Sunday that they cannot sit on Friday
  blocks it themselves. Patients already booked are left alone and the count is
  reported back, so the desk can move them.

The whole ERP is usable on a phone: below 860 px the navigation folds into a
drawer behind the ☰ button, the top bar sticks, the numbers sit two across, and
wide tables scroll inside their own box rather than pushing the page sideways.

A doctor can open only their own list. `GET /api/appointments/my-day?doctorId=…`
returns 403 for another doctor; the front desk and admin may pass `doctorId`
because they run the diary.

## 3. Booking alerts

When anyone books an appointment — the front desk, or a patient through
WhatsApp — the doctor is told three ways, and none of them can lose the booking
if they fail:

| Where | What |
|---|---|
| **The bell** in the top bar | Always. Unread count polls every minute and on returning to the tab. Tapping an alert opens that clinic day. |
| **WhatsApp** to their own mobile | If they have a number on file and have not turned it off. Patient, mobile, time, token, reason, and how many patients they now have that day. |
| **Email** | Only if the doctor asks for it. |

Moving or cancelling an appointment alerts them too, so a doctor never travels
in for a patient who cancelled.

`My Clinic → Alert settings` is where a doctor sets the WhatsApp number the
alerts go to (leave it blank and their staff mobile is used) and turns the
WhatsApp and email copies on or off. Nobody sets this for them.

Alerts are per staff member and private: the id of somebody else's alert simply
does not exist for you, so marking it read does nothing.

## On the dashboard

`Dashboard → Appointments by doctor today` answers the question the front desk
asks all morning — *how many has Dr Sheikh got?* — without opening the diary.

One row per doctor who is either sitting today or has somebody booked, busiest
first: their visiting hours, patients booked (and how many are new), how many
have arrived, how many have been seen, how many slots are still free, and what
was cancelled or did not turn up. A doctor on leave says so and shows nothing
free. **List** opens that doctor's patients for the day in place — any desk role
can, without needing the doctor's own sign-in.

A doctor looking at the dashboard sees their own row marked *you*.

## In Reports

`Reports → Doctor month by month` is the management view: one row per doctor,
one column per month, over the last 3, 6 or 12 months.

Switch the cell between **patients booked**, **visits attended**, **billed** and
**collected**. Cells are shaded against the busiest month anyone had, so heavy
and quiet months stand out without reading every figure. The row total carries
what is still outstanding, and a **per patient** column makes two doctors with
the same headcount comparable. The table foots across every doctor, and prints
as a sheet the administrator can sign and file.

**How revenue is attributed.** An invoice belongs to the visit or admission it
was raised against, and that record names the doctor. So the pharmacy and
diagnostics ordered during a consultation count to the doctor whose consultation
ordered them — not to the pharmacy or the lab. `billed` is what was invoiced in
the month; `collected` is what has actually come in against those invoices. They
differ, and the gap between them is the point of showing both.

The report is management information: admin, reception and the cashier can read
it. A doctor cannot — they see their own day in My Clinic, not the clinic's
earnings by colleague.

## Tables

| Table | Holds |
|---|---|
| `doctor_availability` | One fixed visiting window on one date |
| `doctor_schedules` | The weekly rota, used when no window is fixed |
| `doctor_leaves` | Blocked days, which beat both |
| `staff_notifications` | The bell: one row per alert per staff member |
| `notifications` | The outbound WhatsApp/email copy, on the same queue as patient messages |
| `doctor_profiles.notify_whatsapp` / `notify_email` | How that doctor wants to hear |
| `users.whatsapp` | The number they chose for alerts, if not their staff mobile |

## Endpoints

| Method | Path | Who |
|---|---|---|
| GET | `/masters/doctors/:id/availability?from=&to=` | any signed-in user |
| POST | `/masters/doctors/:id/availability` | admin, reception |
| DELETE | `/masters/availability/:id[?force=1]` | admin, reception |
| GET | `/appointments/my-day?date=&doctorId=` | the doctor themselves; any desk role for others |
| GET | `/me/notifications` · `/notifications/count` | the signed-in user |
| POST | `/me/notifications/:id/read` · `/read-all` | the signed-in user |
| GET/PATCH | `/me/alert-settings` | the signed-in user |
| POST | `/me/leave` · DELETE `/me/leave/:date` | doctors |
