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
  scheduledDate: string | null;

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
}

export function isSource(value: unknown): value is Source {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export function isDateString(value: unknown): value is string {
  return typeof value === 'string' && DATE_PATTERN.test(value);
}
