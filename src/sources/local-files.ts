// Files on this computer (backlog 3.4). See docs/DECISIONS.md, D10.
//
// Looks through the folders you list in LOCAL_FOLDERS for Markdown and text
// files, and treats two kinds of line as a task:
//
//   - [ ] Write up the interview notes        ← an unticked checkbox
//   TODO: chase Mark about the invoice        ← a TODO
//
// A ticked checkbox (- [x]) with the same text means it's done. A line that
// disappears from a file that's still there counts as done too — deleting a
// TODO is the most common way people tick one off. A file that has gone or
// can't be read changes nothing (it may just be mid-sync or moved).
//
// Only .md and .txt files: code is full of TODO comments that aren't
// personal tasks. Hidden folders (.git, .obsidian) and node_modules are
// skipped, and so is the app's own inbox folder.
//
// Read-only: files are never changed.

import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { SourceItem } from '../sync.ts';
import { readTextFile } from './text-file.ts';

export interface LocalScanOptions {
  /** Folders to leave out entirely (the inbox, for one). */
  skip?: string[];
  /** How many folders deep to look. */
  maxDepth?: number;
  /** Stop after this many files, so pointing it at a huge folder can't hang the app. */
  maxFiles?: number;
}

export interface LocalScanResult {
  items: SourceItem[];
  /** Files that were read successfully. Only tasks from these can be
   *  treated as gone. */
  filesRead: Set<string>;
  /** Folders or files that couldn't be read, with why. */
  problems: string[];
  filesScanned: number;
  hitFileLimit: boolean;
}

const EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const MAX_FILE_BYTES = 1_000_000;
const OPEN_BOX = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.+)$/;
const TICKED_BOX = /^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]\s+(.+)$/;
const TODO = /(?:^|\s|[-*+]\s)TODO\b[:\s-]\s*(.+)$/;

/** Separator between file path and line text in a task's externalId. */
const ID_SEPARATOR = ' :: ';

export async function scanLocalFolders(folders: string[], options: LocalScanOptions = {}): Promise<LocalScanResult> {
  const skip = new Set((options.skip ?? []).map((p) => resolve(p).toLowerCase()));
  const maxDepth = options.maxDepth ?? 4;
  const maxFiles = options.maxFiles ?? 2000;
  const result: LocalScanResult = { items: [], filesRead: new Set(), problems: [], filesScanned: 0, hitFileLimit: false };

  const files: string[] = [];
  for (const folder of folders) {
    await collectFiles(resolve(folder), 0, { skip, maxDepth, maxFiles, files, result });
  }

  for (const file of files) {
    try {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) continue;
      const text = await readTextFile(file); // UTF-8 or UTF-16 (Q4)
      result.filesRead.add(file);
      result.items.push(...tasksInFile(file, text));
    } catch (error) {
      result.problems.push(`${file}: ${(error as Error).message}`);
    }
  }
  result.filesScanned = files.length;
  return result;
}

/** The tasks in one file's text. Exported for tests. */
export function tasksInFile(file: string, text: string): SourceItem[] {
  // One entry per distinct line text; if the same text is both ticked and
  // unticked in a file, unticked wins (something's still open).
  const found = new Map<string, SourceItem>();
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    let title: string | null = null;
    let open = true;

    const ticked = line.match(TICKED_BOX);
    const box = line.match(OPEN_BOX);
    const todo = line.match(TODO);
    if (ticked) {
      title = ticked[1];
      open = false;
    } else if (box) {
      title = box[1];
    } else if (todo) {
      title = todo[1];
    }
    if (!title) return;

    title = title.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!title) return;
    const externalId = localId(file, title);
    const previous = found.get(externalId);
    if (previous && previous.open) return;

    found.set(externalId, {
      externalId,
      title,
      url: null, // browsers won't open file:// links from a web page; the path is in the detail
      open,
      detail: `${file}, line ${index + 1}`,
    });
  });

  return [...found.values()];
}

/** Stable ID for a line: the file plus the line's text (not its line number,
 *  which shifts whenever anything above it changes). */
export function localId(file: string, title: string): string {
  return `${file}${ID_SEPARATOR}${title.toLowerCase()}`;
}

/** The file part of a local task's externalId. */
export function fileOfLocalId(externalId: string): string {
  const at = externalId.indexOf(ID_SEPARATOR);
  return at === -1 ? externalId : externalId.slice(0, at);
}

interface Walk {
  skip: Set<string>;
  maxDepth: number;
  maxFiles: number;
  files: string[];
  result: LocalScanResult;
}

async function collectFiles(folder: string, depth: number, walk: Walk): Promise<void> {
  if (walk.skip.has(folder.toLowerCase())) return;
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    walk.result.problems.push(`${folder}: ${(error as Error).message}`);
    return;
  }

  for (const entry of entries) {
    if (walk.files.length >= walk.maxFiles) {
      walk.result.hitFileLimit = true;
      return;
    }
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (depth < walk.maxDepth) await collectFiles(path, depth + 1, walk);
    } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      walk.files.push(path);
    }
  }
}
