# CensorSearch sheet reader (Apps Script)

CensorSearch normally reads a sheet straight from Google by its link. That only works when the sheet is shared as "Anyone with the link can view". The school's own sheet is not, so the page reads it through this small read-only script instead. The script runs on Google, under an account that can view the sheet, and hands the page the list as data. It stores nothing.

You need this only for a sheet that can't be shared by link. Setting it up takes about 10 minutes and needs no programming.

## What the script shares, and with whom

- **Only the list's columns:** Title, Author, ISBN, Banned By, Type, Year of Banning and Memo (the mapped columns), plus the lines above the header row (the list's title and its "updated as of…" line) and any https links in those cells, such as memo links. Every other column, such as a Status column or the notes box beside the list, stays in the sheet.
- **To anyone who has the script's address, without signing in.** That's the accepted v1 behaviour: anyone with the CensorSearch page link can search the list. Row links in the results still open only for people who have access to the sheet.
- **Nothing is kept.** The script reads the sheet when the page asks, sends the result and forgets it: no copy, no log and, by default, no cache.
- **It can only read.** It asks Google for read-only permission to spreadsheets and only ever reads cells. Give its account **Viewer** access to the sheet, not Editor.
- Hidden and filtered rows are included and marked, so the page can say "may be hidden by the sheet's filter". Hidden tabs are included only if you list them in `TABS`.

## Before you start

- **Pick the account.** Use an account that will stay: ideally a long-lived school role account (for example a shared library account) rather than one teacher's account. The script stops working the day its account is removed, so if a teacher's account is used for now, switch to a role account before any staff change (see "Moving to another account").
- **Give that account Viewer access to the sheet** (Share, add the account, Viewer).
- **Your Google Workspace admin must allow Apps Script,** and web apps open to "Anyone". If "Anyone" is missing under "Who has access" in step 4, the admin has blocked it; see "If it doesn't work".

Sign in to Google as that account for all the steps below.

## 1. Create the script

