import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../src/model.ts';
import { buildMatrix, daysBetween, prioritise, type PrioritySettings } from '../src/priority.ts';

const TODAY = '2026-10-14'; // a Wednesday
const SETTINGS: PrioritySettings = { urgentWithinDays: 3, doNowLimit: 2 };

let counter = 0;
/** A minimal open task; override whatever a test cares about. */
function task(overrides: Partial<Task> = {}): Task {
  counter++;
  return {
    id: `t${counter}`,
    title: `Task ${counter}`,
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
    createdAt: `2026-10-01T09:00:${String(counter % 60).padStart(2, '0')}.000Z`,
    updatedAt: '2026-10-01T09:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

test('daysBetween counts calendar days, including across the October clock change', () => {
  assert.equal(daysBetween(TODAY, TODAY), 0);
  assert.equal(daysBetween(TODAY, '2026-10-15'), 1);
  assert.equal(daysBetween(TODAY, '2026-10-12'), -2);
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
});

test('2.1 — the two answers place a task in one of four quadrants', () => {
  const place = (important: boolean, urgent: boolean) => prioritise(task({ important, urgent }), TODAY, SETTINGS).placement;
  assert.equal(place(true, true), 'do');
  assert.equal(place(true, false), 'schedule');
  assert.equal(place(false, true), 'delegate');
  assert.equal(place(false, false), 'eliminate');
});

test('2.1 — a task stays untriaged until both questions are answered', () => {
  assert.equal(prioritise(task(), TODAY, SETTINGS).placement, 'untriaged');
  assert.equal(prioritise(task({ important: true }), TODAY, SETTINGS).placement, 'untriaged');
  assert.equal(prioritise(task({ urgent: true }), TODAY, SETTINGS).placement, 'untriaged');
});

test('2.4 — a due date inside the window makes a task urgent, whatever was said', () => {
  const p = prioritise(task({ important: true, urgent: false, dueDate: '2026-10-17' }), TODAY, SETTINGS);
  assert.equal(p.placement, 'do');
  assert.equal(p.urgencyReason, 'due-soon');
  assert.equal(p.dueInDays, 3);
});

test('2.4 — overdue tasks are urgent', () => {
  const p = prioritise(task({ important: false, dueDate: '2026-10-10' }), TODAY, SETTINGS);
  assert.equal(p.placement, 'delegate');
  assert.equal(p.dueInDays, -4);
});

test('2.4 — a due date outside the window answers "not urgent" only if you have not', () => {
  const later = '2026-10-30';
  assert.equal(prioritise(task({ important: true, dueDate: later }), TODAY, SETTINGS).placement, 'schedule');
  assert.equal(prioritise(task({ important: true, dueDate: later }), TODAY, SETTINGS).urgencyReason, 'due-later');
  // You said urgent: a distant date doesn't overrule you.
  assert.equal(prioritise(task({ important: true, urgent: true, dueDate: later }), TODAY, SETTINGS).placement, 'do');
});

test('2.4 — time passing moves a task into "Do now" with no edit', () => {
  const t = task({ important: true, urgent: false, dueDate: '2026-10-20' });
  assert.equal(prioritise(t, TODAY, SETTINGS).placement, 'schedule');
  assert.equal(prioritise(t, '2026-10-17', SETTINGS).placement, 'do');
});

test('2.2 — the matrix always lists "do" first, untriaged last', () => {
  const matrix = buildMatrix([task()], TODAY, SETTINGS);
  assert.deepEqual(matrix.quadrants.map((q) => q.id), ['do', 'schedule', 'delegate', 'eliminate', 'untriaged']);
});

test('the matrix ignores closed tasks and sorts by due date, then oldest first', () => {
  const noDueOld = task({ important: true, urgent: true, createdAt: '2026-09-01T00:00:00.000Z' });
  const noDueNew = task({ important: true, urgent: true, createdAt: '2026-10-10T00:00:00.000Z' });
  const overdue = task({ important: true, dueDate: '2026-10-13' });
  const today = task({ important: true, dueDate: TODAY });
  const done = task({ important: true, urgent: true, status: 'done' });

  const doNow = buildMatrix([noDueNew, today, done, noDueOld, overdue], TODAY, { ...SETTINGS, doNowLimit: 10 }).quadrants[0];
  assert.deepEqual(doNow.tasks.map((t) => t.id), [overdue.id, today.id, noDueOld.id, noDueNew.id]);
});

test('2.5 — "Do now" is flagged once it holds more than the limit', () => {
  const urgentImportant = () => task({ important: true, urgent: true });
  const atLimit = buildMatrix([urgentImportant(), urgentImportant()], TODAY, SETTINGS).quadrants[0];
  assert.equal(atLimit.overloaded, false);
  const over = buildMatrix([urgentImportant(), urgentImportant(), urgentImportant()], TODAY, SETTINGS).quadrants[0];
  assert.equal(over.overloaded, true);
  assert.equal(over.limit, 2);
});

test('2.5 — other quadrants have no limit', () => {
  const many = Array.from({ length: 20 }, () => task({ important: true, urgent: false }));
  const schedule = buildMatrix(many, TODAY, SETTINGS).quadrants[1];
  assert.equal(schedule.limit, null);
  assert.equal(schedule.overloaded, false);
});
