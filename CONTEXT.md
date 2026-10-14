# Task Management App — Context

_Last updated: 14 October 2026_

## What this is

A personal task management app, built for Rory McClelland, whose job is to give
**one place to see and prioritise everything that currently sits in separate
systems**.

This is not a Lunatask clone and not a team tool. It is a single-user oversight
layer plus the parts of a task manager that are actually used day to day.

## The problem

Tasks currently accumulate in at least four places, with no single view:

| Source | What lands there |
|---|---|
| Claude | Work started or promised during conversations; follow-ups |
| Gemini | The same, in a second assistant |
| Lunatask | The deliberate, curated task list and calendar |
| Local machine | Files, notes, half-finished work that implies tasks |

The cost is not that any one list is bad — it is that no list is complete. There
is no single place that answers "what should I be doing now?" with confidence.

## Scope decisions already made

- **Lunatask usage is narrow.** Only task management and the calendar are used.
  The notes, habits, mood tracking and contact tracking features are not used
  and are explicitly out of scope for any replacement.
- **Prioritisation is Eisenhower.** Urgency × importance is the working model for
  deciding what to do, so the data model and the main view need to support it
  natively rather than bolting it on as a tag.
- **Single user.** No sharing, no collaboration, no multi-tenancy.

## How we build it

Same working pattern as the Bolt prototypes:

- Claude writes the code.
- Rory reads it and questions it — so the code needs to be readable and the
  reasoning behind structural choices needs to be explicit, not implied.
- Everything lives in a git repo pushed to GitHub, committed in reviewable
  increments rather than large drops.

## Current status

Backlog agreed (see `BACKLOG.md`). **The build has not started.** Nothing in this
folder is code yet.

## Open decisions

These are not settled and should be decided before or at the start of Phase 0:

1. **Stack.** Web app, desktop app, or local script + web UI?
2. **Where data lives.** Local-first file or SQLite, versus a hosted database.
   Local-first fits the "my own machine" framing and the sync folder this project
   already lives in.
3. **Lunatask integration route.** API, export file, or manual entry — depends on
   what Lunatask actually exposes, which needs checking.
4. **Claude and Gemini capture route.** Whether tasks are pushed out of those
   conversations deliberately, or scraped/exported after the fact.
5. **Whether this replaces Lunatask or sits above it.** The backlog is written so
   either answer stays possible, but it affects how much of the task manager
   proper needs building.
