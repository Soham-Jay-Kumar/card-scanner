# Regression tests

One file per defect found. Each test states the correct behaviour, so it fails while
the defect exists and stays as a guard once it is fixed. Do not edit a test to make
it pass: fix `src/`.

| File | Defect | State |
|---|---|---|
| `ledger.test.ts` | Latency arrived as a fraction, the ledger column only takes whole numbers, so every call failed to record. Spend read $0 and the cost cap could never fire. | Fixed, guarded |
| `add-missed-card.test.ts` | A card added on the Photos screen after a job was done was never read. | Fixed, guarded |
