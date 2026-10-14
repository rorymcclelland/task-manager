// Quick capture (backlog 1.3, extended for 3.2/3.3): turn typed or pasted
// text into new tasks.
//
// One line, with optional shortcuts anywhere in it:
//
//   Send Sarah the budget draft #claude !1 due:2026-10-20 https://claude.ai/chat/abc123
//   └──────── title ─────────┘ └source┘ └┘ └────due─────┘ └──────── link ──────────────┘
//                                   quadrant
//
// - `#claude`, `#gemini`, `#lunatask`, `#local` or `#manual` sets the source.
//   Anything else starting with # is left in the title untouched.
// - `!1` `!2` `!3` `!4` places it on the matrix: Do now, Schedule, Delegate,
//   Drop/defer — the same numbers as the keyboard shortcuts.
// - `due:YYYY-MM-DD` sets a due date.
// - `on:YYYY-MM-DD` schedules it for that day; `at:14:30` gives it a
//   30-minute slot at that time (on today, if there's no `on:`). Phase 4.
// - The first link becomes the task's source link. If there's no #tag, the
//   link says where it came from: a claude.ai link means Claude, a Gemini
//   link means Gemini, a lunatask:// link means Lunatask.
//
// Several lines at once (pasted from a Claude or Gemini conversation, or a
// file dropped in the inbox folder — see DECISIONS.md, D9):
//
//   #claude https://claude.ai/chat/abc123        ← no title: sets the source
//   - Send Sarah the budget draft !1                and link for every line
//   - [ ] Book the venue due:2026-11-02            below it
//   - [x] Already done                           ← ticked: skipped
//
// List markers (-, *, •, 1.) and empty checkboxes are stripped. Lines with
// shortcuts but no title before the first task set defaults for the lines
// after them; later on, only a new link or #source does (see parseCaptureLines).

import { isDateString, isSource, isTimeString, type Slot, type Source } from './model.ts';
import { QUADRANTS, type Placement } from './priority.ts';

export interface CaptureResult {
  title: string;
  source: Source;
  url: string | null;
  placement: Placement;
  dueDate: string | null;
  scheduledDate: string | null;
  slot: Slot | null;
}

/** How long an `at:` slot is blocked out for. */
const AT_MINUTES = 30;

/** What one line said, before defaults are filled in. Null = not mentioned. */
interface LineParts {
  title: string;
  source: Source | null;
  url: string | null;
  placement: Placement | null;
  dueDate: string | null;
  scheduledDate: string | null;
  start: string | null;
}

type Defaults = Omit<LineParts, 'title'>;
const NO_DEFAULTS: Defaults = { source: null, url: null, placement: null, dueDate: null, scheduledDate: null, start: null };

const TAG = /(^|\s)#([a-z]+)(?=\s|$)/gi;
const QUADRANT_TAG = /(^|\s)!([1-4])(?=\s|$)/g;
const DUE = /(^|\s)due:(\S+)(?=\s|$)/i;
const ON = /(^|\s)on:(\S+)(?=\s|$)/i;
const AT = /(^|\s)at:(\d{1,2}:\d{2})(?=\s|$)/i;
const URL = /(^|\s)((?:https?|lunatask):\/\/\S+)/i;
const LIST_MARKER = /^(?:[-*•]|\d+[.)])\s+/;
const OPEN_CHECKBOX = /^\[ \]\s+/;
const TICKED_CHECKBOX = /^(?:[-*•]|\d+[.)])?\s*\[[xX]\]\s+/;

/** Parse one line of capture text. `today` (YYYY-MM-DD) is the day an
 *  `at:` with no `on:` lands on. */
export function parseCapture(text: string, today: string | null = null): CaptureResult {
  return withDefaults(parseLine(text), NO_DEFAULTS, today);
}

/** Parse several lines. Returns one result per task line, in order. */
export function parseCaptureBlock(text: string, today: string | null = null): CaptureResult[] {
  return parseCaptureLines(text, today).tasks;
}

/**
 * Parse several lines, and also say which lines were skipped.
 *
 * Lines with shortcuts but no title are *header* lines: they set the
 * source, link, quadrant or dates for the task lines under them. Q7: once
 * tasks have started, only a line that names a new link or `#source` is
 * taken as a header — that starts a new section, as when two conversations'
 * blocks are pasted together. A title-less line with only `!1`, `due:`,
 * `on:` or `at:` in the middle of a list is almost always a slip (an empty
 * `- !1`), so it's skipped and its line number reported, rather than
 * quietly applying to every line after it.
 */
