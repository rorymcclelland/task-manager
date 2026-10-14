import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture, parseCaptureBlock, parseCaptureLines, sourceFromUrl } from '../src/capture.ts';

test('plain text becomes a manual task', () => {
  assert.deepEqual(parseCapture('  Renew   car insurance '), {
    title: 'Renew car insurance',
    source: 'manual',
    url: null,
    placement: 'untriaged',
    dueDate: null,
    scheduledDate: null,
    slot: null,
  });
});

test('a source tag sets the source and is removed from the title', () => {
  assert.deepEqual(parseCapture('Send Sarah the budget #claude'), {
    title: 'Send Sarah the budget',
    source: 'claude',
    url: null,
    placement: 'untriaged',
    dueDate: null,
    scheduledDate: null,
    slot: null,
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
    scheduledDate: null,
    slot: null,
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

// ---- Phase 4: on: and at: ------------------------------------------------------

test('4.2 — on: schedules a day, at: adds a 30-minute slot', () => {
  const result = parseCapture('Call the bank on:2026-10-16 at:9:30', '2026-10-14');
  assert.equal(result.title, 'Call the bank');
  assert.equal(result.scheduledDate, '2026-10-16');
  assert.deepEqual(result.slot, { start: '09:30', minutes: 30 });
});

test('4.2 — at: with no on: means today; with no today known, no slot', () => {
  assert.equal(parseCapture('Ring Mum at:18:00', '2026-10-14').scheduledDate, '2026-10-14');
  assert.deepEqual(parseCapture('Ring Mum at:18:00').slot, null);
  assert.equal(parseCapture('Ring Mum at:18:00').title, 'Ring Mum');
});

test('4.2 — nonsense times and dates stay in the title', () => {
  const result = parseCapture('Meet at:25:00 on:next-week', '2026-10-14');
  assert.equal(result.title, 'Meet at:25:00 on:next-week');
  assert.equal(result.slot, null);
});

test('4.2 — a block header can set the day for every line', () => {
  const [a, b] = parseCaptureBlock('#claude on:2026-10-20\n- Draft the deck at:10:00\n- Book the room', '2026-10-14');
  assert.equal(a.scheduledDate, '2026-10-20');
  assert.deepEqual(a.slot, { start: '10:00', minutes: 30 });
  assert.equal(b.scheduledDate, '2026-10-20');
  assert.equal(b.slot, null);
});

// ---- Phase 6 -------------------------------------------------------------------

test('Q7 — a stray "- !1" mid-list is skipped and reported, not applied to what follows', () => {
  const { tasks, ignored } = parseCaptureLines('- Good line\n- !1\n- Another good line');
  assert.deepEqual(tasks.map((t) => [t.title, t.placement]), [['Good line', 'untriaged'], ['Another good line', 'untriaged']]);
  assert.deepEqual(ignored, [2]);
});

test('Q7 — header lines before the first task still set defaults, and a new link starts a new section', () => {
  const text = '#claude\n!2\n- One\nhttps://gemini.google.com/app/x\n- Two';
  const { tasks, ignored } = parseCaptureLines(text);
  assert.deepEqual(tasks.map((t) => [t.title, t.source, t.placement, t.url]), [
    ['One', 'claude', 'schedule', null],
    ['Two', 'gemini', 'untriaged', 'https://gemini.google.com/app/x'],
  ]);
  assert.deepEqual(ignored, []);
});
