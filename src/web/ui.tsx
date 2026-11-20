/** Small shared pieces: icons, status labels and formatting. */
import type { ReactNode } from 'react';
import type { Card, PauseReason } from '../shared/contracts.ts';

function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const CheckIcon = () => (
  <Icon><path d="M3 8.5 6.5 12 13 4.5" /></Icon>
);
export const AlertIcon = () => (
  <Icon><path d="M8 2 14.5 13.5h-13L8 2Z" /><path d="M8 6.5v3.2M8 11.7v.05" /></Icon>
);
export const InfoIcon = () => (
  <Icon><circle cx="8" cy="8" r="6.25" /><path d="M8 7.3v3.6M8 5.1v.05" /></Icon>
);
export const CardsIcon = () => (
  <Icon size={28}>
    <rect x="1.5" y="5" width="11" height="7.5" rx="1" />
    <path d="M4.5 5V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-1" />
    <path d="M3.5 8h4M3.5 10h2.5" strokeWidth="1" />
  </Icon>
);

const STATUS_LABELS: Record<Card['status'], string> = {
  pending: 'Reading',
  verified: 'Verified',
  needs_review: 'Needs checking',
  confirmed: 'Confirmed by you',
  rejected: 'Removed',
  failed: 'Failed',
};

export function StatusLabel({ status }: { status: Card['status'] }) {
  return (
    <span className={`status ${status}`}>
      {(status === 'verified' || status === 'confirmed') && <CheckIcon />}
      {status === 'needs_review' && <AlertIcon />}
      {STATUS_LABELS[status]}
    </span>
  );
}

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

export function formatMinutes(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return 'under a minute';
  return plural(Math.round(seconds / 60), 'minute');
}

export const formatMoney = (usd: number) => `$${usd.toFixed(usd < 1 ? 3 : 2)}`;

/** A pause with no reason means the engine stopped because its totals didn't add up. */
export function pauseMessage(reason: PauseReason | null): { title: string; action: string } {
  if (reason === null) {
    return {
      title: 'The scan stopped because its totals didn’t add up.',
      action: 'It stopped rather than risk losing a card silently. Press Resume to try again. If it stops again, check the Photos tab.',
    };
  }
  return PAUSE_MESSAGES[reason];
}

const PAUSE_MESSAGES: Record<PauseReason, { title: string; action: string }> = {
  out_of_credit: {
    title: 'Your OpenAI account is out of credit.',
    action: 'Add credit in your OpenAI account, then press Resume. Finished cards are saved and won’t be charged again.',
  },
  bad_api_key: {
    title: 'OpenAI rejected the API key.',
    action: 'Correct OPENAI_API_KEY in .env.local, restart the app, then press Resume.',
  },
  cost_cap: {
    title: 'This scan reached its spending cap.',
    action: 'Finished cards are saved and won’t be charged again. Raise the cap to carry on.',
  },
  network: {
    title: 'The app can’t reach OpenAI.',
    action: 'Check your internet connection, then press Resume.',
  },
  user: { title: 'Scan paused.', action: 'Press Resume to carry on where it stopped.' },
};
