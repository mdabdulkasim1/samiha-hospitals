# Deploying, recovery and backups

## Why a fresh deployment says "Invalid credentials"

A brand-new server starts with an empty database and no accounts, so every sign-in fails.
The app now handles that itself: **when there are no users at all, it seeds the starter data on
first boot** and logs what it did. You will see this in the deploy log:

```
[setup] No accounts found — creating the starter data.
[setup] Done. Sign in as admin@samiha.local with the seeded password.
[setup] ⚠ Change every seeded password before using this with real patient data.
```

Set `AUTO_SEED=false` once you are past first boot. Seeding only ever runs when the users
table is empty, so it can never overwrite a live clinic's data.

## The catalogue keeps itself in step

Because seeding runs once, a clinic that has been live for months would never receive a
test added to the app afterwards. So the **billable catalogue** — services, diagnostics
and the tariff — is synced on every boot, seeded or not, and logs what it did:

```
[catalogue] 158 diagnostic(s) added, 158 rate(s) set from the tariff.
```

Every write is an upsert: a row the catalogue does not have is inserted, a row it does
is left exactly as the clinic has it. Rates are a three-way merge — see `src/db/rates.js`
— so one an administrator set by hand is kept and named in the log:

```
[catalogue]   kept CBC at 999 — the tariff says 110
```

Staff, patients, wards, beds, stock, insurers and ICD codes are **not** touched by this.
They are the clinic's state, not reference data, and nothing about them should change
because the app restarted.

## SQLite needs a persistent disk

The whole database is one file. On a platform with an ephemeral filesystem (Railway, Render,
Fly, Heroku), **every deploy or restart wipes it** unless you attach a volume.

**Railway:** add a Volume to the service, mount it at `/data`, then set:

```
DB_FILE=/data/samiha.db
BACKUP_DIR=/data/backups
APP_URL=https://your-app.up.railway.app
```

Without this the clinic loses its records on the next deploy. `APP_URL` also matters on its
own — password-reset links are built from it, so if it is wrong the links point at localhost.

## Recovery mailbox

Every password-reset link and every backup notice is copied to **`RECOVERY_EMAIL`**
(`samihahospital@gmail.com` by default). That means an account can always be recovered even
when the staff member has lost access to their own inbox — the administrator can pick the
link out of the clinic mailbox.

### Sending real email through Gmail

Gmail rejects your ordinary account password. Create an **App Password**:

1. The account needs **2-Step Verification** switched on.
2. Google Account → Security → 2-Step Verification → **App passwords**.
3. Create one for "Mail", and copy the 16-character value.

Then set:

```
MAIL_PROVIDER=smtp
SMTP_USER=samihahospital@gmail.com
SMTP_PASS=xxxxxxxxxxxxxxxx      # the App Password, no spaces
MAIL_FROM="SAMIHA Healthcare <samihahospital@gmail.com>"
APP_URL=https://your-domain
```

Restart, then **Account & System → Recovery & email → Send a test email** to prove it before
anyone needs it. The banner turns green when SMTP is connected.

Leave `MAIL_PROVIDER=mock` and nothing is actually sent — reset links are written to the
outbox and shown to the administrator instead, so the app works with no mail server at all.

## Forgotten password

**A staff member:** Sign-in screen → *Forgotten your password?* → enter email or staff code.
A link valid for 30 minutes arrives, and is copied to the recovery mailbox.

**An administrator, for someone at the desk:** Account & System → Staff access → *Send reset
link*. No need to know their current password.

Guardrails:

- The response is **identical whether or not the account exists**, so the endpoint cannot be
  used to discover who works at the clinic.
- **Five requests per account per 15 minutes**, so nobody's inbox can be sprayed.
- Only the **hash** of a token is stored; the token itself exists solely in the emailed link.
- Requesting a new link **invalidates the previous one**, and a link works **once**.
- Completing a reset **signs out every session** for that account.
- Passwords must be 8+ characters with a letter and a number, and must not be a common one.

## Seeing what you type

Every password field in the app — sign-in, reset, change password — has an **eye toggle**,
because a password you cannot see is the most common reason a correct login is rejected. The
reset and change-password screens also show a live strength meter, and refuse two entries that
do not match before anything reaches the server. A failed sign-in points at the eye and at
Caps Lock rather than just repeating "invalid credentials".

## Backups

A consistent snapshot is taken with SQLite's own online backup API — safe to run while the
clinic is mid-transaction, unlike copying the file by hand.

| Setting | Meaning |
|---|---|
| `BACKUP_DIR` | Where snapshots are written (default `./data/backups`) |
| `BACKUP_RETENTION` | How many to keep; older ones are pruned (default 14) |
| `BACKUP_HOUR` | Hour of the day for the automatic snapshot (default 2). Blank disables it |
| `BACKUP_EMAIL_ATTACH` | Attach the file to the notice, for databases under 20 MB |

A notice goes to the recovery mailbox after every snapshot, and a **failure** raises a
separate alert — a backup that quietly stops working is worse than none.

**Account & System → Backups** lists them, takes one on demand, and downloads any of them.

> **Download copies off the machine regularly.** A backup sitting on the same disk as the
> database is not a backup — it dies with the disk. The daily email notice is your reminder;
> turn on `BACKUP_EMAIL_ATTACH` while the database is still small, and move to an object
> store or an off-site copy as it grows.

**To restore:** stop the app, replace `DB_FILE` with the downloaded snapshot, restart.

