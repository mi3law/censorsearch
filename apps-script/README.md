# CensorSearch sheet reader (Apps Script)

CensorSearch normally reads a sheet straight from Google by its link. That only works when the sheet is shared as "Anyone with the link can view". The school's own sheet is not, so the page reads it through this small read-only script instead. The script runs on Google, under an account that can view the sheet, and hands the page the list as data. It stores nothing.

You need this only for a sheet that can't be shared by link. Setting it up takes about 10 minutes and needs no programming.

## What the script shares, and with whom

- **Only the list's columns:** Title, Author, ISBN, Banned By, Type, Year of Banning and Memo (the mapped columns), and any https links in those cells, such as memo links. From the rows above the header it sends two cells only: the list's title (the first filled cell) and its "updated as of…" line. Everything else, such as a Status column, the notes box beside the list or a note beside the title, stays in the sheet.
- **To anyone who has the script's address, without signing in.** That's the accepted v1 behaviour: anyone with the CensorSearch page link can search the list. Row links in the results still open only for people who have access to the sheet.
- **Nothing is kept.** The script reads the sheet when the page asks, sends the result and forgets it: no copy, no log and, by default, no cache.
- **It only reads.** The script only ever reads cells. Google has no read-only version of the permission to open a spreadsheet by its id, so the permission it asks for (step 3) is the broad one, to see and edit your Google Sheets spreadsheets. That's why its account must have **Viewer** access to the sheet, not Editor: then the sheet can't be changed through the script at all.
- **One tab unless you say otherwise.** Without `TABS` (step 2) it shares only the first tab that isn't hidden. Any other tab, hidden or not, is shared only if you list it in `TABS`.
- Hidden and filtered rows are included and marked, so the page can say "may be hidden by the sheet's filter".

## Before you start

- **Pick the account.** Use an account that will stay: ideally a long-lived school role account (for example a shared library account) rather than one teacher's account. The script stops working the day its account is removed, so if a teacher's account is used for now, switch to a role account before any staff change (see "Moving to another account").
- **Give that account Viewer access to the sheet** (Share, add the account, Viewer).
- **Your Google Workspace admin must allow Apps Script,** and web apps open to "Anyone". If "Anyone" is missing under "Who has access" in step 3 ("Deploy it as a web app"), the admin has blocked it; see "If it doesn't work".

Sign in to Google as that account for all the steps below.

## 1. Create the script

