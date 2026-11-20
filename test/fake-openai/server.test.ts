/**
 * Proves the fake is faithful: the real openai SDK v7 parses every answer with
 * responses.parse and zodTextFormat, and each fault looks the way the SDK sees it
 * from the real API. Also proves card identification and determinism.
 */
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CONFIG } from '../../src/shared/config.ts';
import { FIELD_KEYS, SCHEMA_NAMES } from '../../src/shared/contracts.ts';
import type { CardReadData } from '../../src/shared/contracts.ts';
import { markerSvg } from './marker.ts';
import { startFakeOpenAI } from './server.ts';
import type { FakeOpenAI, FaultKind } from './server.ts';

const ReadSchema = z.strictObject({
  transcript: z.array(z.string()),
  name: z.string(),
  position: z.string(),
  company: z.string(),
  emails: z.array(z.string()),
  phones: z.array(z.strictObject({ number: z.string(), label: z.string() })),
  websites: z.array(z.string()),
  unreadable: z.array(z.enum(FIELD_KEYS)),
});
const LocateSchema = z.strictObject({
  contains_card: z.boolean(),
  cards: z.array(
    z.strictObject({
      x_min: z.number(),
      y_min: z.number(),
      x_max: z.number(),
      y_max: z.number(),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    }),
  ),
});

const read = (name: string, email: string): CardReadData => ({
  transcript: [name, 'Engineer', 'Acme Works', `Tel: +1 415 555 0132`, email],
  name,
  position: 'Engineer',
  company: 'Acme Works',
  emails: [email],
  phones: [{ number: '+1 415 555 0132', label: 'Tel' }],
  websites: [],
  unreadable: [],
});

const CARDS = [
  { id: 11, aspect: 1.75, read: read('Fern Barnes', 'fern@barnwell.com') },
  { id: 12, aspect: 1.75, read: read('Jane Doe', 'jane@acme.com') },
  { id: 13, aspect: 1.75, read: read('Ana Ruiz', 'ana@ruiz.es') },
];

async function cardPng(id: number, variant = 0): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="600"><rect width="1050" height="600" fill="#fff"/>${markerSvg(id, 1050)}<circle cx="${500 + variant}" cy="340" r="90" fill="#333"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const dataUrl = (image: Buffer) => `data:image/png;base64,${image.toString('base64')}`;

