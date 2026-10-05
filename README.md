# CensorSearch

A single static web page that searches a school's banned-materials list, kept in a Google Sheet, more reliably than Ctrl+F. It tolerates moved articles ("Alchemist, The"), missing authors, typos, word order, punctuation and number variants, and links every result to its row in the sheet.

No backend and no stored data: the page reads the live sheet (read-only) each time it loads. It needs no accounts of its own; for a list limited to people who can view the sheet, teachers sign in with their Google account ([Signing in](#signing-in)).

**Try it:** <https://mi3law.github.io/censorsearch/> (served from the `main` branch).

- [PRD.md](PRD.md): requirements, with every search hiccup the app handles
- [prototype/](prototype/): the Node prototype of the matching rules, stress-tested against 180 teacher queries

## Using it

Type all or part of a title, an author's name or an ISBN. Results update as you type and come in three tiers: listings found (exact, or "close" when a spelling differs), then possible matches, then "ISBN starts with…" while an ISBN is being typed. Each result shows its status from the Banned By column, its tab and row, and a link that opens that row in the sheet. No results never means "permitted": the page says so.

Paste several titles on separate lines to check a reading list; each line is searched on its own.

## Pointing it at a sheet

The page reads one of three ways. All feed the same search.

1. **By link (default).** The sheet must be shared "Anyone with the link can view". Choose it and its tabs on the [settings page](#changing-the-settings), or try any sheet without changing anything by adding `?sheet=` and the sheet's link to the page address:

   ```
   https://mi3law.github.io/censorsearch/?sheet=https://docs.google.com/spreadsheets/d/<id>/edit%23gid=<tab id>
   ```

   The sheet needs a header row (in its first 10 rows) with at least a Title column; columns are matched by header name. Without a tab id, the sheet's first tab is read; its row links select the row only when that tab is `gid=0`, otherwise they open the sheet. When the link points at a different spreadsheet from the settings, the page says plainly that it is showing another sheet, not its usual list.

2. **With Google sign-in**, so that only people who can view the sheet can search it (recommended for the school's list). Each teacher signs in with their Google account and the page reads the sheet with their own access: Google answers only if that account can open the sheet. The sheet needn't be shared by link. Setting it up takes one Google Cloud project; see [Signing in](#signing-in).

3. **Through the read-only Apps Script**, for a sheet that can't be shared by link, when anyone with the page's link may search it. Deploy [apps-script/Code.gs](apps-script/Code.gs) under an account with Viewer access to the sheet, following [apps-script/README.md](apps-script/README.md), then choose "Through the Apps Script reader" on the [settings page](#changing-the-settings) and paste its `/exec` address, so the plain page address reads it. Alternatively open the page with `?script=<the /exec link>`: a script address the page doesn't know is shown with a warning and no sheet or row links, until its code (shown in the page's maintainer notes) is added under Advanced, "Trusted script codes", on the settings page. That keeps the address itself out of this repository.

The page shows which sheet it is reading, and a link back to the default list when an override is in use.

The settings list the tabs to search by tab id, which survives renames (v1: the main tab only). To add a tab, such as the test sheet's Other Materials tab (tab id `1111920478`), open that tab in the sheet, copy its address and paste it under "Add a tab from its link" on the settings page.

[aliases.json](aliases.json) holds names the sheet doesn't contain (pen names, acronyms, alternate titles). Searching one name also searches the others, and those results are labelled "via alias".

## Signing in

With sign-in, the page asks each visitor to sign in with Google before it reads anything. It asks Google for one permission, to see Google Sheets (read-only), and uses it only to read the list. Google then answers only if that account can view the sheet, so the list's own sharing decides who can search it: add or remove someone in the sheet's Share box and the page follows. Nothing runs on a server of ours: the page is still a static page on GitHub Pages.

The sign-in lasts about an hour. After that the list already on screen stays searchable, and the page asks to sign in again before it reads the sheet again.

### Setting it up (once)

Google needs to know which site may ask teachers to sign in. That registration lives in a Google Cloud project; it runs nothing and costs nothing. Do this signed in with a school account:

1. Open [console.cloud.google.com](https://console.cloud.google.com), click the project picker, then **New project**. Name it `CensorSearch` and keep **Location** on the school's organization.
2. In the project: ☰, **APIs & Services**, **OAuth consent screen** (Google Auth Platform), **Get started**. App name `CensorSearch`, your school address as support email, **Audience: Internal**. Internal means only the school's Google accounts can sign in, and Google doesn't need to review the app.
3. **APIs & Services**, **Library**: find **Google Sheets API** and click **Enable**.
4. **Clients**, **Create client**, **Web application**. Under **Authorized JavaScript origins** add the page's address without a path, `https://mi3law.github.io` for this copy (and `http://localhost:8765` to test locally). No redirect URIs. Copy the **Client ID**, which ends in `.apps.googleusercontent.com`. It is public; never use or share the client secret shown beside it.
5. On the [settings page](#changing-the-settings), choose **With Google sign-in**, paste the client ID, keep the sheet link and tabs, then check the list (you sign in yourself) and save.
6. If the list was read through the Apps Script before, archive that deployment once sign-in works (in the script: **Deploy**, **Manage deployments**, **Archive**). Until then it keeps answering anyone who has its address, which is public in this repository's history.

If a step says you need permission, or a teacher's sign-in says the school's settings don't allow the app, the school's Google admin has to allow it (for Internal apps this is rare).

For sign-in to keep people out, the sheet itself must not be shared "Anyone with the link can view": the settings page warns when it is.

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
| [index.html](index.html), [styles.css](styles.css) | The page. A strict Content-Security-Policy allows only this site, Google's sheet endpoints and Google sign-in. |
| [config.js](config.js) | The only settings: sheet link, tabs, the optional sign-in client ID, the optional Apps Script link and trusted script codes, the school's Banned By code. Changed on the settings page or by hand. |
| [settings.html](settings.html), [src/settings.js](src/settings.js) | The settings page: shows the settings in plain words, checks the sheet with new ones, shows the changes to config.js and saves it through GitHub's API with a token pasted for each save. It refuses to work inside another page. |
| [src/sheet.js](src/sheet.js) | Reads the sheet: CSV by link, the Google Sheets API with a visitor's sign-in, or the Apps Script JSON; finds the header row, maps columns by name, keeps exact row numbers, derives the status from Banned By. |
| [src/signin.js](src/signin.js) | Google sign-in: loads Google Identity Services only in sign-in mode and keeps the visitor's read-only token in memory. |
| [src/engine.js](src/engine.js) | The search: one normalizer for cells and queries, alternate forms, an in-memory index and the tiered matcher. Ported from the prototype, plus the PRD's v1 rules. |
| [src/app.js](src/app.js) | The page's behaviour: load states, search as you type, results, the Banned By filter, freshness checks. |
| [apps-script/](apps-script/) | The read-only fallback for sheets that can't be link-shared. |
| [test/](test/) | `node:test` suites: engine cases for every PRD rule, the prototype's 180 queries, the sheet loader, sign-in and the Sheets API against a mocked Google, the Apps Script against a mocked Google, the settings page against a mocked GitHub. |

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

The page fetches the sheet when it opens and keeps the list only in the open tab. What you type is searched in your browser and sent nowhere: it never goes into the page address, and nothing is written to browser storage. There are no accounts of the page's own and no analytics. With sign-in, Google gives the page a token that can only read Google Sheets and runs out after about an hour; the page keeps it in the open tab, uses it only to read the list from Google, and never stores or shows it. The settings page sends the token you paste only to GitHub (api.github.com), for the save you ask for, and keeps it nowhere: the field is cleared once the save is done.
