# CensorSearch

A single static web page that searches a school's banned-materials list, kept in a Google Sheet, more reliably than Ctrl+F. It tolerates moved articles ("Alchemist, The"), missing authors, typos, word order, punctuation and number variants, and links every result to its row in the sheet.

No backend, no stored data, no accounts: the page reads the live sheet (read-only) each time it loads.

**Try it:** <https://mi3law.github.io/censorsearch/> (served from the `main` branch).

- [PRD.md](PRD.md): requirements, with every search hiccup the app handles
- [prototype/](prototype/): the Node prototype of the matching rules, stress-tested against 180 teacher queries

## Using it

Type all or part of a title, an author's name or an ISBN. Results update as you type and come in three tiers: listings found (exact, or "close" when a spelling differs), then possible matches, then "ISBN starts with…" while an ISBN is being typed. Each result shows its status from the Banned By column, its tab and row, and a link that opens that row in the sheet. No results never means "permitted": the page says so.

Paste several titles on separate lines to check a reading list; each line is searched on its own.

## Pointing it at a sheet

The page reads one of two ways. Both feed the same search.

1. **By link (default).** The sheet must be shared "Anyone with the link can view". Choose it and its tabs on the [settings page](#changing-the-settings), or try any sheet without changing anything by adding `?sheet=` and the sheet's link to the page address:

   ```
   https://mi3law.github.io/censorsearch/?sheet=https://docs.google.com/spreadsheets/d/<id>/edit%23gid=<tab id>
   ```

   The sheet needs a header row (in its first 10 rows) with at least a Title column; columns are matched by header name. Without a tab id, the sheet's first tab is read; its row links select the row only when that tab is `gid=0`, otherwise they open the sheet. When the link points at a different spreadsheet from the settings, the page says plainly that it is showing another sheet, not its usual list.

2. **Through the read-only Apps Script**, for a sheet that can't be shared by link (the school's own sheet). Deploy [apps-script/Code.gs](apps-script/Code.gs) under an account with Viewer access to the sheet, following [apps-script/README.md](apps-script/README.md), then choose "Through the Apps Script reader" on the [settings page](#changing-the-settings) and paste its `/exec` address, so the plain page address reads it (recommended for the school's list). Alternatively open the page with `?script=<the /exec link>`: a script address the page doesn't know is shown with a warning and no sheet or row links, until its code (shown in the page's maintainer notes) is added under Advanced, "Trusted script codes", on the settings page. That keeps the address itself out of this repository.

The page shows which sheet it is reading, and a link back to the default list when an override is in use.

The settings list the tabs to search by tab id, which survives renames (v1: the main tab only). To add a tab, such as the test sheet's Other Materials tab (tab id `1111920478`), open that tab in the sheet, copy its address and paste it under "Add a tab from its link" on the settings page.

[aliases.json](aliases.json) holds names the sheet doesn't contain (pen names, acronyms, alternate titles). Searching one name also searches the others, and those results are labelled "via alias".

## Changing the settings

The page's settings live in [config.js](config.js): the sheet it reads, its tabs, the optional Apps Script address and trusted script codes, and the school's Banned By code. The list's maintainers change them on the settings page, linked as "Settings for the list's maintainers" at the bottom of the search page (<https://mi3law.github.io/censorsearch/settings.html>):

1. **Change the settings.** The page starts from the current ones and says them in plain words.
2. **Check the list.** The page reads the sheet with the new settings, the way the search page will, and shows each tab's number of items, header row, "updated as of" line, first titles and any data-quality notes. It also warns about things that don't stop saving but may be mistakes: an alias list it can't read, no item with the school's Banned By code, or a tab that the sheet names differently. Saving needs a successful check of exactly the settings on screen, so any change after a check needs a new one.
3. **Review and save.** The page shows the lines of config.js that change, then saves the new file to GitHub with a token you paste ([Making a token](#making-a-token)). It saves to the branch GitHub Pages publishes, and then says when the change is live, usually within a minute or two. From then on the search page shows the new settings in that browser (reload it if it is open). Other browsers that opened the search page in the last 10 minutes may show the old settings for up to 10 more minutes, even after a normal reload, because GitHub Pages lets browsers keep config.js for 10 minutes; a hard reload (Ctrl+Shift+R, or Cmd+Shift+R on a Mac) shows the new ones.

If config.js changed on GitHub since the settings page loaded (or a change is still being published), the page saves nothing and asks you to reload it in a minute.

### Making a token

Saving uses a fine-grained personal access token from a GitHub account that can change this repository. The settings page uses it for that one save and stores it nowhere, so paste it each time, from a password manager.

1. On the settings page, open "How to make a token" and follow its link: GitHub's new-token page opens with the name, owner and permissions filled in. (Or, on GitHub: Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token.)
2. **Resource owner:** the repository's owner (`mi3law` for this copy).
3. **Repository access:** Only select repositories, then choose this repository. GitHub can't fill this in from a link.
4. **Repository permissions:** Contents: **Read and write**, and Pages: **Read-only**, so the settings page can find the branch (and folder) GitHub Pages publishes. Without Pages access it can't tell where the site comes from, so it saves nothing.
5. **Expiration:** any. A short one is safer, since you can make a new token whenever you need one.
6. Click **Generate token** and copy it. GitHub shows it only once: keep it in a password manager, not in a file, a message or this repository.

Revoke a token at <https://github.com/settings/personal-access-tokens>. If the repository belongs to an organization, the organization may need to approve the token first.

### Editing config.js by hand

You can still edit [config.js](config.js) directly on GitHub (or in a clone) and commit; each setting has a comment saying what it does. Keep it valid JavaScript, since a mistake there stops the search page from loading the list. The settings page reads hand edits too; if the file's layout differs from the one it writes, it says so, and saving rewrites the file in its own layout (the changes it shows before saving include every line).

## How it's built

| File | What it does |
| --- | --- |
| [index.html](index.html), [styles.css](styles.css) | The page. A strict Content-Security-Policy allows only this site and Google's sheet endpoints. |
| [config.js](config.js) | The only settings: sheet link, tabs, optional Apps Script link and trusted script codes, the school's Banned By code. Changed on the settings page or by hand. |
| [settings.html](settings.html), [src/settings.js](src/settings.js) | The settings page: shows the settings in plain words, checks the sheet with new ones, shows the changes to config.js and saves it through GitHub's API with a token pasted for each save. It refuses to work inside another page. |
| [src/sheet.js](src/sheet.js) | Reads the sheet: CSV by link or the Apps Script JSON, finds the header row, maps columns by name, keeps exact row numbers, derives the status from Banned By. |
| [src/engine.js](src/engine.js) | The search: one normalizer for cells and queries, alternate forms, an in-memory index and the tiered matcher. Ported from the prototype, plus the PRD's v1 rules. |
| [src/app.js](src/app.js) | The page's behaviour: load states, search as you type, results, the Banned By filter, freshness checks. |
| [apps-script/](apps-script/) | The read-only fallback for sheets that can't be link-shared. |
| [test/](test/) | `node:test` suites: engine cases for every PRD rule, the prototype's 180 queries, the sheet loader, the Apps Script against a mocked Google, the settings page against a mocked GitHub. |

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

The page fetches the sheet when it opens and keeps the list only in the open tab. What you type is searched in your browser and sent nowhere: it never goes into the page address, and nothing is written to browser storage. There are no accounts and no analytics. The settings page sends the token you paste only to GitHub (api.github.com), for the save you ask for, and keeps it nowhere: the field is cleared once the save is done.
