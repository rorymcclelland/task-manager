# Setup, configuration and troubleshooting

Everything needed to get the app running on a PC, connect each source,
and fix the usual problems. For what to do once it's running, see the
[user guide](user-guide.md).

## 1. Install

1. **Node.js 22.18 or newer** from <https://nodejs.org> (the LTS
   installer is fine). Check in PowerShell: `node --version`.
2. **The project folder** — either the synced copy at
   `C:\Data\Sync\My files\Projects\Task management app`, or a clone of
   `github.com/rorymcclelland/task-manager`.

Nothing else. The app has no runtime dependencies; `npm install` is only
needed for development (it fetches TypeScript for type checking).

## 2. Start it

In PowerShell, in the project folder:

```powershell
npm start
```

Open <http://localhost:4321>. The console shows where tasks are stored,
the urgency settings, and each source as on or off. Leave the window
open; closing it stops the app (the page will say "Can't reach the app").

**Try it with made-up data first:** `npm run sample` writes about 30
sample tasks, a notes folder, an inbox file and a calendar, then starts
the app on those instead of your real data. Run it again to reset. It
never touches your real tasks, Lunatask, notes or calendar.

## 3. Configure

Settings go in a file called `.env` in the project folder — copy
`.env.example` to `.env` and fill in what you need. Every setting is
optional. Restart the app after changing it. `.env` is kept out of git,
so tokens and private addresses in it never reach GitHub.

| Setting | Default | What it does |
|---|---|---|
| `TASKS_FILE` | `data/tasks.json` | Where tasks are saved |
| `PORT` | `4321` | Which port the page is on |
| `URGENT_WITHIN_DAYS` | `3` | A task due within this many days (or overdue) counts as urgent |
| `DO_NOW_LIMIT` | `5` | "Do now" is flagged as overloaded above this many |
| `STALE_AFTER_DAYS` | `30` | A task you haven't touched this long is flagged idle |
| `DO_NOW_STALE_AFTER_DAYS` | `7` | …or this long, if it's in "Do now" |
| `LUNATASK_TOKEN` | — | Turns on the Lunatask mirror |
| `LOCAL_FOLDERS` | — | Notes folders to scan for `- [ ]` and `TODO:`, separated by `;` |
| `INBOX_FOLDER` | `inbox` next to the tasks file | Where dropped-in task files are picked up |
| `CALENDAR_URLS` | — | Your calendar's private .ics address (or an .ics file), several separated by `;` |
| `DAY_HOURS` | `09:00-18:00` | Your working day; free time is counted inside it |
| `SYNC_EVERY_MINUTES` | `15` | How often to sync; `0` = only on "Sync now" |

Numbers that don't make sense are ignored with a warning in the console,
and the default is used.

An example `.env`:

```
LUNATASK_TOKEN=eyJhbGciOi…
LOCAL_FOLDERS=C:\Data\Sync\My files\Notes;C:\Data\Sync\My files\Projects
CALENDAR_URLS=https://calendar.google.com/calendar/ical/…/basic.ics
DAY_HOURS=08:30-17:30
```

## 4. Connect the sources

All sources are read-only: nothing this app does changes Lunatask, your
notes or your calendar.

### Lunatask

1. In the Lunatask desktop app: **Settings → Access tokens → create one**.
2. Put it in `.env` as `LUNATASK_TOKEN=…` and restart.

Every open Lunatask task appears within a few seconds, placed on the
matrix by its Lunatask quadrant. **Lunatask encrypts task names, so its
API can't send them:** each arrives as *Unnamed Lunatask task*. Name each
one once — the review (`r`) walks through them, with a link to open
the task in Lunatask. Completing or deleting a task in Lunatask closes it
here at the next sync; completing it here doesn't touch Lunatask.

### Notes folders

Set `LOCAL_FOLDERS` to one or more folders. In `.md`, `.markdown` and
`.txt` files, unticked checkboxes (`- [ ] …`, `* [ ] …`, `1. [ ] …`) and
lines with an upper-case `TODO:` become tasks. Tick the box or delete
the line and the task closes at the next sync. Limits: 4 folder levels
deep, 2,000 files, files over 1 MB skipped; hidden folders,
`node_modules` and the inbox are skipped; code files are ignored.

### Claude and Gemini

No set-up. At the end of a conversation, ask the assistant:

