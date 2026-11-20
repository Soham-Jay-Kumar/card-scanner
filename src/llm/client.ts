/**
 * The only place that talks to OpenAI. Handles ramp-up, retries, usage and the
 * ledger. Returns ok:false for per-card problems and throws JobPauseError for
 * problems retrying can't fix, so a card never gets a guessed value.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { Response as OpenAIResponse, ResponseInputContent, ResponseUsage } from 'openai/resources/responses/responses';
import { CONFIG } from '../shared/config.ts';
import {
  JobPauseError,
  type CreateLlmClient,
  type LlmCallContext,
  type LlmClient,
  type LlmFailure,
  type LlmParseRequest,
  type LlmParseResult,
  type LlmUsage,
} from '../shared/contracts.ts';
import { classifyError, type ErrorVerdict } from './errors.ts';
import { AdaptiveLimiter } from './limiter.ts';

export type LlmClientOptions = Parameters<CreateLlmClient>[0] & {
  /** Test seam: replaces the network. */
  fetch?: typeof globalThis.fetch;
  /** Test seam: replaces backoff waits. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export interface AdaptiveLlmClient extends LlmClient {
  /** Current ramp-up level, for the progress display. */
  getConcurrency(): number;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

type AttemptOutcome<T> =
  | { kind: 'parsed'; value: T; model: string }
  | { kind: 'refused'; detail: string }
  | { kind: 'incomplete'; reason: string }
  | { kind: 'schema_invalid'; detail: string }
  | ErrorVerdict;

interface Tally {
  attempts: number;
  apiMs: number;
  usage: LlmUsage | null;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toUsage(usage: ResponseUsage | null | undefined): LlmUsage | null {
  if (!usage) return null;
  const inputTokens = usage.input_tokens;
  const cachedInputTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  const outputTokens = usage.output_tokens;
  const { inputPerM, cachedInputPerM, outputPerM } = CONFIG.pricing;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    // Reasoning tokens are already inside outputTokens, so they add nothing to the cost.
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    costUsd: ((inputTokens - cachedInputTokens) * inputPerM + cachedInputTokens * cachedInputPerM + outputTokens * outputPerM) / 1_000_000,
  };
}

function addUsage(total: LlmUsage | null, more: LlmUsage | null): LlmUsage | null {
  if (!total || !more) return total ?? more;
  return {
    inputTokens: total.inputTokens + more.inputTokens,
    cachedInputTokens: total.cachedInputTokens + more.cachedInputTokens,
    outputTokens: total.outputTokens + more.outputTokens,
    reasoningTokens: total.reasoningTokens + more.reasoningTokens,
    costUsd: total.costUsd + more.costUsd,
  };
}

async function toImageContent(path: string): Promise<ResponseInputContent> {
  const mime = MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'image/jpeg';
  const base64 = (await readFile(path)).toString('base64');
  return { type: 'input_image', image_url: `data:${mime};base64,${base64}`, detail: CONFIG.imageDetail };
}

function findRefusal(response: OpenAIResponse): string | null {
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type === 'refusal') return part.refusal;
    }
  }
  return null;
}

function retryDelayMs(attempt: number, retryAfterMs: number | null, random: () => number): number {
  const { baseDelayMs, maxDelayMs } = CONFIG.retries;
  // Retry-After is a minimum, so jitter only ever adds to it.
  if (retryAfterMs !== null) return retryAfterMs + random() * baseDelayMs;
  const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return backoff / 2 + (random() * backoff) / 2;
}

