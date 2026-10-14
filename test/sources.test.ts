// The Phase 3 source connectors, each against fake or temporary data — no
// test ever talks to the real Lunatask or reads your real folders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processInbox } from '../src/sources/inbox.ts';
import { fileOfLocalId, scanLocalFolders, tasksInFile } from '../src/sources/local-files.ts';
import { fetchLunataskItems, toItem } from '../src/sources/lunatask.ts';
import { JsonFileStore } from '../src/store/json-file-store.ts';
import { SyncRunner } from '../src/sync-runner.ts';
import { TaskService } from '../src/tasks.ts';

async function freshService() {
  const dir = await mkdtemp(join(tmpdir(), 'task-sources-'));
  return { dir, service: new TaskService(new JsonFileStore(join(dir, 'tasks.json'))) };
}

/** A stand-in for `fetch` that answers like Lunatask's API would. */
function fakeLunatask(status: number, body: unknown): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.lunatask.app/v1/tasks');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'bearer secret');
    return new Response(JSON.stringify(body), { status, statusText: 'x' });
  }) as typeof fetch;
}

// ---- Lunatask (3.1) ---------------------------------------------------------

test('Lunatask tasks become items: no name, Eisenhower mapped, status described', () => {
  const item = toItem({ id: 'abc', status: 'started', priority: 1, motivation: 'must', eisenhower: 3, scheduled_on: '2026-10-16' });
  assert.equal(item.title, null);
  assert.equal(item.url, 'lunatask://tasks/abc');
  assert.equal(item.open, true);
  assert.equal(item.important, true);
  assert.equal(item.urgent, false);
  assert.equal(item.scheduledDate, '2026-10-16');
  assert.equal(item.detail, 'Lunatask: in progress · high priority · must · scheduled 2026-10-16');

  assert.equal(toItem({ id: 'x', status: 'completed' }).open, false);
  assert.equal(toItem({ id: 'x', status: 'later', eisenhower: 0 }).important, null);
});

test('Lunatask: a bad token gives a message that says what to do', async () => {
  await assert.rejects(fetchLunataskItems('secret', fakeLunatask(401, {})), /Access tokens/);
});

test('Lunatask: an answer that looks paged is marked incomplete', async () => {
  const whole = await fetchLunataskItems('secret', fakeLunatask(200, { tasks: [{ id: 'a', status: 'next' }] }));
  assert.equal(whole.complete, true);
  const paged = await fetchLunataskItems('secret', fakeLunatask(200, { tasks: [], next_page: 2 }));
  assert.equal(paged.complete, false);
});

test('Lunatask end to end: import, rename, complete over there', async () => {
  const { dir, service } = await freshService();
  let tasks: unknown[] = [{ id: 'L1', status: 'next', eisenhower: 1 }];
  const fetchFn = (async () => new Response(JSON.stringify({ tasks }))) as unknown as typeof fetch;
  const runner = new SyncRunner(service, {
    lunatask: { token: 'secret', fetchFn },
    local: { folders: [] },
    inbox: { folder: join(dir, 'inbox') },
  });

  let status = await runner.syncAll();
  assert.match(status[0].lastRun!.summary, /1 new/);
  const [task] = await service.listOpen();
  assert.equal(task.title, 'Unnamed Lunatask task');
  assert.equal(task.priority.placement, 'do');

  const renamed = await service.update(task.id, { title: 'Book flights' });
  assert.equal(renamed.mirror?.placeholderTitle, false);

  tasks = [{ id: 'L1', status: 'completed', completed_at: '2026-10-14T12:00:00Z' }];
  status = await runner.syncAll();
  assert.match(status[0].lastRun!.summary, /1 closed/);
  const [closed] = await service.listClosed();
  assert.equal(closed.title, 'Book flights');
  assert.equal(closed.status, 'done');
});

