/** One scan: what the app is doing, what needs the user, and the way out to a spreadsheet. */
import { useCallback, useEffect, useState } from 'react';

import { api } from './api.ts';
import type { CardSummary } from './api.ts';
import { CardsTable } from './CardsTable.tsx';
import { CopyBar } from './CopyBar.tsx';
import { PhotosPanel, photoNeedsCheck } from './PhotosPanel.tsx';
import { ReviewPanel } from './ReviewPanel.tsx';
import { AlertIcon, CheckIcon, formatMinutes, formatMoney, pauseMessage, plural } from './ui.tsx';
import type { JobProgress, SourceFile } from '../shared/contracts.ts';

const POLL_MS = 1_500;

type Tab = 'check' | 'all' | 'photos';

function describe(progress: JobProgress): string {
  const r = progress.reconciliation;
  const finished = r.cards - r.cardsInProgress;
  if (progress.status === 'paused') return pauseMessage(progress.pauseReason).title;
  if (progress.status === 'cancelled') return 'This scan was stopped. Finished cards are kept.';
  if (progress.status === 'done') {
    return r.needsReview > 0
      ? `Finished. ${plural(r.needsReview, 'card needs', 'cards need')} your check before copying.`
      : 'Finished. Every card is ready to copy.';
  }
  // Until every image has been searched, the card total is still growing, so don't present it as final.
  if (r.filesInProgress > 0) {
    const searched = r.files - r.filesInProgress;
    return `Finding cards: ${searched.toLocaleString()} of ${plural(r.files, 'image')} searched, ${plural(r.cards, 'card')} found so far.`;
  }
  const eta = formatMinutes(progress.etaSeconds);
  return `Reading cards: ${finished.toLocaleString()} of ${r.cards.toLocaleString()} done${eta ? `, about ${eta} left` : ''}.`;
}

