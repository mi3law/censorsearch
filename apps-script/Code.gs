/**
 * CensorSearch: read-only Apps Script fallback (see PRD.md, "Decision: two read paths").
 *
 * A standalone web app for a sheet that can't be shared by link. It opens one spreadsheet as the
 * account that deployed it and returns the ban-list columns (Title, Author, ISBN, Banned By, Type,
 * Year of Banning, Memo) as JSON for the CensorSearch page. Nothing else from the sheet is returned,
 * except the list's title and its "updated as of" line from above the header row.
 *
 * Read-only by construction: this file calls getters only (and the Sheets service's Spreadsheets.get for
 * the hidden-row flags), and its account should have Viewer access to the sheet. The manifest asks for
 * the spreadsheets scope because SpreadsheetApp.openById accepts no read-only scope. It writes no cell,
 * sheet, property or Drive file, logs nothing, and keeps nothing between requests unless CACHE_SECONDS is set.
 *
 * Script properties (Project Settings > Script properties); nothing is configured in this file:
 *   SPREADSHEET_ID  required. The id from the sheet link (…/spreadsheets/d/<this part>/edit), or the whole link.
 *   TABS            optional; recommended. Tab ids to serve, comma-separated (the number after gid= in the sheet
 *                   link), e.g. "0" or "0,1111920478". Hidden tabs are served only when listed here.
 *                   Default: the first tab that isn't hidden (the main tab), and no other.
 *   CACHE_SECONDS   optional. 0 (default) = no cache. 1 to 300 = keep each response in the script cache
 *                   for that many seconds. Only worth setting if the 30-simultaneous-runs quota is ever hit.
 *
 * GET <web app url>            -> every tab the script serves
 * GET <web app url>?gid=0,123  -> only those tabs (each must be one the script serves)
 * Every other parameter is ignored. There is no doPost. Deployment steps: apps-script/README.md.
 *
 * Response (format "censorsearch-v1"):
 *   { format, spreadsheetId, fetchedAt, tabs: [{ name, gid, hiddenTab, headerRow, above, headers, columns,
 *     lastColumn, rows: [{ row, values, raw, links, hidden }] }], errors: [{ tab, message }] }
 *   or, when nothing can be read: { format, error }.
 */

const FORMAT = 'censorsearch-v1';
const HEADER_SCAN_ROWS = 10;
const CACHE_MAX_SECONDS = 300;
const CACHE_CHUNK_BYTES = 100000;   // CacheService keeps at most 100 KB per value
const CACHE_MAX_CHUNKS = 60;
const MAX_REQUESTED_TABS = 20;
const MAX_LINK_LENGTH = 2048;

// Header mapping. Keep identical to FIELDS / HEADER_PATTERNS / foldHeader / mapHeaders in src/sheet.js
// (test/apps-script.test.js checks both map the same header rows the same way).
const FIELDS = ['title', 'author', 'isbn', 'bannedBy', 'type', 'year', 'memo'];
const HEADER_PATTERNS = {
  title: [/^title$/, /^titles$/, /^(book|item|material) title$/, /^title of (the )?(book|item|material)$/, /^materials?$/, /^name$/],
  author: [/^authors?$/, /^author names?$/, /^writers?$/],
  isbn: [/^isbn/],
  bannedBy: [/^banned ?by$/, /^banned$/],
  type: [/^type$/, /^material type$/, /^format$/, /^(media|item) type$/, /^type of material$/],
  year: [/^year of banning$/, /^year banned$/, /^year$/],
  memo: [/^memo$/, /^memos$/, /^memo link$/, /^notes?$/, /^links?$/],
};

