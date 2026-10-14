// The inbox folder (backlog 3.2, 3.3). See docs/DECISIONS.md, D9.
//
// Any .md or .txt file dropped into the inbox folder is read as a capture
// block (the same format as pasting several lines into the capture box —
// see src/capture.ts), its tasks are added, and the file is moved into
// inbox/processed/ so it's never read twice.
//
// This is how tasks reach the app when it isn't the thing you're looking at:
// a Claude session working on your computer can write a file here, or you
// can save one from your phone into the synced folder. The app doesn't need
// to be running at the time — files wait until the next sync.

import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parseCaptureBlock } from '../capture.ts';
import type { TaskService } from '../tasks.ts';

export interface InboxResult {
  files: number;
  created: number;
  skipped: number;
  problems: string[];
}

const EXTENSIONS = new Set(['.md', '.txt']);

export async function processInbox(folder: string, service: TaskService, now: Date = new Date()): Promise<InboxResult> {
  const result: InboxResult = { files: 0, created: 0, skipped: 0, problems: [] };
  await mkdir(folder, { recursive: true });
  const processed = join(folder, 'processed');

  const entries = await readdir(folder, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const path = join(folder, entry.name);
    try {
      const lines = parseCaptureBlock(await readFile(path, 'utf8'));
      const added = await service.captureMany(lines);
      result.files++;
      result.created += added.created.length;
      result.skipped += added.skipped;

      // Move it out of the way, stamped so two files with the same name
      // can't collide: processed/2026-10-14T10-42-05-claude.md
      await mkdir(processed, { recursive: true });
      const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
      await rename(path, join(processed, `${stamp}-${entry.name}`));
    } catch (error) {
      // A bad title (say, an empty line with just "!1") throws partway; the
      // file stays put so nothing is lost, and the problem is reported.
      result.problems.push(`${entry.name}: ${(error as Error).message}`);
    }
  }
  return result;
}
