/**
 * A real local HTTP server that stands in for POST /v1/responses.
 *
 * Point the app's baseURL at it. Its answers are valid Responses API JSON, so the
 * real openai SDK parses them unmodified (server.test.ts proves that).
 *
 * It knows nothing about text in images. Every card carries a coloured strip (see
 * marker.ts) naming its card ID, and the fake answers from a table of known cards.
 * So a good score here proves the pipeline logic and says nothing about how well
 * the real model reads cards.
 *
 * Standalone: node test/fake-openai/server.ts --port 4010 --truth test/.artifacts/synth/truth.json
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { CONFIG } from '../../src/shared/config.ts';
import { READ_VARIANTS, SCHEMA_NAMES } from '../../src/shared/contracts.ts';
import type { CardReadData, FieldKey, LocateWireResult, ReadVariant } from '../../src/shared/contracts.ts';
import { decodeMarkers, markerToBox, primaryMarker, visibleShare } from './marker.ts';
import type { DecodedMarker, MarkerBox } from './marker.ts';

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export interface FakeCard {
  /** The ID printed in the card's marker strip. */
  id: number;
  /** Width divided by height, upright. Locate needs it to size the box. */
  aspect: number;
  /** A perfect read of this card. */
  read: CardReadData;
}

export type FaultKind =
  | 'slow_down'
  | 'quota'
  | 'bad_key'
  | 'server_500'
  | 'overloaded_503'
  | 'hang'
  | 'connection_reset'
  | 'malformed_json'
  | 'malformed_output'
  | 'refusal'
  | 'incomplete'
  | 'wrong_schema'
  | 'response_failed';

export type PurposeFilter = 'locate' | 'read' | 'read_a' | 'read_b' | 'read_c';

export interface FaultRule {
  fault: FaultKind;
  purpose?: PurposeFilter;
  /** Only requests about these cards. Omit for every card. */
  cardIds?: number[];
  /** Seeded chance per attempt. The default is every attempt. */
  rate?: number;
  /** Only the first N attempts per card and read, so a retry then succeeds. */
  maxAttempt?: number;
  /** Stop after firing this many times in total. */
  times?: number;
  /** Stay off until this many requests have arrived. */
  afterRequests?: number;
  /** Seconds in the Retry-After header. 0 leaves the header out. */
  retryAfterSeconds?: number;
  /** For 'hang': release after this long. Omit to hang until the client gives up. */
  hangMs?: number;
}

/** Everything fails with this fault until cleared: out of credit, a revoked key. */
export interface Outage {
  fault: FaultKind;
  afterRequests?: number;
  retryAfterSeconds?: number;
}

export interface Misread {
  cardIds?: number[];
  field: FieldKey;
  /** Which reads get it. All three is the correlated case. */
  variants?: ReadVariant[];
  /** A character error, such as acme to acrne. Also goes in the transcript, like a real misread. */
  replace?: { from: string; to: string };
  /** A value not on the card. Stays out of the transcript unless inTranscript is set. */
  value?: string;
  /** Adds a value after the real ones, as a neighbouring card's text leaking into a read. Lists only. */
  append?: string;
  inTranscript?: boolean;
  blank?: boolean;
  unreadable?: boolean;
}

/** Seeded random character errors, spread over every card. */
export interface Noise {
  /** Chance per card and field of an error in one read. */
  rate: number;
  /** Chance per card and field of the same error in all three reads. */
  correlatedRate?: number;
}

/** What each of the two independent locate passes does for an image. */
export interface LocateRule {
  /** Applies to images showing any of these cards. Omit for every image. */
  cardIds?: number[];
  missInPass1?: number[];
  missInPass2?: number[];
  failPass?: { pass: 1 | 2; fault: FaultKind; retryAfterSeconds?: number };
  /** Box edges move by up to this many 0-1000 units, seeded per pass. */
  jitter?: number;
  /** A box where no card is. */
  phantomInPass?: 1 | 2;
  badGeometry?: { pass: 1 | 2; kind: 'inverted' | 'out_of_range' | 'zero_area' };
  wrongRotation?: number[];
  /** The pass answers contains_card: false. */
  blindPass?: 1 | 2;
}

