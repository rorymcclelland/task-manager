import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../src/model.ts';
import { planSync, type SourceItem } from '../src/sync.ts';

const NOW = '2026-10-14T10:00:00.000Z';
const LATER = '2026-10-14T10:15:00.000Z';
let counter = 0;
const newId = () => `id-${++counter}`;

function item(overrides: Partial<SourceItem> = {}): SourceItem {
  return {
    externalId: 'L1',
    title: null,
    url: 'lunatask://tasks/L1',
    open: true,
    detail: 'Lunatask: next',
    ...overrides,
  };
}

/** Run one sync and return the resulting full task list. */
function sync(tasks: Task[], items: SourceItem[], now = NOW, whenGone: 'done' | 'dropped' = 'dropped') {
  const plan = planSync(tasks, 'lunatask', items, { whenGone }, now, newId);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of plan.changed) byId.set(t.id, t);
  return { tasks: [...byId.values()], plan };
}

test('a new open item becomes a task, with a placeholder title when the source has none', () => {
  const { tasks, plan } = sync([], [item({ important: true, urgent: false, scheduledDate: '2026-10-16' })]);
  assert.equal(plan.report.created, 1);
  const [task] = tasks;
  assert.equal(task.title, 'Unnamed Lunatask task');
  assert.equal(task.mirror?.placeholderTitle, true);
  assert.deepEqual(task.origin, { source: 'lunatask', externalId: 'L1', url: 'lunatask://tasks/L1' });
  assert.equal(task.important, true);
  assert.equal(task.urgent, false);
  assert.equal(task.scheduledDate, '2026-10-16');
});

test('items already finished in the source are not imported', () => {
  const { plan } = sync([], [item({ open: false })]);
  assert.equal(plan.changed.length, 0);
});

test('a second sync with nothing new writes nothing', () => {
  const first = sync([], [item()]);
  const second = sync(first.tasks, [item()], LATER);
  assert.equal(second.plan.changed.length, 0);
});

test('closing it in the source closes it here — once', () => {
  const first = sync([], [item()]);
  const closed = sync(first.tasks, [item({ open: false, detail: 'Lunatask: completed' })], LATER);
  assert.deepEqual(closed.plan.report.closed, ['Unnamed Lunatask task']);
  assert.equal(closed.tasks[0].status, 'done');

  // You reopen it here; the source still says completed. It stays open.
  const reopened = { ...closed.tasks[0], status: 'open' as const, closedAt: null };
  const again = sync([reopened], [item({ open: false, detail: 'Lunatask: completed' })], LATER);
  assert.equal(again.plan.changed.length, 0);
});

test('disappearing from the source drops it (or marks it done), but only where the source looked', () => {
  const first = sync([], [item(), item({ externalId: 'L2', url: 'lunatask://tasks/L2' })]);

  const gone = sync(first.tasks, [item()], LATER, 'dropped');
  const l2 = gone.tasks.find((t) => t.origin.externalId === 'L2');
  assert.equal(l2?.status, 'dropped');
  assert.equal(l2?.mirror?.detail, 'No longer in Lunatask');

  const notLooked = planSync(first.tasks, 'lunatask', [item()], { whenGone: 'done', covered: (id) => id !== 'L2' }, LATER, newId);
  assert.equal(notLooked.changed.length, 0);
});

test('the source fills in Eisenhower answers only while the task is unplaced here', () => {
  const first = sync([], [item()]); // no answers from the source
  const filled = sync(first.tasks, [item({ important: true, urgent: true })], LATER);
  assert.equal(filled.tasks[0].important, true);

  const yours = { ...filled.tasks[0], important: false, urgent: false };
  const ignored = sync([yours], [item({ important: true, urgent: true, detail: 'Lunatask: started' })], LATER);
  assert.equal(ignored.tasks[0].important, false);
  assert.equal(ignored.tasks[0].mirror?.detail, 'Lunatask: started');
});

test('scheduling follows the source; your title and notes are never touched', () => {
  const first = sync([], [item({ scheduledDate: '2026-10-16' })]);
  const renamed = { ...first.tasks[0], title: 'Book flights', notes: 'aisle seat', mirror: { ...first.tasks[0].mirror!, placeholderTitle: false } };
  const moved = sync([renamed], [item({ scheduledDate: '2026-10-20' })], LATER);
  assert.equal(moved.tasks[0].scheduledDate, '2026-10-20');
  assert.equal(moved.tasks[0].title, 'Book flights');
  assert.equal(moved.tasks[0].notes, 'aisle seat');
  assert.equal(moved.tasks[0].updatedAt, LATER);
});

test('tasks from other sources are never touched', () => {
  const manual: Task = {
    id: 'm', title: 'Manual one', notes: '', origin: { source: 'manual', externalId: 'L1', url: null }, alsoIn: [],
    important: null, urgent: null, dueDate: null, scheduledDate: null, status: 'open', mergedInto: null,
    notDuplicateOf: [], createdAt: NOW, updatedAt: NOW, closedAt: null,
  };
  const { tasks } = sync([manual], []);
  assert.deepEqual(tasks, [manual]);
});
