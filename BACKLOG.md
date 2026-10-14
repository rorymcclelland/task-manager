# Task Management App — Backlog

_Last updated: 14 October 2026 · Status: Phases 0–3 built; Phase 4 next_

Organised by **job to be done**, in phases. Each phase should be usable on its
own — the aim is that the app earns its place from Phase 1, not after Phase 5.

Items are written as job stories so the reason for each is visible:
_When [situation], I want to [motivation], so I can [outcome]._

---

## Phase 0 — Foundations ✅

The minimum scaffolding needed before anything else is worth writing.

- **0.1 Repo and working agreement.** Git repo created, pushed to GitHub, with a
  README that states what the app is and how to run it.
- **0.2 Stack decision, written down.** Pick the stack and record _why_ in the
  repo, so the choice can be questioned later on its merits.
- **0.3 Task data model.** One schema that can represent a task from any source:
  title, notes, source system, source link/ID, importance, urgency, due date,
  scheduled date, status, created/updated timestamps.
- **0.4 Storage.** A persistence layer behind a thin interface, so the
  local-file-versus-database decision can be reversed without rewriting the app.

---

## Phase 1 — One list I can trust ✅

_The single job that justifies the project: see everything in one place._

- **1.1** When tasks are scattered across systems, I want to see them all in a
  single list, so I can stop holding the gaps in my head.
- **1.2** When I look at a task, I want to see which system it came from, so I
  know where to go to act on it or close it.
- **1.3** When I spot something that needs doing, I want to add it in one or two
  keystrokes, so capture never loses to friction.
- **1.4** When a task is done or no longer real, I want to complete or drop it,
  so the list stays believable.
- **1.5** When the same task has arrived from two sources, I want to merge or
  dismiss the duplicate, so one real task shows up once.

---

## Phase 2 — Prioritisation that matches how I decide ✅

- **2.1** When I review my list, I want to place tasks on an Eisenhower matrix
  (important/urgent), so prioritisation uses the model I already think in.
- **2.2** When I open the app, I want the top-left quadrant — important and
  urgent — to be what I see first, so the default view answers "what now?".
- **2.3** When importance or urgency changes, I want to move a task between
  quadrants quickly, so re-prioritising is cheap enough to actually do.
- **2.4** When a task has a due date, I want urgency to reflect that date
  automatically, so time passing updates my priorities without my input.
- **2.5** When a quadrant is overloaded, I want to see that plainly, so I notice
  when "urgent and important" has stopped meaning anything.

_Built as: matrix is the default view; drag or keys 1–4 to move; due within
3 days = urgent; "Do now" flagged above 5. Reasons in D5 and D6._

---

## Phase 3 — Pulling in the sources ✅

Each source is independent — build whichever is cheapest to prove first.

- **3.1 Lunatask.** When my curated tasks and calendar live in Lunatask, I want
  them visible in this app, so the oversight view is complete.
  _Depends on open decision: API vs export._
- **3.2 Claude.** When I agree to do something in a Claude conversation, I want
  it to reach this list, so commitments made in chat do not evaporate.
- **3.3 Gemini.** The same for Gemini.
- **3.4 Local machine.** When work-in-progress files on my machine imply a task,
  I want a way to surface or register that, so local work is not invisible.
- **3.5 Sync direction.** Decide per source whether it is read-only (mirror),
  write-back (completing here completes there), or two-way — and record the
  choice in `CONTEXT.md`.

_Built as: Lunatask mirrored over its API every 15 minutes — names are
encrypted by Lunatask, so each task is named here once (D7). Claude and
Gemini by pasting a block of lines or dropping a file in the inbox folder
(D9). Checkboxes and TODOs in `LOCAL_FOLDERS` mirrored (D10). Every source
read-only (D8). A "Sources" line shows each sync's result or error — the
start of 5.3._

_Possible follow-ups: fill in Lunatask names from an export file (needs a
sample export to build against); write completion back to Lunatask._

---

## Phase 4 — Time

- **4.1** When planning a day, I want to see my calendar alongside the list, so
  priorities meet the time actually available.
- **4.2** When a task needs doing at a particular time, I want to schedule it,
  so it has a slot rather than just a rank.
- **4.3** When I look ahead, I want to see what is due and when, so nothing
  arrives as a surprise.

---

## Phase 5 — Keeping it honest

The maintenance jobs that decide whether the system survives month two.

- **5.1** When tasks go stale, I want them flagged, so the list does not quietly
  fill with things I will never do.
- **5.2** When I sit down to review, I want a review flow — triage, re-prioritise,
  drop — so the review is a few minutes rather than an afternoon.
- **5.3** When a sync fails, I want to know, so I never trust a list that has
  silently stopped updating.

---

## Phase 6 — Later, maybe

Explicitly deferred. Written down so they stop occupying thinking space.

- Mobile or phone-friendly view.
- Recurring tasks.
- Projects or hierarchy above individual tasks.
- Effort/time estimates and capacity planning.
- Any reporting or analytics on completion.
- **Not in scope at all:** notes, habits, mood tracking, contact tracking.

---

## Reminder of how we work

Claude writes the code; Rory reads and questions it. Small, reviewable commits in
a GitHub repo. Structural choices get a written reason, not just an
implementation.
