# Sprint 1 refinement: Lunatask follow-ups

_26 October 2026 · status: L0 ready for Sprint 1; L1 and L2 planned for Sprint 2_

The first sprint under the refine-then-build process. It takes the two open
Phase 3 follow-ups, which matter more now that the app sits above Lunatask
rather than replacing it (D19). Both apps stay in daily use, so closing a
task twice and naming every mirrored task by hand are permanent costs, not
a stopgap.

## What we know and what we don't

From Lunatask's API documentation:

- `PUT /v1/tasks/<id>` updates a task. `status` accepts `later`, `next`,
  `started`, `waiting` and `completed`, and the reply includes
  `previous_status` and `completed_at`.
- Task names and notes are end-to-end encrypted, so the API never returns
  them (D7).

Not documented, and the design depends on them:

1. **Whether an update with only `status` leaves everything else alone.**
   In particular, whether it can blank the encrypted name. We can't check
   the name through the API, only by looking in the Lunatask app.
2. **Whether setting `completed` fills in `completed_at`, and whether setting
   the old status back reopens the task cleanly.**
3. **Whether your access token is allowed to write.**
4. **What the export contains.** Lunatask's docs say it is "limited", give
   no format, and warn that it may change without notice. We don't know if
   it holds task names in readable form, or if its task IDs match the API's.

These can't be answered by reading. They need one short test against your
real Lunatask, so the sprint is split in two.

| Sprint | Contents | Status |
|---|---|---|
| **Sprint 1** | L0: spike, about 1 hour (15 minutes of yours) | **Ready, Sprint 1** |
| **Sprint 2** | L1: complete once. L2: names from the export | Drafted below so the spike asks the right questions; **planned for Sprint 2, refined at the spike's close** |

L1 and L2 can't be marked ready while their design waits on the spike's
answer, so they wait for Sprint 2 (the refinement rule of 16 October 2026).

---

## L0: Spike — what Lunatask lets us write, and what its export holds

**The job.** Answer questions 1 to 4 above with evidence, so L1 and L2 are
designed on facts. We'll know it worked when each question has a recorded
yes or no, and each story has a go or no-go.

**How (timebox: 1 hour).**

- **Write-back probe.** A small script, `scripts/lunatask-probe.ts`, run
  once on your PC with your token. It:
  1. creates one task named "Task app probe, delete me";
  2. records what the API says about it;
  3. sets it to `completed`, and records `completed_at`;
  4. sets it back to its previous status;
  5. reports each answer in plain words.

  You then check in Lunatask that the name survived each step, and delete
  the task. The script touches only the task it created, and stops at the
  first unexpected answer. The token is read from `.env` and never printed.
- **Export check.** You run Settings → Export in the Lunatask desktop app
  and save the file in `data/` (kept out of git). I read it **on your PC
  only** and report its structure: file type, field names, counts, whether
  names are readable, and whether its IDs match the tasks the app already
  mirrors. I don't copy it anywhere or quote any task text, and you can
  delete it afterwards.

**Exit.** A short findings note added to this file. Draft decision entries
(D20 completing in Lunatask, D21 names from the export), each with a go or
no-go. Then L1 and L2 are refined properly for Sprint 2.

**Boundaries.** This is the first time anything writes to Lunatask (an
exception to D8), so it's limited to one throwaway task, with your
permission and while you watch. Export data stays on your PC and out of git.

