// Time (backlog Phase 4): tasks and calendar events laid out day by day.
//
// One function, `buildAgenda`, feeds both new views:
//
//   - Day (4.1, 4.2): one day's calendar next to the list, with the tasks
//     slotted into it and how much free time is left.
//   - Ahead (4.3): the coming fortnight — what's overdue, what's due, what's
//     scheduled, and what's on the calendar around it.
//
// Pure, like priority.ts: no clock, no storage, no network. The caller
// passes in today, the time now, the tasks and the calendar occurrences.

import type { CalendarOccurrence } from './sources/calendar.ts';
import { instantOf, wallAt } from './calendar/zones.ts';
import { addDays } from './calendar/ics.ts';
import { minutesOf, timeOf, type Task } from './model.ts';
import { prioritise, type PrioritisedTask, type PrioritySettings } from './priority.ts';

/** Your working day, e.g. 09:00–18:00. Free time is counted inside it. */
export interface DayHours {
  start: string;
  end: string;
}

export const DEFAULT_DAY_HOURS: DayHours = { start: '09:00', end: '18:00' };

/** A calendar event as it falls on one day, in this computer's local time. */
export interface AgendaEvent {
  calendar: string;
  title: string;
  location: string;
  allDay: boolean;
  /** "HH:MM" on this day; null for all-day events. An event that started
   *  the day before shows "00:00"; one running past midnight ends "24:00". */
  start: string | null;
  end: string | null;
  startsEarlier: boolean;
  endsLater: boolean;
  /** False for events marked "show me as free". */
  busy: boolean;
}

export interface FreeTime {
  /** Minutes not taken by busy events or slotted tasks, inside the day's
   *  hours — and, today, only from now on. */
  minutes: number;
  /** The free stretches of 15 minutes or more. */
  gaps: { start: string; end: string }[];
}

export interface AgendaDay {
  date: string;
  isToday: boolean;
  events: AgendaEvent[];
  /** Tasks with a time slot on this day, earliest first. */
  slotted: PrioritisedTask[];
  /** Tasks scheduled for this day with no particular time. */
  scheduled: PrioritisedTask[];
  /** Tasks due this day that aren't already scheduled for it. */
  due: PrioritisedTask[];
  /** Null for days already over. */
  free: FreeTime | null;
}

export interface Agenda {
  today: string;
  from: string;
  to: string;
  dayHours: DayHours;
  /** Open tasks whose due date has passed (only when the agenda includes today). */
  overdue: PrioritisedTask[];
  /** Open tasks scheduled for a day already gone (only when it includes today). */
  missed: PrioritisedTask[];
  /** The next few open tasks due after the last day shown — so a deadline
   *  just past the edge of the fortnight still gets seen. */
  dueLater: PrioritisedTask[];
  days: AgendaDay[];
  /** Repeating events whose rule couldn't be read (only the first shown). */
  unsupportedRules: number;
}

export interface AgendaInput {
  tasks: Task[];
  occurrences: CalendarOccurrence[];
  unsupportedRules?: number;
  from: string;
  days: number;
  today: string;
  /** "HH:MM" now, on this computer — free time today starts here. */
  nowTime: string;
  /** The zone event times are shown in: this computer's. */
  zone: string;
  settings: PrioritySettings;
  dayHours: DayHours;
}

/** How many tasks "due later" lists. */
const DUE_LATER_LIMIT = 5;
/** Free stretches shorter than this aren't worth listing. */
const MIN_GAP = 15;

export function buildAgenda(input: AgendaInput): Agenda {
  const { from, today, settings } = input;
  const to = addDays(from, input.days - 1);
  const open = input.tasks
    .filter((t) => t.status === 'open')
    .map((t): PrioritisedTask => ({ ...t, priority: prioritise(t, today, settings) }));

  const days: AgendaDay[] = [];
  for (let i = 0; i < input.days; i++) {
    const date = addDays(from, i);
    const events = eventsOn(date, input.occurrences, input.zone);
    const slotted = open
      .filter((t) => t.scheduledDate === date && t.slot)
      .sort((a, b) => a.slot!.start.localeCompare(b.slot!.start));
    const scheduled = open.filter((t) => t.scheduledDate === date && !t.slot).sort(byPriority);
    const due = open.filter((t) => t.dueDate === date && t.scheduledDate !== date).sort(byPriority);

    let free: FreeTime | null = null;
    if (date >= today) {
      // Today, free time starts now — rounded up to 5 minutes, so it reads
      // "free from 12:05" rather than "12:02".
      const from = date === today ? timeOf(Math.min(1440, Math.ceil(minutesOf(input.nowTime) / 5) * 5)) : '00:00';
      free = freeTime(input.dayHours, from, [
        ...events.filter((e) => e.busy && !e.allDay).map((e) => ({ start: e.start!, end: e.end! })),
        ...slotted.map((t) => ({ start: t.slot!.start, end: timeOf(minutesOf(t.slot!.start) + t.slot!.minutes) })),
      ]);
    }
    days.push({ date, isToday: date === today, events, slotted, scheduled, due, free });
  }

  const includesToday = from <= today && today <= to;
  return {
    today,
    from,
    to,
    dayHours: input.dayHours,
    overdue: includesToday ? open.filter((t) => t.dueDate !== null && t.dueDate < today).sort(byDue) : [],
    missed: includesToday ? open.filter((t) => t.scheduledDate !== null && t.scheduledDate < today).sort((a, b) => a.scheduledDate!.localeCompare(b.scheduledDate!)) : [],
    dueLater: open.filter((t) => t.dueDate !== null && t.dueDate > to).sort(byDue).slice(0, DUE_LATER_LIMIT),
    days,
    unsupportedRules: input.unsupportedRules ?? 0,
  };
}