/** Web app entry point. Always answers JSON; never a stack trace, id or email address in an error. */
function doGet(e) {
  let body;
  try {
    body = respond_(e && e.parameter ? e.parameter : {});
  } catch (err) {
    body = JSON.stringify({ format: FORMAT, error: plainMessage_(err) });
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function respond_(params) {
  const config = readConfig_();
  const errors = config.problems.slice();
  const requested = parseRequestedGids_(params.gid, errors);
  const cacheKey = config.cacheSeconds > 0 && errors.length === 0 ? cacheKey_(config, requested) : null;
  if (cacheKey) {
    const cached = cacheRead_(cacheKey);
    if (cached) return cached;
  }
  const out = readSpreadsheet_(config, requested, errors);
  const body = JSON.stringify(out);
  if (cacheKey && out.errors.length === 0) cacheWrite_(cacheKey, body, config.cacheSeconds);
  return body;
}

// ------------------------------------------------------------------------------------------------
// Configuration (Script properties, read only)

function readConfig_() {
  const props = PropertiesService.getScriptProperties();
  const problems = [];

  const rawId = String(props.getProperty('SPREADSHEET_ID') || '').trim();
  if (!rawId) throw userError_('The script is not set up yet: add SPREADSHEET_ID in Project Settings > Script properties.');
  const spreadsheetId = spreadsheetIdFrom_(rawId);
  if (!spreadsheetId) throw userError_('SPREADSHEET_ID in the script properties is not a spreadsheet id or link.');

  let tabs = null;
  const rawTabs = String(props.getProperty('TABS') || '').trim();
  if (rawTabs) {
    tabs = [];
    let invalid = false;
    rawTabs.split(/[,;\s]+/).forEach(part => {
      if (!part) return;
      const gid = normalizeGid_(part);
      if (gid == null) invalid = true;
      else if (tabs.indexOf(gid) === -1) tabs.push(gid);
    });
    if (invalid || !tabs.length) {
      problems.push({ tab: 'TABS', message: 'TABS in the script properties has an entry that is not a tab id (the number after gid= in the sheet link).' });
    }
  }

  const seconds = Number(String(props.getProperty('CACHE_SECONDS') || '').trim());
  const cacheSeconds = Number.isFinite(seconds) && seconds >= 1 ? Math.min(Math.floor(seconds), CACHE_MAX_SECONDS) : 0;

  return { spreadsheetId, tabs, cacheSeconds, problems };
}

/** Accepts a bare id or any Google Sheets link containing /d/<id>. */
function spreadsheetIdFrom_(text) {
  const inLink = /\/d\/([A-Za-z0-9_-]{20,128})(?:[\/?#]|$)/.exec(text);
  if (inLink) return inLink[1];
  return /^[A-Za-z0-9_-]{20,128}$/.test(text) ? text : null;
}

function normalizeGid_(text) {
  const s = String(text).trim();
  return /^\d{1,12}$/.test(s) ? s.replace(/^0+(?=\d)/, '') : null;
}

/** ?gid=0,123 -> ['0', '123']; absent or empty -> null (all tabs); only invalid entries -> [] plus an error. */
function parseRequestedGids_(value, errors) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const gids = [];
  let invalid = false;
  text.split(',').forEach(part => {
    if (!part.trim()) return;
    const gid = normalizeGid_(part);
    if (gid == null) invalid = true;
    else if (gids.indexOf(gid) === -1) gids.push(gid);
  });
  if (gids.length > MAX_REQUESTED_TABS) {
    gids.length = MAX_REQUESTED_TABS;
    invalid = true;
  }
  if (invalid) {
    errors.push({ tab: 'gid', message: 'The gid parameter takes up to ' + MAX_REQUESTED_TABS + ' tab ids (the number after gid= in the sheet link), separated by commas.' });
  }
  return gids.length || invalid ? gids : null;
}

// ------------------------------------------------------------------------------------------------
// Reading

function readSpreadsheet_(config, requested, errors) {
  let spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
  } catch (err) {
    if (/permission to call|required permissions/i.test(String(err && err.message))) {
      throw userError_("The script isn't allowed to open spreadsheets. Replace appsscript.json with the one from CensorSearch (it asks for the Google Sheets permission), save, then deploy a new version and authorize it.");
    }
    throw userError_("Can't open the spreadsheet. Check SPREADSHEET_ID in the script properties, and that the account running the script can view the sheet.");
  }
  const sheets = spreadsheet.getSheets();
  const byGid = {};
  sheets.forEach(sheet => { byGid[String(sheet.getSheetId())] = sheet; });

  // Allow-list: TABS in its order, else only the first tab that isn't hidden (v1 reads the main tab only,
  // like the link path's "first tab"). No other tab is served unless TABS names it.
  const firstVisible = sheets.find(sheet => !sheet.isSheetHidden());
  const allowed = config.tabs || (firstVisible ? [String(firstVisible.getSheetId())] : []);
  const tabs = [];

  (requested || allowed).forEach(gid => {
    if (allowed.indexOf(gid) === -1) {
      errors.push({ tab: 'gid ' + gid, message: 'This tab is not available from this script.' });
      return;
    }
    const sheet = byGid[gid];
    if (!sheet) {
      errors.push({ tab: 'gid ' + gid, message: 'No tab with this id in the spreadsheet. Check TABS in the script properties.' });
      return;
    }
    let name = 'gid ' + gid;
    try {
      name = String(sheet.getName());
      const tab = readTab_(sheet, name, gid, config.spreadsheetId);
      if (tab) tabs.push(tab);
      else errors.push({ tab: name, message: 'No Title column in the first 10 rows of this tab, so it can\'t be searched.' });
    } catch (err) {
      errors.push({ tab: name, message: 'Could not read this tab. Try again in a minute.' });
    }
  });

  if (!tabs.length && !errors.length) {
    errors.push({ tab: '', message: 'Every tab is hidden. Add the list\'s tab id to TABS in the script properties.' });
  }
  return { format: FORMAT, spreadsheetId: config.spreadsheetId, fetchedAt: new Date().toISOString(), tabs, errors };
}

/** Reads one tab, or returns null when its top 10 rows have no Title header. */
function readTab_(sheet, name, gid, spreadsheetId) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return null;

  const top = sheet.getRange(1, 1, Math.min(HEADER_SCAN_ROWS, lastRow), lastCol).getDisplayValues();
  const headerIndex = top.findIndex(cells => cells.some(isTitleHeader_));
  if (headerIndex < 0) return null;
  const headerCells = top[headerIndex].map(cell => cellText_(cell).trim());
  const mapping = mapHeaders_(headerCells);
  if (mapping.title < 0) return null;

  // Mapped columns in sheet order (0-based), and the table's extent (last non-empty header cell).
  const cols = FIELDS.map(field => mapping[field]).filter(i => i >= 0).sort((a, b) => a - b);
  let lastTableCol = 0;
  headerCells.forEach((cell, i) => { if (!isBlank_(cell)) lastTableCol = i; });
  const isbnPos = mapping.isbn >= 0 ? cols.indexOf(mapping.isbn) : -1;
  const headerRow = headerIndex + 1;

  const rows = [];
  const count = lastRow - headerRow;
  if (count > 0) {
    // One block from the first to the last mapped column, so each kind of value is one call.
    const first = cols[0];
    const block = sheet.getRange(headerRow + 1, first + 1, count, cols[cols.length - 1] - first + 1);
    const display = block.getDisplayValues();
    const rich = block.getRichTextValues();
    const formulas = block.getFormulas();
    const isbnValues = isbnPos >= 0 ? sheet.getRange(headerRow + 1, mapping.isbn + 1, count, 1).getValues() : null;
    fillMergedCells_(block.getMergedRanges(), headerRow + 1, first + 1, cols, [display, rich, formulas],
      isbnValues, mapping.isbn + 1);
    const hiddenFlags = hiddenRows_(spreadsheetId, name, headerRow + 1, count);

    for (let i = 0; i < count; i++) {
      const values = cols.map(c => cellText_(display[i][c - first]));
      if (values.every(isBlank_)) continue;
      const rowNumber = headerRow + 1 + i;

      const raw = {};
      if (isbnValues && !isBlank_(values[isbnPos])) {
        const digits = isbnRawText_(isbnValues[i][0]);
        if (digits) raw[String(isbnPos)] = digits;
      }
      const links = {};
      cols.forEach((c, k) => {
        if (isBlank_(values[k])) return;
        const url = linkFromRichText_(rich[i][c - first]) || linkFromFormula_(formulas[i][c - first]);
        if (url) links[String(k)] = url;
      });
      const hidden = hiddenFlags ? hiddenFlags[i] : null;

      rows.push({ row: rowNumber, values, raw, links, hidden });
    }
  }

  return {
    name,
    gid,
    hiddenTab: sheet.isSheetHidden() === true,
    headerRow,
    above: aboveHeader_(top.slice(0, headerIndex)),
    headers: cols.map(c => headerCells[c]),
    columns: cols.map(columnLetter_),
    lastColumn: columnLetter_(lastTableCol),
    rows,
  };
}

/**
 * The rows above the header, keeping only the two cells the page uses: the first cell mentioning "updated"
 * (the "updated as of" line) and the first other non-empty cell (the list's title), in their own rows. The
 * page picks them the same way (src/sheet.js). Anything else there, such as a note beside the title, stays in the sheet.
 */
function aboveHeader_(rows) {
  let updated = null;
  let banner = null;
  rows.forEach((cells, r) => cells.forEach((cell, c) => {
    if (isBlank_(cell)) return;
    if (updated == null && /updated/i.test(cellText_(cell))) updated = r + ':' + c;
    else if (banner == null) banner = r + ':' + c;
  }));
  return rows.map((cells, r) => cells.map(cellText_).filter((v, c) => r + ':' + c === updated || r + ':' + c === banner));
}

/**
 * Hidden flags (by a user or by the sheet's filter) for `count` rows from `firstRow`, in one Sheets API call
 * rather than two SpreadsheetApp calls per row. Returns null ("can't tell"; the page then shows no hidden label)
 * if the Sheets service is off or the call fails, for example over its per-minute read limit; a row the answer
 * doesn't cover is null too. The list itself still loads either way.
 */
function hiddenRows_(spreadsheetId, name, firstRow, count) {
  try {
    const range = "'" + name.replace(/'/g, "''") + "'!A" + firstRow + ':A' + (firstRow + count - 1);
    const res = Sheets.Spreadsheets.get(spreadsheetId, {
      ranges: [range],
      fields: 'sheets(data(startRow,rowMetadata(hiddenByUser,hiddenByFilter)))',
    });
    const data = res.sheets[0].data[0];
    if ((data.startRow || 0) !== firstRow - 1) return null;   // 0-based, and left out when 0
    const meta = data.rowMetadata || [];
    const flags = [];
    for (let i = 0; i < count; i++) {
      flags.push(meta[i] ? meta[i].hiddenByUser === true || meta[i].hiddenByFilter === true : null);
    }
    return flags;
  } catch (err) {
    return null;
  }
}

/**
 * A merged cell's value sits in its top-left cell only. For merges that start on a data row in a mapped
 * column, copy the top-left value down to every row the merge covers (in that column; a merge that also
 * spans columns to the right, like a full-width heading, still belongs to its first column).
 */
function fillMergedCells_(merges, firstRow, firstCol, cols, grids, isbnValues, isbnCol) {
  (merges || []).forEach(merge => {
    const top = merge.getRow();
    const col = merge.getColumn();
    const height = merge.getNumRows();
    if (height < 2 || top < firstRow || cols.indexOf(col - 1) === -1) return;
    const i0 = top - firstRow;
    const j = col - firstCol;
    const end = Math.min(i0 + height, grids[0].length);
    for (let i = i0 + 1; i < end; i++) {
      grids.forEach(grid => { grid[i][j] = grid[i0][j]; });
      if (isbnValues && col === isbnCol) isbnValues[i][0] = isbnValues[i0][0];
    }
  });
}

// ------------------------------------------------------------------------------------------------
// Cell helpers

function cellText_(v) {
  return v == null ? '' : typeof v === 'string' ? v : String(v);
}

/** Blank = only whitespace or invisible characters (NBSP, zero-width space/joiners, BOM), as in src/sheet.js. */
function isBlank_(v) {
  return cellText_(v).replace(/[\s​-‍⁠﻿]/g, '') === '';
}

function foldHeader_(s) {
  return cellText_(s).normalize('NFKC').toLowerCase().replace(/\(s\)/g, 's').replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function isTitleHeader_(cell) {
  const f = foldHeader_(cell);
  return !!f && HEADER_PATTERNS.title.some(re => re.test(f));
}

/** { title, author, isbn, bannedBy, type, year, memo } -> column index or -1. Per field, patterns in priority order. */
function mapHeaders_(headers) {
  const mapping = {};
  const folded = headers.map(foldHeader_);
  const used = {};
  FIELDS.forEach(field => {
    mapping[field] = -1;
    for (let p = 0; p < HEADER_PATTERNS[field].length; p++) {
      const re = HEADER_PATTERNS[field][p];
      const idx = folded.findIndex((h, i) => h && !used[i] && re.test(h));
      if (idx >= 0) {
        mapping[field] = idx;
        used[idx] = true;
        break;
      }
    }
  });
  return mapping;
}

function columnLetter_(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Exact ISBN as digits (and a final X): numbers via toFixed(0), text with spaces, hyphens and an "ISBN" label removed.
 * Only one whole ISBN (9 digits with a lost leading 0, 10 with a final digit or X, or 13) is returned. Anything else,
 * such as two ISBNs on two lines, gives '' so the page reads the displayed cell, which it splits into each ISBN.
 */
function isbnRawText_(value) {
  let s = '';
  if (typeof value === 'number') {
    s = Number.isInteger(value) && value >= 0 && value < 1e21 ? value.toFixed(0) : '';
  } else if (typeof value === 'string') {
    s = value.replace(/[\s ‐-―-]+/g, '').toUpperCase().replace(/^ISBN(?:1[03])?:?/, '');
  }
  return /^(?:\d{9}|\d{9}[\dX]|\d{13})$/.test(s) ? s : '';
}

/** A link on the whole cell, else the first https link on part of its text. */
function linkFromRichText_(rich) {
  if (!rich) return null;   // numbers and dates have no rich text value
  const whole = httpsOnly_(rich.getLinkUrl());
  if (whole) return whole;
  const runs = rich.getRuns() || [];
  for (let i = 0; i < runs.length; i++) {
    const url = httpsOnly_(runs[i].getLinkUrl());
    if (url) return url;
  }
  return null;
}

/** =HYPERLINK("https://…", "label") (either argument separator); a cell reference as the URL is not followed. */
function linkFromFormula_(formula) {
  if (!formula) return null;
  const m = /HYPERLINK\s*\(\s*"((?:[^"]|"")*)"/i.exec(String(formula));
  return m ? httpsOnly_(m[1].replace(/""/g, '"')) : null;
}

/** Keeps a link only if it is a plain https URL; javascript:, data:, http: and anything odd are dropped. */
function httpsOnly_(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (!u || u.length > MAX_LINK_LENGTH) return null;
  if (!/^https:\/\/[^\/?#\s@:]+(?::\d+)?(?:[\/?#]|$)/i.test(u)) return null;
  if (/[\s"<>\\`\u0000-\u001f\u007f]/.test(u)) return null;
  return u;
}

// ------------------------------------------------------------------------------------------------
// Errors

function userError_(message) {
  const err = new Error(message);
  err.censorsearchPlain = true;
  return err;
}

/** Only messages written in this file reach the page; anything Google throws becomes a generic line. */
function plainMessage_(err) {
  if (err && err.censorsearchPlain) return err.message;
  return 'The script could not read the sheet. Try again in a minute; if it keeps failing, ask the person who set up the script.';
}

// ------------------------------------------------------------------------------------------------
// Optional cache (CACHE_SECONDS > 0 only). Values are chunked to stay under the 100 KB per-value limit;
// a head entry "<chunks>:<token>" is written last so a reader never mixes chunks of two responses.

function cacheKey_(config, requested) {
  const basis = [FORMAT, config.spreadsheetId, config.tabs ? config.tabs.join(',') : '*', requested ? requested.join(',') : '*'].join('|');
  return 'censorsearch:' + hash32_(basis, 0x811c9dc5) + hash32_(basis, 0x01000193);
}

function hash32_(s, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function cacheRead_(key) {
  try {
    const cache = CacheService.getScriptCache();
    const head = /^(\d+):([a-z0-9]+)$/.exec(cache.get(key) || '');
    if (!head) return null;
    const n = Number(head[1]);
    if (n < 1 || n > CACHE_MAX_CHUNKS) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(key + ':' + head[2] + ':' + i);
    const parts = cache.getAll(keys) || {};
    let body = '';
    for (let i = 0; i < keys.length; i++) {
      if (typeof parts[keys[i]] !== 'string') return null;
      body += parts[keys[i]];
    }
    return body;
  } catch (err) {
    return null;
  }
}

function cacheWrite_(key, body, seconds) {
  try {
    const chunks = splitForCache_(body);
    if (chunks.length > CACHE_MAX_CHUNKS) return;
    const token = Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
    const entries = {};
    chunks.forEach((chunk, i) => { entries[key + ':' + token + ':' + i] = chunk; });
    const cache = CacheService.getScriptCache();
    cache.putAll(entries, seconds);
    cache.put(key, chunks.length + ':' + token, seconds);
  } catch (err) {
    // Serving the response matters more than caching it.
  }
}

/** Splits text into pieces of at most CACHE_CHUNK_BYTES of UTF-8, never inside a surrogate pair. */
function splitForCache_(s) {
  const chunks = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < s.length;
    const size = pair ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (bytes + size > CACHE_CHUNK_BYTES) {
      chunks.push(s.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
    if (pair) i++;
  }
  chunks.push(s.slice(start));
  return chunks;
}
