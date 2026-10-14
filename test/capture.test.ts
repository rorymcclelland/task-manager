import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture } from '../src/capture.ts';

test('plain text becomes a manual task', () => {
  assert.deepEqual(parseCapture('  Renew   car insurance '), {
    title: 'Renew car insurance',
    source: 'manual',
    url: null,
  });
});

test('a source tag sets the source and is removed from the title', () => {
  assert.deepEqual(parseCapture('Send Sarah the budget #claude'), {
    title: 'Send Sarah the budget',
    source: 'claude',
    url: null,
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
  });
  assert.equal(parseCapture('Plan #offsite agenda').title, 'Plan #offsite agenda');
});
