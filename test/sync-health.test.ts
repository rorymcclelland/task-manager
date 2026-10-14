import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthOf } from '../src/sync-runner.ts';

const NOW = new Date('2026-10-14T12:00:00Z');
const base = {
  label: 'Lunatask',
  configured: true,
  lastRun: null,
  lastSuccessAt: null,
  failures: 0,
  startedAt: '2026-10-14T11:58:00Z',
  intervalMinutes: 15,
  now: NOW,
};
const ok = (at: string, warnings: string[] = []) => ({ at, ok: true, summary: 'nothing new', warnings, error: null });

test('5.3 — not set up, waiting, fine, or fine with warnings', () => {
  assert.equal(healthOf({ ...base, configured: false }).health, 'off');
  assert.equal(healthOf(base).health, 'pending');
  assert.equal(healthOf({ ...base, lastRun: ok('2026-10-14T11:58:30Z'), lastSuccessAt: '2026-10-14T11:58:30Z' }).health, 'ok');
  assert.equal(healthOf({ ...base, lastRun: ok('2026-10-14T11:58:30Z', ['x']), lastSuccessAt: '2026-10-14T11:58:30Z' }).health, 'warn');
});

test('5.3 — a failed sync is an error, with a sentence for the banner', () => {
  const result = healthOf({
    ...base,
    lastRun: { at: '2026-10-14T11:59:00Z', ok: false, summary: '', warnings: [], error: 'Lunatask rejected the access token.' },
    lastSuccessAt: null,
    failures: 3,
  });
  assert.equal(result.health, 'error');
  assert.match(result.problem!, /^Lunatask hasn't synced since the app started \(3 tries in a row\): Lunatask rejected the access token\. What's shown from it may be out of date\.$/);
});

test('5.3 — no success for over two intervals is stale, even with no failure to show', () => {
  // Last worked 40 minutes ago, every 15 minutes: grace is 2×15+5 = 35.
  const result = healthOf({ ...base, lastRun: ok('2026-10-14T11:20:00Z'), lastSuccessAt: '2026-10-14T11:20:00Z', startedAt: '2026-10-14T09:00:00Z' });
  assert.equal(result.health, 'stale');
  assert.match(result.problem!, /should every 15 minutes/);
  // A first sync that never finishes counts too.
  assert.equal(healthOf({ ...base, startedAt: '2026-10-14T11:00:00Z' }).health, 'stale');
});

test('5.3 — with syncing only on request, nothing is ever stale', () => {
  assert.equal(healthOf({ ...base, intervalMinutes: 0, startedAt: '2026-10-01T00:00:00Z' }).health, 'pending');
});
