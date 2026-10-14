// Quick capture (backlog 1.3): turn one line of typed text into a new task.
//
// The capture box accepts plain text plus two optional shortcuts, so a task
// can be added — with its source — in a single line:
//
//   Send Sarah the budget draft #claude !1 https://claude.ai/chat/abc123
//   └──────── title ─────────┘ └source┘ └┘ └──────── link ──────────────┘
//                                   quadrant
//
// - `#claude`, `#gemini`, `#lunatask`, `#local` or `#manual` sets the source.
//   Anything else starting with # is left in the title untouched.
// - `!1` `!2` `!3` `!4` places it on the matrix: Do now, Schedule, Delegate,
//   Drop/defer — the same numbers as the keyboard shortcuts.
// - The first http(s) link becomes the task's source link.
//
// All can go anywhere in the line. With none, the source is "manual" and the
// task waits in "Not placed yet".

import { isSource, type Source } from './model.ts';
import { QUADRANTS, type Placement } from './priority.ts';

export interface CaptureResult {
  title: string;
  source: Source;
  url: string | null;
  placement: Placement;
}

const TAG = /(^|\s)#([a-z]+)(?=\s|$)/gi;
const QUADRANT_TAG = /(^|\s)!([1-4])(?=\s|$)/g;
const URL = /(^|\s)(https?:\/\/\S+)/i;

export function parseCapture(text: string): CaptureResult {
  let rest = text;
  let source: Source = 'manual';
  let url: string | null = null;
  let placement: Placement = 'untriaged';

  const urlMatch = rest.match(URL);
  if (urlMatch) {
    url = urlMatch[2];
    rest = rest.replace(urlMatch[0], ' ');
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
  return { title, source, url, placement };
}
