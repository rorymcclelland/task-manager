// Lunatask (backlog 3.1). See docs/DECISIONS.md, D7.
//
// Reads every task from Lunatask's API and describes each as a SourceItem.
// What the API gives us, and what it doesn't:
//
//   ✓ id, status, Eisenhower quadrant, priority, motivation, scheduled date
//   ✗ name and note — Lunatask encrypts these on your device, so its servers
//     (and therefore its API) can't read them
//
// So Lunatask tasks arrive here as "Unnamed Lunatask task", with what
// Lunatask does know shown underneath and a link that opens the task in the
// Lunatask app. You name each one here once; syncs never touch the name.
//
// Read-only: this file only ever sends GET requests. Nothing here changes
// anything in Lunatask.
//
// API reference: https://lunatask.app/api/overview

import type { SourceItem } from '../sync.ts';

const API = 'https://api.lunatask.app/v1';

/** The fields we use from Lunatask's task object. */
interface LunataskTask {
  id: string;
  status: 'later' | 'next' | 'started' | 'waiting' | 'completed';
  priority?: number;
  motivation?: 'must' | 'should' | 'want' | 'unknown';
  eisenhower?: number;
  scheduled_on?: string | null;
  completed_at?: string | null;
}

const STATUS_WORDS: Record<string, string> = {
  later: 'later',
  next: 'next',
  started: 'in progress',
  waiting: 'waiting',
  completed: 'completed',
};

const PRIORITY_WORDS: Record<number, string> = {
  2: 'highest priority',
  1: 'high priority',
  [-1]: 'low priority',
  [-2]: 'lowest priority',
};

/** Lunatask's Eisenhower numbers → this app's two answers. 0 = not set. */
const EISENHOWER: Record<number, { important: boolean; urgent: boolean }> = {
  1: { important: true, urgent: true },
  2: { important: false, urgent: true },
  3: { important: true, urgent: false },
  4: { important: false, urgent: false },
};

export class LunataskError extends Error {}

export interface LunataskResult {
  items: SourceItem[];
  /** False if the answer looked like only part of the list. */
  complete: boolean;
}

/**
 * Fetch every Lunatask task. `fetchFn` is swappable so tests don't need the
 * real API.
 */
export async function fetchLunataskItems(token: string, fetchFn: typeof fetch = fetch): Promise<LunataskResult> {
  let response: Response;
  try {
    response = await fetchFn(`${API}/tasks`, {
      headers: { Authorization: `bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new LunataskError(`Couldn't reach Lunatask (${(error as Error).message}). Are you online?`);
  }

  if (response.status === 401) {
    throw new LunataskError('Lunatask rejected the access token. Make a new one in Lunatask → Settings → Access tokens and put it in .env.');
  }
  if (response.status === 503) throw new LunataskError('Lunatask is down for maintenance; will try again at the next sync.');
  if (!response.ok) throw new LunataskError(`Lunatask answered ${response.status} ${response.statusText}.`);

  const body = (await response.json()) as { tasks?: LunataskTask[] } & Record<string, unknown>;
  if (!Array.isArray(body.tasks)) throw new LunataskError('Lunatask sent something unexpected (no task list).');

  // Lunatask's docs don't mention paging, so we expect the whole list in one
  // go. If the answer ever carries anything that looks like "there's more",
  // say the list may be partial — the sync then won't treat missing tasks
  // as deleted, so a change on Lunatask's side can't wipe out half the list.
  const complete = !Object.keys(body).some((key) => /next|page|cursor|links|more/i.test(key));
  return { items: body.tasks.map(toItem), complete };
}

export function toItem(task: LunataskTask): SourceItem {
  const open = task.status !== 'completed' && !task.completed_at;
  const flags = EISENHOWER[task.eisenhower ?? 0];
  return {
    externalId: task.id,
    title: null, // encrypted — see the top of this file
    // Lunatask's own link format; opens the task in the desktop app.
    url: `lunatask://tasks/${task.id}`,
    open,
    detail: describe(task),
    important: flags?.important ?? null,
    urgent: flags?.urgent ?? null,
    scheduledDate: task.scheduled_on ?? null,
  };
}

/** e.g. "Lunatask: next · high priority · must · scheduled 2026-10-16" */
function describe(task: LunataskTask): string {
  const parts = [STATUS_WORDS[task.status] ?? task.status];
  const priority = PRIORITY_WORDS[task.priority ?? 0];
  if (priority) parts.push(priority);
  if (task.motivation && task.motivation !== 'unknown') parts.push(task.motivation);
  if (task.scheduled_on) parts.push(`scheduled ${task.scheduled_on}`);
  return `Lunatask: ${parts.join(' · ')}`;
}
