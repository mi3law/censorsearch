# CensorSearch

A single static web page that searches a school's banned-materials list, kept in a Google Sheet, more reliably than Ctrl+F. It tolerates moved articles ("Alchemist, The"), missing authors, typos, word order, punctuation and number variants, and links every result to its row in the sheet.

No backend, no stored data, no accounts: the page reads the live sheet (read-only) each time it loads.

**Try it:** <https://mi3law.github.io/censorsearch/> (served from the `v1` branch while v1 is being tested).

- [PRD.md](PRD.md): requirements, with every search hiccup the app handles
- [prototype/](prototype/): the Node prototype of the matching rules, stress-tested against 180 teacher queries

## Using it

Type all or part of a title, an author's name or an ISBN. Results update as you type and come in three tiers: listings found (exact, or "close" when a spelling differs), then possible matches, then "ISBN starts with…" while an ISBN is being typed. Each result shows its status from the Banned By column, its tab and row, and a link that opens that row in the sheet. No results never means "permitted": the page says so.

Paste several titles on separate lines to check a reading list; each line is searched on its own.

## Pointing it at a sheet

The page reads one of two ways. Both feed the same search.

1. **By link (default).** The sheet must be shared "Anyone with the link can view". Set `sheetUrl` and `tabs` in [config.js](config.js), or try any sheet without editing anything by adding `?sheet=` and the sheet's link to the page address:

   ```
   https://mi3law.github.io/censorsearch/?sheet=https://docs.google.com/spreadsheets/d/<id>/edit%23gid=<tab id>
   ```

   The sheet needs a header row (in its first 10 rows) with at least a Title column; columns are matched by header name. Without a tab id, the sheet's first tab is read; its row links select the row only when that tab is `gid=0`, otherwise they open the sheet. When the link points at a different spreadsheet from `config.js`, the page says plainly that it is showing another sheet, not its usual list.

2. **Through the read-only Apps Script**, for a sheet that can't be shared by link (the school's own sheet). Deploy [apps-script/Code.gs](apps-script/Code.gs) under an account with Viewer access to the sheet, following [apps-script/README.md](apps-script/README.md), then set `scriptUrl` in `config.js` so the plain page address reads it (recommended for the school's list). Alternatively open the page with `?script=<the /exec link>`: a script address the page doesn't know is shown with a warning and no sheet or row links, until its code (shown in the page's maintainer notes) is added to `trustedScripts` in `config.js`. That keeps the address itself out of this repository.

The page shows which sheet it is reading, and a link back to the default list when an override is in use.

`tabs` in `config.js` lists the tabs to search by tab id (v1: the main tab only). Adding a tab, such as the test sheet's Other Materials tab (`{ gid: '1111920478', name: 'Other Materials' }`), is a one-line change.

[aliases.json](aliases.json) holds names the sheet doesn't contain (pen names, acronyms, alternate titles). Searching one name also searches the others, and those results are labelled "via alias".

## How it's built

| File | What it does |
| --- | --- |
| [index.html](index.html), [styles.css](styles.css) | The page. A strict Content-Security-Policy allows only this site and Google's sheet endpoints. |
| [config.js](config.js) | The only settings: sheet link, tabs, optional Apps Script link and trusted script codes, the school's Banned By code. |
| [src/sheet.js](src/sheet.js) | Reads the sheet: CSV by link or the Apps Script JSON, finds the header row, maps columns by name, keeps exact row numbers, derives the status from Banned By. |
| [src/engine.js](src/engine.js) | The search: one normalizer for cells and queries, alternate forms, an in-memory index and the tiered matcher. Ported from the prototype, plus the PRD's v1 rules. |
| [src/app.js](src/app.js) | The page's behaviour: load states, search as you type, results, the Banned By filter, freshness checks. |
| [apps-script/](apps-script/) | The read-only fallback for sheets that can't be link-shared. |
| [test/](test/) | `node:test` suites: engine cases for every PRD rule, the prototype's 180 queries, the sheet loader, the Apps Script against a mocked Google. |

No dependencies and no build step. The page must be served over https (or from `localhost`); opened from disk, Google refuses the request.

## Developing

```bash
python3 -m http.server 8765
```

Then open <http://localhost:8765>.

```bash
npm test
```

The sample list is gitignored. Put its `.xlsx` export in the repo root (or set `SAMPLE_XLSX`) to run the sample-based suites; without it they skip, and the synthetic-row suites still run. `node test/bench-engine.js` times the search at 20,000 rows (run `node prototype/gen_synthetic.js` first).

## Privacy

The page fetches the sheet when it opens and keeps the list only in the open tab. What you type is searched in your browser and sent nowhere: it never goes into the page address, and nothing is written to browser storage. There are no accounts and no analytics.