1. Go to [script.google.com](https://script.google.com) and click **New project**.
2. Click "Untitled project" at the top and name it `CensorSearch reader`.
3. In the editor, select everything in `Code.gs`, delete it, and paste the whole of [`Code.gs`](Code.gs) from this folder.
4. Click **Project Settings** (the gear on the left) and tick **Show "appsscript.json" manifest file in editor**.
5. Go back to the **Editor** (the `< >` icon), open `appsscript.json`, replace everything in it with [`appsscript.json`](appsscript.json) from this folder, and click **Save** (the disk icon). This also turns on the **Google Sheets API** service (it appears under **Services** on the left), which the script uses to find out in one step which rows are hidden or filtered.

## 2. Tell it which sheet to read

Settings live in the script's properties, never in the code. In **Project Settings**, scroll to **Script properties**, click **Add script property** for each line below, then **Save script properties**.

| Property | Value | Needed? |
| --- | --- | --- |
| `SPREADSHEET_ID` | The sheet's id: the part of its link between `/d/` and `/edit`. In `https://docs.google.com/spreadsheets/d/<the id>/edit#gid=0` it's `<the id>`. Pasting the whole link also works. | Required |
| `TABS` | The tabs to share, as tab ids separated by commas, for example `0` or `0,1111920478`. A tab's id is the number after `gid=` in the link while that tab is open. Leave it out to share only the first tab that isn't hidden. Any other tab, hidden or not, is shared only if listed here. | Optional; recommended |
| `CACHE_SECONDS` | Leave it out. See "Limits". | Optional |

For CensorSearch v1, set `TABS` to `0` (the main tab), so the main tab stays the one shared even if someone adds or reorders tabs.

Changes to these properties apply to the next request at once; you don't need to redeploy.

## 3. Deploy it as a web app

1. Click **Deploy** (top right), then **New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Description: `CensorSearch v1`.
4. **Execute as: Me.** The script reads the sheet as this account, so visitors don't need access to the sheet.
5. **Who has access: Anyone.** (Not "Anyone with Google account": teachers must not need to sign in.)
6. Click **Deploy**, then **Authorize access** and choose the account. If Google shows "Google hasn't verified this app", that's because you just wrote it: click **Advanced**, then **Go to CensorSearch reader (unsafe)**. Google then asks to let it "see, edit, create and delete all your Google Sheets spreadsheets". That's expected: opening a sheet by its id needs this permission, the script only reads, and the account's Viewer access keeps the sheet itself unchanged. It should ask for nothing else, such as Drive or Gmail.
7. Copy the **Web app URL**. It ends in `/exec`. That's the script's address.

## 4. Test it

Open the `/exec` address in a private (incognito) window, where you're not signed in. You should see text starting with `{"format":"censorsearch-v1"`, followed by your list's rows.

- `{"format":"censorsearch-v1","error":"…"}` means the script ran but couldn't read the sheet; the message says why (see the table below).
- A Google sign-in page means "Who has access" isn't "Anyone", or your admin doesn't allow it.
- Adding `?gid=0` to the address returns only that tab.

## 5. Point CensorSearch at it

Either:

- **Make it the default (recommended for the school's list):** put the address in `scriptUrl` in `config.js` (`scriptUrl: 'https://script.google.com/macros/s/…/exec'`), and point `sheetUrl` at the same sheet (the page links to it if the script can't be reached). The plain page address then reads the school's list, so every bookmark, and the page's own "use the default list" link, leads to it. The address becomes visible in the public repository and in the page's `config.js`. Anyone with the page link can already search the list (v1's accepted access), so this adds little exposure.
- **Or use a link:** open the CensorSearch page with `?script=` and the `/exec` address added, for example `https://<the CensorSearch page address>/?script=https://script.google.com/macros/s/…/exec`. The page treats a `?script=` address it doesn't know as someone else's list: it shows a warning and gives no sheet or row links, so a stranger's script can't pose as the school's list. To make your link trusted without publishing its address, open it once, expand "Notes for the list's maintainers" at the bottom of the page, and add the code shown there to `trustedScripts` in `config.js` (the code stands for the address without revealing it). Then bookmark and share that link. The plain page address still reads `sheetUrl`, so make sure that is the list you want people to land on without the link.

The page says which source it's reading and shows "N items · updated as of … · fetched hh:mm".

## Updating the script

When `Code.gs` changes in this repository:

1. Paste the new `Code.gs` over the old one and **Save**.
2. Click **Deploy**, then **Manage deployments**, select the deployment, click the pencil (**Edit**), set **Version: New version**, then **Deploy**.

This keeps the same `/exec` address. Don't use "New deployment" for an update: that creates a new address, and every link and `config.js` would need changing.

## Limits

- **Simultaneous use:** Google runs at most 30 Apps Script executions at the same time for one account, and every read runs as the script's account, so all visitors share that limit. The page reads the list when it opens, and again every 5 minutes while it is on screen (so row links stay current): about 12 short runs an hour for each open page. This matters only if very many people use the page at the same moment. Those who hit the limit see an error and can press Retry; a failed background refresh keeps the list already on screen.
- **The lever, if that ever happens:** set `CACHE_SECONDS` to a number up to `300` (5 minutes; larger values are treated as 300). Google then keeps each answer for that many seconds and reuses it, so the page can be up to that far behind the sheet, and a copy of the mapped columns sits in Google's script cache for that long. Leave it out (no cache) unless you need it.
- **Speed:** the script reads each tab in a fixed handful of calls, however many rows it has: the cells, their links, the ISBN column, merged cells, and one Sheets API call for which rows are hidden or filtered. It hasn't been timed on the school's sheet yet. After deploying, open the project's **Executions** page (the list icon on the left) to see how long each page load took. If loads are slow, `CACHE_SECONDS` helps.
- **Hidden-row labels:** Google's Sheets API allows about 60 reads a minute for one account, and every read of the list uses one (see the 5-minute refresh above). Past that, or if the Google Sheets API service is turned off, the list still loads, just without the "may be hidden by the sheet's filter" labels.

## Moving to another account

The script belongs to the account that created it, and stops working when that account is removed or loses access to the sheet. To move it (do this before the staff change, not after):

1. Give the new account (ideally a school role account) Viewer access to the sheet.
2. Signed in as the new account, do steps 1 to 4 again. This gives a new `/exec` address.
3. Update `scriptUrl` in `config.js`, or the shared `?script=` link and its `trustedScripts` code in `config.js` (open the new link and copy the new code from the maintainers' notes), to the new address.
4. In the old account, open the old project, **Deploy**, **Manage deployments**, and **Archive** the old deployment.

## If it doesn't work

| What you see | What to do |
| --- | --- |
| "The script is not set up yet: add SPREADSHEET_ID…" | Add the `SPREADSHEET_ID` script property (step 2). |
| "SPREADSHEET_ID … is not a spreadsheet id or link" | Copy the id again from the sheet's link. |
| "The script isn't allowed to open spreadsheets…" | `appsscript.json` is missing the Google Sheets permission. Replace it with [`appsscript.json`](appsscript.json) from this folder (step 1), save, deploy a new version (see "Updating the script") and authorize it when asked. |
| "Can't open the spreadsheet…" | The id is wrong, or the script's account can't view the sheet: share the sheet with that account as Viewer. |
| "No Title column in the first 10 rows of this tab…" | The header row moved below row 10, or its Title column was renamed; or `TABS` lists a tab that isn't a list; or, without `TABS`, the first tab isn't the list: set `TABS` to the list's tab id. |
| "This tab is not available from this script." | The page asked for a tab that isn't in `TABS` (without `TABS`, only the first tab that isn't hidden is available). Add its id to `TABS`, or fix the page's tab setting. |
| "Every tab is hidden…" | Add the list's tab id to `TABS`. |
| "No tab with this id in the spreadsheet…" | A tab listed in `TABS` was deleted. Remove it from `TABS`. |
| A Google sign-in page instead of the list | Set "Who has access" to "Anyone" (Manage deployments, Edit). If "Anyone" isn't offered, see below. |

**Risk: the school's Workspace admin can turn off Apps Script,** or web apps open to "Anyone" (the second is reported by users, not documented by Google). If that happens, this reader can't work without sign-in. Ask the admin to allow it for the script's account; otherwise CensorSearch would need school sign-in, with the page served by Apps Script itself, which is planned for later, not v1.

## For developers: the response

`GET <exec URL>` returns every shared tab (without `TABS`, the first tab that isn't hidden); `GET <exec URL>?gid=0,123` returns only those tabs (each must be one the script shares; others come back as entries in `errors`). Every other parameter is ignored, and there is no POST.

```json
{
  "format": "censorsearch-v1",
  "spreadsheetId": "…",
  "fetchedAt": "2026-09-29T20:05:00.000Z",
  "tabs": [
    { "name": "Sheet1", "gid": "0", "hiddenTab": false, "headerRow": 3,
      "above": [["Banned Materials by Ministry and Others 2004-2025"], ["updated as of 28 September 2026"]],
      "headers": ["Title", "Author", "ISBN", "Banned By", "Type", "Year of Banning", "Memo"],
      "columns": ["A", "B", "C", "D", "E", "F", "G"],
      "lastColumn": "G",
      "rows": [ { "row": 4, "values": ["101 Creepy Jokes", "Jovial Bob Stine", "", "RS", "Book", "2010-2011", ""],
                  "raw": {}, "links": {}, "hidden": false } ] }
  ],
  "errors": [ { "tab": "gid 123", "message": "This tab is not available from this script." } ]
}
```

- The header row is the first of the top 10 rows with a Title-like cell in any column; columns are mapped by header name with the same synonyms as `src/sheet.js`. Only mapped columns are returned, in sheet order.
- `values` are the cells as displayed. A merged cell's value is copied to every row the merge covers (in the merge's first column). Rows whose mapped cells are all empty are left out.
- `above` has one entry per row above the header, holding at most two cells in all: the first cell mentioning "updated" (the "updated as of" line) and the first other non-empty cell (the list's title). Every other cell is left out, so a row can come back as `[]`.
- `lastColumn` is the last column with a header (it can be an unmapped one such as Status), for the row link's range.
- `raw` holds the exact ISBN as digits (and a final X) by value index, so `9.79889E+12` on screen still yields all 13 digits. It is set only when the cell holds one whole ISBN (9, 10 or 13 characters); a cell with several ISBNs gets none, and the page splits the displayed text into each ISBN. `links` holds https links by value index, from cell links or `=HYPERLINK("https://…", …)`; any other link is dropped.
- `hidden` is true when the row is hidden by a user or by the sheet's filter, false when it isn't, and `null` when the script couldn't tell (the Google Sheets API service is off or over its limit).
- If nothing can be read: `{ "format": "censorsearch-v1", "error": "a plain message" }`, never a stack trace, id or email address.

`test/apps-script.test.js` runs `Code.gs` against a mocked, synthetic spreadsheet (`npm test`); its output is kept in `test/fixtures/script-response.json`.
