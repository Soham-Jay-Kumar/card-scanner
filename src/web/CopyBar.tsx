/**
 * The finish line: copy to the clipboard, paste into the spreadsheet, then
 * paste back here to prove every cell arrived unchanged.
 */
import { useState } from 'react';

import { api } from './api.ts';
import { AlertIcon, CheckIcon, plural } from './ui.tsx';
import { COLUMN_HEADERS } from '../shared/contracts.ts';
import type { ClipboardPayload, VerifyPasteReport } from '../shared/contracts.ts';

const DIFFERENCE_LABELS: Record<string, string> = {
  formula_error: 'The spreadsheet showed an error',
  lost_plus: 'The + sign was lost',
  lost_leading_zero: 'A leading zero was lost',
  scientific_notation: 'Turned into scientific notation',
  date: 'Turned into a date',
  changed: 'The value changed',
  missing_row: 'This row is missing from the paste',
  extra_row: 'The paste has a row that shouldn’t be there',
  extra_column: 'The paste has a column that shouldn’t be there',
};

/** Used only if the direct Mac clipboard write fails. */
function browserCopy(payload: ClipboardPayload): boolean {
  const listener = (event: ClipboardEvent) => {
    event.clipboardData?.setData('text/html', payload.html);
    event.clipboardData?.setData('text/plain', payload.plain);
    event.preventDefault();
  };
  document.addEventListener('copy', listener);
  const copied = document.execCommand('copy');
  document.removeEventListener('copy', listener);
  return copied;
}

export function CopyBar({
  jobId,
  copyable,
  remaining,
  running,
  photosToCheck,
}: {
  jobId: string;
  copyable: number;
  remaining: number;
  /** Copying waits for the scan to finish, because the last checks compare cards with each other. */
  running: boolean;
  /** Images whose card count a person hasn't confirmed yet. Copying waits for them. */
  photosToCheck: number;
}) {
  const [includeHeader, setIncludeHeader] = useState(true);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState<{ rows: number; viaBrowser: boolean } | null>(null);
  const [report, setReport] = useState<VerifyPasteReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blocked = running || photosToCheck > 0;
  const downloadsReady = copyable > 0 && !blocked;

  const copy = async () => {
    setCopying(true);
    setError(null);
    setReport(null);
    try {
      const result = await api.copy(jobId, includeHeader);
      if (result.verified) {
        setCopied({ rows: result.rowCount, viaBrowser: false });
      } else if (result.fallback && browserCopy(result.fallback)) {
        setCopied({ rows: result.rowCount, viaBrowser: true });
      } else {
        throw new Error(`Copying failed: ${result.detail}`);
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Copying failed.');
    }
    setCopying(false);
  };

  const verify = async (pastedText: string) => {
    setError(null);
    try {
      setReport(await api.verifyPaste(jobId, pastedText));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'The check could not run.');
    }
  };

  return (
    <div className="copybar">
      {copied && (
        <div className="verify" style={{ paddingTop: 12 }}>
          <h3 style={{ marginBottom: 6 }}>Copied {plural(copied.rows, 'row')}. Now paste, then check the paste.</h3>
          <ol>
            <li>In your spreadsheet, click the first cell and press ⌘V.</li>
            <li>Select all the cells you just pasted and press ⌘C.</li>
            <li>Click the box below and press ⌘V. The app compares every cell.</li>
          </ol>
          <textarea
            aria-label="Paste the copied cells here to check them"
            placeholder="Paste the cells from your spreadsheet here"
            onPaste={(event) => {
              event.preventDefault();
              void verify(event.clipboardData.getData('text/plain'));
            }}
          />
          {report?.ok && (
            <div className="notice ok" style={{ marginTop: 8 }}>
              <CheckIcon />
              <div><strong>Every cell matches.</strong> {report.cellsCompared.toLocaleString()} cells across {plural(report.rowsFound, 'row')} arrived unchanged.</div>
            </div>
          )}
          {report && !report.ok && (
            <>
              <div className="notice danger" style={{ marginTop: 8 }}>
                <AlertIcon />
                <div>
                  <strong>{plural(report.differences.length, 'cell differs', 'cells differ')} from the scan.</strong>{' '}
                  {report.rowsFound !== report.rowsExpected && `Expected ${plural(report.rowsExpected, 'row')}, found ${report.rowsFound.toLocaleString()}. `}
                  Download the .xlsx file instead: it keeps every value exact.
                </div>
              </div>
              {report.differences.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Row</th><th>Column</th><th>Should be</th><th>Spreadsheet has</th><th>What happened</th></tr>
                    </thead>
                    <tbody>
                      {report.differences.slice(0, 200).map((difference) => (
                        <tr key={`${difference.row}-${difference.field}`}>
                          <td>{difference.row}</td>
                          <td>{COLUMN_HEADERS[difference.field]}</td>
                          <td className="cell">{difference.expected}</td>
                          <td className="cell">{difference.actual}</td>
                          <td>{DIFFERENCE_LABELS[difference.kind] ?? DIFFERENCE_LABELS.changed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          <div className="verify-row">
            {copied.viaBrowser && <span className="hint">Copied through the browser, so this check matters more than usual.</span>}
            <span className="spacer" />
            <button className="button quiet" type="button" onClick={() => { setCopied(null); setReport(null); }}>Close</button>
          </div>
        </div>
      )}

      <div className="copybar-row">
        <button className="button primary large" type="button" disabled={copyable === 0 || copying || blocked} onClick={() => void copy()}>
          {copying
            ? 'Copying…'
            : running
              ? 'Copy when the scan finishes'
              : photosToCheck > 0
                ? `Check ${plural(photosToCheck, 'photo')} first`
                : copyable === 0
                  ? 'Nothing to copy yet'
                  : `Copy ${plural(copyable, 'card')}`}
        </button>
        {remaining > 0 && <span className="hint">{plural(remaining, 'card')} still to finish or check</span>}
        <label className="check">
          <input type="checkbox" checked={includeHeader} onChange={(event) => setIncludeHeader(event.target.checked)} />
          Include column headings
        </label>
        <span className="spacer" />
        {error && <span className="status failed">{error}</span>}
        {downloadsReady ? (
          <>
            <a className="button" href={`/api/jobs/${jobId}/export.xlsx`} download>Download .xlsx</a>
            <a
              className="button quiet"
              href={`/api/jobs/${jobId}/export.csv`}
              download
              title="For importing into other systems. Opening a .csv directly in Excel can change phone numbers, so use .xlsx for spreadsheets."
            >
              Download .csv
            </a>
          </>
        ) : (
          <>
            <button className="button" type="button" disabled>Download .xlsx</button>
            <button className="button quiet" type="button" disabled>Download .csv</button>
          </>
        )}
      </div>
    </div>
  );
}
