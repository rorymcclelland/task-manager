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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Task } from '../model.ts';
import type { TaskStore } from './task-store.ts';

/** What's actually on disk. `version` lets future code migrate old files. */
interface FileContents {
  version: 1;
  tasks: Task[];
}

export class JsonFileStore implements TaskStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
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
      const contents = await this.read();
      for (const task of changed) {
        const index = contents.tasks.findIndex((t) => t.id === task.id);
        if (index === -1) contents.tasks.push(task);
        else contents.tasks[index] = task;
      }
      await this.write(contents);
    });
  }

  /** Chain `work` onto the queue so it only starts after everything before it has finished. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    // Keep the queue moving even if this piece of work fails.
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async read(): Promise<FileContents> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      // No file yet just means no tasks yet.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tasks: [] };
      throw error;
    }
    const parsed = JSON.parse(text) as FileContents;
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
      throw new Error(`${this.filePath} is not a task file this version of the app understands`);
    }
    return parsed;
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
