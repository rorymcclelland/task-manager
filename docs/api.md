# HTTP API

The page talks to the server through a small JSON API, and anything else
on this computer can use it too: a script, a scheduled job, or a Claude
session with a shell. Routes are defined in [`src/app.ts`](../src/app.ts).

- **Base address:** `http://localhost:4321` (or your `PORT`). The server
  only listens on 127.0.0.1, so nothing else on the network can reach it.
- **No sign-in, but only for this computer** (D17): requests must be
  addressed to `localhost`/`127.0.0.1`, and **every POST and PATCH must
  send `Content-Type: application/json`** (even with no body), and
  mustn't come from another website. Scripts on this computer just add
  the header.
- **Bodies are JSON objects.** An empty body counts as `{}`.
- **Errors** come back as `{"error": "A readable message"}` with status
  400 (bad input), 403 (refused: not from this app or computer, or not
  JSON), 404 (no such task or route), 503 with `"kind": "task-file"`
  (tasks.json can't be read; nothing has been changed) or 500 (see the
  server console).
- **Dates** must be real calendar days: `2026-02-30` is a 400.

Task objects are described in [`data-model.md`](data-model.md). A
*prioritised task* is a task plus a `priority` object (placement,
urgency, due-in days, idle days, stale).

## Reading

### `GET /api/tasks?view=open|closed`
`open` (the default): open tasks, newest first, each prioritised.
`closed`: done, dropped and merged tasks, most recently closed first,
without `priority`.

### `GET /api/tasks/:id`
One task, prioritised (whatever its status).

### `GET /api/matrix`
Open tasks grouped into the Eisenhower matrix.

```json
{
  "today": "2026-10-14",
  "settings": { "urgentWithinDays": 3, "doNowLimit": 5, "staleAfterDays": 30, "doNowStaleAfterDays": 7 },
  "quadrants": [
    { "id": "do", "label": "Do now", "tasks": [ …prioritised tasks… ], "limit": 5, "overloaded": true },
    { "id": "schedule", … }, { "id": "delegate", … }, { "id": "eliminate", … },
    { "id": "untriaged", "label": "Not placed yet", … }
  ]
}
```

Always in that order. Within a quadrant: soonest due first, then oldest.

### `GET /api/duplicates[?limit=N]`
Likely duplicate pairs among open tasks, most similar first:
`[{ "a": task, "b": task, "score": 0.75 }]`. Unnamed Lunatask tasks and
pairs marked "not the same" are left out. With `?limit=N`, the answer is
`{ "total": 42, "pairs": [ …the top N… ] }` — the page asks for 10.

### `GET /api/health`
Problems with the task file's contents that didn't stop it loading —
entries set aside because they can't be tasks (D18):
`{ "taskFile": [ "Entry 4 in tasks.json isn't a task…" ] }`.

### `GET /api/agenda?from=YYYY-MM-DD&days=N`
Tasks and calendar events laid out by day. `from` defaults to today;
`days` is 1–62 (default 1). The Day view asks for one day, Ahead for 14.

```json
{
  "today": "2026-10-14", "from": "2026-10-14", "to": "2026-10-27",
  "dayHours": { "start": "09:00", "end": "18:00" },
  "overdue": [ …due before today… ],
  "missed": [ …planned for a day before today, still open… ],
  "dueLater": [ …the next 5 due after "to"… ],
  "days": [
    {
      "date": "2026-10-14", "isToday": true,
      "events": [ { "calendar": "Work", "title": "Standup", "location": "", "allDay": false,
                    "start": "09:30", "end": "09:45", "startsEarlier": false, "endsLater": false, "busy": true } ],
      "slotted": [ …tasks with a time slot that day, earliest first… ],
      "scheduled": [ …planned for that day, no time… ],
      "due": [ …due that day, not planned for it… ],
      "free": { "minutes": 265, "gaps": [ { "start": "12:05", "end": "15:00" } ] }
    }
  ],
  "unsupportedRules": 0,
  "calendars": [ "Work" ]
}
```

`overdue` and `missed` are only filled when the range includes today.
`free` is `null` for days already over. Event times are local to this
computer; an event running past midnight ends `"24:00"`.

### `GET /api/review`
What needs a decision, in review order.

```json
{
  "items": [ { "task": …prioritised task…, "reason": "untriaged", "reasons": ["untriaged", "overdue"] } ],
  "counts": { "untriaged": 11, "unnamed": 2, "overdue": 1, "missed": 1, "stale": 3, "overload": 7 }
}
```

Reasons, in order: `untriaged`, `unnamed`, `overdue`, `missed`, `stale`,
`overload`. Each task appears once, under its first reason; `counts`
counts every reason.

