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
report the clinic runs, with the report's own units and ranges. Nothing in it
is priced — a guessed rate would put a wrong figure on a real patient's bill —
and the seed's upsert leaves a price alone once set, so re-seeding never undoes
the clinic's tariff.
