# Event Control and running several events

The platform runs any number of events side by side. Each event is private to
the people on it; **Event Control** (sidebar, top item) is where events are
created, run, closed and finally reduced to a record.

## Who sees what

| | Every staff user | People on the event | Super admins |
|---|---|---|---|
| Event name, status, dates | ✓ | ✓ | ✓ |
| The event's admins (name, email) | ✓ | ✓ | ✓ |
| Its other people, progress, candidates, scores, schedules, reports, exports | | ✓ | ✓ |

- What a person may do on an event depends on **their role on that event**
  (Admin, Coordinator, Panel chair, Auditor), not their platform role. A
  platform auditor can be an admin of one event and see nothing of another.
- The platform role still decides what happens outside events: platform
  **Admins** (and super admins) can create events; **super admins** manage
  accounts (Users & roles: creating accounts, invite and reset links, deleting
  accounts) and can open every event. Account actions are super-admin only
  because a reset link signs its holder in as that person.
- Judges and team reps don't use the main app; they keep their own links.

Enforced in the API, not just hidden in the app:

- GraphQL: every id an operation names (event, team, session, judge, room,
  scorecard, …) is looked up, and all of them must belong to one event the
  caller is on (`src/auth/event-access.ts`, `event-scope.guard.ts`). An
  operation that doesn't say how it is scoped is refused, and a test
  (`event-scope.coverage.spec.ts`) fails if any operation in the schema or any
  REST handler hasn't decided.
- REST (review, reports, schedule, judge links, exports, imports, judge
  notifications, workbook setup) runs the same check in each handler.
- Ids must be in their canonical form (other spellings the database would
  accept are refused rather than skipped).
- Judge notifications go only to the judge's own stored email and phone, with
  a link made by the server (on `APP_URL` when set).

## Several admins

- Whoever creates an event is its first admin; co-admins can be added when
  creating it or later.
- Any admin of an event can add, re-role or remove people on it (existing
  staff accounts; new accounts are created by a super admin).
- An event always keeps at least one admin: the last one can't be removed or
  demoted (checked under a lock, so two admins removing each other at once
  can't both succeed).

## Lifecycle

Draft → Active → Closed → Archived → **Done (record only)**

- **Draft**: only its admins work on it; set it up (Excel upload or wizard).
- **Start**: Draft → Active.
- **Close**: interview events need every day closed (Results page); judge links
  stop and scores lock. The close date starts the retention clock.
- **Archive**: read-only; reports and exports stay available.
- **Done**: see below. Nothing in a done event can change afterwards (except
  who is on it).

## Retention

- Chosen when the event is created: **3, 4, 5 or 6 months after it is closed**
  (can be changed within that range until it is done).
- Admins can **extend** it at any time, before or after it runs out, by 1–12
  months at a time with a reason. Every extension is in the audit log.
- Nothing is removed automatically. When the period is over the event shows
  as **Due** in Event Control (with a notice to its admins); an admin either
  extends it or marks it done.

## Marking an event done

Only after its retention period, only by an admin of the event, who types the
event's name and their sign-in password. Cannot be undone. In one transaction:

- **Removed**: candidates' names, contact and application details; team
  members; report PDFs; HR feedback, judges' written comments and notes;
  messages to judges; judge links.
- **Kept as the record**: event name, dates, admins and totals; scores and
  decisions, anonymised as "Candidate #0001"…; the audit log, with the
  before/after values cleared and candidate names in its text replaced by the
  same labels.

What is removed and kept is defined in one place
(`DONE_REMOVES` / `DONE_KEEPS` and `removeCandidateData` in
`apps/api/src/event-control/event-control.service.ts`) so it can change with
what people expect.

## On deploy

Migration `20261005140000_event_control` adds the retention fields and keeps
everyone's access exactly as it is today:

- Existing assignments take the person's platform role (until now the role on
  an assignment was never used; the platform role decided).
- Every staff user with no assignments (who could reach every event) is put on
  every current event in their platform role.
- Users already assigned to some events keep exactly those.

Afterwards, tighten it in Event Control. An event can end up with no admin (if
none of its people is a platform admin); a super admin can add one.
