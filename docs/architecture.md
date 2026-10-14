# Architecture

How the app is put together: what runs where, how a click becomes a
change in `tasks.json`, how other systems feed in, and where each rule
lives. The *why* behind each choice is in [`DECISIONS.md`](DECISIONS.md);
this page is the map.

## The shape of it

```
 Your browser                     Node on your PC (npm start)                    Disk / outside world
┌──────────────┐   JSON over    ┌───────────────────────────────────────────┐
│ public/      │   HTTP         │ app.ts         routes → TaskService       │
│  index.html  │ ◄────────────► │ tasks.ts       TaskService: every rule    │──► store/json-file-store.ts ──► data/tasks.json
│  app.js      │  localhost     │                about changing a task      │       (one file, safe writes)
│  styles.css  │   :4321        │                                           │
└──────────────┘                │ Pure rules (no clock, no I/O, all tested):│
                                │  priority.ts  quadrant, urgency, idle     │
                                │  capture.ts   the quick-add syntax        │
                                │  duplicates.ts  likely duplicates         │
                                │  sync.ts      mirroring rules             │
                                │  agenda.ts    days, events, free time     │
                                │  review.ts    what needs a decision       │
                                │  calendar/    .ics parsing, time zones    │
                                │                                           │
                                │ sync-runner.ts  on start + every 15 min:  │
                                │  sources/lunatask.ts ─────────────────────│──► api.lunatask.app (read-only)
                                │  sources/local-files.ts ──────────────────│──► your notes folders
                                │  sources/inbox.ts ────────────────────────│──► data/inbox/*.md
                                │  sources/calendar.ts (held in memory) ────│──► your calendar's .ics address
                                │                                           │
                                │ server.ts      reads .env, wires it all   │
                                └───────────────────────────────────────────┘
```

Before any of it, `refuseForeign` in `app.ts` turns away requests that
didn't come from this page or this computer (D17).

Three layers, each only talking to the one below:

1. **The page** (`public/`) draws what the server gives it and sends
   your actions back. It holds no rules of its own, beyond formatting.
2. **The server** (`src/`) decides everything: what's valid, what a
   task's quadrant is, what a sync changes. The rules are pure functions,
   so they're tested without a server, a clock or a disk.
3. **Storage** is a four-method interface (`TaskStore`) with one
   implementation: a JSON file. Swapping to SQLite would mean writing one
   new class.

## Life of a click

Pressing `x` on a selected task:

1. `app.js` → `POST /api/tasks/<id>/complete`.
2. `app.ts` matches the route and calls `TaskService.complete(id)`.
3. `tasks.ts` loads the task through the store, checks it's open, sets
   `status: "done"` and `closedAt`, and saves it.
4. `json-file-store.ts` re-reads `tasks.json`, replaces that task, writes
   `tasks.json.tmp` and renames it over the original — inside a queue, so
   two saves can't interleave.
5. The page shows "Done: … — Undo" and re-fetches everything to redraw.
   Undo is just `POST …/reopen`.

Every action follows that pattern: one route, one `TaskService` method,
one save, one redraw.

## How the page stays current

The page re-fetches its data (nine requests in parallel: open tasks,
closed tasks, the top ten duplicates, matrix, sync status, the day's
agenda, the 14-day agenda, the review queue, and task-file health):

- after every action you take,
- when you switch back to the tab,
- every 60 seconds, unless you're typing or editing,
- every 10 seconds while the server can't be reached, so the warning
  clears as soon as it's back.

It then redraws the whole page from that data. With a few hundred tasks
a full redraw is instant, and it means the page can't drift out of step
with the server. All task text goes in with `textContent`, never as HTML.

## Prioritisation — worked out, never stored

`priority.ts` turns a task's stored answers (`important`, `urgent`), its
dates and today's date into a placement, an urgency reason, days until
due, days idle and a stale flag. It runs on every request, so time
passing moves tasks — "due in 3 days" becomes urgent overnight — without
anything rewriting the file. Settings: `URGENT_WITHIN_DAYS`,
`DO_NOW_LIMIT`, `STALE_AFTER_DAYS`, `DO_NOW_STALE_AFTER_DAYS`.

## Sources and syncing

