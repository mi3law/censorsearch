# Option A: Same page, quieter

Today's page and words, with two-thirds of the visible text removed, demoted or collapsed. The most conservative option.

## What changed (visible)

- Landing: name, one-line intro, label, box, small grey status line. 52 words (was 152).
- The three tips sit behind a **Help** button; its panel opens under the box.
- Source line, privacy sentence and maintainer notes moved to the footer. The filter sits after the results, closed.
- Cards: white, hairline border, thin status stripe. Close matches say "Close match · …"; possible matches get a dashed outline, no stripe.
- Nothing found: the caveat is the one large sentence; "Try:" is one line; extra hints wait behind "More tips".
- Reading list: a line with no listing is one quiet row.

## To ship

- Copy `index.html`, `styles.css` to the root (fix script paths).
- `app.js`, 38 changed lines: `renderStatus`, `start` (Help toggle), `updateFilterSummary`, `renderNotes`, `renderResults`, `renderSingle`, `appendNoListingHelp`, `renderMulti`, `card`, `autoGrow`.
- Changed strings: `For list maintainers (N)`, `Filter by Banned By`, `(the sheet says: …)`, `Close match · …`, `More tips`; the live summary says the full no-listing sentence.
- One test fails: WEB2-2 expects the summary `No listing found.`

## Open questions

- "Matched in" shows only for matches outside title and author. Acceptable?
- The status line wraps to two lines on a phone.
- Dark-mode "Banned by UAS" is orchid (navy in light). Right colour?
- The PRD wants the "no author" tip always visible; it needs updating.
