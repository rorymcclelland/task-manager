// Everything you can do to a task, in one place.
//
// The HTTP layer (app.ts) only translates requests into calls on TaskService;
// all the rules — what's allowed, what changes, what gets timestamped — live
// here, where they can be tested without a server.

import { randomUUID } from 'node:crypto';
import { buildAgenda, type Agenda, type DayHours } from './agenda.ts';
import type { CalendarOccurrence } from './sources/calendar.ts';
import type { CaptureResult } from './capture.ts';
import { findDuplicatePairs, type DuplicatePair } from './duplicates.ts';
import { isDateString, isSource, isTimeString, minutesOf, type Slot, type Source, type SourceRef, type Task } from './model.ts';
import {
  buildMatrix,
  DEFAULT_SETTINGS,
  localDateString,
  prioritise,
  QUADRANT_FLAGS,
  type Matrix,
  type Placement,
  type PrioritisedTask,
  type PrioritySettings,
} from './priority.ts';
import type { TaskStore } from './store/task-store.ts';
import { buildReviewQueue, type ReviewQueue } from './review.ts';
import { planSync, type SourceItem, type SyncOptions, type SyncReport } from './sync.ts';

/** Thrown for bad input; the HTTP layer turns it into a 400 response. */
export class ValidationError extends Error {}
/** Thrown when an id doesn't exist; the HTTP layer turns it into a 404. */
export class NotFoundError extends Error {}

export interface NewTask {
  title: string;
  notes?: string;
  source?: Source;
  externalId?: string | null;
  url?: string | null;
  /** Optionally place it on the matrix straight away (capture's !1–!4). */
  placement?: Placement;
  dueDate?: string | null;
  /** Phase 4: capture's on:YYYY-MM-DD and at:HH:MM. */
  scheduledDate?: string | null;
  slot?: Slot | null;
}

/** What happened when several captured tasks were added at once. */
export interface CaptureManyResult {
  created: Task[];
  /** Lines skipped because the same task is already here. */
  skipped: number;
}

/** The fields you can edit directly. Status changes have their own methods. */
export interface TaskChanges {
  title?: string;
  notes?: string;
  source?: Source;
  url?: string | null;
  important?: boolean | null;
  urgent?: boolean | null;
  dueDate?: string | null;
  scheduledDate?: string | null;
  /** 4.2: a time on the scheduled day, or null to make it "some time that
   *  day". Clearing `scheduledDate` clears this too. */
  slot?: Slot | null;
}

/** A slot is blocked out for this long unless you say otherwise. */
export const DEFAULT_SLOT_MINUTES = 30;

export class TaskService {
  private readonly store: TaskStore;
  private readonly now: () => Date;
  readonly settings: PrioritySettings;

  /** `now` is swappable so tests can control time. */
  constructor(store: TaskStore, now: () => Date = () => new Date(), settings: PrioritySettings = DEFAULT_SETTINGS) {
    this.store = store;
    this.now = now;
    this.settings = settings;
  }

  /** Today's date as YYYY-MM-DD, on this computer's clock. */
  today(): string {
    return localDateString(this.now());
  }

  // ---- Reading ----------------------------------------------------------

  /** Open tasks, newest first, each with its current priority. (1.1: everything
   *  in one list.) */
  async listOpen(): Promise<PrioritisedTask[]> {
    const today = this.today();
    const tasks = (await this.store.all()).filter((t) => t.status === 'open');
    return tasks
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((t) => ({ ...t, priority: prioritise(t, today, this.settings) }));
  }

  /** Open tasks grouped into Eisenhower quadrants. (2.1, 2.2, 2.5) */
  async matrix(): Promise<Matrix> {
    return buildMatrix(await this.store.all(), this.today(), this.settings);
  }

  /** Done, dropped and merged tasks, most recently closed first. */
  async listClosed(): Promise<Task[]> {
    const tasks = (await this.store.all()).filter((t) => t.status !== 'open');
    return tasks.sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  }

