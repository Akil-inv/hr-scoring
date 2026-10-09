# Document passwords

> Super admins can switch file passwords off for the whole platform (Settings); see [SETTINGS.md](SETTINGS.md).

Every file HR Scoring hands out is locked with a password made from **what the file is about plus the downloader's HR code** (see below):

| Download | Where | Locked as |
|---|---|---|
| Candidate report PDF (download or view) | Review, Results | PDF, AES-256 |
| HR draft preview PDF | Review | PDF, AES-256 |
| A day's reports (zip) | Results | each PDF inside, AES-256 |
| Results workbook | Results | Excel, AES-256 (ECMA-376 agile) |
| Data exports: schedule, raw scores, scores, team aggregates, judge analytics, rankings | Rankings | Excel, AES-256 (these were CSV, which can't carry a password) |
| The schedule as on screen, drafts included | Schedule → Export | Excel, AES-256 (the page sends the table to the server to be locked) |

## Each file has its own password: name prefix + HR code

A file's password is the **first four letters of what it's about, in capitals, followed by the downloader's HR code** (the personal secret, stored as the "document password"):

| File | Prefix from | Example (HR code `k7#pQ29xLm`) |
|---|---|---|
| A candidate's report or preview | the candidate's name | Priya Menon → `PRIYk7#pQ29xLm` |
| Each report inside a day's zip | that candidate's name | Daniel Koh → `DANIk7#pQ29xLm` |
| Results workbook, data exports, schedule export | the event's name | October Graduate Interviews → `OCTOk7#pQ29xLm` |

- Letters and digits only, accents dropped (`Zoë` → `ZOEA`), apostrophes and spaces ignored (`O'Brien` → `OBRI`). Shorter than four: padded with `X` (`Li` → `LIXX`); a name with no Latin letters is `XXXX`.
- So a password typed or shared for one candidate's report doesn't open another candidate's. Sharing one file's password does give away the HR code, so the code stays secret and long (at least 10 characters); the prefix is not a secret.
- The app says what each file opens with: the PDF viewer shows the prefix, and after a download a note reads "It opens with PRIY + your HR code" (zips: "each report opens with the first four letters of the candidate's name…"). The API sends it in the `X-Password-Prefix` response header and records it in the download's audit entry.
- In the app this is called the **HR code** (My account → HR code).

**The document password is personal.** Each user sets it once on **My account → Document password**, after re-entering their sign-in password. It must differ from the sign-in password and follows the same rules: at least 10 characters, not containing the email name, and not a common password.

Until it's set, downloads are refused with a message pointing to My account.

**The same report downloaded by two people gives two files**, each opening only with its downloader's password.

**Once opened:** printing is allowed. Copying text, editing, annotating and form filling are not. These are standard PDF permissions, which the usual readers honour (Acrobat, Preview, browsers). Each file's owner password, which would lift them, is random and never stored.

**Forgotten document password:** set a new one on My account and download again. Files downloaded earlier still need the old one. There is no recovery, by design. If the sign-in password is also forgotten, an admin sends a reset link first.

**Stored where:** in `users.document_password`, encrypted by the app (`enc:v1:`) like other sensitive fields, and counted by `./encryption.sh status`. On an install with field encryption switched off, it is stored as plain text like everything else. It's never returned by the API; the app only shows whether it's set and when.

Viewing a report inside the app asks for it too: the file shown is the same locked file a download gives.

**Audit:** setting it, and every protected download, is recorded in the audit log, with who did it, which event and what kind of file.

## Running it

- The API image installs **qpdf** (`apps/api/Dockerfile`). Without it the API logs a warning at start-up, and PDF downloads answer 503 rather than going out unprotected.
- Unprotected copies never touch the disk if it can be helped: qpdf works in a private folder in `/dev/shm` (memory), deleted straight after. Passwords go to qpdf in an argument file, not on the command line.
- The stored reports are unchanged: still encrypted in the database (`ENC1`), and locked per person only when downloaded.

## Limits worth knowing

- A password protects the file, not what someone does after opening it. A person who can open it can still photograph the screen, or tell someone the password.
- Copy and edit restrictions depend on the reader respecting them. The encryption itself (who can open the file) doesn't.
- **Schedule → Print** opens a printable page in the browser; what the browser prints (or saves as PDF) isn't locked.
- The rule "different from the sign-in password" is checked when the document password is set. Changing the sign-in password later doesn't re-check it.
- Locking a large Excel file takes up to about a second. It runs on a separate thread, so other people's requests aren't held up.
