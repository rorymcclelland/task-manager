// The review (backlog 5.2): what needs a decision, in the order it's worth
// deciding. See docs/DECISIONS.md, D15.
//
// A review is a short queue of cards, one task each. Every task appears at
// most once, under the first reason that applies, because one decision
// usually settles all of them — placing an unplaced task that's also idle
// deals with both.
//
// Pure, like priority.ts: give it prioritised open tasks and the settings,
// get back the queue.

import type { PrioritisedTask, PrioritySettings } from './priority.ts';

/** Why a task is in the review, in the order they're asked about. */
export const REVIEW_REASONS = ['untriaged', 'unnamed', 'overdue', 'missed', 'stale', 'overload'] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export interface ReviewItem {
  task: PrioritisedTask;
  /** The first reason, which decides where it sits in the queue. */
  reason: ReviewReason;
  /** Every reason that applies, so the card can mention the others. */
  reasons: ReviewReason[];
}

export interface ReviewQueue {
  items: ReviewItem[];
  /** How many tasks each reason applies to (counting every reason). */
  counts: Record<ReviewReason, number>;
}

/** Every reason that applies to one open task on `today`. */
export function reasonsFor(task: PrioritisedTask, today: string, doNowOverloaded: boolean): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  const unnamed = !!task.mirror?.placeholderTitle;
  // An unnamed Lunatask task is asked to be named first; it can be placed
  // once you know what it is.
  if (task.priority.placement === 'untriaged' && !unnamed) reasons.push('untriaged');
  if (unnamed) reasons.push('unnamed');
  if (task.dueDate && task.dueDate < today) reasons.push('overdue');
  if (task.scheduledDate && task.scheduledDate < today) reasons.push('missed');
  if (task.priority.stale) reasons.push('stale');
  if (doNowOverloaded && task.priority.placement === 'do') reasons.push('overload');
  return reasons;
}

/**
 * The queue, in order: unplaced, unnamed, overdue, planned for a day that's
 * gone, idle, and — if "Do now" is over its limit — what's in "Do now".
 * Within each reason: the matrix's order (Do now first), then oldest first.
 */
export function buildReviewQueue(open: PrioritisedTask[], today: string, settings: PrioritySettings): ReviewQueue {
  const doNow = open.filter((t) => t.priority.placement === 'do').length;
  const overloaded = doNow > settings.doNowLimit;
  const counts = Object.fromEntries(REVIEW_REASONS.map((r) => [r, 0])) as Record<ReviewReason, number>;

  const items: ReviewItem[] = [];
  for (const task of open) {
    if (task.status !== 'open') continue;
    const reasons = reasonsFor(task, today, overloaded);
    for (const r of reasons) counts[r]++;
    if (reasons.length) items.push({ task, reason: reasons[0], reasons });
  }

  items.sort(
    (a, b) =>
      REVIEW_REASONS.indexOf(a.reason) - REVIEW_REASONS.indexOf(b.reason) ||
      PLACEMENTS.indexOf(a.task.priority.placement) - PLACEMENTS.indexOf(b.task.priority.placement) ||
      a.task.createdAt.localeCompare(b.task.createdAt),
  );
  return { items, counts };
}

const PLACEMENTS = ['do', 'schedule', 'delegate', 'eliminate', 'untriaged'];
