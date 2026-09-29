# Search prototype

A throwaway Node prototype of the matching rules in [PRD.md](../PRD.md), built to stress-test them before the real single-page app is written. It is not the app: no UI and no Google Sheets loading, just the normalizer, index and tiered search run against the sample export.

## Run it

Needs Node 18+ and the `unzip` CLI. The sample `.xlsx` is gitignored, so put a copy in the repo root first, or point `SAMPLE_XLSX` at it.

```bash
node run.js
```

```bash
node gen_synthetic.js && node scale.js && node bench.js
```

| File | What it does |
| --- | --- |
| `engine.js` | Normalizer, slot tokenizer, inverted index and tiered search (`buildIndex`, `search`) |
| `load.js` | Reads every tab of the .xlsx: finds the header row, maps columns by name, keeps sheet row numbers |
| `queries.js` | 180 teacher queries, each with the rows it must return (`S20` = Sheet1 row 20, `O5` = Other Materials row 5) |
| `run.js` | Recall, flood and noise report for `queries.js` (`--all` prints every query) |
| `gen_synthetic.js` | Hides the sample rows among 20,000 synthetic rows in `data/rows20k.json` (gitignored) |
| `scale.js` | Recall and rank of the same queries at 20,000 rows |
| `bench.js` | Per-keystroke timing and result counts for flood-prone queries |

## Results (29 September 2026, Apple M4 Pro, Node 26)

- **Sample:** 162 of 162 expected rows found, 159 in the strong tier; 0 floods; median 1 result per query.
- **20,000 rows:** 162 of 162 found, all within the top 25 of their tier; 0.9 ms median and about 4 ms p95 per keystroke; 340 ms index build.
- Three queries are expected misses because the sheet doesn't hold the words: a pen name ("daniel handler"), an unlisted co-author ("mark victor hansen") and a spelled-out acronym ("core knowledge language arts").

## Rule changes found by the stress test

The first draft of the rules found 153 of 162 rows. Each fix below is tagged `FIX Fn` in `engine.js`.

| Fix | Change |
| --- | --- |
| F1 | Map Arabic-Indic and Persian digits to 0–9; delete invisible format characters |
| F2 | Year of Banning isn't searched; Type and Banned By can complete a match but never anchor one |
| F3 | Digit-only words prefix-match only from 3 digits |
| F4 | Format and edition words (book, dvd, disc, paperback…) are optional |
| F5 | A query of only small words ("the", "of the") shows a hint, not results |
| F6 | Strip "Et Al" / "and others" from authors before indexing |
| F7 | Label + number pairs (unit 4, grade 5, book 3) are one exact term; class/grade/standard share a key |
| F8 | A run of initials (r. l.) is one slot; initials are optional beside a real word |
| F9 | In a one-word query, fuzzy-only hits go to the possible tier |
| F10 | ISBN labels are stripped, hyphenated groups joined, and partial ISBNs prefix-match while typing |
| F11 | Spoken digit groups: "four fifty-one" also reads as 451; number words get no fuzzy edits |
| F12 | A one-word title inside a long pasted query counts when the row's author is also in the query |
| F13 | Query words ending in s also try the singular, including against joined pairs |
| F14 | Don't index the paste residue in Sheet1 A8 ("+3:15A13:…") |
| F15 | A one-word title counts as "inside the query" only on an exact match |
| F16 | A possible match must be anchored by an exact, variant or prefix hit, never fuzzy |
| F17 | Edit budget: 0 up to 3 letters, 1 for 4–7, 2 from 8; the unfinished last word gets at most 1 |

The completeness review that followed added more rules to the PRD that this prototype does not implement yet. Examples are short acronyms like "Plan B" staying required, Banned By status parsing, and multi-line paste. The PRD is the spec; this code is evidence that the core approach holds.
