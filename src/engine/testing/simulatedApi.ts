/**
 * A stand-in for the OpenAI Responses endpoint, for the benchmark only: latency,
 * token and request limits, occasional errors. Its numbers are assumptions, so
 * anything measured against it is simulated, not a real API result.
 */
export interface ApiModel {
  readLatencyMs: number;
  locateLatencyMs: number;
  tokensPerMinute: number;
  requestsPerMinute: number;
  /** Count max_output_tokens against the limit, as OpenAI's rate-limit guide describes. */
  reserveMaxOutput: boolean;
  /**
   * Models "no more than 50% more every 15 minutes, once at 1M input TPM" as a cap
   * on input tokens that rises each 15 minutes. How OpenAI really applies it is unknown.
   */
  rampRule: boolean;
  errorRate: number;
}

/** From the plan: about 20k tokens per card at 0.12 cents per read. */
export const READ_TOKENS = { input: 5_333, output: 1_334 };
/** Assumed. A 3,000px image costs about what a read crop does, at low reasoning effort. */
export const LOCATE_TOKENS = { input: 5_500, outputBase: 800, outputPerCard: 60 };

const RAMP_START_INPUT_TPM = 1_000_000;
const RAMP_WINDOW_MS = 15 * 60_000;
const REJECT_LATENCY_MS = 150;
const LATENCY_SPREAD = 0.4;

export interface ApiStats {
  requests: number;
  rateLimited: number;
  slowDowns: number;
  serverErrors: number;
  peakInFlight: number;
  inputTokens: number;
  outputTokens: number;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function simulatedApi(model: ApiModel): { fetch: typeof globalThis.fetch; stats: ApiStats } {
  const random = seededRandom(42);
  const stats: ApiStats = { requests: 0, rateLimited: 0, slowDowns: 0, serverErrors: 0, peakInFlight: 0, inputTokens: 0, outputTokens: 0 };
  const startedAt = Date.now();
  let lastRefillAt = startedAt;
  let tokenBudget = model.tokensPerMinute;
  let requestBudget = model.requestsPerMinute;
  let inputBudget = RAMP_START_INPUT_TPM;
  let inFlight = 0;

  const inputCap = (now: number): number => RAMP_START_INPUT_TPM * 1.5 ** Math.floor((now - startedAt) / RAMP_WINDOW_MS);

  function refill(now: number): void {
    const elapsedMinutes = (now - lastRefillAt) / 60_000;
    lastRefillAt = now;
    tokenBudget = Math.min(model.tokensPerMinute, tokenBudget + model.tokensPerMinute * elapsedMinutes);
    requestBudget = Math.min(model.requestsPerMinute, requestBudget + model.requestsPerMinute * elapsedMinutes);
    inputBudget = Math.min(inputCap(now), inputBudget + inputCap(now) * elapsedMinutes);
  }

  const latency = (mean: number): number => mean * Math.exp(LATENCY_SPREAD * (random() + random() + random() - 1.5));

  async function handle(body: string): Promise<Response> {
    stats.requests += 1;
    const cards = /sheet-cards=(\d+)/.exec(body)?.[1];
    const isLocate = cards !== undefined;
    const input = isLocate ? LOCATE_TOKENS.input : READ_TOKENS.input;
    const output = isLocate ? LOCATE_TOKENS.outputBase + LOCATE_TOKENS.outputPerCard * Number(cards) : READ_TOKENS.output;
    const maxOutput = Number(/"max_output_tokens":(\d+)/.exec(body)?.[1] ?? 0);
    const charged = model.reserveMaxOutput ? Math.max(maxOutput, input) : input + output;

    const now = Date.now();
    refill(now);
    if (model.rampRule && inputBudget < input) {
      stats.slowDowns += 1;
      await wait(REJECT_LATENCY_MS);
      return jsonResponse({ error: { message: 'Too fast.', type: 'rate_limit_error', code: 'slow_down', param: null } }, 429, { 'retry-after': '2' });
    }
    if (tokenBudget < charged || requestBudget < 1) {
      stats.rateLimited += 1;
      await wait(REJECT_LATENCY_MS);
      const retryAfterMs = Math.ceil(((charged - tokenBudget) / model.tokensPerMinute) * 60_000) + 50;
      return jsonResponse({ error: { message: 'Rate limit reached.', type: 'tokens', code: 'rate_limit_exceeded', param: null } }, 429, {
        'retry-after-ms': String(Math.max(50, retryAfterMs)),
      });
    }
    tokenBudget -= charged;
    requestBudget -= 1;
    if (model.rampRule) inputBudget -= input;

    await wait(latency(isLocate ? model.locateLatencyMs : model.readLatencyMs));
    if (random() < model.errorRate) {
      stats.serverErrors += 1;
      return jsonResponse({ error: { message: 'Server error.', type: 'server_error', code: null, param: null } }, 500);
    }
    stats.inputTokens += input;
    stats.outputTokens += output;
    return jsonResponse({
      id: 'resp_sim',
      object: 'response',
      model: 'gpt-6-luna',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }] }],
      usage: {
        input_tokens: input,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: output,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: input + output,
      },
    });
  }

  return {
    stats,
    fetch: async (_url, init) => {
      inFlight += 1;
      stats.peakInFlight = Math.max(stats.peakInFlight, inFlight);
      try {
        return await handle(String(init?.body));
      } finally {
        inFlight -= 1;
      }
    },
  };
}
