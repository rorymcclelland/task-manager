// Sprint 1, L0: the Lunatask spike.
//
//   npm run probe:lunatask                 run the probe
//   npm run probe:lunatask -- --cleanup    delete every probe task it has made
//
// Lunatask's API documentation doesn't say what a status change does to the
// rest of a task, in particular whether it can blank the task's name. Names
// are end-to-end encrypted, so the API can't read them; only a person looking
// in Lunatask can. So the probe does everything the API can answer by itself,
// then leaves one hand check for Rory, written as a test pack:
//
//   Task A  "Task app probe A, delete me"  created, then left alone
//   Task B  "Task app probe B, delete me"  created, completed, then reopened,
//                                          sending only the status each time
//
// Once Lunatask has synced (run 1 on 28 Oct 2026 showed that can take a
// while), one look answers it: if both show their names, status changes
// leave names alone; if only A does, they don't.
//
// What the run does, stopping at the first unexpected answer:
//   1. Lists your Lunatask tasks: IDs and statuses only, saved so the export
//      check can match against them. No task text is read.
//   2. Picks the area holding most of your open tasks (or LUNATASK_PROBE_AREA).
//   3. Creates A and B in Next, a week out, with a priority, motivation and
//      quadrant set. Lunatask ignores some of those on create (run 1), so it
//      records which and sets them with one update.
//   4. Completes B, checking nothing else changed and that Lunatask recorded
//      when; reads B back; reopens B, checking it's back as it was.
//   5. Notes how Lunatask answers an unknown task and an invalid status.
//   6. Writes the test pack.
//
// Safety:
//   - It only ever changes tasks it created. The one other write is a single
//     update to a freshly made-up ID, to see how Lunatask answers a task that
//     doesn't exist.
//   - Clean-up deletes only the IDs the probe recorded creating, and checks
//     each one looks like a task ID first.
//   - Your token is read from .env and never printed or saved.
//   - Results go to data/lunatask-probe/ (data/ is never committed).

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.lunatask.app/v1';

export const PROBE_NAMES = {
  A: 'Task app probe A, delete me',
  B: 'Task app probe B, delete me',
} as const;

/** Everything the probe needs from the outside world, so tests can fake it. */
export interface ProbeIO {
  fetch: typeof fetch;
  /** Print one line. */
  say(line: string): void;
  /** Today as YYYY-MM-DD, for the probe tasks' scheduled date. */
  today: string;
  /** Area to create the probe tasks in, if you'd rather choose one. */
  areaId?: string;
  /** Called the moment a probe task exists, before any other request, so it
   *  is on record for clean-up even if the run is interrupted. */
  onCreated?: (task: ProbeTask) => Promise<void>;
}

export interface Finding {
  step: string;
  ok: boolean;
  detail: string;
}

/** What the API answered. `null` = that step didn't run. */
export interface Answers {
  canRead: boolean | null;
  canWrite: boolean | null;
  /** Did Lunatask keep every field the create asked for? */
  createKeepsFields: boolean | null;
  /** If not, could an update set them? (null: no update was needed) */
  updateSetsIgnoredFields: boolean | null;
  statusOnlyLeavesOtherFields: boolean | null;
  completingSetsCompletedAt: boolean | null;
  reopeningIsClean: boolean | null;
  /** Does GET /v1/tasks/<id> work? */
  singleTaskRead: boolean | null;
  /** HTTP status Lunatask gives for an update to a task that doesn't exist. */
  unknownIdAnswer: number | null;
  /** HTTP status Lunatask gives for an update with an invalid status. */
  invalidStatusAnswer: number | null;
}

/** A probe task, and where it ended up, for the test pack. */
export interface ProbeTask {
  /** 'unknown': a task Lunatask made from the update to a made-up ID. */
  label: 'A' | 'B' | 'unknown';
  id: string;
  name: string;
  status: string;
  scheduledOn: string | null;
}

