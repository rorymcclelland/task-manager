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
//   POST  /api/tasks        {title, notes?, source?, url?, externalId?}
//   PATCH /api/tasks/:id    {title?, notes?, source?, url?, ...}
//   POST  /api/tasks/:id/complete
//   POST  /api/tasks/:id/drop
//   POST  /api/tasks/:id/reopen
//   POST  /api/tasks/:id/place          {quadrant}  do|schedule|delegate|eliminate|untriaged
//   POST  /api/tasks/:id/merge          {intoId}   fold this task into another
//   POST  /api/tasks/:id/not-duplicate  {otherId}
//   GET   /api/duplicates

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { parseCapture } from './capture.ts';
import { NotFoundError, TaskService, ValidationError, type NewTask } from './tasks.ts';

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export function createApp(service: TaskService): Handler {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(service, request, response, url);
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

async function handleApi(service: TaskService, request: IncomingMessage, response: ServerResponse, url: URL) {
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

  if (resource === 'capture' && method === 'POST') {
    const { text } = await readJson(request);
    const parsed = parseCapture(String(text ?? ''));
    return sendJson(response, 201, await service.create(parsed));
  }

  if (resource === 'matrix' && method === 'GET') return sendJson(response, 200, await service.matrix());

  if (resource === 'duplicates' && method === 'GET') {
    const pairs = await service.duplicates();
    return sendJson(response, 200, pairs.map((p) => ({ a: p.a, b: p.b, score: p.score })));
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
