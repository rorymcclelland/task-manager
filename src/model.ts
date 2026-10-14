// The task data model (backlog item 0.3).
//
// One shape that can represent a task from any source system. Everything the
// app does — the list, the API, the JSON file on disk — uses this type.

/** The systems a task can come from. "manual" means typed straight into this app. */
export const SOURCES = ['manual', 'claude', 'gemini', 'lunatask', 'local'] as const;
export type Source = (typeof SOURCES)[number];

/**
 * Where a task is in its life.
 * - open:    still needs doing
 * - done:    finished
 * - dropped: no longer real (decided not to do it)
 * - merged:  was a duplicate; folded into another task (see `mergedInto`)
 */
export const STATUSES = ['open', 'done', 'dropped', 'merged'] as const;
export type Status = (typeof STATUSES)[number];

/** A pointer back to the task in the system it came from. */
export interface SourceRef {
  source: Source;
  /** The other system's own ID for this task, if it has one. Used later to
   *  avoid importing the same item twice. */
  externalId: string | null;
  /** A link that opens the task (or conversation) in the other system. */
  url: string | null;
}

export interface Task {
  id: string;
  title: string;
  notes: string;

  /** Where the task was first seen. */
  origin: SourceRef;
  /** Other places the same task also exists — filled in when duplicates are
   *  merged, so a merged task still tells you every system it lives in. */
  alsoIn: SourceRef[];

  // Eisenhower inputs. `null` means "not decided yet" — deliberately different
  // from `false`, so the app can tell an untriaged task from one you've judged
  // to be unimportant. src/priority.ts turns these (plus the due date) into
  // a place on the Eisenhower matrix. `urgent` is what you said; a near due
  // date can make a task urgent regardless (see priority.ts).
  important: boolean | null;
  urgent: boolean | null;

  /** Dates as plain YYYY-MM-DD strings: a due date is a calendar day, not an
   *  instant, so storing a time zone would only invite off-by-one bugs. */
  dueDate: string | null;
  /** The day you mean to do it. Different from the due date: due is when it
   *  must be done by, scheduled is when you've decided to do it. */
  scheduledDate: string | null;
  /** Phase 4 (4.2): a time on the scheduled day, if it has one. Only
   *  allowed while `scheduledDate` is set — a time with no day means
   *  nothing. Missing on tasks saved before Phase 4, which reads the same
   *  as null, so older task files still load unchanged. */
  slot?: Slot | null;

  status: Status;
  /** Set only when status is "merged": the id of the task that absorbed this one. */
  mergedInto: string | null;
  /** Task ids you've said are NOT duplicates of this one, so the app stops
   *  suggesting them. */
  notDuplicateOf: string[];

  /** ISO 8601 timestamps. */
  createdAt: string;
  updatedAt: string;
  /** When the task left "open" (done, dropped or merged). Null while open. */
  closedAt: string | null;
  /** Phase 5 (5.1): the last time *you* paid it attention — created it,
   *  edited, placed or scheduled it, or said it's still relevant. Syncs
   *  never set it, so a task Lunatask keeps touching can still go stale.
   *  Missing on tasks saved before Phase 5; see `lastAttention` in
   *  priority.ts for what's used instead. */
  reviewedAt?: string;

  /** Only on tasks a sync keeps up to date (Lunatask, files on this
   *  computer). Missing on everything else, including tasks saved before
   *  Phase 3 — so older task files still load unchanged. See src/sync.ts. */
  mirror?: MirrorInfo;
}

/**
 * A time slot on the task's scheduled day (4.2).
 *
 * `start` is a wall-clock time, "HH:MM" in 24-hour form, for the same reason
 * dates are plain strings: "14:00 on Thursday" means 14:00 wherever this
 * computer happens to be, not an instant in some time zone.
 */
export interface Slot {
  start: string;
  /** How long it's blocked out for, in minutes. */
  minutes: number;
}

/** What a sync knows about a task it's mirroring from another system. */
export interface MirrorInfo {
  /** What the other system last said about it, in words — e.g.
   *  "Lunatask: next · high priority". Shown under the task. */
  detail: string;
  /** Whether the other system had it open at the last sync. A sync only
   *  closes the task here when this flips from true to false — so if you
   *  reopen it here, the next sync leaves it alone. */
  openInSource: boolean;
  /** True while the title is a stand-in because the other system wouldn't
   *  give us one (Lunatask encrypts names). Cleared when you rename it. */
  placeholderTitle: boolean;
  /** The scheduled date the other system gave at the last sync. A sync only
   *  copies the source's scheduled date over yours when this changes — so a
   *  date (or time slot) you set here survives until the source itself
   *  moves the task. Missing on tasks synced before Phase 4. See D12. */
  sourceScheduledDate?: string | null;
}

export function isSource(value: unknown): value is Source {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day as YYYY-MM-DD. Q2: the pattern alone let 2026-02-30
 *  and 2026-13-45 through, so the date is also checked to exist — it must
 *  survive a round trip through the calendar unchanged. */
export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** "HH:MM", 24-hour, 00:00–23:59. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export function isTimeString(value: unknown): value is string {
  return typeof value === 'string' && TIME_PATTERN.test(value);
}

/** Minutes since midnight for an "HH:MM" time. */
export function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** "HH:MM" for a number of minutes since midnight. */
export function timeOf(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
