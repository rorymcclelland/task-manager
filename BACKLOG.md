# Task Management App — Backlog

_Last updated: 14 October 2026 · Status: Phases 0–6 built; Phase 7 is the deferred list_

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

## Phase 4 — Time ✅

- **4.1** When planning a day, I want to see my calendar alongside the list, so
  priorities meet the time actually available.
- **4.2** When a task needs doing at a particular time, I want to schedule it,
  so it has a slot rather than just a rank.
- **4.3** When I look ahead, I want to see what is due and when, so nothing
  arrives as a surprise.

_Built as: your calendar read from its private .ics address (D11). Lunatask
has no calendar API. Tasks get a day plus an optional time slot, set by
dragging in the new Day view, `s` for the next free gap, the edit panel,
or `on:`/`at:` in capture (D12). Lunatask's date now only overrules yours
when Lunatask changes it. Day shows the timeline beside the list and the
free time left; Ahead shows 14 days, plus overdue and "planned for an
earlier day" (D13)._

_Possible follow-ups: write slots back to the calendar as events; a week
grid; free time that knows weekends from weekdays._

---

## Phase 5 — Keeping it honest ✅

The maintenance jobs that decide whether the system survives month two.

- **5.1** When tasks go stale, I want them flagged, so the list does not quietly
  fill with things I will never do.
- **5.2** When I sit down to review, I want a review flow — triage, re-prioritise,
  drop — so the review is a few minutes rather than an afternoon.
- **5.3** When a sync fails, I want to know, so I never trust a list that has
  silently stopped updating.

_Built as: tasks untouched for 30 days (7 in Do now) with no date ahead are
flagged idle; syncs don't count as touching (D14). A Review button opens
one card at a time: unplaced, unnamed, overdue, missed, idle, then an
overfull Do now, each with keyed actions and Undo (D15). A failed or stuck
sync, or losing the app's server, puts a red banner at the top (D16)._

_Possible follow-ups: a "last reviewed" date and a weekly nudge; write
completion back to Lunatask (D8), now that the review makes completing
here more common._

---

## Phase 6 — Hardening ✅

_The job: when I rely on this list, I want it to be safe from the web,
honest about bad data and quick at any size, so trusting it is never a
gamble._

The fixes from the full QA pass on 14 October 2026; the evidence for each
is in [`docs/qa-2026-10-14.md`](docs/qa-2026-10-14.md), along with the
retest. Numbered by priority. Each item says what was wrong, the job it
got in the way of, and when it counts as done. Every fix has a test that
failed before it, and every one was rechecked in the running app.

### Must fix — the list can't be trusted until these are done ✅

- ✅ **Q1 — Only the app's own page can change tasks.** _(High · security)_
  When I have the app running and visit other websites, I want only the
  app's own page to be able to change my tasks, so nothing I browse can
  quietly add, complete or drop them.
  _Was:_ the server accepts requests from any web page. A page on another
  address added a task in testing. It doesn't check the `Host` header
  either, which leaves room to read tasks through DNS rebinding.
  _Done when:_ changes (POST/PATCH) are refused unless the body is JSON
  (`Content-Type: application/json`, which other sites can't send without
  the browser asking first). They're also refused if the request names
  another site as its origin. Every request is refused unless addressed to
  `localhost` or `127.0.0.1`. The QA test page can no longer add a task,
  while scripts on this computer (curl, a Claude session) still can.

- ✅ **Q2 — Impossible dates are refused.** _(Medium · correctness)_
  When I mistype a date, I want to be told, so a task never ends up
  "due" on a day that doesn't exist.
  _Was:_ `due:2026-13-45` is accepted and shows as "due later" with no real
  date. `2026-02-30` is accepted and counted as overdue since 2 March. The
  same applies to `on:`, the edit panel's API fields and `/api/agenda?from=`.
  _Done when:_ a date is only accepted if it's a real calendar day. Capture
  leaves an impossible `due:`/`on:` in the title, like other text it doesn't
  understand, and the API answers 400.

- ✅ **Q3 — A task file the app can't read says so plainly.** _(Medium · trust)_
  When `tasks.json` can't be read, I want the page to tell me that and
  where it is, so I don't go looking for a server problem that isn't there.
  _Was:_ the page says "Couldn't reach the task server: Something went
  wrong", and a file saved with a byte-order mark (older Notepad) can't be
  read at all. The file is never overwritten — that part is right and must
  stay so.
  _Done when:_ a leading byte-order mark is ignored. A damaged or
  unrecognised file produces a banner naming the file and the problem, and
  saying nothing has been changed. Writes stay blocked until the file reads.

- ✅ **Q4 — Inbox files in UTF-16 are read correctly.** _(Medium · data)_
  When I save an inbox file from Windows PowerShell 5 (`"…" > file.md`,
  which writes UTF-16), I want its tasks to arrive as written, so the
  inbox works from any tool on the PC.
  _Was:_ the file becomes junk tasks (`\u0000`, garbled titles) and is
  moved to `processed`. Notes folders (`LOCAL_FOLDERS`) read files the
  same way, so they have the same problem.
  _Done when:_ files starting with a UTF-16 byte-order mark (either byte
  order) are decoded as UTF-16. A file that still looks binary is left in
  the inbox with a warning, not imported.

