// Sprint 1, L0: the Lunatask spike. These tests run the probe against a
// pretend Lunatask held in memory — no test ever talks to the real one.
//
// The probe runs without questions (Claude runs it), and leaves one hand
// check for Rory, as a test pack: two probe tasks to look at once Lunatask
// has synced. Run 1 (28 Oct 2026) showed the API-to-app sync can take a
// while, so the check can't happen live.
//
// What these tests pin down:
//   - the probe only ever changes tasks it created (plus one update to a
//     made-up ID, to see how Lunatask answers an unknown task)
//   - clean-up deletes only the IDs it is given, and only with DELETE
//   - status changes send only the status
//   - it stops at the first unexpected answer, keeping what it created on
//     record so clean-up can remove it
//   - your token never appears in anything it prints or saves
//   - it saves task IDs and statuses only, never any task text

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupProbe, PROBE_NAMES, runProbe, testPack, type ProbeIO } from '../scripts/lunatask-probe.ts';

const TOKEN = 'secret-token-123';
const OLD_AREA = '22222222-2222-4222-8222-222222222222';
const MAIN_AREA = '33333333-3333-4333-8333-333333333333';

interface FakeTask {
  id: string;
  area_id: string;
  status: string;
  previous_status: string | null;
  priority: number;
  motivation: string;
  eisenhower: number;
  scheduled_on: string | null;
  completed_at: string | null;
  name?: string; // held server-side only; never returned, as in the real API
}

/** Knobs for making the pretend Lunatask misbehave in particular ways. */
interface Quirks {
  readOnlyToken?: boolean;
  /** A status-only update resets the other fields (the thing we fear). */
  updateIsReplace?: boolean;
  /** Completing doesn't fill in completed_at. */
  noCompletedAt?: boolean;
  /** No GET /v1/tasks/<id> endpoint. */
  noShow?: boolean;
  /** Lunatask unreachable. */
  offline?: boolean;
  /** Fields a create ignores (the real Lunatask ignored these on 28 Oct 2026). */
  createIgnores?: string[];
  /** An update can't set these either. */
  updateIgnores?: string[];
}

function fakeLunatask(existing: FakeTask[], quirks: Quirks = {}) {
  const tasks = new Map(existing.map((t) => [t.id, { ...t }]));
  const writes: { method: string; id: string; body: unknown }[] = [];
  let counter = 0;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const visible = (t: FakeTask) => {
    const { name: _hidden, ...rest } = t;
    return rest;
  };

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (quirks.offline) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = init?.headers as Record<string, string>;
    if (headers.Authorization !== `bearer ${TOKEN}`) return json(401, { message: 'unauthorized' });
    assert.equal(url.origin, 'https://api.lunatask.app');

    const [, , , id] = url.pathname.split('/'); // /v1/tasks/<id>
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') writes.push({ method, id: id ?? '(new)', body: body && { ...body } });
    if (method !== 'GET' && quirks.readOnlyToken) return json(403, { message: 'forbidden' });

    if (method === 'GET' && !id) return json(200, { tasks: [...tasks.values()].map(visible) });
    if (method === 'GET') {
      if (quirks.noShow) return json(404, { message: 'not found' });
      const t = tasks.get(id);
      return t ? json(200, { task: visible(t) }) : json(404, { message: 'not found' });
    }
    if (method === 'POST') {
      for (const field of quirks.createIgnores ?? []) delete body[field];
      const task: FakeTask = {
        id: `00000000-0000-4000-8000-00000000000${++counter}`,
        area_id: body.area_id,
        status: body.status ?? 'later',
        previous_status: null,
        priority: body.priority ?? 0,
        motivation: body.motivation ?? 'unknown',
        eisenhower: body.eisenhower ?? 0,
        scheduled_on: body.scheduled_on ?? null,
        completed_at: null,
        name: body.name,
      };
      tasks.set(task.id, task);
      return json(200, { task: visible(task) });
    }
    const t = tasks.get(id);
    if (!t) return json(404, { message: 'not found' });
    if (method === 'DELETE') {
      tasks.delete(id);
      return json(200, { task: visible(t) });
    }
    if (method === 'PUT') {
      if (body.status && !['later', 'next', 'started', 'waiting', 'completed'].includes(body.status)) {
        return json(422, { message: 'invalid status' });
      }
      for (const field of quirks.updateIgnores ?? []) delete body[field];
      const base: FakeTask = quirks.updateIsReplace
        ? { ...t, priority: 0, motivation: 'unknown', eisenhower: 0, scheduled_on: null }
        : t;
      const next: FakeTask = { ...base, ...body, previous_status: body.status ? t.status : t.previous_status };
      next.completed_at = next.status === 'completed' && !quirks.noCompletedAt ? '2026-11-05T17:00:00Z' : null;
      tasks.set(id, next);
      return json(200, { task: visible(next) });
    }
    return json(405, {});
  }) as typeof fetch;

  return { fetchFn, tasks, writes };
}