**Risks.** If the probe shows that a status update blanks the name, L1 is a
no-go as designed (see L1's fallback). If the export has no readable names,
or no matching IDs, L2 is a no-go.

**Size: S.**

---

## L1: Complete once _(draft, Sprint 2; refined at the spike's close)_

**The job.** When I complete a Lunatask task here, it's completed in
Lunatask too, so I close it once. We'll know it worked when "tick it off
in Lunatask too" disappears from daily use.

**Before → after.** Today, pressing `x` on a Lunatask task shows "Done —
tick it off in Lunatask too", and you repeat it there. After, it shows "Done
here and in Lunatask". If Lunatask can't be reached, it shows "Done here;
Lunatask will be updated at the next sync".

**What changes.**

- `src/sources/lunatask.ts` gains `setLunataskStatus(id, status)`, the only
  code that writes. It sends `{ "status": … }` and nothing else.
- On completing a task here: a task done here with a Lunatask link (as its
  origin, or in `alsoIn` after a merge) is sent `completed`.
- `MirrorInfo` gains an optional `writeBack` record: what's still to be
  sent, Lunatask's status before we changed it, and the last error. Older
  files load unchanged.
- The sync retries anything still to be sent before it reads.
- The Sources panel shows "Write-back: on · 1 waiting".
- Setting: `LUNATASK_WRITE_BACK`, on by default once a token is set; `off` turns it off (answer B).
- A new decision entry, D20, as a narrow exception to D8.

**Test cases** (draft, to be confirmed after the spike):

1. Completing an open Lunatask task sends one `PUT /v1/tasks/<id>` with a
   body of exactly `{"status":"completed"}`.
2. Completing a manual, Claude, Gemini or local task sends nothing.
3. Completing a task that Lunatask already shows as closed sends nothing.
4. If Lunatask is unreachable or answers 500, the task is still done here and
   marked as waiting. The next sync sends it once and clears the mark.
5. If Lunatask answers 401, the task stays waiting, and the banner says the
   token was rejected, as it does for syncs.
6. Pressing Undo on the toast, or Reopen later from the closed list, reopens
   the task here, and sends Lunatask its previous status (for example `next`)
   (answer D).
7. A sync that closes a task because Lunatask completed it never sends
   anything back.
8. Completing a task in the review counts the same as pressing `x`.
9. When a merged task has a Lunatask copy in `alsoIn`, completing it
   completes that copy in Lunatask.
10. With write-back switched off, the app behaves exactly as today.
10a. Dropping a Lunatask task here sends nothing; the toast keeps "drop it in
    Lunatask too" (answer C).
11. Hostile input: a hand-edited `externalId` that isn't a Lunatask ID (for
    example `../x`) is never put into a URL. The task is left waiting, with
    a warning.
12. Safety: more than 5 write-backs within a minute pauses write-back and
    warns. This guards against a bug completing a whole list, the risk D8
    named.
13. The token never appears in logs, warnings or the page.

**Out of scope.** Writing back scheduling, Eisenhower answers or names;
creating tasks in Lunatask; deleting anything in Lunatask.

**Boundaries.** Narrow exception to D8: only status, only after you act on
one task, and always undoable. The same-origin rules (D17) are unchanged:
only the app's own page can trigger it.

**Fallback if the spike says no-go.** Keep the reminder, but make it a link
that opens the task in Lunatask.

**Size: M** (about a day).

---

## L2: Names from the export _(draft, Sprint 2; refined at the spike's close)_

**The job.** When Lunatask tasks arrive unnamed, I want to fill in their
names from a Lunatask export in one go, so naming isn't a task-by-task chore.
We'll know it worked when the review's "Needs a name" card is empty after
an import.

**Shape, if the spike says go.** Drop the export where the app looks for it
(the inbox folder, or a button that names a file). The app matches tasks by
Lunatask ID and fills in **only stand-in titles**. It never changes a name
you typed. Then it reports, for example, "42 named · 3 not in the export ·
notes ignored".

**Test-case outline.**

- Stand-in titles are filled in.
- Names you typed are untouched.
- IDs that aren't mirrored here are ignored.
- Tasks that are completed in the export are ignored.
- Newly named tasks join the duplicate check.
- An unreadable or unrecognised file is refused with a plain message, and
  nothing is changed.
- Hostile input: names containing HTML are shown as text.
- Very long names are handled.
- Running the same file twice changes nothing; it can be run whenever new
  unnamed tasks pile up (answer E).

**Boundaries.** Your export holds all your Lunatask data. The app reads names
and IDs only, ignores notes, and never copies the file. It suggests deleting
the file once it's been imported.