export interface ProbeResult {
  answers: Answers;
  findings: Finding[];
  /** Every task Lunatask's API listed: ID and status only. */
  apiTasks: { id: string; status: string }[];
  /** Probe tasks created, in order. Kept even when the run stops, for clean-up. */
  created: ProbeTask[];
  unknownId: string | null;
  areaWords: string;
  stoppedEarly: boolean;
}

export interface CleanupResult {
  deleted: string[];
  alreadyGone: string[];
  failed: string[];
  /** Not shaped like a task ID, so never sent. */
  refused: string[];
}

/** What the probe tasks are created with. */
const REQUESTED = { status: 'next', priority: 1, motivation: 'should', eisenhower: 3 } as const;

/** The fields compared before and after a status change. */
const KEPT_FIELDS = ['area_id', 'priority', 'motivation', 'eisenhower', 'scheduled_on'] as const;

/** Lunatask's own names for its status lists. */
const LIST_NAMES: Record<string, string> = {
  later: 'Later',
  next: 'Next',
  started: 'In progress',
  waiting: 'Waiting',
  completed: 'Completed',
};

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ApiTask {
  id: string;
  status: string;
  previous_status?: string | null;
  completed_at?: string | null;
  area_id?: string;
  scheduled_on?: string | null;
  [field: string]: unknown;
}

interface Reply {
  status: number;
  body: any;
}

/** An API client that refuses a write to any task not on its allowed list,
 *  and any ID not shaped like a task ID. Exported for its tests: it is the
 *  backstop behind every other check. */
export function client(token: string, io: ProbeIO, allowedWrites: Set<string>, note: (step: string, ok: boolean, detail: string) => void) {
  /** `id` null means the task list itself: only reading it, or creating a task in it. */
  const call = async (method: string, id: string | null, body?: unknown): Promise<Reply | null> => {
    if (id === null) {
      if (method !== 'GET' && method !== 'POST') throw new Error(`Refusing to ${method} the whole task list`);
    } else {
      if (!TASK_ID.test(id)) throw new Error(`Refusing to use ${JSON.stringify(id)}: not a task ID`);
      if (method !== 'GET' && !allowedWrites.has(id)) throw new Error(`Refusing to ${method} a task this probe didn't create`);
    }
    const path = id === null ? '/tasks' : `/tasks/${encodeURIComponent(id)}`;
    try {
      const response = await io.fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text.slice(0, 200) };
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      note(`${method} ${path}`, false, `couldn't reach Lunatask (${(error as Error).message})`);
      return null;
    }
  };
  const ok = (reply: Reply | null): reply is Reply => !!reply && reply.status >= 200 && reply.status < 300;
  const why = (reply: Reply) => `Lunatask answered ${reply.status}${reply.body?.message ? ` (${reply.body.message})` : ''}`;
  return { call, ok, why };
}

function recorder(token: string, io: ProbeIO, findings: Finding[]) {
  const clean = (text: string) => (token ? text.split(token).join('***') : text);
  const note = (step: string, ok: boolean, detail: string) => {
    findings.push({ step, ok, detail: clean(detail) });
    io.say(`${ok ? '  ✓' : '  ✗'} ${step}: ${clean(detail)}`);
  };
  return { clean, note };
}

// ---- The run --------------------------------------------------------------------

