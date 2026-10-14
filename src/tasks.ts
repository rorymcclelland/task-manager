// Everything you can do to a task, in one place.
//
// The HTTP layer (app.ts) only translates requests into calls on TaskService;
// all the rules — what's allowed, what changes, what gets timestamped — live
// here, where they can be tested without a server.

import { randomUUID } from 'node:crypto';
import { findDuplicatePairs, type DuplicatePair } from './duplicates.ts';
import { isDateString, isSource, type Source, type SourceRef, type Task } from './model.ts';
import type { TaskStore } from './store/task-store.ts';

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
}

export class TaskService {
  private readonly store: TaskStore;
  private readonly now: () => Date;

  /** `now` is swappable so tests can control time. */
  constructor(store: TaskStore, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
  }

  // ---- Reading ----------------------------------------------------------

  /** Open tasks, newest first. (1.1: everything in one list.) */
  async listOpen(): Promise<Task[]> {
    const tasks = (await this.store.all()).filter((t) => t.status === 'open');
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Done, dropped and merged tasks, most recently closed first. */
  async listClosed(): Promise<Task[]> {
    const tasks = (await this.store.all()).filter((t) => t.status !== 'open');
    return tasks.sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  }

  async get(id: string): Promise<Task> {
    const task = await this.store.get(id);
    if (!task) throw new NotFoundError(`No task with id ${id}`);
    return task;
  }

  async duplicates(): Promise<DuplicatePair[]> {
    return findDuplicatePairs(await this.store.all());
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
      notes: typeof input.notes === 'string' ? input.notes.trim() : '',
      origin: { source, externalId: input.externalId ?? null, url: cleanUrl(input.url) },
      alsoIn: [],
      important: null,
      urgent: null,
      dueDate: null,
      scheduledDate: null,
      status: 'open',
      mergedInto: null,
      notDuplicateOf: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
    };
    await this.store.save(task);
    return task;
  }

  async update(id: string, changes: TaskChanges): Promise<Task> {
    const task = await this.get(id);
    const updated: Task = { ...task, origin: { ...task.origin } };

    if (changes.title !== undefined) updated.title = requireTitle(changes.title);
    if (changes.notes !== undefined) updated.notes = String(changes.notes).trim();
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
    }

    updated.updatedAt = this.now().toISOString();
    await this.store.save(updated);
    return updated;
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

    changed.push({ ...task, status: 'open', mergedInto: null, closedAt: null, updatedAt: timestamp });
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

function requireTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!title) throw new ValidationError('A task needs a title');
  return title;
}

function cleanUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const url = String(value).trim();
  if (!url) return null;
  // Only web links: this URL ends up as a clickable link in the page, and a
  // "javascript:" link would run code when clicked.
  if (!/^https?:\/\//i.test(url)) throw new ValidationError('Source links must start with http:// or https://');
  return url;
}

function requireTriState(value: unknown, field: string): boolean | null {
  if (value === true || value === false || value === null) return value;
  throw new ValidationError(`${field} must be true, false or null`);
}

function requireDateOrNull(value: unknown, field: string): string | null {
  if (value === null || value === '') return null;
  if (isDateString(value)) return value;
  throw new ValidationError(`${field} must be a YYYY-MM-DD date`);
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