export function parseCaptureLines(text: string, today: string | null = null): { tasks: CaptureResult[]; ignored: number[] } {
  const tasks: CaptureResult[] = [];
  const ignored: number[] = [];
  let defaults: Defaults = NO_DEFAULTS;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || TICKED_CHECKBOX.test(line)) return;

    const parts = parseLine(line.replace(LIST_MARKER, '').replace(OPEN_CHECKBOX, ''));
    if (parts.title) {
      tasks.push(withDefaults(parts, defaults, today));
      return;
    }

    const { title: _none, ...shortcuts } = parts;
    if (tasks.length === 0) {
      // Still in the header: each line adds to the defaults.
      defaults = {
        source: parts.source ?? defaults.source,
        url: parts.url ?? defaults.url,
        placement: parts.placement ?? defaults.placement,
        dueDate: parts.dueDate ?? defaults.dueDate,
        scheduledDate: parts.scheduledDate ?? defaults.scheduledDate,
        start: parts.start ?? defaults.start,
      };
    } else if (parts.url || parts.source) {
      defaults = shortcuts; // a new section starts afresh
    } else {
      ignored.push(index + 1);
    }
  });
  return { tasks, ignored };
}

/** Work out which system a link points into, if it's one we know. */
export function sourceFromUrl(url: string): Source | null {
  let parsed: URL;
  try {
    parsed = new globalThis.URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === 'lunatask:') return 'lunatask';
  const host = parsed.hostname.toLowerCase();
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) return 'claude';
  if (host === 'gemini.google.com') return 'gemini';
  if (host === 'g.co' && parsed.pathname.startsWith('/gemini')) return 'gemini';
  return null;
}

function parseLine(text: string): LineParts {
  let rest = text;
  let source: Source | null = null;
  let url: string | null = null;
  let placement: Placement | null = null;
  let dueDate: string | null = null;
  let scheduledDate: string | null = null;
  let start: string | null = null;

  const urlMatch = rest.match(URL);
  if (urlMatch) {
    url = urlMatch[2];
    rest = rest.replace(urlMatch[0], ' ');
  }

  const dueMatch = rest.match(DUE);
  if (dueMatch && isDateString(dueMatch[2])) {
    dueDate = dueMatch[2];
    rest = rest.replace(dueMatch[0], ' ');
  }

  const onMatch = rest.match(ON);
  if (onMatch && isDateString(onMatch[2])) {
    scheduledDate = onMatch[2];
    rest = rest.replace(onMatch[0], ' ');
  }

  const atMatch = rest.match(AT);
  const atTime = atMatch ? atMatch[2].padStart(5, '0') : null; // 9:30 → 09:30
  if (atMatch && isTimeString(atTime)) {
    start = atTime;
    rest = rest.replace(atMatch[0], ' ');
  }

  rest = rest.replace(TAG, (whole, leadingSpace: string, word: string) => {
    const candidate = word.toLowerCase();
    if (!isSource(candidate)) return whole; // not a source tag — keep it in the title
    source = candidate;
    return leadingSpace;
  });

  rest = rest.replace(QUADRANT_TAG, (_whole, leadingSpace: string, digit: string) => {
    placement = QUADRANTS[Number(digit) - 1];
    return leadingSpace;
  });

  const title = rest.replace(/\s+/g, ' ').trim();
  return { title, source, url, placement, dueDate, scheduledDate, start };
}

function withDefaults(parts: LineParts, defaults: Defaults, today: string | null): CaptureResult {
  const url = parts.url ?? defaults.url;
  // Source: an explicit #tag on the line, then the line's own link, then
  // the block's defaults, then "manual".
  const source =
    parts.source ?? (parts.url ? sourceFromUrl(parts.url) : null) ?? defaults.source ?? (url ? sourceFromUrl(url) : null) ?? 'manual';
  return {
    title: parts.title,
    source,
    url,
    placement: parts.placement ?? defaults.placement ?? 'untriaged',
    dueDate: parts.dueDate ?? defaults.dueDate,
    ...schedule(parts.scheduledDate ?? defaults.scheduledDate, parts.start ?? defaults.start, today),
  };
}

/** A time with no day lands on today; with no today either, it's ignored. */
function schedule(date: string | null, start: string | null, today: string | null): Pick<CaptureResult, 'scheduledDate' | 'slot'> {
  const day = date ?? (start ? today : null);
  return { scheduledDate: day, slot: day && start ? { start, minutes: AT_MINUTES } : null };
}