export async function runProbe(token: string, io: ProbeIO): Promise<ProbeResult> {
  const answers: Answers = {
    canRead: null,
    canWrite: null,
    createKeepsFields: null,
    updateSetsIgnoredFields: null,
    statusOnlyLeavesOtherFields: null,
    completingSetsCompletedAt: null,
    reopeningIsClean: null,
    singleTaskRead: null,
    unknownIdAnswer: null,
    invalidStatusAnswer: null,
  };
  const result: ProbeResult = {
    answers,
    findings: [],
    apiTasks: [],
    created: [],
    unknownId: null,
    areaWords: '',
    stoppedEarly: false,
  };
  const { clean, note } = recorder(token, io, result.findings);
  const allowedWrites = new Set<string>();
  const { call, ok, why } = client(token, io, allowedWrites, note);
  const stop = (reason: string) => {
    result.stoppedEarly = true;
    io.say(`\nStopping here: ${clean(reason)}`);
    return result;
  };

  try {
    return await steps();
  } catch (error) {
    // Anything unexpected ends the run cleanly. Every probe task created so
    // far is already on record (onCreated), so clean-up can still find it.
    note('Unexpected error', false, (error as Error).message);
    return stop('something unexpected happened.');
  }

  async function steps(): Promise<ProbeResult> {
  // ---- 1. Read ---------------------------------------------------------------
  io.say('1. Reading your Lunatask task list (IDs and statuses only)…');
  const list = await call('GET', null);
  if (!ok(list) || !Array.isArray(list.body?.tasks)) {
    answers.canRead = false;
    if (list) {
      note('Read tasks', false, list.status === 401 ? 'Lunatask rejected the token. Make a new one in Lunatask → Settings → Access tokens.' : why(list));
    }
    return stop('the probe needs to read your tasks first.');
  }
  answers.canRead = true;
  const listed = list.body.tasks as ApiTask[];
  result.apiTasks = listed.map((t) => ({ id: String(t.id), status: String(t.status) }));
  const extraKeys = Object.keys(list.body).filter((k) => k !== 'tasks');
  note(
    'Read tasks',
    true,
    `${listed.length} task${listed.length === 1 ? '' : 's'} listed${extraKeys.length ? `; the reply also had: ${extraKeys.join(', ')}` : ', in one reply'}`,
  );

  // ---- 2. Where to put the probe tasks: where Rory will look -------------------
  // Run 1 borrowed the area of the first task listed: a completed task, in an
  // area Rory doesn't use.
  let areaId = io.areaId;
  result.areaWords = 'the area you chose (LUNATASK_PROBE_AREA)';
  if (!areaId) {
    const openByArea = new Map<string, number>();
    for (const t of listed) {
      if (t.area_id && t.status !== 'completed') openByArea.set(t.area_id, (openByArea.get(t.area_id) ?? 0) + 1);
    }
    const busiest = [...openByArea].sort((a, b) => b[1] - a[1])[0];
    if (busiest) {
      areaId = busiest[0];
      result.areaWords = `the area with the most open tasks (${busiest[1]} open)`;
    }
  }
  if (!areaId) {
    return stop(
      'none of your open tasks has an area to borrow. Set LUNATASK_PROBE_AREA in .env to an area ID (Lunatask → area settings → Copy area ID) and run again.',
    );
  }

  // ---- 3. Create A and B --------------------------------------------------------
  const requested: Record<string, unknown> = { ...REQUESTED, scheduled_on: addDays(io.today, 7) };
  const tasks: Partial<Record<'A' | 'B', ApiTask>> = {};

  for (const label of ['A', 'B'] as const) {
    io.say(`\n${label === 'A' ? 2 : 3}. Creating "${PROBE_NAMES[label]}" in ${result.areaWords}…`);
    const created = await call('POST', null, { name: PROBE_NAMES[label], area_id: areaId, ...requested });
    const byHand = `Check Lunatask for "${PROBE_NAMES[label]}" and, if it's there, delete it by hand.`;
    if (created && created.status >= 400 && created.status < 500) {
      answers.canWrite = false;
      note(`Create task ${label}`, false, `${why(created)}. The token may not be allowed to write.`);
      return stop('a task could not be created.');
    }
    if (!ok(created) || !created.body?.task?.id) {
      // No answer, a server error or a reply without a task: it may exist anyway.
      note(`Create task ${label}`, false, `${created ? why(created) : 'no answer'}; the task may have been created. ${byHand}`);
      return stop('a create gave no usable answer.');
    }
    answers.canWrite = true;
    let task = created.body.task as ApiTask;
    const id = task.id;
    // Only ever act on an ID that is new, and shaped like a task ID. A create
    // that answered with one of your existing tasks (an upsert, or a bug) must
    // not lead to that task being completed, or later deleted.
    if (typeof id !== 'string' || !TASK_ID.test(id) || result.apiTasks.some((t) => t.id === id) || allowedWrites.has(id)) {
      note(`Create task ${label}`, false, `Lunatask answered with an ID that isn't a new task ID (${JSON.stringify(id)}); nothing was sent to it. ${byHand}`);
      return stop('the create answered with an ID the probe could not trust.');
    }
    allowedWrites.add(id);
    const record: ProbeTask = { label, id, name: PROBE_NAMES[label], status: task.status, scheduledOn: task.scheduled_on ?? null };
    result.created.push(record);
    await io.onCreated?.(record);
    note(`Create task ${label}`, true, `created with status ${task.status}, ${describeFields(task)}`);

    const ignored = Object.keys(requested).filter((f) => JSON.stringify(task[f] ?? null) !== JSON.stringify(requested[f]));
    if (label === 'A') {
      answers.createKeepsFields = ignored.length === 0;
      note('Create keeps what it was sent', answers.createKeepsFields, ignored.length ? `ignored: ${ignored.join(', ')}` : 'everything kept');
    }
    if (ignored.length) {
      // Set them with an update, so B's status test starts from a task whose
      // other fields aren't all defaults (otherwise "nothing else changed"
      // would prove little), and so A and B end up in the same place.
      const updated = await call('PUT', record.id, Object.fromEntries(ignored.map((f) => [f, requested[f]])));
      const stillWrong = ok(updated) && updated.body?.task
        ? ignored.filter((f) => JSON.stringify(updated.body.task[f] ?? null) !== JSON.stringify(requested[f]))
        : ignored;
      answers.updateSetsIgnoredFields = stillWrong.length === 0 && answers.updateSetsIgnoredFields !== false;
      note(`Update sets what create ignored (${label})`, stillWrong.length === 0, stillWrong.length ? `still not set: ${stillWrong.join(', ')}` : 'all set');
      if (stillWrong.length) return stop('Lunatask would not set those fields, even with an update.');
      task = updated!.body.task as ApiTask;
      record.status = task.status;
      record.scheduledOn = task.scheduled_on ?? null;
    }
    tasks[label] = task;
  }

  // ---- 4. Complete B, then reopen it ---------------------------------------------
  const b = result.created[1];
  const original = tasks.B!;
  io.say('\n4. Completing B (sending only {"status":"completed"})…');
  const completed = await call('PUT', b.id, { status: 'completed' });
  if (!ok(completed) || !completed.body?.task) {
    note('Complete B', false, completed ? why(completed) : 'no answer');
    return stop('completing through the API failed.');
  }
  const afterComplete = completed.body.task as ApiTask;
  b.status = afterComplete.status;
  const changedOnComplete = changedFields(original, afterComplete);
  answers.statusOnlyLeavesOtherFields = afterComplete.status === 'completed' && changedOnComplete.length === 0;
  note(
    'Status-only update leaves everything else',
    answers.statusOnlyLeavesOtherFields,
    afterComplete.status !== 'completed'
      ? `status is ${afterComplete.status}, not completed`
      : changedOnComplete.length === 0 ? 'nothing else changed' : `also changed: ${changedOnComplete.join(', ')}`,
  );
  answers.completingSetsCompletedAt = !!afterComplete.completed_at;
  note(
    'Completing records when',
    answers.completingSetsCompletedAt,
    `completed_at is ${afterComplete.completed_at ?? 'empty'}; previous_status is ${afterComplete.previous_status ?? 'empty'}`,
  );
  if (!answers.statusOnlyLeavesOtherFields || !answers.completingSetsCompletedAt) {
    return stop('completing changed more (or less) than it should.');
  }

  const shown = await call('GET', b.id);
  const shownStatus = ok(shown) ? shown.body?.task?.status : null;
  answers.singleTaskRead = shownStatus === 'completed';
  note(
    'Read back a single task',
    answers.singleTaskRead,
    shownStatus ? `reads back as ${shownStatus}` : shown ? `${why(shown)} (no single-task read; not needed for L1)` : 'no answer',
  );

  const back = afterComplete.previous_status || String(REQUESTED.status);
  io.say(`\n5. Reopening B (sending only {"status":"${back}"})…`);
  const reopened = await call('PUT', b.id, { status: back });
  if (!ok(reopened) || !reopened.body?.task) {
    note('Reopen B', false, reopened ? why(reopened) : 'no answer');
    return stop('reopening through the API failed.');
  }
  const afterReopen = reopened.body.task as ApiTask;
  b.status = afterReopen.status;
  const changedOnReopen = changedFields(original, afterReopen);
  answers.reopeningIsClean = afterReopen.status === back && !afterReopen.completed_at && changedOnReopen.length === 0;
  note(
    'Reopening is clean',
    answers.reopeningIsClean,
    `status ${afterReopen.status}, completed_at ${afterReopen.completed_at ?? 'empty'}` +
      (changedOnReopen.length ? `; also changed: ${changedOnReopen.join(', ')}` : '; nothing else changed'),
  );
  if (!answers.reopeningIsClean) return stop("reopening didn't put the task back as it was.");

  // ---- 5. How Lunatask answers mistakes ----------------------------------------
  io.say('\n6. Checking how Lunatask answers mistakes…');
  result.unknownId = randomUUID();
  allowedWrites.add(result.unknownId);
  const unknown = await call('PUT', result.unknownId, { status: 'completed' });
  answers.unknownIdAnswer = unknown?.status ?? null;
  if (ok(unknown)) {
    // Lunatask made a task from it. Put it on record so clean-up removes it.
    const made: ProbeTask = { label: 'unknown', id: result.unknownId, name: '(no name: made by an update)', status: String(unknown.body?.task?.status ?? 'completed'), scheduledOn: null };
    result.created.push(made);
    await io.onCreated?.(made);
    note('Update a task that does not exist', false, `${why(unknown)}: it created a task, now on record for clean-up`);
    return stop('an update to an unknown ID created a task.');
  }
  note('Update a task that does not exist', true, unknown ? why(unknown) : 'no answer');

  const invalid = await call('PUT', b.id, { status: 'finished' });
  answers.invalidStatusAnswer = invalid?.status ?? null;
  if (ok(invalid)) {
    b.status = String(invalid.body?.task?.status ?? 'finished');
    note('Update with an invalid status', false, `${why(invalid)}: accepted, and B's status is now ${b.status}`);
    return stop('Lunatask accepted an invalid status.');
  }
  note('Update with an invalid status', true, invalid ? why(invalid) : 'no answer');

  io.say('\nDone: every API step answered. One hand check left (the test pack).');
  return result;
  }
}

