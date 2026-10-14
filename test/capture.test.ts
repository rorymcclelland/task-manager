import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture, parseCaptureBlock, sourceFromUrl } from '../src/capture.ts';

test('plain text becomes a manual task', () => {
  assert.deepEqual(parseCapture('  Renew   car insurance '), {
    title: 'Renew car insurance',
    source: 'manual',
    url: null,
    placement: 'untriaged',
    dueDate: null,
  });
});

test('a source tag sets the source and is removed from the title', () => {
  assert.deepEqual(parseCapture('Send Sarah the budget #claude'), {
    title: 'Send Sarah the budget',
    source: 'claude',
    url: null,
    placement: 'untriaged',
    dueDate: null,
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
    dueDate: null,
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

// ---- Phase 3: due dates, links that name their source, pasted blocks --------

test('due:YYYY-MM-DD sets a due date; anything else after due: stays in the title', () => {
  const result = parseCapture('Send invoice due:2026-10-20 !1');
  assert.equal(result.title, 'Send invoice');
  assert.equal(result.dueDate, '2026-10-20');
  assert.equal(parseCapture('Agree due:friday with Sam').title, 'Agree due:friday with Sam');
});

test('a link says where the task came from when there is no #tag', () => {
  assert.equal(parseCapture('Reply to Ann https://claude.ai/chat/1').source, 'claude');
  assert.equal(parseCapture('Reply to Ann https://gemini.google.com/app/2').source, 'gemini');
  assert.equal(parseCapture('Reply to Ann https://g.co/gemini/share/3').source, 'gemini');
  assert.equal(parseCapture('Reply to Ann https://example.com/x').source, 'manual');
  // An explicit tag beats the link.
  assert.equal(parseCapture('Reply #local https://claude.ai/chat/1').source, 'local');
});

test('sourceFromUrl knows Lunatask links and ignores look-alikes', () => {
  assert.equal(sourceFromUrl('lunatask://tasks/abc'), 'lunatask');
  assert.equal(sourceFromUrl('https://claude.ai.evil.example/chat'), null);
  assert.equal(sourceFromUrl('not a link'), null);
});

test('a pasted block: header line sets defaults, list markers go, ticked lines are skipped', () => {
  const block = [
    '#claude https://claude.ai/chat/abc',
    '- Send Sarah the budget !1',
    '* [ ] Book the venue due:2026-11-02',
    '- [x] Already sorted',
    '',
    '2. Draft agenda #gemini',
  ].join('\n');
  const results = parseCaptureBlock(block);
  assert.deepEqual(results.map((r) => r.title), ['Send Sarah the budget', 'Book the venue', 'Draft agenda']);
  assert.equal(results[0].source, 'claude');
  assert.equal(results[0].url, 'https://claude.ai/chat/abc');
  assert.equal(results[0].placement, 'do');
  assert.equal(results[1].dueDate, '2026-11-02');
  assert.equal(results[1].placement, 'untriaged');
  assert.equal(results[2].source, 'gemini'); // its own tag wins over the header
  assert.equal(results[2].url, 'https://claude.ai/chat/abc');
});

test('a header link alone is enough to set the source for the block', () => {
  const results = parseCaptureBlock('https://gemini.google.com/app/xyz\r\nCall the bank\r\nRenew domain');
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.source === 'gemini' && r.url === 'https://gemini.google.com/app/xyz'));
});

test('a block with no task lines gives nothing', () => {
  assert.deepEqual(parseCaptureBlock('#claude\n\n- [x] done'), []);
});
