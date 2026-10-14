// End-to-end checks of the HTTP API: a real server on a random port,
// talking to a real JSON file in a temp folder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { JsonFileStore } from '../src/store/json-file-store.ts';
import { TaskService } from '../src/tasks.ts';

const dir = await mkdtemp(join(tmpdir(), 'task-api-'));
const server = createServer(createApp(new TaskService(new JsonFileStore(join(dir, 'tasks.json')))));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}

/** A raw request, so tests can set Host and Origin like a browser would. */
function raw(method: string, path: string, headers: Record<string, string>, body = ''): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('capture, list, complete and reopen through the API', async () => {
  const created = await call('POST', '/api/capture', { text: 'Chase contract #claude https://claude.ai/chat/1' });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, 'Chase contract');
  assert.equal(created.body.origin.source, 'claude');

  const open = await call('GET', '/api/tasks');
  assert.equal(open.body.length, 1);

  await call('POST', `/api/tasks/${created.body.id}/complete`);
  assert.equal((await call('GET', '/api/tasks')).body.length, 0);
  assert.equal((await call('GET', '/api/tasks?view=closed')).body[0].status, 'done');

  await call('POST', `/api/tasks/${created.body.id}/reopen`);
  assert.equal((await call('GET', '/api/tasks')).body.length, 1);
});

test('duplicates and merge through the API', async () => {
  const a = (await call('POST', '/api/tasks', { title: 'Renew passport', source: 'gemini' })).body;
  const b = (await call('POST', '/api/tasks', { title: 'Renew my passport', source: 'lunatask' })).body;
  const pairs = (await call('GET', '/api/duplicates')).body;
  assert.equal(pairs.length, 1);

  const merged = await call('POST', `/api/tasks/${a.id}/merge`, { intoId: b.id });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.kept.alsoIn[0].source, 'gemini');
});

test('bad input gets a 400 with a readable message', async () => {
  const result = await call('POST', '/api/capture', { text: '#claude' });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /title/);
});

test('unknown ids get a 404', async () => {
  const result = await call('POST', '/api/tasks/nope/complete');
  assert.equal(result.status, 404);
});

test('the UI page is served at /', async () => {
  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
});

