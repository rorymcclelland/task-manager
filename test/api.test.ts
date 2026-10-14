// End-to-end checks of the HTTP API: a real server on a random port,
// talking to a real JSON file in a temp folder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
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
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
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