// ---- Clean-up ---------------------------------------------------------------------

/** Delete the given probe tasks. Only IDs shaped like task IDs are sent, and
 *  only as DELETE. */
export async function cleanupProbe(token: string, io: ProbeIO, ids: string[]): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: [], alreadyGone: [], failed: [], refused: [] };
  const findings: Finding[] = [];
  const { note } = recorder(token, io, findings);
  const valid = ids.filter((id) => TASK_ID.test(id));
  result.refused = ids.filter((id) => !TASK_ID.test(id));
  const { call, why } = client(token, io, new Set(valid), note);

  for (const id of valid) {
    const reply: Reply | null = await call('DELETE', id);
    const status = reply?.status ?? 0;
    if (status >= 200 && status < 300) {
      result.deleted.push(id);
      note('Delete probe task', true, id);
    } else if (status === 404) {
      result.alreadyGone.push(id);
      note('Delete probe task', true, `${id} was already gone`);
    } else {
      result.failed.push(id);
      if (reply) note('Delete probe task', false, `${id}: ${why(reply)}`);
    }
  }
  for (const id of result.refused) io.say(`  ✗ Not a task ID, so not sent: ${id}`);
  return result;
}

// ---- The test pack (the one hand check) --------------------------------------------

export function testPack(result: ProbeResult, ranAt: string): string {
  const [a, b] = result.created;
  const lines = ['# Lunatask probe: hand check', '', `_Probe run: ${ranAt} · Sprint 1, L0_`, ''];

  if (result.stoppedEarly || !a || !b) {
    lines.push(
      'The probe stopped before the hand check was needed, so there is **no hand check** this time.',
      'Claude will read the findings and say what happens next.',
      '',
    );
    return lines.join('\n');
  }

  const where = (t: ProbeTask) =>
    `in **${LIST_NAMES[t.status] ?? t.status}**${t.scheduledOn ? `, scheduled **${dayWords(t.scheduledOn)}**` : ''}, in ${result.areaWords}`;
  lines.push(
    '**What it checks.** Whether changing a task\'s status through Lunatask\'s API leaves its name intact.',
    'The API can\'t read names (they are encrypted), so only a look in Lunatask can tell.',
    '',
    '**Before you start.** Wait until both tasks show in Lunatask. The sync from the API to the app can take a',
    'while: on 28 October it was long enough that the first probe task looked missing. Lunatask\'s search finds',
    'both by name.',
    '',
    '| Case | Task | Where | What happened to it | Expected |',
    '|---|---|---|---|---|',
    `| 1 | ${a.name} | ${where(a)} | Created, then left alone | Shows its name exactly |`,
    `| 2 | ${b.name} | ${where(b)} | Created, completed, then reopened, sending only the status each time | Shows its name exactly, and is not completed |`,
    '',
    '**Then tell Claude** one of:',
    '',
    '- "Both named": status changes leave names alone, so L1 (complete once) is a go.',
    '- "Only A named": status changes lose the name, so L1 needs its fallback.',
    '- Anything else you see.',
    '',
    'Claude then deletes both probe tasks. Please don\'t edit them.',
    '',
  );
  return lines.join('\n');
}

