/** Sorts an SDK exception into what the client should do about it. */
import { APIConnectionError, APIError } from 'openai';
import type { PauseReason } from '../shared/contracts.ts';

export type ErrorVerdict =
  | { kind: 'pause'; reason: PauseReason; message: string }
  /** The request itself was rejected, so sending it again can't help. */
  | { kind: 'rejected'; detail: string }
  | {
      kind: 'transient';
      detail: string;
      retryAfterMs: number | null;
      rateLimited: boolean;
      connection: boolean;
      /** Says quota or billing but also Retry-After: retried, then paused if it never clears. */
      quota: boolean;
    };

const QUOTA_CODES = new Set(['insufficient_quota', 'billing_not_active', 'billing_hard_limit_reached']);
/**
 * Plain rate-limit messages link to the billing page, so a bare /billing/ match
 * would pause a job for an ordinary 429. Only OpenAI's quota sentence counts.
 */
const QUOTA_MESSAGE = /exceeded your current quota|check your plan and billing/i;

const NO_CREDIT = 'OpenAI says this account is out of credit. Add credit, then press Resume.';
const BAD_KEY = 'OpenAI rejected the API key. Check OPENAI_API_KEY, then press Resume.';
const NO_MODEL_ACCESS = 'This API key has no access to the model. Check the account, then press Resume.';

function pointsToQuota(error: APIError): boolean {
  return QUOTA_CODES.has(error.code ?? '') || QUOTA_CODES.has(error.type ?? '') || QUOTA_MESSAGE.test(error.message);
}

export function parseRetryAfterMs(headers: Headers | undefined): number | null {
  const ms = Number.parseFloat(headers?.get('retry-after-ms') ?? '');
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers?.get('retry-after');
  if (!value) return null;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function transient(detail: string, retryAfterMs: number | null, flags: { rateLimited?: boolean; connection?: boolean; quota?: boolean } = {}): ErrorVerdict {
  return {
    kind: 'transient',
    detail,
    retryAfterMs,
    rateLimited: flags.rateLimited ?? false,
    connection: flags.connection ?? false,
    quota: flags.quota ?? false,
  };
}

function classify429(error: APIError, retryAfterMs: number | null): ErrorVerdict {
  const quota = error.code !== 'slow_down' && pointsToQuota(error);
  if (quota && retryAfterMs === null) return { kind: 'pause', reason: 'out_of_credit', message: NO_CREDIT };
  return transient(error.message, retryAfterMs, { rateLimited: true, quota });
}

export function classifyError(error: unknown): ErrorVerdict {
  if (error instanceof APIConnectionError) return transient(error.message, null, { connection: true });
  if (!(error instanceof APIError) || error.status === undefined) {
    return transient(error instanceof Error ? error.message : String(error), null, { connection: true });
  }

  const { status } = error;
  const retryAfterMs = parseRetryAfterMs(error.headers);
  if (status === 401 || status === 403) return { kind: 'pause', reason: 'bad_api_key', message: BAD_KEY };
  if (status === 429) return classify429(error, retryAfterMs);
  if (status === 408 || status === 409 || status >= 500) return transient(error.message, retryAfterMs);
  if (status === 404 && error.code === 'model_not_found') {
    return { kind: 'pause', reason: 'bad_api_key', message: NO_MODEL_ACCESS };
  }
  if (QUOTA_CODES.has(error.code ?? '')) return { kind: 'pause', reason: 'out_of_credit', message: NO_CREDIT };
  return { kind: 'rejected', detail: error.message };
}
