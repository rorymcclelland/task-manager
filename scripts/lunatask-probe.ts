// Sprint 1, L0: the Lunatask spike. Run once, by hand:
//
//   npm run probe:lunatask
//
// Lunatask's API documentation doesn't say what a status change does to the
// rest of a task — in particular whether it can blank the task's name, which
// is encrypted and so invisible to the API. This script finds out, using one
// throwaway task, so the "complete once" story (L1) is designed on facts.
// See docs/refinement/sprint-1.md.
//
// What it does, in order, stopping at the first unexpected answer:
//
//   1. Lists your Lunatask tasks — IDs and statuses only — and saves them, so
//      the export check can match against them. No task text is read.
//   2. If an earlier run left its probe task behind, offers to delete it.
//   3. Creates one task, "Task app probe, delete me", in the area that holds
//      most of your open tasks, with a status, priority, motivation, quadrant
//      and date set. If Lunatask ignores any of those on create (it ignored
//      status, motivation and quadrant on 28 Oct 2026), notes it and sets
//      them with an update instead.
//   4. Tells you where the task really is — from what Lunatask recorded, not
//      what was asked for — and asks you to look at it there (its name can
//      only be checked in Lunatask).
//   4. Marks it completed, sending only {"status":"completed"}, and checks
//      nothing else changed and that Lunatask recorded when.
//   5. Asks you to check its name survived.
//   6. Sets it back to its previous status, and checks again — then asks again.
//   7. Notes how Lunatask answers an unknown task and an invalid status.
//   8. Offers to delete the probe task.
//
// Safety:
//   - It only ever changes the task it created in this run. The other writes
//     are a delete of the probe task an earlier run recorded creating (only if
//     you say yes), and one update to a freshly made-up ID, to see how
//     Lunatask answers a task that doesn't exist.
//   - Your token is read from .env and never printed or saved.
//   - Results go to data/lunatask-probe/ (data/ is never committed).

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const API = 'https://api.lunatask.app/v1';
export const PROBE_NAME = 'Task app probe, delete me';

/** Everything the probe needs from the outside world, so tests can fake it. */
export interface ProbeIO {
  fetch: typeof fetch;
  /** Ask Rory a yes/no question. */
  ask(question: string): Promise<boolean>;
  /** Print one line for Rory. */
  say(line: string): void;
  /** Today as YYYY-MM-DD, for the probe task's scheduled date. */
  today: string;
  /** Area to create the probe task in, if you'd rather choose one. */
  areaId?: string;
  /** The probe task an earlier run created and didn't delete, if any. */
  leftoverId?: string;
}

export interface Finding {
  step: string;
  ok: boolean;
  detail: string;
}

/** The spike's questions. `null` = that step didn't run. */
export interface Answers {
  canRead: boolean | null;
  canWrite: boolean | null;
  statusOnlyLeavesOtherFields: boolean | null;
  completingSetsCompletedAt: boolean | null;
  reopeningIsClean: boolean | null;
  nameVisibleAfterCreate: boolean | null;
  nameSurvivesCompleting: boolean | null;
  nameSurvivesReopening: boolean | null;
  /** HTTP status Lunatask gives for an update to a task that doesn't exist. */
  unknownIdAnswer: number | null;
  /** HTTP status Lunatask gives for an update with an invalid status. */
  invalidStatusAnswer: number | null;
  deleted: boolean | null;
  /** Did Lunatask keep every field the create asked for? */
  createKeepsFields: boolean | null;
  /** Asked when you can't see the name: can you see the task at all? */
  taskVisibleAfterCreate: boolean | null;
  /** The earlier run's leftover task: deleted (true), kept (false), not there (null). */
  leftoverDeleted: boolean | null;
}

export interface ProbeResult {
  answers: Answers;
  findings: Finding[];
  /** Every task Lunatask's API listed: ID and status only. */
  apiTasks: { id: string; status: string }[];
  createdId: string | null;
  unknownId: string | null;
  stoppedEarly: boolean;
}

