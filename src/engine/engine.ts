/** Job lifecycle: start, pause, resume, cancel, recover, progress. */
import type { CreateJobEngine, JobEngine, JobPauseError, JobProgress, Reconciliation } from '../shared/contracts.ts';
import { IMAGE_SLOTS, NETWORK_SLOTS, runPipeline, type PipelineDeps, type Run } from './pipeline.ts';
import { estimate } from './progress.ts';
import { Gate, WorkQueue } from './queue.ts';

/** Fast enough to feel live, slow enough that counting never competes with the work. */
const PROGRESS_INTERVAL_MS = 500;

export type JobEngineDeps = Parameters<CreateJobEngine>[0] & {
  /** The client's ramp-up level. Without it, progress shows calls the engine has running. */
  getLlmConcurrency?: () => number;
};

interface Emission {
  lastAt: number;
  timer: NodeJS.Timeout | null;
}

function isFinished(reconciliation: Reconciliation): boolean {
  return reconciliation.balanced && reconciliation.filesInProgress === 0 && reconciliation.cardsInProgress === 0;
}

export function createJobEngine(deps: JobEngineDeps): JobEngine {
  const { store, getLlmConcurrency } = deps;
  const imageGate = new Gate(IMAGE_SLOTS);
  const networkGate = new Gate(NETWORK_SLOTS);
  const runs = new Map<string, Run>();
  const listeners = new Set<(progress: JobProgress) => void>();
  const emissions = new Map<string, Emission>();
  let closed = false;

  function getProgress(jobId: string): JobProgress {
    const job = store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} does not exist.`);
    const reconciliation = store.getReconciliation(jobId);
    const run = runs.get(jobId);
    const speed =
      run && job.status === 'running'
        ? estimate(run.startedAt, run.finishedAt, reconciliation, Date.now())
        : { cardsPerMinute: 0, etaSeconds: null };
    return {
      jobId,
      status: job.status,
      pauseReason: job.pauseReason,
      reconciliation,
      spendUsd: store.getJobSpendUsd(jobId),
      costCapUsd: job.options.costCapUsd,
      ...speed,
      concurrency: getLlmConcurrency?.() ?? networkGate.active,
    };
  }

  function emit(jobId: string, emission: Emission): void {
    emission.lastAt = Date.now();
    try {
      const progress = getProgress(jobId);
      for (const listener of listeners) listener(progress);
    } catch (error) {
      console.error('Could not publish progress:', error);
    }
  }

  /** Limits progress to one update per interval. Status changes go out at once. */
  function notify(jobId: string, immediately = false): void {
    if (listeners.size === 0) return;
    const emission = emissions.get(jobId) ?? { lastAt: 0, timer: null };
    emissions.set(jobId, emission);
    const waitMs = emission.lastAt + PROGRESS_INTERVAL_MS - Date.now();
    if (immediately || waitMs <= 0) {
      if (emission.timer) clearTimeout(emission.timer);
      emission.timer = null;
      emit(jobId, emission);
    } else if (!emission.timer) {
      emission.timer = setTimeout(() => {
        emission.timer = null;
        emit(jobId, emission);
      }, waitMs);
      emission.timer.unref();
    }
  }

  function stopRun(run: Run): void {
    run.stopRequested = true;
    run.queue.stop();
  }

  function pauseRun(run: Run, error: JobPauseError): void {
    if (run.stopRequested) return;
    stopRun(run);
    store.setJobStatus(run.jobId, 'paused', error.reason);
    notify(run.jobId, true);
  }

  /** A job that can't honestly finish stops visibly: paused, with no reason. */
  function surfaceProblem(jobId: string, message: string, detail: unknown): void {
    console.error(`Job ${jobId}: ${message}`, detail);
    try {
      store.setJobStatus(jobId, 'paused', null);
    } catch (error) {
      console.error(`Job ${jobId}: could not record that problem.`, error);
    }
  }

  function finishJob(jobId: string): void {
    const reconciliation = store.getReconciliation(jobId);
    if (!isFinished(reconciliation)) {
      surfaceProblem(jobId, 'the work stopped, but the counts do not reconcile.', reconciliation);
      return;
    }
    store.markPossibleDuplicates(jobId);
    store.setJobStatus(jobId, 'done', null);
  }

  const pipeline: PipelineDeps = {
    store,
    vision: deps.vision,
    extraction: deps.extraction,
    decision: deps.decision,
    jobsDir: deps.jobsDir,
    imageGate,
    networkGate,
    onPause: pauseRun,
    onProgress: notify,
  };

  async function execute(run: Run): Promise<void> {
    let pendingBefore = Number.POSITIVE_INFINITY;
    for (;;) {
      await runPipeline(pipeline, run);
      if (run.stopRequested) return;
      // A person can add a card while the job runs, after its file has gone by.
      // Another pass only helps while it finishes cards; if not, finishJob reports it.
      const pending = store.getReconciliation(run.jobId).cardsInProgress;
      if (pending === 0 || pending >= pendingBefore) break;
      pendingBefore = pending;
      run.queue = new WorkQueue();
    }
    finishJob(run.jobId);
  }

  function launch(jobId: string): void {
    const previous = runs.get(jobId);
    if (closed || (previous && !previous.stopRequested)) return;

    const run: Run = {
      jobId,
      // Shared with a run still draining, so cancel reaches both.
      controller: previous?.controller ?? new AbortController(),
      stopRequested: false,
      queue: new WorkQueue(),
      startedAt: Date.now(),
      finishedAt: [],
      done: Promise.resolve(),
    };
    runs.set(jobId, run);
    // A pause lets in-flight reads finish, so a quick resume waits for them.
    run.done = (async () => {
      try {
        await previous?.done;
        if (!run.stopRequested) await execute(run);
      } catch (error) {
        surfaceProblem(jobId, 'the run stopped on an unexpected error.', error);
      } finally {
        if (runs.get(jobId) === run) runs.delete(jobId);
        notify(jobId, true);
      }
    })();
    notify(jobId, true);
  }

  function setRunning(jobId: string): void {
    if (closed) return;
    store.setJobStatus(jobId, 'running', null);
    launch(jobId);
  }

  function requireJob(jobId: string) {
    const job = store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} does not exist.`);
    return job;
  }

  return {
    start(jobId) {
      const { status } = requireJob(jobId);
      if (status === 'cancelled') return;
      // A finished job only runs again for a card a person added afterwards.
      if (status === 'done' && store.getReconciliation(jobId).cardsInProgress === 0) return;
      setRunning(jobId);
    },

    pause(jobId) {
      const { status } = requireJob(jobId);
      if (status !== 'running' && status !== 'queued') return;
      const run = runs.get(jobId);
      if (run) stopRun(run);
      store.setJobStatus(jobId, 'paused', 'user');
      notify(jobId, true);
    },

    resume(jobId) {
      if (requireJob(jobId).status === 'paused') setRunning(jobId);
    },

    cancel(jobId) {
      const { status } = requireJob(jobId);
      if (status === 'done' || status === 'cancelled') return;
      const run = runs.get(jobId);
      if (run) {
        stopRun(run);
        run.controller.abort();
      }
      store.setJobStatus(jobId, 'cancelled', null);
      notify(jobId, true);
    },

    getProgress,

    recover() {
      for (const job of store.listJobs()) {
        if (job.status === 'running' || job.status === 'queued') setRunning(job.id);
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async shutdown() {
      closed = true;
      const stopping = [...runs.values()];
      for (const run of stopping) {
        stopRun(run);
        run.controller.abort();
      }
      await Promise.all(stopping.map((run) => run.done));
      for (const emission of emissions.values()) {
        if (emission.timer) clearTimeout(emission.timer);
      }
      listeners.clear();
    },
  };
}

createJobEngine satisfies CreateJobEngine;
