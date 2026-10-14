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
folder. To keep them somewhere else, or use another port:

```
# PowerShell
$env:TASKS_FILE = "C:\path\to\tasks.json"; $env:PORT = 5000; npm start
```

## Using it

Type in the box at the top and press Enter. Two optional shortcuts in the
same line:

| Type | Effect |
|---|---|
| `#claude` `#gemini` `#lunatask` `#local` | Records where the task came from |
| a pasted `https://…` link | Becomes a link back to it in that system |

So `Send Sarah the budget #claude https://claude.ai/chat/abc` adds a task
tagged Claude, with the coloured "Claude ↗" label linking to the conversation.

Keyboard: `n` add · `j`/`k` move · `x` done · `d` drop · `e` edit ·
`o` open the source link · `Esc` leave a text box.

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
| `src/capture.ts` | Parsing the one-line quick-add |
| `src/duplicates.ts` | How likely duplicates are spotted |
| `src/store/` | Storage interface + the JSON file implementation |
| `src/app.ts` | HTTP routes (the API is listed at the top of the file) |
| `src/server.ts` | Startup: wires everything together |
| `public/` | The page: `index.html`, `app.js`, `styles.css` |
| `test/` | One test file per source file, plus end-to-end API tests |
