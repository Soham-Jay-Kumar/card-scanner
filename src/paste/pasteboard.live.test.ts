/**
 * Live Mac clipboard check. Run only as a short final check:
 *   PASTEBOARD_LIVE=1 npx vitest run src/paste/pasteboard.live.test.ts
 *
 * The user's clipboard is saved first, every item and every type, and restored
 * afterwards. If saving fails, nothing is written.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIELD_KEYS, type CardRow, type ClipboardPayload } from '../shared/contracts.ts';
import { encode } from './encode.ts';
import { createPasteboard, runOsascript } from './pasteboard.ts';
import { PHONE_CASES } from './phoneCases.ts';

type Snapshot = Array<Array<{ type: string; base64: string }>>;

const SNAPSHOT_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');
function run() {
  const items = $.NSPasteboard.generalPasteboard.pasteboardItems;
  const snapshot = [];
  const itemCount = items.isNil() ? 0 : Number(items.count);
  for (let i = 0; i < itemCount; i += 1) {
    const item = items.objectAtIndex(i);
    const types = item.types;
    const entries = [];
    for (let j = 0; j < Number(types.count); j += 1) {
      const type = types.objectAtIndex(j);
      const data = item.dataForType(type);
      if (!data.isNil()) entries.push({ type: type.js, base64: data.base64EncodedStringWithOptions(0).js });
    }
    snapshot.push(entries);
  }
  const text = $.NSString.stringWithString(JSON.stringify(snapshot));
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(text.dataUsingEncoding($.NSUTF8StringEncoding));
}
`;

const RESTORE_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');
function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const snapshot = JSON.parse($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding).js);
  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  const items = $.NSMutableArray.array;
  for (const entries of snapshot) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const { type, base64 } of entries) {
      item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(base64, 0), type);
    }
    items.addObject(item);
  }
  if (snapshot.length > 0 && !pasteboard.writeObjects(items)) throw new Error('Could not restore the clipboard.');
}
`;

/** The call Chrome makes when pasting: NSPasteboard decodes the HTML itself. */
const READ_HTML_AS_STRING_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');
function run() {
  const text = $.NSPasteboard.generalPasteboard.stringForType('public.html');
  if (text.isNil()) throw new Error('No HTML string on the clipboard.');
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(text.dataUsingEncoding($.NSUTF8StringEncoding));
}
`;

const takeSnapshot = async (): Promise<Snapshot> => JSON.parse(await runOsascript(SNAPSHOT_SCRIPT, '')) as Snapshot;

const rows: CardRow[] = Array.from({ length: 1_000 }, (_, index) => {
  const value = PHONE_CASES[index % PHONE_CASES.length]?.value ?? '';
  return { name: `山田太郎 ${index}`, position: 'तुलिका 😀', company: value, email: `p${index}@example.com`, phone: value, website: '' };
});

describe.runIf(process.env.PASTEBOARD_LIVE === '1')('live Mac clipboard', () => {
  const { readClipboard, writeClipboard } = createPasteboard();
  const payload: ClipboardPayload = encode(rows, { includeHeader: true });
  let saved: Snapshot | undefined;

  beforeAll(async () => {
    saved = await takeSnapshot();
  });

  afterAll(async () => {
    if (saved === undefined) return;
    await runOsascript(RESTORE_SCRIPT, JSON.stringify(saved));
    const restored = await takeSnapshot();
    expect(restored.length).toBe(saved.length);
    saved.forEach((entries, index) => {
      for (const entry of entries) expect(restored[index]).toContainEqual(entry);
    });
    const types = saved.reduce((sum, entries) => sum + entries.length, 0);
    console.log(`Clipboard restored and confirmed: ${saved.length} item(s), ${types} type(s).`);
  });

  it('writes 1,000 rows of mixed scripts and confirms the bytes', async () => {
    expect(FIELD_KEYS).toHaveLength(6);
    const result = await writeClipboard(payload);
    console.log(result.detail);
    expect(result.verified).toBe(true);
  });

  it('reads the same text back', async () => {
    expect(await readClipboard()).toEqual(payload);
  });

  it('decodes the HTML correctly through the call browsers use', async () => {
    expect(await runOsascript(READ_HTML_AS_STRING_SCRIPT, '')).toBe(payload.html);
  });

  it('gives another program the exact text', async () => {
    const { stdout } = await promisify(execFile)('/usr/bin/pbpaste', [], {
      env: { ...process.env, LANG: 'en_US.UTF-8' },
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(stdout).toBe(payload.plain);
  });
});
