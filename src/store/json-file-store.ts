// A TaskStore that keeps every task in one human-readable JSON file.
//
// Design choices, and why:
//
// - Re-read the file on every operation instead of caching it in memory.
//   The file lives in a sync folder, so another machine (or you, in a text
//   editor) may change it while the app is running. With a few hundred tasks
//   the file is tiny and reading it costs nothing noticeable.
//
// - Write to a temporary file, then rename it over the real one. A rename is
//   all-or-nothing, so a crash or power cut mid-write leaves either the old
//   file or the new one — never a half-written file. That matters even more
//   with a sync tool watching the folder.
//
// - Run operations one at a time (the `queue` below). Two requests arriving
//   together could otherwise both read the old file and the second write would
//   silently undo the first.
//
// - Phase 6 (D18): be forgiving about what's *in* the file, never about
//   losing it. A byte-order mark is ignored (Q3). A file that can't be read
//   at all stops everything with a plain message and is never overwritten.
//   A task with missing fields is repaired with defaults; an entry that
//   isn't a task at all (no id or title) is set aside — kept in the file
//   exactly as it was, reported, and left out of the app (Q5).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDateString, isSource, isStatus, isTimeString, type SourceRef, type Task } from '../model.ts';
import type { TaskStore } from './task-store.ts';

/** What's on disk. `version` lets future code migrate old files. */
interface FileContents {
  version: 1;
  tasks: unknown[];
}

/** The file couldn't be read, so nothing can be read or saved until it's fixed. */
export class StoreReadError extends Error {
  readonly file: string;
  constructor(file: string, problem: string) {
    super(`Your task file can't be read: ${problem}. Nothing has been changed — the app won't write to it until it reads again. File: ${file}`);
    this.file = file;
  }
}

export class JsonFileStore implements TaskStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  /** Entries set aside at the last read, described for the page. */
  private setAside: string[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get file(): string {
    return this.filePath;
  }

  all(): Promise<Task[]> {
    return this.exclusive(async () => (await this.read()).tasks);
  }

  get(id: string): Promise<Task | undefined> {
    return this.exclusive(async () => (await this.read()).tasks.find((t) => t.id === id));
  }

  save(task: Task): Promise<void> {
    return this.saveMany([task]);
  }

  saveMany(changed: Task[]): Promise<void> {
    return this.exclusive(async () => {
      const { tasks, invalid } = await this.read();
      for (const task of changed) {
        const index = tasks.findIndex((t) => t.id === task.id);
        if (index === -1) tasks.push(task);
        else tasks[index] = task;
      }
      // Set-aside entries go back in untouched: the app never deletes
      // anything it doesn't understand.
      await this.write({ version: 1, tasks: [...tasks, ...invalid] });
    });
  }

  /** Q5: entries in the file that aren't usable tasks, as of the last read. */
  problems(): string[] {
    return [...this.setAside];
  }

  /** Chain `work` onto the queue so it only starts after everything before it has finished. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    // Keep the queue moving even if this piece of work fails.
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async read(): Promise<{ tasks: Task[]; invalid: unknown[] }> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      // No file yet just means no tasks yet.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.setAside = [];
        return { tasks: [], invalid: [] };
      }
      throw new StoreReadError(this.filePath, `it couldn't be opened (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }

    // Q3: older Notepad (and some sync tools) put a byte-order mark first.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    let parsed: FileContents;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new StoreReadError(this.filePath, `it isn't valid JSON (${(error as Error).message}) — it may be half-synced or hand-edited`);
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.tasks)) {
      throw new StoreReadError(this.filePath, 'it has no task list in it');
    }
    if (parsed.version !== 1) {
      throw new StoreReadError(this.filePath, `it says it's version ${JSON.stringify(parsed.version)}, and this app reads version 1 — a newer copy of the app may have written it`);
    }

    const tasks: Task[] = [];
    const invalid: unknown[] = [];
    const notes: string[] = [];
    const now = new Date().toISOString();
    parsed.tasks.forEach((entry, index) => {
      const task = repairTask(entry, now);
      if (task) tasks.push(task);
      else {
        invalid.push(entry);
        notes.push(`Entry ${index + 1} in tasks.json isn't a task the app can use (it needs an "id" and a "title"), so it's being ignored. It hasn't been deleted.`);
      }
    });
    this.setAside = notes;
    return { tasks, invalid };
  }

  private async write(contents: FileContents): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    // Pretty-printed so the file is readable and sync/diff tools show small changes.
    await writeFile(tempPath, JSON.stringify(contents, null, 2) + '\n', 'utf8');
    await renameWithRetry(tempPath, this.filePath);
  }
}

/**
 * Q5: turn one entry from the file into a usable task, filling in anything
 * missing or malformed with the value a new task would have. Returns null
 * if it can't be a task at all (no id or no title). A repaired task isn't
 * written back until something about it changes.
 */
export function repairTask(entry: unknown, now: string): Task | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const e = entry as Record<string, any>;
  if (typeof e.id !== 'string' || !e.id) return null;
  if (typeof e.title !== 'string' || !e.title.trim()) return null;

  const ref = (value: any): SourceRef | null =>
    value && typeof value === 'object' && isSource(value.source)
      ? { source: value.source, externalId: typeof value.externalId === 'string' ? value.externalId : null, url: typeof value.url === 'string' ? value.url : null }
      : null;
  const triState = (value: unknown) => (value === true || value === false ? value : null);
  const date = (value: unknown) => (isDateString(value) ? value : null);
  const stamp = (value: unknown, fallback: string) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback);

  const createdAt = stamp(e.createdAt, now);
  const status = isStatus(e.status) ? e.status : 'open';
  const scheduledDate = date(e.scheduledDate);
  const slot =
    scheduledDate && e.slot && isTimeString(e.slot.start) && Number.isInteger(e.slot.minutes) && e.slot.minutes >= 5
      ? { start: e.slot.start, minutes: e.slot.minutes }
      : null;

  const task: Task = {
    ...e, // keep anything we don't know about (e.g. `mirror`) as it was
    id: e.id,
    title: e.title,
    notes: typeof e.notes === 'string' ? e.notes : '',
    origin: ref(e.origin) ?? { source: 'manual', externalId: null, url: null },
    alsoIn: Array.isArray(e.alsoIn) ? e.alsoIn.map(ref).filter((r: SourceRef | null): r is SourceRef => r !== null) : [],
    important: triState(e.important),
    urgent: triState(e.urgent),
    dueDate: date(e.dueDate),
    scheduledDate,
    slot,
    status,
    mergedInto: typeof e.mergedInto === 'string' ? e.mergedInto : null,
    notDuplicateOf: Array.isArray(e.notDuplicateOf) ? e.notDuplicateOf.filter((id: unknown) => typeof id === 'string') : [],
    createdAt,
    updatedAt: stamp(e.updatedAt, createdAt),
    closedAt: status === 'open' ? null : stamp(e.closedAt, stamp(e.updatedAt, createdAt)),
  };
  if (e.reviewedAt !== undefined && typeof e.reviewedAt !== 'string') delete task.reviewedAt;
  if (e.mirror !== undefined && (typeof e.mirror !== 'object' || e.mirror === null)) delete task.mirror;
  return task;
}

/**
 * On Windows, replacing a file fails with EPERM/EBUSY if another program
 * (a sync client, antivirus) has it open for a moment. Retry briefly rather
 * than lose the write.
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}