test('a failing source is reported and the others still run', async () => {
  const { dir, service } = await freshService();
  await mkdir(join(dir, 'inbox'));
  await writeFile(join(dir, 'inbox', 'note.md'), 'Call the bank');
  const runner = new SyncRunner(service, {
    lunatask: { token: 'secret', fetchFn: fakeLunatask(500, {}) },
    local: { folders: [] },
    inbox: { folder: join(dir, 'inbox') },
  });
  const status = await runner.syncAll();
  const lunatask = status.find((s) => s.id === 'lunatask')!;
  assert.equal(lunatask.lastRun!.ok, false);
  assert.match(lunatask.lastRun!.error!, /500/);
  assert.equal((await service.listOpen()).length, 1);
  assert.equal(status.find((s) => s.id === 'local')!.lastRun, null); // not set up, so never run
});

// ---- Files on this computer (3.4) -----------------------------------------------

test('checkboxes and TODOs in a file become items; ticked means done', () => {
  const items = tasksInFile('C:\\notes\\a.md', [
    '- [ ] Get quotes',
    '* [x] Measure space',
    '1. [ ] Pick tiles',
    'TODO: ask about the van',
    'A todo list of things',            // lower-case: prose, not a task
    '- [ ] Get   quotes',               // same text again: one item
  ].join('\n'));
  assert.deepEqual(items.map((i) => [i.title, i.open]), [
    ['Get quotes', true],
    ['Measure space', false],
    ['Pick tiles', true],
    ['ask about the van', true],
  ]);
  assert.equal(items[0].detail, 'C:\\notes\\a.md, line 1');
  assert.equal(fileOfLocalId(items[0].externalId), 'C:\\notes\\a.md');
});

test('local scan: only .md/.txt, skips hidden folders and the skip list; deleting a line closes the task', async () => {
  const { dir, service } = await freshService();
  const notes = join(dir, 'notes');
  await mkdir(join(notes, '.obsidian'), { recursive: true });
  await mkdir(join(notes, 'inbox'), { recursive: true });
  await writeFile(join(notes, 'plan.md'), '- [ ] Get quotes\n- [ ] Pick tiles\n');
  await writeFile(join(notes, 'code.ts'), '// TODO: refactor');
  await writeFile(join(notes, '.obsidian', 'x.md'), '- [ ] hidden');
  await writeFile(join(notes, 'inbox', 'y.md'), '- [x] skipped');

  const scan = await scanLocalFolders([notes], { skip: [join(notes, 'inbox')] });
  assert.deepEqual(scan.items.map((i) => i.title).sort(), ['Get quotes', 'Pick tiles']);

  const runner = new SyncRunner(service, {
    lunatask: { token: null },
    local: { folders: [notes] },
    inbox: { folder: join(notes, 'inbox') },
  });
  await runner.syncAll();
  assert.equal((await service.listOpen()).length, 2);

  // Delete one line: that task is done. Delete the whole file: nothing more changes.
  await writeFile(join(notes, 'plan.md'), '- [ ] Get quotes\n');
  await runner.syncAll();
  assert.deepEqual((await service.listOpen()).map((t) => t.title), ['Get quotes']);
  await rm(join(notes, 'plan.md'));
  await runner.syncAll();
  assert.deepEqual((await service.listOpen()).map((t) => t.title), ['Get quotes']);
});

// ---- Inbox folder (3.2, 3.3) ------------------------------------------------------

test('inbox: files are read as capture blocks, then moved to processed/', async () => {
  const { dir, service } = await freshService();
  const inbox = join(dir, 'inbox');
  await mkdir(inbox);
  await writeFile(join(inbox, 'from-claude.md'), 'https://claude.ai/chat/1\n- Send budget !1\n- Book room\n');
  await writeFile(join(inbox, 'ignore.json'), '{}');

  const first = await processInbox(inbox, service, new Date('2026-10-14T10:00:00Z'));
  assert.deepEqual([first.files, first.created], [1, 2]);
  const open = await service.listOpen();
  assert.ok(open.every((t) => t.origin.source === 'claude'));
  assert.deepEqual(await readdir(join(inbox, 'processed')), ['2026-10-14T10-00-00-from-claude.md']);

  // The same file dropped again adds nothing.
  await writeFile(join(inbox, 'again.md'), 'https://claude.ai/chat/1\n- Send budget !1\n');
  const second = await processInbox(inbox, service);
  assert.deepEqual([second.created, second.skipped], [0, 1]);
});