  /** Days from `from`, with tasks and calendar events laid out on them.
   *  (Phase 4: the Day and Ahead views.) */
  async agenda(options: {
    from: string;
    days: number;
    occurrences: CalendarOccurrence[];
    unsupportedRules: number;
    zone: string;
    dayHours: DayHours;
  }): Promise<Agenda> {
    const now = this.now();
    return buildAgenda({
      ...options,
      tasks: await this.store.all(),
      today: localDateString(now),
      nowTime: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      settings: this.settings,
    });
  }

  /** Q5: anything about the task file worth showing (entries set aside). */
  storeProblems(): string[] {
    return this.store.problems?.() ?? [];
  }

  /** 5.2: what needs a decision, in the order it's worth deciding. */
  async review(): Promise<ReviewQueue> {
    return buildReviewQueue(await this.listOpen(), this.today(), this.settings);
  }

  async get(id: string): Promise<Task> {
    const task = await this.store.get(id);
    if (!task) throw new NotFoundError(`No task with id ${id}`);
    return task;
  }

  /** Q8: the last answer, and what it was worked out from. */
  private duplicateCache: { key: string; pairs: DuplicatePair[] } | null = null;

  /**
   * Likely duplicates among open tasks. The page asks on every refresh, and
   * usually nothing relevant has changed, so the answer is reused until an
   * open task's id, title or "not the same" list changes (Q8).
   */
  async duplicates(): Promise<DuplicatePair[]> {
    const tasks = await this.store.all();
    const key = JSON.stringify(
      tasks
        .filter((t) => t.status === 'open' && !t.mirror?.placeholderTitle)
        .map((t) => [t.id, t.title, t.notDuplicateOf]),
    );
    if (this.duplicateCache?.key !== key) {
      this.duplicateCache = { key, pairs: findDuplicatePairs(tasks) };
    } else {
      // Same pairs, but hand back today's copies of the tasks (other fields
      // — dates, notes — may have changed).
      const byId = new Map(tasks.map((t) => [t.id, t]));
      this.duplicateCache.pairs = this.duplicateCache.pairs.map((p) => ({ ...p, a: byId.get(p.a.id)!, b: byId.get(p.b.id)! }));
    }
    return this.duplicateCache.pairs;
  }

  // ---- Creating and editing (1.3) -----------------------------------------

  async create(input: NewTask): Promise<Task> {
    const title = requireTitle(input.title);
    const source = input.source ?? 'manual';
    if (!isSource(source)) throw new ValidationError(`Unknown source: ${String(source)}`);
    const timestamp = this.now().toISOString();

    const task: Task = {
      id: randomUUID(),
      title,
      notes: requireTextOrEmpty(input.notes, 'notes'),
      origin: { source, externalId: requireTextOrNull(input.externalId, 'externalId'), url: cleanUrl(input.url) },
      alsoIn: [],
      ...flagsFor(input.placement ?? 'untriaged'),
      dueDate: input.dueDate === undefined ? null : requireDateOrNull(input.dueDate, 'dueDate'),
      scheduledDate: input.scheduledDate === undefined ? null : requireDateOrNull(input.scheduledDate, 'scheduledDate'),
      slot: input.slot === undefined ? null : requireSlotOrNull(input.slot),
      status: 'open',
      mergedInto: null,
      notDuplicateOf: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
      reviewedAt: timestamp,
    };
    requireSlotHasDay(task);
    await this.store.save(task);
    return task;
  }

