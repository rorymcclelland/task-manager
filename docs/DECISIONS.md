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
