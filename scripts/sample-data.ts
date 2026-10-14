// Sample data for trying the app out: `npm run sample`.
//
// Writes a fresh data/sample-tasks.json and starts the app on it, so your
// real data/tasks.json is never touched. Run it again any time to reset.
//
//   npm run sample                 write the sample file, then start the app on it
//   npm run sample -- --no-start   just write the file
//
// Dates are set relative to today, not fixed, so the due-date rules always
// have something to show: one task is overdue, some are due within the
// 3-day window (and so jump into an urgent quadrant on their own), others
// are far enough out not to.
//
// What the sample is built to exercise:
//   - every quadrant has tasks, and "Do now" has 6 — one over the default
//     limit of 5 — so the overload warning shows
//   - each urgency reason: marked, due-soon (incl. overdue and due today),
//     due-later, undecided; plus a half-answered task (important, urgency unset)
//   - all five sources, with and without links back
//   - two likely-duplicate pairs to merge, and one look-alike pair already
//     marked "not the same" (it should NOT be suggested)
//   - closed tasks of every kind: done, dropped, and one merged into an open task
//   - Phase 3: Lunatask tasks as a sync leaves them — two still unnamed —
//     plus a sample notes folder with TODOs and an inbox file waiting to be
//     picked up, so the first sync on start has something to do. The sample
//     uses its own notes and inbox folders and never syncs your real Lunatask,
//     so trying it can't touch your real data.

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Source, SourceRef, Status, Task } from '../src/model.ts';
import { localDateString } from '../src/priority.ts';
import { JsonFileStore } from '../src/store/json-file-store.ts';

const sampleFile = resolve(join(import.meta.dirname, '..', 'data', 'sample-tasks.json'));
const sampleNotes = resolve(join(import.meta.dirname, '..', 'data', 'sample-notes'));
const sampleInbox = resolve(join(import.meta.dirname, '..', 'data', 'sample-inbox'));
const now = new Date();

// ---- Helpers ----------------------------------------------------------------

/** A calendar date `days` from today (negative = in the past), as YYYY-MM-DD. */
function day(days: number): string {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

/** A timestamp `days` ago, at a plausible time of day. */
function ago(days: number, hour = 10): string {
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  date.setHours(hour, 15, 0, 0);
  // Never in the future, even for "today at 10:15" when it's earlier than that.
  return (date > now ? now : date).toISOString();
}

/** Plausible-looking links back to the source system. They're made up, so
 *  they'll open the right site but not a real conversation. */
function linkFor(source: Source): string | null {
  if (source === 'claude') return `https://claude.ai/chat/${randomUUID()}`;
  if (source === 'gemini') return `https://gemini.google.com/app/${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return null;
}

function ref(source: Source): SourceRef {
  if (source === 'lunatask') {
    // As a Lunatask sync records them: Lunatask's own id, and its app link.
    const id = randomUUID();
    return { source, externalId: id, url: `lunatask://tasks/${id}` };
  }
  return { source, externalId: null, url: linkFor(source) };
}

interface Sample {
  title: string;
  source: Source;
  notes?: string;
  important?: boolean | null;
  urgent?: boolean | null;
  due?: number; //        days from today
  scheduled?: number; //  days from today
  createdDaysAgo: number;
  status?: Status;
  closedDaysAgo?: number;
  /** For Lunatask tasks: what Lunatask says, e.g. "next · high priority". */
  lunatask?: string;
  /** Lunatask task not yet named here. */
  unnamed?: boolean;
}

function task(s: Sample): Task {
  const createdAt = ago(s.createdDaysAgo, 9);
  const closedAt = s.status && s.status !== 'open' ? ago(s.closedDaysAgo ?? 0, 16) : null;
  return {
    id: randomUUID(),
    title: s.title,
    notes: s.notes ?? '',
    origin: ref(s.source),
    alsoIn: [],
    important: s.important ?? null,
    urgent: s.urgent ?? null,
    dueDate: s.due === undefined ? null : day(s.due),
    scheduledDate: s.scheduled === undefined ? null : day(s.scheduled),
    status: s.status ?? 'open',
    mergedInto: null,
    notDuplicateOf: [],
    createdAt,
    updatedAt: closedAt ?? createdAt,
    closedAt,
    // Every Lunatask task in the sample looks as if a sync brought it in.
    ...(s.source === 'lunatask'
      ? { mirror: { detail: `Lunatask: ${s.lunatask ?? 'later'}`, openInSource: (s.status ?? 'open') === 'open', placeholderTitle: !!s.unnamed } }
      : {}),
  };
}

