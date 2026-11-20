import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStore } from '../data/index.ts';
import { CONFIG } from '../shared/config.ts';
import { JobPauseError, type LlmLedgerEntry, type LlmParseRequest, type PauseReason } from '../shared/contracts.ts';
import { createLlmClient, type LlmClientOptions } from './client.ts';
import { parseRetryAfterMs } from './errors.ts';

const schema = z.strictObject({ name: z.string() });
type Answer = z.infer<typeof schema>;

const USAGE = {
  input_tokens: 1_000,
  input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 },
  output_tokens: 500,
  output_tokens_details: { reasoning_tokens: 300 },
  total_tokens: 1_500,
};

function responseBody(fields: Record<string, unknown>): Record<string, unknown> {
  return { id: 'resp_1', object: 'response', model: 'gpt-6-luna', status: 'completed', output: [], usage: USAGE, ...fields };
}

function textOutput(text: string): unknown[] {
  return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const good = (name = 'Jane'): Response => json(responseBody({ output: textOutput(JSON.stringify({ name })) }));
const apiError = (status: number, code: string | null, message = 'nope', headers: Record<string, string> = {}): Response =>
  json({ error: { message, type: 'api_error', code, param: null } }, status, headers);

type Step = Response | Error | ((init: RequestInit) => Response | Promise<Response>);

let dir: string;
let imagePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'llm-test-'));
  imagePath = join(dir, 'card.jpg');
  writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Harness {
  calls: Array<Record<string, unknown>>;
  ledger: LlmLedgerEntry[];
  sleeps: number[];
  client: ReturnType<typeof createLlmClient>;
}

function harness(steps: Step[], overrides: Partial<LlmClientOptions> = {}): Harness {
  const calls: Array<Record<string, unknown>> = [];
  const ledger: LlmLedgerEntry[] = [];
  const sleeps: number[] = [];
  const queue = [...steps];
  const client = createLlmClient({
    apiKey: 'test-key',
    onCall: (entry) => ledger.push(entry),
    getSpendUsd: () => 0,
    getCostCapUsd: () => 10,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch: async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const step = queue.shift();
      if (step === undefined) throw new Error('The stub ran out of responses.');
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step(init ?? {}) : step;
    },
    ...overrides,
  });
  return { calls, ledger, sleeps, client };
}

function request(overrides: Partial<LlmParseRequest<Answer>> = {}): LlmParseRequest<Answer> {
  return {
    instructions: 'Read the card.',
    userText: 'Read this.',
    imagePaths: [imagePath],
    schema,
    schemaName: 'card_read',
    reasoningEffort: 'high',
    maxOutputTokens: 1_000,
    ...overrides,
  };
}

const ctx = { jobId: 'job1', purpose: 'read_a', cardId: 'card1' } as const;

async function expectPause(promise: Promise<unknown>, reason: PauseReason): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(JobPauseError);
  expect((error as JobPauseError).reason).toBe(reason);
}

describe('request shape', () => {
  it('sends what the contract asks for', async () => {
    const h = harness([good()]);
    await h.client.parse(request({ imagePaths: [imagePath, imagePath] }), ctx);

    const body = h.calls[0] as Record<string, any>;
    expect(body.model).toBe(CONFIG.model);
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.max_output_tokens).toBe(1_000);
    expect(body.instructions).toBe('Read the card.');
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'card_read', strict: true });

    const content = body.input[0].content;
    expect(content[0]).toEqual({ type: 'input_text', text: 'Read this.' });
    expect(content).toHaveLength(3);
    expect(content[1]).toEqual({ type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/2Q==', detail: CONFIG.imageDetail });
  });

  it('does not let the SDK retry on its own', async () => {
    const h = harness([apiError(500, null), good()]);
    await h.client.parse(request(), ctx);
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toHaveLength(1);
  });
});

describe('usage', () => {
  it('prices cached input separately and does not double-count reasoning', async () => {
    const h = harness([good()]);
    const result = await h.client.parse(request(), ctx);

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ value: { name: 'Jane' }, model: 'gpt-6-luna', attempts: 1 });
    const usage = result.usage!;
    expect(usage).toMatchObject({ inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 500, reasoningTokens: 300 });
    expect(usage.costUsd).toBeCloseTo((800 * 0.1 + 200 * 0.01 + 500 * 0.5) / 1e6, 12);
  });

  it('writes one ledger entry per logical parse, with retries summed', async () => {
    const h = harness([apiError(500, null), json(responseBody({ output: textOutput('{bad') })), good()]);
    const result = await h.client.parse(request(), ctx);

    expect(result.ok).toBe(true);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0]).toMatchObject({ jobId: 'job1', cardId: 'card1', fileId: null, purpose: 'read_a', ok: true, failure: null, attempts: 3 });
    expect(h.ledger[0]?.usage?.inputTokens).toBe(2_000);
  });

  it('keeps a paid answer when the ledger write fails', async () => {
    const original = console.error;
    console.error = () => {};
    const h = harness([good()], {
      onCall: () => {
        throw new Error('disk full');
      },
    });
    const result = await h.client.parse(request(), ctx);
    console.error = original;
    expect(result.ok).toBe(true);
  });
});