## First-hour checklist for a real deployment

1. Attach a persistent volume and point `DB_FILE` and `BACKUP_DIR` at it.
2. Set `SESSION_SECRET` to a long random value
   (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
3. Set `APP_URL` to the real public URL, or reset links will not work.
4. Sign in as the administrator and **change every seeded password**, then set
   `AUTO_SEED=false`.
5. Configure SMTP and send a test email.
6. Take a manual backup, download it, and confirm it opens.
7. Serve over HTTPS and set `NODE_ENV=production` — session cookies are marked `Secure` only
   in production.

## Collecting by UPI

Every printed bill can carry a QR code for whatever is still owed. A patient
scans it with any UPI app and confirms; the payee, the amount and the invoice
number are already in the code, so the money that lands names the bill it paid.

Set the collection account once, under **Account & System → Clinic & payments**:

- **UPI ID** — the clinic's own collection VPA, `samiha@okicici` or
  `7200750420@ybl`. It is checked for shape before it is saved.
- **Payee name** — what shows in the patient's app before they confirm.

The settings screen draws a sample code for ₹1 from whatever is saved. Scan it
with your own phone before the first patient does: the account name your app
offers to pay is the one everybody will see.

A deployment can also supply these as `CLINIC_UPI_ID` and `CLINIC_UPI_NAME`,
which is what a fresh install starts with; anything set in the app wins, so a
clinic can move its collections to another account without a redeploy. The same
screen sets the clinic name, address, phone, email and GSTIN that print on the
letterhead of every document.

Until an ID is set, bills simply print without a payment code. Nothing is
guessed — a QR pointing at the wrong account is worse than no QR at all.

## The diagnostic catalogue

`lab_tests` holds two kinds of row.

A **panel** — a lipid profile, a complete blood count, a renal function test —
is what a patient is billed for, and it carries a rate.

A **component** (`component_of` names its panel) is one analyte inside that
panel: MCHC, direct bilirubin, the urine deposits. It carries the unit and
reference range the report is issued against, but no rate, and it is left out
of the doctor's order form and the cashier's charge board — a hundred
unsellable buttons only get in the way of the dozen that matter.

Give a component a rate under **Services & Rates** and it becomes a test the
clinic offers on its own: it appears on the order form and on the charge board
from that moment. Pricing a test is how the clinic says it sells it.

`GET /api/masters/catalogue` and `GET /api/masters/lab-tests` return what is
sellable; both take `?all=1` for the whole catalogue, which is what the rates
screen asks for.

The starter catalogue in `src/db/diagnostics.js` came from a health-checkup
report the clinic runs, with the report's own units and ranges, plus a
radiology list covering the views a request actually names — chest PA and
lateral, left ankle, PNS, OPG, TVS, carotid Doppler — because a single "X-ray,
per part" cannot carry that and a radiographer who has to guess the view will
shoot the wrong one. Radiology is ordered down the body rather than down the
alphabet, so the X-ray list opens on the chest and ends with the contrast
studies.

Nothing in it is priced — a guessed rate would put a wrong figure on a real
patient's bill — and the seed's upsert leaves a price alone once set, so
re-seeding never undoes the clinic's tariff.

### Switching off what the clinic does not do

No clinic does all of any catalogue. The **Offered** switch on each row of
Services & Rates takes an item out of use: it leaves the doctor's order form
and the cashier's charge board immediately, but it is not deleted, so a bill
already raised still reads correctly. A department without fluoroscopy switches
off the barium studies and the IVP; one without an ultrasound probe switches
off the scans. The tile at the top counts what is offered against the whole
catalogue.

## Who may see money

The dashboard is read by everybody in the building — the technician at the
bench, the nurse at the station, the pharmacist at the counter. What the clinic
took today is not their work, so they do not see it.

Rupees on the dashboard and in Reports are limited to three roles: **admin,
cashier and financial counsellor**. Everyone else gets the same board without
the money: the day's visits, appointments, diagnostics, beds, the doctor list,
the queue and what needs chasing in their own department. The fourth tile,
which shows *Collected today* to the money desks, shows *Diagnostics today* to
everybody else rather than leaving a hole.

It is enforced on the server, not by hiding a tile. `GET /api/reports/dashboard`
sends `revenue: null`, `pharmacy.salesToday: null` and `insurance.receivable:
null` to anyone else, and `GET /api/reports/trend` drops its `collected` column
— absent rather than zeroed, because a zero is a figure and a wrong one. The
money drill-downs (`collections`, `outstanding`, `trend_collected`,
`revenue_*`, a doctor's billed and collected months) answer 403 to everyone
else, so nothing can be read out of the network tab either.

### The till is the cashier's

Reception books, registers and moves patients through the clinic. It does not
touch billing at all: no Billing screen, no invoice, no payment, no day-book,
and no *prepare bill* or *check out* on a visit — those two steps are money,
and money is one desk's. A patient's record opens for reception without its
invoices or its outstanding balance, and a household's unpaid total is left out
of the family list.

The cashier raises and settles bills. The counsellor reads them and gives what
they are there to give — the sliding scale, assistance, a payment plan, a
documented exception — but does not open new bills or take cash. A doctor and
the ward may read a bill (a patient asks what a procedure costs; a ward needs
the running total before a discharge) and may not change one.

The pharmacist keeps the pharmacy's own bills and till on the Pharmacy screen,
which is theirs to reconcile at handover.
