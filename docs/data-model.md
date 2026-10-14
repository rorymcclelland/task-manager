# Data model

Everything the app knows about your tasks lives in one JSON file,
`data/tasks.json` by default (`TASKS_FILE` changes it). This page
describes that file, every field in a task, and what's deliberately
*not* stored. The type definitions with comments are in
[`src/model.ts`](../src/model.ts); the reasons are in
[`DECISIONS.md`](DECISIONS.md) (D2, D3, D5, D12, D14).

## The file

```json
{
  "version": 1,
  "tasks": [ { …task… }, { …task… } ]
}
```

- **Pretty-printed,** so you can read it, and sync or diff tools show
  small changes as small.
- **Written safely.** Each save writes `tasks.json.tmp`, then renames it
  over `tasks.json`. A rename is all-or-nothing, so a crash or a sync
  client mid-copy leaves the old file or the new one, never half of each.
  On Windows a rename blocked by another program is retried briefly.
- **Read fresh every time.** Nothing is cached in memory, so an edit made
  in a text editor, or on another machine via the sync folder, is
  picked up on the next request.
- **One change at a time.** Saves are queued, so two requests at once can't
  undo each other.
- **Never trimmed.** Nothing is ever deleted. Done, dropped and merged
  tasks stay in the file and can be reopened.
- **Kept out of git.** `data/` is in `.gitignore`.
- **`version`** lets a later release migrate old files. A file whose
  version isn't `1` is refused, not overwritten.
- **A byte-order mark** at the start (older Notepad) is ignored.

## A task

A real example, a Lunatask task that's been named, merged with a
duplicate and placed:

```json
{
  "id": "78714d8a-7a24-48ce-b7c5-987e073bc788",
  "title": "Pay electricity bill",
  "notes": "",
  "origin": {
    "source": "lunatask",
    "externalId": "b2dc1468-8106-489d-a92e-5a8b022fa07a",
    "url": "lunatask://tasks/b2dc1468-8106-489d-a92e-5a8b022fa07a"
  },
  "alsoIn": [ { "source": "manual", "externalId": null, "url": null } ],
  "important": true,
  "urgent": false,
  "dueDate": "2026-10-12",
  "scheduledDate": null,
  "slot": null,
  "status": "open",
  "mergedInto": null,
  "notDuplicateOf": [],
  "createdAt": "2026-10-02T08:15:00.000Z",
  "updatedAt": "2026-10-14T12:09:17.594Z",
  "closedAt": null,
  "reviewedAt": "2026-10-14T12:09:17.594Z",
  "mirror": {
    "detail": "Lunatask: next · must",
    "openInSource": true,
    "placeholderTitle": false,
    "sourceScheduledDate": null
  }
}
```

### Fields

| Field | Type | Meaning |
|---|---|---|
| `id` | string (UUID) | This app's id for the task. Never changes. |
| `title` | string | What it is. Spaces are collapsed; never empty. |
| `notes` | string | Free text. Empty string if none. |
| `origin` | SourceRef | Where it was first seen (below). |
| `alsoIn` | SourceRef[] | Other systems it also lives in, added when duplicates are merged. |
| `important` | `true` / `false` / `null` | Your Eisenhower answer. `null` = not decided yet, which is different from "no". |
| `urgent` | `true` / `false` / `null` | The same. A near due date can make a task urgent regardless (see "Worked out, not stored" below). |
| `dueDate` | `YYYY-MM-DD` or `null` | When it must be done by. Must be a real day: `2026-02-30` is refused. |
| `scheduledDate` | `YYYY-MM-DD` or `null` | The day you mean to do it. |
| `slot` | `{start, minutes}` or `null` | A time on the scheduled day: `start` is `"HH:MM"` (24-hour), `minutes` 5–1440, finishing by midnight. Only allowed with a `scheduledDate`. _Phase 4; may be missing in older files._ |
| `status` | `open` / `done` / `dropped` / `merged` | Done = you did it. Dropped = it stopped being real. Merged = it was a duplicate. |
| `mergedInto` | id or `null` | For merged tasks: the task that absorbed it. |
| `notDuplicateOf` | id[] | Tasks you've said aren't duplicates of this one, so they're not suggested again. |
| `createdAt` | ISO timestamp | When it was added here. |
| `updatedAt` | ISO timestamp | Last change of any kind, by you or a sync. |
| `closedAt` | ISO timestamp or `null` | When it left `open`. |
| `reviewedAt` | ISO timestamp | The last time *you* paid it attention: created, edited, placed, scheduled, reopened, or "still relevant". Syncs never set it. Drives idle flags. _Phase 5; may be missing in older files._ |
| `mirror` | MirrorInfo | Only on tasks a sync keeps up to date (Lunatask, notes files). |

