# Document passwords

Every file HR Scoring hands out is locked with the **document password of the person downloading it**:

| Download | Where | Locked as |
|---|---|---|
| Candidate report PDF (download or view) | Review, Results | PDF, AES-256 |
| HR draft preview PDF | Review | PDF, AES-256 |
| A day's reports (zip) | Results | each PDF inside, AES-256 |
| Results workbook | Results | Excel, AES-256 (ECMA-376 agile) |
| Data exports: schedule, raw scores, scores, team aggregates, judge analytics, rankings | Rankings | Excel, AES-256 (these were CSV, which can't carry a password) |
| The schedule as on screen, drafts included | Schedule → Export | Excel, AES-256 (the page sends the table to the server to be locked) |

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