test('2.1–2.3 — capture with !1, read the matrix, then move a task', async () => {
  const created = (await call('POST', '/api/capture', { text: 'Submit tax return !1' })).body;
  assert.equal(created.important, true);

  let matrix = (await call('GET', '/api/matrix')).body;
  assert.equal(matrix.quadrants[0].id, 'do');
  assert.ok(matrix.quadrants[0].tasks.some((t: { id: string }) => t.id === created.id));

  const moved = await call('POST', `/api/tasks/${created.id}/place`, { quadrant: 'eliminate' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.priority.placement, 'eliminate');

  matrix = (await call('GET', '/api/matrix')).body;
  const eliminate = matrix.quadrants.find((q: { id: string }) => q.id === 'eliminate');
  assert.ok(eliminate.tasks.some((t: { id: string }) => t.id === created.id));
});

test('placing in an unknown quadrant gets a 400', async () => {
  const created = (await call('POST', '/api/tasks', { title: 'Something' })).body;
  const result = await call('POST', `/api/tasks/${created.id}/place`, { quadrant: 'later' });
  assert.equal(result.status, 400);
});

test('open tasks in the list carry their priority', async () => {
  const open = (await call('GET', '/api/tasks')).body;
  assert.ok(open.every((t: { priority?: { placement: string } }) => typeof t.priority?.placement === 'string'));
});

test('3.2 — a pasted block adds every task once, even if pasted twice', async () => {
  const text = '#gemini https://gemini.google.com/app/q1\n- Ring the bank due:2026-10-20\n- Renew the domain';
  const first = await call('POST', '/api/capture/block', { text });
  assert.equal(first.status, 201);
  assert.equal(first.body.created.length, 2);
  assert.equal(first.body.created[0].dueDate, '2026-10-20');
  const again = await call('POST', '/api/capture/block', { text });
  assert.deepEqual([again.body.created.length, again.body.skipped], [0, 2]);

  const empty = await call('POST', '/api/capture/block', { text: '#claude\n' });
  assert.equal(empty.status, 400);
});

test('Lunatask links are accepted as source links; javascript: links still are not', async () => {
  const ok = await call('POST', '/api/tasks', { title: 'From Lunatask', url: 'lunatask://tasks/abc-123' });
  assert.equal(ok.status, 201);
  const bad = await call('POST', '/api/tasks', { title: 'Nope', url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);
});

test('/api/sync answers even when no sync runner is wired in', async () => {
  assert.deepEqual((await call('GET', '/api/sync')).body, []);
});

test('4.1–4.3 — /api/agenda lays tasks out by day; PATCH schedules a slot', async () => {
  const created = (await call('POST', '/api/tasks', { title: 'Plan the week' })).body;
  const patched = await call('PATCH', `/api/tasks/${created.id}`, { scheduledDate: '2026-10-20', slot: { start: '10:00', minutes: 45 } });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.slot, { start: '10:00', minutes: 45 });

  const agenda = (await call('GET', '/api/agenda?from=2026-10-19&days=3')).body;
  assert.deepEqual(agenda.days.map((d: { date: string }) => d.date), ['2026-10-19', '2026-10-20', '2026-10-21']);
  assert.ok(agenda.days[1].slotted.some((t: { id: string }) => t.id === created.id));
  assert.deepEqual(agenda.calendars, []);

  assert.equal((await call('GET', '/api/agenda?from=tomorrow')).status, 400);
  assert.equal((await call('GET', '/api/agenda?days=500')).status, 400);
});

test('5.2 — /api/review lists what needs a decision; keep resets the idle clock', async () => {
  const created = (await call('POST', '/api/tasks', { title: 'Review me' })).body;
  const queue = (await call('GET', '/api/review')).body;
  assert.ok(queue.items.some((i: { task: { id: string } }) => i.task.id === created.id));
  const kept = await call('POST', `/api/tasks/${created.id}/keep`);
  assert.equal(kept.status, 200);
  assert.equal(kept.body.priority.idleDays, 0);
  const back = await call('POST', `/api/tasks/${created.id}/reviewed-at`, { reviewedAt: 'not a date' });
  assert.equal(back.status, 400);
});

// ---- Phase 6: hardening ---------------------------------------------------------

test('Q1 — another website cannot change tasks; this app and local scripts can', async () => {
  const id = (await call('POST', '/api/tasks', { title: 'Guarded' })).body.id;
  const host = new URL(base).host;
  const json = { 'Content-Type': 'application/json' };
  // What a cross-site page can send without asking: text/plain, its own Origin.
  assert.equal(await raw('POST', `/api/tasks/${id}/complete`, { 'Content-Type': 'text/plain', Origin: 'https://evil.example' }), 403);
  assert.equal(await raw('POST', '/api/capture', { 'Content-Type': 'text/plain' }, '{"text":"planted"}'), 403);
  // Even JSON is refused when another origin — including another local port — sends it.
  assert.equal(await raw('POST', `/api/tasks/${id}/drop`, { ...json, Origin: 'http://127.0.0.1:1' }), 403);
  assert.equal(await raw('POST', `/api/tasks/${id}/drop`, { ...json, Origin: 'null' }), 403);
  // DNS rebinding: a request addressed to another name is refused, reads included.
  assert.equal(await raw('GET', '/api/tasks', { Host: 'evil.example' }), 403);
  // The app's own page (same origin) and scripts with no Origin still work.
  assert.equal(await raw('GET', '/api/tasks', {}), 200);
  assert.equal(await raw('POST', `/api/tasks/${id}/complete`, { ...json, Origin: `http://${host}` }), 200);
  assert.equal(await raw('POST', `/api/tasks/${id}/reopen`, json), 200);
  assert.equal((await call('GET', `/api/tasks/${id}`)).body.status, 'open');
});

test('Q9 — fields the API stores are type-checked', async () => {
  assert.equal((await call('POST', '/api/tasks', { title: 'x', externalId: { $ne: 1 } })).status, 400);
  assert.equal((await call('POST', '/api/tasks', { title: 'x', notes: { a: 1 } })).status, 400);
  const id = (await call('POST', '/api/tasks', { title: 'typed' })).body.id;
  assert.equal((await call('POST', `/api/tasks/${id}/reviewed-at`, { reviewedAt: 12345 })).status, 400);
  assert.equal((await call('PATCH', `/api/tasks/${id}`, { notes: 42 })).status, 400);
  const merge = await call('POST', `/api/tasks/${id}/merge`, {});
  assert.equal(merge.status, 400);
  assert.match(merge.body.error, /intoId/);
});

test('Q2 — impossible dates are refused', async () => {
  assert.equal((await call('POST', '/api/tasks', { title: 'x', dueDate: '2026-02-30' })).status, 400);
  assert.equal((await call('POST', '/api/tasks', { title: 'x', dueDate: '2026-13-45' })).status, 400);
  assert.equal((await call('GET', '/api/agenda?from=2026-02-30')).status, 400);
  const captured = (await call('POST', '/api/capture', { text: 'Pay rent due:2026-02-31' })).body;
  assert.equal(captured.dueDate, null);
  assert.equal(captured.title, 'Pay rent due:2026-02-31');
});

test('Q3 — an unreadable task file is a 503 that says what\'s wrong', async () => {
  const dir2 = await mkdtemp(join(tmpdir(), 'task-api-bad-'));
  const file = join(dir2, 'tasks.json');
  await writeFile(file, '{"version":1,"tasks":[');
  const bad = createServer(createApp(new TaskService(new JsonFileStore(file))));
  await new Promise<void>((resolve) => bad.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(bad.address() as AddressInfo).port}/api/tasks`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.kind, 'task-file');
    assert.match(body.error, /isn't valid JSON.*Nothing has been changed/);
  } finally {
    bad.close();
  }
});

test('Q5 — /api/health lists set-aside entries', async () => {
  assert.deepEqual((await call('GET', '/api/health')).body, { taskFile: [] });
});

test('Q8 — /api/duplicates?limit=N returns the top N and the total', async () => {
  for (const title of ['Order printer paper', 'Order the printer paper', 'Order printer paper now']) await call('POST', '/api/tasks', { title });
  const all = (await call('GET', '/api/duplicates')).body;
  const top = (await call('GET', '/api/duplicates?limit=1')).body;
  assert.equal(top.total, all.length);
  assert.equal(top.pairs.length, 1);
  assert.deepEqual(top.pairs[0].score, all[0].score);
  assert.equal((await call('GET', '/api/duplicates?limit=0')).status, 400);
});
