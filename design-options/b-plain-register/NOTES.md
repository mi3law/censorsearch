# Option B: Plain Register

Today's content, re-ordered. The title is the box's label, the answer sits directly under the box, each listing leads with its status as a tag in words, and everything else waits below a rule.

## What changed (visible)

- Landing: wordmark, "Check the banned list", one hint with **Help** at its right, the box. Tips open under the box.
- The status line, privacy sentence and "About this page" (source, the two times explained, maintainer notes) sit at the foot. The filter appears after results only.
- Cards: status tag first; "Close match · …" or "Possible match: …" above it; dashed outline for possible matches.
- Nothing found: one block with the caveat, "Try:" on one line, extra hints behind one disclosure.
- Reading list: one row per line, outcome at the right.

## To ship

Copy the `index.html` body, `styles.css`, and about 40 changed lines in `app.js`: `retryButton`, `renderStatus`, `updateFilterSummary`, `renderResults`, `appendNoListingHelp`, `renderSingle`, `renderMulti`, `card`.

Strings changed: "(the sheet says: …)"; the possible-section intros; "Close match · …"; "Filter by Banned By"; the no-results live summary. Against the current tests, one assertion fails (the `'No listing found.'` summary).

## Open questions

- The proposal's "!" icon and the mark on found lines were left out as ornament. Wanted?
- "Check the banned list" or "Check the banned-materials list"?
- Help follows the box in tab order. Acceptable?
- The "no author" tip is no longer standing text (a PRD v1 must).