### `GET /api/sync`
Each source's set-up and health:

```json
[
  {
    "id": "lunatask", "label": "Lunatask", "configured": true,
    "setup": "Mirrors your Lunatask tasks (read-only)…",
    "health": "error",
    "problem": "Lunatask hasn't synced since 10:42 (3 tries in a row): …",
    "lastSuccessAt": "2026-10-14T09:42:00.000Z", "failures": 3,
    "lastRun": { "at": "…", "ok": false, "summary": "", "warnings": [], "error": "…" }
  }
]
```

`id` is `lunatask`, `local`, `inbox` or `calendar`. `health` is `off`,
`pending`, `ok`, `warn`, `error` or `stale` (see the user guide,
"When a sync fails").

## Adding tasks

### `POST /api/capture` `{"text": "…"}` → 201, task
One line, with the same shortcuts as the capture box: `#claude`, `!1`–`!4`,
`due:YYYY-MM-DD`, `on:YYYY-MM-DD`, `at:HH:MM`, and a link. Never
de-duplicated.

### `POST /api/capture/block` `{"text": "…"}` → 201
Several lines, as pasted from a conversation (format in the user guide).
Lines already here, matched on source, link and title, are skipped.
`ignored` lists line numbers left out because they had shortcuts but no
title, part-way down the list (a stray `- !1`).

```json
{ "created": [ …tasks… ], "skipped": 1, "ignored": [4] }
```

400 if no line has a title.

### `POST /api/tasks` → 201, task
```json
{ "title": "…", "notes": "…", "source": "claude", "url": "https://…", "externalId": "…",
  "placement": "schedule", "dueDate": "2026-10-31", "scheduledDate": "2026-10-20",
  "slot": { "start": "14:00", "minutes": 60 } }
```
Only `title` is required. `source` defaults to `manual`, `placement` to
`untriaged`.

## Changing tasks

### `PATCH /api/tasks/:id` → 200, prioritised task
Any of: `title`, `notes`, `source`, `url`, `important`, `urgent`,
`dueDate`, `scheduledDate`, `slot`. Use `null` to clear. Other fields
(`id`, `status`, timestamps…) are ignored. Clearing `scheduledDate` also
clears `slot`. Renaming an unnamed Lunatask task clears its placeholder
flag. Counts as attention (sets `reviewedAt`).

Scheduling (4.2) is a PATCH:
`{"scheduledDate": "2026-10-20", "slot": {"start": "14:00", "minutes": 30}}`.

### `POST /api/tasks/:id/place` `{"quadrant": "…"}` → 200, prioritised task
`do`, `schedule`, `delegate`, `eliminate` or `untriaged`. Sets both
Eisenhower answers. The due-date rule still applies afterwards; compare
`priority.placement` with what you asked for to see if it overruled you.

### `POST /api/tasks/:id/complete` · `/drop` → 200, task
Close it as done or dropped. 400 if it's already closed.

### `POST /api/tasks/:id/reopen` → 200, task
Back to open. Reopening a merged task undoes the merge, including
removing its sources from the task it was merged into.

### `POST /api/tasks/:id/merge` `{"intoId": "…"}` → 200
Fold this task into another. The kept task gains this one's sources.

```json
{ "kept": task, "merged": task }
```

### `POST /api/tasks/:id/not-duplicate` `{"otherId": "…"}` → 200
Stop suggesting this pair. Returns `{"ok": true}`.

### `POST /api/tasks/:id/keep` → 200, prioritised task
"Still relevant": resets the idle clock without changing anything else.

### `POST /api/tasks/:id/reviewed-at` `{"reviewedAt": "ISO timestamp" | null}` → 200, task
Puts `reviewedAt` back; the undo for `keep`.

## Syncing

### `POST /api/sync` → 200, same shape as `GET /api/sync`
Run every configured source now and wait for the result. If a sync is
already running, waits for that one instead of starting another.

## Examples

Every example sends `Content-Type: application/json`; without it, changes
are refused (403).

```powershell
# Add a task from PowerShell
Invoke-RestMethod -Method Post -Uri http://localhost:4321/api/capture `
  -ContentType 'application/json' -Body '{"text":"Ring the bank !1 due:2026-10-20"}'

# What's in Do now?
(Invoke-RestMethod http://localhost:4321/api/matrix).quadrants[0].tasks | Select-Object title, dueDate
```

```bash
curl -s -X POST localhost:4321/api/capture -H 'Content-Type: application/json' \
  -d '{"text":"Send the deck #claude !2 on:2026-10-20 at:10:00"}'
```

For anything that can't make HTTP calls, the inbox folder does the same
job with plain files (user guide, "Claude and Gemini").