### Should fix ✅

- ✅ **Q5 — One malformed task can't break the page.** _(Medium · robustness)_
  When I or a sync tool edit `tasks.json` by hand, I want a task with
  missing fields to be repaired or set aside, so one bad entry doesn't stop
  the whole app.
  _Was:_ a task with only `id`, `title` and `status` lands in "Drop or
  defer", and makes `/api/duplicates` fail with a 500, which stops the page
  loading.
  _Done when:_ tasks are checked as they're read. Missing optional fields
  get their defaults; entries without an id or title are skipped and
  reported in Sources, not deleted.

- ✅ **Q6 — Readable text in light mode.** _(Medium · accessibility)_
  When I glance at a task's source or quadrant, I want the label to be
  easy to read, so colour never costs me a squint.
  _Was:_ in light mode the Claude, Local and Gemini colours and the amber
  used for Delegate and idle measure 3.3–4.4:1 against the background,
  under the 4.5:1 needed for 12px text. Dark mode passes, apart from two
  faint labels (filter counts, "not set up").
  _Done when:_ an automated accessibility scan (axe) reports no
  colour-contrast problems in any view, in light or dark mode. Each colour
  stays recognisably the same colour.

- ✅ **Q7 — Empty `!1` lines don't silently set a quadrant.** _(Low · surprise)_
  When I paste a block with a stray empty list item like `- !1`, I want it
  to be ignored or flagged, so it doesn't push every line after it into
  Do now.
  _Was:_ a line with shortcuts and no title sets defaults for the lines
  after it, as documented for header lines — but in the middle of a list
  it's almost always a mistake. The comment in `src/sources/inbox.ts` still
  says such a line causes an error.
  _Done when:_ only lines before the first task line can set defaults; a
  title-less line after that is skipped and counted ("1 line skipped: no
  title"). The comment matches the behaviour.

- ✅ **Q8 — Duplicate checking stays quick as the list grows.** _(Medium · performance)_
  When my list grows to hundreds of open tasks, I want every click to stay
  instant, so the app never feels slower than Lunatask.
  _Was:_ the check compares every pair of open tasks and runs on every
  refresh: about 0.3s at 500 open tasks, 1.5s at 1,000, 3.8s at 1,666. Any
  number of suggested pairs is shown.
  _Done when:_ the check takes under 100ms at 2,000 open tasks — by
  indexing titles by word so only tasks sharing a word are compared, or by
  caching between refreshes. The box shows the top 10 pairs, with a count
  of the rest.

### Could fix ✅

- ✅ **Q9 — The API rejects wrong types.** _(Low · robustness)_
  `externalId` accepts an object and `reviewedAt` a number; both get
  stored. _Done when:_ every field the API stores is type-checked, with a
  400 for anything else.

- ✅ **Q10 — Sources panel structure for screen readers.** _(Low · accessibility)_
  The Sync now button sits inside the panel's clickable header (two
  controls in one), and the panel's headings skip a level. _Done when:_
  Sync now is outside the `<summary>` and axe reports no structural issues.

- ✅ **Q11 — The Day view moves on at midnight.** _(Low)_
  If the page is left open overnight on Today, it stays on yesterday.
  _Done when:_ a Day view showing today follows the date change.

- ✅ **Q12 — Two cosmetic quirks.** _(Low)_
  The empty Ahead view says "Nothing on Today – Tue, 27 Oct" (should read
  "Nothing planned from today to Tue 27 Oct"). An event at a time skipped
  by the clocks going forward (01:30 on that night) shows with no length.
  It should keep its length, as calendar apps do.

### Found during the retest ✅

- **Q13 — A view you've left stays hidden.** _(Medium · display)_
  When I switch from Ahead to another view, I want Ahead to go away, so
  I'm only looking at what I chose.
  _Was:_ the stylesheet gave the Ahead view a grid layout, which overrode
  "hidden", so after visiting Ahead its day cards stayed on screen under
  the matrix, Day, List and the review. (Found by the accessibility scan
  of the review screen.) _Done when:_ hidden always wins, for every element.

_Built as (v0.6.0): changes only accepted as JSON from the app's own page
or this computer, and only for `localhost` (D17). Dates checked to exist.
Task file read forgivingly but never overwritten when unreadable, with a
plain banner; malformed entries repaired or set aside, never deleted
(D18). UTF-16 files decoded. Mid-list `- !1` lines skipped and reported.
Duplicate check indexed by word and reused between refreshes: a refresh
at 2,000 open tasks takes ~20ms, a recheck after a rename ~0.13s
(was 3.8s at 1,666); top 10 shown. Light-mode colours
darkened to pass 4.5:1. Sync now moved out of the panel header. Day view
follows midnight. Empty-days wording. Spring-forward events keep their
length. `[hidden]` always hides._

---

## Phase 7 — Later, maybe

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
