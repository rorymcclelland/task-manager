// Reading a text file the way Windows tools actually save them (Q4).
//
// Most tools save UTF-8, sometimes with a byte-order mark (BOM) in front —
// Notepad did by default for years. But Windows PowerShell 5, the one
// built into Windows, saves UTF-16 for `"…" > file.md` and `Out-File`, and
// reading that as UTF-8 turns every other byte into a stray null.
//
// So: look at the first bytes. A UTF-16 BOM (either byte order) means
// UTF-16; a UTF-8 BOM is dropped; anything else is read as UTF-8. If the
// result still contains null characters, it isn't text at all, and saying
// so beats importing gibberish.

import { readFile } from 'node:fs/promises';

/** The file isn't text this app can read. */
export class NotTextError extends Error {}

export async function readTextFile(path: string): Promise<string> {
  return decodeText(await readFile(path));
}

/** Exported for tests. */
export function decodeText(bytes: Buffer): string {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = bytes.subarray(2).toString('utf16le');
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16 big-endian: Node only decodes little-endian, so swap each pair.
    const body = bytes.subarray(2, bytes.length - (bytes.length % 2)); // whole pairs only
    const swapped = Buffer.from(body);
    swapped.swap16();
    text = swapped.toString('utf16le');
  } else {
    text = bytes.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  }
  if (text.includes('\u0000')) {
    throw new NotTextError("doesn't look like a text file (it may be UTF-16 without a byte-order mark, or not text at all). Save it as UTF-8 and it'll be picked up at the next sync");
  }
  return text;
}
