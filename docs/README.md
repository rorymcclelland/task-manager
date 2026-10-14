# Documentation

_Task oversight · v0.5.0 · 14 October 2026_

One place to see and prioritise tasks that live across Claude, Gemini,
Lunatask and the local machine. Single user, runs on your PC.

## Using it

| Document | For |
|---|---|
| [Setup, configuration and troubleshooting](setup.md) | Installing, every setting, connecting each source, fixing problems |
| [User guide](user-guide.md) | Every view, the capture syntax, planning your day, the review, all keys |

## Understanding and changing it

| Document | For |
|---|---|
| [Architecture](architecture.md) | How it fits together, life of a click, syncing, where to change what |
| [Data model](data-model.md) | `tasks.json`, every field, what's calculated and what's never stored |
| [HTTP API](api.md) | Every route, with request and response shapes |
| [Development](development.md) | Commands, layout, tests, conventions, adding a source |
| [Decisions](DECISIONS.md) | D1–D16: every structural choice and why |

## Project

| Document | For |
|---|---|
| [Context](../CONTEXT.md) | Why it exists, scope, sync direction per source, open decisions |
| [Backlog](../BACKLOG.md) | Phases 0–5 (built), 5Q fixes from QA (next), 6 deferred |
| [QA report, 14 Oct 2026](qa-2026-10-14.md) | Full QA of v0.5.0: findings, evidence, what passed |

## At a glance

| | |
|---|---|
| **Runs as** | A small Node server on 127.0.0.1:4321 plus a browser page |
| **Stack** | Node 22.18+ running TypeScript directly; plain JavaScript page; no runtime dependencies |
| **Data** | One JSON file in the sync folder, safe writes, never trimmed |
| **Sources** | Lunatask (API mirror), notes folders (checkboxes, TODOs), Claude & Gemini (paste or inbox file), calendar (.ics) — all read-only |
| **Prioritisation** | Eisenhower matrix; due dates raise urgency; Do now limit; idle flags |
| **Time** | Day view with timeline and free time; 14-day Ahead view; time slots on tasks |
| **Upkeep** | One-card-at-a-time review; banners when a sync fails |
| **Tests** | 134, Node's built-in runner |
| **Repo** | `github.com/rorymcclelland/task-manager` (private) |