> List what we agreed I'd do as a task block: this conversation's link on
> the first line, then one task per line as `- title`, with `!1`–`!4` if
> it's clear which quadrant, and `due:YYYY-MM-DD` if there's a date.

Paste the answer into the capture box, or save it as a `.md` file in the
inbox folder. For Claude, the same instruction can go in a Project's
instructions so it happens without asking.

### Calendar

Lunatask's API doesn't include the calendar, so the app reads it from the
calendar's private iCal address:

- **Google Calendar** (web): Settings → your calendar under "Settings
  for my calendars" → Integrate calendar → **Secret address in iCal
  format**.
- **Outlook / Microsoft 365** (web): Settings → Calendar → Shared
  calendars → **Publish a calendar** → "Can view all details" → copy the
  **ICS** link. (Some work accounts have this turned off.)
- **iCloud**: share the calendar as a **Public Calendar** and copy the
  `webcal://` link.

Put it in `CALENDAR_URLS` and restart. **Treat the address like a
password** — anyone with it can read your calendar. If it leaks, reset
it in the calendar's settings and paste the new one in. Providers update
these addresses on their own schedule, so a brand-new meeting can take a
while to appear.

## 5. Your data

- **Where:** `data/tasks.json` (or `TASKS_FILE`). Inside the sync folder,
  so it's backed up and available on your other machines.
- **Backups:** nothing is ever deleted from the file, and each save
  replaces it in one step. To keep a dated copy, copy the file somewhere;
  to restore, stop the app and copy it back.
- **Two machines:** fine one at a time. If the app runs on two machines at
  once against the same synced file, the last save wins.
- **Format:** see [data-model.md](data-model.md).

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| `npm start` fails with "Unknown file extension .ts" | Node is older than 22.18 | Install a newer Node |
| `EADDRINUSE` in the console | Something already uses port 4321 — often the app itself, still running in another window | Close the other window, or set `PORT=4322` in `.env` |
| Red banner: *Can't reach the app* | The page lost the server: window closed, PC slept, or it crashed | Run `npm start` again; the banner clears by itself |
| Red banner: *Lunatask hasn't synced… rejected the access token* | Token revoked or mistyped | Make a new token, update `.env`, restart |
| Red banner: *…the calendar address was refused (404)* | The private address was reset | Copy the new address into `CALENDAR_URLS` |
| Red banner: *…didn't return a calendar* | The link is to the calendar's web page, not the iCal address | Use the "iCal format" / "ICS" link |
| Red banner: *…hasn't synced since…, though it should every 15 minutes* | A sync is stuck, or the app's timer stopped | Click Sync now; if it stays, restart the app |
| Amber dot on a source | It synced, but something's worth knowing (e.g. an unreadable notes file) | Open *Sources* to read it |
| Red banner: *Your tasks can't be loaded. The task file can't be read: …* | `tasks.json` is damaged (half-synced, or a hand edit broke the JSON) or from a newer app version | The banner says what's wrong and where the file is. Restore a copy or fix the JSON; the banner clears by itself. Nothing is written to the file until it reads again (D18) |
| Amber banner: *Entry 4 in tasks.json isn't a task the app can use* | A hand edit left an entry with no `id` or `title` | Fix or remove that entry by hand. It's kept in the file, untouched, until you do |
| `403` from a script calling the API | The request isn't sent as JSON, or names another site as its origin | Add `Content-Type: application/json` to every POST/PATCH (D17) |
| Lunatask tasks all say *Unnamed Lunatask task* | Expected — Lunatask encrypts names | Name them once, via the review |
| A ticked notes checkbox didn't close the task | The next sync hasn't run, or the file moved | Click Sync now. Moving or renaming a file doesn't close its tasks, by design |
| Sources warning: *…doesn't look like a text file* | An inbox or notes file is UTF-16 without a byte-order mark, or not text | Save it as UTF-8. (UTF-8 and UTF-16 with a byte-order mark — what Notepad and PowerShell 5 write — are both read fine.) The inbox file stays where it is |
| Sources warning: *line 4 had shortcuts but no task title, so it was skipped* | A stray `- !1` (or `- due:…`) part-way down an inbox file | Nothing to do unless that line was meant to be a task |
| Times in the calendar are an hour out | The calendar uses a time zone this app doesn't recognise | *Sources* names the zone; tell Claude so it can be added to `src/calendar/zones.ts` |
