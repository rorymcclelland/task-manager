import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../src/model.ts';
import { DEFAULT_SETTINGS, prioritise, type PrioritisedTask } from '../src/priority.ts';
import { buildReviewQueue } from '../src/review.ts';

const TODAY = '2026-10-14';
const SETTINGS = { ...DEFAULT_SETTINGS, doNowLimit: 2 };
let n = 0;

function task(overrides: Partial<Task>): PrioritisedTask {
  const t: Task = {
    id: `t${++n}`, title: `Task ${n}`, notes: '',
    origin: { source: 'manual', externalId: null, url: null }, alsoIn: [],
    important: true, urgent: false, dueDate: null, scheduledDate: null, status: 'open',
    mergedInto: null, notDuplicateOf: [],
    createdAt: `2026-10-13T09:00:${String(n).padStart(2, '0')}.000Z`, updatedAt: '2026-10-13T09:00:00.000Z', closedAt: null,
    reviewedAt: '2026-10-13T09:00:00.000Z',
    ...overrides,
  };
  return { ...t, priority: prioritise(t, TODAY, SETTINGS) };
}

test('5.2 — reasons come in a fixed order', () => {
  const tasks = [
    task({ title: 'idle', reviewedAt: '2026-08-01T09:00:00.000Z' }),
    task({ title: 'missed', scheduledDate: '2026-10-10' }),
    task({ title: 'overdue', dueDate: '2026-10-12' }),
    task({ title: 'unnamed', important: null, urgent: null, mirror: { detail: 'Lunatask: next', openInSource: true, placeholderTitle: true } }),
    task({ title: 'unplaced', important: null, urgent: null }),
    task({ title: 'fine' }),
  ];
  assert.deepEqual(buildReviewQueue(tasks, TODAY, SETTINGS).items.map((i) => i.reason), ['untriaged', 'unnamed', 'overdue', 'missed', 'stale']);
});

test('5.2 — an unnamed task is asked for its name, not its quadrant', () => {
  const t = task({ important: null, urgent: null, mirror: { detail: '', openInSource: true, placeholderTitle: true } });
  assert.deepEqual(buildReviewQueue([t], TODAY, SETTINGS).items[0].reasons, ['unnamed']);
});

test('5.2 — "Do now" tasks only join the review when it\'s over its limit', () => {
  const doNow = () => task({ important: true, urgent: true });
  assert.equal(buildReviewQueue([doNow(), doNow()], TODAY, SETTINGS).items.length, 0);
  const over = buildReviewQueue([doNow(), doNow(), doNow()], TODAY, SETTINGS);
  assert.deepEqual(over.items.map((i) => i.reason), ['overload', 'overload', 'overload']);
});

test('5.2 — closed tasks never appear', () => {
  assert.equal(buildReviewQueue([task({ status: 'done', dueDate: '2026-10-01' })], TODAY, SETTINGS).items.length, 0);
});
