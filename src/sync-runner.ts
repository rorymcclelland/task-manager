// Runs the source connectors and remembers how each one went, so the page
// can show "Lunatask: synced 10:42 · 2 new" or a plain error.
//
// 5.3 — a sync that has stopped working must never look like one with
// nothing new. Each source's `health` says which it is (see `healthOf`), and
// the page puts anything other than "ok" or "warn" in a banner at the top.
// See docs/DECISIONS.md, D16.
//
// Sources run one after another, never two syncs at once. A sync runs when
// the app starts, every SYNC_EVERY_MINUTES, and when you press "Sync now".
// The status lives in memory only: it's about this run of the app, and
// keeping it out of tasks.json means the file isn't rewritten just to say
// "still nothing new".

import type { Calendars } from './sources/calendar.ts';
import { fileOfLocalId, scanLocalFolders } from './sources/local-files.ts';
import { fetchLunataskItems } from './sources/lunatask.ts';
import { processInbox } from './sources/inbox.ts';
import type { TaskService } from './tasks.ts';

export interface SyncConfig {
  lunatask: { token: string | null; fetchFn?: typeof fetch };
  local: { folders: string[] };
  inbox: { folder: string };
  /** Phase 4: optional so tests that don't care about it can leave it out. */
  calendar?: Calendars;
}

export type ConnectorId = 'lunatask' | 'local' | 'inbox' | 'calendar';

/**
 * - off:     not set up
 * - pending: set up, first sync not finished yet
 * - ok:      last sync worked
 * - warn:    last sync worked, with something worth knowing (an unreadable file…)
 * - error:   last sync failed
 * - stale:   no sync has worked for over two sync intervals — it may be
 *            stuck, or the app's timer stopped; either way, don't trust it
 */
export type Health = 'off' | 'pending' | 'ok' | 'warn' | 'error' | 'stale';

export interface ConnectorStatus {
  id: ConnectorId;
  label: string;
  /** False when it needs setting up before it can run. */
  configured: boolean;
  /** What to do to set it up, or where it looks once it is. */
  setup: string;
  health: Health;
  /** One plain sentence for the banner when health is error or stale. */
  problem: string | null;
  /** When a sync last worked (since the app started). */
  lastSuccessAt: string | null;
  /** Failed syncs in a row. */
  failures: number;
  lastRun: {
    at: string;
    ok: boolean;
    /** e.g. "2 new · 1 closed" or "nothing new" */
    summary: string;
    /** Things worth knowing that didn't stop the sync (unreadable files…). */
    warnings: string[];
    error: string | null;
  } | null;
}

interface Connector {
  id: ConnectorId;
  label: string;
  configured: boolean;
  setup: string;
  run(): Promise<{ summary: string; warnings: string[] }>;
}

export class SyncRunner {
  private readonly connectors: Connector[];
  private readonly status = new Map<ConnectorId, ConnectorStatus['lastRun']>();
  private readonly lastSuccess = new Map<ConnectorId, string>();
  private readonly failures = new Map<ConnectorId, number>();
  /** Set by start(): how often syncs should happen, and since when. */
  private intervalMinutes = 0;
  private startedAt: string | null = null;
  private running: Promise<ConnectorStatus[]> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

  constructor(service: TaskService, config: SyncConfig, now: () => Date = () => new Date()) {
    this.now = now;
    const { token, fetchFn } = config.lunatask;
    const { folders } = config.local;
    const inboxFolder = config.inbox.folder;

    this.connectors = [
      {
        id: 'lunatask',
        label: 'Lunatask',
        configured: !!token,
        setup: token
          ? 'Mirrors your Lunatask tasks (read-only). Names are encrypted by Lunatask, so name each one here once.'
          : 'Not set up. Make a token in Lunatask → Settings → Access tokens, then add LUNATASK_TOKEN=… to .env and restart.',
        run: async () => {
          const { items, complete } = await fetchLunataskItems(token!, fetchFn);
          const report = await service.applySync('lunatask', items, {
            whenGone: 'dropped',
            covered: () => complete,
          });
          const warnings = complete ? [] : ['Lunatask sent what looks like part of the list, so nothing was treated as deleted.'];
          return { summary: summarise(report.created, report.updated, report.closed.length, items.filter((i) => i.open).length), warnings };
        },
      },
      {
        id: 'local',
        label: 'Files on this computer',
        configured: folders.length > 0,
        setup: folders.length
          ? `Looks for "- [ ]" and "TODO:" lines in .md and .txt files in: ${folders.join('; ')}`
          : 'Not set up. Add LOCAL_FOLDERS=C:\\path\\one;C:\\path\\two to .env and restart.',
        run: async () => {
          const scan = await scanLocalFolders(folders, { skip: [inboxFolder] });
          const report = await service.applySync('local', scan.items, {
            whenGone: 'done',
            covered: (externalId) => scan.filesRead.has(fileOfLocalId(externalId)),
          });
          const warnings = [...scan.problems];
          if (scan.hitFileLimit) warnings.push(`Stopped after ${scan.filesScanned} files — point LOCAL_FOLDERS at smaller folders.`);
          const open = scan.items.filter((i) => i.open).length;
          return { summary: summarise(report.created, report.updated, report.closed.length, open) + ` · ${scan.filesScanned} file${scan.filesScanned === 1 ? '' : 's'}`, warnings };
        },
      },
      {
        id: 'inbox',
        label: 'Inbox folder',
        configured: true,
        setup: `Drop .md or .txt files of tasks (same format as pasting into the capture box) in ${inboxFolder}`,
        run: async () => {
          const result = await processInbox(inboxFolder, service, this.now());
          const summary = result.files === 0
            ? 'empty'
            : `${result.created} new from ${result.files} file${result.files === 1 ? '' : 's'}` +
              (result.skipped ? ` · ${result.skipped} already here` : '');
          return { summary, warnings: result.problems };
        },
      },
      {
        id: 'calendar',
        label: 'Calendar',
        configured: !!config.calendar?.configured,
        setup: config.calendar?.configured
          ? 'Reads your calendar (read-only) for the Day and Ahead views. Events are never added as tasks.'
          : 'Not set up. Copy your calendar\'s private iCal (.ics) address and add CALENDAR_URLS=… to .env, then restart. See README → Calendar.',
        run: () => config.calendar!.refresh(),
      },
    ];
  }

