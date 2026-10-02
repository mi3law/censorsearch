# Wildcard: Signpost

One instruction ("Search the banned list"), one large box, and each answer as a sign whose top band carries the status words. Filled sign: a listing. Dashed, unfilled sign: only might be the item. Not found: a grey dashed sign of the same size.

## What changed, visibly
- Landing is about 40 words (today 152). The tips sit behind Help.
- Status words sit in a deep band (brick, navy, ochre, slate) above the title. Close matches add a grey strip; possible matches open with "Possible match (…). Check it is your item."
- A reading list is a board: marker, typed line and outcome per row; signs only under rows with listings.
- List status, filter (only with results), privacy, "Open the sheet" and "About this list" are small print below the results. Warnings and Retry stay under the box.

## To ship
`index.html` and `styles.css` replace today's. `app.js` changes: `renderStatus`, `retryButton`, `statusView`, `updateFilterSummary`, `renderNotes`, `renderResults`, `appendNoListingHelp`, `renderSingle`, `renderMulti`, `section`, `card`, plus `TEXT.tooShort`. Today's tests: 34 of 35 pass; one expects the summary "No listing found." (now the full sentence). Unpinned strings changed: filter and maintainer labels, "Close match (…)", "Possible match (…)", "(the sheet says: …)".

## Open questions
- Are solid bands calm enough, or should they be tints?
- Engine hints now sit inside the closed "Why it might be missed". Acceptable?
- Is the filter findable below results?
- "Banned by UAS" is styled but unseen (no test rows).
