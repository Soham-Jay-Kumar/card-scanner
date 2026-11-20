/**
 * Runs the real app in its own process, so a test can kill it with SIGKILL. Modes:
 *   --start          start the job
 *   --recover        boot as the app does after a crash: engine.recover()
 *   --kill-after-cards N   SIGKILL itself straight after the Nth card is saved
 * Exits 0 once the job stops.
 */
import { parseArgs } from 'node:util';

import { installFakeDns, tuneForTests } from '../../helpers/app.ts';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    'base-url': { type: 'string' },
    job: { type: 'string' },
    start: { type: 'boolean', default: false },
    recover: { type: 'boolean', default: false },
    'kill-after-cards': { type: 'string' },
    'request-timeout': { type: 'string', default: '30000' },
  },
});

installFakeDns();
tuneForTests(Number(values['request-timeout']));
// Imported after tuning, so the client reads the short retry settings.
const { createApp } = await import('../../../src/server/app.ts');

const jobId = values.job!;
const app = createApp({ dataDir: values.data!, apiKey: 'test-key', baseURL: values['base-url']! });

const killAfter = values['kill-after-cards'] ? Number(values['kill-after-cards']) : null;
if (killAfter !== null) {
  const { store } = app;
  const createCard = store.createCard.bind(store);
  let created = 0;
  store.createCard = (input) => {
    const card = createCard(input);
    created += 1;
    if (created === killAfter) process.kill(process.pid, 'SIGKILL');
    return card;
  };
}

if (values.recover) app.engine.recover();
if (values.start) app.engine.start(jobId);

const poll = setInterval(() => {
  const status = app.store.getJob(jobId)?.status;
  if (status === 'done' || status === 'paused' || status === 'cancelled') {
    clearInterval(poll);
    void app.shutdown().then(() => {
      console.log(`CHILD_DONE ${status}`);
      process.exit(0);
    });
  }
}, 100);