`sync-runner.ts` runs each configured source one after another — on
start, every `SYNC_EVERY_MINUTES` (default 15), and on "Sync now". Never
two syncs at once; one source failing never stops the others.

Inbox and notes files are read by `sources/text-file.ts`, which handles
UTF-8 (with or without a byte-order mark) and UTF-16 (what Windows
PowerShell 5 writes), and refuses anything that still isn't text.

| Source | File | What it returns | How it lands |
|---|---|---|---|
| Lunatask | `sources/lunatask.ts` | Every task from `GET /v1/tasks` (names are encrypted, so none) | `TaskService.applySync` → `sync.ts` rules |
| Notes folders | `sources/local-files.ts` | `- [ ]` and `TODO:` lines in `.md`/`.markdown`/`.txt` files, 4 levels deep, up to 2,000 files of ≤ 1 MB | `applySync` → `sync.ts` rules |
| Inbox folder | `sources/inbox.ts` | Each `.md`/`.txt` file read as a capture block, then moved to `processed/` | `TaskService.captureMany` |
| Calendar | `sources/calendar.ts` | Parsed .ics feeds, kept in memory | Read by `/api/agenda`; never becomes tasks |

**Mirroring rules** (`sync.ts`, pure): match on the other system's own
id, never on title; import only open items; close a task here only when
the source *changes* from open to closed or gone; never reopen; never
touch a title or notes; take the source's scheduled date only when the
source changes it; write only when something actually changed.

**Health** (`sync-runner.ts`, `healthOf`): each source is off, pending,
ok, warn, error, or stale (nothing has worked for two intervals plus
five minutes). Error and stale put a banner on the page. Kept in memory;
a restart starts clean.

Everything is read-only towards the other systems — no source writes
anywhere (D8).

## Time: calendar, agenda, free time

- `calendar/ics.ts` parses iCalendar text and expands repeating events
  between two days, working in each event's own time zone so "09:00
  every Monday" stays 09:00 across clock changes.
- `calendar/zones.ts` converts between instants and wall-clock time in
  any zone using the built-in `Intl` API, and maps Outlook's Windows zone
  names.
- `agenda.ts` lays tasks and events onto days, clips events to each day
  in local time, and works out free time inside `DAY_HOURS` around busy
  events and slotted tasks (from now, for today).

## The review

`review.ts` builds the queue from prioritised open tasks: each task once,
under its first reason (unplaced → unnamed → overdue → missed → idle →
Do now over its limit). The page fixes the order when a review starts
and walks it card by card; every action on a card is an ordinary API
call with an ordinary Undo.

## Where to change what

| To change… | Look in |
|---|---|
| What a task can store | `src/model.ts`, then `tasks.ts` validation, then `docs/data-model.md` |
| Quadrant, urgency or idle rules | `src/priority.ts` (+ `test/priority.test.ts`) |
| The capture syntax | `src/capture.ts` (+ `test/capture.test.ts`) |
| What a sync does to existing tasks | `src/sync.ts` (+ `test/sync.test.ts`) |
| A source's connection details | `src/sources/<source>.ts` |
| Sync timing or health rules | `src/sync-runner.ts` |
| Calendar parsing | `src/calendar/ics.ts` (+ `test/ics.test.ts`) |
| Day/Ahead layout data, free time | `src/agenda.ts` |
| Review order or reasons | `src/review.ts` |
| A route | `src/app.ts` (the full list is at the top) |
| A setting | `src/server.ts`, `.env.example`, README table, `docs/setup.md` |
| Anything on screen | `public/app.js` (sections are marked by phase), `public/styles.css` |

## Constraints worth knowing

- **Node 22.18+, no build step.** Node strips TypeScript types and runs
  the files directly, so TypeScript features that generate code (enums,
  namespaces, parameter properties) can't be used. `tsconfig.json`
  enforces this.
- **No runtime dependencies.** `npm install` only fetches TypeScript and
  Node's type definitions for `npm run typecheck`.
- **Single user, single machine at a time.** Two copies of the app
  against one synced `tasks.json` would be "last write wins".
- **Local only.** The server binds to 127.0.0.1, answers only requests
  addressed to localhost, and accepts changes only as JSON from its own
  page or a local script (D17).
- **The task file is never written while it can't be read,** and
  entries it can't use are kept, not deleted (D18).
