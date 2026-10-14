// Entry point: `npm start` runs this file.
//
// Wires the pieces together — file store → task service → HTTP app — and
// starts listening. Settings, all optional, via environment variables:
//
//   PORT                which port to serve on (default 4321)
//   TASKS_FILE          where the task data lives (default: data/tasks.json in this folder)
//   URGENT_WITHIN_DAYS  a task due within this many days counts as urgent (default 3)
//   DO_NOW_LIMIT        "Do now" is flagged as overloaded above this many tasks (default 5)
//
// Phase 3 — pulling in other systems (see README.md, "Sources"):
//
//   LUNATASK_TOKEN      a Lunatask access token; without it, Lunatask isn't synced
//   LOCAL_FOLDERS       folders to scan for "- [ ]" and "TODO:" lines, separated by ;
//   INBOX_FOLDER        where dropped-in task files are picked up (default: an
//                       "inbox" folder next to the tasks file)
//   SYNC_EVERY_MINUTES  how often to sync (default 15; 0 = only on "Sync now")
//
// Phase 4 — time:
//
//   CALENDAR_URLS       your calendar's private iCal (.ics) address — or a
//                       path to an .ics file — several separated by ;
//   DAY_HOURS           your working day, for counting free time (default 09:00-18:00)
//
// `npm start` reads these from a .env file in this folder if there is one
// (copy .env.example). .env is kept out of git: the token is a password.

import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_DAY_HOURS, parseDayHours } from './agenda.ts';
import { createApp } from './app.ts';
import { Calendars } from './sources/calendar.ts';
import { DEFAULT_SETTINGS, type PrioritySettings } from './priority.ts';
import { JsonFileStore } from './store/json-file-store.ts';
import { SyncRunner } from './sync-runner.ts';
import { TaskService } from './tasks.ts';

const port = Number(process.env.PORT ?? 4321);
const tasksFile = resolve(process.env.TASKS_FILE ?? join(import.meta.dirname, '..', 'data', 'tasks.json'));

const settings: PrioritySettings = {
  urgentWithinDays: wholeNumber('URGENT_WITHIN_DAYS', DEFAULT_SETTINGS.urgentWithinDays),
  doNowLimit: wholeNumber('DO_NOW_LIMIT', DEFAULT_SETTINGS.doNowLimit),
};

const service = new TaskService(new JsonFileStore(tasksFile), () => new Date(), settings);

const localFolders = (process.env.LOCAL_FOLDERS ?? '')
  .split(';')
  .map((folder) => folder.trim())
  .filter(Boolean)
  .map((folder) => resolve(folder));
const inboxFolder = resolve(process.env.INBOX_FOLDER || join(dirname(tasksFile), 'inbox'));
const calendar = new Calendars(
  (process.env.CALENDAR_URLS ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (/^(https?|webcal):\/\//i.test(entry) ? entry : resolve(entry))),
);
const dayHours = process.env.DAY_HOURS ? parseDayHours(process.env.DAY_HOURS) : DEFAULT_DAY_HOURS;
if (!dayHours) console.warn(`Ignoring DAY_HOURS=${process.env.DAY_HOURS} (needs something like 09:00-17:30)`);

const sync = new SyncRunner(service, {
  lunatask: { token: process.env.LUNATASK_TOKEN?.trim() || null },
  local: { folders: localFolders },
  inbox: { folder: inboxFolder },
  calendar,
});

const server = createServer(createApp(service, sync, { calendar, dayHours: dayHours ?? DEFAULT_DAY_HOURS }));

// 127.0.0.1 rather than all network interfaces: the app is reachable from
// this computer only, not from anything else on the same Wi-Fi.
server.listen(port, '127.0.0.1', () => {
  console.log(`Task app running at http://localhost:${port}`);
  console.log(`Tasks stored in ${tasksFile}`);
  console.log(`Urgent when due within ${settings.urgentWithinDays} days; "Do now" limit ${settings.doNowLimit}`);
  for (const status of sync.statuses()) {
    console.log(`${status.label}: ${status.configured ? 'on' : 'off'} — ${status.setup}`);
  }
  sync.start(wholeNumber('SYNC_EVERY_MINUTES', 15));
});

/** Read a whole-number setting, falling back to the default if it's missing or nonsense. */
function wholeNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 0) return value;
  console.warn(`Ignoring ${name}=${raw} (needs a whole number, 0 or more); using ${fallback}`);
  return fallback;
}
