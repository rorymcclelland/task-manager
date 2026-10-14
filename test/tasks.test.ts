import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../src/store/json-file-store.ts';
import { TaskService, ValidationError } from '../src/tasks.ts';

/** A service on a fresh temp file, with a clock that ticks one minute per call. */
async function freshService() {
  const dir = await mkdtemp(join(tmpdir(), 'task-service-'));
  let minute = 0;
  const clock = () => new Date(Date.UTC(2026, 9, 14, 9, minute++));
  return new TaskService(new JsonFileStore(join(dir, 'tasks.json')), clock);
}

test('1.1 — new tasks appear in the open list, newest first', async () => {
  const service = await freshService();
  await service.create({ title: 'First' });
  await service.create({ title: 'Second' });
  assert.deepEqual((await service.listOpen()).map((t) => t.title), ['Second', 'First']);
});

test('1.2 — a task records which system it came from', async () => {
  const service = await freshService();
  const task = await service.create({ title: 'Reply to Tom', source: 'gemini', url: 'https://gemini.google.com/app/x' });
  assert.equal(task.origin.source, 'gemini');
  assert.equal(task.origin.url, 'https://gemini.google.com/app/x');
});

test('1.3 — an empty title is refused', async () => {
  const service = await freshService();
  await assert.rejects(service.create({ title: '   ' }), ValidationError);
});

test('source links must be web links', async () => {
  const service = await freshService();
  await assert.rejects(service.create({ title: 'x', url: 'javascript:alert(1)' }), ValidationError);
});

test('1.4 — completing and dropping take a task off the open list', async () => {
  const service = await freshService();
  const a = await service.create({ title: 'Done one' });
  const b = await service.create({ title: 'Dropped one' });
  await service.complete(a.id);
  await service.drop(b.id);

  assert.equal((await service.listOpen()).length, 0);
  const closed = await service.listClosed();
  assert.deepEqual(closed.map((t) => [t.title, t.status]), [['Dropped one', 'dropped'], ['Done one', 'done']]);
  assert.ok(closed.every((t) => t.closedAt));
});

test('1.4 — a closed task can be reopened', async () => {
  const service = await freshService();
  const task = await service.create({ title: 'Oops' });
  await service.complete(task.id);
  const reopened = await service.reopen(task.id);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.closedAt, null);
});

test('editing updates fields and the updatedAt timestamp', async () => {
  const service = await freshService();
  const task = await service.create({ title: 'Draft' });
  const edited = await service.update(task.id, { title: 'Final', notes: 'See thread', source: 'lunatask' });
  assert.equal(edited.title, 'Final');
  assert.equal(edited.notes, 'See thread');
  assert.equal(edited.origin.source, 'lunatask');
  assert.ok(edited.updatedAt > task.updatedAt);
});

test('1.5 — merging keeps one task that knows both sources', async () => {
  const service = await freshService();
  const fromClaude = await service.create({ title: 'Send invoice to Acme', source: 'claude' });
  const fromLunatask = await service.create({ title: 'Send Acme the invoice', source: 'lunatask' });

  assert.equal((await service.duplicates()).length, 1);

  const { kept, merged } = await service.merge(fromClaude.id, fromLunatask.id);
  assert.equal(merged.status, 'merged');
  assert.equal(merged.mergedInto, fromLunatask.id);
  assert.deepEqual(kept.alsoIn.map((r) => r.source), ['claude']);

  const open = await service.listOpen();
  assert.deepEqual(open.map((t) => t.id), [fromLunatask.id]);
  assert.equal((await service.duplicates()).length, 0);
});

test('1.5 — reopening a merged task undoes the merge', async () => {
  const service = await freshService();
  const a = await service.create({ title: 'Send invoice to Acme', source: 'claude' });
  const b = await service.create({ title: 'Send Acme the invoice', source: 'lunatask' });
  await service.merge(a.id, b.id);
  await service.reopen(a.id);

  assert.equal((await service.listOpen()).length, 2);
  assert.deepEqual((await service.get(b.id)).alsoIn, []);
});

test('1.5 — dismissing a suggestion stops it being suggested', async () => {
  const service = await freshService();
  const a = await service.create({ title: 'Book dentist' });
  const b = await service.create({ title: 'Book dentist for daughter' });
  assert.equal((await service.duplicates()).length, 1);
  await service.markNotDuplicate(a.id, b.id);
  assert.equal((await service.duplicates()).length, 0);
});

test('a task cannot be merged into itself or into a closed task', async () => {
  const service = await freshService();
  const a = await service.create({ title: 'A' });
  const b = await service.create({ title: 'B' });
  await service.complete(b.id);
  await assert.rejects(service.merge(a.id, a.id), ValidationError);
  await assert.rejects(service.merge(a.id, b.id), ValidationError);
});