/** The events that touch `date`, clipped to it, in local time. */
function eventsOn(date: string, occurrences: CalendarOccurrence[], zone: string): AgendaEvent[] {
  const [y, m, d] = date.split('-').map(Number);
  const dayStart = instantOf({ y, m, d, h: 0, mi: 0, s: 0 }, zone);
  const next = addDays(date, 1).split('-').map(Number);
  const dayEnd = instantOf({ y: next[0], m: next[1], d: next[2], h: 0, mi: 0, s: 0 }, zone);

  const events: AgendaEvent[] = [];
  for (const o of occurrences) {
    const base = { calendar: o.calendar, title: o.title, location: o.location, busy: o.busy };
    if (o.allDay) {
      if (o.startDate! <= date && date < o.endDate!) {
        events.push({ ...base, allDay: true, start: null, end: null, startsEarlier: o.startDate! < date, endsLater: addDays(date, 1) < o.endDate! });
      }
      continue;
    }
    const startMs = o.startMs!;
    const endMs = o.endMs!;
    const touches = endMs > startMs ? startMs < dayEnd && endMs > dayStart : startMs >= dayStart && startMs < dayEnd;
    if (!touches) continue;
    const startsEarlier = startMs < dayStart;
    const endsLater = endMs > dayEnd;
    events.push({
      ...base,
      allDay: false,
      start: startsEarlier ? '00:00' : clock(startMs, zone),
      end: endsLater ? '24:00' : clock(endMs, zone),
      startsEarlier,
      endsLater,
    });
  }
  // All-day first, then by start time.
  return events.sort((a, b) => (a.allDay === b.allDay ? (a.start ?? '').localeCompare(b.start ?? '') : a.allDay ? -1 : 1));
}

function clock(ms: number, zone: string): string {
  const w = wallAt(ms, zone);
  return timeOf(w.h * 60 + w.mi);
}

/**
 * Free time inside `hours`, from `notBefore` on, around the busy stretches.
 * Overlapping busy stretches are only counted once.
 */
export function freeTime(hours: DayHours, notBefore: string, busy: { start: string; end: string }[]): FreeTime {
  const dayStart = Math.max(minutesOf(hours.start), minutesOf(notBefore));
  const dayEnd = minutesOf(hours.end);
  const gaps: { start: string; end: string }[] = [];
  let minutes = 0;
  let cursor = dayStart;

  const stretches = busy
    .map((b) => [minutesOf(b.start), minutesOf(b.end)] as const)
    .sort((a, b) => a[0] - b[0]);

  const addGap = (start: number, end: number) => {
    if (end <= start) return;
    minutes += end - start;
    if (end - start >= MIN_GAP) gaps.push({ start: timeOf(start), end: timeOf(end) });
  };

  for (const [start, end] of stretches) {
    if (end <= cursor) continue;
    if (start >= dayEnd) break;
    addGap(cursor, Math.min(start, dayEnd));
    cursor = Math.max(cursor, end);
  }
  addGap(cursor, dayEnd);
  return { minutes, gaps };
}

/** Do now first, then Schedule, Delegate, Drop/defer, unplaced — the matrix's order. */
const PLACEMENT_ORDER = ['do', 'schedule', 'delegate', 'eliminate', 'untriaged'];
function byPriority(a: PrioritisedTask, b: PrioritisedTask): number {
  return PLACEMENT_ORDER.indexOf(a.priority.placement) - PLACEMENT_ORDER.indexOf(b.priority.placement) || a.createdAt.localeCompare(b.createdAt);
}

function byDue(a: PrioritisedTask, b: PrioritisedTask): number {
  return a.dueDate!.localeCompare(b.dueDate!) || byPriority(a, b);
}

/** "09:00-18:00" → DayHours, or null if it doesn't make sense. */
export function parseDayHours(text: string): DayHours | null {
  const match = text.trim().match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
  if (!match) return null;
  const [start, end] = [match[1].padStart(5, '0'), match[2].padStart(5, '0')];
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-4]):[0-5]\d$/.test(end)) return null;
  if (minutesOf(end) <= minutesOf(start) || minutesOf(end) > 1440) return null;
  return { start, end };
}
