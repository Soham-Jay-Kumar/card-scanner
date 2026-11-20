/** Typed calls to the local server. */
import type {
  Card,
  CardRow,
  ClipboardPayload,
  CardLocation,
  FieldKey,
  Job,
  JobProgress,
  ReadRecord,
  Reconciliation,
  SourceFile,
  VerifyPasteReport,
} from '../shared/contracts.ts';

export interface CardSummary {
  id: string;
  status: Card['status'];
  row: CardRow | null;
  flaggedFields: FieldKey[];
  confirmedByHuman: boolean;
  possibleDuplicateOf: string | null;
  error: string | null;
  sourceName: string;
  sourceFileIds: string[];
}

export interface AppStatus {
  hasApiKey: boolean;
  model: string;
  maxCardsPerJob: number;
}

export interface CopyResult {
  verified: boolean;
  detail: string;
  rowCount: number;
  fallback: ClipboardPayload | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? `The server answered with an error (${response.status}).`);
  return body as T;
}

const postJson = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  status: () => request<AppStatus>('/api/status'),
  listJobs: () => request<Array<Job & { reconciliation: Reconciliation }>>('/api/jobs'),
  createJob: (body: { name: string; frontBackPairs: boolean; defaultCountry: string | null }) =>
    postJson<Job>('/api/jobs', body),
  getJob: (id: string) => request<Job>(`/api/jobs/${id}`),
  deleteJob: (id: string) => request<{ deleted: boolean }>(`/api/jobs/${id}`, { method: 'DELETE' }),
  uploadFile: (jobId: string, name: string, blob: Blob) =>
    request<SourceFile>(`/api/jobs/${jobId}/files`, {
      method: 'POST',
      headers: { 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream' },
      body: blob,
    }),
  listFiles: (jobId: string) => request<SourceFile[]>(`/api/jobs/${jobId}/files`),
  /** Adds a card the app missed, from a box the user drew on the photo. */
  addCard: (fileId: string, location: CardLocation) => postJson<CardSummary>(`/api/files/${fileId}/cards`, location),
  /** The user looked at the photo and every card has been found. */
  confirmCount: (fileId: string) => postJson<SourceFile>(`/api/files/${fileId}/confirm-count`),
  start: (id: string) => postJson<JobProgress>(`/api/jobs/${id}/start`),
  pause: (id: string) => postJson<JobProgress>(`/api/jobs/${id}/pause`),
  resume: (id: string) => postJson<JobProgress>(`/api/jobs/${id}/resume`),
  cancel: (id: string) => postJson<JobProgress>(`/api/jobs/${id}/cancel`),
  setCostCap: (id: string, costCapUsd: number) => postJson<JobProgress>(`/api/jobs/${id}/cost-cap`, { costCapUsd }),
  progress: (id: string) => request<JobProgress>(`/api/jobs/${id}/progress`),
  listCards: (id: string) => request<CardSummary[]>(`/api/jobs/${id}/cards`),
  getCard: (id: string) => request<{ card: Card; reads: ReadRecord[] }>(`/api/cards/${id}`),
  confirmCard: (id: string, row: CardRow) => postJson<CardSummary>(`/api/cards/${id}/confirm`, { row }),
  rejectCard: (id: string, reason: string) => postJson<CardSummary>(`/api/cards/${id}/reject`, { reason }),
  copy: (id: string, includeHeader: boolean) => postJson<CopyResult>(`/api/jobs/${id}/copy`, { includeHeader }),
  verifyPaste: (id: string, pastedText: string) =>
    postJson<VerifyPasteReport>(`/api/jobs/${id}/verify-paste`, { pastedText }),
};