**SourceRef** — a pointer back to the task in another system:

| Field | Meaning |
|---|---|
| `source` | `manual`, `claude`, `gemini`, `lunatask` or `local` |
| `externalId` | That system's id, if it has one: the Lunatask task id, or `file :: line text` for notes |
| `url` | A link that opens it there: `https://…` or `lunatask://…` only |

**MirrorInfo** — what a sync knows:

| Field | Meaning |
|---|---|
| `detail` | What the source last said, in words, e.g. `Lunatask: next · must`, or `C:\Notes\kitchen.md, line 4` |
| `openInSource` | Whether the source had it open at the last sync. A task is closed here only when this flips from true to false, so reopening it here sticks. |
| `placeholderTitle` | True while the title is "Unnamed Lunatask task". Cleared when you rename it. |
| `sourceScheduledDate` | The scheduled date the source gave last time. The source's date replaces yours only when this changes (D12). |

### Dates and times

- **Dates are calendar days** (`2026-10-31`), not instants, so "due Friday"
  can't shift a day when the clocks change or you travel.
- **Slot times are wall-clock times** (`14:00`), for the same reason.
- **Timestamps** (`createdAt` and the rest) are instants in UTC (`…Z`).
  They're converted to this computer's local date where a day matters,
  e.g. "idle for 12 days".

## Worked out, not stored

These are calculated every time a page asks, from the stored fields plus
today's date. Nothing rewrites the file just because time has passed.
They come back from the API as `priority` on each open task:

| Field | How it's worked out |
|---|---|
| `placement` | Quadrant from `important` + effective urgency: `do`, `schedule`, `delegate`, `eliminate`, or `untriaged` if either answer is missing |
| `urgent` | `true` if due within `URGENT_WITHIN_DAYS` (default 3) or overdue; otherwise your answer; otherwise `false` if it has a later due date; otherwise `null` |
| `urgencyReason` | `due-soon`, `marked`, `due-later` or `undecided`, so the page can explain itself |
| `dueInDays` | Days until due: 0 today, negative overdue, `null` without a due date |
| `idleDays` | Days since `reviewedAt` (older tasks: last edit, or created date for mirrored tasks) |
| `stale` | Idle ≥ 30 days (7 in Do now) and no due date or planned day still to come |

The code is [`src/priority.ts`](../src/priority.ts).

## Never stored in `tasks.json`

| What | Where it lives | Why |
|---|---|---|
| Quadrants, urgency, idle flags | Calculated (above) | Time passing would mean rewriting the file (D5) |
| Calendar events | Server memory, refetched every sync | Events aren't tasks; hundreds of them would churn the sync-folder file (D11) |
| Sync status and health | Server memory | About this run of the app only (D16) |
| Review progress | The browser tab | A review is a session (D15) |
| The Lunatask token, calendar addresses | `.env` | They're passwords; `.env` is kept out of git |

## Files older versions wrote

Each phase added fields as optional, so a file from any earlier phase
loads unchanged. Missing `slot` reads as no slot. Missing `mirror`
means not mirrored. For a missing `reviewedAt`, idle time is counted from
the last edit (your own tasks) or the creation date (mirrored tasks).
Nothing is rewritten until the task itself changes.

## Editing the file by hand

It's safe to edit while the app is stopped, or running, because the file
is re-read on every request. What happens to mistakes (D18):

- **Broken JSON** (or a newer version number): a red banner says what's
  wrong; nothing is written to the file until it reads again.
- **A byte-order mark** (as older Notepad adds): ignored.
- **A task with missing or odd fields**, say only `id`, `title` and
  `status`: filled in with defaults (not decided, no dates) and used. It's
  saved back repaired only when it next changes.
- **An entry with no `id` or `title`:** left out, kept in the file as it
  was, and named in an amber banner until you fix it.