// ---- Helpers --------------------------------------------------------------------------

function changedFields(before: ApiTask, after: ApiTask): string[] {
  return KEPT_FIELDS.filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)).map(
    (field) => `${field} ${JSON.stringify(before[field] ?? null)} → ${JSON.stringify(after[field] ?? null)}`,
  );
}

function describeFields(task: ApiTask): string {
  return KEPT_FIELDS.filter((f) => f !== 'area_id').map((f) => `${f} ${JSON.stringify(task[f] ?? null)}`).join(', ');
}

/** "2026-11-12" → "Thu 12 Nov" */
function dayWords(date: string): string {
  return new Date(`${date}T00:00:00Z`)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .replace(',', '');
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---- Run from the command line ----------------------------------------------------------

export interface ProbeRecord {
  /** Probe tasks made and not yet confirmed deleted. */
  pending: { id: string; label: string; createdAt: string }[];
  /** Probe task IDs confirmed deleted (or already gone). */
  done: string[];
}

const RECORD_FILE = 'probe-tasks.json';

/** Read the record. Missing: start empty. Unreadable: stop, and leave the
 *  file alone, rather than lose track of probe tasks still to delete. */
export async function loadRecord(folder: string): Promise<ProbeRecord> {
  const file = join(folder, RECORD_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pending: [], done: [] };
    throw new Error(`Can't read ${file}: ${(error as Error).message}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} isn't valid JSON (${(error as Error).message}). Nothing was changed; fix or remove it.`);
  }
  const pending = parsed?.pending;
  if (!Array.isArray(pending) || !pending.every((p: any) => typeof p?.id === 'string')) {
    throw new Error(`${file} has no valid "pending" list. Nothing was changed; fix or remove it.`);
  }
  const done = Array.isArray(parsed.done) ? parsed.done.filter((d: unknown) => typeof d === 'string') : [];
  return { pending, done };
}