  async update(id: string, changes: TaskChanges): Promise<Task> {
    const task = await this.get(id);
    const updated: Task = { ...task, origin: { ...task.origin } };

    if (changes.title !== undefined) {
      updated.title = requireTitle(changes.title);
      // Naming a task Lunatask couldn't name for us: it's a real title now.
      if (updated.mirror?.placeholderTitle && updated.title !== task.title) {
        updated.mirror = { ...updated.mirror, placeholderTitle: false };
      }
    }
    if (changes.notes !== undefined) updated.notes = requireTextOrEmpty(changes.notes, 'notes');
    if (changes.source !== undefined) {
      if (!isSource(changes.source)) throw new ValidationError(`Unknown source: ${String(changes.source)}`);
      updated.origin.source = changes.source;
    }
    if (changes.url !== undefined) updated.origin.url = cleanUrl(changes.url);
    if (changes.important !== undefined) updated.important = requireTriState(changes.important, 'important');
    if (changes.urgent !== undefined) updated.urgent = requireTriState(changes.urgent, 'urgent');
    if (changes.dueDate !== undefined) updated.dueDate = requireDateOrNull(changes.dueDate, 'dueDate');
    if (changes.scheduledDate !== undefined) {
      updated.scheduledDate = requireDateOrNull(changes.scheduledDate, 'scheduledDate');
      // Unscheduling the day unschedules the time on it.
      if (updated.scheduledDate === null) updated.slot = null;
    }
    if (changes.slot !== undefined) updated.slot = requireSlotOrNull(changes.slot);
    requireSlotHasDay(updated);

    updated.updatedAt = this.now().toISOString();
    // Any edit you make counts as paying it attention (5.1).
    updated.reviewedAt = updated.updatedAt;
    await this.store.save(updated);
    return updated;
  }

  /**
   * 5.2: "Still relevant" — you've looked at it and it stays as it is.
   * Resets the idle clock without changing anything else.
   */
  async keep(id: string): Promise<PrioritisedTask> {
    const task = await this.get(id);
    if (task.status !== 'open') throw new ValidationError(`Task is already ${task.status}`);
    const timestamp = this.now().toISOString();
    const kept: Task = { ...task, reviewedAt: timestamp, updatedAt: timestamp };
    await this.store.save(kept);
    return { ...kept, priority: prioritise(kept, this.today(), this.settings) };
  }

  /** 5.2: undo for "Still relevant" — put the old attention date back. */
  async setReviewedAt(id: string, reviewedAt: string | null): Promise<Task> {
    const task = await this.get(id);
    if (reviewedAt !== null && (typeof reviewedAt !== 'string' || Number.isNaN(Date.parse(reviewedAt)))) {
      throw new ValidationError('reviewedAt must be a timestamp');
    }
    const next: Task = { ...task, updatedAt: this.now().toISOString() };
    if (reviewedAt === null) delete next.reviewedAt;
    else next.reviewedAt = reviewedAt;
    await this.store.save(next);
    return next;
  }

  // ---- Bringing tasks in from elsewhere (Phase 3) ---------------------------

  /**
   * Add several captured tasks at once — a block pasted from a Claude or
   * Gemini conversation, or a file from the inbox folder (3.2, 3.3).
   *
   * Unlike typing one task, a block may well be pasted twice, so a line is
   * skipped when a task with the same source, link and title is already
   * here — open or closed, so finished tasks don't come back either.
   */
  async captureMany(lines: CaptureResult[]): Promise<CaptureManyResult> {
    const existing = await this.store.all();
    const keys = new Set(existing.map((t) => captureKey(t.origin.source, t.origin.url, t.title)));
    const created: Task[] = [];
    let skipped = 0;

    for (const line of lines) {
      const key = captureKey(line.source, line.url, line.title);
      if (keys.has(key)) {
        skipped++;
        continue;
      }
      keys.add(key); // also catches the same line twice in one block
      created.push(await this.create(line));
    }
    return { created, skipped };
  }

  /**
   * Bring this app in step with what a source system says (3.1, 3.4). The
   * rules are in src/sync.ts; this just loads, plans and saves.
   *
   * Like merge, this reads then writes in two steps; an edit landing in
   * between could be overwritten. With one person using one app that's a
   * window of milliseconds, so it's accepted rather than engineered around.
   */
  async applySync(source: Source, items: SourceItem[], options: SyncOptions): Promise<SyncReport> {
    const plan = planSync(await this.store.all(), source, items, options, this.now().toISOString(), randomUUID);
    if (plan.changed.length > 0) await this.store.saveMany(plan.changed);
    return plan.report;
  }

