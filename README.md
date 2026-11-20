# Card Scanner

Turns business card images into checked spreadsheet rows (Name, Position, Company, Email, Phone, Website) that paste cleanly into Excel or Google Sheets. It runs on this Mac only.

Each card is read three times by GPT-6 Luna, then automatic checks run on every value. Anything uncertain is shown to you beside the card image before it can be copied.

## Set up once

1. Install Node 26 or later.
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env.local` and add your OpenAI API key after `OPENAI_API_KEY=`.

## Use it

```
npm start
```

The app opens in your browser at http://127.0.0.1:4173.

1. **Add images.** Drop images, a PDF, a ZIP or a folder. One image can hold one card or a table of 30 or more.
2. **Wait for the scan to finish.** You can pause and resume at any time. Finished cards are saved and never charged twice.
3. **Check cards.** The Check cards tab shows each card that needs you, beside its image. Press Return to confirm each one.
4. **Check photos.** The Photos tab shows every card found in each image, numbered. If a card was missed, use **Add a missed card** and drag a box around it.
5. **Copy and verify.** Press **Copy**, paste into your spreadsheet, then copy the pasted cells back into the box in the app. It compares every cell and tells you if anything changed.

If a paste ever changes a value, use **Download .xlsx** instead. It stores every value as text, so phone numbers stay exact.

## Getting the most cards verified automatically

- A card needs about 700 pixels on its long edge to be read reliably. In a 12-megapixel photo of 30 cards, each card is smaller than that, so every card goes to you for checking. Use a 48-megapixel camera mode, a flatbed scan at 300 DPI or more, or fewer cards per photo.
- Lay cards flat, without overlaps. Overlapping cards always go to you for checking.
- Choose the country most cards come from, so phone numbers without a country code can be checked.

## What has and hasn't been proven

Proven with automated tests and the fake OpenAI server in `test/fake-openai/`:
- The pipeline logic: no card lost, counts always balance, crash and resume, pause for credit, key or spending cap, retries.
- The clipboard writes exactly what was encoded.

Not yet proven:
- **Real accuracy with GPT-6 Luna.** Needs an API key and at least 50 real cards. See `test/accuracy/README.md`.
- **Real paste into Excel and Google Sheets.** Needs sign-ins. Follow `test/paste-proof/CHECKLIST.md`. The Google Sheets text-cell code in `src/paste/encode.ts` is a placeholder until a real Sheets cell is captured, as step 1 of that checklist explains.

## Development

```
npm test              # unit, integration and end-to-end tests (fast set)
npm run typecheck
npm run dev:server    # API server with reload
npm run dev:web       # web app with reload, at http://127.0.0.1:5173
```

Slow suites run only when asked: `RUN_FULL_SYNTH=1` runs the full synthetic card set, `RUN_1000_CARDS=1` runs the 1,000-card job, and `PASTEBOARD_LIVE=1` runs the live clipboard tests, which save and restore your clipboard. The simulated throughput benchmark is `node src/engine/testing/benchmark.ts <scenario>`.

To run the whole app against the fake server instead of OpenAI, start `node test/fake-openai/server.ts --port 4010 --truth test/.artifacts/synth/truth.json` and set `OPENAI_BASE_URL=http://127.0.0.1:4010/v1` in `.env.local`. The fake reads no text: it only recognises the generated test cards, by their coloured marker strip, so it can't be used with real photos.

### Where things live

| Folder | What it does |
|---|---|
| `src/shared/` | Contracts between modules, configuration, text normaliser |
| `src/vision/` | Image clean-up, quality checks, finding and cropping cards |
| `src/extraction/` | The three reads, field rules, comparing reads |
| `src/validation/` | Automatic checks and the verified or needs-review decision |
| `src/data/` | SQLite storage, duplicates, count reconciliation |
| `src/paste/`, `src/export/` | Clipboard encoding, paste verification, `.xlsx` and `.csv` |
| `src/llm/`, `src/engine/` | OpenAI client, rate limiting, the job engine |
| `src/server/`, `src/web/` | Local HTTP API and the web app |
| `test/` | Fake OpenAI server, synthetic cards, accuracy harness, end-to-end tests, paste proof kit |
# card-scanner