/** What the probe task is created with. */
const REQUESTED = { status: 'next', priority: 1, motivation: 'should', eisenhower: 3 } as const;

/** Lunatask's own names for its status lists. */
const LIST_NAMES: Record<string, string> = {
  later: 'Later',
  next: 'Next',
  started: 'In progress',
  waiting: 'Waiting',
  completed: 'Completed',
};

/** The fields we compare before and after a status change. */
const KEPT_FIELDS = ['area_id', 'priority', 'motivation', 'eisenhower', 'scheduled_on'] as const;

interface ApiTask {
  id: string;
  status: string;
  previous_status?: string | null;
  completed_at?: string | null;
  area_id?: string;
  [field: string]: unknown;
}

interface Reply {
  status: number;
  body: any;
}

export async function runProbe(token: string, io: ProbeIO): Promise<ProbeResult> {
  const answers: Answers = {
    canRead: null,
    canWrite: null,
    statusOnlyLeavesOtherFields: null,
    completingSetsCompletedAt: null,
    reopeningIsClean: null,
    nameVisibleAfterCreate: null,
    nameSurvivesCompleting: null,
    nameSurvivesReopening: null,
    unknownIdAnswer: null,
    invalidStatusAnswer: null,
    deleted: null,
    createKeepsFields: null,
    taskVisibleAfterCreate: null,
    leftoverDeleted: null,
  };
  const result: ProbeResult = { answers, findings: [], apiTasks: [], createdId: null, unknownId: null, stoppedEarly: false };

  /** Never let the token reach anything printed or saved. */
  const clean = (text: string) => (token ? text.split(token).join('***') : text);
  const note = (step: string, ok: boolean, detail: string) => {
    result.findings.push({ step, ok, detail: clean(detail) });
    io.say(`${ok ? '  ✓' : '  ✗'} ${step}: ${clean(detail)}`);
  };
  const stop = (why: string) => {
    result.stoppedEarly = true;
    io.say(`\nStopping here: ${clean(why)}`);
  };

  /** One API call. Writes are only allowed to the task this run created,
   *  or the made-up ID — a guard against a bug touching your real tasks. */
  const call = async (method: string, path: string, body?: unknown): Promise<Reply | null> => {
    if (method !== 'GET' && path !== '/tasks') {
      const id = path.split('/')[2];
      const allowed =
        id === result.createdId || id === result.unknownId || (method === 'DELETE' && !!io.leftoverId && id === io.leftoverId);
      if (!allowed) throw new Error(`Refusing to ${method} a task this probe didn't create`);
    }
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

  // ---- 1. Read ---------------------------------------------------------------
  io.say('1. Reading your Lunatask task list (IDs and statuses only)…');
  const list = await call('GET', '/tasks');
  if (!ok(list) || !Array.isArray(list.body?.tasks)) {
    answers.canRead = false;
    if (list) note('Read tasks', false, list.status === 401 ? 'Lunatask rejected the token. Make a new one in Lunatask → Settings → Access tokens.' : why(list));
    else io.say("  Couldn't reach Lunatask. Are you online?");
    stop('the probe needs to read your tasks first.');
    return result;
  }
  answers.canRead = true;
  const listed = list.body.tasks as ApiTask[];
  result.apiTasks = listed.map((t) => ({ id: String(t.id), status: String(t.status) }));
  const extraKeys = Object.keys(list.body).filter((k) => k !== 'tasks');
  note('Read tasks', true, `${listed.length} task${listed.length === 1 ? '' : 's'} listed${extraKeys.length ? `; the reply also had: ${extraKeys.join(', ')}` : ', in one reply'}`);

  // ---- 2. An earlier run's leftover -----------------------------------------
  if (io.leftoverId) {
    const leftover = listed.find((t) => t.id === io.leftoverId);
    if (!leftover) {
      io.say('\nThe probe task from an earlier run is already gone from Lunatask.');
    } else {
      const remove = await io.ask(
        `A probe task from an earlier run is still in Lunatask (in ${listName(leftover.status)}` +
          `${leftover.scheduled_on ? `, scheduled ${dayWords(String(leftover.scheduled_on))}` : ''}). Delete it now?`,
      );
      if (remove) {
        const deleted = await call('DELETE', `/tasks/${io.leftoverId}`);
        answers.leftoverDeleted = ok(deleted);
        note("Delete the earlier run's probe task", answers.leftoverDeleted, deleted ? why(deleted) : 'no answer');
      } else {
        answers.leftoverDeleted = false;
      }
    }
  }

  // Where to put the probe task: where you'll look. The first run borrowed the
  // area of the first task listed — a completed one, in an area you don't use.
  let areaId = io.areaId;
  let areaWords = 'the area you chose (LUNATASK_PROBE_AREA)';
  if (!areaId) {
    const openByArea = new Map<string, number>();
    for (const t of listed) {
      if (t.area_id && t.status !== 'completed') openByArea.set(t.area_id, (openByArea.get(t.area_id) ?? 0) + 1);
    }
    const busiest = [...openByArea].sort((a, b) => b[1] - a[1])[0];
    if (busiest) {
      areaId = busiest[0];
      areaWords = `the area with the most open tasks (${busiest[1]} open)`;
    }
  }
  if (!areaId) {
    stop('none of your open tasks has an area to borrow. Set LUNATASK_PROBE_AREA in .env to an area ID (Lunatask → area settings → Copy area ID) and run again.');
    return result;
  }

  // ---- 3. Create the probe task --------------------------------------------
  io.say(`\n2. Creating one task, "${PROBE_NAME}", in ${areaWords}…`);
  const requested: Record<string, unknown> = { ...REQUESTED, scheduled_on: addDays(io.today, 7) };
  const created = await call('POST', '/tasks', { name: PROBE_NAME, area_id: areaId, ...requested });
  if (!ok(created) || !created.body?.task?.id) {
    answers.canWrite = false;
    note('Create a task', false, created ? `${why(created)}. The token may not be allowed to write.` : 'no answer');
    stop('the token could not create a task, so write-back would not work with it either.');
    return result;
  }
  answers.canWrite = true;
  let original = created.body.task as ApiTask;
  result.createdId = String(original.id);
  note('Create a task', true, `created with status ${original.status}, ${describeFields(original)}`);

  try {
    const ignored = Object.keys(requested).filter((f) => JSON.stringify(original[f] ?? null) !== JSON.stringify(requested[f]));
    answers.createKeepsFields = ignored.length === 0;
    note('Create keeps what it was sent', answers.createKeepsFields, ignored.length ? `ignored: ${ignored.join(', ')}` : 'everything kept');
    if (ignored.length) {
      // Set them with an update, so the status test below starts from a task
      // whose other fields aren't all defaults (otherwise "nothing else
      // changed" would prove little).
      const setup = Object.fromEntries(ignored.map((f) => [f, requested[f]]));
      const updated = await call('PUT', `/tasks/${result.createdId}`, setup);
      const stillWrong = ok(updated) && updated.body?.task
        ? ignored.filter((f) => JSON.stringify(updated.body.task[f] ?? null) !== JSON.stringify(requested[f]))
        : ignored;
      note('An update sets what create ignored', stillWrong.length === 0, stillWrong.length ? `still not set: ${stillWrong.join(', ')}` : 'all set');
      if (stillWrong.length) {
        stop('Lunatask would not set those fields, even with an update.');
        return result;
      }
      original = updated!.body.task as ApiTask;
    }

    const where =
      `it's in ${listName(original.status)}` +
      `${original.scheduled_on ? `, scheduled ${dayWords(String(original.scheduled_on))}` : ''}, in ${areaWords}. ` +
      "Lunatask's search will also find it by name";
    answers.nameVisibleAfterCreate = await io.ask(`In Lunatask, find "${PROBE_NAME}": ${where}. Can you see it with that name?`);
    if (!answers.nameVisibleAfterCreate) {
      answers.taskVisibleAfterCreate = await io.ask(`Can you see a task there with no name, or a garbled one, instead?`);
      stop(
        answers.taskVisibleAfterCreate
          ? 'the task arrived, but its name did not — so names sent through the API do not show in Lunatask.'
          : "the task can't be seen in Lunatask at all. It may not have synced to the app yet; try again in a few minutes.",
      );
      return result;
    }
    answers.taskVisibleAfterCreate = true;

    // ---- 3. Complete it ------------------------------------------------------
    io.say('\n3. Marking it completed (sending only {"status":"completed"})…');
    const completed = await call('PUT', `/tasks/${result.createdId}`, { status: 'completed' });
    if (!ok(completed) || !completed.body?.task) {
      note('Complete', false, completed ? why(completed) : 'no answer');
      stop('completing through the API failed.');
      return result;
    }
    const afterComplete = completed.body.task as ApiTask;
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
    note('Completing records when', answers.completingSetsCompletedAt, `completed_at is ${afterComplete.completed_at ?? 'empty'}; previous_status is ${afterComplete.previous_status ?? 'empty'}`);
    if (!answers.statusOnlyLeavesOtherFields || !answers.completingSetsCompletedAt) {
      stop('completing changed more (or less) than it should.');
      return result;
    }

    const shown = await call('GET', `/tasks/${result.createdId}`);
    const shownStatus = ok(shown) ? shown.body?.task?.status : null;
    note(
      'Read back a single task',
      shownStatus === 'completed',
      shownStatus ? `reads back as ${shownStatus}` : shown ? `${why(shown)} (no single-task read; not needed for L1)` : 'no answer',
    );

    answers.nameSurvivesCompleting = await io.ask(`In Lunatask, is "${PROBE_NAME}" now shown as completed, with its name intact?`);
    if (!answers.nameSurvivesCompleting) {
      stop('completing through the API lost the name.');
      return result;
    }

    // ---- 4. Reopen it ----------------------------------------------------------
    const back = afterComplete.previous_status || 'next';
    io.say(`\n4. Setting it back to "${back}"…`);
    const reopened = await call('PUT', `/tasks/${result.createdId}`, { status: back });
    if (!ok(reopened) || !reopened.body?.task) {
      note('Reopen', false, reopened ? why(reopened) : 'no answer');
      stop('reopening through the API failed.');
      return result;
    }
    const afterReopen = reopened.body.task as ApiTask;
    const changedOnReopen = changedFields(original, afterReopen);
    answers.reopeningIsClean = afterReopen.status === back && !afterReopen.completed_at && changedOnReopen.length === 0;
    note(
      'Reopening is clean',
      answers.reopeningIsClean,
      `status ${afterReopen.status}, completed_at ${afterReopen.completed_at ?? 'empty'}` +
        (changedOnReopen.length ? `; also changed: ${changedOnReopen.join(', ')}` : '; nothing else changed'),
    );
    if (!answers.reopeningIsClean) {
      stop("reopening didn't put the task back as it was.");
      return result;
    }

    answers.nameSurvivesReopening = await io.ask(`In Lunatask, is "${PROBE_NAME}" back in ${listName(back)}, with its name intact?`);
    if (!answers.nameSurvivesReopening) {
      stop('reopening through the API lost the name.');
      return result;
    }

    // ---- 5. How Lunatask answers mistakes --------------------------------------
    io.say('\n5. Checking how Lunatask answers mistakes…');
    result.unknownId = randomUUID();
    const unknown = await call('PUT', `/tasks/${result.unknownId}`, { status: 'completed' });
    answers.unknownIdAnswer = unknown?.status ?? null;
    note('Update a task that does not exist', true, unknown ? why(unknown) : 'no answer');

    const invalid = await call('PUT', `/tasks/${result.createdId}`, { status: 'finished' });
    answers.invalidStatusAnswer = invalid?.status ?? null;
    note('Update with an invalid status', !ok(invalid), invalid ? why(invalid) : 'no answer');
  } finally {
    // ---- 6. Clean up, whatever happened -----------------------------------------
    if (result.createdId) {
      const remove = await io.ask(`Delete "${PROBE_NAME}" from Lunatask now?`);
      if (remove) {
        const deleted = await call('DELETE', `/tasks/${result.createdId}`);
        answers.deleted = ok(deleted);
        note('Delete the probe task', answers.deleted, deleted ? why(deleted) : 'no answer');
      } else {
        answers.deleted = false;
      }
      if (!answers.deleted) io.say(`  Please delete it yourself in Lunatask: "${PROBE_NAME}".`);
    }
  }

  io.say('\nDone: every step answered.');
  return result;
}

function changedFields(before: ApiTask, after: ApiTask): string[] {
  return KEPT_FIELDS.filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)).map(
    (field) => `${field} ${JSON.stringify(before[field] ?? null)} → ${JSON.stringify(after[field] ?? null)}`,
  );
}

