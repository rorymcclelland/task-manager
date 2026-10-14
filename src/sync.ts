// Keeping mirrored tasks in step with the system they came from (Phase 3).
// See docs/DECISIONS.md, D8.
//
// Each source connector (src/sources/) turns what it finds into a list of
// `SourceItem`s. `planSync` compares that list with the tasks already here
// and works out what to create, update and close. It's a pure function —
// no clock, no storage, no network — so every rule below can be tested with
// made-up data. TaskService.applySync saves the result.
//
// The rules, in short:
//
// - Matching is by the other system's own ID (`origin.externalId`), never by
//   title. Renaming a task here doesn't break the link.
// - New items are only imported while open. A sync never fills the list with
//   things that were finished before this app saw them.
// - What the other system says about scheduling is copied over each time.
//   Its Eisenhower answers are only used while you haven't placed the task
//   here — once you have, your answer wins.
// - A task is closed here when the other system closes it (or it disappears
//   from there) — but only on the change. If you reopen it here, the next
//   sync leaves it open. Nothing is ever reopened by a sync.
// - Title and notes are never overwritten: either the source can't tell us
//   (Lunatask) or the ID already depends on the text (local files).
// - A task is only written when something actually changed, so the JSON file
//   in your sync folder isn't rewritten every few minutes for nothing.

import type { MirrorInfo, Source, Task } from './model.ts';

/** One task as another system describes it. */
export interface SourceItem {
  /** That system's own ID for it. Must be stable between syncs. */
  externalId: string;
  /** Null when the source can't tell us (Lunatask's names are encrypted). */
  title: string | null;
  url: string | null;
  /** False when the source says it's finished. */
  open: boolean;
  /** What the source says about it, in words, shown under the task. */
  detail: string;
  /** The source's own Eisenhower answers, if it has them. */
  important?: boolean | null;
  urgent?: boolean | null;
  /** Leave undefined if the source has no idea about scheduling. */
  scheduledDate?: string | null;
}

export interface SyncOptions {
  /** What to call it when something disappears from the source entirely. */
  whenGone: 'done' | 'dropped';
  /**
   * Whether the source looked in the place this item would be. A task is
   * only treated as "gone" when this says yes — so a file that couldn't be
   * read doesn't make all its tasks vanish. Defaults to "yes, everywhere".
   */
  covered?: (externalId: string) => boolean;
}

export interface SyncReport {
  created: number;
  updated: number;
  /** Titles of tasks closed because the source closed them. */
  closed: string[];
}

export interface SyncPlan {
  /** Every task that needs saving: new ones and changed ones. */
  changed: Task[];
  report: SyncReport;
}

const SOURCE_NAMES: Record<Source, string> = {
  manual: 'manual',
  claude: 'Claude',
  gemini: 'Gemini',
  lunatask: 'Lunatask',
  local: 'local',
};

export function placeholderTitle(source: Source): string {
  return `Unnamed ${SOURCE_NAMES[source]} task`;
}

/**
 * Work out what a sync from `source` should change.
 * `now` is an ISO timestamp; `newId` makes ids for new tasks.
 */
export function planSync(
  tasks: Task[],
  source: Source,
  items: SourceItem[],
  options: SyncOptions,
  now: string,
  newId: () => string,
): SyncPlan {
  const report: SyncReport = { created: 0, updated: 0, closed: [] };
  const changed: Task[] = [];
  const covered = options.covered ?? (() => true);

  // The tasks this source has given us before, by their ID over there.
  const known = new Map<string, Task>();
  for (const task of tasks) {
    if (task.origin.source === source && task.origin.externalId) known.set(task.origin.externalId, task);
  }

  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.externalId)) continue; // the source listed it twice; first wins
    seen.add(item.externalId);

    const existing = known.get(item.externalId);
    if (!existing) {
      if (!item.open) continue; // don't import history
      changed.push(newTask(source, item, now, newId()));
      report.created++;
      continue;
    }

    const next = updatedTask(existing, item, now);
    if (next === existing) continue;
    if (next.status !== existing.status) report.closed.push(next.title);
    else report.updated++;
    changed.push(next);
  }

  // Anything we were mirroring that the source no longer lists at all.
  for (const [externalId, task] of known) {
    if (seen.has(externalId) || !covered(externalId)) continue;
    if (!task.mirror?.openInSource) continue; // already knew it was gone
    const next = closeIfOpen(
      { ...task, mirror: { ...task.mirror, openInSource: false, detail: `No longer in ${SOURCE_NAMES[source]}` } },
      options.whenGone,
      now,
    );
    if (next.status !== task.status) report.closed.push(next.title);
    else report.updated++;
    changed.push(next);
  }

  return { changed, report };
}

function newTask(source: Source, item: SourceItem, now: string, id: string): Task {
  return {
    id,
    title: item.title ?? placeholderTitle(source),
    notes: '',
    origin: { source, externalId: item.externalId, url: item.url },
    alsoIn: [],
    important: item.important ?? null,
    urgent: item.urgent ?? null,
    dueDate: null,
    scheduledDate: item.scheduledDate ?? null,
    status: 'open',
    mergedInto: null,
    notDuplicateOf: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    mirror: { detail: item.detail, openInSource: true, placeholderTitle: item.title === null },
  };
}

/** The task with the source's latest news applied — or the very same object
 *  if nothing changed, so the caller knows not to save it. */
function updatedTask(task: Task, item: SourceItem, now: string): Task {
  const wasOpenInSource = task.mirror?.openInSource ?? true;
  const mirror: MirrorInfo = {
    detail: item.detail,
    openInSource: item.open,
    placeholderTitle: task.mirror?.placeholderTitle ?? false,
  };
  let next: Task = { ...task, origin: { ...task.origin }, mirror };
  let differs = !sameMirror(task.mirror, mirror);

  if (item.url !== task.origin.url) {
    next.origin.url = item.url;
    differs = true;
  }
  if (item.scheduledDate !== undefined && item.scheduledDate !== task.scheduledDate) {
    next.scheduledDate = item.scheduledDate;
    differs = true;
  }
  // The source's Eisenhower answers only fill a gap; they never overrule you.
  if (task.important === null && task.urgent === null && (item.important != null || item.urgent != null)) {
    next.important = item.important ?? null;
    next.urgent = item.urgent ?? null;
    differs = true;
  }
  // Closed over there since we last looked → close it here (once).
  if (wasOpenInSource && !item.open) {
    next = closeIfOpen(next, 'done', now);
    differs = true;
  }

  if (!differs) return task;
  return { ...next, updatedAt: now };
}

function closeIfOpen(task: Task, status: 'done' | 'dropped', now: string): Task {
  if (task.status !== 'open') return { ...task, updatedAt: now };
  return { ...task, status, closedAt: now, updatedAt: now };
}

function sameMirror(a: MirrorInfo | undefined, b: MirrorInfo): boolean {
  return !!a && a.detail === b.detail && a.openInSource === b.openInSource && a.placeholderTitle === b.placeholderTitle;
}
