import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../src/store/json-file-store.ts';
import type { Task } from '../src/model.ts';

function sampleTask(id: string, title = 'Sample'): Task {
  const now = '2026-10-14T09:00:00.000Z';
  return {
    id,
    title,
    notes: '',
    origin: { source: 'manual', externalId: null, url: null },
    alsoIn: [],
    important: null,
    urgent: null,
    dueDate: null,
    scheduledDate: null,
    status: 'open',
    mergedInto: null,
    notDuplicateOf: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
}

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'task-store-'));
  return join(dir, 'nested', 'tasks.json');
}

test('a missing file reads as an empty list', async () => {
  const store = new JsonFileStore(await tempFile());
  assert.deepEqual(await store.all(), []);
});

test('saved tasks are written to disk and read back', async () => {
  const path = await tempFile();
  await new JsonFileStore(path).save(sampleTask('a'));

  // A brand-new store instance sees it, so it really is on disk.
  const reopened = new JsonFileStore(path);
  assert.equal((await reopened.get('a'))?.title, 'Sample');

  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.tasks.length, 1);
});

test('saving an existing id replaces it rather than duplicating it', async () => {
  const store = new JsonFileStore(await tempFile());
  await store.save(sampleTask('a', 'First'));
  await store.save(sampleTask('a', 'Second'));
  const all = await store.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, 'Second');
});

test('simultaneous saves do not overwrite each other', async () => {
  const store = new JsonFileStore(await tempFile());
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.save(sampleTask(`t${i}`))));
  assert.equal((await store.all()).length, 20);
});

test('edits made to the file outside the app are picked up', async () => {
  const path = await tempFile();
  const store = new JsonFileStore(path);
  await store.save(sampleTask('a', 'Before'));
  const raw = JSON.parse(await readFile(path, 'utf8'));
  raw.tasks[0].title = 'Edited by hand';
  await writeFile(path, JSON.stringify(raw));
  assert.equal((await store.get('a'))?.title, 'Edited by hand');
});
