// The storage interface (backlog item 0.4).
//
// The rest of the app only ever talks to a TaskStore. Today the only
// implementation is JsonFileStore; if we later move to SQLite or a hosted
// database, we write a new class with these same four methods and nothing
// else in the app has to change.

import type { Task } from '../model.ts';

export interface TaskStore {
  /** Every task, in no particular order. */
  all(): Promise<Task[]>;
  /** One task, or undefined if the id doesn't exist. */
  get(id: string): Promise<Task | undefined>;
  /** Insert or replace a task (matched by id). */
  save(task: Task): Promise<void>;
  /** Insert or replace several tasks as one write — used by merge, which
   *  changes two tasks and must not leave the file half-updated. */
  saveMany(tasks: Task[]): Promise<void>;
  /** Optional (Q5): things about the stored data worth showing, such as
   *  entries that couldn't be used. Empty when all is well. */
  problems?(): string[];
}
