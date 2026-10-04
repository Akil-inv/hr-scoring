# Field encryption: operator guide

Candidate data is stored encrypted in Postgres and decrypted by the API only
when a screen, export or PDF needs it. A copy of the database, a backup or a
disk snapshot on its own shows only `enc:v1:…` / `det:v1:…` text and
encrypted PDF bytes.

This guide is for whoever runs production. Everything is done with two
scripts, so nobody has to edit AWS policies by hand:

| | |
|---|---|
| `tools/encryption/setup-aws-kms.sh` | one-time AWS setup (CloudShell) |
| `./encryption.sh` | everything on the server afterwards |

## Contents

1. [What is encrypted](#what-is-encrypted)
2. [How it works](#how-it-works)
3. [Turning it on](#turning-it-on)
4. [Break glass: when KMS is unavailable](#break-glass)
5. [Switching it off](#switching-it-off)
6. [Other situations](#other-situations)
7. [Running it as a product](#running-it-as-a-product)

## What is encrypted

| Table | Fields |
|---|---|
| Candidates (`teams`) | name*, project name, lead name and email, statements, notes |
| `team_members` | name, email |
| Judges | name, email*, phone, organisation, designation |
| Scorecards | strengths, improvements, recommendation, reopen reason, **total score**, **support Yes/No** |
| Criterion scores | **score**, comment |
| HR decisions | comments, reopen reason |
| PDF reports | the PDF itself, file name, superseded reason |
| Audit log | old / new values, reason |
| Judge messages, conflicts, session notes | the text |

\* These are encrypted deterministically (the same value always encrypts the
same way), so exact lookups still work: a candidate by name within an event,
a judge by email. Everything else uses a fresh random IV each time and can't
be searched in the database. Emails are stored in lower case.

Not encrypted:
- user accounts (HR admins log in by email);
- event, room, schedule and rubric setup;
- the decision outcome (Selected / Waitlist / …);
- dates.

## How it works

- **One data key** (256-bit) encrypts every value with AES-256-GCM, which
  also detects tampering.
- **AWS KMS protects the data key.** On first start the API asks KMS for a
  data key and stores only the KMS-wrapped copy, in `data_keys`. On every
  start it asks KMS to unwrap it, and holds it in memory until it stops.
  AWS logs each unwrap.
- **The recovery key is the same data key**, printed once on paper or saved
  to a vault (`HRK-v1-…`). It lets you run without KMS: see
  [Break glass](#break-glass).
- **A fingerprint is stored with the key.** It lets the app tell whether a
  key it is given is the right one, and refuse it if not. It reveals nothing
  about the key.
- **The app never runs half-encrypted.** It refuses to start in three cases,
  and its log says what to do:
  - it cannot unlock the key;
  - it is given the wrong key;
  - the data is encrypted but no key is set.
- **Data written earlier is encrypted on the first start** with a key. This
  takes seconds; later starts skip values that are already encrypted.

## Turning it on

**1. AWS (once, about 5 minutes).** Open AWS CloudShell in ap-southeast-1,
upload `tools/encryption/setup-aws-kms.sh`, and run:

```bash
bash setup-aws-kms.sh --instance-id i-0123456789abcdef0 --alert-email you@company.com
```

Add `--dry-run` first to see what it would do. It:
- creates the key `alias/hr-scoring` with automatic yearly rotation;
- sets a key policy under which **only the account's root user** can
  disable the key or schedule it for deletion, so admin users can't do it,
  even by mistake;
- lets the server's IAM role use this key, and only this key;
- lets the app's container reach the server's credentials (metadata hop
  limit 2);
- emails you on any attempt to disable, delete or re-permission a KMS key,
  and turns CloudTrail on if it is off.

Confirm the subscription email AWS sends you.

**2. Server.** In the hr-scoring folder:

```bash
docker-compose exec -T postgres pg_dump -U hackathon hackathon | gzip > ~/hr-before-encryption.sql.gz
echo 'KMS_KEY_ID=alias/hr-scoring' >> .env
DEPLOY_BRANCH=feature/interview-availability ./deploy.sh
./encryption.sh status
```

`status` should show that the key is wrapped by AWS KMS and that every value
is encrypted (`N encrypted, 0 plain`).

**3. Print the recovery kit. Do not skip this.**

```bash
./encryption.sh recovery-kit
```

Store what it prints offline: in a password-manager vault, or printed and
kept in a safe, with two people knowing where. Anyone holding it plus a
database copy can read everything, so guard it like the HR files
themselves. The app's Users page warns super admins until the kit has been
printed.

**4.** Once the app reads correctly: `shred -u ~/hr-before-encryption.sql.gz`.

## Break glass

When KMS can't be used, the app stops at start-up and its log says
`Could not unlock the encryption key with AWS KMS…`. Typical causes are a
changed IAM policy, a disabled key, an AWS outage, or a key scheduled for
deletion. A running app is not affected: it unlocked the key when it started.

**Get running now:**

```bash
./encryption.sh break-glass
```

Paste the recovery key when asked; it isn't shown on screen. The script
checks the key against this data before changing anything, then restarts
the app on it. Users see everything as normal. Super admins see an amber
"Running on the recovery key" notice on the Users page.

**Then fix KMS.** The usual causes, and their fixes:

| Cause | Fix |
|---|---|
| IAM role policy changed | run `setup-aws-kms.sh` again |
| Key disabled | root user: KMS console → the key → *Enable* |
| Key scheduled for deletion | root user: KMS console → the key → *Cancel key deletion*, then *Enable* |
| Key gone for good | run `setup-aws-kms.sh --alias alias/hr-scoring-2`, then set `KMS_KEY_ID=alias/hr-scoring-2` in .env |

**Back on KMS:**

```bash
./encryption.sh restore-kms
```

This puts the data key back under the KMS key named by `KMS_KEY_ID`, takes
the recovery key out of `.env`, and restarts. The `.env` backups the script
makes never contain the recovery key.

## Switching it off

```bash
./encryption.sh decrypt-all
```

You confirm by typing `DECRYPT`. The command then:
1. stops the app for a minute;
2. stores every value unencrypted again (scores back in their normal
   columns, PDFs as plain PDFs);
3. removes the key and takes the key settings out of `.env`;
4. starts the app again.

If anything is left encrypted, it keeps the key and changes nothing. It
needs the key, so it works with KMS or after a break-glass start. Take a
backup first.

To turn encryption on again later, follow [Turning it on](#turning-it-on)
again. A new key is made, so print a new recovery kit.

## Other situations

| Situation | What to do |
|---|---|
| What state is it in? | `./encryption.sh status`. Super admins also see it on the Users page. |
| Does the key still unlock? | `./encryption.sh check`. It unlocks the key exactly as the app would. |
| Move to a different KMS key or AWS account | Give the server's role access to the new key, then `./encryption.sh move-to-kms <alias or ARN>` |
| No AWS (another cloud, on-premise) | Put a key in .env as `FIELD_ENCRYPTION_KEY` (`openssl rand -base64 32`), and keep a copy offline: it is the recovery key. Move to KMS later with `move-to-kms`. Weaker, because the key sits on the same server as the data, but backups and copies stay protected. |
| Restore a backup | Restore as usual. It opens with the same key, because the wrapped key is in `data_keys` inside the backup. |
| Rotate the key | KMS rotates its own key material yearly with no action needed. Rotating the data key itself (re-encrypting every value) isn't built yet; stored values carry a key version so it can be added. |

**Rules from now on**
- Never delete the `data_keys` table or its rows.
- Never run `docker-compose down -v` (it deletes the database).
- Keep the recovery kit offline. It must not be stored on the server or in
  git, and it must not be sent in chat or email.

## Running it as a product

The pieces above are designed so a customer, or a hosting partner, can run
production without the developers involved.

**Deployment model: one deployment per customer.** Each customer gets their
own server, database and key, so one customer's data can never be decrypted
with another's key, and offboarding is clean.

**Who holds the key: three options to offer.**

| Option | Who holds the KMS key | Good for |
|---|---|---|
| Hosted | The vendor's AWS account, one key per customer | Smaller customers; simplest |
| Customer-managed key ("bring your own key") | The customer's AWS account, with a grant letting the vendor's server use it | Banks and regulated HR: the customer can cut off access at any time, and each use shows in *their* CloudTrail |
| Self-hosted | The customer runs everything, with KMS or a local key | Customers who must keep data on-premise |

Customer-managed key works with what is built now. The customer creates the
key and allows the server's role (in the vendor's account) to use
`GenerateDataKey` / `Decrypt` / `Encrypt`. `KMS_KEY_ID` is then the full ARN
of the customer's key.

**Responsibilities** (for the contract or service description):

- **The customer:**
  - holds the recovery kit (two named people);
  - receives the key alerts;
  - approves any `decrypt-all`.
- **The operator:**
  - runs `setup-aws-kms.sh`;
  - deploys and patches;
  - checks `./encryption.sh status` after each deploy;
  - runs break glass with the customer's key holder present.
- **Offboarding:** export the data, then the customer disables or deletes
  the key. Every copy and backup becomes unreadable ("crypto-shredding"),
  with no need to hunt down copies.

**Before selling to regulated customers, consider adding:**
- an audit trail entry each time the recovery kit is printed or break glass
  is used (today these go to the server log only);
- a split recovery kit, where two of three holders are needed to rebuild
  the key (Shamir sharing), for customers who require dual control;
- data-key rotation (re-encrypting all values with a new key);
- encrypted backups shipped off the server on a schedule (separate from
  field encryption).