function describeFields(task: ApiTask): string {
  return KEPT_FIELDS.filter((f) => f !== 'area_id').map((f) => `${f} ${JSON.stringify(task[f] ?? null)}`).join(', ');
}

function listName(status: string): string {
  return LIST_NAMES[status] ?? status;
}

/** "2026-11-03" → "Tue 3 Nov" */
function dayWords(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---- Run from the command line -------------------------------------------------

async function main() {
  const token = process.env.LUNATASK_TOKEN?.trim();
  if (!token) {
    console.log('No LUNATASK_TOKEN found. In Lunatask: Settings → Access tokens → create one,');
    console.log('then put it in .env in this folder as LUNATASK_TOKEN=… and run this again.');
    process.exitCode = 1;
    return;
  }

  // The probe task an earlier run created and didn't delete, if any — the only
  // task other than its own this probe will ever offer to delete.
  const folder = resolve(join(import.meta.dirname, '..', 'data', 'lunatask-probe'));
  let leftoverId: string | undefined;
  let previousRanAt: string | undefined;
  try {
    const previous = JSON.parse(await readFile(join(folder, 'findings.json'), 'utf8'));
    previousRanAt = previous.ranAt;
    const candidate = previous.answers?.deleted === true ? null : previous.createdId;
    if (typeof candidate === 'string' && /^[0-9a-f-]{36}$/i.test(candidate)) leftoverId = candidate;
  } catch {
    // no earlier run
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  console.log('Lunatask probe (Sprint 1 spike). It changes only a task it creates itself.\n');

  const result = await runProbe(token, {
    fetch,
    today,
    areaId: process.env.LUNATASK_PROBE_AREA?.trim() || undefined,
    leftoverId,
    say: (line) => console.log(line),
    ask: async (question) => {
      for (;;) {
        const answer = (await rl.question(`\n  ${question} (y/n) `)).trim().toLowerCase();
        if (answer === 'y' || answer === 'yes') return true;
        if (answer === 'n' || answer === 'no') return false;
      }
    },
  });
  rl.close();

  await mkdir(folder, { recursive: true });
  // Keep the earlier run's findings under its own date rather than overwrite them.
  if (previousRanAt) {
    await rename(join(folder, 'findings.json'), join(folder, `findings-${previousRanAt.replace(/[:.]/g, '-')}.json`)).catch(() => {});
  }
  const ranAt = now.toISOString();
  const { apiTasks, ...findings } = result;
  await writeFile(join(folder, 'findings.json'), JSON.stringify({ ranAt, ...findings }, null, 2) + '\n');
  await writeFile(join(folder, 'api-task-ids.json'), JSON.stringify({ ranAt, tasks: apiTasks }, null, 2) + '\n');
  console.log(`\nSaved to ${folder} (findings.json, api-task-ids.json). Nothing there is task text.`);
  console.log('Tell Claude when it has run.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`The probe stopped unexpectedly: ${error.message}`);
    process.exitCode = 1;
  });
}
