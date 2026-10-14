# Task Management App — Context

_Last updated: 14 October 2026_

## What this is

A personal task management app, built for Rory McClelland, whose job is to give
**one place to see and prioritise everything that currently sits in separate
systems**.

This is not a Lunatask clone and not a team tool. It is a single-user oversight
layer plus the parts of a task manager that are actually used day to day.

## The problem

Tasks currently accumulate in at least four places, with no single view:

| Source | What lands there |
|---|---|
| Claude | Work started or promised during conversations; follow-ups |
| Gemini | The same, in a second assistant |
| Lunatask | The deliberate, curated task list and calendar |
| Local machine | Files, notes, half-finished work that implies tasks |

The cost is not that any one list is bad — it is that no list is complete. There
is no single place that answers "what should I be doing now?" with confidence.

## Scope decisions already made

- **Lunatask usage is narrow.** Only task management and the calendar are used.
  The notes, habits, mood tracking and contact tracking features are not used
  and are explicitly out of scope for any replacement.
- **Prioritisation is Eisenhower.** Urgency × importance is the working model for
  deciding what to do, so the data model and the main view need to support it
  natively rather than bolting it on as a tag.
- **Single user.** No sharing, no collaboration, no multi-tenancy.

## How we build it

Same working pattern as the Bolt prototypes:

- Claude writes the code.
- Rory reads it and questions it — so the code needs to be readable and the
  reasoning behind structural choices needs to be explicit, not implied.
- Everything lives in a git repo pushed to GitHub, committed in reviewable
  increments rather than large drops.

## Current status

**Phases 0–5 are built** (14 Oct 2026): a local web app with one list
across all sources, quick capture, complete/drop with undo, duplicate merging,
and an Eisenhower matrix as the default view. Tasks move between quadrants by
drag or keyboard, due dates raise urgency automatically, and an overfull
"Do now" is flagged. Phase 3 pulls tasks in: Lunatask is mirrored over its
API, Claude and Gemini tasks arrive by pasting a block or dropping a file in
an inbox folder, and checkboxes/TODOs in your notes folders are mirrored.
Phase 4 adds time: your calendar (read from its .ics address) beside the
list in a Day view, tasks slotted into it, the free time left, and an
Ahead view of the next 14 days. Phase 5 keeps it believable: idle tasks
are flagged, a one-card-at-a-time review clears what needs deciding, and
a failed or stuck sync shows as a red banner.
See `README.md` to run it.

## Sync direction per source (backlog 3.5)

Every source is **read-only** for now — nothing here is written back. Reasons
in `docs/DECISIONS.md`, D8.

| Source | Direction | How it arrives | What closes it here |
|---|---|---|---|
| Lunatask | Mirror (read-only) | API, every 15 min | Completed or deleted in Lunatask |
| Claude | Push in, one-way | Paste a block, or a file in the inbox | Only you, here |
| Gemini | Push in, one-way | The same | Only you, here |
| Files on this computer | Mirror (read-only) | Scan of `LOCAL_FOLDERS` | Ticked or deleted in the file |
| Calendar (Google / Outlook / iCloud) | Read-only, events not tasks | Private .ics address, every 15 min | n/a: events aren't stored here (D11) |

Known gap: completing (or scheduling) a Lunatask task here doesn't change it in Lunatask.
If that becomes annoying, completion write-back is the first to add.

## Open decisions

Settled on 14 Oct 2026 (reasons in `docs/DECISIONS.md`):

- ~~Stack~~ → local Node + TypeScript web app (D1).
- ~~Where data lives~~ → one JSON file behind a swappable storage interface (D2).
- ~~Lunatask integration route~~ → API mirror; Lunatask encrypts task names,
  so they're named here once (D7). An export importer could fill names in
  later.
- ~~Claude and Gemini capture route~~ → deliberate capture: paste a block or
  drop a file in the inbox; no scraping (D9).
- ~~Where the calendar comes from~~ → the calendar's own .ics address;
  Lunatask has no calendar API (D11).

Still open:

5. **Whether this replaces Lunatask or sits above it.** The backlog is written so
   either answer stays possible, but it affects how much of the task manager
   proper needs building.