export function JobPage({ jobId }: { jobId: string }) {
  const [name, setName] = useState('');
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [tab, setTab] = useState<Tab>('check');
  const [singleCardId, setSingleCardId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newCap, setNewCap] = useState('');

  const refresh = useCallback(async () => {
    const [nextProgress, nextCards, nextFiles] = await Promise.all([api.progress(jobId), api.listCards(jobId), api.listFiles(jobId)]);
    setProgress(nextProgress);
    setCards(nextCards);
    setFiles(nextFiles);
    setError(null);
    return nextProgress;
  }, [jobId]);

  useEffect(() => {
    api.getJob(jobId).then((job) => setName(job.name)).catch(() => undefined);
  }, [jobId]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let delay = POLL_MS;
      try {
        const latest = await refresh();
        if (latest.status === 'done' || latest.status === 'cancelled') delay = 6_000;
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : 'Lost contact with the local server.');
      }
      if (!stopped) timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  const control = async (action: (id: string) => Promise<JobProgress>) => {
    try {
      setProgress(await action(jobId));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work.');
    }
  };

  if (!progress) {
    return (
      <main className="page">
        {error ? <div className="notice danger"><AlertIcon /><div>{error}</div></div> : <p className="hint">Opening this scan…</p>}
      </main>
    );
  }

  const r = progress.reconciliation;
  const running = progress.status === 'running' || progress.status === 'queued';
  const finished = r.cards - r.cardsInProgress;
  const photosToCheck = files.filter(photoNeedsCheck).length;
  const pause = progress.status === 'paused' ? pauseMessage(progress.pauseReason) : null;
  const toReview = cards.filter((card) => card.status === 'needs_review');

  return (
    <main className="page has-bar">
      <div className="job-head">
        <div>
          <h1>{name || 'Scan'}</h1>
          <p className="job-sentence">{describe(progress)}</p>
        </div>
        <div className="job-actions">
          {running && <button className="button" type="button" onClick={() => void control(api.pause)}>Pause</button>}
          {progress.status === 'paused' && progress.pauseReason !== 'cost_cap' && (
            <button className="button primary" type="button" onClick={() => void control(api.resume)}>Resume</button>
          )}
        </div>
      </div>

      {running && r.cards > 0 && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={r.cards} aria-valuenow={finished}>
          <div style={{ width: `${(finished / r.cards) * 100}%` }} />
        </div>
      )}

      <p className="job-meta">
        {plural(r.files, 'file')}, {plural(r.cards, 'card')}: {r.verified.toLocaleString()} verified, {r.confirmed.toLocaleString()} confirmed by you, {r.needsReview.toLocaleString()} to check
        {r.duplicateFiles > 0 && `, ${plural(r.duplicateFiles, 'duplicate file')}`}
        {r.noCardFiles > 0 && `, ${plural(r.noCardFiles, 'image')} with no card`}
        {r.failedCards + r.failedFiles > 0 && `, ${(r.failedCards + r.failedFiles).toLocaleString()} failed`}
        . Spent {formatMoney(progress.spendUsd)} of {formatMoney(progress.costCapUsd)}.
      </p>

      <div className="notice-stack">
        {pause && (
          <div className="notice attention">
            <AlertIcon />
            <div>
              <strong>{pause.title}</strong> {pause.action}
              {progress.pauseReason === 'cost_cap' && (
                <form
                  className="cap-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void control(async (id) => {
                      await api.setCostCap(id, Number(newCap));
                      return api.resume(id);
                    });
                  }}
                >
                  <label htmlFor="new-cap">New cap in US dollars</label>
                  <input
                    id="new-cap"
                    type="text"
                    inputMode="decimal"
                    value={newCap}
                    placeholder={(progress.costCapUsd * 2).toFixed(2)}
                    onChange={(event) => setNewCap(event.target.value)}
                  />
                  <button className="button primary" type="submit" disabled={!(Number(newCap) > progress.spendUsd)}>
                    Raise cap and resume
                  </button>
                </form>
              )}
            </div>
          </div>
        )}
        {error && <div className="notice danger"><AlertIcon /><div>{error}</div></div>}
        {progress.status === 'done' && !r.balanced && (
          <div className="notice danger">
            <AlertIcon />
            <div><strong>The totals for this scan don’t add up.</strong> Some files or cards may not be accounted for. Check the Photos tab before relying on this scan.</div>
          </div>
        )}
        {photosToCheck > 0 && !running && (
          <div className="notice attention">
            <AlertIcon />
            <div>
              <strong>{plural(photosToCheck, 'photo needs', 'photos need')} a quick look before copying.</strong> Confirm every card in it has a number, so none is missed.{' '}
              <button className="button quiet" type="button" onClick={() => setTab('photos')}>Open Photos</button>
            </div>
          </div>
        )}
        {progress.status === 'done' && r.needsReview === 0 && photosToCheck === 0 && r.balanced && (
          <div className="notice ok">
            <CheckIcon />
            <div><strong>All done.</strong> Use the Copy button below, then paste into your spreadsheet.</div>
          </div>
        )}
      </div>

      <div className="tabs" role="tablist">
        <button className="tab" type="button" role="tab" aria-selected={tab === 'check'} onClick={() => { setSingleCardId(null); setTab('check'); }}>
          Check cards<span className={`count ${r.needsReview > 0 ? 'attention' : ''}`}>{r.needsReview.toLocaleString()}</span>
        </button>
        <button className="tab" type="button" role="tab" aria-selected={tab === 'all'} onClick={() => { setSingleCardId(null); setTab('all'); }}>
          All cards<span className="count">{r.cards.toLocaleString()}</span>
        </button>
        <button className="tab" type="button" role="tab" aria-selected={tab === 'photos'} onClick={() => setTab('photos')}>
          Photos<span className={`count ${photosToCheck > 0 ? 'attention' : ''}`}>{photosToCheck > 0 ? photosToCheck.toLocaleString() : r.files.toLocaleString()}</span>
        </button>
      </div>

      <div className="tab-body">
        {tab === 'check' && (
          <ReviewPanel
            key={singleCardId ?? 'queue'}
            cards={singleCardId ? cards.filter((card) => card.id === singleCardId) : toReview}
            stillRunning={running}
            onChanged={() => void refresh()}
            onClose={singleCardId ? () => { setSingleCardId(null); setTab('all'); } : undefined}
          />
        )}
        {tab === 'all' && (
          <CardsTable
            cards={cards}
            onOpen={(id) => {
              setSingleCardId(id);
              setTab('check');
            }}
          />
        )}
        {tab === 'photos' && <PhotosPanel jobId={jobId} files={files} cards={cards} onChanged={() => void refresh()} />}
      </div>

      <CopyBar jobId={jobId} copyable={r.verified + r.confirmed} remaining={r.needsReview + r.cardsInProgress} running={running} photosToCheck={photosToCheck} />
    </main>
  );
}
