// Entry point: `npm start` runs this file.
//
// Wires the pieces together — file store → task service → HTTP app — and
// starts listening. Two settings, both optional, via environment variables:
//
//   PORT        which port to serve on (default 4321)
//   TASKS_FILE  where the task data lives (default: data/tasks.json in this folder)

import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createApp } from './app.ts';
import { JsonFileStore } from './store/json-file-store.ts';
import { TaskService } from './tasks.ts';

const port = Number(process.env.PORT ?? 4321);
const tasksFile = resolve(process.env.TASKS_FILE ?? join(import.meta.dirname, '..', 'data', 'tasks.json'));

const service = new TaskService(new JsonFileStore(tasksFile));
const server = createServer(createApp(service));

// 127.0.0.1 rather than all network interfaces: the app is reachable from
// this computer only, not from anything else on the same Wi-Fi.
server.listen(port, '127.0.0.1', () => {
  console.log(`Task app running at http://localhost:${port}`);
  console.log(`Tasks stored in ${tasksFile}`);
});