describe('with the real store', () => {
  it('records spend, so the live cost and the cost cap both work', async () => {
    const store = createStore(join(dir, 'ledger.sqlite'));
    const job = store.createJob({ name: 'cap', options: { frontBackPairs: false, defaultCountry: null, costCapUsd: 0.0002 } });
    const client = createLlmClient({
      apiKey: 'k',
      onCall: (entry) => store.recordLlmCall(entry),
      getSpendUsd: (jobId) => store.getJobSpendUsd(jobId),
      getCostCapUsd: (jobId) => store.getJob(jobId)?.options.costCapUsd ?? 0,
      fetch: async () => {
        // A real call takes a fraction of a millisecond more or less, never a whole number.
        await new Promise((resolve) => setTimeout(resolve, 2));
        return good();
      },
    });
    const jobCtx = { jobId: job.id, purpose: 'read_a' } as const;

    await client.parse(request(), jobCtx);
    expect(store.getJobSpendUsd(job.id)).toBeGreaterThan(0.0002);
    await expectPause(client.parse(request(), jobCtx), 'cost_cap');
    store.close();
  });
});

describe('retryable failures', () => {
  it.each([
    ['408', () => apiError(408, null)],
    ['409', () => apiError(409, null)],
    ['500', () => apiError(500, null)],
    ['503 overloaded', () => apiError(503, 'server_is_overloaded')],
    ['429 slow_down without Retry-After', () => apiError(429, 'slow_down', 'Too fast')],
    ['429 with Retry-After', () => apiError(429, 'rate_limit_exceeded', 'Busy', { 'retry-after-ms': '5' })],
    ['429 rate limit with no header', () => apiError(429, 'rate_limit_exceeded', 'Rate limit reached. See https://platform.openai.com/account/billing')],
    ['connection error', () => new TypeError('fetch failed')],
    ['timeout', () => new DOMException('The operation timed out.', 'AbortError')],
    ['failed response', () => json(responseBody({ status: 'failed', error: { code: 'server_error', message: 'boom' } }))],
  ])('retries %s', async (_name, step) => {
    const h = harness([step(), good()]);
    const result = await h.client.parse(request(), ctx);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(h.ledger).toHaveLength(1);
  });

  it('treats Retry-After as a minimum, and holds other calls for that long', async () => {
    const h = harness([apiError(429, 'slow_down', 'x', { 'retry-after-ms': '40' }), good()]);
    const startedAt = Date.now();
    await h.client.parse(request(), ctx);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(40);
    expect(h.sleeps[0]).toBeLessThan(40 + CONFIG.retries.baseDelayMs);
    // The sleep is stubbed, so only the shared cooldown can account for this wait.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(39);
  });

  it('backs off exponentially with jitter and gives up at maxAttempts', async () => {
    const h = harness(Array.from({ length: CONFIG.retries.maxAttempts }, () => apiError(500, null, 'still down')));
    const result = await h.client.parse(request(), ctx);

    expect(result).toMatchObject({ ok: false, failure: 'retries_exhausted', usage: null, attempts: CONFIG.retries.maxAttempts });
    expect(h.calls).toHaveLength(CONFIG.retries.maxAttempts);
    expect(h.sleeps).toHaveLength(CONFIG.retries.maxAttempts - 1);
    h.sleeps.forEach((ms, i) => {
      const backoff = CONFIG.retries.baseDelayMs * 2 ** i;
      expect(ms).toBeGreaterThanOrEqual(backoff / 2);
      expect(ms).toBeLessThanOrEqual(backoff);
    });
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0]).toMatchObject({ ok: false, failure: 'retries_exhausted' });
  });
});

describe('parseRetryAfterMs', () => {
  it('reads seconds, milliseconds and dates, and ignores nonsense', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '7' }))).toBe(7_000);
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '1500', 'retry-after': '7' }))).toBe(1_500);
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    expect(parseRetryAfterMs(new Headers({ 'retry-after': inTenSeconds }))).toBeGreaterThan(8_000);
    expect(parseRetryAfterMs(new Headers({ 'retry-after': 'soon' }))).toBeNull();
    expect(parseRetryAfterMs(new Headers())).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });
});

