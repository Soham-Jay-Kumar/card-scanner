# Accuracy harness

Runs a folder of card images through the whole app and scores the results against
known answers, per field, as an exact string match.

## Running it

```
node test/accuracy/run.ts                                   # synthetic set, fake server
OPENAI_API_KEY=sk-... node test/accuracy/run.ts             # synthetic set, live Luna
OPENAI_API_KEY=sk-... node test/accuracy/run.ts --truth /path/to/real-cards/truth.json
```

`OPENAI_API_KEY` is the only switch between the fake server and the live API. The
code is otherwise the same. Options: `--country US` sets the default phone country,
and `--noise 0.02 --correlated 0.002 --seed 1` adds seeded misreads on the fake server.

Reports go to `test/.artifacts/accuracy/`.

**Scores against the fake server say nothing about real Luna accuracy.** The fake reads
no text: it recognises each card by a coloured strip and answers from a table. Those
runs only prove the pipeline logic. The plan's targets count only on the live API, on
at least 50 real cards checked by hand:

| Target | Pass mark |
|---|---|
| Verified fields that are exactly right | at least 99.5% |
| Invented values | 0 |
| Cards verified without a person | at least 85% |

## Scoring real cards

1. Put the card images in one folder.
2. Add `truth.json` beside them, written by hand from the printed cards.
3. Run the third command above.

Write each value exactly as the app should give it, following the column rules:
`Dr. Jane Doe, PhD` keeps its credentials, numbers stay as printed, several values
are joined with `; `, fax numbers are left out, and a blank cell is `""`.

```json
{
  "version": 1,
  "source": "hand-labelled",
  "files": [
    {
      "file": "IMG_0412.jpg",
      "cards": [
        {
          "row": {
            "name": "Dr. Jane Doe, PhD",
            "position": "Chief Medical Officer",
            "company": "Harbor Health Group",
            "email": "jane.doe@harborhealth.org",
            "phone": "+1 617 555 0118; +1 617 555 0119",
            "website": "www.harborhealth.org"
          },
          "printed": ["Dr. Jane Doe, PhD", "Chief Medical Officer", "Harbor Health Group", "T +1 617 555 0118", "M +1 617 555 0119", "jane.doe@harborhealth.org", "www.harborhealth.org", "12 Quay Street, Boston"],
          "difficulty": "easy"
        }
      ]
    },
    { "file": "table-photo.jpg", "expect": "no_card", "cards": [] }
  ]
}
```

| Key | Needed | Meaning |
|---|---|---|
| `file` | yes | Path relative to `truth.json`. Files upload in this order. |
| `cards` | yes | One entry per card, in reading order: top to bottom, then left to right. |
| `row` | yes | The six exact cells. |
| `printed` | recommended | Every printed line. Without it, a wrong value that looks nothing like the right one counts as invented. |
| `difficulty` | optional | `easy`, `medium` or `hard`, for the breakdown. |
| `buckets` | optional | Extra breakdowns. Add `"sheet-30+"` to every card on an image holding 30 or more. |
| `expectedStatus` | optional | `verified` or `needs_review`, only when the outcome is certain. |
| `expect` | optional | On a file: `cards` (default), `no_card`, `failed` or `duplicate`. |

## What gets reported

- **Overall accuracy:** every field of every card, including fields a person would still check.
- **Verified accuracy:** only fields on verified cards. This is the number that matters most.
- **Invented values:** a filled-in field that truth says is blank, or text that is neither on the card nor close to the right answer. A website worked out from an email domain counts, even though the domain is printed.
- **Lost cards:** in truth but never found. All six fields count as wrong.
- **Review rate and verified rate.**
- **Breakdowns:** by difficulty, by degradation, and `sheet-30+` for images holding 30 or more cards.
- **Reading order, files that ended wrongly, and every wrong verified value by name.**
