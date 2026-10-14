# User guide

How to use the app day to day. To install it and connect your sources,
see [setup](setup.md) first.

## The idea in one paragraph

Tasks pile up in Claude conversations, Gemini, Lunatask and your notes,
and no single list is complete. This app pulls them into **one list**,
shows **where each came from** (and links back), and sorts them with the
**Eisenhower matrix** — important × urgent — that you already decide
with. It adds your **calendar**, so priorities meet the time you actually
have, and a short **review** that keeps the list believable. It never
changes the other systems; it's an oversight layer on top of them.

## The screen

From the top:

- **Header:** open count, how many are in Do now, how many are idle; the
  view switch (**Matrix · Day · Ahead · List**); and **Review** with the
  number of tasks needing a decision (amber when there are any).
- **Banners** (only when something's wrong): a source that has stopped
  syncing, or the page losing the app. See "When a sync fails".
- **Capture box:** type a task and press Enter.
- **Filters:** All, or one source. A source with a sync problem shows ⚠.
- **Sources:** each source's last sync. Click to open details; *Sync now*
  syncs everything.
- **Possible duplicates:** appears when two open tasks look alike.
- **The view** you've chosen.
- **Done, dropped and merged:** everything closed, with Reopen / Unmerge.

Each task row shows a round **done** button, the title (click to edit),
and underneath: its quadrant (in List and Ahead), due date, when it's
planned, an idle flag, a coloured **source label** (click to open it
there — a Claude conversation, a Lunatask task), any other systems it's
also in, what the source last said about it, and the start of its notes.

## Adding tasks

Type in the capture box and press **Enter** (`n` or `/` jumps there from
anywhere). Shortcuts can go anywhere in the line and are removed from
the title:

| Type | Effect |
|---|---|
| `#claude` `#gemini` `#lunatask` `#local` `#manual` | Where it came from (other `#words` stay in the title) |
| `!1` `!2` `!3` `!4` | Place it: Do now, Schedule, Delegate, Drop/defer |
| `due:2026-10-31` | Due date |
| `on:2026-10-20` | Plan it for that day |
| `at:14:00` | A 30-minute slot at that time (today if there's no `on:`) |
| a pasted link | Becomes the link back. A claude.ai or Gemini link also sets the source; `lunatask://` sets Lunatask |

Example: `Send Sarah the budget #claude !1 due:2026-10-17 https://claude.ai/chat/abc`
→ a Claude task in Do now, due Friday, whose orange **Claude ↗** label
opens the conversation.

**Pasting several lines** adds each as a task. A first line with only a
link or a `#source` (or `!1`, `due:`, `on:`) applies to every line under
it. List markers (`-`, `*`, `1.`) and empty checkboxes are stripped;
ticked `- [x]` lines are skipped. Pasting the same block twice adds
nothing the second time.

```
https://claude.ai/chat/abc123
- Send Sarah the budget draft !1 due:2026-10-17
- Book the venue for the offsite !2
- [ ] Draft the agenda on:2026-10-20 at:10:00
```

The same text saved as a `.md` file in the **inbox folder** is picked up
at the next sync and moved to `inbox/processed`.

## The matrix (default view)

```
                URGENT            NOT URGENT
IMPORTANT     ┌─────────────┬──────────────────┐
              │ Do now   1  │ Schedule      2  │
              ├─────────────┼──────────────────┤
NOT IMPORTANT │ Delegate 3  │ Drop or defer 4  │
              └─────────────┴──────────────────┘
              Not placed yet (0) — below the matrix
```

The page opens with the first task in **Do now** selected — the answer to
"what now?". To move a task: drag it to another quadrant, or select it
and press **1–4** (0 sends it back to "Not placed yet"). `i` and `u` flip
important and urgent one at a time.

**Due dates move tasks for you.** A task due within 3 days, or overdue,
counts as urgent whatever you said, so it rises into Do now (or
Delegate) on its own. Its due label gets a ⏱. If you try to move such a
task out of the urgent column, your answer is saved but the task stays
put, and the app tells you why; once the date moves, your answer takes
over.

**Too much in Do now?** Over 5 tasks, the quadrant turns red and says
so. It's a warning, not a block.

## List

Every open task in one column, newest first, each with its quadrant
shown. Useful for scanning everything from one source (use the filters).

## Day — your calendar beside your list

- **Left:** the day's timeline — calendar events in grey, tasks with a
  time slot as coloured blocks (the colour is their quadrant). Hatched
  areas are outside your working hours (`DAY_HOURS`). A red line marks
  now. All-day events sit at the top; above the timeline, **Some time
  this day** lists tasks planned for the day without a time, and **Due
  this day** lists deadlines.
- **Right — To fit in:** open tasks not yet planned for this day, Do now
  first; "Not placed yet" and "Drop or defer" are folded away.
- **Header:** which day (`[` / `]` to move, `t` for today) and how much
  free time is left — e.g. *4h 25m free for the rest of the day
  (09:00–18:00) · 12:05–15:00, 16:30–18:00*. Events marked "free" in your
  calendar (lunch, birthdays) are dashed and don't count as busy.

**Planning:** drag a task onto the timeline to give it a time (snaps to
15 minutes; 30 minutes long unless you change it in the edit panel).
Drag it onto *Some time this day* to plan the day without a time, or
back to *To fit in* to unplan it. Select a task and press **s** to drop
it into the first free gap long enough. On a timeline block: the circle
completes it, × takes it off the timeline (still planned for the day),
double-click edits it, and dragging moves it.

Planning a Lunatask task here doesn't change Lunatask. If Lunatask later
moves the task to another day, Lunatask's date wins and the time slot is
cleared.

## Ahead — the next 14 days

One card per day with anything on it — events (muted), slotted tasks,
planned tasks and deadlines — plus how much is due and how much free
time there is. Empty days fold into one line. Above the days: **Overdue**
and **Planned for an earlier day, still open**. Below: the next few
deadlines after the fortnight. Click a day's name to open it in Day.

## Editing a task

Click its title, or select it and press `e` (or Enter). The panel has:
title, notes, where it came from and the link to it there; Important? /
Urgent? (Yes, No, Not decided); Due; Planned for, At (optional) and For
(how long); and **This is a duplicate of…** to merge it into any other
open task by hand. Save, or Esc to cancel.

## Duplicates

When two open tasks look like the same thing, **Possible duplicates**
appears above the list. *Same task — keep left/right* merges them: one
task stays, remembering both sources (it shows "also in …"). *Not the
same* stops that pair being suggested. Unnamed Lunatask tasks are left
out until named.

## Closing, undoing, reopening

- `x` or the circle: **done**. `d` or Drop: **dropped** (no longer real).
- Every change shows **Undo** for a few seconds.
- Anything closed stays in **Done, dropped and merged** at the bottom,
  with **Reopen** (or **Unmerge**). Nothing is ever deleted.
- Completing a Lunatask task here doesn't complete it in Lunatask — the
  message says "tick it off in Lunatask too".

## Idle tasks

A task you haven't touched for **30 days** — or **7 days in Do now** —
shows *◌ Idle 34 days*. Touching means editing, placing, planning,
reopening or "still relevant" in the review; syncs don't count. Tasks
with a due date or planned day still ahead aren't flagged — they're
waiting on purpose. Nothing is dropped automatically.

## The review

Press **r** or **Review**. Tasks that need a decision come one card at a
time, in this order:

1. **Not placed yet** — place it, or drop it.
2. **Needs a name** (Lunatask) — open it in Lunatask via its label, press
   `n`, type the name, Enter.
3. **Overdue** — due tomorrow, in a week, no due date; done; drop.
4. **Planned for a day that's gone** — plan for today or tomorrow, unplan.
5. **Idle** — still relevant, move it, done, drop.
6. **Do now is over its limit** — everything in Do now, so you can move
   some out.

| Key | On a card |
|---|---|
| `1`–`4` | move to that quadrant |
| `k` | still relevant — keep as it is (resets the idle clock) |
| `x` / `d` | done / drop |
| `n` | type a name (naming cards) |
| `e` | edit |
| `→` / `←` | skip / back |
| `Esc` | stop |

Every action has Undo. Skipped cards come back next time. At the end, a
summary: how many placed, named, rescheduled, kept, done, dropped.
Once a week is a good rhythm; the amber count on the button is the
reminder.

## When a sync fails

- A **red banner** at the top names the source, since when, and why —
  e.g. *Lunatask hasn't synced since 10:42 (3 tries in a row): Lunatask
  rejected the access token.* — with **Sync now**. That source's filter
  chip shows ⚠. Tasks from it are still shown, but may be out of date.
- The banner also appears if a source hasn't synced successfully for over
  two sync intervals (35 minutes by default), in case a sync is stuck
  rather than failing.
- **Can't reach the app** means the page lost the server (window closed,
  PC asleep). Nothing on the page updates, and changes won't save, until
  it's back; the banner clears itself.

Setup's [troubleshooting table](setup.md#troubleshooting) says what to do
about each message.

## Keyboard reference

| Key | Does |
|---|---|
| `n` or `/` | jump to the capture box |
| `j` / `k` or ↓ / ↑ | next / previous task |
| `1` `2` `3` `4` | move to Do now / Schedule / Delegate / Drop or defer |
| `0` | back to "Not placed yet" |
| `i` / `u` | flip important / urgent |
| `x` / `d` | done / drop |
| `e` or Enter | edit |
| `o` | open the task's source link |
| `s` | Day view: next free slot. Elsewhere: edit (to set a planned day) |
| `[` / `]` | Day view: day before / after |
| `t` | Day view, today |
| `v` | next view: Matrix → Day → Ahead → List |
| `r` | start a review |
| `Esc` | leave a text box; stop a review |

## A suggested rhythm

- **Through the day:** keep the matrix open; capture with `n`; at the end
  of a Claude or Gemini conversation, paste the task block.
- **Each morning:** Day view — drag the top of Do now into the free gaps.
- **Weekly:** Ahead for what's coming, then a review until the count is 0.