  /** Every connector, with how its last run went. */
  statuses(): ConnectorStatus[] {
    return this.connectors.map((c) => {
      const lastRun = this.status.get(c.id) ?? null;
      const lastSuccessAt = this.lastSuccess.get(c.id) ?? null;
      const failures = this.failures.get(c.id) ?? 0;
      const { health, problem } = healthOf({
        label: c.label,
        configured: c.configured,
        lastRun,
        lastSuccessAt,
        failures,
        startedAt: this.startedAt,
        intervalMinutes: this.intervalMinutes,
        now: this.now(),
      });
      return { id: c.id, label: c.label, configured: c.configured, setup: c.setup, health, problem, lastSuccessAt, failures, lastRun };
    });
  }

  /** Run every configured connector. If a sync is already running, wait for
   *  that one rather than starting a second. */
  syncAll(): Promise<ConnectorStatus[]> {
    if (!this.running) {
      this.running = this.runAll().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /** Sync now, then every `minutes`. 0 = only when asked. */
  start(minutes: number): void {
    this.intervalMinutes = minutes;
    this.startedAt = this.now().toISOString();
    void this.syncAll();
    if (minutes > 0) {
      this.timer = setInterval(() => void this.syncAll(), minutes * 60_000);
      this.timer.unref(); // don't keep the process alive just for this
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runAll(): Promise<ConnectorStatus[]> {
    for (const connector of this.connectors) {
      if (!connector.configured) continue;
      const at = this.now().toISOString();
      try {
        const { summary, warnings } = await connector.run();
        this.status.set(connector.id, { at, ok: true, summary, warnings, error: null });
        this.lastSuccess.set(connector.id, at);
        this.failures.set(connector.id, 0);
      } catch (error) {
        // One source failing never stops the others.
        console.error(`Sync from ${connector.label} failed:`, (error as Error).message);
        this.status.set(connector.id, { at, ok: false, summary: '', warnings: [], error: (error as Error).message });
        this.failures.set(connector.id, (this.failures.get(connector.id) ?? 0) + 1);
      }
    }
    return this.statuses();
  }
}

/** A sync interval's grace: two intervals plus five minutes. */
function graceMs(intervalMinutes: number): number {
  return (2 * intervalMinutes + 5) * 60_000;
}

/**
 * How healthy one source is, and the sentence to show if it isn't. Pure, so
 * the rules can be tested with any clock.
 *
 * "Stale" catches what a failure can't: a sync that never finishes, or a
 * timer that stopped. It needs a schedule to measure against, so with
 * SYNC_EVERY_MINUTES=0 (sync only when asked) nothing is ever stale.
 */
export function healthOf(input: {
  label: string;
  configured: boolean;
  lastRun: ConnectorStatus['lastRun'];
  lastSuccessAt: string | null;
  failures: number;
  startedAt: string | null;
  intervalMinutes: number;
  now: Date;
}): { health: Health; problem: string | null } {
  const { label, lastRun, lastSuccessAt, failures, startedAt, intervalMinutes, now } = input;
  if (!input.configured) return { health: 'off', problem: null };

  const since = lastSuccessAt ? `since ${clock(lastSuccessAt)}` : 'since the app started';
  if (lastRun && !lastRun.ok) {
    const tries = failures > 1 ? ` (${failures} tries in a row)` : '';
    return {
      health: 'error',
      problem: `${label} hasn't synced ${since}${tries}: ${lastRun.error} What's shown from it may be out of date.`,
    };
  }

  const reference = lastSuccessAt ?? startedAt;
  if (intervalMinutes > 0 && reference && now.getTime() - Date.parse(reference) > graceMs(intervalMinutes)) {
    return {
      health: 'stale',
      problem: `${label} hasn't synced ${since}, though it should every ${intervalMinutes} minutes. The sync may be stuck — try Sync now, or restart the app.`,
    };
  }

  if (!lastRun) return { health: 'pending', problem: null };
  return { health: lastRun.warnings.length ? 'warn' : 'ok', problem: null };
}

/** "10:42", or "Tue 10:42" if it wasn't today. On this computer's clock. */
function clock(iso: string): string {
  const date = new Date(iso);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return time;
  return `${date.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}

function summarise(created: number, updated: number, closed: number, openThere: number): string {
  const parts: string[] = [];
  if (created) parts.push(`${created} new`);
  if (closed) parts.push(`${closed} closed`);
  if (updated) parts.push(`${updated} updated`);
  if (parts.length === 0) parts.push('nothing new');
  parts.push(`${openThere} open there`);
  return parts.join(' · ');
}
