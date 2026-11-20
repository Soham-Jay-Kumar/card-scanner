/**
 * Central configuration. Owned by the Chief Engineer.
 * Model ID, tuning values and pricing all live here, so changing them never
 * means touching pipeline code.
 */
export const CONFIG = {
  /** The user chose GPT-6 Luna for every model call. Do not add other models. */
  model: 'gpt-6-luna',
  reasoningEffort: { locate: 'low', orient: 'low', read: 'high' },
  /** OpenAI's recommended detail level for OCR. Luna support is unconfirmed until a real API call. */
  imageDetail: 'original',
  /** Locate returns one box per card, and a single image can hold 30+ cards. */
  maxOutputTokens: { locate: 12_000, orient: 4_000, read: 12_000 },

  image: {
    /** Long edge of the image sent to the locate pass. High, because one image can hold 30+ cards. */
    locateLongEdge: 3_000,
    /** Long-edge bounds for read crops. Small scans are enlarged, huge photos reduced. */
    cropMinLongEdge: 1_600,
    cropMaxLongEdge: 3_000,
    /** Margin added around each located card, as a fraction of the box's size. */
    cropMarginRatio: 0.04,
    jpegQuality: 92,
    /** OpenAI rejects, rather than resizes, images above this. */
    maxPatchesPerImage: 30_000,
  },

  /** Pricing for gpt-6-luna, USD per 1M tokens. Used for the live cost display and cap. */
  pricing: { inputPerM: 0.1, cachedInputPerM: 0.01, outputPerM: 0.5 },

  job: {
    maxCardsPerJob: 1_000,
    defaultCostCapUsd: 10,
  },

  concurrency: {
    /** Start low and ramp up: OpenAI returns slow_down when traffic rises too quickly. */
    initial: 4,
    min: 1,
    max: 32,
  },

  retries: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000, requestTimeoutMs: 120_000 },

  server: { host: '127.0.0.1', port: 4173 },

  paths: { dataDir: 'data', dbFile: 'data/card-scanner.sqlite', jobsDir: 'data/jobs' },
} as const;

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
