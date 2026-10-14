// Entry point: `npm start` runs this file.
//
// Wires the pieces together — file store → task service → HTTP app — and
// starts listening. Settings, all optional, via environment variables:
//
//   PORT                which port to serve on (default 4321)
//   TASKS_FILE          where the task data lives (default: data/tasks.json in this folder)
//   URGENT_WITHIN_DAYS  a task due within this many days counts as urgent (default 3)
//   DO_NOW_LIMIT        "Do now" is flagged as overloaded above this many tasks (default 5)

import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createApp } from './app.ts';
import { DEFAULT_SETTINGS, type PrioritySettings } from './priority.ts';
import { JsonFileStore } from './store/json-file-store.ts';
import { TaskService } from './tasks.ts';

const port = Number(process.env.PORT ?? 4321);
const tasksFile = resolve(process.env.TASKS_FILE ?? join(import.meta.dirname, '..', 'data', 'tasks.json'));

const settings: PrioritySettings = {
  urgentWithinDays: wholeNumber('URGENT_WITHIN_DAYS', DEFAULT_SETTINGS.urgentWithinDays),
  doNowLimit: wholeNumber('DO_NOW_LIMIT', DEFAULT_SETTINGS.doNowLimit),
};

const service = new TaskService(new JsonFileStore(tasksFile), () => new Date(), settings);
const server = createServer(createApp(service));

// 127.0.0.1 rather than all network interfaces: the app is reachable from
// this computer only, not from anything else on the same Wi-Fi.
server.listen(port, '127.0.0.1', () => {
  console.log(`Task app running at http://localhost:${port}`);
  console.log(`Tasks stored in ${tasksFile}`);
  console.log(`Urgent when due within ${settings.urgentWithinDays} days; "Do now" limit ${settings.doNowLimit}`);
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