function existingTask(id: string, status = 'next', area = MAIN_AREA): FakeTask {
  return {
    id,
    area_id: area,
    status,
    previous_status: null,
    priority: 0,
    motivation: 'unknown',
    eisenhower: 0,
    scheduled_on: null,
    completed_at: null,
    name: 'A real task — must never be printed',
  };
}

/** Collects everything the probe prints. */
function io(fetchFn: typeof fetch, extra: Partial<ProbeIO> = {}): ProbeIO & { lines: string[] } {
  const lines: string[] = [];
  return { ...extra, fetch: fetchFn, today: '2026-11-05', lines, say: (line) => lines.push(line) };
}

const MINE = [
  existingTask('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  existingTask('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'completed'),
];
const yours = new Set(MINE.map((t) => t.id));

// ---- The run ------------------------------------------------------------------

test('L0 — a well-behaved Lunatask: every API question gets a yes', async () => {
  const lunatask = fakeLunatask(MINE);
  const result = await runProbe(TOKEN, io(lunatask.fetchFn));

  assert.equal(result.stoppedEarly, false);
  assert.deepEqual(result.answers, {
    canRead: true,
    canWrite: true,
    createKeepsFields: true,
    updateSetsIgnoredFields: null, // nothing was ignored, so no update needed
    statusOnlyLeavesOtherFields: true,
    completingSetsCompletedAt: true,
    reopeningIsClean: true,
    singleTaskRead: true,
    unknownIdAnswer: 404,
    invalidStatusAnswer: 422,
  });
  assert.equal(lunatask.tasks.size, 4, 'two probe tasks left for the hand check; yours untouched');
});

test('L0 — it creates task A (left alone) and task B (completed, then reopened)', async () => {
  const lunatask = fakeLunatask(MINE);
  const result = await runProbe(TOKEN, io(lunatask.fetchFn));
  assert.deepEqual(result.created.map((t) => t.label), ['A', 'B']);
  const [a, b] = result.created;
  assert.equal(lunatask.tasks.get(a.id)?.name, PROBE_NAMES.A);
  assert.equal(lunatask.tasks.get(b.id)?.name, PROBE_NAMES.B);
  // Both end in the same place, so one look covers both.
  assert.equal(lunatask.tasks.get(a.id)?.status, 'next');
  assert.equal(lunatask.tasks.get(b.id)?.status, 'next');
  // Only B had its status changed.
  const statusWrites = lunatask.writes.filter((w) => w.method === 'PUT').map((w) => w.id);
  assert.ok(!statusWrites.includes(a.id));
  assert.ok(statusWrites.filter((id) => id === b.id).length >= 2);
});

test('L0 — it only ever changes tasks it created (plus one made-up ID)', async () => {
  const lunatask = fakeLunatask(MINE);
  const result = await runProbe(TOKEN, io(lunatask.fetchFn));
  const created = new Set(result.created.map((t) => t.id));
  for (const write of lunatask.writes) {
    assert.ok(!yours.has(write.id), `wrote to one of your tasks: ${write.method} ${write.id}`);
    assert.ok(write.id === '(new)' || created.has(write.id) || write.id === result.unknownId, `unexpected: ${write.method} ${write.id}`);
  }
  assert.deepEqual(lunatask.tasks.get(MINE[0].id), MINE[0]);
});

test('L0 — status changes send only the status', async () => {
  const lunatask = fakeLunatask(MINE);
  await runProbe(TOKEN, io(lunatask.fetchFn));
  const puts = lunatask.writes.filter((w) => w.method === 'PUT');
  assert.ok(puts.length >= 3);
  for (const write of puts) assert.deepEqual(Object.keys(write.body as object), ['status']);
});

test('L0 — the probe tasks go in the area holding most of your open tasks', async () => {
  const tasks = [
    existingTask('d1', 'completed', OLD_AREA), // listed first, as on 28 Oct
    existingTask('d2', 'completed', OLD_AREA),
    existingTask('d3', 'next', OLD_AREA),
    existingTask('d4', 'next', MAIN_AREA),
    existingTask('d5', 'later', MAIN_AREA),
  ];
  const lunatask = fakeLunatask(tasks);
  const result = await runProbe(TOKEN, io(lunatask.fetchFn));
  for (const write of lunatask.writes.filter((w) => w.method === 'POST')) {
    assert.equal((write.body as { area_id: string }).area_id, MAIN_AREA);
  }
  assert.match(result.areaWords, /area with the most open tasks \(2 open\)/);
});

