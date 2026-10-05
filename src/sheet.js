// CensorSheet: reads a banned-materials Google Sheet (CSV export by link, the read-only Apps Script fallback, or the
// Google Sheets API with the visitor's own sign-in) and turns it into Row objects for the search engine. See PRD.md
// "Data source and architecture" and "Sheet structure and data access". No dependencies; works in the browser
// (window.CensorSheet) and Node.
//
// Every cell value stays the string the sheet displays. Nothing here renders HTML: callers must show cell
// text with textContent. Only https links ever reach memoUrl/titleUrl.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CensorSheet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------------------------
  // Messages shown to teachers (plain words; the app displays them as text).
  const MSG = {
    csvNetwork: "Can't read this sheet: it may not be shared by link, or a network filter may block Google",
    csvHtml: 'Got a web page instead of the list: the sheet may not be shared by link.',
    scriptNetwork: "Can't reach the sheet's script: it may not be deployed for Anyone, or a network filter may block Google",
    scriptHtml: 'Got a web page instead of the list: the script may not be deployed for Anyone.',
    scriptJson: "The script's reply couldn't be read as the list.",
    scriptFormat: "The script's reply isn't in the expected format (censorsearch-v1).",
    scriptBadUrl: "This isn't an Apps Script web app link (https://script.google.com/macros/s/…/exec).",
    scriptMissingTab: "The script didn't return this tab.",
    badSheetId: "This isn't a Google Sheets link.",
    noHeader: "No Title column in the first 10 rows of this tab, so it can't be searched.",
    timeout: 'Reading the sheet took too long: the connection may be slow, or a network filter may block Google',
    apiNetwork: "Can't reach Google's Sheets service: a network filter may block it",
    apiJson: "Google's answer couldn't be read as the list.",
    apiSignIn: 'Sign in with Google to read the list.',
    apiExpired: 'Your Google sign-in has run out. Sign in again.',
    apiScope: "Your Google sign-in didn't give this page permission to see the sheet. Sign in again and allow it.",
    apiAccess: "The Google account you signed in with can't view this sheet.",
    apiDisabled: "The Google Sheets API is turned off in this page's Google Cloud project, so the list can't be read. A list maintainer needs to turn it on.",
    apiNotFound: 'Google answered with an error (HTTP 404): no spreadsheet has this id. Check the sheet link.',
    apiNoTab: 'No tab with this id in the spreadsheet.',
  };

  const DEFAULT_TIMEOUT_MS = 30000;
  const HEADER_SCAN_ROWS = 10;
  const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,128}$/;
  const BARE_ID_RE = /^[A-Za-z0-9_-]{30,128}$/;
  const GID_RE = /^\d{1,12}$/;
  const COL_RE = /^[A-Z]{1,3}$/;

  // ---------------------------------------------------------------------------------------------
  // Small helpers

  const str = v => (v == null ? '' : typeof v === 'string' ? v : String(v));
  // Blank = only whitespace or invisible characters (NBSP, zero-width space/joiners, BOM).
  const isBlank = v => str(v).replace(/[\s​-‍⁠﻿]/g, '') === '';

  function colLetter(i) {
    let n = i + 1, s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  // Optimal string alignment distance with an early exit once it exceeds k.
  function osa(a, b, k) {
    const n = a.length, m = b.length;
    if (Math.abs(n - m) > k) return k + 1;
    let pp = null, p = new Array(m + 1), c = new Array(m + 1);
    for (let j = 0; j <= m; j++) p[j] = j;
    for (let i = 1; i <= n; i++) {
      c[0] = i; let rowMin = i;
      for (let j = 1; j <= m; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + cost);
        if (pp && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, pp[j - 2] + 1);
        c[j] = v; if (v < rowMin) rowMin = v;
      }
      if (rowMin > k) return k + 1;
      const t = pp || new Array(m + 1); pp = p; p = c; c = t;
    }
    return p[m];
  }

  // Only https links survive; anything else (javascript:, data:, http:, relative, garbage) becomes null.
  function safeHttpsUrl(u) {
    if (typeof u !== 'string' || !u.trim()) return null;
    let url;
    try { url = new URL(u.trim()); } catch (e) { return null; }
    if (url.protocol !== 'https:' || !url.hostname) return null;
    return url.href;
  }

  // ---------------------------------------------------------------------------------------------
  // URLs

  function parseSheetUrl(link) {
    if (typeof link !== 'string') return null;
    let s = link.trim();
    if (!s) return null;
    if (BARE_ID_RE.test(s)) return { id: s, gid: null };
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;           // "docs.google.com/spreadsheets/d/…"
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.hostname !== 'docs.google.com' || u.username || u.password) return null;
    const m = u.pathname.match(/^\/spreadsheets(?:\/u\/\d+)?\/d\/([^/]+)(?:\/|$)/);
    if (!m || m[1] === 'e' || !SHEET_ID_RE.test(m[1])) return null;     // /d/e/2PACX… is a publish id, not a sheet id
    const fromHash = new URLSearchParams(u.hash.replace(/^#/, '')).get('gid');
    const fromQuery = u.searchParams.get('gid');
    const gid = [fromHash, fromQuery].find(g => g != null && GID_RE.test(g)) || null;
    return { id: m[1], gid };
  }

  const gidOr0 = gid => (gid != null && GID_RE.test(str(gid)) ? str(gid) : '0');
  // '' stands for "the first tab, id unknown" (a link without a gid): Google exports the first tab when gid is left out.
  const gidOrFirst = gid => (gid != null && GID_RE.test(str(gid)) ? str(gid) : '');
  const base = id => 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(str(id));

  function csvUrl(id, gid) {
    const g = gidOrFirst(gid);
    return base(id) + '/export?format=csv' + (g ? '&gid=' + g : '');
  }

  function sheetUrl(id, gid) {
    const g = gidOrFirst(gid);
    return g ? base(id) + '/edit?gid=' + g + '#gid=' + g : base(id) + '/edit';
  }

  // Google ignores a range without a gid, so a row of a tab whose id is unknown links to the sheet itself.
  function rowUrl(id, gid, row, lastCol) {
    const g = gidOrFirst(gid);
    if (!g) return base(id) + '/edit';
    const col = COL_RE.test(str(lastCol)) ? str(lastCol) : 'G';
    const r = Math.max(1, Math.floor(Number(row)) || 1);
    return base(id) + '/edit?gid=' + g + '#gid=' + g + '&range=A' + r + ':' + col + r;
  }

  function parseScriptUrl(u) {
    if (typeof u !== 'string') return null;
    let url;
    try { url = new URL(u.trim()); } catch (e) { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') return null;
    if (url.username || url.password || url.port) return null;
    const m = url.pathname.match(/^\/(?:macros|a\/macros\/[A-Za-z0-9.-]+)\/s\/([A-Za-z0-9_-]{10,200})\/exec\/?$/);
    return m ? 'https://script.google.com/macros/s/' + m[1] + '/exec' : null;
  }

  // Google: attachment; filename="Doc-Tab.csv"; filename*=UTF-8''Doc%20title%20-%20Tab%20name.csv
  // The whole file name, decoded (filename* when it can be decoded, else filename), or null.
  function fileNameFromDisposition(headerValue) {
    const h = str(headerValue);
    if (!h) return null;
    let name = null;
    const star = h.match(/filename\*\s*=\s*([^;]+)/i);
    if (star) {
      const v = star[1].trim().replace(/^"|"$/g, '');
      const mm = v.match(/^([A-Za-z0-9!#$&+^`{}~-]+)'[^']*'(.*)$/);   // charset'lang'pct-encoded
      try { name = decodeURIComponent(mm ? mm[2] : v); } catch (e) { name = null; }
    }
    const fromStar = name != null;
    if (name == null) {
      const plain = h.match(/filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i);
      if (plain) name = (plain[1] != null ? plain[1].replace(/\\(.)/g, '$1') : plain[2]).trim();
    }
    return name ? { name, fromStar } : null;
  }

  // The tab name is the part after the LAST " - ". (A tab whose own name contains " - " is cut; configure its name.)
  // For display only: two tabs can share that part ("Ministry - 2024", "School - 2024"), so never use it to tell tabs apart.
  function tabNameFromDisposition(headerValue) {
    const file = fileNameFromDisposition(headerValue);
    if (!file) return null;
    const fromStar = file.fromStar;
    let name = file.name.replace(/\.csv$/i, '');
    const i = name.lastIndexOf(' - ');
    if (i >= 0) name = name.slice(i + 3);
    else if (!fromStar) return null;          // the ASCII filename= drops spaces ("Doc-OtherMaterials"): not trustworthy
    name = name.trim();
    return name || null;
  }

  // ---------------------------------------------------------------------------------------------
  // CSV (RFC 4180). Quoted fields may hold commas, doubled quotes, CR and LF. Records end at CRLF, LF or a lone CR.
  // Empty lines are kept as [''] so record index + 1 = sheet row. A final line break does not add a record.

  function parseCsv(text) {
    let s = str(text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const rows = [];
    const n = s.length;
    if (n === 0) return rows;
    let row = [], field = '', i = 0, quoted = false;
    while (i < n) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"' && field === '') { quoted = true; i++; continue; }  // only at the start of a field
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
        i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      field += ch; i++;           // includes a stray quote inside an unquoted field, or text after a closing quote
    }
    const last = s[n - 1];
    if (quoted || !(last === '\n' || last === '\r') || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function tableFromCsv(grid, opts) {
    const o = opts || {};
    const records = (grid || []).map((cells, i) => ({
      row: i + 1, cells: (cells || []).map(str), hidden: null, links: {}, isbnRaw: {},
    }));
    return { tab: str(o.tab) || 'Sheet', gid: gidOrFirst(o.gid), sheetId: str(o.sheetId), records, hiddenKnown: false };
  }

  // ---------------------------------------------------------------------------------------------
  // Header mapping

  const FIELDS = ['title', 'author', 'isbn', 'bannedBy', 'type', 'year', 'memo'];
  // Per field, patterns in priority order: "Title" beats "Name" wherever the columns sit.
  const HEADER_PATTERNS = {
    title: [/^title$/, /^titles$/, /^(book|item|material) title$/, /^title of (the )?(book|item|material)$/, /^materials?$/, /^name$/],
    author: [/^authors?$/, /^author names?$/, /^writers?$/],
    isbn: [/^isbn/],
    bannedBy: [/^banned ?by$/, /^banned$/],
    type: [/^type$/, /^material type$/, /^format$/, /^(media|item) type$/, /^type of material$/],
    year: [/^year of banning$/, /^year banned$/, /^year$/],
    memo: [/^memo$/, /^memos$/, /^memo link$/, /^notes?$/, /^links?$/],
  };

  function foldHeader(s) {
    return str(s).normalize('NFKC').toLowerCase().replace(/\(s\)/g, 's').replace(/['’`]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function headerField(h) {
    const f = foldHeader(h);
    if (!f) return null;
    for (const field of FIELDS) if (HEADER_PATTERNS[field].some(re => re.test(f))) return field;
    return null;
  }

  function isTitleHeader(h) { const f = foldHeader(h); return !!f && HEADER_PATTERNS.title.some(re => re.test(f)); }

  function mapHeaders(headers) {
    const mapping = {}; FIELDS.forEach(f => { mapping[f] = -1; });
    const folded = headers.map(foldHeader);
    const used = new Set();
    for (const field of FIELDS) {
      for (const re of HEADER_PATTERNS[field]) {
        const idx = folded.findIndex((h, i) => h && !used.has(i) && re.test(h));
        if (idx >= 0) { mapping[field] = idx; used.add(idx); break; }
      }
    }
    return mapping;
  }

  function sheetError(kind, message) { const e = new Error(message); e.kind = kind; return e; }

  // ---------------------------------------------------------------------------------------------
  // Banned By status

  const BB_SPLIT = /[\/,;&+\r\n]|\band\b/i;
  const BB_PLACEHOLDER = /^(?:-+|—|–|\?+|n\/?a|none|unknown|tbd|tbc)$/i;

  const foldCode = s => str(s).normalize('NFKC').toLowerCase().replace(/[.'’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // "When in doubt, show the more severe status": one edit of "ministry" (two for 8+ letters), any word starting
  // "minist" (Ministries, Minister), MOE (also spelled out "M O E"), and a dotted abbreviation such as "Min.".
  const isMinistryWord = w => {
    if (w === 'moe' || w.startsWith('minist')) return true;
    const k = w.length >= 8 ? 2 : 1;
    return w.length >= 7 && w.length <= 10 && osa(w, 'ministry', k) <= k;
  };
  const isMinistryPart = (raw, folded, words) => isMinistryWord(folded) || words.some(isMinistryWord) ||
    /^min(?:s|is|ist)?\.$/i.test(raw) || (words.length === 3 && words.every(w => w.length === 1) && words.join('') === 'moe');

  function parseBannedBy(text, opts) {
    const schoolCode = opts && opts.schoolCode != null ? str(opts.schoolCode).trim() : 'UAS';
    const blank = { level: 'blank', label: 'Status not stated, open the row', codes: [] };
    const s = str(text);
    if (isBlank(s) || BB_PLACEHOLDER.test(s.trim())) return blank;
    const parts = s.split(BB_SPLIT).map(p => p.replace(/\s+/g, ' ').trim()).filter(p => /[\p{L}\p{N}]/u.test(p));
    if (!parts.length) return blank;
    const school = foldCode(schoolCode);
    const codes = [], seen = new Set();
    let ministry = false, isSchool = false;
    for (const p of parts) {
      const f = foldCode(p), words = f.split(' ').filter(Boolean);
      let code;
      if (isMinistryPart(p, f, words)) { code = 'Ministry'; ministry = true; }
      else if (school && (f === school || words.includes(school))) { code = schoolCode; isSchool = true; }
      else code = /^\p{L}{1,6}$/u.test(p) ? p.toUpperCase() : p;
      const key = code.toLowerCase();
      if (!seen.has(key)) { seen.add(key); codes.push(code); }
    }
    if (ministry) return { level: 'ministry', label: 'Must remove (Ministry)', codes };
    if (isSchool) return { level: 'uas', label: 'Banned by ' + schoolCode, codes };
    return { level: 'other', label: 'Check case by case (' + codes.join(', ') + ')', codes };
  }

  // ---------------------------------------------------------------------------------------------
  // Rows

  const foldFp = v => str(v).normalize('NFKC').toLowerCase().replace(/[\s​-‍⁠﻿]+/g, ' ').trim();
  function fingerprint(row) {
    const r = row || {};
    return [r.title, r.author, r.bannedBy, r.year].map(foldFp).join('\u001f');
  }

  const PASTE_RESIDUE = /\+[0-9A-Za-z:]*:[0-9A-Za-z:]*\s*$/;
  const HEADING_TEXT = new RegExp([
    '\\b(?:19|20)\\d{2}\\s*[-–—/]\\s*(?:19|20)?\\d{2}\\b',                               // 2024-2025, 2024/25
    '\\b(?:additions?|added|section|continued)\\b',
    '\\b(?:older|newer|new|other|earlier|later|more)\\s+(?:items|titles|books|materials|listings)\\b',
    ':\\s*$',
  ].join('|'), 'i');
  const ISBN_SCIENTIFIC = /^\s*[0-9](?:[.,][0-9]+)?e\+?[0-9]+\s*$/i;

  function extractRows(table, opts) {
    const schoolCode = opts && opts.schoolCode != null ? opts.schoolCode : 'UAS';
    const t = table || {};
    const tab = str(t.tab) || 'Sheet', gid = gidOrFirst(t.gid), sheetId = str(t.sheetId);
    const records = Array.isArray(t.records) ? t.records : [];
    const issues = [];
    const issue = (row, kind, message) => issues.push({ tab, row, kind, message });

    // 1. Header row: the given one (Apps Script), else the first of the top 10 rows with a Title-like cell.
    let hIdx = -1;
    if (t.headerRow != null) hIdx = records.findIndex(r => r.row === t.headerRow && (r.cells || []).some(isTitleHeader));
    if (hIdx < 0) hIdx = records.findIndex(r => r.row <= HEADER_SCAN_ROWS && (r.cells || []).some(isTitleHeader));
    if (hIdx < 0) throw sheetError('format', MSG.noHeader);
    const header = records[hIdx];
    const headers = (header.cells || []).map(h => str(h).trim());
    const mapping = mapHeaders(headers);
    if (mapping.title < 0) throw sheetError('format', MSG.noHeader);
    const tableCols = [];
    headers.forEach((h, i) => { if (!isBlank(h)) tableCols.push(i); });   // empty-header columns (the notes box) are ignored
    const mappedCols = new Set(FIELDS.map(f => mapping[f]).filter(i => i >= 0));
    const extraCols = tableCols.filter(i => !mappedCols.has(i));
    const letters = Array.isArray(t.columnLetters) ? t.columnLetters : null;
    const letterOf = i => (letters && COL_RE.test(str(letters[i])) ? str(letters[i]) : colLetter(i));
    const lastCol = COL_RE.test(str(t.lastCol)) ? str(t.lastCol) : letterOf(tableCols[tableCols.length - 1]);

    // 2. Banner rows above the header.
    let updatedAsOf = null, bannerTitle = null;
    for (const r of records.slice(0, hIdx)) {
      for (const c of r.cells || []) {
        if (isBlank(c)) continue;
        const v = str(c).trim();
        if (updatedAsOf == null && /updated/i.test(v)) updatedAsOf = v;
        else if (bannerTitle == null) bannerTitle = v;
      }
    }
    if (mapping.author < 0) issue(header.row, 'missingColumn', 'No Author column found; only titles and the other mapped columns are searched.');

    // 3. Classify data rows.
    const cell = (rec, i) => (i >= 0 ? str((rec.cells || [])[i]) : '');
    const headerLike = rec => {
      if (!isTitleHeader(cell(rec, mapping.title))) return false;
      return tableCols.every(i => {
        const v = cell(rec, i);
        if (isBlank(v)) return true;
        const field = FIELDS.find(f => mapping[f] === i);
        return foldHeader(v) === foldHeader(headers[i]) || (field != null && headerField(v) === field);
      });
    };
    const candidates = [];
    for (const rec of records.slice(hIdx + 1)) {
      if (['title', 'author', 'isbn'].every(f => isBlank(cell(rec, mapping[f])))) continue;   // empty or formatted-only row
      if (headerLike(rec)) { issue(rec.row, 'repeatedHeader', 'Repeated header row skipped.'); continue; }
      candidates.push(rec);
    }
    const withBannedBy = mapping.bannedBy >= 0 ? candidates.filter(r => !isBlank(cell(r, mapping.bannedBy))).length : 0;
    const headingsPossible = mapping.bannedBy >= 0 && withBannedBy * 2 > candidates.length;
    // A heading is a row with only Title filled that also reads like one: its text repeated across the row (a merged
    // heading on the Apps Script path), a year range, words like "additions", or a closing colon. Any other title-only
    // row stays an item, with "Status not stated": CSV can't see merged cells, and a missed item is worse than an extra one.
    const isHeading = rec => {
      const title = cell(rec, mapping.title);
      if (isBlank(title)) return false;
      const tt = title.trim();
      const others = tableCols.filter(i => i !== mapping.title && !isBlank(cell(rec, i)));
      if (!others.every(i => cell(rec, i).trim() === tt)) return false;
      return others.length > 0 || HEADING_TEXT.test(tt);
    };

    const rows = [];
    let section = null;
    for (const rec of candidates) {
      if (headingsPossible && isHeading(rec)) {
        section = cell(rec, mapping.title).trim();
        issue(rec.row, 'sectionHeading', 'Treated as a section heading, not an item: "' + section + '".');
        continue;
      }
      const v = {}; FIELDS.forEach(f => { v[f] = cell(rec, mapping[f]); });
      if (PASTE_RESIDUE.test(v.title)) {
        const m = v.title.match(PASTE_RESIDUE);
        issue(rec.row, 'pasteResidue', 'Title ends with pasted characters "' + m[0].trim() + '"; shown as written but not searched.');
      }
      if (ISBN_SCIENTIFIC.test(v.isbn)) {
        issue(rec.row, 'isbnScientific', 'ISBN shows as "' + v.isbn.trim() + '" (scientific format), so its digits are lost and it is not searched. Format the ISBN column as plain text.');
      }
      const links = rec.links || {}, raw = rec.isbnRaw || {};
      const isbnRawVal = mapping.isbn >= 0 ? str(raw[mapping.isbn]) : '';
      const row = {
        id: null, tab, gid, sheetId, row: rec.row,
        title: v.title, author: v.author, isbn: v.isbn, bannedBy: v.bannedBy, type: v.type, year: v.year, memo: v.memo,
        isbnRaw: /^(?:\d{9}|\d{9}[0-9Xx]|\d{13})$/.test(isbnRawVal) ? isbnRawVal : '',   // one complete ISBN only; else the cell text is parsed
        memoUrl: mapping.memo >= 0 ? safeHttpsUrl(links[mapping.memo]) : null,
        titleUrl: safeHttpsUrl(links[mapping.title]),
        hidden: typeof rec.hidden === 'boolean' ? rec.hidden : null,
        section,
        extra: extraCols.filter(i => !isBlank(cell(rec, i))).map(i => ({ header: headers[i], value: cell(rec, i) })),
        status: parseBannedBy(v.bannedBy, { schoolCode }),
        fingerprint: '',
        lastCol,
      };
      row.fingerprint = fingerprint(row);
      rows.push(row);
    }
    if (!rows.length) issue(header.row, 'emptyTab', 'No items found below the header row.');

    const meta = {
      tab, gid, sheetId, headerRow: header.row, headers, mapping, updatedAsOf, bannerTitle,
      rowCount: rows.length, lastCol, hiddenKnown: !!t.hiddenKnown,
    };
    if (typeof t.hiddenTab === 'boolean') meta.hiddenTab = t.hiddenTab;
    return { rows, meta, issues };
  }

  // ---------------------------------------------------------------------------------------------
  // Apps Script JSON -> Tables

  function tablesFromScript(json) {
    const fmt = message => ({ tables: [], errors: [{ tab: null, message, kind: 'format' }], sheetId: null });
    if (!json || typeof json !== 'object' || Array.isArray(json)) return fmt(MSG.scriptJson);
    if (json.format !== 'censorsearch-v1') return fmt(MSG.scriptFormat);
    const sheetId = SHEET_ID_RE.test(str(json.spreadsheetId)) ? str(json.spreadsheetId) : null;
    const errors = [];
    if (json.error != null) {
      errors.push({ tab: null, message: str(json.error) || 'The script could not read the sheet.', kind: 'script' });
      return { tables: [], errors, sheetId };
    }
    for (const e of Array.isArray(json.errors) ? json.errors : []) {
      if (!e || typeof e !== 'object') continue;
      errors.push({ tab: e.tab == null ? null : str(e.tab), message: str(e.message) || 'The script could not read this tab.', kind: 'script' });
    }
    const tables = [];
    for (const t of Array.isArray(json.tabs) ? json.tabs : []) {
      if (!t || typeof t !== 'object') continue;
      const headers = (Array.isArray(t.headers) ? t.headers : []).map(str);
      const above = (Array.isArray(t.above) ? t.above : []).map(r => (Array.isArray(r) ? r.map(str) : [str(r)]));
      const headerRow = Number.isInteger(t.headerRow) && t.headerRow >= 1 ? t.headerRow : above.length + 1;
      const columns = (Array.isArray(t.columns) ? t.columns : []).map(str);
      const records = [];
      above.slice(0, headerRow - 1).forEach((cells, i) => records.push({ row: i + 1, cells, hidden: null, links: {}, isbnRaw: {} }));
      records.push({ row: headerRow, cells: headers.slice(), hidden: null, links: {}, isbnRaw: {} });
      for (const r of Array.isArray(t.rows) ? t.rows : []) {
        if (!r || typeof r !== 'object' || !Number.isInteger(r.row) || r.row <= headerRow) continue;
        const cells = (Array.isArray(r.values) ? r.values : []).map(str);
        while (cells.length < headers.length) cells.push('');
        const links = {}, isbnRaw = {};
        if (r.links && typeof r.links === 'object') {
          for (const k of Object.keys(r.links)) { const u = safeHttpsUrl(r.links[k]); if (u && /^\d+$/.test(k)) links[+k] = u; }
        }
        if (r.raw && typeof r.raw === 'object') {
          for (const k of Object.keys(r.raw)) {
            const v = r.raw[k];
            const s = typeof v === 'number' && Number.isInteger(v) ? v.toFixed(0) : str(v).trim();
            if (/^\d+$/.test(k) && /^[0-9Xx]+$/.test(s)) isbnRaw[+k] = s;
          }
        }
        records.push({ row: r.row, cells, hidden: typeof r.hidden === 'boolean' ? r.hidden : null, links, isbnRaw });
      }
      const table = {
        tab: str(t.name) || 'Sheet', gid: gidOr0(t.gid), sheetId: sheetId || '', records,
        columnLetters: columns.length ? columns : undefined, headerRow, hiddenKnown: true,
      };
      if (COL_RE.test(str(t.lastColumn))) table.lastCol = str(t.lastColumn);
      if (typeof t.hiddenTab === 'boolean') table.hiddenTab = t.hiddenTab;
      tables.push(table);
    }
    return { tables, errors, sheetId };
  }

  // ---------------------------------------------------------------------------------------------
  // Google Sheets API grid data -> Tables

  // Exact ISBN digits (and a final X), as the Apps Script's isbnRawText_: a whole number as written out, or text without
  // spaces, hyphens and an "ISBN" label. Only one whole ISBN (9, 10 or 13 characters) counts.
  function isbnDigits(number, text) {
    let s = '';
    if (typeof number === 'number') s = Number.isInteger(number) && number >= 0 && number < 1e21 ? number.toFixed(0) : '';
    else s = str(text).replace(/[\s ‐-―-]+/g, '').toUpperCase().replace(/^ISBN(?:1[03])?:?/, '');
    return /^(?:\d{9}|\d{9}[\dX]|\d{13})$/.test(s) ? s : '';
  }

  // A link on the whole cell (or from =HYPERLINK), else the first https link on part of its text.
  function cellLink(v) {
    if (!v || typeof v !== 'object') return null;
    const whole = safeHttpsUrl(v.hyperlink);
    if (whole) return whole;
    for (const run of Array.isArray(v.textFormatRuns) ? v.textFormatRuns : []) {
      const u = run && run.format && run.format.link ? safeHttpsUrl(run.format.link.uri) : null;
      if (u) return u;
    }
    const f = v.userEnteredValue && typeof v.userEnteredValue.formulaValue === 'string' ? v.userEnteredValue.formulaValue : '';
    const m = /HYPERLINK\s*\(\s*"((?:[^"]|"")*)"/i.exec(f);
    return m ? safeHttpsUrl(m[1].replace(/""/g, '"')) : null;
  }

  // One sheet of a spreadsheets.get answer with grid data -> the table extractRows reads: every cell as displayed, its
  // https link, exact ISBN digits, and the row's hidden flag (by a user or by the sheet's filter). As on the Apps Script
  // path, a merged cell's value is copied down to every row the merge covers (in its first column), below the header.
  function tableFromGrid(sheet, opts) {
    const o = opts || {};
    const data = sheet && Array.isArray(sheet.data) && sheet.data[0] && typeof sheet.data[0] === 'object' ? sheet.data[0] : {};
    const row0 = Math.max(0, Math.floor(Number(data.startRow)) || 0), col0 = Math.max(0, Math.floor(Number(data.startColumn)) || 0);
    const rowData = Array.isArray(data.rowData) ? data.rowData : [];
    const meta = Array.isArray(data.rowMetadata) ? data.rowMetadata : null;
    const records = rowData.map((rd, i) => {
      const values = rd && Array.isArray(rd.values) ? rd.values : [];
      const cells = new Array(col0).fill(''), links = {}, isbnRaw = {};
      values.forEach((v, j) => {
        const c = col0 + j;
        const text = v && v.formattedValue != null ? str(v.formattedValue) : '';
        cells[c] = text;
        if (isBlank(text)) return;
        const link = cellLink(v);
        if (link) links[c] = link;
        const raw = isbnDigits(v.effectiveValue ? v.effectiveValue.numberValue : undefined, text);
        if (raw) isbnRaw[c] = raw;
      });
      const m = meta ? meta[i] : null;
      const hidden = m && typeof m === 'object' ? m.hiddenByUser === true || m.hiddenByFilter === true : null;
      return { row: row0 + i + 1, cells, hidden, links, isbnRaw };
    });
    const header = records.find(r => r.row <= HEADER_SCAN_ROWS && r.cells.some(isTitleHeader));
    for (const mg of sheet && Array.isArray(sheet.merges) ? sheet.merges : []) {
      if (!mg || typeof mg !== 'object') continue;
      const top = Number(mg.startRowIndex) || 0, end = Number(mg.endRowIndex) || 0, col = Number(mg.startColumnIndex) || 0;
      if (end - top < 2 || !header || top + 1 <= header.row) continue;
      const from = records[top - row0];
      if (!from) continue;
      for (let r = top + 1; r < end; r++) {
        const rec = records[r - row0];
        if (!rec) continue;
        rec.cells[col] = from.cells[col] == null ? '' : from.cells[col];
        if (from.links[col]) rec.links[col] = from.links[col]; else delete rec.links[col];
        if (from.isbnRaw[col]) rec.isbnRaw[col] = from.isbnRaw[col]; else delete rec.isbnRaw[col];
      }
    }
    for (const r of records) for (let c = 0; c < r.cells.length; c++) if (r.cells[c] == null) r.cells[c] = '';
    const props = sheet && sheet.properties ? sheet.properties : {};
    const table = { tab: str(o.tab) || 'Sheet', gid: gidOr0(o.gid), sheetId: str(o.sheetId), records, hiddenKnown: !!meta };
    if (typeof props.hidden === 'boolean') table.hiddenTab = props.hidden;
    return table;
  }

  // ---------------------------------------------------------------------------------------------
  // Loading

  const FETCH_OPTS = { cache: 'no-store', credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer' };

  function httpMessage(status, what) {
    const s = 'Google answered with an error (HTTP ' + status + ')';
    if (status === 400 || status === 404) return s + ': the ' + what + ' may not exist, or the tab id may be wrong.';
    if (status === 401 || status === 403) return s + ': the ' + what + ' may not be shared.';
    if (status === 429) return s + ': too many requests; try again in a minute.';
    if (status >= 500) return s + ': try again in a moment.';
    return s + '.';
  }

  function looksLikeHtml(contentType, body) {
    if (/html/i.test(contentType)) return true;
    const head = body.replace(/^﻿/, '').slice(0, 200);
    if (/^\s*<(?:!doctype\b|html[\s>]|head[\s>]|body[\s>]|!--)/i.test(head)) return true;
    return !/csv|json/i.test(contentType) && /^\s*</.test(head);
  }

  // Fetches url and returns { res, body } or throws an Error with .kind set.
  async function fetchText(fetchFn, url, timeoutMs, msgs) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null, timedOut = false;
    if (ctrl && timeoutMs > 0) timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    try {
      let res;
      try {
        res = await fetchFn(url, ctrl ? Object.assign({}, FETCH_OPTS, { signal: ctrl.signal }) : Object.assign({}, FETCH_OPTS));
      } catch (e) {
        throw sheetError('network', timedOut ? MSG.timeout : msgs.network);
      }
      if (!res || typeof res.status !== 'number') throw sheetError('network', msgs.network);
      if (!res.ok) {
        try { if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {}); } catch (e) { /* ignore */ }
        throw sheetError('http', httpMessage(res.status, msgs.what));
      }
      let body;
      try { body = await res.text(); } catch (e) { throw sheetError('network', timedOut ? MSG.timeout : msgs.network); }
      const ctype = str(res.headers && res.headers.get ? res.headers.get('content-type') : '');
      if (looksLikeHtml(ctype, body)) throw sheetError('format', msgs.html);
      return { res, body };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function resolveNow(now) {
    if (typeof now === 'function') { const v = now(); return v instanceof Date ? v : new Date(v); }
    if (now instanceof Date) return new Date(now.getTime());
    if (typeof now === 'number' || typeof now === 'string') return new Date(now);
    return new Date();
  }

  function finish(parts, extra) {
    const rows = [], tabs = [], issues = [];
    for (const p of parts) {
      if (!p) continue;
      for (const r of p.rows) { r.id = rows.length; rows.push(r); }
      tabs.push(p.meta);
      issues.push(...p.issues);
    }
    return Object.assign({ rows, tabs, issues }, extra);
  }

  const dispositionOf = res => (res && res.headers && res.headers.get ? res.headers.get('content-disposition') : null);

  // The whole file name of the export ("Doc title - Tab name.csv"): the document title is the same for every tab and
  // tab names are unique in a spreadsheet, so two exports with the same file name are the same tab.
  const exportFileName = res => { const f = fileNameFromDisposition(dispositionOf(res)); return f ? f.name : null; };

  // The file name of the export Google sends for gid (headers only; the body is dropped), or null.
  async function exportedFileName(fetchFn, sheetId, gid, timeoutMs) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl && timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(csvUrl(sheetId, gid), Object.assign({}, FETCH_OPTS, ctrl ? { signal: ctrl.signal } : {}));
      try { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {}); } catch (e) { /* ignore */ }
      return res && res.ok ? exportFileName(res) : null;
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function loadCsv(source, fetchFn, schoolCode, timeoutMs) {
    const sheetId = str(source.sheetId);
    const tabs = Array.isArray(source.tabs) && source.tabs.length ? source.tabs : [{ gid: null, name: null }];
    if (!SHEET_ID_RE.test(sheetId)) {
      return { parts: [], errors: [{ tab: null, message: MSG.badSheetId, kind: 'format' }], sheetId };
    }
    const msgs = { network: MSG.csvNetwork, html: MSG.csvHtml, what: 'sheet or tab' };
    const results = await Promise.all(tabs.map(async t => {
      let gid = gidOrFirst(t && t.gid);
      const configured = t && t.name ? str(t.name) : null;
      // No gid: read the first tab (the export without a gid). Its id isn't in the reply, so ask for gid 0 alongside:
      // when Google gives the same file name (so the same tab), row links can use gid 0; otherwise they open the sheet
      // without a row.
      const gid0File = gid ? null : exportedFileName(fetchFn, sheetId, '0', timeoutMs);
      try {
        const { res, body } = await fetchText(fetchFn, csvUrl(sheetId, gid), timeoutMs, msgs);
        const named = tabNameFromDisposition(dispositionOf(res));
        const file = exportFileName(res);
        if (!gid && named && file && file === await gid0File) gid = '0';
        const tab = configured || named || 'Sheet';
        try {
          const part = extractRows(tableFromCsv(parseCsv(body), { tab, gid, sheetId }), { schoolCode });
          // The tab's own name from Google, kept beside a configured one so the settings page can show a mix-up.
          if (named) part.meta.sheetTabName = named;
          return { part };
        } catch (e) {
          return { error: { tab, message: e.kind ? e.message : MSG.noHeader, kind: 'format' } };
        }
      } catch (e) {
        return { error: { tab: configured || (gid ? 'gid ' + gid : 'the first tab'), message: e.message, kind: e.kind || 'network' } };
      }
    }));
    return { parts: results.map(r => r.part), errors: results.filter(r => r.error).map(r => r.error), sheetId };
  }

  async function loadScript(source, fetchFn, schoolCode, timeoutMs) {
    const url = parseScriptUrl(str(source.url));
    if (!url) return { parts: [], errors: [{ tab: null, message: MSG.scriptBadUrl, kind: 'script' }], sheetId: null };
    const wanted = Array.isArray(source.tabs) && source.tabs.length ? source.tabs.map(t => ({ gid: gidOr0(t && t.gid), name: t && t.name ? str(t.name) : null })) : null;
    const reqUrl = wanted ? url + '?gid=' + wanted.map(t => t.gid).join(',') : url;
    const msgs = { network: MSG.scriptNetwork, html: MSG.scriptHtml, what: 'script' };
    let body;
    try {
      body = (await fetchText(fetchFn, reqUrl, timeoutMs, msgs)).body;
    } catch (e) {
      return { parts: [], errors: [{ tab: null, message: e.message, kind: e.kind || 'network' }], sheetId: null };
    }
    let json;
    try { json = JSON.parse(body); } catch (e) {
      return { parts: [], errors: [{ tab: null, message: MSG.scriptJson, kind: 'format' }], sheetId: null };
    }
    const conv = tablesFromScript(json);
    const errors = conv.errors.map(e => ({ tab: e.tab, message: e.message, kind: e.kind || 'script' }));
    let tables = conv.tables;
    if (wanted) {
      const byGid = new Map(tables.map(t => [t.gid, t]));
      tables = [];
      for (const w of wanted) {
        const t = byGid.get(w.gid);
        if (t) { if (w.name) t.tab = w.name; tables.push(t); continue; }
        // Not returned: report it unless the script already sent an error for it (or for the whole request).
        const label = w.name || 'gid ' + w.gid;
        const covered = errors.some(e => e.tab == null || e.tab === w.name || e.tab === w.gid || e.tab === 'gid ' + w.gid);
        if (!covered) errors.push({ tab: label, message: MSG.scriptMissingTab, kind: 'script' });
      }
    }
    const parts = [];
    for (const t of tables) {
      try { parts.push(extractRows(t, { schoolCode })); } catch (e) {
        errors.push({ tab: t.tab, message: e.kind ? e.message : MSG.noHeader, kind: 'format' });
      }
    }
    return { parts, errors, sheetId: conv.sheetId };
  }

  // The Google Sheets API, read with the visitor's own access token: Google answers only if their account can view the
  // sheet. The token goes only in the Authorization header, never in an address or a message.
  const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';
  const API_TABS_FIELDS = 'sheets.properties(sheetId,title,hidden)';
  const API_GRID_FIELDS = 'sheets(properties(sheetId,title,hidden),merges,data(startRow,startColumn,' +
    'rowMetadata(hiddenByUser,hiddenByFilter),rowData(values(formattedValue,hyperlink,effectiveValue(numberValue),' +
    'userEnteredValue(formulaValue),textFormatRuns(format(link(uri)))))))';

  // kind: 'auth' (sign in again), 'access' (this account can't view the sheet), 'setup' (the Cloud project), else 'http'.
  function apiError(status, body) {
    const e = body && body.error && typeof body.error === 'object' ? body.error : {};
    let details = '';
    try { details = JSON.stringify(e.details || []); } catch (x) { details = ''; }
    const text = str(e.status) + ' ' + str(e.message) + ' ' + details;
    if (status === 401) return sheetError('auth', MSG.apiExpired);
    if (status === 403) {
      if (/SERVICE_DISABLED|has not been used|is disabled/i.test(text)) return sheetError('setup', MSG.apiDisabled);
      if (/SCOPE_INSUFFICIENT|insufficient\W*(?:authentication\W*)?scopes?/i.test(text)) return sheetError('auth', MSG.apiScope);
      if (/RATE_LIMIT|RESOURCE_EXHAUSTED|quota/i.test(text)) return sheetError('http', httpMessage(429, 'sheet'));
      return sheetError('access', MSG.apiAccess);
    }
    if (status === 404) return sheetError('http', MSG.apiNotFound);
    return sheetError('http', httpMessage(status, 'sheet'));
  }

  async function fetchApi(fetchFn, url, token, timeoutMs) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null, timedOut = false;
    if (ctrl && timeoutMs > 0) timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    try {
      const init = Object.assign({}, FETCH_OPTS, { headers: { Authorization: 'Bearer ' + token } }, ctrl ? { signal: ctrl.signal } : {});
      let res, body = null;
      try {
        res = await fetchFn(url, init);
      } catch (e) {
        throw sheetError('network', timedOut ? MSG.timeout : MSG.apiNetwork);
      }
      if (!res || typeof res.status !== 'number') throw sheetError('network', MSG.apiNetwork);
      try { body = await res.json(); } catch (e) {
        if (timedOut) throw sheetError('network', MSG.timeout);
        body = null;
      }
      if (!res.ok) throw apiError(res.status, body);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw sheetError('format', MSG.apiJson);
      return body;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const a1Sheet = title => "'" + str(title).replace(/'/g, "''") + "'";
  // Google leaves a 0 out of its answers (the first tab's sheetId), so a missing id is 0.
  const apiGid = p => str(p && p.sheetId != null ? p.sheetId : 0);

  async function loadApi(source, fetchFn, schoolCode, timeoutMs, token) {
    const sheetId = str(source.sheetId);
    if (!SHEET_ID_RE.test(sheetId)) return { parts: [], errors: [{ tab: null, message: MSG.badSheetId, kind: 'format' }], sheetId };
    if (!token) return { parts: [], errors: [{ tab: null, message: MSG.apiSignIn, kind: 'auth' }], sheetId };
    const wanted = Array.isArray(source.tabs) && source.tabs.length ? source.tabs : [{ gid: null, name: null }];
    const base = API_BASE + encodeURIComponent(sheetId);
    const fail = e => ({ parts: [], errors: [{ tab: null, message: e.message, kind: e.kind || 'network' }], sheetId });

    // 1. The tabs: which titles the configured tab ids have now (a range names a tab by its title).
    let info;
    try { info = await fetchApi(fetchFn, base + '?fields=' + encodeURIComponent(API_TABS_FIELDS), token, timeoutMs); } catch (e) { return fail(e); }
    const props = (Array.isArray(info.sheets) ? info.sheets : []).map(s => (s && s.properties) || null).filter(p => p && p.title != null);
    const errors = [], picks = [];
    for (const t of wanted) {
      const gid = gidOrFirst(t && t.gid);
      const name = t && t.name ? str(t.name) : null;
      // No tab id: the first tab that isn't hidden, as the export without a gid reads the first tab.
      const p = gid ? props.find(x => apiGid(x) === gid) : props.find(x => x.hidden !== true) || props[0];
      if (!p) { errors.push({ tab: name || (gid ? 'gid ' + gid : 'the first tab'), message: MSG.apiNoTab, kind: 'format' }); continue; }
      picks.push({ gid: apiGid(p), title: str(p.title), name });
    }
    if (!picks.length) return { parts: [], errors, sheetId };

    // 2. Those tabs' cells, links, merges and hidden rows, in one call.
    const ranges = picks.map(p => '&ranges=' + encodeURIComponent(a1Sheet(p.title))).join('');
    let grid;
    try {
      grid = await fetchApi(fetchFn, base + '?includeGridData=true' + ranges + '&fields=' + encodeURIComponent(API_GRID_FIELDS), token, timeoutMs);
    } catch (e) { return fail(e); }
    const sheets = Array.isArray(grid.sheets) ? grid.sheets : [];
    const parts = [];
    for (const p of picks) {
      const tab = p.name || p.title || 'Sheet';
      const s = sheets.find(x => x && x.properties && apiGid(x.properties) === p.gid);
      if (!s) { errors.push({ tab, message: MSG.apiNoTab, kind: 'format' }); continue; }
      try {
        const part = extractRows(tableFromGrid(s, { tab, gid: p.gid, sheetId }), { schoolCode });
        // The tab's own name in the sheet, kept beside a configured one so the settings page can show a mix-up.
        part.meta.sheetTabName = p.title;
        parts.push(part);
      } catch (e) {
        errors.push({ tab, message: e.kind ? e.message : MSG.noHeader, kind: 'format' });
      }
    }
    return { parts, errors, sheetId };
  }

  async function load(source, options) {
    const o = options || {};
    const fetchFn = typeof o.fetch === 'function' ? o.fetch
      : typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
    const schoolCode = o.schoolCode != null ? o.schoolCode : 'UAS';
    const timeoutMs = o.timeoutMs != null ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const src = source || {};
    const kind = src.kind === 'script' || src.kind === 'api' ? src.kind : 'csv';
    let out;
    if (!fetchFn) out = { parts: [], errors: [{ tab: null, message: MSG.csvNetwork, kind: 'network' }], sheetId: null };
    else if (kind === 'script') out = await loadScript(src, fetchFn, schoolCode, timeoutMs);
    else if (kind === 'api') out = await loadApi(src, fetchFn, schoolCode, timeoutMs, typeof o.accessToken === 'string' ? o.accessToken : '');
    else out = await loadCsv(src, fetchFn, schoolCode, timeoutMs);
    return finish(out.parts, { errors: out.errors, fetchedAt: resolveNow(o.now), source: kind, sheetId: out.sheetId || null });
  }

  return {
    parseSheetUrl, csvUrl, rowUrl, sheetUrl, parseScriptUrl, parseCsv, tabNameFromDisposition,
    tableFromCsv, tablesFromScript, tableFromGrid, extractRows, parseBannedBy, fingerprint, load,
    // exposed for tests and the app
    safeHttpsUrl, colLetter, messages: MSG,
  };
});