describe('fake OpenAI server with the real SDK', () => {
  let fake: FakeOpenAI;
  let client: OpenAI;
  let image11: Buffer;

  const callRead = (image: Buffer) =>
    client.responses.parse({
      model: CONFIG.model,
      instructions: 'Read this card.',
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: dataUrl(image), detail: CONFIG.imageDetail as 'original' }] }],
      text: { format: zodTextFormat(ReadSchema, SCHEMA_NAMES.read) },
      reasoning: { effort: CONFIG.reasoningEffort.read },
      max_output_tokens: CONFIG.maxOutputTokens.read,
      store: false,
    });

  const callLocate = (image: Buffer) =>
    client.responses.parse({
      model: CONFIG.model,
      instructions: 'Find every card.',
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: dataUrl(image), detail: CONFIG.imageDetail as 'original' }] }],
      text: { format: zodTextFormat(LocateSchema, SCHEMA_NAMES.locate) },
      reasoning: { effort: CONFIG.reasoningEffort.locate },
      max_output_tokens: CONFIG.maxOutputTokens.locate,
      store: false,
    });

  beforeAll(async () => {
    fake = await startFakeOpenAI({ cards: CARDS });
    client = new OpenAI({ apiKey: 'test-key', baseURL: fake.url, maxRetries: 0, timeout: 5_000 });
    image11 = await cardPng(11);
  });
  afterEach(() => fake.reset());
  afterAll(() => fake.close());

  it('returns a read the real SDK parses unmodified, and names the right card', async () => {
    const response = await callRead(image11);
    expect(response.status).toBe('completed');
    expect(response.output_parsed).toEqual(CARDS[0]!.read);
    expect(response.usage?.output_tokens_details.reasoning_tokens).toBe(240);
    expect(response.output[0]?.type).toBe('reasoning');
    const stats = fake.stats();
    expect(stats.violations).toEqual([]);
    expect(stats.delivered[11]).toEqual({ locate: 0, A: 1, B: 0, C: 0 });
  });

  it('returns a locate answer the real SDK parses unmodified', async () => {
    const response = await callLocate(image11);
    const parsed = response.output_parsed!;
    expect(parsed.contains_card).toBe(true);
    expect(parsed.cards).toHaveLength(1);
    const box = parsed.cards[0]!;
    expect(box.rotation).toBe(0);
    expect(box.x_min).toBeLessThanOrEqual(5);
    expect(box.x_max).toBeGreaterThanOrEqual(995);
    expect(fake.stats().byPurpose.locate).toBe(1);
  });

  it('reports no card for an image with no strip', async () => {
    const blank = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#556677' } }).png().toBuffer();
    const response = await callLocate(blank);
    expect(response.output_parsed).toEqual({ contains_card: false, cards: [] });
  });

  it('gives each of a card’s three distinct images its own read variant', async () => {
    await callRead(await cardPng(12, 0));
    await callRead(await cardPng(12, 3));
    await callRead(await cardPng(12, 6));
    await callRead(await cardPng(12, 3));
    expect(fake.stats().delivered[12]).toEqual({ locate: 0, A: 1, B: 2, C: 1 });
  });

  const expectApiError = async (fault: FaultKind, status: number, code: string | null) => {
    fake.configure({ faults: [{ fault, purpose: 'read' }] });
    const error = await callRead(image11).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAI.APIError);
    expect((error as InstanceType<typeof OpenAI.APIError>).status).toBe(status);
    expect((error as InstanceType<typeof OpenAI.APIError>).code ?? null).toBe(code);
    return error as InstanceType<typeof OpenAI.APIError>;
  };

  it('slow_down is a 429 with Retry-After', async () => {
    const error = await expectApiError('slow_down', 429, 'slow_down');
    expect(error.headers?.get('retry-after')).toBe('1');
  });
  it('quota is a 429 with no Retry-After', async () => {
    const error = await expectApiError('quota', 429, 'insufficient_quota');
    expect(error.headers?.get('retry-after')).toBeNull();
  });
  it('bad key is a 401', async () => {
    await expectApiError('bad_key', 401, 'invalid_api_key');
  });
  it('server errors are a 500 and an overloaded 503', async () => {
    await expectApiError('server_500', 500, null);
    await expectApiError('overloaded_503', 503, 'server_is_overloaded');
  });

  it('refusal arrives as a refusal part with nothing parsed', async () => {
    fake.configure({ faults: [{ fault: 'refusal' }] });
    const response = await callRead(image11);
    expect(response.output_parsed).toBeNull();
    const message = response.output.find((item) => item.type === 'message');
    expect(message?.type === 'message' && message.content[0]?.type).toBe('refusal');
  });

  it('status incomplete stays unparsed and gives the reason', async () => {
    fake.configure({ faults: [{ fault: 'incomplete' }] });
    const response = await callRead(image11);
    expect(response.status).toBe('incomplete');
    expect(response.incomplete_details?.reason).toBe('max_output_tokens');
    expect(response.output_parsed).toBeNull();
  });

  it('status failed stays unparsed', async () => {
    fake.configure({ faults: [{ fault: 'response_failed' }] });
    const response = await callRead(image11);
    expect(response.status).toBe('failed');
    expect(response.output_parsed).toBeNull();
  });

  it('malformed bodies, malformed output and wrong schemas all throw from the SDK', async () => {
    for (const fault of ['malformed_json', 'malformed_output', 'wrong_schema'] as const) {
      fake.configure({ faults: [{ fault }] });
      await expect(callRead(image11), fault).rejects.toThrow();
    }
  });

  it('a hung request ends in the client’s timeout, and a dropped socket in a connection error', async () => {
    const quick = new OpenAI({ apiKey: 'k', baseURL: fake.url, maxRetries: 0, timeout: 200 });
    fake.configure({ faults: [{ fault: 'hang' }] });
    const call = () =>
      quick.responses.create({ model: CONFIG.model, input: [{ role: 'user', content: [{ type: 'input_image', image_url: dataUrl(image11), detail: 'original' }] }], text: { format: { type: 'json_schema', name: SCHEMA_NAMES.read, strict: true, schema: { type: 'object', properties: {}, required: [], additionalProperties: false } } }, store: false });
    await expect(call()).rejects.toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
    fake.configure({ faults: [{ fault: 'connection_reset' }] });
    await expect(call()).rejects.toBeInstanceOf(OpenAI.APIConnectionError);
  });

  it('a fault limited by maxAttempt lets the retry succeed', async () => {
    fake.configure({ faults: [{ fault: 'server_500', purpose: 'read', maxAttempt: 1 }] });
    await expect(callRead(image11)).rejects.toThrow();
    await expect(callRead(image11)).resolves.toMatchObject({ status: 'completed' });
  });

  it('an outage fails everything until cleared', async () => {
    fake.configure({ outage: { fault: 'quota' } });
    await expect(callRead(image11)).rejects.toMatchObject({ code: 'insufficient_quota' });
    await expect(callLocate(image11)).rejects.toMatchObject({ code: 'insufficient_quota' });
    fake.clearOutage();
    await expect(callRead(image11)).resolves.toMatchObject({ status: 'completed' });
  });

  it('a correlated misread lands in the field and the transcript of every read', async () => {
    fake.configure({ misreads: [{ cardIds: [11], field: 'email', replace: { from: 'barnwell', to: 'bamwell' } }] });
    const first = (await callRead(image11)).output_parsed!;
    expect(first.emails).toEqual(['fern@bamwell.com']);
    expect(first.transcript).toContain('fern@bamwell.com');
  });

  it('an invented value stays out of the transcript', async () => {
    fake.configure({ misreads: [{ cardIds: [11], field: 'website', value: 'www.barnwell.com' }] });
    const parsed = (await callRead(image11)).output_parsed!;
    expect(parsed.websites).toEqual(['www.barnwell.com']);
    expect(parsed.transcript).not.toContain('www.barnwell.com');
  });

  it('flags requests that break the rules the plan sets', async () => {
    await client.responses.parse({
      model: 'gpt-4o',
      input: 'hello',
      text: { format: zodTextFormat(ReadSchema, SCHEMA_NAMES.read) },
    });
    const violations = fake.stats().violations.join('\n');
    expect(violations).toMatch(/every call must use gpt-6-luna/);
    expect(violations).toMatch(/store must be false/);
    expect(violations).toMatch(/has no image/);
  });

  it('bills reasoning inside output tokens, and cached tokens at the cached price', async () => {
    await callRead(image11);
    const { billed } = fake.stats();
    const expected = ((1_800 - 256) * 0.1 + 256 * 0.01 + 640 * 0.5) / 1_000_000;
    expect(billed.costUsd).toBeCloseTo(expected, 12);
    expect(billed.responses).toBe(1);
  });
});

describe('determinism', () => {
  it('gives the same faults whatever order requests arrive in', async () => {
    const run = async (order: number[]) => {
      const fake = await startFakeOpenAI({ cards: CARDS, seed: 7, faults: [{ fault: 'server_500', purpose: 'read', rate: 0.5 }] });
      const client = new OpenAI({ apiKey: 'k', baseURL: fake.url, maxRetries: 0 });
      const outcome = new Map<number, string>();
      for (const id of order) {
        const image = await cardPng(id);
        const result = await client.responses
          .parse({
            model: CONFIG.model,
            input: [{ role: 'user', content: [{ type: 'input_image', image_url: dataUrl(image), detail: 'original' }] }],
            text: { format: zodTextFormat(ReadSchema, SCHEMA_NAMES.read) },
            store: false,
          })
          .then(
            () => 'ok',
            () => 'fail',
          );
        outcome.set(id, result);
      }
      await fake.close();
      return [...outcome.entries()].sort(([p], [q]) => p - q);
    };
    expect(await run([11, 12, 13])).toEqual(await run([13, 11, 12]));
  });
});
