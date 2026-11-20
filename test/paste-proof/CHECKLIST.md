# Paste proof checklist

This checks by hand the one thing software can't check from here: whether every value
arrives in a real spreadsheet exactly as it was printed on the card.

**Pass mark:** every cell identical, character for character, on every route you test.
Sorting and filtering must still work afterwards.

**Why a person is needed:** Google Sheets and Excel decide for themselves what pasted
text means. `+91 98765 43210` can turn into `#ERROR!`, and `+1-555-123-4567` can turn
into `-5244` with no warning at all. Nothing short of a real paste into the real app
proves this is fixed.

## What you need

- This Mac, with the project set up.
- A Google sign-in, for one blank test sheet.
- A Microsoft sign-in, for one blank test workbook in Excel for the web.
- Desktop Excel, only if you want that proven too. Without it, desktop Excel stays
  **unproven**, and the `.xlsx` download is the safe route.
- About 45 minutes.

Menu names below may differ slightly from what you see. If you can't find one, write
down what you did instead in the Notes column.

## Step 1: Capture a real Google Sheets cell (do this first)

The app labels each cell so that Sheets treats it as text. Google doesn't publish the
format, so the app's code for "text" is an unconfirmed guess until this step is done.

1. Open a blank Google Sheet.
2. Type `'+91 98765 43210` into cell A1, with the apostrophe at the front, and press Enter.
3. Click A1 and press Cmd+C.
4. Open Terminal and run this, which saves what Sheets really put on the clipboard:

   ```
   osascript -e 'the clipboard as «class HTML»' | sed 's/«data HTML//;s/»//' | xxd -r -p > ~/Desktop/sheets-cell.html
   ```

5. Open `sheets-cell.html` on your Desktop in a text editor. Find `data-sheets-value`.
   It looks something like `{"1":2,"2":"+91 98765 43210"}`.
6. Write down the number after `"1":`. That is the real code for "text".
7. Note anything wrapped around the table, such as `google-sheets-html-origin` or
   `data-sheets-root`.

**Record it:** real code ________. The app currently uses `2`, in
`SHEETS_STRING_TYPE_CODE` in `src/paste/encode.ts`. If yours differs, stop and send
`sheets-cell.html` to the engineer before going on, because Route 1 can't pass until
the code is changed. Keep the file either way.

## Step 2: The routes

Do these steps once for **each route** in the table below.

1. In Terminal, in the project folder, run `node test/paste-proof/paste-kit.ts copy`.
   It should say `Ready`. If it says `Failed`, stop and write down what it says.
2. Go to a blank sheet, click cell A1 and paste using that route's method.
3. Look through the Phone and Company columns against the table in Step 4. Any change
   at all is a failure, even one character.
4. Click cell A1, hold Shift, click the last cell of the pasted data and press Cmd+C.
5. In Terminal, run `node test/paste-proof/paste-kit.ts check`. It should end with
   `PASS: every cell is identical.` Copy anything it lists into your notes.
6. Do the sort and filter check in Step 3.

| Route | Spreadsheet | How to paste |
|---|---|---|
| 1 | Google Sheets | Normal paste: Cmd+V |
| 2 | Google Sheets | Values only: Cmd+Shift+V |
| 3 | Excel for the web | Normal paste: Cmd+V. Allow clipboard access if the browser asks |
| 4 | Excel for the web | Values only: Paste Special, then Values |
| 5 | Desktop Excel | Normal paste: Cmd+V |
| 6 | Desktop Excel | Values only: Paste Special, then Values or Text |

The values-only routes may show a formula such as `="+91 98765 43210"` in the formula
bar. That is expected. What counts is what the cell shows.

## Step 3: Sort, filter and download

For each route:

1. Sort the sheet by the Phone column, then sort it back. No cell should change.
2. Turn on a filter and filter the Phone column to one value. The right row should show.
3. Download the sheet as CSV, open it and check that three phone values look right.

## Step 4: What every cell must show

Each cell must show exactly the value here, and nothing else. The last column is what
going wrong looks like.

### Phone column

