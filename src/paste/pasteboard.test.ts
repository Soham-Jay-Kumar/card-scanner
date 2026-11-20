/**
 * The default suite never touches the real clipboard: failures are injected
 * through a fake runner. The transport tests run real osascript, but their
 * scripts only echo stdin. Live clipboard tests are in pasteboard.live.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { ClipboardPayload } from '../shared/contracts.ts';
import { createPasteboard, runOsascript, type OsascriptRunner } from './pasteboard.ts';

const payload: ClipboardPayload = {
  html: '<table><tr><td>山田太郎 तुलिका 😀 +91 98765 43210</td></tr></table>',
  plain: '山田太郎\t="+91 98765 43210"',
};

const isWrite = (script: string): boolean => script.includes('setDataForType');

/** Behaves like a real clipboard, unless a test overrides what it does. */
function fakeClipboard(overrides: { onWrite?: () => void; onRead?: (stored: string) => string } = {}) {
  let stored = '\n\n';
  const scripts: string[] = [];
  const run: OsascriptRunner = async (script, stdin) => {
    scripts.push(script);
    if (isWrite(script)) {
      overrides.onWrite?.();
      stored = stdin;
      return '';
    }
    return overrides.onRead ? overrides.onRead(stored) : stored;
  };
  return { run, scripts };
}

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

describe('writeClipboard', () => {
  it('verifies when both formats read back byte for byte', async () => {
    const { writeClipboard } = createPasteboard(fakeClipboard().run);
    const result = await writeClipboard(payload);
    expect(result.verified).toBe(true);
    expect(result.detail).toContain('both match');
  });

  it('reads back as a separate step after writing', async () => {
    const clipboard = fakeClipboard();
    await createPasteboard(clipboard.run).writeClipboard(payload);
    expect(clipboard.scripts.map(isWrite)).toEqual([true, false]);
  });

  it('never puts card data in the script itself', async () => {
    const clipboard = fakeClipboard();
    await createPasteboard(clipboard.run).writeClipboard(payload);
    for (const script of clipboard.scripts) {
      expect(script).not.toContain('98765');
      expect(script).not.toContain(base64(payload.html));
    }
  });

  it('reports a failed write and does not claim success', async () => {
    const clipboard = fakeClipboard({
      onWrite: () => {
        throw new Error('The clipboard refused the HTML.');
      },
    });
    const result = await createPasteboard(clipboard.run).writeClipboard(payload);
    expect(result).toEqual({
      verified: false,
      detail: 'Could not write to the Mac clipboard: The clipboard refused the HTML.',
    });
  });

  it('reports a failed read-back', async () => {
    const clipboard = fakeClipboard({
      onRead: () => {
        throw new Error('osascript timed out');
      },
    });
    const result = await createPasteboard(clipboard.run).writeClipboard(payload);
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('could not read it back: osascript timed out');
  });

  it.each([
    ['the HTML differs by one character', () => `${base64(`${payload.html}x`)}\n${base64(payload.plain)}\n`, 'HTML'],
    ['the text differs by one character', () => `${base64(payload.html)}\n${base64(`${payload.plain}x`)}\n`, 'text'],
    ['the HTML is truncated', () => `${base64(payload.html.slice(0, 5))}\n${base64(payload.plain)}\n`, 'HTML'],
    ['the HTML is missing', () => `\n${base64(payload.plain)}\n`, 'HTML'],
    ['the text is missing', () => `${base64(payload.html)}\n\n`, 'text'],
    ['the clipboard is empty', () => '\n\n', 'HTML'],
    ['another app overwrote it', () => `${base64('other')}\n${base64('other')}\n`, 'text'],
    ['the output is garbage', () => 'not base64 at all', 'HTML'],
  ])('reports a mismatch when %s', async (_, readBack, named) => {
    const clipboard = fakeClipboard({ onRead: readBack });
    const result = await createPasteboard(clipboard.run).writeClipboard(payload);
    expect(result.verified).toBe(false);
    expect(result.detail).toContain(named);
  });

  it('compares bytes, so a normalised Unicode form does not pass', async () => {
    const composed = { html: 'é', plain: 'é' };
    const decomposed = 'e\u0301';
    const clipboard = fakeClipboard({ onRead: () => `${base64(decomposed)}\n${base64(decomposed)}\n` });
    expect((await createPasteboard(clipboard.run).writeClipboard(composed)).verified).toBe(false);
  });
});

describe('readClipboard', () => {
  it('decodes both formats', async () => {
    const clipboard = fakeClipboard({ onRead: () => `${base64(payload.html)}\n${base64(payload.plain)}\n` });
    expect(await createPasteboard(clipboard.run).readClipboard()).toEqual(payload);
  });

  it('returns blanks for a format that is not on the clipboard', async () => {
    const clipboard = fakeClipboard({ onRead: () => `\n${base64('text')}\n` });
    expect(await createPasteboard(clipboard.run).readClipboard()).toEqual({ html: '', plain: 'text' });
  });

  it('lets a failure reach the caller', async () => {
    const clipboard = fakeClipboard({
      onRead: () => {
        throw new Error('no clipboard');
      },
    });
    await expect(createPasteboard(clipboard.run).readClipboard()).rejects.toThrow('no clipboard');
  });
});

describe.runIf(process.platform === 'darwin')('osascript transport (clipboard not touched)', () => {
  const ECHO_SCRIPT = `
ObjC.import('Foundation');
function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(input);
}
`;

  it('carries a large payload unchanged through stdin and stdout', async () => {
    const data = `${base64('山田太郎 तुलिका 😀\t="+91"\n'.repeat(100_000))}\n`;
    expect(data.length).toBeGreaterThan(4_000_000);
    expect(await runOsascript(ECHO_SCRIPT, data)).toBe(data);
  });

  it('rejects with the script error', async () => {
    const script = `function run() { throw new Error('boom from script'); }`;
    await expect(runOsascript(script, '')).rejects.toThrow('boom from script');
  });

  it('rejects when the script dies before reading a large stdin', async () => {
    const script = `function run() { throw new Error('died early'); }`;
    await expect(runOsascript(script, 'x'.repeat(5_000_000))).rejects.toThrow('died early');
  });
});
