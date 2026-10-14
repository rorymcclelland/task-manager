import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture } from '../src/capture.ts';

test('plain text becomes a manual task', () => {
  assert.deepEqual(parseCapture('  Renew   car insurance '), {
    title: 'Renew car insurance',
    source: 'manual',
    url: null,
    placement: 'untriaged',
  });
});

test('a source tag sets the source and is removed from the title', () => {
  assert.deepEqual(parseCapture('Send Sarah the budget #claude'), {
    title: 'Send Sarah the budget',
    source: 'claude',
    url: null,
    placement: 'untriaged',
  });
});

test('tags are case-insensitive and can go anywhere', () => {
  assert.equal(parseCapture('#Gemini summarise report').source, 'gemini');
  assert.equal(parseCapture('#Gemini summarise report').title, 'summarise report');
});

test('a link becomes the source link', () => {
  const result = parseCapture('Draft reply https://claude.ai/chat/abc123 #claude');
  assert.equal(result.title, 'Draft reply');
  assert.equal(result.url, 'https://claude.ai/chat/abc123');
  assert.equal(result.source, 'claude');
});

test('unknown hashtags stay in the title', () => {
  assert.deepEqual(parseCapture('Fix bug #42 in exporter'), {
    title: 'Fix bug #42 in exporter',
    source: 'manual',
    url: null,
    placement: 'untriaged',
  });
  assert.equal(parseCapture('Plan #offsite agenda').title, 'Plan #offsite agenda');
});

test('!1–!4 place the task on the matrix and are removed from the title', () => {
  assert.equal(parseCapture('Pay VAT !1').placement, 'do');
  assert.equal(parseCapture('!2 Plan Q1 roadmap').placement, 'schedule');
  assert.equal(parseCapture('Book room !3 #claude').placement, 'delegate');
  assert.equal(parseCapture('Tidy downloads !4').title, 'Tidy downloads');
});

test('an exclamation mark that is not !1–!4 stays in the title', () => {
  assert.equal(parseCapture('Call Mum!').title, 'Call Mum!');
  assert.equal(parseCapture('Fix bug !5').title, 'Fix bug !5');
  assert.equal(parseCapture('Fix bug !5').placement, 'untriaged');
});