/** Write the record whole: to a temporary file, then renamed into place. */
export async function saveRecord(folder: string, record: ProbeRecord): Promise<void> {
  const file = join(folder, RECORD_FILE);
  await writeFile(`${file}.tmp`, JSON.stringify(record, null, 2) + '\n');
  await rename(`${file}.tmp`, file);
}

/** Run 1 (28 Oct 2026) recorded its task in findings.json. Bring it in, once. */
export function mergeRun1(record: ProbeRecord, run1: any): ProbeRecord {
  const id = run1?.createdId;
  if (typeof id !== 'string' || run1.answers?.deleted === true) return record;
  if (record.pending.some((p) => p.id === id) || record.done.includes(id)) return record;
  return { ...record, pending: [...record.pending, { id, label: 'run 1', createdAt: String(run1.ranAt) }] };
}

/** After clean-up: deleted and already-gone IDs are done; failed and refused
 *  ones stay on record (refused ones are reported each time). */
export function applyCleanup(record: ProbeRecord, result: CleanupResult): ProbeRecord {
  const finished = new Set([...result.deleted, ...result.alreadyGone]);
  return {
    pending: record.pending.filter((p) => !finished.has(p.id)),
    done: [...record.done, ...finished],
  };
}

async function main() {
  const token = process.env.LUNATASK_TOKEN?.trim();
  if (!token) {
    console.log('No LUNATASK_TOKEN found. Put it in .env in this folder as LUNATASK_TOKEN=… and run this again.');
    process.exitCode = 1;
    return;
  }

  const folder = resolve(join(import.meta.dirname, '..', 'data', 'lunatask-probe'));
  await mkdir(folder, { recursive: true });
  const run1 = await readFile(join(folder, 'findings.json'), 'utf8').then((t) => JSON.parse(t)).catch(() => null);
  let record = mergeRun1(await loadRecord(folder), run1);
  await saveRecord(folder, record);

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const io: ProbeIO = { fetch, today, areaId: process.env.LUNATASK_PROBE_AREA?.trim() || undefined, say: (line) => console.log(line) };
  const ranAt = now.toISOString();
  const stamp = ranAt.replace(/[:.]/g, '-');

  if (process.argv.includes('--cleanup')) {
    console.log(`Lunatask probe clean-up: deleting ${record.pending.length} probe task(s) it made.\n`);
    const result = await cleanupProbe(token, io, record.pending.map((p) => p.id));
    record = applyCleanup(record, result);
    await saveRecord(folder, record);
    await writeFile(join(folder, `cleanup-${stamp}.json`), JSON.stringify({ ranAt, ...result }, null, 2) + '\n');
    console.log(`\n${result.deleted.length} deleted, ${result.alreadyGone.length} already gone, ${record.pending.length} still on record.`);
    return;
  }

  console.log('Lunatask probe (Sprint 1 spike). It changes only tasks it creates itself.\n');
  const result = await runProbe(token, {
    ...io,
    // Saved to disk the moment each task exists (review H1).
    onCreated: async (task) => {
      record = { ...record, pending: [...record.pending, { id: task.id, label: task.label, createdAt: ranAt }] };
      await saveRecord(folder, record);
    },
  });

  const { apiTasks, ...findings } = result;
  await writeFile(join(folder, `run-${stamp}.json`), JSON.stringify({ ranAt, ...findings }, null, 2) + '\n');
  await writeFile(join(folder, 'api-task-ids.json'), JSON.stringify({ ranAt, tasks: apiTasks }, null, 2) + '\n');
  await writeFile(join(folder, 'test-pack.md'), testPack(result, ranAt));
  console.log(`\nSaved to ${folder}: run-${stamp}.json, api-task-ids.json, test-pack.md. None of it is your task text.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const token = process.env.LUNATASK_TOKEN?.trim();
    const message = String(error?.message ?? error);
    console.error(`The probe stopped unexpectedly: ${token ? message.split(token).join('***') : message}`);
    process.exitCode = 1;
  });
}