export interface UsagePlan {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface FakeConfig {
  seed: number;
  latency: { baseMs: number; jitterMs: number };
  usage: UsagePlan;
  faults: FaultRule[];
  misreads: Misread[];
  noise: Noise | null;
  locate: LocateRule[];
  outage: Outage | null;
  /** When a neighbour's whole strip shows in a crop, its email leaks into the read. */
  neighbourBleed: boolean;
}

export interface RequestLogEntry {
  seq: number;
  receivedAt: number;
  finishedAt: number | null;
  purpose: 'locate' | 'orient' | 'read_a' | 'read_b' | 'read_c' | 'unknown';
  /** Locate only: which of the two passes this attempt was for. */
  pass: 1 | 2 | null;
  /** Locate: every card returned. Read: the card the read is about. */
  cards: number[];
  attempt: number;
  fault: FaultKind | null;
  httpStatus: number | null;
  /** A complete valid model answer reached the client. */
  delivered: boolean;
  aborted: boolean;
  inFlightAtStart: number;
}

export interface CardCounts {
  locate: number;
  A: number;
  B: number;
  C: number;
}

export interface FakeStats {
  requests: number;
  byPurpose: Record<RequestLogEntry['purpose'], number>;
  /** Every attempt, per card. */
  attempts: Record<string, CardCounts>;
  /** Valid answers delivered, per card. A finished read that repeats shows up here. */
  delivered: Record<string, CardCounts>;
  faults: Partial<Record<FaultKind, number>>;
  /** Read images with no strip the fake could decode. Must stay 0 in a pipeline test. */
  unidentifiedReads: number;
  /** Read images holding several whole cards, as a full-image fallback on a sheet does. */
  multiCardReads: number;
  /** Read images where a neighbour's strip was also visible. */
  neighbourStripReads: number;
  /** Read images that were not upright. Vision should have turned them. */
  notUprightReads: number;
  /** Locate images where the fake found no card. */
  emptyLocates: number;
  inFlight: number;
  inFlightPeak: number;
  billed: UsagePlan & { responses: number; costUsd: number };
  /** Requests that broke the rules the real API or the plan sets. Must stay empty. */
  violations: string[];
  log: RequestLogEntry[];
}

export interface FakeOpenAI {
  /** Use this as baseURL. Ends in /v1. */
  url: string;
  port: number;
  addCards(cards: FakeCard[]): void;
  configure(patch: Partial<FakeConfig>): void;
  clearOutage(): void;
  /** Clears counts and rules, and keeps the known cards. */
  reset(): void;
  stats(): FakeStats;
  close(): Promise<void>;
}

export interface FakeOpenAIOptions extends Partial<FakeConfig> {
  port?: number;
  host?: string;
  cards?: FakeCard[];
}

/* ------------------------------------------------------------------ */
/* Defaults and small helpers                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_ASPECT = 1.75;
const DEFAULT_USAGE: UsagePlan = { inputTokens: 1_800, cachedInputTokens: 256, outputTokens: 640, reasoningTokens: 240 };
const EMPTY_READ: CardReadData = {
  transcript: [],
  name: '',
  position: '',
  company: '',
  emails: [],
  phones: [],
  websites: [],
  unreadable: [],
};

const CONFUSIONS: Array<[string, string]> = [
  ['rn', 'm'],
  ['m', 'rn'],
  ['0', 'O'],
  ['O', '0'],
  ['l', '1'],
  ['1', 'l'],
  ['5', 'S'],
  ['8', 'B'],
  ['e', 'c'],
];
const NOISY_FIELDS: FieldKey[] = ['name', 'position', 'company', 'email', 'phone', 'website'];

function defaults(): FakeConfig {
  return {
    seed: 1,
    latency: { baseMs: 0, jitterMs: 0 },
    usage: DEFAULT_USAGE,
    faults: [],
    misreads: [],
    noise: null,
    locate: [],
    outage: null,
    neighbourBleed: false,
  };
}

function sha(...parts: Array<string | Buffer>): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

/** A repeatable number from 0 up to 1. Depends on the inputs and never on arrival order. */
function unit(...parts: Array<string | number>): number {
  return parseInt(sha(parts.join('|')).slice(0, 12), 16) / 2 ** 48;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyCounts(): CardCounts {
  return { locate: 0, A: 0, B: 0, C: 0 };
}

function emptyStats(): FakeStats {
  return {
    requests: 0,
    byPurpose: { locate: 0, orient: 0, read_a: 0, read_b: 0, read_c: 0, unknown: 0 },
    attempts: {},
    delivered: {},
    faults: {},
    unidentifiedReads: 0,
    multiCardReads: 0,
    neighbourStripReads: 0,
    notUprightReads: 0,
    emptyLocates: 0,
    inFlight: 0,
    inFlightPeak: 0,
    billed: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, responses: 0, costUsd: 0 },
    violations: [],
    log: [],
  };
}

/* ------------------------------------------------------------------ */
/* Response bodies                                                     */
/* ------------------------------------------------------------------ */

interface OpenAiError {
  status: number;
  message: string;
  type: string;
  code: string | null;
}

const ERRORS: Partial<Record<FaultKind, OpenAiError>> = {
  slow_down: { status: 429, message: 'Your request rate increased too quickly.', type: 'rate_limit_error', code: 'slow_down' },
  quota: {
    status: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    type: 'insufficient_quota',
    code: 'insufficient_quota',
  },
  bad_key: { status: 401, message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' },
  server_500: { status: 500, message: 'The server had an error while processing your request.', type: 'server_error', code: null },
  overloaded_503: {
    status: 503,
    message: 'The requested model is temporarily overloaded.',
    type: 'service_unavailable_error',
    code: 'server_is_overloaded',
  },
};

function usageJson(usage: UsagePlan) {
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: usage.cachedInputTokens },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
}

function messageItem(seq: number, content: unknown[], status = 'completed') {
  return { id: `msg_fake_${seq}`, type: 'message', status, role: 'assistant', content };
}

function outputText(text: string) {
  return { type: 'output_text', text, annotations: [], logprobs: [] };
}

function reasoningItem(seq: number) {
  return { id: `rs_fake_${seq}`, type: 'reasoning', summary: [] };
}

function envelope(seq: number, request: Record<string, unknown>, fields: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `resp_fake_${seq}`,
    object: 'response',
    access_programs: null,
    created_at: now,
    status: 'completed',
    completed_at: now,
    error: null,
    incomplete_details: null,
    instructions: request['instructions'] ?? null,
    max_output_tokens: request['max_output_tokens'] ?? null,
    model: request['model'] ?? CONFIG.model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: request['reasoning'] ?? { effort: null, summary: null },
    store: request['store'] ?? true,
    temperature: 1,
    text: request['text'] ?? { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: null,
    user: null,
    metadata: {},
    ...fields,
  };
}

/* ------------------------------------------------------------------ */
/* Request reading and auditing                                        */
/* ------------------------------------------------------------------ */

function collectImages(node: unknown, found: Array<{ url: unknown; detail: unknown }>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectImages(item, found);
  } else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record['type'] === 'input_image') found.push({ url: record['image_url'], detail: record['detail'] });
    else for (const value of Object.values(record)) collectImages(value, found);
  }
}

