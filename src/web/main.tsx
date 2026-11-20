import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api } from './api.ts';
import type { AppStatus } from './api.ts';
import { HomePage } from './HomePage.tsx';
import { JobPage } from './JobPage.tsx';
import './styles.css';

const jobIdFromHash = () => /^#\/scan\/(.+)$/.exec(window.location.hash)?.[1] ?? null;

function App() {
  const [jobId, setJobId] = useState(jobIdFromHash);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);

  useEffect(() => {
    const onHashChange = () => setJobId(jobIdFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    api.status().then(setStatus).catch((error: Error) => setStartupError(error.message));
  }, []);

  return (
    <>
      <header className="topbar">
        <a className="topbar-name" href="#/">Card Scanner</a>
        <span className="spacer" />
        {jobId && <a className="button" href="#/">New scan</a>}
      </header>
      {startupError ? (
        <main className="page">
          <div className="notice danger">
            <div><strong>The app can’t reach its local server.</strong> Check that <code>npm start</code> is still running in Terminal, then reload this page.</div>
          </div>
        </main>
      ) : jobId ? (
        <JobPage key={jobId} jobId={jobId} />
      ) : (
        <HomePage status={status} />
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
