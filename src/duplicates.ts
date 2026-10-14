// Duplicate suggestions (backlog 1.5). See docs/DECISIONS.md, D4.
//
// Pure functions only — no storage, no HTTP — so the matching rules can be
// tested and tuned in isolation.

import type { Task } from './model.ts';

/** Words too common to say anything about what a task is. */
const FILLER = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'and', 'or', 'on', 'in', 'at', 'by',
  'from', 'with', 'about', 're', 'my', 'me', 'i', 'is', 'it', 'this', 'that',
  'up', 'some', 'into', 'be',
]);

/** Reduce a title to its set of meaningful words. */
export function meaningfulWords(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 0 && !FILLER.has(word))
    // Crude plural folding so "invoices" matches "invoice". Words of 3 letters
    // or fewer are left alone ("bus", "gas").
    .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
  return new Set(words);
}

/**
 * How alike two titles are, from 0 (nothing shared) to 1 (same words).
 * Returns 0 when the titles aren't similar enough to suggest.
 */
export function similarity(titleA: string, titleB: string): number {
  const a = meaningfulWords(titleA);
  const b = meaningfulWords(titleB);
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  const union = a.size + b.size - shared;
  const overlap = shared / union;

  // Rule 1: most of the words are shared.
  if (overlap >= 0.6) return overlap;

  // Rule 2: every word of the shorter title appears in the longer one
  // ("Book dentist" vs "Book dentist appointment for October"). Needs at
  // least two words, or a single common word like "email" would match
  // half the list.
  const smaller = Math.min(a.size, b.size);
  if (smaller >= 2 && shared === smaller) return Math.max(overlap, 0.6);

  return 0;
}

export interface DuplicatePair {
  a: Task;
  b: Task;
  score: number;
}

/** Likely duplicate pairs among open tasks, most similar first. */
export function findDuplicatePairs(tasks: Task[]): DuplicatePair[] {
  // Tasks still waiting for a real name ("Unnamed Lunatask task") all look
  // alike, so leave them out until they've been named.
  const open = tasks.filter((t) => t.status === 'open' && !t.mirror?.placeholderTitle);
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i];
      const b = open[j];
      if (a.notDuplicateOf.includes(b.id) || b.notDuplicateOf.includes(a.id)) continue;
      const score = similarity(a.title, b.title);
      if (score > 0) pairs.push({ a, b, score });
    }
  }

  return pairs.sort((x, y) => y.score - x.score);
}
