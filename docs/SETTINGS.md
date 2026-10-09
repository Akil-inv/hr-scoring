# Settings: switching features off without losing them

Some teams want a simpler system. These switches turn features off without
removing them; switching back on brings each one back exactly as it was.

## Platform settings (super admins: sidebar → Settings)

| Switch | On (default) | Off |
|---|---|---|
| **File passwords on downloads** | Every report PDF and Excel export opens with the first four letters of its name + the downloader's HR code ([DOCUMENT-PASSWORDS.md](DOCUMENT-PASSWORDS.md)). | Files download unlocked; nobody needs an HR code; the HR code card on My account says so. Each download is still in the audit log, marked "Unprotected download". |
| **Two-factor sign-in** | People can turn on an authenticator-app code (My account) and are asked for it at each sign-in. | Nobody is asked for a code and the option is hidden. People who had set it up keep their set-up (secrets and recovery codes stay, encrypted), so it applies again when switched back on. |

- Platform-wide, and immediate: read on each sign-in and each download, on
  every API instance; no restart.
- Changing one needs the super admin's sign-in password; each change is in the
  audit log ("… turned off/on").
- Stored in `platform_settings` (one row). Two-factor is switched through
  auth-kit 0.3.0's `twoFactor` option.

## Per event: whole-number scores (Event Control → the event → Scoring)

- **Whole numbers only**: judges score 3 or 4, never 3.75, whatever steps the
  rubric allows (the workbook's "Score step" column; default 0.25). The
  rubric itself is not changed, so switching back restores its steps.
- Event admins can change it **until the first judge starts scoring**, so
  every candidate in an event is scored the same way. Recorded in the event's
  recent changes and audit log.
- Applied where scores are checked (the API refuses 3.75) and in the judge's
  scoring screen (steps of 1).
- A whole-number rubric can still be set from the workbook: Score step = 1.
