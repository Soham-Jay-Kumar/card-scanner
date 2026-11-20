import { describe, expect, it } from 'vitest';
import { CONFIG } from '../shared/config.ts';
import {
  JobPauseError,
  SCHEMA_NAMES,
  type CardReadData,
  type LlmCallContext,
  type LlmClient,
  type LlmParseRequest,
  type LlmParseResult,
  type LlmUsage,
} from '../shared/contracts.ts';
import { createExtractionService } from './index.ts';
import { READ_INSTRUCTIONS, READ_USER_TEXT } from './prompts.ts';
import { cardReadSchema } from './schema.ts';

const usage: LlmUsage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, costUsd: 0 };
const ctx: LlmCallContext = { jobId: 'job', purpose: 'read_a', cardId: 'card' };

const card: CardReadData = {
  transcript: ['Jane Doe', 'Acme Ltd', 'Tel: +1 555 123 4567'],
  name: 'Jane Doe',
  position: '',
  company: 'Acme Ltd',
  emails: [],
  phones: [{ number: '+1 555 123 4567', label: 'Tel:' }],
  websites: [],
  unreadable: [],
};

function okResult(value: unknown): LlmParseResult<unknown> {
  return { ok: true, value, model: CONFIG.model, usage, latencyMs: 1, attempts: 1 };
}

function failedResult(failure: 'refused' | 'incomplete' | 'schema_invalid' | 'retries_exhausted', detail: string): LlmParseResult<unknown> {
  return { ok: false, failure, detail, usage: null, latencyMs: 1, attempts: 3 };
}

/** A fake client that answers every call the same way and records what it was asked. */
function fakeLlm(respond: () => LlmParseResult<unknown>) {
  const calls: Array<{ request: LlmParseRequest<unknown>; ctx: LlmCallContext }> = [];
  const llm = {
    async parse(request: LlmParseRequest<unknown>, callCtx: LlmCallContext) {
      calls.push({ request, ctx: callCtx });
      return respond();
    },
  } as LlmClient;
  return { llm, calls };
}

function read(respond: () => LlmParseResult<unknown>) {
  const { llm } = fakeLlm(respond);
  return createExtractionService({ llm }).readCard({ variant: 'B', imagePaths: ['/tmp/b.jpg'] }, ctx);
}

describe('readCard request', () => {
  it('sends the configured read request', async () => {
    const { llm, calls } = fakeLlm(() => okResult(card));
    await createExtractionService({ llm }).readCard({ variant: 'A', imagePaths: ['/tmp/a.jpg'] }, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.ctx).toBe(ctx);
    expect(calls[0]!.request).toEqual({
      instructions: READ_INSTRUCTIONS,
      userText: READ_USER_TEXT,
      imagePaths: ['/tmp/a.jpg'],
      schema: cardReadSchema,
      schemaName: SCHEMA_NAMES.read,
      reasoningEffort: CONFIG.reasoningEffort.read,
      maxOutputTokens: CONFIG.maxOutputTokens.read,
    });
  });

  it('passes both sides of a two-sided card in order', async () => {
    const { llm, calls } = fakeLlm(() => okResult(card));
    await createExtractionService({ llm }).readCard({ variant: 'C', imagePaths: ['/tmp/front.jpg', '/tmp/back.jpg'] }, ctx);
    expect(calls[0]!.request.imagePaths).toEqual(['/tmp/front.jpg', '/tmp/back.jpg']);
  });

  it('keeps instructions and user text byte-identical across every variant and card', async () => {
    const { llm, calls } = fakeLlm(() => okResult(card));
    const service = createExtractionService({ llm });
    await service.readCard({ variant: 'A', imagePaths: ['/tmp/1.jpg'] }, ctx);
    await service.readCard({ variant: 'B', imagePaths: ['/tmp/2.jpg'] }, { ...ctx, purpose: 'read_b', cardId: 'other' });
    await service.readCard({ variant: 'C', imagePaths: ['/tmp/3.jpg', '/tmp/4.jpg'] }, { ...ctx, purpose: 'read_c' });

    expect(new Set(calls.map((call) => call.request.instructions)).size).toBe(1);
    expect(new Set(calls.map((call) => call.request.userText)).size).toBe(1);
  });
});

