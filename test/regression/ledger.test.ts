/**
 * Every call must reach the ledger, or spend reads $0 and the cost cap never fires.
 * The client reports a fractional latency, and the ledger's column must accept it.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { startFakeOpenAI } from '../fake-openai/server.ts';
import { installFakeDns, loadApp, startTestApp } from '../helpers/app.ts';
import { cardFile, testCard } from '../helpers/fixtures.ts';

const { createApp, skipReason } = await loadApp();

describe.skipIf(!createApp)(`cost ledger ${skipReason}`, () => {
  const dns = installFakeDns();
  afterAll(() => dns.restore());

  it('records spend equal to what the API billed', async () => {
    const fake = await startFakeOpenAI();
    const app = await startTestApp(createApp!, { baseURL: fake.url });
    const card = testCard(3440);
    fake.addCards([card.fake]);
    const { job } = await app.runJob([await cardFile(card)], undefined, 5 * 60_000);
    const billed = fake.stats().billed;
    const spend = app.app.store.getJobSpendUsd(job.id);
    await app.close();
    await fake.close();
    expect(billed.responses).toBeGreaterThanOrEqual(5);
    expect(spend).toBeCloseTo(billed.costUsd, 9);
  }, 5 * 60_000);
});
