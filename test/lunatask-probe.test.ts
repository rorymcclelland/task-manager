// Sprint 1, L0: the Lunatask spike. These tests run the probe against a
// pretend Lunatask held in memory — no test ever talks to the real one.
//
// What they pin down:
//   - the probe only ever changes the one task it created (plus a single
//     write to a made-up ID, to see how Lunatask answers an unknown task)
//   - it stops at the first unexpected answer, but still offers to clean up
//   - your token never appears in anything it prints or saves
//   - it saves task IDs and statuses only, never any task text

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProbe, type ProbeIO } from '../scripts/lunatask-probe.ts';

const TOKEN = 'secret-token-123';
const AREA = '11b37775-5a34-41bb-b109-f0e5a6084799';

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
    if (method !== 'GET') writes.push({ method, id: id ?? '(new)', body });
    if (method !== 'GET' && quirks.readOnlyToken) return json(403, { message: 'forbidden' });

    if (method === 'GET' && !id) return json(200, { tasks: [...tasks.values()].map(visible) });
    if (method === 'GET') {
      if (quirks.noShow) return json(404, { message: 'not found' });
      const t = tasks.get(id);
      return t ? json(200, { task: visible(t) }) : json(404, { message: 'not found' });
    }
    if (method === 'POST') {
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
      const base: FakeTask = quirks.updateIsReplace
        ? { ...t, priority: 0, motivation: 'unknown', eisenhower: 0, scheduled_on: null }
        : t;
      const next: FakeTask = { ...base, ...body, previous_status: t.status };
      next.completed_at = next.status === 'completed' && !quirks.noCompletedAt ? '2026-10-27T22:00:00Z' : null;
      tasks.set(id, next);
      return json(200, { task: visible(next) });
    }
    return json(405, {});
  }) as typeof fetch;

  return { fetchFn, tasks, writes };
}

