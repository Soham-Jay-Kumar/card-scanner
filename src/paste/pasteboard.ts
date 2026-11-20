/**
 * Layer 1 of the phone paste fix: write the Mac clipboard directly.
 *
 * Chrome rewrites HTML when a page writes to the clipboard, so the local server
 * talks to NSPasteboard itself through osascript. Card data only ever travels
 * over stdin and stdout as base64, so it is never interpolated into a script or
 * shell command, and it never lands in a temporary file.
 */
import { execFile } from 'node:child_process';
import type { ClipboardPayload } from '../shared/contracts.ts';

const WRITE_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');
function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const text = $.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding);
  const parts = text.componentsSeparatedByString('\n');
  const html = $.NSData.alloc.initWithBase64EncodedStringOptions(parts.objectAtIndex(0), 0);
  const plain = $.NSData.alloc.initWithBase64EncodedStringOptions(parts.objectAtIndex(1), 0);
  if (html.isNil() || plain.isNil()) throw new Error('Clipboard data could not be decoded.');
  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  if (!pasteboard.setDataForType(html, 'public.html')) throw new Error('The clipboard refused the HTML.');
  if (!pasteboard.setDataForType(plain, 'public.utf8-plain-text')) throw new Error('The clipboard refused the text.');
}
`;

const READ_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');
function run() {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  const output = $.NSFileHandle.fileHandleWithStandardOutput;
  const newline = $.NSString.stringWithString('\n').dataUsingEncoding($.NSUTF8StringEncoding);
  for (const type of ['public.html', 'public.utf8-plain-text']) {
    const data = pasteboard.dataForType(type);
    if (!data.isNil()) output.writeData(data.base64EncodedDataWithOptions(0));
    output.writeData(newline);
  }
}
`;

/** Runs a JXA script, sends stdin to it and resolves with its stdout. */
export type OsascriptRunner = (script: string, stdin: string) => Promise<string>;

const OSASCRIPT_TIMEOUT_MS = 60_000;
/** Far above a 1,000-row payload, which is a few megabytes of base64. */
const OSASCRIPT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export const runOsascript: OsascriptRunner = (script, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script],
      { timeout: OSASCRIPT_TIMEOUT_MS, maxBuffer: OSASCRIPT_MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
    // A script that dies early closes stdin. The exit error above reports that.
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPasteboard(run: OsascriptRunner = runOsascript) {
  async function readBytes(): Promise<{ html: Buffer; plain: Buffer }> {
    const output = await run(READ_SCRIPT, '');
    const [html = '', plain = ''] = output.split('\n');
    return { html: Buffer.from(html, 'base64'), plain: Buffer.from(plain, 'base64') };
  }

  async function readClipboard(): Promise<ClipboardPayload> {
    const { html, plain } = await readBytes();
    return { html: html.toString('utf8'), plain: plain.toString('utf8') };
  }

  /** Writes both formats, then reads them back in a separate process and compares every byte. */
  async function writeClipboard(payload: ClipboardPayload): Promise<{ verified: boolean; detail: string }> {
    const html = Buffer.from(payload.html, 'utf8');
    const plain = Buffer.from(payload.plain, 'utf8');

    try {
      await run(WRITE_SCRIPT, `${html.toString('base64')}\n${plain.toString('base64')}\n`);
    } catch (error) {
      return { verified: false, detail: `Could not write to the Mac clipboard: ${describe(error)}` };
    }

    let readBack: { html: Buffer; plain: Buffer };
    try {
      readBack = await readBytes();
    } catch (error) {
      return { verified: false, detail: `Wrote the Mac clipboard but could not read it back: ${describe(error)}` };
    }

    const mismatched = [
      ...(html.equals(readBack.html) ? [] : [`HTML (wrote ${html.length} bytes, read ${readBack.html.length})`]),
      ...(plain.equals(readBack.plain) ? [] : [`text (wrote ${plain.length} bytes, read ${readBack.plain.length})`]),
    ];
    if (mismatched.length > 0) {
      return { verified: false, detail: `The Mac clipboard did not match what was written: ${mismatched.join(' and ')}.` };
    }
    return {
      verified: true,
      detail: `The Mac clipboard holds ${html.length} bytes of HTML and ${plain.length} bytes of text, and both match exactly.`,
    };
  }

  return { readClipboard, writeClipboard };
}