// ---- The tasks ------------------------------------------------------------------

// Do now — 6 tasks, one over the limit. Three are here only because of
// their due date (overdue, due today, due in 2 days).
const doNow = [
  task({ title: 'Confirm whether Lunatask has a public API', source: 'claude', important: true, urgent: true, createdDaysAgo: 1,
    notes: 'Decides the Phase 3 import route: API, export file, or manual entry.' }),
  task({ title: 'Pay electricity bill', source: 'lunatask', important: true, urgent: false, due: -2, createdDaysAgo: 12, lunatask: 'next · must',
    notes: 'Marked not urgent, but it is now overdue, so it shows in Do now with ⏱.' }),
  task({ title: 'Submit expenses for September', source: 'gemini', important: true, due: 0, createdDaysAgo: 9 }),
  task({ title: 'Prepare agenda for Thursday planning call', source: 'claude', important: true, urgent: true, due: 2, createdDaysAgo: 3 }),
  task({ title: 'Send Q4 budget draft to finance', source: 'claude', important: true, urgent: true, due: 1, createdDaysAgo: 4 }),
  task({ title: 'Fix the broken backup script on the laptop', source: 'local', important: true, urgent: true, createdDaysAgo: 2,
    notes: 'Scheduled task has been failing silently since last week. Log is in C:\\Scripts\\backup.log.' }),
];

// Schedule — important, not urgent.
const schedule = [
  task({ title: 'Draft Phase 3 plan for automatic task import', source: 'claude', important: true, urgent: false, due: 14, scheduled: 7, createdDaysAgo: 1 }),
  task({ title: 'Book dentist appointment for November', source: 'lunatask', important: true, urgent: false, createdDaysAgo: 20, scheduled: 5,
    lunatask: `later · scheduled ${day(5)}` }),
  task({ title: 'Renew car insurance', source: 'lunatask', important: true, due: 20, createdDaysAgo: 15,
    notes: 'Urgency left blank; the due date is outside the 3-day window, so it counts as not urgent.' }),
  task({ title: 'Review pension contributions', source: 'manual', important: true, urgent: false, scheduled: 10, createdDaysAgo: 30 }),
  task({ title: 'Write up lessons from the Bolt prototypes', source: 'local', important: true, urgent: false, createdDaysAgo: 6,
    notes: 'Rough notes are in Documents\\Bolt\\retro.md.' }),
];

// Delegate or fit in — urgent, not important.
const delegate = [
  task({ title: 'Order printer ink', source: 'manual', important: false, urgent: true, createdDaysAgo: 2 }),
  task({ title: 'Return library books', source: 'lunatask', important: false, due: 3, createdDaysAgo: 18,
    notes: 'Due in exactly 3 days — the edge of the window, so it counts as urgent.' }),
  task({ title: 'RSVP to Friday drinks', source: 'gemini', important: false, urgent: true, due: 1, createdDaysAgo: 5 }),
];

// Drop or defer — neither.
const eliminate = [
  task({ title: 'Reorganise browser bookmarks', source: 'manual', important: false, urgent: false, createdDaysAgo: 40 }),
  task({ title: 'Try out a new Markdown editor', source: 'gemini', important: false, urgent: false, createdDaysAgo: 25 }),
  task({ title: 'Unsubscribe from old newsletters', source: 'manual', important: false, urgent: false, due: 30, createdDaysAgo: 8 }),
];

// Not placed yet.
const sarahA = task({ title: 'Email Sarah about the workshop', source: 'manual', createdDaysAgo: 3 });
const sarahB = task({ title: 'Email Sarah about the workshop venue', source: 'claude', createdDaysAgo: 2,
  notes: 'Already marked "not the same" as the other Sarah task, so no duplicate suggestion.' });
sarahA.notDuplicateOf = [sarahB.id];
sarahB.notDuplicateOf = [sarahA.id];

