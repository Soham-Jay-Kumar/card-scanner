/** The card image beside its six fields. The user is the final check on anything uncertain. */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { api } from './api.ts';
import type { CardSummary } from './api.ts';
import { AlertIcon, CheckIcon, plural } from './ui.tsx';
import { COLUMN_HEADERS, FIELD_KEYS } from '../shared/contracts.ts';
import type { Card, CardRow, FieldKey, ReadRecord } from '../shared/contracts.ts';

const EMPTY_ROW = Object.fromEntries(FIELD_KEYS.map((key) => [key, ''])) as CardRow;

function CardImage({ src, alt }: { src: string; alt: string }) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <div className={`card-image ${zoomed ? 'zoomed' : ''}`} onClick={() => setZoomed(!zoomed)}>
      <img src={src} alt={alt} />
    </div>
  );
}

export function ReviewPanel({
  cards,
  stillRunning,
  onChanged,
  onClose,
}: {
  cards: CardSummary[];
  stillRunning: boolean;
  onChanged: () => void;
  onClose?: (() => void) | undefined;
}) {
  const [index, setIndex] = useState(0);
  const [detail, setDetail] = useState<{ card: Card; reads: ReadRecord[] } | null>(null);
  const [row, setRow] = useState<CardRow>(EMPTY_ROW);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const position = Math.min(index, Math.max(cards.length - 1, 0));
  const summary = cards[position];
  const cardId = summary?.id;

  useEffect(() => {
    if (!cardId) {
      setDetail(null);
      return;
    }
    let current = true;
    setError(null);
    api
      .getCard(cardId)
      .then((next) => {
        if (!current) return;
        setDetail(next);
        setRow(next.card.finalRow ?? next.card.decision?.row ?? EMPTY_ROW);
      })
      .catch((problem: Error) => setError(problem.message));
    return () => {
      current = false;
    };
  }, [cardId]);

  if (!summary) {
    return (
      <div className="empty">
        <h2>{stillRunning ? 'Nothing to check yet' : 'Nothing left to check'}</h2>
        <p>
          {stillRunning
            ? 'Any card the app isn’t sure of will appear here, beside its image, for you to confirm.'
            : 'Every card is verified or confirmed. Use the Copy button below.'}
        </p>
      </div>
    );
  }

  const decision = detail?.card.decision ?? null;
  const flagged = new Set<FieldKey>(decision?.flaggedFields ?? []);
  const failedChecks = (decision?.checks ?? []).filter((check) => !check.passed);
  const cardIssues = failedChecks.filter((check) => check.field === null);
  const transcript = detail?.reads.find((read) => read.outcome.ok);

  const finish = async (action: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await action();
      onChanged();
      if (onClose) onClose();
      else if (position >= cards.length - 1) setIndex(0);
      // The confirmed card leaves the queue, so the same index now shows the next card.
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That could not be saved.');
    }
    setSaving(false);
  };

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void finish(() => api.confirmCard(summary.id, row));
  };

  return (
    <div className="review">
      <div className="review-image">
        <p className="review-position">
          {onClose ? `From ${summary.sourceName}` : `Card ${position + 1} of ${plural(cards.length, 'to check', 'to check')}, from ${summary.sourceName}`}
        </p>
        {detail?.card.crops.map((crop, cropIndex) => (
          <CardImage key={crop.path} src={`/api/cards/${summary.id}/images/${cropIndex}`} alt={`Business card, ${crop.side === 'back' ? 'back' : 'front'}`} />
        ))}
        <p className="hint" style={{ marginTop: 6 }}>Click the image to zoom in.</p>
      </div>

      <form onSubmit={confirm}>
        {cardIssues.length > 0 && (
          <div className="notice attention" style={{ marginBottom: 12 }}>
            <AlertIcon />
            <div>{cardIssues.map((check) => <div key={check.check}>{check.detail}</div>)}</div>
          </div>
        )}
        {summary.status === 'failed' && (
          <div className="notice danger" style={{ marginBottom: 12 }}>
            <AlertIcon />
            <div>The app couldn’t read this card{summary.error ? `: ${summary.error}` : '.'} Type the details from the image.</div>
          </div>
        )}

        {FIELD_KEYS.map((field) => {
          const reasons = failedChecks.filter((check) => check.field === field);
          const candidates = decision?.consensus[field].candidates ?? [];
          const isFlagged = flagged.has(field);
          return (
            <div key={field} className={`review-field ${isFlagged ? 'flagged' : ''}`}>
              <label className="field-label" htmlFor={`field-${field}`}>{COLUMN_HEADERS[field]}</label>
              <input
                id={`field-${field}`}
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={row[field]}
                onChange={(event) => setRow({ ...row, [field]: event.target.value })}
              />
              {isFlagged && candidates.length > 1 && (
                <div className="candidates">
                  {candidates.map((candidate) => (
                    <button
                      key={candidate.value}
                      className="candidate"
                      type="button"
                      aria-pressed={row[field] === candidate.value}
                      onClick={() => setRow({ ...row, [field]: candidate.value })}
                    >
                      {candidate.value || 'Blank'} <span>{candidate.reads.length} of 3 reads</span>
                    </button>
                  ))}
                </div>
              )}
              {reasons.map((check) => <p key={check.check} className="review-reason">{check.detail}</p>)}
            </div>
          );
        })}

        {error && <div className="notice danger"><AlertIcon /><div>{error}</div></div>}

        <div className="review-actions">
          <button className="button primary large" type="submit" disabled={saving || !detail}>
            <CheckIcon />
            {onClose ? 'Confirm' : 'Confirm and next'}
          </button>
          {onClose ? (
            <button className="button" type="button" onClick={onClose}>Back to all cards</button>
          ) : (
            <button className="button" type="button" disabled={cards.length < 2} onClick={() => setIndex((position + 1) % cards.length)}>Skip for now</button>
          )}
          <span className="spacer" />
          <button className="button quiet" type="button" disabled={saving} onClick={() => void finish(() => api.rejectCard(summary.id, 'Removed by the user'))}>
            Not a card
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>Compare each field with the image. Press Return to confirm.</p>

        {transcript?.outcome.ok && (
          <details className="review-transcript">
            <summary>All the text the app read on this card</summary>
            <pre>{transcript.outcome.data.transcript.join('\n')}</pre>
          </details>
        )}
      </form>
    </div>
  );
}