  // ---- Prioritising (2.3) --------------------------------------------------

  /**
   * Move a task to a quadrant (or back to "not placed yet") by setting its
   * important/urgent answers in one go.
   *
   * The due-date rule still applies afterwards: put a task that's due tomorrow
   * into "Schedule" and it will still show in "Do now". The answer you gave is
   * saved, so it takes effect once the due date moves or is cleared. The
   * returned priority lets the UI explain when that happens.
   */
  async place(id: string, placement: unknown): Promise<PrioritisedTask> {
    if (!isPlacement(placement)) throw new ValidationError(`Unknown quadrant: ${String(placement)}`);
    const task = await this.update(id, flagsFor(placement));
    return { ...task, priority: prioritise(task, this.today(), this.settings) };
  }

  /** The same as `get`, with the task's current priority attached. */
  async getPrioritised(id: string): Promise<PrioritisedTask> {
    const task = await this.get(id);
    return { ...task, priority: prioritise(task, this.today(), this.settings) };
  }

  // ---- Closing and reopening (1.4) ----------------------------------------

  complete(id: string): Promise<Task> {
    return this.close(id, 'done');
  }

  drop(id: string): Promise<Task> {
    return this.close(id, 'dropped');
  }

  /** Put a done, dropped or merged task back on the list. Reopening a merged
   *  task undoes the merge, including removing its sources from the survivor. */
  async reopen(id: string): Promise<Task> {
    const task = await this.get(id);
    if (task.status === 'open') return task;
    const timestamp = this.now().toISOString();
    const changed: Task[] = [];

    if (task.status === 'merged' && task.mergedInto) {
      const survivor = await this.store.get(task.mergedInto);
      if (survivor) {
        changed.push({
          ...survivor,
          alsoIn: removeOnce(survivor.alsoIn, [task.origin, ...task.alsoIn]),
          updatedAt: timestamp,
        });
      }
    }

    changed.push({ ...task, status: 'open', mergedInto: null, closedAt: null, updatedAt: timestamp, reviewedAt: timestamp });
    await this.store.saveMany(changed);
    return changed[changed.length - 1];
  }

  private async close(id: string, status: 'done' | 'dropped'): Promise<Task> {
    const task = await this.get(id);
    if (task.status !== 'open') throw new ValidationError(`Task is already ${task.status}`);
    const timestamp = this.now().toISOString();
    const updated: Task = { ...task, status, closedAt: timestamp, updatedAt: timestamp };
    await this.store.save(updated);
    return updated;
  }

  // ---- Duplicates (1.5) ----------------------------------------------------