| Must show exactly | Going wrong looks like |
|---|---|
| `+91 98765 43210` | `#ERROR!` |
| `+1-555-123-4567` | `-5244`, a wrong number with no error shown |
| `+919876543210` | The `+` is gone |
| `0412345678` | The leading zero is gone |
| `9198765432101234` | Last digits rounded, or `9.19E+15` |
| `12345678901234567890` | Last digits rounded, or shown in scientific form |
| `10-12-2024` | Turned into a date |
| `(555) 123-4567` | Shown as a negative number |
| `+44 (0)20 7946 0958` | `#ERROR!`, or `(0)` lost |
| `555.123.4567` | Turned into a number or a date |
| `1-800-FLOWERS` | Changed or an error |
| `+91-98765-43210 x204` | An error, or the extension lost |
| `+91 98765 43210; +91 98765 43211` | Split, or an error |
| `020 7946 0958; 07700 900123` | A leading zero lost, or split |
| `0044 20 7946 0958` | Leading zeros lost |
| `+81 3-1234-5678` | An error, or a wrong number |
| `03-1234-5678` | Leading zero lost, or turned into a date |
| `(03) 9123 4567` | Brackets lost, or a negative number |
| `555-123-4567` | A wrong number, or a date |
| `5551234567` | Shown in another number format |
| `+1 (212) 555-0100 ext. 89` | An error |
| `1 800 123 456` | Spaces lost |
| `12/10/2024` | Turned into a date |
| `2024-12-10` | Turned into a date |
| `12.05.2024` | Turned into a date or number |
| `+९१ ९८७६५ ४३२१०` | An error, or the characters damaged |

### Company column (values that aren't phones but get mangled the same way)

| Must show exactly | Going wrong looks like |
|---|---|
| `007` | `7` |
| `3/4` | A date, or `0.75` |
| `TRUE` | A tick box, or a true/false value |
| `FALSE` | A tick box, or a true/false value |
| `=SUM(1)` | `1`: this means it ran as a formula |
| `1e5` | `100000` |
| `@acme` | An error, or a person chip |
| `-Sales` | An error |
| `50%` | `0.5` |
| `$1,000` | `1000`, or currency format |
| `12:30` | A time value |
| `Mar-12` | A date |
| `"Acme" Inc` | Quotes lost, or the row breaks up |
| `#N/A` | A real error value |
| `Müller` | Garbled letters |
| `山田太郎` | Garbled, or boxes |
| `तुलिका` | Letters separated or garbled |

## Step 5: One photo with 30 or more cards

Pasting has to work at this size too, and the order has to survive.

1. In the app, upload one photo of 30 or more cards laid out in rows. Count the cards by
   hand first and write the number down.
2. When the job finishes, open the Photos screen and compare the count on screen with
   your own. If a card is missing, draw a box round it, then confirm the count.
3. Confirm any cards waiting for review, then press Copy.
4. Paste into a blank Google Sheet and a blank Excel for the web sheet.
5. Check three things: the number of rows matches your count, the rows run top to bottom
   and left to right across the photo, and one phone number from each row of the photo
   is exact. A card added by hand may appear after the others from that photo.
6. Use **Verify paste** in the app and confirm it reports no differences.

## Step 6: Record the results

Write PASS, FAIL or NOT TESTED. A route you did not test stays NOT TESTED. Never leave
it to be assumed.

| Route | Clipboard copy said Ready | Every cell identical | `check` said PASS | Sort and filter work | Result | Date, tester, notes |
|---|---|---|---|---|---|---|
| 1. Sheets, normal | | | | | | |
| 2. Sheets, values only | | | | | | |
| 3. Excel web, normal | | | | | | |
| 4. Excel web, values only | | | | | | |
| 5. Desktop Excel, normal | | | | | | |
| 6. Desktop Excel, values only | | | | | | |
| 30+ cards, Google Sheets | | | | | | |
| 30+ cards, Excel for the web | | | | | | |

**Spreadsheet and version tested:** ________________

**Real Sheets text code from Step 1:** ________

## If a route fails

Don't try to fix it. Write down the exact value that changed and what it turned into, take a
screenshot, and send them to the engineer along with `sheets-cell.html`. The plan already
covers this:

1. If one app fails normal paste, it gets its own Copy button using the values-only form.
2. If that fails too, the `.xlsx` download becomes the route for that app, and you'll be told plainly that paste didn't work there.