test('L0 — LUNATASK_PROBE_AREA overrides the choice of area', async () => {
  const lunatask = fakeLunatask(MINE);
  await runProbe(TOKEN, io(lunatask.fetchFn, { areaId: OLD_AREA }));
  for (const write of lunatask.writes.filter((w) => w.method === 'POST')) {
    assert.equal((write.body as { area_id: string }).area_id, OLD_AREA);
  }
});

test('L0 — fields a create ignores are recorded, set by one update each, and the probe carries on', async () => {
  const lunatask = fakeLunatask(MINE, { createIgnores: ['status', 'motivation', 'eisenhower'] });
  const result = await runProbe(TOKEN, io(lunatask.fetchFn));
  assert.equal(result.answers.createKeepsFields, false);
  assert.equal(result.answers.updateSetsIgnoredFields, true);
  const finding = result.findings.find((f) => /create keeps/i.test(f.step));
  assert.ok(finding && /status, motivation, eisenhower/.test(finding.detail), finding?.detail);
  // Setup updates carry exactly the ignored fields; every other update is status only.
  const puts = lunatask.writes.filter((w) => w.method === 'PUT');
  const setups = puts.filter((w) => Object.keys(w.body as object).length > 1);
  assert.equal(setups.length, 2, 'one setup update per probe task');
  for (const write of setups) assert.deepEqual(write.body, { status: 'next', motivation: 'should', eisenhower: 3 });
  for (const write of puts.filter((w) => !setups.includes(w))) assert.deepEqual(Object.keys(write.body as object), ['status']);
  assert.equal(result.answers.statusOnlyLeavesOtherFields, true);
  assert.equal(result.stoppedEarly, false);
});

test('L0 — fields that even an update cannot set stop the probe, with both tasks on record', async () => {
  const lunatask = fakeLunatask(MINE, { createIgnores: ['eisenhower'], updateIgnores: ['eisenhower'] });
  const result = await runProbe(TOKEN, io(lunatask.fetchFn));
  assert.equal(result.answers.updateSetsIgnoredFields, false);
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.created.length, 1, 'stopped after the first task, which is on record for clean-up');
});

test('L0 — a status-only update that resets other fields is caught, and the probe stops', async () => {
  const result = await runProbe(TOKEN, io(fakeLunatask(MINE, { updateIsReplace: true }).fetchFn));
  assert.equal(result.answers.statusOnlyLeavesOtherFields, false);
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.answers.reopeningIsClean, null, 'later steps not run');
  assert.equal(result.created.length, 2, 'both on record for clean-up');
});

test('L0 — a missing completed_at is recorded as a no, not a crash', async () => {
  const result = await runProbe(TOKEN, io(fakeLunatask(MINE, { noCompletedAt: true }).fetchFn));
  assert.equal(result.answers.completingSetsCompletedAt, false);
  assert.equal(result.stoppedEarly, true);
});

test('L0 — no single-task endpoint is recorded, not fatal', async () => {
  const result = await runProbe(TOKEN, io(fakeLunatask(MINE, { noShow: true }).fetchFn));
  assert.equal(result.answers.singleTaskRead, false);
  assert.equal(result.stoppedEarly, false);
});

test('L0 — a read-only token: canWrite is no, nothing created', async () => {
  const probe = io(fakeLunatask(MINE, { readOnlyToken: true }).fetchFn);
  const result = await runProbe(TOKEN, probe);
  assert.equal(result.answers.canRead, true);
  assert.equal(result.answers.canWrite, false);
  assert.deepEqual(result.created, []);
  assert.match(probe.lines.join('\n'), /403/);
});

