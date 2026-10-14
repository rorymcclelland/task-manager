// The HTTP layer: maps URLs to TaskService calls and serves the browser UI.
//
// Built on Node's own `http` module rather than a framework like Express —
// there are only a handful of routes, and this way every line that handles a
// request is visible here.
//
// API (all JSON):
//   GET   /api/tasks?view=open|closed      list tasks (open ones include `priority`)
//   GET   /api/matrix                      open tasks grouped by Eisenhower quadrant
//   POST  /api/capture      {text}         quick-add from one typed line
//   POST  /api/capture/block {text}        add every task in a pasted block of lines
//   POST  /api/tasks        {title, notes?, source?, url?, externalId?}
//   PATCH /api/tasks/:id    {title?, notes?, source?, url?, ...}
//   POST  /api/tasks/:id/complete
//   POST  /api/tasks/:id/drop
//   POST  /api/tasks/:id/reopen
//   POST  /api/tasks/:id/place          {quadrant}  do|schedule|delegate|eliminate|untriaged
//   POST  /api/tasks/:id/merge          {intoId}   fold this task into another
//   POST  /api/tasks/:id/not-duplicate  {otherId}
//   GET   /api/duplicates
//   GET   /api/sync                        each source's set-up and last sync
//   POST  /api/sync                        sync every source now
//   GET   /api/agenda?from=YYYY-MM-DD&days=N   tasks and calendar events by day (Phase 4)
//   GET   /api/review                      what needs a decision, in order (5.2)
//   POST  /api/tasks/:id/keep              "still relevant": resets its idle clock (5.1)
//   POST  /api/tasks/:id/reviewed-at {reviewedAt}   puts it back (undo for keep)
//
// Scheduling a task (4.2) is a PATCH: {scheduledDate, slot: {start, minutes} | null}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { DEFAULT_DAY_HOURS, type DayHours } from './agenda.ts';
import { localZone } from './calendar/zones.ts';
import { parseCapture, parseCaptureBlock } from './capture.ts';
import { isDateString } from './model.ts';
import type { Calendars } from './sources/calendar.ts';
import type { SyncRunner } from './sync-runner.ts';
import { NotFoundError, TaskService, ValidationError, type NewTask } from './tasks.ts';

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/** Phase 4 settings for the Day and Ahead views. */
export interface TimeOptions {
  calendar?: Calendars;
  /** The zone calendar times are shown in. Default: this computer's. */
  zone?: string;
  dayHours?: DayHours;
}

/** Everything but `service` is optional, so tests can leave out what they don't need. */
export function createApp(service: TaskService, sync?: SyncRunner, time: TimeOptions = {}): Handler {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(service, sync, time, request, response, url);
      } else {
        await serveStatic(url.pathname, response);
      }
    } catch (error) {
      if (error instanceof ValidationError) return sendJson(response, 400, { error: error.message });
      if (error instanceof NotFoundError) return sendJson(response, 404, { error: error.message });
      console.error(error);
      sendJson(response, 500, { error: 'Something went wrong — see the server console' });
    }
  };
}

async function handleApi(
  service: TaskService,
  sync: SyncRunner | undefined,
  time: TimeOptions,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const method = request.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api', 'tasks', '<id>', 'merge']
  const [, resource, id, action] = parts;

  if (resource === 'tasks' && !id) {
    if (method === 'GET') {
      const view = url.searchParams.get('view') ?? 'open';
      const tasks = view === 'closed' ? await service.listClosed() : await service.listOpen();
      return sendJson(response, 200, tasks);
    }
    // The body is untrusted, but TaskService validates every field it uses.
    if (method === 'POST') return sendJson(response, 201, await service.create((await readJson(request)) as NewTask));
  }

  if (resource === 'capture' && id === 'block' && method === 'POST') {
    const { text } = await readJson(request);
    const lines = parseCaptureBlock(String(text ?? ''), service.today());
    if (lines.length === 0) throw new ValidationError('No tasks found in that text');
    return sendJson(response, 201, await service.captureMany(lines));
  }

  if (resource === 'capture' && !id && method === 'POST') {
    const { text } = await readJson(request);
    const parsed = parseCapture(String(text ?? ''), service.today());
    return sendJson(response, 201, await service.create(parsed));
  }

  if (resource === 'matrix' && method === 'GET') return sendJson(response, 200, await service.matrix());

  if (resource === 'review' && method === 'GET') return sendJson(response, 200, await service.review());

  if (resource === 'duplicates' && method === 'GET') {
    const pairs = await service.duplicates();
    return sendJson(response, 200, pairs.map((p) => ({ a: p.a, b: p.b, score: p.score })));
  }

  if (resource === 'agenda' && method === 'GET') {
    const from = url.searchParams.get('from') ?? service.today();
    const days = Number(url.searchParams.get('days') ?? 1);
    if (!isDateString(from)) throw new ValidationError('from must be a YYYY-MM-DD date');
    if (!Number.isInteger(days) || days < 1 || days > 62) throw new ValidationError('days must be a whole number from 1 to 62');
    const zone = time.zone ?? localZone();
    const to = new Date(Date.parse(`${from}T00:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const events = time.calendar?.between(from, to, zone) ?? { occurrences: [], unsupportedRules: 0 };
    return sendJson(response, 200, {
      ...(await service.agenda({ from, days, zone, dayHours: time.dayHours ?? DEFAULT_DAY_HOURS, ...events })),
      calendars: time.calendar?.configured ? time.calendar.names() : [],
    });
  }

  if (resource === 'sync' && !id) {
    if (!sync) return sendJson(response, 200, []);
    if (method === 'GET') return sendJson(response, 200, sync.statuses());
    if (method === 'POST') return sendJson(response, 200, await sync.syncAll());
  }

  if (resource === 'tasks' && id && !action) {
    if (method === 'GET') return sendJson(response, 200, await service.getPrioritised(id));
    if (method === 'PATCH') {
      await service.update(id, await readJson(request));
      return sendJson(response, 200, await service.getPrioritised(id));
    }
  }

  if (resource === 'tasks' && id && action && method === 'POST') {
    switch (action) {
      case 'complete':
        return sendJson(response, 200, await service.complete(id));
      case 'drop':
        return sendJson(response, 200, await service.drop(id));
      case 'reopen':
        return sendJson(response, 200, await service.reopen(id));
      case 'keep':
        return sendJson(response, 200, await service.keep(id));
      case 'reviewed-at': {
        const { reviewedAt } = await readJson(request);
        return sendJson(response, 200, await service.setReviewedAt(id, reviewedAt ?? null));
      }
      case 'place': {
        const { quadrant } = await readJson(request);
        return sendJson(response, 200, await service.place(id, quadrant));
      }
      case 'merge': {
        const { intoId } = await readJson(request);
        return sendJson(response, 200, await service.merge(id, String(intoId)));
      }
      case 'not-duplicate': {
        const { otherId } = await readJson(request);
        await service.markNotDuplicate(id, String(otherId));
        return sendJson(response, 200, { ok: true });
      }
    }
  }

  sendJson(response, 404, { error: `No route for ${method} ${url.pathname}` });
}

async function serveStatic(pathname: string, response: ServerResponse) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = normalize(join(PUBLIC_DIR, relative));
  // Refuse paths like /../../secret that would escape the public folder.
  if (!filePath.startsWith(PUBLIC_DIR + sep)) return sendJson(response, 403, { error: 'Forbidden' });

  try {
    const body = await readFile(filePath);
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

/** Read a JSON request body. An empty body counts as `{}`. */
async function readJson(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new ValidationError('Request body must be a JSON object');
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