**Size: M** if the IDs match. If they don't, it's a no-go: matching by
anything else would be guesswork.

---

## Sprint view

- **Sprint 1:** L0 only, size S.
- **Sprint 2:** L1 (M), then L2 (M), about two days. L1 goes first, because
  it removes a daily cost while L2 is a catch-up.

## Questions for Rory

Recommendations first. Answers will be recorded here.

- **A. Run the spike now?** Recommended: yes, today. It needs 15 minutes
  of your time: running the probe, checking one task in Lunatask, and
  making an export.
- **B. Should write-back be on by default once a token is set?**
  Recommended: on, with `LUNATASK_WRITE_BACK=off` to turn it off. You've
  chosen to want it, and the Sources panel will show that it's on.
- **C. What should dropping a Lunatask task here do?** Recommended:
  nothing in Lunatask. Lunatask has no "dropped" status, deleting is
  irreversible, and marking it "completed" would misreport what happened.
  The reminder to drop it there stays.
- **D. Should reopening here reopen in Lunatask?** Recommended: yes, for
  both Undo and a later Reopen of a task this app completed in Lunatask.
  It's sent Lunatask's own previous status.
- **E. Names import: a one-off catch-up, or repeatable?** Recommended:
  repeatable. New Lunatask tasks keep arriving unnamed, and a second run
  is harmless.
- **F. Should the D19 backlog changes be applied?** These are: Phase 7's
  recurring tasks and projects marked "not planned", and 8.1 (phone view)
  narrowed to viewing only. Recommended: yes.

## Answers

Given by Rory on 26 October 2026; all as recommended.

| | Question | Answer |
|---|---|---|
| A | Run the spike now? | Yes, today |
| B | Write-back on by default once a token is set? | On by default; `LUNATASK_WRITE_BACK=off` turns it off |
| C | Dropping a Lunatask task here | Nothing changes in Lunatask; the reminder stays |
| D | Reopening here reopens in Lunatask? | Yes, for both Undo and a later Reopen, to Lunatask's previous status |
| E | Names import | Repeatable |
| F | Apply the D19 backlog changes? | Yes; applied to `BACKLOG.md` |
| G | Safety cap on write-back | Pause and warn above 5 a minute (test 12) |

**L0 is Ready, Sprint 1:** test steps agreed, questions answered,
boundaries checked (one throwaway task, export read on the PC only), and it
depends on nothing. Building starts when Rory says go.

## Spike log

**Run 1, 28 Oct 2026 07:41.** Stopped early, mostly on mistakes in the probe.

- **Reading works.** 389 tasks came back in one reply, with no paging (130
  open, 260 completed).
- **The token can write.** The probe task was created.
- **Create ignores some fields.** Lunatask kept `priority` and
  `scheduled_on`, but created the task in `later`, with motivation and
  quadrant unset, whatever was sent. That matters for L1 only if we ever
  create tasks, which is out of scope, but it is worth recording in D20.
- **Two probe faults hid the name test.** The task went into the area of the
  first task listed, a completed task in an area Rory doesn't use. And the
  question said "it's in Next" because it assumed the create had kept the
  status. Rory couldn't find the task at all, so `nameVisibleAfterCreate: no`
  is not evidence either way.
- **One leftover.** The probe task stayed in Lunatask, in Later, scheduled
  Wed 4 Nov.

**Fixes for run 2** (tests first; 8 new tests):

- Put the task in the area with the most open tasks, unless
  `LUNATASK_PROBE_AREA` says otherwise.
- Record which fields a create ignores, and set them with one update, so the
  status-only test starts from non-default values.
- Describe where the task is from what Lunatask recorded, and mention
  Lunatask's search.
- If the name isn't visible, ask whether the task is visible at all, so a
  missing name can be told apart from a missing task.
- Offer to delete run 1's leftover first. Only the ID run 1 recorded creating
  can be deleted, and nothing else is ever sent to it.
- Keep each run's findings, rather than overwriting them.