  /**
   * Fold `duplicateId` into `keepId`. The kept task gains the duplicate's
   * sources (so you still see every system it lives in); the duplicate is
   * marked "merged" and leaves the list. Nothing else is copied across — the
   * duplicate stays readable in the closed list if its notes mattered.
   */
  async merge(duplicateId: string, keepId: string): Promise<{ kept: Task; merged: Task }> {
    if (duplicateId === keepId) throw new ValidationError('A task cannot be merged into itself');
    const duplicate = await this.get(duplicateId);
    const keep = await this.get(keepId);
    if (duplicate.status !== 'open' || keep.status !== 'open') {
      throw new ValidationError('Only open tasks can be merged');
    }
    const timestamp = this.now().toISOString();

    const kept: Task = {
      ...keep,
      alsoIn: [...keep.alsoIn, duplicate.origin, ...duplicate.alsoIn],
      updatedAt: timestamp,
    };
    const merged: Task = {
      ...duplicate,
      status: 'merged',
      mergedInto: keep.id,
      closedAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.saveMany([kept, merged]);
    return { kept, merged };
  }

  /** Record that two tasks are genuinely different, so they stop being suggested. */
  async markNotDuplicate(idA: string, idB: string): Promise<void> {
    if (idA === idB) throw new ValidationError('Pick two different tasks');
    const a = await this.get(idA);
    const b = await this.get(idB);
    const timestamp = this.now().toISOString();
    await this.store.saveMany([
      { ...a, notDuplicateOf: addOnce(a.notDuplicateOf, b.id), updatedAt: timestamp },
      { ...b, notDuplicateOf: addOnce(b.notDuplicateOf, a.id), updatedAt: timestamp },
    ]);
  }
}

// ---- Small helpers -----------------------------------------------------------

function isPlacement(value: unknown): value is Placement {
  return typeof value === 'string' && Object.hasOwn(QUADRANT_FLAGS, value);
}

function flagsFor(placement: Placement): { important: boolean | null; urgent: boolean | null } {
  if (!isPlacement(placement)) throw new ValidationError(`Unknown quadrant: ${String(placement)}`);
  return { ...QUADRANT_FLAGS[placement] };
}

function requireTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!title) throw new ValidationError('A task needs a title');
  return title;
}

function cleanUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const url = String(value).trim();
  if (!url) return null;
  // Only web links and Lunatask's own links: this URL ends up as a clickable
  // link in the page, and a "javascript:" link would run code when clicked.
  if (/^https?:\/\//i.test(url)) return url;
  if (/^lunatask:\/\/[\w/-]+$/i.test(url)) return url;
  throw new ValidationError('Source links must start with http://, https:// or lunatask://');
}

/** Q9: free text, or nothing. Anything else is a mistake, not an empty note. */
function requireTextOrEmpty(value: unknown, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`);
  return value.trim();
}

function requireTextOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`);
  return value;
}

function requireTriState(value: unknown, field: string): boolean | null {
  if (value === true || value === false || value === null) return value;
  throw new ValidationError(`${field} must be true, false or null`);
}

/** A slot from untrusted input: {start: "HH:MM", minutes?}, or null. Must
 *  finish by midnight — a task running into tomorrow is two tasks. */
function requireSlotOrNull(value: unknown): Slot | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('slot must be {start, minutes} or null');
  const { start, minutes = DEFAULT_SLOT_MINUTES } = value as Record<string, unknown>;
  if (!isTimeString(start)) throw new ValidationError('slot.start must be a time like 09:30');
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 5 || minutes > 24 * 60) {
    throw new ValidationError('slot.minutes must be a whole number from 5 to 1440');
  }
  if (minutesOf(start) + minutes > 24 * 60) throw new ValidationError('A slot has to finish by midnight');
  return { start, minutes };
}

function requireSlotHasDay(task: Task): void {
  if (task.slot && !task.scheduledDate) throw new ValidationError('Give it a scheduled day before a time');
}

function requireDateOrNull(value: unknown, field: string): string | null {
  if (value === null || value === '') return null;
  if (isDateString(value)) return value;
  throw new ValidationError(`${field} must be a YYYY-MM-DD date`);
}

/** Two captured tasks count as the same if source, link and title match
 *  (ignoring case and spacing in the title). */
function captureKey(source: Source, url: string | null, title: string): string {
  return JSON.stringify([source, url ?? '', title.replace(/\s+/g, ' ').trim().toLowerCase()]);
}

function addOnce(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id];
}

function sameRef(a: SourceRef, b: SourceRef): boolean {
  return a.source === b.source && a.externalId === b.externalId && a.url === b.url;
}

/** Remove one matching entry from `list` for each item in `toRemove`. */
function removeOnce(list: SourceRef[], toRemove: SourceRef[]): SourceRef[] {
  const result = [...list];
  for (const ref of toRemove) {
    const index = result.findIndex((r) => sameRef(r, ref));
    if (index !== -1) result.splice(index, 1);
  }
  return result;
}
