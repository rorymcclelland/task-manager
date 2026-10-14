import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../src/store/json-file-store.ts';
import { TaskService, ValidationError } from '../src/tasks.ts';
import { DEFAULT_SETTINGS } from '../src/priority.ts';

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

// ---- Phase 2 -----------------------------------------------------------------

test('2.1 — new tasks start untriaged', async () => {
  const service = await freshService();
  await service.create({ title: 'Undecided' });
  const [task] = await service.listOpen();
  assert.equal(task.priority.placement, 'untriaged');
});

test('2.3 — placing a task sets both answers in one step', async () => {
  const service = await freshService();
  const task = await service.create({ title: 'Quarterly plan' });
  const placed = await service.place(task.id, 'schedule');
  assert.equal(placed.important, true);
  assert.equal(placed.urgent, false);
  assert.equal(placed.priority.placement, 'schedule');

  const back = await service.place(task.id, 'untriaged');
  assert.equal(back.important, null);
  assert.equal(back.urgent, null);
});

test('2.3 — an unknown quadrant is refused', async () => {
  const service = await freshService();
  const task = await service.create({ title: 'x' });
  await assert.rejects(service.place(task.id, 'someday'), ValidationError);
  await assert.rejects(service.place(task.id, 'toString'), ValidationError);
});

test('2.4 — a task due soon stays in "Do now" even when placed in "Schedule"', async () => {
  const service = await freshService(); // clock: 14 Oct 2026
  const task = await service.create({ title: 'File expenses' });
  await service.update(task.id, { dueDate: '2026-10-15' });
  const placed = await service.place(task.id, 'schedule');
  assert.equal(placed.urgent, false, 'your answer is saved…');
  assert.equal(placed.priority.placement, 'do', '…but the due date still wins');
  assert.equal(placed.priority.urgencyReason, 'due-soon');
});

test('capture can place a task straight away', async () => {
  const service = await freshService();
  const task = await service.create({ title: 'Pay VAT', placement: 'do' });
  assert.equal(task.important, true);
  assert.equal(task.urgent, true);
});

test('the matrix groups open tasks and flags an overloaded "Do now"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-matrix-'));
  const clock = () => new Date(Date.UTC(2026, 9, 14, 9));
  const service = new TaskService(new JsonFileStore(join(dir, 'tasks.json')), clock, { ...DEFAULT_SETTINGS, urgentWithinDays: 3, doNowLimit: 1 });
  await service.create({ title: 'One', placement: 'do' });
  await service.create({ title: 'Two', placement: 'do' });
  await service.create({ title: 'Later', placement: 'schedule' });

  const matrix = await service.matrix();
  assert.equal(matrix.today, '2026-10-14');
  const [doNow, schedule] = matrix.quadrants;
  assert.equal(doNow.tasks.length, 2);
  assert.equal(doNow.overloaded, true);
  assert.equal(schedule.tasks.length, 1);
});

// ---- Phase 4: scheduling ----------------------------------------------------------

test('4.2 — a task can be given a day and a time slot', async () => {
  const service = await freshService();
  const task = await service.create({ title: 'Write report' });
  const updated = await service.update(task.id, { scheduledDate: '2026-10-15', slot: { start: '14:00', minutes: 90 } });
  assert.deepEqual(updated.slot, { start: '14:00', minutes: 90 });
});

test('4.2 — a slot needs a day, and unscheduling the day clears the slot', async () => {
  const service = await freshService();
  const task = await service.create({ title: 'Write report' });
  await assert.rejects(service.update(task.id, { slot: { start: '14:00', minutes: 30 } }), /scheduled day/);
  await service.update(task.id, { scheduledDate: '2026-10-15', slot: { start: '14:00', minutes: 30 } });
  const cleared = await service.update(task.id, { scheduledDate: null });
  assert.equal(cleared.slot, null);
});

test('4.2 — slots are checked: real times, sensible lengths, finished by midnight', async () => {
  const service = await freshService();
  const task = await service.create({ title: 'x' });
  const bad = [
    { start: '25:00', minutes: 30 },
    { start: '9:00', minutes: 30 },
    { start: '09:00', minutes: 2 },
    { start: '23:30', minutes: 60 },
    'tomorrow',
  ];
  for (const slot of bad) {
    await assert.rejects(service.update(task.id, { scheduledDate: '2026-10-15', slot: slot as any }), ValidationError);
  }
  // Minutes default to 30.
  const ok = await service.update(task.id, { scheduledDate: '2026-10-15', slot: { start: '09:00' } as any });
  assert.deepEqual(ok.slot, { start: '09:00', minutes: 30 });
});

test('4.2 — on:/at: from capture creates a scheduled task', async () => {
  const service = await freshService();
  const task = await service.create({ title: 'Call', scheduledDate: '2026-10-16', slot: { start: '09:30', minutes: 30 } });
  assert.equal(task.scheduledDate, '2026-10-16');
  assert.deepEqual(task.slot, { start: '09:30', minutes: 30 });
});

// ---- Phase 5 -----------------------------------------------------------------------

test('5.1 — creating, editing and placing all count as attention; keep resets it', async () => {
  const service = await freshService();
  const task = await service.create({ title: 'Something' });
  assert.ok(task.reviewedAt);
  const edited = await service.update(task.id, { notes: 'more' });
  assert.ok(edited.reviewedAt! > task.reviewedAt!);
  const kept = await service.keep(task.id);
  assert.ok(kept.reviewedAt! > edited.reviewedAt!);
  assert.equal(kept.notes, 'more');
  // Undo for keep puts the old value back.
  const undone = await service.setReviewedAt(task.id, edited.reviewedAt!);
  assert.equal(undone.reviewedAt, edited.reviewedAt);
});

test('5.2 — the review queue: unplaced first, each task once', async () => {
  const service = await freshService();
  await service.create({ title: 'Unplaced' });
  await service.create({ title: 'Overdue and unplaced', dueDate: '2026-10-01' });
  await service.create({ title: 'Overdue, placed', dueDate: '2026-10-01', placement: 'schedule' });
  await service.create({ title: 'Fine', placement: 'schedule' });
  const queue = await service.review();
  assert.deepEqual(queue.items.map((i) => [i.task.title, i.reason]), [
    ['Unplaced', 'untriaged'],
    ['Overdue and unplaced', 'untriaged'],
    ['Overdue, placed', 'overdue'],
  ]);
  assert.deepEqual(queue.items[1].reasons, ['untriaged', 'overdue']);
  assert.equal(queue.counts.overdue, 2);
});

test('Q8 — duplicate results are reused only while nothing relevant has changed', async () => {
  const service = await freshService();
  const a = await service.create({ title: 'Order printer paper' });
  const b = await service.create({ title: 'Order the printer paper' });
  assert.equal((await service.duplicates()).length, 1);
  // A notes edit doesn't change the pairs, but the pair carries the new notes.
  await service.update(a.id, { notes: 'A4' });
  assert.equal((await service.duplicates())[0].a.notes || (await service.duplicates())[0].b.notes, 'A4');
  // A rename, "not the same", and closing a task each change the answer.
  await service.update(b.id, { title: 'Renew the domain' });
  assert.equal((await service.duplicates()).length, 0);
  await service.update(b.id, { title: 'Order printer paper now' });
  assert.equal((await service.duplicates()).length, 1);
  await service.markNotDuplicate(a.id, b.id);
  assert.equal((await service.duplicates()).length, 0);
});