const untriaged = [
  // Likely duplicates of tasks above.
  task({ title: 'Send budget draft to finance', source: 'gemini', createdDaysAgo: 3 }),
  task({ title: 'Book dentist', source: 'manual', createdDaysAgo: 0 }),
  // Look-alikes already marked as different.
  sarahA,
  sarahB,
  // Half-answered: important, urgency not decided.
  task({ title: 'Read the time-blocking article Claude recommended', source: 'claude', important: true, createdDaysAgo: 4 }),
  // Has a due date but no importance answer yet.
  task({ title: 'Plan a weekend away in the spring', source: 'manual', due: 45, createdDaysAgo: 1 }),
  task({ title: 'Look into Gemini export options', source: 'gemini', createdDaysAgo: 0 }),
  task({ title: 'Tidy the Downloads folder', source: 'local', createdDaysAgo: 7 }),
  // Lunatask can't tell us names (they're encrypted), so these wait to be named.
  task({ title: 'Unnamed Lunatask task', source: 'lunatask', unnamed: true, createdDaysAgo: 0, lunatask: 'next · high priority' }),
  task({ title: 'Unnamed Lunatask task', source: 'lunatask', unnamed: true, createdDaysAgo: 0, scheduled: 2,
    lunatask: `waiting · scheduled ${day(2)}` }),
];

// Closed: done, dropped, and one merged into "Pay electricity bill".
const payBill = doNow[1];
const mergedBill = task({ title: 'Pay the electric bill', source: 'manual', createdDaysAgo: 10, status: 'merged', closedDaysAgo: 5 });
mergedBill.mergedInto = payBill.id;
payBill.alsoIn = [mergedBill.origin];
payBill.updatedAt = mergedBill.closedAt!;

const closed = [
  task({ title: 'Set up GitHub repo for task-manager', source: 'claude', important: true, urgent: true, createdDaysAgo: 2, status: 'done', closedDaysAgo: 1 }),
  task({ title: 'Choose a stack for the task app', source: 'claude', important: true, urgent: false, createdDaysAgo: 3, status: 'done', closedDaysAgo: 0 }),
  task({ title: 'Cancel unused streaming subscription', source: 'lunatask', important: false, urgent: true, createdDaysAgo: 14, status: 'done', closedDaysAgo: 3 }),
  task({ title: 'Evaluate Todoist as a Lunatask replacement', source: 'gemini', createdDaysAgo: 21, status: 'dropped', closedDaysAgo: 2,
    notes: 'Dropped: building our own instead.' }),
  task({ title: 'Buy a standing desk mat', source: 'manual', important: false, urgent: false, createdDaysAgo: 35, status: 'dropped', closedDaysAgo: 6 }),
  mergedBill,
];

const allTasks = [...doNow, ...schedule, ...delegate, ...eliminate, ...untriaged, ...closed];

// ---- Write it, then (unless told not to) start the app on it ----------------

await rm(sampleFile, { force: true });
await new JsonFileStore(sampleFile).saveMany(allTasks);
console.log(`Wrote ${allTasks.length} sample tasks to ${sampleFile}`);

// A notes folder for the "files on this computer" scan (3.4)…
await rm(sampleNotes, { recursive: true, force: true });
await mkdir(sampleNotes, { recursive: true });
await writeFile(join(sampleNotes, 'project-notes.md'), [
  '# Kitchen refit',
  '',
  '- [x] Measure the space',
  '- [ ] Get three quotes for worktops',
  '- [ ] Decide on tap finish',
  '',
  'TODO: ask Dad about borrowing the van',
  '',
].join('\n'));

// …and a file waiting in the inbox, as a Claude session might leave it (3.2).
await rm(sampleInbox, { recursive: true, force: true });
await mkdir(sampleInbox, { recursive: true });
await writeFile(join(sampleInbox, 'claude-actions.md'), [
  `https://claude.ai/chat/${randomUUID()}`,
  '- Send the revised proposal !1 due:' + day(1),
  '- Book follow-up call for next week !2',
  '',
].join('\n'));
console.log(`Sample notes in ${sampleNotes}; one file waiting in ${sampleInbox}`);

if (!process.argv.includes('--no-start')) {
  // server.ts reads these when it loads, so set them first. LUNATASK_TOKEN is
  // cleared so the sample never syncs (and so never changes) your real list.
  process.env.TASKS_FILE = sampleFile;
  process.env.LOCAL_FOLDERS = sampleNotes;
  process.env.INBOX_FOLDER = sampleInbox;
  process.env.LUNATASK_TOKEN = '';
  await import('../src/server.ts');
}
