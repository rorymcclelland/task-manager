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
// List markers (-, *, •, 1.) and empty checkboxes are stripped. A line with
// shortcuts but no title sets defaults for the lines after it.

import { isDateString, isSource, type Source } from './model.ts';
import { QUADRANTS, type Placement } from './priority.ts';

export interface CaptureResult {
  title: string;
  source: Source;
  url: string | null;
  placement: Placement;
  dueDate: string | null;
}

/** What one line said, before defaults are filled in. Null = not mentioned. */
interface LineParts {
  title: string;
  source: Source | null;
  url: string | null;
  placement: Placement | null;
  dueDate: string | null;
}

const TAG = /(^|\s)#([a-z]+)(?=\s|$)/gi;
const QUADRANT_TAG = /(^|\s)!([1-4])(?=\s|$)/g;
const DUE = /(^|\s)due:(\S+)(?=\s|$)/i;
const URL = /(^|\s)((?:https?|lunatask):\/\/\S+)/i;
const LIST_MARKER = /^(?:[-*•]|\d+[.)])\s+/;
const OPEN_CHECKBOX = /^\[ \]\s+/;
const TICKED_CHECKBOX = /^(?:[-*•]|\d+[.)])?\s*\[[xX]\]\s+/;

/** Parse one line of capture text. */
export function parseCapture(text: string): CaptureResult {
  return withDefaults(parseLine(text), { source: null, url: null, placement: null, dueDate: null });
}

/** Parse several lines. Returns one result per task line, in order. */
export function parseCaptureBlock(text: string): CaptureResult[] {
  const results: CaptureResult[] = [];
  let defaults: Omit<LineParts, 'title'> = { source: null, url: null, placement: null, dueDate: null };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || TICKED_CHECKBOX.test(line)) continue;

    const parts = parseLine(line.replace(LIST_MARKER, '').replace(OPEN_CHECKBOX, ''));
    if (!parts.title) {
      // A header line: shortcuts with no title set defaults for what follows.
      defaults = {
        source: parts.source ?? defaults.source,
        url: parts.url ?? defaults.url,
        placement: parts.placement ?? defaults.placement,
        dueDate: parts.dueDate ?? defaults.dueDate,
      };
      continue;
    }
    results.push(withDefaults(parts, defaults));
  }
  return results;
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
  return { title, source, url, placement, dueDate };
}

function withDefaults(parts: LineParts, defaults: Omit<LineParts, 'title'>): CaptureResult {
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
  };
}
