# Making this a product

A running note of the places where the platform assumes this particular event.
Nothing here is a defect — building for one event first was deliberate — but
each is a seam that will need cutting if the tool is used somewhere else.

Kept as a list rather than a plan. Add to it when something new gets hardcoded.

---

## The grouping dimension

**Where:** `apps/web/src/components/platform-chip.tsx`

The platform palette — AWS orange, GCP amber, Cloudera red, Qlik green, Purple
Fabric purple, Internal blue — is a map of one industry's vendors, and the six
values are baked into the component. `teams.service.ts` validates against the
same list at import.

The concept is general: every event has some dimension that decides who attends
which session. Platform here; department in a healthcare setting; funding stage
in a startup competition; sponsor track almost anywhere.

**What it becomes:** an event defines its own grouping dimension — a label, a
list of values, a colour each. The chip and the card tint read from that rather
than a constant. Nothing about the rendering changes.

---

## Country, home country, and what "remote" means

**Where:** `apps/api/src/scheduling/passes.ts`, `apps/web/src/components/country-flag.tsx`

Two assumptions are wired in. The seven participating countries are a fixed
list, and Singapore is home — anything else is remote and therefore needs a
room with video conferencing.

The flag rendering itself generalises perfectly: an ISO code becomes an emoji
with no assets and no licensing question.

**What it becomes:** home country and the participating list are event
settings. Remote is derived, as it is now, so the video conferencing rule
follows without being restated.

---

## Timezone ordering

**Where:** `apps/api/src/scheduling/passes.ts` — `HOURS_BEHIND_SG`

Countries are ordered so that those sharing Singapore's offset are scheduled
first, letting the ones an hour behind start once their local clock has caught
up. The offsets are a hardcoded map, and Indonesia is assumed to be Jakarta.

**What it becomes:** offsets derived from the country codes rather than
declared, relative to whichever country is home.

---

## The judge tiers

**Where:** `schema.prisma` — the `JudgeTier` enum; `anchors.ts`

L1 leadership, L2 MD, L3 ED, L4 senior, PS professional services, V vendor.
That is one bank's hierarchy. The *shape* is general — some judges anchor a
room all day, some rotate, some attend only their own vendor's sessions, some
are held back for a final round — but the labels are not.

Anchoring logic reads the tier strings directly, so renaming them means
touching the allocator.

**What it becomes:** tiers defined per event with a role rather than a name:
anchors, rotates, restricted-to-matching, held-back. The allocator reads roles.

---

## The scoring rubric

**Where:** `apps/api/src/scoring-templates/uob-rubric.ts`

Already close to right. It is loaded by a button rather than seeded
automatically, and everything it creates is ordinary editable data. The two
level structure — categories with scoring rows beneath — is general.

**What it becomes:** more than one rubric available to load, or an import
format so an organiser can bring their own. Small.

---

## Session length, day structure, break pattern

**Where:** event settings and `anchors.ts`

Twenty minute sessions and a lunch break come from the event record, so those
are fine. The four-on-one-off cover pattern is a constant in `anchors.ts`.

**What it becomes:** cover interval as an event setting.

---

## What already generalises

Worth recording so it does not get rebuilt.

**The two-level criteria tree.** Categories and rows, validated against a total.
No assumption about what the criteria are.

**Anchor allocation.** Assign a fixed judge per room-day, compute the load,
report shortfalls. Reads tiers but the logic is generic.

**Sequential passes.** A list of team groups, each solved with the previous
locked. The passes are currently built by hardcoded rules, but the machinery
that runs them takes any list.

**The availability matrix.** Email, date, AM/PM/BOTH. No event-specific
assumptions at all.

**Everything about scoring, ranking and the judge portal.** Rubric-agnostic
once the rubric itself is data.

---

## The honest summary

The engine is general. The rules that drive it are not.

Roughly: `passes.ts` and `platform-chip.tsx` hold most of the event-specific
logic, `anchors.ts` holds a little, and the rest of the platform does not care
what event it is running.

A product version means moving those rules out of code and into event
configuration — which is a real piece of work, but a contained one, and it does
not require rewriting anything that currently works.
