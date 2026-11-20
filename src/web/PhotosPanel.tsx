/**
 * The safety net for images holding many cards. Each uploaded image is shown
 * with a numbered box on every card found, so a missed card stands out, and
 * the user can draw a box around it to add it.
 */
import { useRef, useState } from 'react';
import type { PointerEvent } from 'react';

import { api } from './api.ts';
import type { CardSummary } from './api.ts';
import { AlertIcon, CheckIcon, plural } from './ui.tsx';
import type { Rotation, SourceFile } from '../shared/contracts.ts';

import { photoNeedsCheck } from '../shared/photoCheck.ts';

export { photoNeedsCheck };

function describeFile(file: SourceFile, cardCount: number): { text: string; tone: '' | 'attention' | 'danger' } {
  if (file.stage === 'failed') return { text: file.error ? `Couldn’t be read: ${file.error}` : 'Couldn’t be read', tone: 'danger' };
  if (file.stage === 'duplicate') return { text: 'Same as another file, skipped', tone: '' };
  if (file.locate?.checkedByPerson) return { text: `${plural(cardCount, 'card')}, checked by you`, tone: '' };
  if (file.stage === 'no_card') return { text: 'No card found. Please check', tone: 'attention' };
  if (file.locate?.fellBackToFullImage) return { text: 'Cards couldn’t be located. Please check', tone: 'attention' };
  if (file.locate && !file.locate.countConfirmed) return { text: `${plural(cardCount, 'card')} found. Please check the count`, tone: 'attention' };
  if (file.stage === 'cropped' && photoNeedsCheck(file)) return { text: `${plural(cardCount, 'card')} found. Please check the count`, tone: 'attention' };
  if (file.stage === 'cropped') return { text: `${plural(cardCount, 'card')} found`, tone: '' };
  return { text: 'Working…', tone: '' };
}

interface Draft {
  startX: number;
  startY: number;
  x: number;
  y: number;
}

function PhotoViewer({
  jobId,
  file,
  cardCount,
  onBack,
  onChanged,
}: {
  jobId: string;
  file: SourceFile;
  cardCount: number;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [drawing, setDrawing] = useState(false);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  const size = file.normalized;
  const locations = file.locate?.locations ?? [];

  const pointAt = (event: PointerEvent) => {
    const rect = stage.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  const submit = async () => {
    if (!draft || !size) return;
    const left = Math.min(draft.startX, draft.x);
    const top = Math.min(draft.startY, draft.y);
    const width = Math.abs(draft.x - draft.startX);
    const height = Math.abs(draft.y - draft.startY);
    setDraft(null);
    if (width < 0.01 || height < 0.01) return;
    setBusy(true);
    setError(null);
    try {
      await api.addCard(file.id, {
        box: {
          x: Math.round(left * size.width),
          y: Math.round(top * size.height),
          width: Math.round(width * size.width),
          height: Math.round(height * size.height),
        },
        rotation,
      });
      setDrawing(false);
      onChanged();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That card could not be added.');
    }
    setBusy(false);
  };

  const confirmCount = async () => {
    setBusy(true);
    try {
      await api.confirmCount(file.id);
      onChanged();
      onBack();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That could not be saved.');
    }
    setBusy(false);
  };

  return (
    <>
      <div className="photo-viewer-head">
        <button className="button" type="button" onClick={onBack}>All photos</button>
        <h2>{file.originalName}</h2>
        <span className="spacer" />
        {drawing ? (
          <>
            <label className="hint" htmlFor="turn">Text on this card is</label>
            <select id="turn" style={{ width: 150 }} value={rotation} onChange={(event) => setRotation(Number(event.target.value) as Rotation)}>
              <option value={0}>The right way up</option>
              <option value={90}>Lying on its left</option>
              <option value={180}>Upside down</option>
              <option value={270}>Lying on its right</option>
            </select>
            <button className="button" type="button" onClick={() => { setDrawing(false); setDraft(null); }}>Cancel</button>
          </>
        ) : (
          <>
            <button className="button" type="button" disabled={busy || !size} onClick={() => setDrawing(true)}>Add a missed card</button>
            {photoNeedsCheck(file) && (
              <button className="button primary" type="button" disabled={busy} onClick={() => void confirmCount()}>
                <CheckIcon />
                {file.stage === 'no_card' ? 'There’s no card here' : 'Every card is numbered'}
              </button>
            )}
          </>
        )}
      </div>

      <p className="hint" style={{ marginBottom: 10 }}>
        {drawing
          ? 'Drag a box around the whole card.'
          : `${plural(cardCount, 'card')} found. Check that every card in the photo has a number on it.`}
      </p>

      {file.locate?.note && !drawing && (
        <div className="notice attention" style={{ marginBottom: 10 }}>
          <AlertIcon />
          <div>{file.locate.note}</div>
        </div>
      )}
      {error && <div className="notice danger" style={{ marginBottom: 10 }}><AlertIcon /><div>{error}</div></div>}

      {size ? (
        <div
          ref={stage}
          className={`photo-stage ${drawing ? 'drawing' : ''}`}
          onPointerDown={(event) => {
            if (!drawing) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const point = pointAt(event);
            setDraft({ startX: point.x, startY: point.y, ...point });
          }}
          onPointerMove={(event) => {
            if (draft) setDraft({ ...draft, ...pointAt(event) });
          }}
          onPointerUp={() => void submit()}
        >
          <img src={`/api/files/${file.id}/image`} alt={`Uploaded image ${file.originalName}`} />
          {locations.map((location, index) => (
            <div
              key={`${location.box.x}-${location.box.y}`}
              className="photo-box"
              style={{
                left: `${(location.box.x / size.width) * 100}%`,
                top: `${(location.box.y / size.height) * 100}%`,
                width: `${(location.box.width / size.width) * 100}%`,
                height: `${(location.box.height / size.height) * 100}%`,
              }}
            >
              <span>{index + 1}</span>
            </div>
          ))}
          {draft && (
            <div
              className="photo-box new"
              style={{
                left: `${Math.min(draft.startX, draft.x) * 100}%`,
                top: `${Math.min(draft.startY, draft.y) * 100}%`,
                width: `${Math.abs(draft.x - draft.startX) * 100}%`,
                height: `${Math.abs(draft.y - draft.startY) * 100}%`,
              }}
            />
          )}
        </div>
      ) : (
        <p className="hint">This image can’t be shown because it couldn’t be read.</p>
      )}
    </>
  );
}

export function PhotosPanel({
  jobId,
  files,
  cards,
  onChanged,
}: {
  jobId: string;
  files: SourceFile[];
  cards: CardSummary[];
  onChanged: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  const countFor = (file: SourceFile) => cards.filter((card) => card.sourceFileIds.includes(file.id)).length;
  const open = files.find((file) => file.id === openId);

  if (open) {
    return <PhotoViewer jobId={jobId} file={open} cardCount={countFor(open)} onBack={() => setOpenId(null)} onChanged={onChanged} />;
  }

  const ordered = [...files].sort((a, b) => Number(photoNeedsCheck(b)) - Number(photoNeedsCheck(a)) || a.seq - b.seq);

  return (
    <>
      <p className="hint" style={{ marginBottom: 10 }}>
        Open any image to see which cards were found. If one was missed, you can add it.
      </p>
      <div className="photo-list">
        {ordered.map((file) => {
          const { text, tone } = describeFile(file, countFor(file));
          return (
            <button key={file.id} className="photo-row" type="button" onClick={() => setOpenId(file.id)}>
              <span className="name">{file.originalName}</span>
              <span className={`state ${tone}`}>{text}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