test('L0 — offline: a plain message, nothing else attempted', async () => {
  const lunatask = fakeLunatask(MINE, { offline: true });
  const probe = io(lunatask.fetchFn);
  const result = await runProbe(TOKEN, probe);
  assert.equal(result.answers.canRead, false);
  assert.equal(lunatask.writes.length, 0);
  assert.match(probe.lines.join('\n'), /couldn't reach Lunatask/i);
});

test('L0 — a wrong token: says so, writes nothing', async () => {
  const lunatask = fakeLunatask(MINE);
  const probe = io(lunatask.fetchFn);
  const result = await runProbe('wrong', probe);
  assert.equal(result.answers.canRead, false);
  assert.equal(lunatask.writes.length, 0);
  assert.match(probe.lines.join('\n'), /rejected the token/i);
});

test('L0 — no open task with an area: stops before writing', async () => {
  const lunatask = fakeLunatask([existingTask('x', 'completed')]);
  const probe = io(lunatask.fetchFn);
  const result = await runProbe(TOKEN, probe);
  assert.equal(lunatask.writes.length, 0);
  assert.equal(result.stoppedEarly, true);
  assert.match(probe.lines.join('\n'), /LUNATASK_PROBE_AREA/);
});

test('L0 — the token never appears in anything printed or saved', async () => {
  for (const quirks of [{}, { offline: true }, { readOnlyToken: true }, { updateIsReplace: true }] as Quirks[]) {
    const probe = io(fakeLunatask(MINE, quirks).fetchFn);
    const result = await runProbe(TOKEN, probe);
    const everything = JSON.stringify({ lines: probe.lines, result, pack: testPack(result, '2026-11-05T17:00:00Z') });
    assert.ok(!everything.includes(TOKEN), `token leaked with quirks ${JSON.stringify(quirks)}`);
  }
});

test('L0 — it saves IDs and statuses only, never task text', async () => {
  const probe = io(fakeLunatask(MINE).fetchFn);
  const result = await runProbe(TOKEN, probe);
  assert.deepEqual(result.apiTasks, [
    { id: MINE[0].id, status: 'next' },
    { id: MINE[1].id, status: 'completed' },
  ]);
  const everything = JSON.stringify({ lines: probe.lines, result, pack: testPack(result, 'x') });
  assert.ok(!everything.includes('must never be printed'));
});

// ---- The test pack -------------------------------------------------------------

test('L0 — the test pack says where to look and what to expect, from what Lunatask recorded', async () => {
  const lunatask = fakeLunatask(MINE, { createIgnores: ['status'] });
  const result = await runProbe(TOKEN, io(lunatask.fetchFn));
  const pack = testPack(result, '2026-11-05T17:00:00Z');
  assert.match(pack, /Next/);
  assert.match(pack, /Thu 12 Nov/); // scheduled a week after 5 Nov
  assert.match(pack, /area with the most open tasks/);
  assert.ok(pack.includes(PROBE_NAMES.A) && pack.includes(PROBE_NAMES.B));
  assert.match(pack, /search/i);
  assert.match(pack, /sync/i);
  assert.ok(!pack.includes('—'), 'no em dashes in writing for Rory');
});

test('L0 — a run that stopped early says there is nothing to check by hand', async () => {
  const result = await runProbe(TOKEN, io(fakeLunatask(MINE, { updateIsReplace: true }).fetchFn));
  const pack = testPack(result, 'x');
  assert.match(pack, /no hand check/i);
});

// ---- Clean-up --------------------------------------------------------------------

test('L0 — clean-up deletes exactly the IDs it is given, with DELETE only', async () => {
  const lunatask = fakeLunatask(MINE);
  const run = await runProbe(TOKEN, io(lunatask.fetchFn));
  const ids = run.created.map((t) => t.id);
  const before = lunatask.writes.length;
  const cleanup = await cleanupProbe(TOKEN, io(lunatask.fetchFn), ids);
  assert.deepEqual(cleanup.deleted, ids);
  const writes = lunatask.writes.slice(before);
  assert.deepEqual(writes.map((w) => [w.method, w.id]), ids.map((id) => ['DELETE', id]));
  assert.equal(lunatask.tasks.size, 2, 'only your tasks remain');
});

test('L0 — clean-up reports a task that is already gone, not an error', async () => {
  const gone = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const cleanup = await cleanupProbe(TOKEN, io(fakeLunatask(MINE).fetchFn), [gone]);
  assert.deepEqual(cleanup, { deleted: [], alreadyGone: [gone], failed: [], refused: [] });
});

test("L0 — clean-up refuses anything that isn't a task ID", async () => {
  const lunatask = fakeLunatask(MINE);
  const cleanup = await cleanupProbe(TOKEN, io(lunatask.fetchFn), ['../tasks', 'not-an-id']);
  assert.deepEqual(cleanup.refused, ['../tasks', 'not-an-id']);
  assert.equal(lunatask.writes.length, 0);
});

test('L0 — clean-up offline keeps the IDs as failed, to try again', async () => {
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const cleanup = await cleanupProbe(TOKEN, io(fakeLunatask(MINE, { offline: true }).fetchFn), [id]);
  assert.deepEqual(cleanup.failed, [id]);
});
