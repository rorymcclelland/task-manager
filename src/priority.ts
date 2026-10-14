// Prioritisation (backlog Phase 2): where a task sits on the Eisenhower
// matrix, and when a quadrant has too much in it.
//
// Nothing here is stored. A task stores only what you decided (`important`,
// `urgent`) and its `dueDate`; the quadrant is worked out from those, plus
// today's date, every time it's asked for. That's what lets time passing move
// a task into "Do now" without anyone editing it (2.4).
//
// All functions here are pure — no clock, no storage — so they can be tested
// with any "today" we like.

import type { Task } from './model.ts';

/**
 * The four Eisenhower quadrants, plus a pile for tasks not placed yet.
 *
 *                    urgent        not urgent
 *   important     ┌────────────┬──────────────┐
 *                 │ do         │ schedule     │
 *                 ├────────────┼──────────────┤
 *   not important │ delegate   │ eliminate    │
 *                 └────────────┴──────────────┘
 */
export const QUADRANTS = ['do', 'schedule', 'delegate', 'eliminate'] as const;
export type Quadrant = (typeof QUADRANTS)[number];
export type Placement = Quadrant | 'untriaged';

export const QUADRANT_LABELS: Record<Placement, string> = {
  do: 'Do now',
  schedule: 'Schedule',
  delegate: 'Delegate or fit in',
  eliminate: 'Drop or defer',
  untriaged: 'Not placed yet',
};

/** The important/urgent answers that put a task in each quadrant. Placing a
 *  task (2.3) just writes these two fields. */
export const QUADRANT_FLAGS: Record<Placement, { important: boolean | null; urgent: boolean | null }> = {
  do: { important: true, urgent: true },
  schedule: { important: true, urgent: false },
  delegate: { important: false, urgent: true },
  eliminate: { important: false, urgent: false },
  untriaged: { important: null, urgent: null },
};

export interface PrioritySettings {
  /** A task due within this many days (or overdue) counts as urgent,
   *  whatever its `urgent` field says. 0 = only when due today. */
  urgentWithinDays: number;
  /** "Do now" is flagged as overloaded above this many tasks (2.5). */
  doNowLimit: number;
}

export const DEFAULT_SETTINGS: PrioritySettings = { urgentWithinDays: 3, doNowLimit: 5 };

/** Why a task is (or isn't) urgent — shown in the UI so the rule is visible. */
export type UrgencyReason =
  | 'due-soon' //  due within the window, or overdue: urgent whatever you said
  | 'marked' //    you said so, and no due date overrides it
  | 'due-later' // has a due date outside the window and you haven't said
  | 'undecided'; // no due date, and you haven't said

export interface Priority {
  placement: Placement;
  /** Urgency after the due-date rule is applied. Null = still undecided. */
  urgent: boolean | null;
  urgencyReason: UrgencyReason;
  /** Days until due: 0 = today, 1 = tomorrow, negative = overdue. Null if no due date. */
  dueInDays: number | null;
}

export type PrioritisedTask = Task & { priority: Priority };

/** Work out where one task sits on `today` (a YYYY-MM-DD date). */
export function prioritise(task: Task, today: string, settings: PrioritySettings): Priority {
  const dueInDays = task.dueDate ? daysBetween(today, task.dueDate) : null;

  // 2.4: the due date can only make a task MORE urgent. A task you marked
  // urgent stays urgent even if its due date is weeks away — you may know
  // something the date doesn't.
  let urgent: boolean | null;
  let urgencyReason: UrgencyReason;
  if (dueInDays !== null && dueInDays <= settings.urgentWithinDays) {
    urgent = true;
    urgencyReason = 'due-soon';
  } else if (task.urgent !== null) {
    urgent = task.urgent;
    urgencyReason = 'marked';
  } else if (dueInDays !== null) {
    urgent = false;
    urgencyReason = 'due-later';
  } else {
    urgent = null;
    urgencyReason = 'undecided';
  }

  return { placement: placementOf(task.important, urgent), urgent, urgencyReason, dueInDays };
}

/** A task is only placed once both questions have an answer. */
function placementOf(important: boolean | null, urgent: boolean | null): Placement {
  if (important === null || urgent === null) return 'untriaged';
  if (important) return urgent ? 'do' : 'schedule';
  return urgent ? 'delegate' : 'eliminate';
}

// ---- The matrix as a whole -------------------------------------------------

export interface QuadrantView {
  id: Placement;
  label: string;
  tasks: PrioritisedTask[];
  /** The soft limit for this quadrant, if it has one. */
  limit: number | null;
  /** 2.5: true when the quadrant holds more than its limit. */
  overloaded: boolean;
}

export interface Matrix {
  today: string;
  settings: PrioritySettings;
  /** Always in the same order: do, schedule, delegate, eliminate, untriaged —
   *  so "Do now" is first everywhere it's drawn (2.2). */
  quadrants: QuadrantView[];
}

/** Group open tasks into the matrix. Closed tasks are ignored. */
export function buildMatrix(tasks: Task[], today: string, settings: PrioritySettings): Matrix {
  const open = tasks
    .filter((t) => t.status === 'open')
    .map((t): PrioritisedTask => ({ ...t, priority: prioritise(t, today, settings) }));

  const quadrants = [...QUADRANTS, 'untriaged' as const].map((id): QuadrantView => {
    const inHere = open.filter((t) => t.priority.placement === id).sort(byDueThenAge);
    // Only "Do now" has a limit. It's the quadrant whose whole value depends
    // on being short; a long "Schedule" list is normal.
    const limit = id === 'do' ? settings.doNowLimit : null;
    return {
      id,
      label: QUADRANT_LABELS[id],
      tasks: inHere,
      limit,
      overloaded: limit !== null && inHere.length > limit,
    };
  });

  return { today, settings, quadrants };
}

/**
 * Order inside a quadrant: soonest due first (overdue at the very top), then
 * tasks with no due date, oldest first — the longer something has waited,
 * the higher it floats.
 */
export function byDueThenAge(a: PrioritisedTask, b: PrioritisedTask): number {
  const dueA = a.priority.dueInDays ?? Infinity;
  const dueB = b.priority.dueInDays ?? Infinity;
  if (dueA !== dueB) return dueA - dueB;
  return a.createdAt.localeCompare(b.createdAt);
}

// ---- Dates -------------------------------------------------------------------

/** Whole days from `from` to `to` (both YYYY-MM-DD). Negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  // Both read as midnight UTC, so clock changes can't make a day 23 hours long.
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

/** Today's date on this computer's clock, as YYYY-MM-DD. Uses local time, not
 *  UTC, so just after midnight in Dublin it's already tomorrow. */
export function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