export function createLlmClient(options: LlmClientOptions): AdaptiveLlmClient {
  const { onCall, getSpendUsd, getCostCapUsd, sleep = abortableSleep } = options;
  const sdk = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    maxRetries: 0,
    timeout: CONFIG.retries.requestTimeoutMs,
    fetch: options.fetch,
  });
  const limiter = new AdaptiveLimiter();
  /** Any answer from the server, even an error, proves the network is up. */
  let lastServerResponseAt = 0;

  function enforceCostCap(ctx: LlmCallContext, tally: Tally): void {
    // This call's earlier attempts aren't in the ledger yet, so count them here.
    const spend = getSpendUsd(ctx.jobId) + (tally.usage?.costUsd ?? 0);
    const cap = getCostCapUsd(ctx.jobId);
    if (spend >= cap) {
      throw new JobPauseError('cost_cap', `This job has reached its $${cap.toFixed(2)} cost cap. Raise the cap, then press Resume.`);
    }
  }

  async function send<T>(
    request: LlmParseRequest<T>,
    content: ResponseInputContent[],
    maxOutputTokens: number,
    ctx: LlmCallContext,
    tally: Tally,
  ): Promise<AttemptOutcome<T>> {
    const startedAt = performance.now();
    tally.attempts += 1;
    try {
      const pending = sdk.responses.parse(
        {
          model: CONFIG.model,
          instructions: request.instructions,
          input: [{ role: 'user', content }],
          text: { format: zodTextFormat(request.schema, request.schemaName) },
          reasoning: { effort: request.reasoningEffort },
          max_output_tokens: maxOutputTokens,
          store: false,
        },
        { signal: ctx.signal },
      );

      // Read the body before the SDK parses it: a parse error would otherwise
      // hide the usage of a response that was still billed.
      const http = await pending.asResponse();
      lastServerResponseAt = Date.now();
      const raw = (await http.clone().json()) as OpenAIResponse;
      tally.usage = addUsage(tally.usage, toUsage(raw.usage));

      const refusal = findRefusal(raw);
      if (refusal !== null) return { kind: 'refused', detail: refusal };
      if (raw.status === 'incomplete') return { kind: 'incomplete', reason: raw.incomplete_details?.reason ?? 'unknown' };
      if (raw.status === 'failed') {
        const detail = raw.error ? `${raw.error.code}: ${raw.error.message}` : 'The response failed.';
        return { kind: 'transient', detail, retryAfterMs: null, rateLimited: false, connection: false, quota: false };
      }

      let parsed: T | null;
      try {
        parsed = (await pending).output_parsed;
      } catch (error) {
        return { kind: 'schema_invalid', detail: error instanceof Error ? error.message : String(error) };
      }
      if (parsed === null) return { kind: 'schema_invalid', detail: 'The response had no structured output.' };
      return { kind: 'parsed', value: parsed, model: raw.model ?? CONFIG.model };
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      const verdict = classifyError(error);
      if (!(verdict.kind === 'transient' && verdict.connection)) lastServerResponseAt = Date.now();
      return verdict;
    } finally {
      // Whole milliseconds: the ledger column is a STRICT integer.
      tally.apiMs += Math.round(performance.now() - startedAt);
    }
  }

  async function runAttempts<T>(request: LlmParseRequest<T>, ctx: LlmCallContext, tally: Tally): Promise<LlmParseResult<T>> {
    const { maxAttempts } = CONFIG.retries;
    let maxOutputTokens = request.maxOutputTokens;
    let enlarged = false;
    let schemaRetried = false;
    /** When this call's unbroken run of connection failures began. */
    let connectionFailingSince: number | null = null;

    const fail = (failure: LlmFailure, detail: string): LlmParseResult<T> => ({
      ok: false,
      failure,
      detail,
      usage: tally.usage,
      latencyMs: tally.apiMs,
      attempts: tally.attempts,
    });

    for (;;) {
      const epoch = await limiter.acquire(ctx.signal);
      let outcome: AttemptOutcome<T>;
      try {
        enforceCostCap(ctx, tally);
        let content: ResponseInputContent[];
        try {
          // Read inside the slot and per attempt, so a queue of calls holds no image bytes.
          const images = await Promise.all(request.imagePaths.map(toImageContent));
          content = [{ type: 'input_text', text: request.userText }, ...images];
        } catch (error) {
          return fail('retries_exhausted', `Could not read the card image: ${error instanceof Error ? error.message : String(error)}`);
        }
        outcome = await send(request, content, maxOutputTokens, ctx, tally);
      } finally {
        limiter.release();
      }

      const canRetry = tally.attempts < maxAttempts;
      switch (outcome.kind) {
        case 'parsed':
          limiter.onSuccess();
          return {
            ok: true,
            value: outcome.value,
            model: outcome.model,
            usage: tally.usage ?? zeroUsage(),
            latencyMs: tally.apiMs,
            attempts: tally.attempts,
          };
        case 'refused':
          limiter.onSuccess();
          return fail('refused', outcome.detail);
        case 'incomplete':
          limiter.onSuccess();
          if (outcome.reason === 'max_output_tokens' && !enlarged && canRetry) {
            enlarged = true;
            maxOutputTokens *= 2;
            continue;
          }
          return fail('incomplete', `The answer was cut off: ${outcome.reason}.`);
        case 'schema_invalid':
          limiter.onSuccess();
          if (!schemaRetried && canRetry) {
            schemaRetried = true;
            continue;
          }
          return fail('schema_invalid', outcome.detail);
        case 'pause':
          throw new JobPauseError(outcome.reason, outcome.message);
        case 'rejected':
          return fail('retries_exhausted', `OpenAI rejected the request: ${outcome.detail}`);
        case 'transient':
          break;
      }

      connectionFailingSince = outcome.connection ? (connectionFailingSince ?? Date.now()) : null;
      if (outcome.rateLimited) limiter.onRateLimited(epoch);
      if (outcome.retryAfterMs !== null) limiter.cooldown(outcome.retryAfterMs);

      if (!canRetry) {
        if (outcome.quota) throw new JobPauseError('out_of_credit', 'OpenAI keeps reporting a quota problem. Check the account, then press Resume.');
        if (connectionFailingSince !== null && lastServerResponseAt < connectionFailingSince) {
          throw new JobPauseError('network', 'Could not reach OpenAI. Check the connection, then press Resume.');
        }
        return fail('retries_exhausted', `Gave up after ${tally.attempts} attempts: ${outcome.detail}`);
      }
      await sleep(retryDelayMs(tally.attempts, outcome.retryAfterMs, Math.random), ctx.signal);
    }
  }

  return {
    getConcurrency: () => limiter.limit,

    async parse<T>(request: LlmParseRequest<T>, ctx: LlmCallContext): Promise<LlmParseResult<T>> {
      const tally: Tally = { attempts: 0, apiMs: 0, usage: null };
      const record = (ok: boolean, failure: LlmFailure | null): void => {
        try {
          onCall({
            jobId: ctx.jobId,
            cardId: ctx.cardId ?? null,
            fileId: ctx.fileId ?? null,
            purpose: ctx.purpose,
            model: CONFIG.model,
            ok,
            failure,
            attempts: tally.attempts,
            latencyMs: tally.apiMs,
            usage: tally.usage,
            createdAt: new Date().toISOString(),
          });
        } catch (error) {
          // The answer is already paid for, so a ledger failure must not lose it.
          console.error('Could not record an LLM call:', error);
        }
      };

      try {
        const result = await runAttempts(request, ctx, tally);
        record(result.ok, result.ok ? null : result.failure);
        return result;
      } catch (error) {
        record(false, null);
        throw error;
      }
    },
  };
}

function zeroUsage(): LlmUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 };
}

createLlmClient satisfies CreateLlmClient;