describe('problems retrying cannot fix', () => {
  it.each([
    [401, 'invalid_api_key'],
    [403, null],
  ])('%i pauses as bad_api_key with no retry', async (status, code) => {
    const h = harness([apiError(status, code)]);
    await expectPause(h.client.parse(request(), ctx), 'bad_api_key');
    expect(h.calls).toHaveLength(1);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0]).toMatchObject({ ok: false, failure: null, attempts: 1 });
  });

  it('pauses when the key cannot use the model', async () => {
    const h = harness([apiError(404, 'model_not_found')]);
    await expectPause(h.client.parse(request(), ctx), 'bad_api_key');
  });

  it.each([
    ['insufficient_quota', 'You exceeded your current quota, please check your plan and billing details.'],
    ['billing_not_active', 'Your account is not active.'],
    [null, 'You exceeded your current quota, please check your plan and billing details.'],
  ])('pauses as out_of_credit for a 429 with code %s', async (code, message) => {
    const h = harness([apiError(429, code, message)]);
    await expectPause(h.client.parse(request(), ctx), 'out_of_credit');
    expect(h.calls).toHaveLength(1);
  });

  it('retries a quota 429 that has Retry-After, then pauses if it never clears', async () => {
    const step = (): Response => apiError(429, 'insufficient_quota', 'quota', { 'retry-after-ms': '1' });
    const h = harness(Array.from({ length: CONFIG.retries.maxAttempts }, step));
    await expectPause(h.client.parse(request(), ctx), 'out_of_credit');
    expect(h.calls).toHaveLength(CONFIG.retries.maxAttempts);
  });

  it('pauses as network when nothing has reached OpenAI', async () => {
    const h = harness(Array.from({ length: CONFIG.retries.maxAttempts }, () => new TypeError('fetch failed')));
    await expectPause(h.client.parse(request(), ctx), 'network');
    expect(h.calls).toHaveLength(CONFIG.retries.maxAttempts);
    expect(h.ledger).toHaveLength(1);
  });

  it('pauses as network when an outage follows earlier successes', async () => {
    const outage = Array.from({ length: CONFIG.retries.maxAttempts }, () => new TypeError('fetch failed'));
    const h = harness([good(), ...outage]);
    await h.client.parse(request(), ctx);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await expectPause(h.client.parse(request(), ctx), 'network');
  });

  it('fails one card, not the job, when other calls still reach OpenAI', async () => {
    let other: Promise<unknown> | undefined;
    const client = createLlmClient({
      apiKey: 'k',
      onCall: () => {},
      getSpendUsd: () => 0,
      getCostCapUsd: () => 10,
      // The other card gets an answer while this one is waiting to retry.
      sleep: async () => {
        other ??= client.parse(request({ maxOutputTokens: 7 }), ctx);
        await other;
      },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { max_output_tokens: number };
        if (body.max_output_tokens === 7) return good();
        throw new TypeError('fetch failed');
      },
    });
    const result = await client.parse(request(), ctx);
    expect(result).toMatchObject({ ok: false, failure: 'retries_exhausted', attempts: CONFIG.retries.maxAttempts });
  });

  it('checks the cost cap before calling', async () => {
    const h = harness([good()], { getSpendUsd: () => 10, getCostCapUsd: () => 10 });
    await expectPause(h.client.parse(request(), ctx), 'cost_cap');
    expect(h.calls).toHaveLength(0);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0]).toMatchObject({ ok: false, failure: null, attempts: 0, usage: null });
  });

  it("counts a call's own earlier attempts against the cap", async () => {
    const h = harness([json(responseBody({ output: textOutput('{bad') })), good()], { getSpendUsd: () => 0, getCostCapUsd: () => 0.0001 });
    await expectPause(h.client.parse(request(), ctx), 'cost_cap');
    expect(h.calls).toHaveLength(1);
    expect(h.ledger[0]?.usage?.inputTokens).toBe(1_000);
  });
});

