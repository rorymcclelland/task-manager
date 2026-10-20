import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicatePairs, meaningfulWords, similarity } from '../src/duplicates.ts';
import type { Task } from '../src/model.ts';

function task(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id, title, notes: '',
    origin: { source: 'manual', externalId: null, url: null },
    alsoIn: [], important: null, urgent: null, dueDate: null, scheduledDate: null,
    status: 'open', mergedInto: null, notDuplicateOf: [],
    createdAt: '2026-10-14T09:00:00.000Z', updatedAt: '2026-10-14T09:00:00.000Z', closedAt: null,
    ...extra,
  };
}

test('filler words, punctuation and simple plurals are ignored', () => {
  assert.deepEqual([...meaningfulWords('Send the invoices to Acme!')], ['send', 'invoice', 'acme']);
});

test('the same task worded slightly differently is a match', () => {
  assert.ok(similarity('Send invoice to Acme', 'Send Acme the invoices') > 0);
});

test('a short title contained in a longer one is a match', () => {
  assert.ok(similarity('Book dentist', 'Book dentist appointment for October') > 0);
});

test('one shared common word is not a match', () => {
  assert.equal(similarity('Email Sarah', 'Email the landlord about the boiler'), 0);
  assert.equal(similarity('Email', 'Email Sarah'), 0);
});

test('unrelated tasks are not a match', () => {
  assert.equal(similarity('Renew car insurance', 'Prepare quarterly review'), 0);
});

test('only open tasks are compared', () => {
  const pairs = findDuplicatePairs([
    task('1', 'Send invoice to Acme'),
    task('2', 'Send Acme the invoice', { status: 'done' }),
  ]);
  assert.equal(pairs.length, 0);
});

test('pairs marked "not a duplicate" are not suggested again', () => {
  const pairs = findDuplicatePairs([
    task('1', 'Send invoice to Acme', { notDuplicateOf: ['2'] }),
    task('2', 'Send Acme the invoice'),
  ]);
  assert.equal(pairs.length, 0);
});

test('closest matches come first', () => {
  const pairs = findDuplicatePairs([
    task('1', 'Book dentist appointment'),
    task('2', 'Book dentist appointment for October checkup'),
    task('3', 'Book dentist appointment'),
  ]);
  assert.equal(pairs[0].score, 1);
});
