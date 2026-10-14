import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgenda, freeTime, parseDayHours, type AgendaInput } from '../src/agenda.ts';
import type { Task } from '../src/model.ts';
import { DEFAULT_SETTINGS } from '../src/priority.ts';
import type { CalendarOccurrence } from '../src/sources/calendar.ts';

let n = 0;
function task(overrides: Partial<Task>): Task {
  return {
    id: `t${++n}`,
    title: 'Task',
    notes: '',
    origin: { source: 'manual', externalId: null, url: null },
    alsoIn: [],
    important: null,
    urgent: null,
    dueDate: null,
    scheduledDate: null,
    slot: null,
    status: 'open',
    mergedInto: null,
    notDuplicateOf: [],
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

function timed(title: string, startIso: string, endIso: string, busy = true): CalendarOccurrence {
  return { uid: title, title, location: '', busy, allDay: false, startDate: null, endDate: null, startMs: Date.parse(startIso), endMs: Date.parse(endIso), calendar: 'Work' };
}

function agenda(overrides: Partial<AgendaInput>) {
  return buildAgenda({
    tasks: [],
    occurrences: [],
    from: '2026-10-14',
    days: 1,
    today: '2026-10-14',
    nowTime: '08:00',
    zone: 'Europe/Dublin',
    settings: DEFAULT_SETTINGS,
    dayHours: { start: '09:00', end: '18:00' },
    ...overrides,
  });
}

test('4.1 — events are shown in local time and clipped to the day', () => {
  const [day] = agenda({
    occurrences: [
      timed('Standup', '2026-10-14T08:30:00Z', '2026-10-14T08:45:00Z'), // 09:30 IST
      timed('Overnight', '2026-10-13T21:00:00Z', '2026-10-14T07:00:00Z'), // 22:00 → 08:00
    ],
  }).days;
  assert.deepEqual(day.events.map((e) => [e.title, e.start, e.end, e.startsEarlier]), [
    ['Overnight', '00:00', '08:00', true],
    ['Standup', '09:30', '09:45', false],
  ]);
});

test('4.1 — free time is the working day minus busy events and slotted tasks', () => {
  const [day] = agenda({
    occurrences: [
      timed('Meeting', '2026-10-14T09:00:00Z', '2026-10-14T10:00:00Z'), //       10:00–11:00
      timed('Lunch (free)', '2026-10-14T12:00:00Z', '2026-10-14T13:00:00Z', false),
    ],
    tasks: [task({ title: 'Write report', scheduledDate: '2026-10-14', slot: { start: '14:00', minutes: 90 } })],
  }).days;
  assert.equal(day.free!.minutes, 9 * 60 - 60 - 90);
  assert.deepEqual(day.free!.gaps, [
    { start: '09:00', end: '10:00' },
    { start: '11:00', end: '14:00' },
    { start: '15:30', end: '18:00' },
  ]);
});

test('4.1 — today, free time only counts from now', () => {
  const [day] = agenda({ nowTime: '16:00' }).days;
  assert.equal(day.free!.minutes, 120);
});

test('freeTime counts overlapping busy stretches once and ignores ones outside hours', () => {
  const free = freeTime({ start: '09:00', end: '12:00' }, '00:00', [
    { start: '08:00', end: '09:30' },
    { start: '10:00', end: '11:00' },
    { start: '10:30', end: '11:15' },
    { start: '13:00', end: '14:00' },
  ]);
  assert.equal(free.minutes, 30 + 45);
});

test('4.2 / 4.3 — tasks land on their day: slotted, scheduled, or due', () => {
  const tasks = [
    task({ title: 'Slotted', scheduledDate: '2026-10-15', slot: { start: '10:00', minutes: 30 } }),
    task({ title: 'Some time that day', scheduledDate: '2026-10-15' }),
    task({ title: 'Due', dueDate: '2026-10-15' }),
    task({ title: 'Due and scheduled the same day', dueDate: '2026-10-15', scheduledDate: '2026-10-15' }),
    task({ title: 'Closed', scheduledDate: '2026-10-15', status: 'done' }),
  ];
  const [, day] = agenda({ tasks, days: 2 }).days;
  assert.deepEqual(day.slotted.map((t) => t.title), ['Slotted']);
  assert.deepEqual(day.scheduled.map((t) => t.title), ['Some time that day', 'Due and scheduled the same day']);
  assert.deepEqual(day.due.map((t) => t.title), ['Due']);
});

test('4.3 — overdue, missed and due-later are pulled out', () => {
  const tasks = [
    task({ title: 'Overdue', dueDate: '2026-10-10' }),
    task({ title: 'Missed', scheduledDate: '2026-10-12' }),
    task({ title: 'Way off', dueDate: '2026-12-01' }),
  ];
  const result = agenda({ tasks, days: 14 });
  assert.deepEqual(result.overdue.map((t) => t.title), ['Overdue']);
  assert.deepEqual(result.missed.map((t) => t.title), ['Missed']);
  assert.deepEqual(result.dueLater.map((t) => t.title), ['Way off']);
  assert.equal(result.to, '2026-10-27');
});

test('days already over have no free time', () => {
  const [day] = agenda({ from: '2026-10-13' }).days;
  assert.equal(day.free, null);
});

test('DAY_HOURS is read leniently but checked', () => {
  assert.deepEqual(parseDayHours('9:00-17:30'), { start: '09:00', end: '17:30' });
  assert.deepEqual(parseDayHours('08:00 – 24:00'), { start: '08:00', end: '24:00' });
  assert.equal(parseDayHours('18:00-09:00'), null);
  assert.equal(parseDayHours('all day'), null);
});
