# Development

How the code is organised, how to test it, the conventions it follows,
and how to extend it. Start with [architecture](architecture.md) for the
map; this page is for changing things.

## How we work

Claude writes the code; Rory reads it and questions it. So:

- **Readable over clever.** Plain TypeScript and plain browser
  JavaScript, comments that explain *why*, no framework to learn first.
- **Every structural choice gets a written reason** in
  [`DECISIONS.md`](DECISIONS.md), numbered, newest at the bottom. A
  reversed decision gets a new entry, not an edit.
- **Small, reviewable commits** on `github.com/rorymcclelland/task-manager`,
  one per phase or fix set, with a message saying what changed and which
  decisions cover it.
- **The backlog is job stories** (`BACKLOG.md`): *When …, I want …, so I
  can …*, grouped into phases that are each usable on their own.

## Commands

```powershell
npm start            # run the app on data/tasks.json
npm run sample       # write sample data and run the app on it
npm install          # once — fetches TypeScript for the two below
npm test             # all tests (Node's built-in runner)
npm run typecheck    # tsc, no output files
```

Node runs the `.ts` files directly (type stripping, Node 22.18+), so
there's no build step: edit, restart, reload.

## Layout

```
src/
  model.ts            the Task type and its field checks — start here
  tasks.ts            TaskService: every rule about changing a task
  priority.ts         Eisenhower placement, due-date urgency, idle/stale
  capture.ts          the quick-add syntax (one line, or a block)
  duplicates.ts       likely-duplicate suggestions
  sync.ts             rules for mirroring another system's tasks
  sync-runner.ts      runs sources on a timer; health per source
  agenda.ts           tasks + events by day; free time
  review.ts           the review queue
  calendar/ics.ts     iCalendar parsing and repeat expansion
  calendar/zones.ts   time-zone maths via Intl; Windows zone names
  sources/            lunatask.ts, local-files.ts, inbox.ts, calendar.ts
  store/              task-store.ts (interface), json-file-store.ts
  app.ts              HTTP routes (full list at the top)
  server.ts           reads settings, wires everything, starts listening
public/
  index.html          the page skeleton
  app.js              everything on screen, in sections marked by phase
  styles.css          colours as variables at the top; dark mode below
scripts/
  sample-data.ts      sample tasks, notes, inbox file and calendar
test/                 one test file per source file, plus API tests
docs/                 this documentation, DECISIONS.md, QA reports
```

## Tests

`npm test` runs every `test/*.test.ts` with Node's built-in runner. 134
tests at v0.5.0; they pass in any time zone.

| File | Covers |
|---|---|
| `priority.test.ts` | quadrants, due-date urgency, overload, idle/stale |
| `tasks.test.ts` | TaskService: create, edit, close, reopen, merge, schedule, keep, review |
| `capture.test.ts` | every capture shortcut, blocks, header lines |
| `duplicates.test.ts` | what counts as a likely duplicate |
| `sync.test.ts` | mirroring rules, including scheduled-date-on-change |
| `sources.test.ts` | Lunatask (with a fake API), notes scanning, inbox |
| `ics.test.ts` | calendar parsing: zones, repeats, exceptions, clock changes |
| `calendar-source.test.ts` | fetching calendars, failures, the secret address never leaking |
| `agenda.test.ts` | days, clipping, free time, overdue/missed/due-later |
| `review.test.ts` | review order and reasons |
| `sync-health.test.ts` | ok / warn / error / stale |
| `json-file-store.test.ts` | the file store: missing file, round trip, replacing by id, simultaneous saves, edits made outside the app |
| `api.test.ts` | end to end: a real server on a random port and a temp file |

**Patterns used:** pure rule modules take "today" or "now" as an
argument, so tests pick any date. `TaskService` takes a clock function.
Sources take a `fetch` function, so tests never touch the network. File
tests use a fresh temp folder each time.

**Manual QA** is recorded in dated reports (`docs/qa-YYYY-MM-DD.md`) with
the method used, so it can be repeated.

## Conventions

- **TypeScript that Node can strip:** no enums, namespaces or constructor
  parameter properties (`erasableSyntaxOnly` enforces it). Use
  `as const` arrays for fixed sets (see `SOURCES`, `QUADRANTS`).
- **No runtime dependencies.** If something seems to need a package,
  write down why in a decision first.
- **Validate at the edge.** `TaskService` checks every field it stores;
  the HTTP layer only translates.
- **Rules are pure.** Anything that decides something (priority, sync,
  agenda, review, capture) takes plain data and returns plain data, with
  its own test file.
- **Never store what can be worked out** (D5): quadrant, urgency, idle.
- **Never delete** a task; close it.
- **Read-only towards other systems** (D8) unless a decision says
  otherwise.
- **Browser code:** state in one object, `render()` redraws from it; text
  via `textContent` only; every action shows a toast with Undo where it
  can be undone.
- **British English** in the UI and docs; dates shown as "Wed, 14 Oct".

## Adding a source

1. **Write the connector** in `src/sources/<name>.ts`: a function that
   returns `SourceItem[]` (see `src/sync.ts`) — each with a stable
   `externalId`, a title (or `null`), an optional link, whether it's
   open, and a `detail` line. Take `fetch` or folder paths as arguments.
2. **Add the source name** to `SOURCES` in `src/model.ts`, a label and
   colour in `public/app.js` (`SOURCE_LABELS`) and `public/styles.css`
   (`--src-<name>`), and its name in `SOURCE_NAMES` in `sync.ts`.
3. **Register it** in `src/sync-runner.ts` as a connector with a label,
   `configured`, a `setup` sentence, and `run()` calling
   `service.applySync(source, items, {whenGone, covered})`. Use `covered`
   so a partial answer never closes tasks.
4. **Add its setting** in `src/server.ts`, `.env.example`, the README
   table and [setup.md](setup.md).
5. **Tests** with a fake response, including a failure and a partial
   answer.
6. **A decision entry**: what the source exposes, read-only or not, and
   what it costs.

## The repo and the project folder

The working copy lives in the sync folder
(`C:\Data\Sync\My files\Projects\Task management app`), which is not
currently a git checkout. To connect it without changing any file:

```powershell
git init -b main
git remote add origin https://github.com/rorymcclelland/task-manager.git
git fetch origin
git reset origin/main     # not --hard: files stay as they are
git status                # should be clean apart from data/ and .env
```

A `.git` folder inside a synced folder is fine on one machine; if the
sync folder is shared with another machine that also uses git there,
keep the checkout outside the sync folder instead.

## Versions

`package.json` carries the phase: 0.3.0 after Phase 3, 0.4.0 after
Phase 4, 0.5.0 after Phase 5. Bump the middle number per phase, the last
for fix sets (Phase 5Q → 0.5.1).