function existingTask(id: string, status = 'next'): FakeTask {
  return {
    id,
    area_id: AREA,
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

/** Collects everything the probe prints, and answers its questions. */
function io(fetchFn: typeof fetch, answers: boolean[] = []): ProbeIO & { lines: string[]; asked: string[] } {
  const lines: string[] = [];
  const asked: string[] = [];
  let i = 0;
  return {
    fetch: fetchFn,
    today: '2026-10-27',
    lines,
    asked,
    say: (line) => lines.push(line),
    ask: async (question) => {
      asked.push(question);
      return answers[i++] ?? true;
    },
  };
}

const MINE = [existingTask('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), existingTask('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'completed')];

test('L0 — a well-behaved Lunatask: every question gets a yes', async () => {
  const lunatask = fakeLunatask(MINE);
  const probe = io(lunatask.fetchFn);
  const result = await runProbe(TOKEN, probe);

  assert.equal(result.stoppedEarly, false);
  assert.deepEqual(result.answers, {
    canRead: true,
    canWrite: true,
    statusOnlyLeavesOtherFields: true,
    completingSetsCompletedAt: true,
    reopeningIsClean: true,
    nameVisibleAfterCreate: true,
    nameSurvivesCompleting: true,
    nameSurvivesReopening: true,
    unknownIdAnswer: 404,
    invalidStatusAnswer: 422,
    deleted: true,
  });
  assert.equal(lunatask.tasks.size, 2, 'the probe task is gone; your tasks are untouched');
});

test('L0 — it only ever changes the task it created (plus one made-up ID)', async () => {
  const lunatask = fakeLunatask(MINE);
  const result = await runProbe(TOKEN, io(lunatask.fetchFn));
  const yours = new Set(MINE.map((t) => t.id));
  for (const write of lunatask.writes) {
    assert.ok(!yours.has(write.id), `wrote to one of your tasks: ${write.method} ${write.id}`);
    assert.ok(
      write.id === '(new)' || write.id === result.createdId || write.id === result.unknownId,
      `wrote somewhere unexpected: ${write.method} ${write.id}`,
    );
  }
  assert.deepEqual(lunatask.tasks.get(MINE[0].id), MINE[0]);
});

test('L0 — status updates send only the status', async () => {
  const lunatask = fakeLunatask(MINE);
  await runProbe(TOKEN, io(lunatask.fetchFn));
  const statusUpdates = lunatask.writes.filter((w) => w.method === 'PUT');
  assert.ok(statusUpdates.length >= 3);
  for (const write of statusUpdates) assert.deepEqual(Object.keys(write.body as object), ['status']);
});

test('L0 — the token never appears in anything printed, asked or saved', async () => {
  for (const quirks of [{}, { offline: true }, { readOnlyToken: true }] as Quirks[]) {
    const probe = io(fakeLunatask(MINE, quirks).fetchFn);
    const result = await runProbe(TOKEN, probe);
    const everything = JSON.stringify({ lines: probe.lines, asked: probe.asked, result });
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
  const everything = JSON.stringify({ lines: probe.lines, result });
  assert.ok(!everything.includes('must never be printed'));
});

test('L0 — a status-only update that resets other fields is caught, and the probe stops', async () => {
  const lunatask = fakeLunatask(MINE, { updateIsReplace: true });
  const probe = io(lunatask.fetchFn);
  const result = await runProbe(TOKEN, probe);
  assert.equal(result.answers.statusOnlyLeavesOtherFields, false);
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.answers.reopeningIsClean, null, 'later steps not run');
  assert.equal(result.answers.deleted, true, 'cleanup still offered');
});

test('L0 — a missing completed_at is recorded as a no, not a crash', async () => {
  const result = await runProbe(TOKEN, io(fakeLunatask(MINE, { noCompletedAt: true }).fetchFn));
  assert.equal(result.answers.completingSetsCompletedAt, false);
  assert.equal(result.stoppedEarly, true);
});

test('L0 — if you say the name was lost, the probe stops there', async () => {
  // Answers: name visible after create, name LOST after completing, then delete? yes
  const result = await runProbe(TOKEN, io(fakeLunatask(MINE).fetchFn, [true, false, true]));
  assert.equal(result.answers.nameSurvivesCompleting, false);
  assert.equal(result.answers.nameSurvivesReopening, null);
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.answers.deleted, true);
});

test('L0 — a read-only token: canWrite is no, nothing was created, nothing to clean up', async () => {
  const lunatask = fakeLunatask(MINE, { readOnlyToken: true });
  const probe = io(lunatask.fetchFn);
  const result = await runProbe(TOKEN, probe);
  assert.equal(result.answers.canRead, true);
  assert.equal(result.answers.canWrite, false);
  assert.equal(result.createdId, null);
  assert.equal(probe.asked.length, 0, 'no questions when there is nothing to look at');
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
  const result = await runProbe('wrong', io(lunatask.fetchFn));
  assert.equal(result.answers.canRead, false);
  assert.equal(lunatask.writes.length, 0);
});

test('L0 — no tasks in Lunatask means no area to borrow: stops before writing', async () => {
  const lunatask = fakeLunatask([]);
  const probe = io(lunatask.fetchFn);
  const result = await runProbe(TOKEN, probe);
  assert.equal(lunatask.writes.length, 0);
  assert.equal(result.stoppedEarly, true);
  assert.match(probe.lines.join('\n'), /LUNATASK_PROBE_AREA/);
});

test('L0 — no single-task endpoint is recorded, not fatal', async () => {
  const result = await runProbe(TOKEN, io(fakeLunatask(MINE, { noShow: true }).fetchFn));
  assert.equal(result.stoppedEarly, false);
  assert.ok(result.findings.some((f) => /single task/i.test(f.step) && !f.ok));
});

test('L0 — saying no to deleting leaves the probe task for you to delete', async () => {
  const lunatask = fakeLunatask(MINE);
  const probe = io(lunatask.fetchFn, [true, true, true, false]);
  const result = await runProbe(TOKEN, probe);
  assert.equal(result.answers.deleted, false);
  assert.equal(lunatask.tasks.size, 3);
  assert.match(probe.lines.join('\n'), /delete it yourself/i);
});
