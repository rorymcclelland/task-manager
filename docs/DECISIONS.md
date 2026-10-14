# Decisions

Structural choices, each with the reason behind it, so they can be questioned
on their merits later. Newest at the bottom. If a decision is reversed, don't
delete it — add a new entry that says what changed and why.

---

## D1 — Stack: a local web app in Node + TypeScript, with no runtime dependencies

_14 Oct 2026 · backlog 0.2_

**Decision.** A small Node.js server runs on your PC and serves a browser UI at
`http://localhost:4321`. The server is TypeScript; the browser code is plain
JavaScript. There is no build step and no npm packages are needed to run it.

**Why.**

- **It runs where the data is.** The later phases pull in Lunatask, Claude,
  Gemini and local files. A process on your own machine can read local files
  and hold API keys without sending them anywhere — a browser-only app can't.
- **Readable over clever.** You'll be reading this code. Node's built-in HTTP
  server, file system and test runner cover everything Phase 1 needs, so
  there's no framework to learn before the code makes sense.
- **Node runs TypeScript directly.** Since Node 22.18, `node file.ts` strips
  the types and runs the file. So we get type checking (`npm run typecheck`)
  without a compile step between editing and running.
- **Plain JavaScript in the browser** for the same reason: the UI is one
  page, and React or a bundler would add more to read than they save. If the UI
  grows past what plain DOM code handles comfortably (Phase 2's matrix or
  Phase 4's calendar may get there), revisit this.

**Rejected.** A browser-only app (data stuck in the browser, can't reach
local files or hold keys safely). A desktop app via Electron/Tauri (much more
scaffolding for the same result at this stage — can be wrapped around this
later if a native window is wanted).

**Constraint this creates.** Node 22.18 or newer must be installed. Because
Node only *strips* types, TypeScript features that generate code (enums,
namespaces, constructor parameter properties) can't be used; `tsconfig.json`
enforces this with `erasableSyntaxOnly`.

---

## D2 — Storage: one JSON file, behind a `TaskStore` interface

_14 Oct 2026 · backlog 0.4_

**Decision.** All tasks live in `data/tasks.json` (or wherever `TASKS_FILE`
points). The app only touches storage through the four-method `TaskStore`
interface in `src/store/task-store.ts`; `JsonFileStore` is the one
implementation.

**Why.**

- **It sits in your sync folder safely.** A SQLite file can be corrupted if a
  sync client copies it mid-write; a JSON file written with
  write-temp-then-rename is always either the old version or the new one.
- **You can open it and see exactly what's stored.** Useful while the model is
  still settling, and useful for trust.
- **It's fast enough.** Every operation re-reads the whole file. That's
  deliberate (see the comments in `json-file-store.ts`) and fine up to
  thousands of tasks.
- **It's reversible.** Swapping to SQLite or a hosted database means writing
  one new class that implements `TaskStore`.

**Kept out of git.** `data/` is in `.gitignore` — your tasks never go to GitHub.

**Limit to know about.** If the app runs on two machines at once against the
same synced file, the last write wins. Fine for a single user on one machine
at a time; revisit if that changes.

---

## D3 — Task data model

_14 Oct 2026 · backlog 0.3_

The full definition, with comments, is `src/model.ts`. The non-obvious parts:

- **`origin` and `alsoIn` instead of a single "source" field.** A task starts
  in one system (`origin`). When two copies get merged (backlog 1.5), the
  survivor keeps the other copy's source in `alsoIn`, so you can still see —
  and click through to — every system it lives in.
- **`important` / `urgent` are `true`, `false` or `null`.** `null` means "not
  triaged yet", which is different from "judged not important". Phase 2's
  matrix needs that distinction to show an untriaged pile.
- **Dates are `YYYY-MM-DD` strings,** not timestamps. A due date is a day on
  the calendar; storing a time and zone invites "due yesterday" bugs.
- **Four statuses: `open`, `done`, `dropped`, `merged`.** Done and dropped are
  kept apart because "I did it" and "it stopped being real" are different
  facts, and Phase 5's review will want to tell them apart. Nothing is ever
  deleted, so any of them can be reopened.
- **`notDuplicateOf`.** When you say two similar-looking tasks aren't
  duplicates, that's remembered so the app stops suggesting them.

---

## D4 — Duplicate detection: suggest, never auto-merge

_14 Oct 2026 · backlog 1.5_

**Decision.** The app compares open task titles and *suggests* likely
duplicates. Merging only happens when you confirm it.

**How "likely duplicate" is decided** (`src/duplicates.ts`): titles are
lower-cased, punctuation and common filler words removed, then compared by
word overlap. Two tasks are suggested when they share at least 60% of their
meaningful words, or one title's words are entirely contained in the other's.

**Why so simple.** It's explainable in one sentence, so when it suggests
something odd you can see why. When real Claude/Gemini/Lunatask imports
arrive in Phase 3, matching on each system's own ID (`externalId`) will catch
exact re-imports, and this fuzzy match only has to catch the same task
described in two places.

---

## D5 — Priority is worked out, not stored

_14 Oct 2026 · backlog 2.1, 2.4_

**Decision.** A task stores only your two answers (`important`, `urgent`)
and its `dueDate`. Which quadrant it's in is calculated from those plus
today's date every time the page asks (`src/priority.ts`). Nothing about
quadrants is written to `tasks.json`.

**Why.** 2.4 asks for urgency to follow the due date "without my input". If
the quadrant were stored, something would have to wake up each morning and
rewrite it — and a sync-folder file being rewritten in the background is
exactly what D2 is trying to avoid. Calculating it means the matrix is
always right for today, and the data model from D3 didn't need to change.

**The urgency rule, in one sentence:** a task due within 3 days, or overdue,
is urgent whatever you said; otherwise your answer stands; if you haven't
answered and it has a later due date, it's not urgent yet.

- **The due date can only make a task *more* urgent.** If you mark something
  urgent that's due in a month, you know something the date doesn't.
- **3 days** is a starting guess, set with `URGENT_WITHIN_DAYS`. It covers
  "today, tomorrow and the day after" — enough warning to act on, short
  enough that "Do now" doesn't fill with next week.
- **A task is only placed once both questions are answered.** Until then it
  waits in "Not placed yet" — the untriaged pile D3 kept `null` for.
- **When the rule overrules you.** Drag a task due tomorrow into "Schedule"
  and your answer *is* saved, but the task stays in "Do now" and the app says
  why. Once the date moves or is cleared, your answer takes over.

**Rejected.** Storing the quadrant (needs a background job, and two sources
of truth that can disagree). Letting your answer override the date (then
time passing changes nothing, which is the opposite of 2.4).

---

## D6 — One overload rule: a soft limit on "Do now"

_14 Oct 2026 · backlog 2.5_

**Decision.** "Do now" is flagged when it holds more than 5 tasks
(`DO_NOW_LIMIT`). The quadrant turns red, shows "7 / 5", and says plainly
that it's over the limit. Nothing is blocked — it's a warning, not a cap.
The other quadrants have no limit.

**Why only "Do now".** It's the one quadrant whose usefulness depends on
being short; a long "Schedule" list is normal and healthy. A limit
elsewhere would be noise.

**Why a count rather than a percentage.** "More than 5" is explainable at
a glance and doesn't change meaning as the rest of the list grows or
shrinks. Considered: flagging when "Do now" is more than half of all
placed tasks — rejected because it fires on small lists and goes quiet on
big ones, which is backwards.

**The limit counts every source,** even while a source filter is on —
overload is about your whole week, not one system.

---

## D7 — Lunatask: mirror over the API, and name tasks here once

_14 Oct 2026 · backlog 3.1 · settles open decision 3 in `CONTEXT.md`_

**What Lunatask actually exposes.** Lunatask has a public API
([docs](https://lunatask.app/api/overview)), authenticated with an access
token you create in the desktop app. But all task text is end-to-end
encrypted, so **the API never returns a task's name or note**. It does return
each task's ID, status (later / next / in progress / waiting / completed),
Eisenhower quadrant, priority, motivation, scheduled date and timestamps.
There are no webhooks. The desktop app has an export, but Lunatask's own
docs call it "somewhat limited" and say its format may change without
notice.

**Decision.** Mirror Lunatask through the API (`src/sources/lunatask.ts`).
Each open Lunatask task appears here as **"Unnamed Lunatask task"** with
what Lunatask knows about it underneath and a `lunatask://tasks/<id>` link
that opens it in the Lunatask app. You name it here once; syncs never
touch a title. Lunatask's Eisenhower answer places the task on the matrix
until you place it yourself. Its scheduled date always follows Lunatask.

**Why the API, despite the missing names.**

- It's the only **documented, stable** route. The export is a manual step in
  a desktop app, in a format we can't see and that may change.
- It answers the oversight question that matters most — *how much is open
  in Lunatask, how urgent, and is it done yet* — automatically, every 15
  minutes, without you doing anything.
- Naming is a one-off cost per task, and the link makes it a two-second job.

**What it costs.** A Lunatask list of 80 open tasks means 80 tasks to name
before the matrix reads well. Unnamed tasks are left out of duplicate
suggestions (they'd all match each other).

**Worth doing next.** If you export from Lunatask (Settings → Export) and
drop the file in the project folder, an importer could fill in names by
matching Lunatask's task IDs — a one-off catch-up, with the API carrying on
for status. That needs a real export file to look at, so it isn't built.

**Rejected for now.** Export-file only (manual, undocumented format, no
status updates between exports). Manual entry (that's what Phase 1 already
does).

---

## D8 — Sync direction: every source is read-only (backlog 3.5)

_14 Oct 2026 · backlog 3.5_

**Decision.** Nothing this app does is written back to any other system.

| Source | Direction | What flows in |
|---|---|---|
| Lunatask | Mirror, read-only | Open tasks; completed there → done here; deleted there → dropped here; scheduled date |
| Claude | One-way push in | Tasks you paste or drop in the inbox |
| Gemini | One-way push in | The same |
| Files on this computer | Mirror, read-only | `- [ ]` and `TODO:` lines; ticked or deleted → done here |

Recorded in `CONTEXT.md` too, as the backlog asked.

**Why read-only.** This app's job is *oversight*. Write-back means this app
can break the systems you rely on — a bug here could complete forty
Lunatask tasks at once — and it's the hardest kind of change to undo.
Read-only first, and add write-back only where the friction of doing it
twice turns out to be real.

**How a mirror closes things** (`src/sync.ts`): only when the source
*changes* — a task the source had open is now closed or gone. Reopen it
here and the next sync leaves it open. A sync never reopens anything. A
file that can't be read, or a Lunatask answer that looks partial, never
counts as "gone".

**The friction this leaves.** Complete a Lunatask task here and it's still
open in Lunatask. The app says so at that moment ("tick it off in Lunatask
too"). If that gets old, completion write-back is one API call
(`PUT /v1/tasks/<id>` with `status: "completed"`) — the obvious first
write-back to add.

---

## D9 — Claude and Gemini: deliberate capture, not scraping

_14 Oct 2026 · backlog 3.2, 3.3 · settles open decision 4 in `CONTEXT.md`_

**Decision.** Tasks from conversations arrive because you (or the
assistant) deliberately send them, in the same text format as the capture
box. Two routes:

1. **Paste a block.** Paste several lines into the capture box and each
   becomes a task. A first line with just a link (or `#claude`) sets the
   source and link for every line under it. A `claude.ai` or Gemini link
   on its own is enough to say where the tasks came from.
2. **The inbox folder.** Any `.md` or `.txt` file in `data/inbox` (or
   `INBOX_FOLDER`) is read the same way at the next sync, then moved to
   `inbox/processed/`. This works when the app isn't running, from anything
   that can save a file into your sync folder — including a Claude session
   that's working on your computer.

Pasting the same block twice adds nothing the second time: a line with the
same source, link and title as an existing task (open or closed) is
skipped. Typed one-line captures are never de-duplicated — typing it is
deliberate.

**Why not scrape.** Claude's data export and Google Takeout give whole
conversation histories, not tasks. Pulling commitments out of them means
guessing what counted as an agreement, and the guesses would be wrong
often enough that the list stops being trusted — the opposite of 1.1.
Neither service offers an API that lists conversations as they happen.
Deliberate capture costs one paste at the end of a conversation, and what
lands is exactly what was agreed.

**Making it a habit.** Ask at the end of a conversation: *"List what we
agreed I'd do as a task block: this conversation's link on the first line,
then one task per line as `- title`, with `!1`–`!4` if it's clear which
quadrant, and `due:YYYY-MM-DD` if there's a date."* For Claude, that
instruction can go in a Project's instructions so it happens without
asking.

---

## D10 — Files on this computer: checkboxes and TODOs in notes

_14 Oct 2026 · backlog 3.4_

**Decision.** `LOCAL_FOLDERS` lists folders to scan. In `.md` and `.txt`
files, an unticked checkbox (`- [ ] …`) or a line with `TODO:` becomes a
task, mirrored like Lunatask (D8). The path and line number show under the
task.

**Why these two markers.** They're what notes apps (Obsidian, VS Code,
plain Markdown) already use, so nothing about how you write notes has to
change. Only upper-case `TODO` counts, so prose like "my todo list" doesn't.

**Limits, on purpose.**

- **Notes, not code.** Code files are full of `TODO` comments that are
  someone's reminder about the code, not your task list.
- **Hidden folders, `node_modules` and the inbox are skipped**; folders
  are read 4 levels deep, at most 2,000 files, files over 1 MB ignored.
- **A task's ID is the file plus the line's text**, not its line number —
  so adding lines above it doesn't make it a new task. Editing the text
  does: the old task closes and a new one appears.
- **Deleting the line counts as done** (that's how most people tick off a
  TODO), but a file that's been moved, deleted or can't be read changes
  nothing.
- **No clickable link.** Browsers won't open `file://` links from a web
  page, so the path is shown as text.

**Rejected.** "Recently changed files imply work in progress" — too much
guessing for a list that has to be believable. Registering it by hand is
already one line in the capture box with `#local`.

---

## D11 — Calendar: read your calendar's private .ics address, not Lunatask

_14 Oct 2026 · backlog 4.1_

**What Lunatask exposes.** Nothing, for the calendar. Its API covers tasks,
notes, habits, journal and people, with no calendar or events endpoint.
Lunatask's calendar is your Google, Outlook or iCloud calendar shown inside
Lunatask, so the events actually live in one of those.

**Decision.** Read the calendar from the source, through its private
iCalendar (.ics) address. Google Calendar ("Secret address in iCal format"),
Outlook ("Publish calendar" → ICS) and iCloud ("Public calendar") all offer
one. `CALENDAR_URLS` in `.env` takes one or more addresses, or paths to
`.ics` files, separated by `;`. The parser is `src/calendar/ics.ts`, and the
connector that fetches with the other sources is `src/sources/calendar.ts`.

**Why this route.**

- **One format covers every calendar provider,** and nobody's API or sign-in
  flow has to be built. A Google API connection would mean OAuth, a Google
  Cloud project and token refresh, all for read-only access that the .ics
  address already gives.
- **Read-only by nature,** which matches D8.
- **No library.** The parser is about 400 lines and runs without
  dependencies, keeping D1's "nothing to install". It handles time zones
  (including Outlook's Windows names), all-day and multi-day events, and
  repeating events: daily, weekly, monthly and yearly, with intervals,
  counts, end dates, "every Tue and Thu", "last Friday of the month",
  skipped dates, and single occurrences that have been moved or cancelled.
  The tests in `test/ics.test.ts` cover each of these.

**Events are not tasks.** They're held in memory and never written to
`tasks.json`. Events are context for planning, not things to tick off, and
copying hundreds of them into the sync-folder file every 15 minutes is
exactly the background rewriting D2 and D5 avoid.

**Limits, on purpose.**

- **The rarer repeat rules** (e.g. "the 2nd weekday of the month", hourly)
  aren't followed. Such an event shows its first occurrence only, and the
  Day view says how many events are affected, so a gap is never silent.
- **An unrecognised time zone** is read as this computer's zone, and the
  Sources panel names it.
- **If a fetch fails,** the last good copy stays on screen and Sources says
  how old it is.
- **Changes reach the .ics address on the provider's schedule,** not
  instantly. That can lag by minutes, sometimes longer, so a meeting
  added a minute ago may not show yet.

**The address is a password.** Anyone with it can read your calendar. It
lives in `.env` (kept out of git) and is never sent to the page or put in
an error message. Calendars are named from the name inside the file.

**Rejected.** The Google Calendar API (OAuth set-up and a dependency, for
the same read-only data). Lunatask (no endpoint). An npm iCal library
(would add the first runtime dependency; the subset needed is small and
now tested).

---

## D12 — Scheduling: a day, plus an optional time slot; source dates apply only when they change

_14 Oct 2026 · backlog 4.2 · amends D7 and D8_

**Decision.** A task's `scheduledDate` (already in D3) can carry a `slot`:
`{start: "HH:MM", minutes}`. The day alone means "some time that day"; the
slot means "14:00–15:30". A slot needs a day, finishes by midnight, and is
cleared when the day is.

**Why a wall-clock time, not a timestamp.** For the same reason due dates
are plain strings (D3): "14:00 on Thursday" means 14:00 wherever this
computer is. Calendar events arrive as instants and are converted to this
computer's local time for display, so both end up on the same clock.

**Why a length.** 4.1 asks whether priorities fit "the time actually
available". That's only answerable if a slotted task takes up time. The
default is 30 minutes. Drag a task to move it; change the length in its
edit panel.

**Change to D7/D8: Lunatask's scheduled date only overrules yours when
Lunatask changes it.** Until now, every sync copied Lunatask's date over
whatever was here. That would undo any planning done here within 15
minutes. Now the sync remembers what Lunatask last said
(`mirror.sourceScheduledDate`) and copies it only when that changes, the
same "only on the change" rule D8 already uses for completion. When it
does change, any slot is cleared rather than silently moved to the new
day. Tasks synced before this change are treated as if Lunatask's last
word was their current date, so nothing jumps.

**Still read-only.** Scheduling a Lunatask task here doesn't schedule it in
Lunatask, and the toast says so at the time.

**Capture.** `on:2026-10-20` schedules the day and `at:14:00` adds a
30-minute slot (today if there's no `on:`). These also work in pasted
blocks and inbox files, so a Claude conversation can hand over "do this
Thursday at 10".

---

## D13 — Two new views: Day and Ahead

_14 Oct 2026 · backlog 4.1–4.3 · revisits D1's "plain JavaScript" note_

**Day (4.1, 4.2).** The calendar for one day as a timeline on the left, and
the open tasks still to fit in on the right, in matrix order (Do now
first). Drag a task onto a time to slot it, onto "Some time this day" to
plan the day without a time, or back to the right to unplan it. `s` puts
the selected task in the first free gap. The header shows the free time
left inside `DAY_HOURS` (default 09:00–18:00), counting from now if the
day is today. Events marked "show me as free" (lunch, birthdays) are drawn
dashed and don't count as busy.

**Ahead (4.3).** The next 14 days, one card per day: events (muted, for
context), slotted tasks, tasks planned for the day, and tasks due. Above
them, two lists that would otherwise be easy to miss: **overdue**, and
**planned for an earlier day, still open**, which is the first sign of a
plan slipping and leads into Phase 5's stale-task work. Below them, the
next few deadlines past the fortnight, so nothing just over the edge
arrives as a surprise. Days with nothing on them fold into one line.

**Why the matrix is still the default.** 2.2 says the first view answers
"what now?", and the matrix still does that best. Day answers "when?",
one click or `v` away.

**Why still no framework (D1).** D1 said to revisit plain JavaScript if
Phase 4's calendar got heavy. It didn't: the timeline is absolutely
positioned divs, with about 30 lines to lay overlapping items side by
side. All the date logic is on the server (`src/agenda.ts`), where it's
pure and tested, and the page only draws what it's given. Not worth a
framework yet.

**Rejected.** A full week grid like a calendar app's: much more drawing
code, and cramped at this page width. Ahead's day list answers 4.3
without it. Writing events into Lunatask or the calendar: read-only (D8).

---

## D14 — Stale tasks: idle for 30 days, or 7 in "Do now", with nothing ahead

_14 Oct 2026 · backlog 5.1_

**The rule, in one sentence:** a task is flagged *idle* when you haven't
touched it for 30 days (7 in "Do now") and it isn't waiting on a date
still to come.

**What counts as touching it.** Creating it, editing anything, placing it
on the matrix, scheduling it, reopening it, or saying "still relevant" in
the review. Each sets `reviewedAt`. **Syncs never do.** Lunatask updating
a task's status every 15 minutes says nothing about whether *you've*
thought about it.

**Why 7 days in "Do now".** "Do now" claims a task is urgent. A week later,
untouched, that claim has usually stopped being true: the task isn't
urgent, or isn't going to happen. Elsewhere a month is a fair test of
"am I ever going to do this?" Both numbers can be changed
(`STALE_AFTER_DAYS`, `DO_NOW_STALE_AFTER_DAYS`).

**Why a future date exempts it.** A due date next month or a planned day
next week means it's parked on purpose. Flagging it would be noise, and
noise is what makes people stop reading flags. Once the date passes, it's
overdue or "planned for a day that's gone", both of which the review asks
about anyway.

**Worked out, not stored** (as in D5). Nothing rewrites `tasks.json`
when a task crosses the line; the flag is calculated each time from
`reviewedAt` and today. For tasks saved before Phase 5, which have no
`reviewedAt`: the last edit is used for your own tasks, and the creation
date for mirrored ones, whose `updatedAt` moves with every sync.

**Flagged, not acted on.** Nothing is dropped automatically. Idle tasks
show *◌ Idle 34 days* and go into the review. What to do with them is
your call.

---

## D15 — The review: one card at a time, in a fixed order

_14 Oct 2026 · backlog 5.2_

**Decision.** A **Review** button (or `r`) shows how many tasks need a
decision and opens them one card at a time. `src/review.ts` builds the
queue; each task appears once, under the first reason that applies:

1. **Not placed yet:** place it, or drop it.
2. **Needs a name** (Lunatask): type the name on the card.
3. **Overdue:** due tomorrow / in a week / no date, done, or drop.
4. **Planned for a day that's gone:** plan for today / tomorrow / unplan.
5. **Idle** (D14): still relevant, move it, done, or drop.
6. **"Do now" over its limit** (D6): all of "Do now", so you can choose
   what to move out.

**Why that order.** It runs from the cheapest decision to the most
considered. Placing an unplaced task takes a second, and later decisions
are easier once everything is placed. It also clears the reasons the
other views can't show properly: an unnamed task can't be judged, and an
unplaced one isn't on the matrix.

**Why one card at a time.** 5.2 asks for "a few minutes rather than an
afternoon". A list of 20 problems invites scrolling and putting it off.
One card with four or five obvious buttons asks for one decision. Every
button has a key (1–4, `k`, `x`, `d`, `e`, `→`) and the usual Undo.

**The queue is fixed when the review starts.** Placing a task doesn't
reshuffle what comes next, and cards for tasks closed elsewhere
meanwhile are skipped. Skipped cards come back next time; nothing records
that you've "seen" a task without deciding. Skipping isn't a decision.

**Not built.** A reminder to review, or a record of when you last did.
The count on the button is the reminder: it's amber whenever anything
needs a decision. If that turns out not to be enough, a "last reviewed"
date is a small addition.

---

## D16 — Sync failures: a banner, not a footnote

_14 Oct 2026 · backlog 5.3_

**The problem.** Phase 3 showed each sync's result in the Sources line,
but a failure there was a small red dot. The list still *looked* complete,
which is exactly the trust problem 5.3 is about.

**Decision.** Each source now has a `health`, worked out in
`src/sync-runner.ts` (`healthOf`):

| Health | When | Shown |
|---|---|---|
| off | not set up | grey dot |
| pending | first sync not finished | grey dot |
| ok | last sync worked | green dot |
| warn | worked, with something worth knowing | amber dot, Sources opens |
| **error** | last sync failed | **red banner**, ⚠ on its filter chip |
| **stale** | no sync has worked for over two intervals (+5 min) | **red banner**, ⚠ on its filter chip |

**Why "stale" as well as "error".** A failure can only be reported by a
sync that finishes. A sync that hangs, or a timer that stops, produces no
error at all, so the app also checks how long it's been since anything
worked. With syncing every 15 minutes that's 35 minutes. With
`SYNC_EVERY_MINUTES=0` (sync only when asked) there's no schedule to miss,
so nothing is stale.

**The banner says three things:** which source, since when, and what went
wrong, in words (e.g. *"Lunatask hasn't synced since 10:42 (3 tries in a
row): Lunatask rejected the access token. What's shown from it may be out
of date."*). It has a Sync now button and goes away by itself once a sync
works.

**A calendar where one feed fails now counts as failed,** not as a
warning. The feeds that worked are still updated, and the failed one
keeps its last good copy on screen, but you're told.

**The page can lose the server too.** If the app stops (closed terminal,
restart, sleep), the open page would otherwise go on looking current. Now
a failed refresh shows *"Can't reach the app since 12:10"*, and the page
checks every 10 seconds until it's back.

**Kept in memory, on purpose.** Health is about this run of the app, so a
restart starts clean and the first sync re-establishes it. Writing it to
`tasks.json` would mean rewriting the sync-folder file just to say "still
fine" (D2).

---

## D17 — Who may call the app: this page and this computer only

_14 Oct 2026 · backlog Q1 (Phase 6)_

**The problem.** QA showed that any website you had open could add,
complete or drop tasks, because the server accepted any request sent to
`localhost:4321`. Browsers let any page send "simple" cross-site
requests (a form post, or `fetch` with a `text/plain` body) without
asking. The server read any body as JSON and never checked who sent it.
A related trick, DNS rebinding, could also have let a site *read* the
list.

**Decision.** Three checks, in `refuseForeign` in `src/app.ts`, before
any route runs:

1. **The request must be addressed to `localhost`, `127.0.0.1` or
   `[::1]`** (the `Host` header). Blocks DNS rebinding, reads included.
2. **A change (POST/PATCH) that says where it came from (`Origin`) must
   come from this server's own address.** A page on any other site, or
   another port on this computer, is refused.
3. **A change must be sent as `Content-Type: application/json`.** A
   browser only lets another site send that after asking this server
   first (a CORS "preflight"), and the server never says yes.

Refused requests get a 403 with a sentence saying why.

**Why not a token or a login.** Single user, one machine. Those three
rules stop browsers, the only way an outsider reaches a server that
listens on 127.0.0.1, without anything to set up. Scripts on this
computer (PowerShell, curl, a Claude session) still work: they send no
`Origin`, and only need the JSON header, which the API docs already
showed.

**Cost.** Anything calling the API must send `Content-Type:
application/json` on POST and PATCH, even with an empty body.

---

## D18 — Reading the task file: forgiving about contents, never about losing them

_14 Oct 2026 · backlog Q3, Q5 (Phase 6) · extends D2_

**Decision.** `JsonFileStore` now separates three cases:

| What's in the file | What happens |
|---|---|
| A byte-order mark in front (older Notepad) | Ignored; the file reads normally |
| Not valid JSON, no task list, or a version this app doesn't know | Every request answers 503 with a plain sentence: what's wrong, the file's path, "nothing has been changed". The page shows it as a red banner. **Nothing is written** until the file reads again. |
| A task with missing or malformed fields | Repaired with the values a new task would have (unknown answers → "not decided", impossible dates → none) and used. It's written back repaired only when the task next changes. |
| An entry that can't be a task (no `id` or no `title`) | Set aside: left out of the app, **kept in the file exactly as it was**, and named in an amber banner |

**Why.** `tasks.json` lives in a sync folder and can be hand-edited
(D2), so half-synced or hand-written content will happen. The worst
outcomes are silently losing data or breaking the page completely. Before
this, the second happened: one task missing a field stopped the whole
page loading. Being strict about *not writing* while lenient about
*reading* avoids both.

**Not done.** Automatic repair of broken JSON. Guessing which half of a
half-synced file to keep is a decision for a person; the banner says
where the file is.
