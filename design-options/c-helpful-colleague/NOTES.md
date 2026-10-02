# Option C: Helpful Colleague

The plain-language option: one question, one box, and the answer directly underneath, on a calm warm page. It is the only option that rewrites the jargon ("entries" for rows and listings, "read at" for fetched).

## What changed (visible)

- Landing is about 50 words (today 152). The three tips sit behind one Help control, top right.
- Each card leads with its status in words. Possible matches are dashed and labelled on top.
- Not found is a neutral block with a dark bar. Amber now only means something is wrong with the list.
- A pasted list is one short row per line; only lines with hits grow cards.
- Filter, list date, source and maintainer notes sit below the answer.

## To ship

- Replace `index.html` and `styles.css`; port the `app.js` edits (about 90 lines).
- Functions touched: `TEXT`, `retryButton`, `loadedText`, `renderStatus`, `statusView`, `renderNotes`, `updateFilterSummary`, `hiddenNote`, `renderResults`, `appendNoListingHelp`, `noResults`, `renderSingle`, `renderMulti`, `appendHits`, `card`, `start`.
- About 25 pinned strings in `test/app-ui.test.js` change: status line, summaries, not-found sentences, Retry, "Use the default list", "Show all N listings", filter texts.
- PRD.md lists the "no author" tip as always visible; amend it.

## Open questions

- "20 entries" replaces "20 items" (the proposal kept "items"). Keep?
- Keyboard order is box, then Help, although Help sits above the box.
- "Banned by UAS" and "Listed N times" were only checked with mocked cards.
- Is the tone right for a compliance tool?
