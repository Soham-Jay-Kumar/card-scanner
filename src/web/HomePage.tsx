/** Start a scan: choose images, set the two options that matter, go. */
import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';

import { api } from './api.ts';
import type { AppStatus } from './api.ts';
import { expandFiles, filesFromDrop, uploadAll } from './upload.ts';
import type { ExpandResult } from './upload.ts';
import { AlertIcon, CardsIcon, InfoIcon, plural } from './ui.tsx';
import type { Job, Reconciliation } from '../shared/contracts.ts';

const COUNTRIES: Array<[string, string]> = [
  ['', 'Not sure'],
  ['IN', 'India'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['AU', 'Australia'],
  ['CA', 'Canada'],
  ['SG', 'Singapore'],
  ['AE', 'United Arab Emirates'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['JP', 'Japan'],
];

type Stage = { name: 'idle' } | { name: 'preparing' } | { name: 'uploading'; done: number; total: number };

export function HomePage({ status }: { status: AppStatus | null }) {
  const [chosen, setChosen] = useState<ExpandResult | null>(null);
  const [stage, setStage] = useState<Stage>({ name: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [frontBackPairs, setFrontBackPairs] = useState(false);
  const [country, setCountry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Array<Job & { reconciliation: Reconciliation }>>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.listJobs().then(setJobs).catch(() => setJobs([]));
  }, []);

  const receive = async (files: File[]) => {
    setError(null);
    setStage({ name: 'preparing' });
    try {
      setChosen(await expandFiles(files));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Those files could not be read.');
    }
    setStage({ name: 'idle' });
  };

  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    await receive(await filesFromDrop(event.dataTransfer.items));
  };

  const start = async () => {
    if (!chosen || chosen.items.length === 0) return;
    setError(null);
    setStage({ name: 'uploading', done: 0, total: chosen.items.length });
    try {
      const name = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      const job = await api.createJob({ name: `Scan ${name}`, frontBackPairs, defaultCountry: country || null });
      const failed = await uploadAll(job.id, chosen.items, (done, total) => setStage({ name: 'uploading', done, total }));
      if (failed.length === chosen.items.length) throw new Error(failed[0]?.reason ?? 'No files could be uploaded.');
      await api.start(job.id);
      window.location.hash = `#/scan/${job.id}`;
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'The scan could not start.');
      setStage({ name: 'idle' });
    }
  };

  const busy = stage.name !== 'idle';
  const limit = status?.maxCardsPerJob ?? 1000;
  const tooMany = (chosen?.items.length ?? 0) > limit;
  const canStart = Boolean(chosen?.items.length) && !busy && !tooMany && status?.hasApiKey === true;

  return (
    <main className="page">
      <h1>Scan business cards</h1>
      <p className="hint" style={{ marginTop: 3, marginBottom: 16 }}>
        Add your images. The app reads every card three times, checks the results, and asks you about anything it isn’t sure of.
      </p>

      {status && !status.hasApiKey && (
        <div className="notice attention" style={{ marginBottom: 14 }}>
          <AlertIcon />
          <div>
            <strong>Add your OpenAI API key to start scanning.</strong> Copy <code>.env.example</code> to <code>.env.local</code>, add the key after <code>OPENAI_API_KEY=</code>, then restart the app.
          </div>
        </div>
      )}

      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => void onDrop(event)}
      >
        <CardsIcon />
        <h2>{stage.name === 'preparing' ? 'Opening your files…' : 'Drop images, a PDF, a ZIP or a folder here'}</h2>
        <p className="hint">One image can hold one card or a whole table of them. JPG, PNG, WEBP, iPhone HEIC and DNG all work.</p>
        <div className="dropzone-actions">
          <button className="button" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>Choose files</button>
          <button className="button" type="button" disabled={busy} onClick={() => folderInput.current?.click()}>Choose a folder</button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept="image/*,.heic,.heif,.dng,.pdf,.zip"
          onChange={(event) => void receive(Array.from(event.target.files ?? []))}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          {...({ webkitdirectory: '' } as object)}
          onChange={(event) => void receive(Array.from(event.target.files ?? []))}
        />
      </div>

      <div className="options">
        <div>
          <label className="field-label" htmlFor="country">Most cards are from</label>
          <select id="country" value={country} onChange={(event) => setCountry(event.target.value)}>
            {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
          <p className="hint" style={{ marginTop: 4 }}>Used to check phone numbers printed without a country code.</p>
        </div>
        <div>
          <span className="field-label">Two-sided cards</span>
          <label className="check">
            <input type="checkbox" checked={frontBackPairs} onChange={(event) => setFrontBackPairs(event.target.checked)} />
            Images are front and back pairs
          </label>
          <p className="hint" style={{ marginTop: 4 }}>Turn on if every two images in name order show one card.</p>
        </div>
        <div>
          <span className="field-label">For a photo of many cards</span>
          <p className="hint">Lay cards flat without overlaps and use your camera’s highest resolution. Small text is the first thing to become unreadable.</p>
        </div>
      </div>

      {chosen && (
        <section className="chosen">
          <div className="chosen-row">
            <strong>{plural(chosen.items.length, 'image')} ready</strong>
            {chosen.skipped.length > 0 && <span className="hint">{plural(chosen.skipped.length, 'file')} skipped</span>}
            <span className="spacer" />
            <button className="button quiet" type="button" disabled={busy} onClick={() => setChosen(null)}>Clear</button>
            <button className="button primary large" type="button" disabled={!canStart} onClick={() => void start()}>
              {stage.name === 'uploading' ? `Uploading ${stage.done} of ${stage.total}…` : `Start scan`}
            </button>
          </div>
          {stage.name === 'uploading' && (
            <div className="progress" style={{ marginTop: 10 }}>
              <div style={{ width: `${(stage.done / stage.total) * 100}%` }} />
            </div>
          )}
          {chosen.skipped.length > 0 && (
            <div className="notice" style={{ marginTop: 10 }}>
              <InfoIcon />
              <div>
                {chosen.skipped.slice(0, 5).map((item) => <div key={item.name}>{item.name}: {item.reason}</div>)}
                {chosen.skipped.length > 5 && <div>and {chosen.skipped.length - 5} more</div>}
              </div>
            </div>
          )}
          {tooMany && (
            <div className="notice attention" style={{ marginTop: 10 }}>
              <AlertIcon />
              <div>A scan can hold up to {limit.toLocaleString()} images. Remove {(chosen.items.length - limit).toLocaleString()} or split them across two scans.</div>
            </div>
          )}
        </section>
      )}

      {error && (
        <div className="notice danger" style={{ marginTop: 14 }}>
          <AlertIcon />
          <div>{error}</div>
        </div>
      )}

      {jobs.length > 0 && (
        <section className="home-section">
          <h2>Earlier scans</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Scan</th><th>Cards</th><th>Still to check</th></tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="clickable" onClick={() => { window.location.hash = `#/scan/${job.id}`; }}>
                    <td><a href={`#/scan/${job.id}`}>{job.name}</a></td>
                    <td>{job.reconciliation.cards.toLocaleString()}</td>
                    <td>{job.reconciliation.needsReview.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
