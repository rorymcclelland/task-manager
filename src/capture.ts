// Quick capture (backlog 1.3): turn one line of typed text into a new task.
//
// The capture box accepts plain text plus two optional shortcuts, so a task
// can be added — with its source — in a single line:
//
//   Send Sarah the budget draft #claude https://claude.ai/chat/abc123
//   └──────── title ─────────┘ └source┘ └──────── link ──────────────┘
//
// - `#claude`, `#gemini`, `#lunatask`, `#local` or `#manual` sets the source.
//   Anything else starting with # is left in the title untouched.
// - The first http(s) link becomes the task's source link.
//
// Both can go anywhere in the line. With neither, the source is "manual".

import { isSource, type Source } from './model.ts';

export interface CaptureResult {
  title: string;
  source: Source;
  url: string | null;
}

const TAG = /(^|\s)#([a-z]+)(?=\s|$)/gi;
const URL = /(^|\s)(https?:\/\/\S+)/i;

export function parseCapture(text: string): CaptureResult {
  let rest = text;
  let source: Source = 'manual';
  let url: string | null = null;

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

  const title = rest.replace(/\s+/g, ' ').trim();
  return { title, source, url };
}