describe('readCard outcomes', () => {
  it('returns good data unchanged', async () => {
    expect(await read(() => okResult(card))).toEqual({ ok: true, data: card });
  });

  it.each(['refused', 'incomplete', 'schema_invalid', 'retries_exhausted'] as const)('maps a client %s failure', async (failure) => {
    expect(await read(() => failedResult(failure, 'why it failed'))).toEqual({ ok: false, failure, detail: 'why it failed' });
  });

  it.each([
    ['an empty list', []],
    ['one empty line', ['']],
    ['only whitespace', ['   ', '\t\n']],
    ['only zero-width characters', ['\u200B\uFEFF']],
  ])('treats a transcript of %s as schema_invalid', async (_case, transcript) => {
    const outcome = await read(() => okResult({ ...card, transcript }));
    expect(outcome).toMatchObject({ ok: false, failure: 'schema_invalid' });
    expect(outcome.ok === false && outcome.detail).toContain('Read B');
  });

  it('accepts a transcript where only the marker could be read, and keeps it as data', async () => {
    const outcome = await read(() => okResult({ ...card, transcript: ['[?]'], name: '', company: '', phones: [], unreadable: ['name'] }));
    expect(outcome.ok).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'not a card'],
    ['a missing transcript', { ...card, transcript: undefined }],
    ['a null transcript', { ...card, transcript: null }],
    ['a field of the wrong type', { ...card, name: 42 }],
    ['an unknown unreadable field', { ...card, unreadable: ['address'] }],
    ['an extra key', { ...card, address: '1 Main St' }],
  ])('does not throw on %s, and fails as schema_invalid', async (_case, value) => {
    await expect(read(() => okResult(value))).resolves.toMatchObject({ ok: false, failure: 'schema_invalid' });
  });

  it.each([
    ['name', { name: 'Jane D[?]e' }],
    ['position', { position: 'Dir[?]ctor' }],
    ['company', { company: 'Ac[?]e Ltd' }],
    ['email', { emails: ['jane@acme.com', 'j[?]e@acme.com'] }],
    ['phone', { phones: [{ number: '+1 555 [?]23 4567', label: '' }] }],
    ['website', { websites: ['ac[?]e.com'] }],
  ])('rejects a read that copied the unreadable marker into %s', async (_field, patch) => {
    await expect(read(() => okResult({ ...card, ...patch }))).resolves.toMatchObject({ ok: false, failure: 'schema_invalid' });
  });

  it('allows the marker in the transcript when the fields are clean', async () => {
    const outcome = await read(() => okResult({ ...card, transcript: ['Jane Doe', 'Acme [?]td'], company: '', unreadable: ['company'] }));
    expect(outcome.ok).toBe(true);
  });
});

describe('readCard exceptions', () => {
  it.each(['out_of_credit', 'bad_api_key', 'cost_cap', 'network', 'user'] as const)('lets a %s JobPauseError propagate', async (reason) => {
    const pause = new JobPauseError(reason, 'pause the job');
    const outcome = read(() => {
      throw pause;
    });
    await expect(outcome).rejects.toBe(pause);
  });

  it('does not turn an abort or other client error into a card failure', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    await expect(read(() => { throw abort; })).rejects.toBe(abort);
  });
});

describe('createExtractionService', () => {
  it('exposes pure compare and toRow on the service', () => {
    const { llm, calls } = fakeLlm(() => okResult(card));
    const service = createExtractionService({ llm });
    expect(service.toRow(card).company).toBe('Acme Ltd');
    expect(service.compare([]).name.agreement).toBe('split');
    expect(calls).toHaveLength(0);
  });
});
