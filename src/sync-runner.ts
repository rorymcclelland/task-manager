// Runs the source connectors and remembers how each one went, so the page
// can show "Lunatask: synced 10:42 · 2 new" or a plain error (and so a sync
// that has quietly stopped working is visible — a first step towards 5.3).
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

export interface ConnectorStatus {
  id: ConnectorId;
  label: string;
  /** False when it needs setting up before it can run. */
  configured: boolean;
  /** What to do to set it up, or where it looks once it is. */
  setup: string;
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
    return this.connectors.map((c) => ({
      id: c.id,
      label: c.label,
      configured: c.configured,
      setup: c.setup,
      lastRun: this.status.get(c.id) ?? null,
    }));
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
      } catch (error) {
        // One source failing never stops the others.
        console.error(`Sync from ${connector.label} failed:`, (error as Error).message);
        this.status.set(connector.id, { at, ok: false, summary: '', warnings: [], error: (error as Error).message });
      }
    }
    return this.statuses();
  }
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
