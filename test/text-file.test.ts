import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeText, NotTextError } from '../src/sources/text-file.ts';

const LINES = '- Send the deck !1\r\n- Book the room\r\n';

test('Q4 — UTF-8, with or without a byte-order mark', () => {
  assert.equal(decodeText(Buffer.from(LINES, 'utf8')), LINES);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LINES, 'utf8')])), LINES);
});

test('Q4 — UTF-16 as Windows PowerShell 5 writes it (little-endian, with BOM)', () => {
  assert.equal(decodeText(Buffer.from('﻿' + LINES, 'utf16le')), LINES);
});

test('Q4 — UTF-16 big-endian', () => {
  const le = Buffer.from('﻿' + LINES + 'é🎉', 'utf16le');
  const be = Buffer.from(le);
  be.swap16();
  assert.equal(decodeText(be), LINES + 'é🎉');
});

test('Q4 — something that still isn\'t text is refused, not imported', () => {
  assert.throws(() => decodeText(Buffer.from(LINES, 'utf16le')), NotTextError); // UTF-16 with no BOM
  assert.throws(() => decodeText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), NotTextError); // a zip file
});