describe('per-card problems never become a value', () => {
  it('reports a refusal without retrying', async () => {
    const output = [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help.' }] }];
    const h = harness([json(responseBody({ output }))]);
    const result = await h.client.parse(request(), ctx);

    expect(result).toMatchObject({ ok: false, failure: 'refused', detail: 'I cannot help.', attempts: 1 });
    expect(result.usage?.inputTokens).toBe(1_000);
    expect(h.ledger[0]).toMatchObject({ ok: false, failure: 'refused' });
  });

  it('retries max_output_tokens once with a larger limit', async () => {
    const cutOff = (): Response => json(responseBody({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
    const h = harness([cutOff(), good()]);
    const result = await h.client.parse(request(), ctx);

    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(h.calls.map((c) => c.max_output_tokens)).toEqual([1_000, 2_000]);
    expect(result.usage?.inputTokens).toBe(2_000);
  });

  it('gives up as incomplete after the larger limit is also cut off', async () => {
    const cutOff = (): Response => json(responseBody({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
    const h = harness([cutOff(), cutOff()]);
    const result = await h.client.parse(request(), ctx);
    expect(result).toMatchObject({ ok: false, failure: 'incomplete', attempts: 2 });
  });

  it('does not retry other incomplete reasons', async () => {
    const h = harness([json(responseBody({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }))]);
    expect(await h.client.parse(request(), ctx)).toMatchObject({ ok: false, failure: 'incomplete', attempts: 1 });
  });

  it.each([
    ['malformed JSON', () => json(responseBody({ output: textOutput('{"name": "Ja') }))],
    ['JSON that breaks the schema', () => json(responseBody({ output: textOutput('{"wrong": 1}') }))],
    ['no output at all', () => json(responseBody({ output: [] }))],
  ])('retries %s once, then reports schema_invalid', async (_name, step) => {
    const h = harness([step(), step()]);
    const result = await h.client.parse(request(), ctx);
    expect(result).toMatchObject({ ok: false, failure: 'schema_invalid', attempts: 2 });
    expect(result.usage?.inputTokens).toBe(2_000);
    expect(h.ledger).toHaveLength(1);
  });

  it('recovers when the schema retry succeeds', async () => {
    const h = harness([json(responseBody({ output: textOutput('not json') })), good('Sam')]);
    expect(await h.client.parse(request(), ctx)).toMatchObject({ ok: true, value: { name: 'Sam' }, attempts: 2 });
  });

  it('fails the card on a rejected request, with no retry', async () => {
    const h = harness([apiError(400, 'invalid_image', 'That image is too large.')]);
    const result = await h.client.parse(request(), ctx);
    expect(result).toMatchObject({ ok: false, failure: 'retries_exhausted', attempts: 1 });
    expect(result.ok === false && result.detail).toContain('too large');
  });

  it('fails the card when its image file is missing, without calling OpenAI', async () => {
    const h = harness([]);
    const result = await h.client.parse(request({ imagePaths: [join(dir, 'missing.jpg')] }), ctx);
    expect(result).toMatchObject({ ok: false, failure: 'retries_exhausted', attempts: 0 });
    expect(h.calls).toHaveLength(0);
    expect(h.ledger).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('rejects a call whose signal is already aborted, and records it once', async () => {
    const h = harness([]);
    const controller = new AbortController();
    controller.abort();
    await expect(h.client.parse(request(), { ...ctx, signal: controller.signal })).rejects.toBeDefined();
    expect(h.calls).toHaveLength(0);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0]).toMatchObject({ ok: false, failure: null });
  });

  it('stops a request that is in flight', async () => {
    const controller = new AbortController();
    const h = harness([
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          controller.abort();
        }),
    ]);
    await expect(h.client.parse(request(), { ...ctx, signal: controller.signal })).rejects.toBeDefined();
    expect(h.ledger).toHaveLength(1);
  });

  it('stops during a backoff wait instead of returning a failed result', async () => {
    const controller = new AbortController();
    const h = harness([apiError(500, null)], {
      sleep: async (_ms, signal) => {
        controller.abort();
        signal?.throwIfAborted();
      },
    });
    await expect(h.client.parse(request(), { ...ctx, signal: controller.signal })).rejects.toBeDefined();
    expect(h.ledger).toHaveLength(1);
  });
});

describe('ramp-up', () => {
  it('starts at the initial limit, then grows under load', async () => {
    let running = 0;
    let peak = 0;
    const client = createLlmClient({
      apiKey: 'k',
      onCall: () => {},
      getSpendUsd: () => 0,
      getCostCapUsd: () => 10,
      sleep: async () => {},
      fetch: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        return good();
      },
    });
    expect(client.getConcurrency()).toBe(CONFIG.concurrency.initial);
    await Promise.all(Array.from({ length: 200 }, () => client.parse(request(), ctx)));
    expect(client.getConcurrency()).toBeGreaterThan(CONFIG.concurrency.initial);
    expect(peak).toBeLessThanOrEqual(client.getConcurrency());
  });

  it('halves on a 429, and a burst from one window halves only once', async () => {
    let calls = 0;
    const client = createLlmClient({
      apiKey: 'k',
      onCall: () => {},
      getSpendUsd: () => 0,
      getCostCapUsd: () => 10,
      sleep: async () => {},
      fetch: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return calls <= CONFIG.concurrency.initial ? apiError(429, 'slow_down') : good();
      },
    });
    await Promise.all(Array.from({ length: 4 }, () => client.parse(request(), ctx)));
    expect(client.getConcurrency()).toBe(CONFIG.concurrency.initial / 2);
  });
});