function collectText(node: unknown, found: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, found);
  } else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record['type'] === 'input_text' && typeof record['text'] === 'string') found.push(record['text']);
    else for (const value of Object.values(record)) collectText(value, found);
  }
}

function strictSchemaProblem(schema: unknown, path = '$'): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const record = schema as Record<string, unknown>;
  if (record['type'] === 'object' || record['properties']) {
    if (record['additionalProperties'] !== false) return `${path}: additionalProperties must be false`;
    const properties = Object.keys((record['properties'] as object | undefined) ?? {});
    const required = (record['required'] as string[] | undefined) ?? [];
    const absent = properties.filter((key) => !required.includes(key));
    if (absent.length > 0) return `${path}: strict mode needs these required: ${absent.join(', ')}`;
  }
  for (const [key, value] of Object.entries(record)) {
    if (value && typeof value === 'object') {
      const problem = strictSchemaProblem(value, `${path}.${key}`);
      if (problem) return problem;
    }
  }
  return null;
}

/** Things the real API would reject, or that break a promise in the plan. */
function audit(body: Record<string, unknown>, formatName: string, images: Array<{ url: unknown; detail: unknown }>): string[] {
  const problems: string[] = [];
  if (body['model'] !== CONFIG.model) problems.push(`model is ${String(body['model'])}, every call must use ${CONFIG.model}`);
  if (body['store'] !== false) problems.push('store must be false');
  if (body['stream']) problems.push('stream must not be used');
  const text = body['text'] as { format?: Record<string, unknown> } | undefined;
  const format = text?.format;
  if (format?.['type'] !== 'json_schema') problems.push('text.format.type must be json_schema');
  if (format?.['strict'] !== true) problems.push('text.format.strict must be true');
  const schemaProblem = strictSchemaProblem(format?.['schema']);
  if (schemaProblem) problems.push(`schema is not valid for strict mode: ${schemaProblem}`);

  const purpose = formatName === SCHEMA_NAMES.locate ? 'locate' : formatName === SCHEMA_NAMES.orient ? 'orient' : 'read';
  const effort = (body['reasoning'] as { effort?: string } | undefined)?.effort;
  if (effort !== CONFIG.reasoningEffort[purpose]) problems.push(`${purpose} reasoning.effort is ${String(effort)}`);
  // The client may raise this when retrying a cut-off answer, but must never send less.
  if (typeof body['max_output_tokens'] !== 'number' || body['max_output_tokens'] < CONFIG.maxOutputTokens[purpose]) {
    problems.push(`${purpose} max_output_tokens is ${String(body['max_output_tokens'])}`);
  }
  if (images.length === 0) problems.push(`${purpose} request has no image`);
  for (const image of images) {
    if (image.detail !== CONFIG.imageDetail) problems.push(`image detail is ${String(image.detail)}`);
    if (typeof image.url !== 'string' || !image.url.startsWith('data:image/')) problems.push('image must be a base64 data URL');
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* Misreads                                                            */
/* ------------------------------------------------------------------ */

function applyToField(read: CardReadData, field: FieldKey, change: (value: string) => string): void {
  if (field === 'name' || field === 'position' || field === 'company') read[field] = change(read[field]);
  else if (field === 'email') read.emails = read.emails.map(change);
  else if (field === 'website') read.websites = read.websites.map(change);
  else read.phones = read.phones.map((phone) => ({ ...phone, number: change(phone.number) }));
}

function setField(read: CardReadData, field: FieldKey, value: string): void {
  if (field === 'name' || field === 'position' || field === 'company') read[field] = value;
  else if (field === 'email') read.emails = value ? [value, ...read.emails.slice(1)] : [];
  else if (field === 'website') read.websites = value ? [value, ...read.websites.slice(1)] : [];
  else read.phones = value ? [{ number: value, label: read.phones[0]?.label ?? '' }, ...read.phones.slice(1)] : [];
}

function fieldText(read: CardReadData, field: FieldKey): string {
  if (field === 'name' || field === 'position' || field === 'company') return read[field];
  if (field === 'email') return read.emails[0] ?? '';
  if (field === 'website') return read.websites[0] ?? '';
  return read.phones[0]?.number ?? '';
}

function applyMisread(read: CardReadData, rule: Misread): void {
  if (rule.blank) setField(read, rule.field, '');
  if (rule.unreadable && !read.unreadable.includes(rule.field)) read.unreadable.push(rule.field);
  if (rule.replace) {
    const { from, to } = rule.replace;
    applyToField(read, rule.field, (value) => value.replaceAll(from, to));
    if (rule.inTranscript !== false) read.transcript = read.transcript.map((line) => line.replaceAll(from, to));
  }
  if (rule.value !== undefined) {
    setField(read, rule.field, rule.value);
    if (rule.inTranscript) read.transcript = [...read.transcript, rule.value];
  }
  if (rule.append !== undefined) {
    if (rule.field === 'email') read.emails = [...read.emails, rule.append];
    else if (rule.field === 'website') read.websites = [...read.websites, rule.append];
    else if (rule.field === 'phone') read.phones = [...read.phones, { number: rule.append, label: '' }];
    if (rule.inTranscript !== false) read.transcript = [...read.transcript, rule.append];
  }
}

function applyNoise(read: CardReadData, cardId: number, variant: ReadVariant, noise: Noise, seed: number): void {
  for (const field of NOISY_FIELDS) {
    const roll = unit(seed, 'noise', cardId, field);
    const correlated = noise.correlatedRate ?? 0;
    let hit = false;
    if (roll < correlated) hit = true;
    else if (roll < correlated + noise.rate) hit = READ_VARIANTS[Math.floor(unit(seed, 'noise-read', cardId, field) * 3)] === variant;
    if (!hit) continue;
    const value = fieldText(read, field);
    const usable = CONFUSIONS.filter(([from]) => value.includes(from));
    const picked = usable[Math.floor(unit(seed, 'noise-pick', cardId, field) * usable.length)];
    if (!picked) continue;
    const [from, to] = picked;
    const at = value.indexOf(from);
    const replaced = value.slice(0, at) + to + value.slice(at + from.length);
    setField(read, field, replaced);
    read.transcript = read.transcript.map((line) => line.replace(value, replaced));
  }
}

/* ------------------------------------------------------------------ */
/* The server                                                          */
/* ------------------------------------------------------------------ */

/**
 * Which of the two locate passes a request is. Vision's second pass sends a
 * contrast-boosted copy and says so in its prompt. The prompt decides, not the
 * image, so a retry stays in its pass and a card the boosted view hides cannot
 * shift the numbering. Pipeline tests assert both passes appear, so a change to
 * the prompt fails loudly instead of quietly merging the passes.
 */
function locatePassOf(promptText: string): 1 | 2 {
  return /contrast/i.test(promptText) ? 2 : 1;
}

export async function startFakeOpenAI(options: FakeOpenAIOptions = {}): Promise<FakeOpenAI> {
  const { port = 0, host = '127.0.0.1', cards: initialCards = [], ...configPatch } = options;
  const cards = new Map<number, FakeCard>();
  for (const card of initialCards) cards.set(card.id, card);

  let config: FakeConfig = { ...defaults(), ...configPatch };
  let stats = emptyStats();
  let fired = new Map<FaultRule, number>();
  let attemptCounts = new Map<string, number>();
  let readImages = new Map<string, string[]>();
  const decodeCache = new Map<string, Promise<DecodedMarker[]>>();
  const timers = new Set<NodeJS.Timeout>();

  const aspectOf = (id: number) => cards.get(id)?.aspect ?? DEFAULT_ASPECT;

  function decode(image: Buffer, key: string, frames: number[] | undefined): Promise<DecodedMarker[]> {
    const cacheKey = `${key}:${frames ? 'full' : 'quick'}`;
    let pending = decodeCache.get(cacheKey);
    if (!pending) {
      pending = decodeMarkers(image, frames);
      decodeCache.set(cacheKey, pending);
    }
    return pending;
  }

  function count(bucket: 'attempts' | 'delivered', cardId: number, slot: keyof CardCounts): void {
    const entry = (stats[bucket][cardId] ??= emptyCounts());
    entry[slot] += 1;
  }

  function firstImage(url: unknown): Buffer | null {
    if (typeof url !== 'string') return null;
    const comma = url.indexOf(',');
    if (!url.startsWith('data:') || comma < 0) return null;
    return Buffer.from(url.slice(comma + 1), 'base64');
  }

  function readVariantOf(body: Record<string, unknown>, cardKey: string, imageKey: string): ReadVariant {
    const hint = (body['metadata'] as { purpose?: string } | undefined)?.purpose;
    if (hint === 'read_a') return 'A';
    if (hint === 'read_b') return 'B';
    if (hint === 'read_c') return 'C';
    // Reads carry identical text, so each card's distinct images stand for its three reads.
    const seen = readImages.get(cardKey) ?? [];
    if (!seen.includes(imageKey)) seen.push(imageKey);
    readImages.set(cardKey, seen);
    return READ_VARIANTS[seen.indexOf(imageKey) % 3]!;
  }

  function faultMatches(rule: FaultRule, purpose: string, cardIds: number[], attempt: number, attemptKey: string, index: number): boolean {
    if (rule.purpose) {
      const family = rule.purpose === 'read' ? purpose.startsWith('read') : purpose === rule.purpose;
      if (!family) return false;
    }
    if (rule.cardIds && !rule.cardIds.some((id) => cardIds.includes(id))) return false;
    if (rule.afterRequests !== undefined && stats.requests <= rule.afterRequests) return false;
    if (rule.maxAttempt !== undefined && attempt > rule.maxAttempt) return false;
    if (rule.times !== undefined && (fired.get(rule) ?? 0) >= rule.times) return false;
    if (rule.rate !== undefined && unit(config.seed, 'fault', index, attemptKey, attempt) >= rule.rate) return false;
    return true;
  }

  function delayFor(key: string): number {
    const { baseMs, jitterMs } = config.latency;
    return baseMs + (jitterMs > 0 ? unit(config.seed, 'latency', key) * jitterMs : 0);
  }

  function wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  }

  function bill(): UsagePlan {
    const usage = config.usage;
    const { billed } = stats;
    const { inputPerM, cachedInputPerM, outputPerM } = CONFIG.pricing;
    billed.inputTokens += usage.inputTokens;
    billed.cachedInputTokens += usage.cachedInputTokens;
    billed.outputTokens += usage.outputTokens;
    billed.reasoningTokens += usage.reasoningTokens;
    billed.responses += 1;
    // Reasoning tokens are already part of outputTokens, and cached tokens part of inputTokens.
    billed.costUsd +=
      ((usage.inputTokens - usage.cachedInputTokens) * inputPerM +
        usage.cachedInputTokens * cachedInputPerM +
        usage.outputTokens * outputPerM) /
      1_000_000;
    return usage;
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  function badRequest(res: ServerResponse, entry: RequestLogEntry, message: string): void {
    entry.httpStatus = 400;
    sendJson(res, 400, { error: { message, type: 'invalid_request_error', param: null, code: null } });
  }

  /** Sends a fault. A released hang returns answer_normally, so the caller still answers. */
  async function sendFault(
    res: ServerResponse,
    request: IncomingMessage,
    entry: RequestLogEntry,
    body: Record<string, unknown>,
    fault: FaultKind,
    retryAfterSeconds: number | undefined,
    hangMs: number | undefined,
  ): Promise<'answered' | 'answer_normally'> {
    entry.fault = fault;
    stats.faults[fault] = (stats.faults[fault] ?? 0) + 1;

    const known = ERRORS[fault];
    if (known) {
      const seconds = retryAfterSeconds ?? (fault === 'slow_down' || fault === 'overloaded_503' ? 1 : 0);
      const headers: Record<string, string> = seconds > 0 ? { 'retry-after': String(seconds) } : {};
      entry.httpStatus = known.status;
      sendJson(res, known.status, { error: { message: known.message, type: known.type, param: null, code: known.code } }, headers);
      return 'answered';
    }

    const usage = () => usageJson(bill());
    switch (fault) {
      case 'hang':
        if (hangMs === undefined) {
          await new Promise<void>((resolve) => request.socket.once('close', () => resolve()));
          return 'answered';
        }
        await wait(hangMs);
        return 'answer_normally';
      case 'connection_reset':
        request.socket.destroy();
        return 'answered';
      case 'malformed_json':
        entry.httpStatus = 200;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"resp_fake","object":"response","output":[{"type":"mess');
        return 'answered';
      case 'malformed_output':
        entry.httpStatus = 200;
        sendJson(
          res,
          200,
          envelope(entry.seq, body, {
            output: [reasoningItem(entry.seq), messageItem(entry.seq, [outputText('{"transcript":["unterminated')])],
            usage: usage(),
          }),
        );
        return 'answered';
      case 'refusal':
        entry.httpStatus = 200;
        sendJson(
          res,
          200,
          envelope(entry.seq, body, {
            output: [messageItem(entry.seq, [{ type: 'refusal', refusal: "I'm sorry, I can't help with that." }])],
            usage: usage(),
          }),
        );
        return 'answered';
      case 'incomplete':
        entry.httpStatus = 200;
        sendJson(
          res,
          200,
          envelope(entry.seq, body, {
            status: 'incomplete',
            completed_at: null,
            incomplete_details: { reason: 'max_output_tokens' },
            output: [reasoningItem(entry.seq), messageItem(entry.seq, [outputText('{"transcript":["Dr. Ja')], 'incomplete')],
            usage: usage(),
          }),
        );
        return 'answered';
      case 'wrong_schema':
        entry.httpStatus = 200;
        sendJson(
          res,
          200,
          envelope(entry.seq, body, {
            output: [reasoningItem(entry.seq), messageItem(entry.seq, [outputText('{"full_name":"Jane","mail":42}')])],
            usage: usage(),
          }),
        );
        return 'answered';
      case 'response_failed':
        entry.httpStatus = 200;
        sendJson(
          res,
          200,
          envelope(entry.seq, body, {
            status: 'failed',
            completed_at: null,
            error: { code: 'server_error', message: 'The model failed to generate a response.' },
          }),
        );
        return 'answered';
      default:
        return 'answer_normally';
    }
  }

  function sendAnswer(res: ServerResponse, entry: RequestLogEntry, body: Record<string, unknown>, answer: unknown): void {
    if (res.destroyed || entry.aborted) return;
    entry.httpStatus = 200;
    entry.delivered = true;
    sendJson(
      res,
      200,
      envelope(entry.seq, body, {
        output: [reasoningItem(entry.seq), messageItem(entry.seq, [outputText(JSON.stringify(answer))])],
        usage: usageJson(bill()),
      }),
    );
  }

  function locateAnswer(markers: DecodedMarker[], pass: 1 | 2, rules: LocateRule[], key: string): LocateWireResult {
    const missed = new Set(rules.flatMap((rule) => (pass === 1 ? (rule.missInPass1 ?? []) : (rule.missInPass2 ?? []))));
    const wrongRotation = new Set(rules.flatMap((rule) => rule.wrongRotation ?? []));
    const jitter = Math.max(0, ...rules.map((rule) => rule.jitter ?? 0));

    const boxes: MarkerBox[] = markers
      .filter((marker) => !missed.has(marker.id))
      .map((marker) => {
        const box = markerToBox(marker, aspectOf(marker.id));
        if (wrongRotation.has(marker.id)) box.rotation = ((box.rotation + 180) % 360) as MarkerBox['rotation'];
        if (jitter > 0) {
          const shift = (edge: string) => Math.round((unit(config.seed, 'jitter', key, pass, marker.id, edge) * 2 - 1) * jitter);
          box.x_min = Math.max(0, box.x_min + shift('x0'));
          box.y_min = Math.max(0, box.y_min + shift('y0'));
          box.x_max = Math.min(1000, box.x_max + shift('x1'));
          box.y_max = Math.min(1000, box.y_max + shift('y1'));
        }
        return box;
      });

    if (rules.some((rule) => rule.phantomInPass === pass)) boxes.push({ x_min: 5, y_min: 5, x_max: 60, y_max: 40, rotation: 0 });
    for (const rule of rules) {
      if (rule.badGeometry?.pass !== pass) continue;
      const first = boxes[0];
      if (!first) continue;
      if (rule.badGeometry.kind === 'inverted') [first.x_min, first.x_max] = [first.x_max, first.x_min];
      if (rule.badGeometry.kind === 'out_of_range') first.x_max = 1400;
      if (rule.badGeometry.kind === 'zero_area') first.x_max = first.x_min;
    }
    if (rules.some((rule) => rule.blindPass === pass)) return { contains_card: false, cards: [] };
    return { contains_card: boxes.length > 0, cards: boxes };
  }

  async function handleLocate(
    res: ServerResponse,
    request: IncomingMessage,
    entry: RequestLogEntry,
    body: Record<string, unknown>,
    images: Buffer[],
    imageKey: string,
  ): Promise<void> {
    const markers = images[0] ? await decode(images[0], imageKey, [4000]) : [];
    if (markers.length === 0) stats.emptyLocates += 1;
    const ids = markers.map((marker) => marker.id);
    const bookKey = ids.length > 0 ? ids.join(',') : imageKey;

    const textParts: string[] = [];
    collectText(body['input'], textParts);
    const pass = locatePassOf(textParts.join('\n'));
    entry.pass = pass;
    entry.cards = ids;

    const attemptKey = `locate|${bookKey}|${pass}`;
    const attempt = (attemptCounts.get(attemptKey) ?? 0) + 1;
    attemptCounts.set(attemptKey, attempt);
    entry.attempt = attempt;
    for (const id of ids) count('attempts', id, 'locate');

    const rules = config.locate.filter((rule) => !rule.cardIds || rule.cardIds.some((id) => ids.includes(id)));
    const passFailure = rules.find((rule) => rule.failPass?.pass === pass)?.failPass;
    if (passFailure) {
      await sendFault(res, request, entry, body, passFailure.fault, passFailure.retryAfterSeconds, undefined);
      return;
    }

    for (const [index, rule] of config.faults.entries()) {
      if (!faultMatches(rule, 'locate', ids, attempt, attemptKey, index)) continue;
      fired.set(rule, (fired.get(rule) ?? 0) + 1);
      const outcome = await sendFault(res, request, entry, body, rule.fault, rule.retryAfterSeconds, rule.hangMs);
      if (outcome === 'answered') return;
      break;
    }

    await wait(delayFor(`${attemptKey}|${attempt}`));
    const answer = locateAnswer(markers, pass, rules, bookKey);
    sendAnswer(res, entry, body, answer);
    if (entry.delivered) for (const id of ids) count('delivered', id, 'locate');
  }

  function buildRead(cardIds: number[], variant: ReadVariant, neighbours: number[]): CardReadData {
    const merged = clone(EMPTY_READ);
    for (const id of cardIds) {
      const card = cards.get(id);
      if (!card) continue;
      const read = clone(card.read);
      for (const rule of config.misreads) {
        if (rule.cardIds && !rule.cardIds.includes(id)) continue;
        if ((rule.variants ?? READ_VARIANTS).includes(variant)) applyMisread(read, rule);
      }
      if (config.noise) applyNoise(read, id, variant, config.noise, config.seed);
      merged.transcript.push(...read.transcript);
      merged.name ||= read.name;
      merged.position ||= read.position;
      merged.company ||= read.company;
      merged.emails.push(...read.emails);
      merged.phones.push(...read.phones);
      merged.websites.push(...read.websites);
      merged.unreadable.push(...read.unreadable.filter((field) => !merged.unreadable.includes(field)));
    }
    if (config.neighbourBleed) {
      for (const id of neighbours) {
        const email = cards.get(id)?.read.emails[0];
        if (!email) continue;
        merged.emails.push(email);
        merged.transcript.push(email);
      }
    }
    return merged;
  }

  async function handleRead(
    res: ServerResponse,
    request: IncomingMessage,
    entry: RequestLogEntry,
    body: Record<string, unknown>,
    images: Buffer[],
    imageKey: string,
  ): Promise<void> {
    const primaries: DecodedMarker[] = [];
    const neighbours = new Set<number>();
    for (const [index, image] of images.entries()) {
      const markers = await decode(image, `${imageKey}:${index}`, undefined);
      const primary = primaryMarker(markers, aspectOf);
      if (!primary) continue;
      primaries.push(primary);
      const whole = markers.filter((marker) => visibleShare(marker, aspectOf(marker.id)) >= 0.5 * visibleShare(primary, aspectOf(primary.id)));
      if (whole.length > 1) stats.multiCardReads += 1;
      else if (markers.length > 1) stats.neighbourStripReads += 1;
      for (const marker of markers) if (marker.id !== primary.id && whole.length <= 1) neighbours.add(marker.id);
      if (Math.abs(((primary.angleDeg + 180) % 360) - 180) > 20) stats.notUprightReads += 1;
    }
    const cardIds = primaries.map((marker) => marker.id);
    if (cardIds.length === 0) stats.unidentifiedReads += 1;

    const cardKey = cardIds.length > 0 ? cardIds.join('+') : imageKey;
    const variant = readVariantOf(body, cardKey, imageKey);
    const purpose = `read_${variant.toLowerCase()}` as 'read_a' | 'read_b' | 'read_c';
    entry.purpose = purpose;
    stats.byPurpose.unknown -= 1;
    stats.byPurpose[purpose] += 1;
    entry.cards = cardIds;

    const attemptKey = `${purpose}|${cardKey}`;
    const attempt = (attemptCounts.get(attemptKey) ?? 0) + 1;
    attemptCounts.set(attemptKey, attempt);
    entry.attempt = attempt;
    for (const id of cardIds) count('attempts', id, variant);

    for (const [index, rule] of config.faults.entries()) {
      if (!faultMatches(rule, purpose, cardIds, attempt, attemptKey, index)) continue;
      fired.set(rule, (fired.get(rule) ?? 0) + 1);
      const outcome = await sendFault(res, request, entry, body, rule.fault, rule.retryAfterSeconds, rule.hangMs);
      if (outcome === 'answered') return;
      break;
    }

    await wait(delayFor(`${attemptKey}|${attempt}`));
    sendAnswer(res, entry, body, buildRead(cardIds, variant, [...neighbours]));
    if (entry.delivered) for (const id of cardIds) count('delivered', id, variant);
  }

  async function handleResponses(request: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
    stats.requests += 1;
    stats.inFlight += 1;
    stats.inFlightPeak = Math.max(stats.inFlightPeak, stats.inFlight);
    const entry: RequestLogEntry = {
      seq: stats.requests,
      receivedAt: Date.now(),
      finishedAt: null,
      purpose: 'unknown',
      pass: null,
      cards: [],
      attempt: 1,
      fault: null,
      httpStatus: null,
      delivered: false,
      aborted: false,
      inFlightAtStart: stats.inFlight,
    };
    stats.log.push(entry);
    res.once('close', () => {
      stats.inFlight -= 1;
      entry.finishedAt = Date.now();
      if (!res.writableFinished) entry.aborted = true;
    });

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      stats.byPurpose.unknown += 1;
      stats.violations.push('request body was not JSON');
      badRequest(res, entry, 'We could not parse the JSON body of your request.');
      return;
    }

    const formatName = (body['text'] as { format?: { name?: string } } | undefined)?.format?.name ?? '';
    const imageParts: Array<{ url: unknown; detail: unknown }> = [];
    collectImages(body['input'], imageParts);
    stats.violations.push(...audit(body, formatName, imageParts).map((problem) => `#${entry.seq}: ${problem}`));

    const isLocate = formatName === SCHEMA_NAMES.locate;
    const isOrient = formatName === SCHEMA_NAMES.orient;
    const isRead = formatName === SCHEMA_NAMES.read;
    if (isLocate) {
      entry.purpose = 'locate';
      stats.byPurpose.locate += 1;
    } else if (isOrient) {
      entry.purpose = 'orient';
      stats.byPurpose.orient += 1;
    } else {
      stats.byPurpose.unknown += 1;
    }
    if (!isLocate && !isOrient && !isRead) {
      stats.violations.push(`#${entry.seq}: unknown text.format.name "${formatName}"`);
      badRequest(res, entry, `Unknown schema name ${formatName}.`);
      return;
    }

    const outage = config.outage;
    if (outage && stats.requests > (outage.afterRequests ?? 0)) {
      await sendFault(res, request, entry, body, outage.fault, outage.retryAfterSeconds, undefined);
      return;
    }

    if (isOrient) {
      // The picture is four turns of one crop and tile 1 is the card as locate turned it, so
      // "tile 1" means "keep locate's rotation". Whether locate's rotation is right is not judged here.
      sendAnswer(res, entry, body, { upright_tile: 1 });
      return;
    }

    const images = imageParts.map((part) => firstImage(part.url)).filter((image): image is Buffer => image !== null);
    const imageKey = sha(...images);
    if (isLocate) await handleLocate(res, request, entry, body, images, imageKey);
    else await handleRead(res, request, entry, body, images, imageKey);
  }

  async function handleControl(url: string, raw: Buffer, res: ServerResponse): Promise<void> {
    if (url === '/__fake/stats') return sendJson(res, 200, stats);
    const payload = (raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {}) as Partial<FakeConfig> & { cards?: FakeCard[] };
    if (url === '/__fake/reset') service.reset();
    else if (url === '/__fake/clear-outage') service.clearOutage();
    else if (url === '/__fake/configure') {
      const { cards: added, ...patch } = payload;
      if (added) service.addCards(added);
      service.configure(patch);
    } else return sendJson(res, 404, { error: 'unknown control path' });
    return sendJson(res, 200, { ok: true });
  }

  const server = createServer((request, res) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = (request.url ?? '').split('?')[0] ?? '';
      const done = url.startsWith('/__fake/')
        ? handleControl(url, raw, res)
        : url === '/v1/responses' && request.method === 'POST'
          ? handleResponses(request, res, raw)
          : Promise.resolve(sendJson(res, 404, { error: { message: `No such route: ${url}`, type: 'invalid_request_error', param: null, code: null } }));
      done.catch((error: unknown) => {
        stats.violations.push(`fake server error: ${String(error)}`);
        sendJson(res, 500, { error: { message: String(error), type: 'server_error', param: null, code: null } });
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const boundPort = (server.address() as AddressInfo).port;

  const service: FakeOpenAI = {
    url: `http://${host}:${boundPort}/v1`,
    port: boundPort,
    addCards(added) {
      for (const card of added) cards.set(card.id, card);
    },
    configure(patch) {
      config = { ...config, ...patch };
    },
    clearOutage() {
      config = { ...config, outage: null };
    },
    reset() {
      config = { ...defaults(), seed: config.seed };
      stats = emptyStats();
      fired = new Map();
      attemptCounts = new Map();
      readImages = new Map();
    },
    stats: () => stats,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return service;
}

/** Known cards from a truth file written by the synth generator. */
export function cardsFromTruth(path: string): FakeCard[] {
  const truth = JSON.parse(readFileSync(path, 'utf8')) as {
    files: Array<{ cards?: Array<{ markerId?: number; aspect?: number; read?: CardReadData }> }>;
  };
  const found: FakeCard[] = [];
  for (const file of truth.files) {
    for (const card of file.cards ?? []) {
      if (card.markerId !== undefined && card.read) {
        found.push({ id: card.markerId, aspect: card.aspect ?? DEFAULT_ASPECT, read: card.read });
      }
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Standalone                                                          */
/* ------------------------------------------------------------------ */

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '4010' },
      host: { type: 'string', default: '127.0.0.1' },
      truth: { type: 'string' },
      seed: { type: 'string', default: '1' },
    },
  });
  const fake = await startFakeOpenAI({
    port: Number(values.port),
    host: values.host,
    seed: Number(values.seed),
    cards: values.truth ? cardsFromTruth(values.truth) : [],
  });
  console.log(`Fake OpenAI listening at ${fake.url}`);
  const stop = () => void fake.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
