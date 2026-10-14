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
folder. To change that or anything else, set these before `npm start`:

| Setting | Default | What it does |
|---|---|---|
| `TASKS_FILE` | `data/tasks.json` | Where tasks are saved |
| `PORT` | `4321` | Which port the page is on |
| `URGENT_WITHIN_DAYS` | `3` | Due within this many days = urgent |
| `DO_NOW_LIMIT` | `5` | "Do now" is flagged above this many |

```
# PowerShell
$env:TASKS_FILE = "C:\path\to\tasks.json"; $env:DO_NOW_LIMIT = 4; npm start
```

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
| a pasted `https://…` link | Becomes a link back to it in that system |

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
| `src/store/` | Storage interface + the JSON file implementation |
| `src/app.ts` | HTTP routes (the API is listed at the top of the file) |
| `src/server.ts` | Startup: wires everything together |
| `public/` | The page: `index.html`, `app.js`, `styles.css` |
| `test/` | One test file per source file, plus end-to-end API tests |
