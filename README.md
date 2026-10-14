# Task oversight

One place to see and prioritise tasks that currently live across Claude,
Gemini, Lunatask and my own machine. Single user, runs locally.

- **Why it exists and what's in scope:** [`CONTEXT.md`](CONTEXT.md)
- **What gets built, in what order:** [`BACKLOG.md`](BACKLOG.md)
- **Why it's built the way it is:** [`docs/DECISIONS.md`](docs/DECISIONS.md)

## Running it

Needs [Node.js](https://nodejs.org) 22.18 or newer (check with `node --version`).
Nothing else needs installing to run it.

```
npm start
```

Then open <http://localhost:4321>. Tasks are saved to `data/tasks.json` in this
folder. To change that or anything else, put these in a `.env` file in this
folder (copy `.env.example`) or set them before `npm start`:

| Setting | Default | What it does |
|---|---|---|
| `TASKS_FILE` | `data/tasks.json` | Where tasks are saved |
| `PORT` | `4321` | Which port the page is on |
| `URGENT_WITHIN_DAYS` | `3` | Due within this many days = urgent |
| `DO_NOW_LIMIT` | `5` | "Do now" is flagged above this many |
| `LUNATASK_TOKEN` | — | Turns on the Lunatask sync (see Sources) |
| `LOCAL_FOLDERS` | — | Folders to scan for `- [ ]` and `TODO:` lines, separated by `;` |
| `INBOX_FOLDER` | `data/inbox` | Where dropped-in task files are picked up |
| `SYNC_EVERY_MINUTES` | `15` | How often to sync; `0` = only on "Sync now" |

```
# PowerShell
$env:TASKS_FILE = "C:\path\to\tasks.json"; $env:DO_NOW_LIMIT = 4; npm start
```

### Trying it with sample data

```
npm run sample
```

Writes about 30 made-up tasks to `data/sample-tasks.json` and starts the app
on that file instead of your real one. It also makes a sample notes folder
and leaves a file in a sample inbox, so the first sync has something to
pick up; it never syncs your real Lunatask, notes or inbox. Due dates are set relative to today,
so there's always something overdue, something due today and an overfull
"Do now"; there are also two likely duplicates to merge and some closed
tasks to reopen. Run it again to reset. The source links are made up, so
they open the right site but not a real conversation. Details at the top of
`scripts/sample-data.ts`.

## Using it

The page opens on an **Eisenhower matrix**, with "Do now" (important and
urgent) top-left and its first task already highlighted. "Matrix" / "List"
at the top right (or `v`) switches to the plain list.

Type in the box at the top and press Enter. Optional shortcuts in the same
line:

| Type | Effect |
|---|---|
| `#claude` `#gemini` `#lunatask` `#local` | Records where the task came from |
| `!1` `!2` `!3` `!4` | Places it: Do now, Schedule, Delegate, Drop/defer |
| `due:2026-10-31` | Sets a due date |
| a pasted `https://…` link | Becomes a link back to it in that system — a `claude.ai` or Gemini link also sets the source |

So `Send Sarah the budget #claude !1 https://claude.ai/chat/abc` adds a task
tagged Claude, straight into "Do now", with the coloured "Claude ↗" label
linking to the conversation. Without `!1`–`!4` a task waits in "Not placed
yet" under the matrix.

**Moving tasks:** drag between quadrants, or select a task and press a
number. Set a due date in the edit panel (`e`).

| Key | Does |
|---|---|
| `n` | add a task |
| `j` / `k` | move down / up |
| `1` `2` `3` `4` | move to Do now / Schedule / Delegate / Drop or defer |
| `0` | back to "Not placed yet" |
| `i` / `u` | flip important / urgent |
| `x` / `d` | done / drop |
| `e` | edit |
| `o` | open the source link |
| `v` | matrix ↔ list |
| `Esc` | leave a text box |

**Due dates move tasks for you.** Anything due within 3 days, or overdue,
counts as urgent whatever you said, so it rises into "Do now" (or
"Delegate") on its own as the day approaches. The due label gets a ⏱ when
that's what's making it urgent.

**Too much in "Do now"?** Over 5 tasks, the quadrant turns red and says so.

Completing, dropping and merging all show an **Undo** for a few seconds, and
anything closed can be reopened from "Done, dropped and merged" at the bottom.

When two open tasks look like the same thing, a **possible duplicates** box
appears above the list. Merging keeps one task and remembers both sources;
"Not the same" stops that pair being suggested again.

## Sources

The **Sources** line under the filters shows each source's last sync (click
it for details and errors). **Sync now** syncs everything; it also happens
on start and every 15 minutes. Nothing is ever written back to another
system — see `docs/DECISIONS.md`, D8.

**Lunatask.** In the Lunatask desktop app: Settings → Access tokens →
create one. Put it in `.env` as `LUNATASK_TOKEN=…` and restart. Every open
Lunatask task then appears here, placed on the matrix by its Lunatask
quadrant. **Lunatask encrypts task names, so its API can't send them**:
each arrives as *Unnamed Lunatask task*, with its Lunatask status
underneath. Click the purple "Lunatask ↗" to open it there, then click the
title (or press `e`) and type its name — once per task. Completing or
deleting it in Lunatask closes it here; completing it here doesn't touch
Lunatask.

**Claude and Gemini.** At the end of a conversation, ask:

> List what we agreed I'd do as a task block: this conversation's link on
> the first line, then one task per line as `- title`, with `!1`–`!4` if
> it's clear which quadrant, and `due:YYYY-MM-DD` if there's a date.

Copy the answer and paste it into the capture box — every line becomes a
task, tagged with the source and linked to the conversation. Pasting the
same block again adds nothing. Or save the block as a `.md` file in
`data/inbox`: it's picked up at the next sync and moved to
`data/inbox/processed`. That's also how a Claude session working on this
computer can hand tasks over.

```
https://claude.ai/chat/abc123
- Send Sarah the budget draft !1 due:2026-10-17
- Book the venue for the offsite !2
```

**Files on this computer.** Set `LOCAL_FOLDERS` to your notes folders. In
`.md` and `.txt` files, `- [ ] …` lines and `TODO: …` lines become tasks
(code files are ignored). Tick the box or delete the line and the task
closes here at the next sync.

## Developing

```
npm install        # once — only fetches TypeScript, for type checking
npm test           # runs the tests in test/
npm run typecheck
```

| Where | What |
|---|---|
| `src/model.ts` | The `Task` type — start here |
| `src/tasks.ts` | Every rule about what can happen to a task |
| `src/priority.ts` | The Eisenhower rules: quadrants, due-date urgency, overload |
| `src/capture.ts` | Parsing the one-line quick-add |
| `src/duplicates.ts` | How likely duplicates are spotted |
| `src/sync.ts` | Phase 3: the rules for mirroring another system's tasks |
| `src/sources/` | One file per source: Lunatask, local files, inbox folder |
| `src/sync-runner.ts` | Runs the sources, on a timer and on "Sync now" |
| `src/store/` | Storage interface + the JSON file implementation |
| `src/app.ts` | HTTP routes (the API is listed at the top of the file) |
| `src/server.ts` | Startup: wires everything together |
| `public/` | The page: `index.html`, `app.js`, `styles.css` |
| `test/` | One test file per source file, plus end-to-end API tests |
| `scripts/sample-data.ts` | Sample tasks for `npm run sample` |