1. Go to [script.google.com](https://script.google.com) and click **New project**.
2. Click "Untitled project" at the top and name it `CensorSearch reader`.
3. In the editor, select everything in `Code.gs`, delete it, and paste the whole of [`Code.gs`](Code.gs) from this folder.
4. Click **Project Settings** (the gear on the left) and tick **Show "appsscript.json" manifest file in editor**.
5. Go back to the **Editor** (the `< >` icon), open `appsscript.json`, replace everything in it with [`appsscript.json`](appsscript.json) from this folder, and click **Save** (the disk icon).

## 2. Tell it which sheet to read

Settings live in the script's properties, never in the code. In **Project Settings**, scroll to **Script properties**, click **Add script property** for each line below, then **Save script properties**.

| Property | Value | Needed? |
| --- | --- | --- |
| `SPREADSHEET_ID` | The sheet's id: the part of its link between `/d/` and `/edit`. In `https://docs.google.com/spreadsheets/d/<the id>/edit#gid=0` it's `<the id>`. Pasting the whole link also works. | Required |
| `TABS` | The tabs to share, as tab ids separated by commas, for example `0` or `0,1111920478`. A tab's id is the number after `gid=` in the link while that tab is open. Leave it out to share every tab that isn't hidden and has a Title header in its first 10 rows. A hidden tab is shared only if listed here. | Optional; recommended |
| `CACHE_SECONDS` | Leave it out. See "Limits". | Optional |

For CensorSearch v1, set `TABS` to `0` (the main tab), so that a new tab added to the sheet later isn't shared by surprise.

Changes to these properties apply to the next request at once; you don't need to redeploy.

## 3. Deploy it as a web app

1. Click **Deploy** (top right), then **New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Description: `CensorSearch v1`.
4. **Execute as: Me.** The script reads the sheet as this account, so visitors don't need access to the sheet.
5. **Who has access: Anyone.** (Not "Anyone with Google account": teachers must not need to sign in.)
6. Click **Deploy**, then **Authorize access** and choose the account. If Google shows "Google hasn't verified this app", that's because you just wrote it: click **Advanced**, then **Go to CensorSearch reader (unsafe)**. The only permission it should ask for is to **see** your Google Sheets spreadsheets. If it asks to edit or delete them, `appsscript.json` wasn't replaced in step 1; fix that and deploy again.
7. Copy the **Web app URL**. It ends in `/exec`. That's the script's address.

## 4. Test it

Open the `/exec` address in a private (incognito) window, where you're not signed in. You should see text starting with `{"format":"censorsearch-v1"`, followed by your list's rows.

- `{"format":"censorsearch-v1","error":"…"}` means the script ran but couldn't read the sheet; the message says why (see the table below).
- A Google sign-in page means "Who has access" isn't "Anyone", or your admin doesn't allow it.
- Adding `?gid=0` to the address returns only that tab.

## 5. Point CensorSearch at it

Either:

- **Use a link (recommended):** open the CensorSearch page with `?script=` and the `/exec` address added, for example `https://<the CensorSearch page address>/?script=https://script.google.com/macros/s/…/exec`, then bookmark and share that link. The script's address stays out of the public code repository.
- **Or make it the default:** put the address in `scriptUrl` in `config.js` (`scriptUrl: 'https://script.google.com/macros/s/…/exec'`). The page then always reads through the script. Because the repository is public, this makes the list readable by anyone who finds the address there, not only by people with the page link. That matches v1's accepted "anyone with the link" access, but the `?script=` link keeps it narrower.

The page says which source it's reading and shows "N items · updated as of … · fetched hh:mm".

## Updating the script

When `Code.gs` changes in this repository:

1. Paste the new `Code.gs` over the old one and **Save**.
2. Click **Deploy**, then **Manage deployments**, select the deployment, click the pencil (**Edit**), set **Version: New version**, then **Deploy**.

This keeps the same `/exec` address. Don't use "New deployment" for an update: that creates a new address, and every link and `config.js` would need changing.

## Limits

- **Simultaneous use:** Google runs at most 30 Apps Script executions at the same time for one account, and every page load runs as the script's account, so all visitors share that limit. Each page load is one short run, so this matters only if very many people open the page in the same few seconds. Those who hit the limit see an error and can press Retry.
- **The lever, if that ever happens:** set `CACHE_SECONDS` to a number up to `300` (5 minutes; larger values are treated as 300). Google then keeps each answer for that many seconds and reuses it, so the page can be up to that far behind the sheet, and a copy of the mapped columns sits in Google's script cache for that long. Leave it out (no cache) unless you need it.
- **Speed:** besides reading the cells, the script asks the sheet whether each listed row is hidden or filtered, two small calls per row. That's the slowest part and it grows with the number of rows: fine for about 1,200 rows, where a page load takes a few seconds; `CACHE_SECONDS` also helps here.

## Moving to another account

The script belongs to the account that created it, and stops working when that account is removed or loses access to the sheet. To move it (do this before the staff change, not after):

1. Give the new account (ideally a school role account) Viewer access to the sheet.
2. Signed in as the new account, do steps 1 to 4 again. This gives a new `/exec` address.
3. Update the shared `?script=` link, or `scriptUrl` in `config.js`, to the new address.
4. In the old account, open the old project, **Deploy**, **Manage deployments**, and **Archive** the old deployment.

## If it doesn't work

| What you see | What to do |
| --- | --- |
| "The script is not set up yet: add SPREADSHEET_ID…" | Add the `SPREADSHEET_ID` script property (step 2). |
| "SPREADSHEET_ID … is not a spreadsheet id or link" | Copy the id again from the sheet's link. |
| "Can't open the spreadsheet…" | The id is wrong, or the script's account can't view the sheet: share the sheet with that account as Viewer. If both are right, Google may be refusing the read-only permission: in `appsscript.json` change `spreadsheets.readonly` to `spreadsheets`, save, and deploy a new version. The account's Viewer access still keeps the sheet safe from changes. |
| "No Title column in the first 10 rows of this tab…" | The header row moved below row 10, or its Title column was renamed; or `TABS` lists a tab that isn't a list. |
| "This tab is not available from this script." | The page asked for a tab that isn't in `TABS` (or is hidden). Add its id to `TABS`, or fix the page's tab setting. |
| "No tab with this id in the spreadsheet…" | A tab listed in `TABS` was deleted. Remove it from `TABS`. |
| A Google sign-in page instead of the list | Set "Who has access" to "Anyone" (Manage deployments, Edit). If "Anyone" isn't offered, see below. |

**Risk: the school's Workspace admin can turn off Apps Script,** or web apps open to "Anyone" (the second is reported by users, not documented by Google). If that happens, this reader can't work without sign-in. Ask the admin to allow it for the script's account; otherwise CensorSearch would need school sign-in, with the page served by Apps Script itself, which is planned for later, not v1.

## For developers: the response

`GET <exec URL>` returns every shared tab; `GET <exec URL>?gid=0,123` returns only those tabs (each must be one the script shares; others come back as entries in `errors`). Every other parameter is ignored, and there is no POST.

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
- `above` has one entry per row above the header: that row's non-empty cells.
- `lastColumn` is the last column with a header (it can be an unmapped one such as Status), for the row link's range.
- `raw` holds the exact ISBN as digits (and a final X) by value index, so `9.79889E+12` on screen still yields all 13 digits. `links` holds https links by value index, from cell links or `=HYPERLINK("https://…", …)`; any other link is dropped.
- `hidden` is true when the row is hidden by a user or by the sheet's filter.
- If nothing can be read: `{ "format": "censorsearch-v1", "error": "a plain message" }`, never a stack trace, id or email address.

`test/apps-script.test.js` runs `Code.gs` against a mocked, synthetic spreadsheet (`npm test`); its output is kept in `test/fixtures/script-response.json`.
