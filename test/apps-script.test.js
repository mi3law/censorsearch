// Tests for the read-only Apps Script fallback (apps-script/Code.gs).
// Code.gs runs in a node vm context against mocked Google services built from a synthetic sheet. Every mocked
// Google object throws on (and records) any method that could change something: set*, insert*, delete*, clear*,
// append*, copy*, move*, remove*, protect*, sort*, hide*, show*, and a few more.
// The produced JSON is kept in test/fixtures/script-response.json (synthetic data only); run with
// UPDATE_FIXTURES=1 to rewrite it after an intended format change.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CODE_PATH = path.join(ROOT, 'apps-script', 'Code.gs');
const CODE = fs.readFileSync(CODE_PATH, 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps-script', 'appsscript.json'), 'utf8'));
const README = fs.readFileSync(path.join(ROOT, 'apps-script', 'README.md'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixtures', 'script-response.json');
const SHEET_JS = path.join(ROOT, 'src', 'sheet.js');

const SHEET_ID = 'synthetic-test-sheet-id-00000000000000000000';   // 44 characters, like a real id
const FIXED_NOW = '2026-01-02T03:04:05.000Z';
const FIXED_MS = Date.parse(FIXED_NOW);
const NO_TITLE = "No Title column in the first 10 rows of this tab, so it can't be searched.";

// The page's adapter (src/sheet.js) and engine, when they exist.
const sheetJs = (() => {
  if (!fs.existsSync(SHEET_JS)) return null;
  try {
    const m = require(SHEET_JS);
    return typeof m.tablesFromScript === 'function' ? m : null;
  } catch (e) {
    return null;
  }
})();
const noSheetJs = sheetJs ? false : 'src/sheet.js with tablesFromScript is not available';
const engine = (() => {
  try {
    const m = require(path.join(ROOT, 'src', 'engine.js'));
    return typeof m.buildIndex === 'function' && typeof m.search === 'function' ? m : null;
  } catch (e) {
    return null;
  }
})();
const noEngine = noSheetJs || (engine ? false : 'src/engine.js is not available');

// Method names a read-only script must never call on a Google object (the task's list plus a few more).
const FORBIDDEN = /^(set|insert|delete|clear|append|copy|move|remove|protect|sort|hide|show|activate|merge|break|create|add|duplicate|trim|auto|randomize|shift|uncheck|check|flush|group|ungroup|expand|collapse)/;
// Everything Code.gs may call on the spreadsheet objects: getters only. Not the per-row isRowHiddenByUser/Filter:
// hidden flags come from one Sheets API call per tab (AS-2).
const SPREADSHEET_GETTERS = new Set([
  'openById', 'getSheets', 'getSheetId', 'getName', 'isSheetHidden', 'getRange', 'getDataRange', 'getDisplayValues',
  'getValues', 'getRichTextValues', 'getFormulas', 'getMergedRanges',
  'getLastRow', 'getLastColumn', 'getRow', 'getColumn', 'getNumRows', 'getNumColumns', 'getLinkUrl', 'getRuns', 'getText',
]);
const HIDDEN_FIELDS = 'sheets(data(startRow,rowMetadata(hiddenByUser,hiddenByFilter)))';

// ------------------------------------------------------------------------------------------------
// Mock Google services

class FixedDate extends Date {
  constructor(...args) { if (args.length === 0) super(FIXED_MS); else super(...args); }
  static now() { return FIXED_MS; }
}

function guard(target, label, log, allowed = new Set()) {
  return new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop !== 'string') return Reflect.get(t, prop, recv);
      if (FORBIDDEN.test(prop) && !allowed.has(prop)) {
        return () => {
          log.violations.push(`${label}.${prop}`);
          throw new Error(`read-only mock: ${label}.${prop} is not allowed`);
        };
      }
      const v = Reflect.get(t, prop, recv);
      if (typeof v !== 'function') return v;
      return (...args) => { log.calls.push({ label, name: prop, args }); return v.apply(t, args); };
    },
    set(t, prop) {
      log.violations.push(`${label}.${String(prop)} (property write)`);
      throw new Error('read-only mock: property write');
    },
  });
}

function colNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function a1(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return { r: Number(m[2]), c: colNumber(m[1]) };
}
function a1Range(ref) {
  const [p, q = p] = ref.split(':');
  const s = a1(p), e = a1(q);
  return { r1: s.r, c1: s.c, r2: e.r, c2: e.c };
}

function makeRich(display, spec, log) {
  const runs = spec && spec.runs ? spec.runs : [[display, spec && spec.link ? spec.link : null]];
  const whole = runs.every(r => r[1] === runs[0][1]) ? runs[0][1] : null;
  let start = 0;
  const runObjs = runs.map(([text, link]) => {
    const s = start; start += text.length;
    return guard({ getText: () => text, getLinkUrl: () => link, getStartIndex: () => s, getEndIndex: () => s + text.length },
      'RichTextRun', log);
  });
  return guard({ getText: () => display, getLinkUrl: () => whole, getRuns: () => runObjs.slice() }, 'RichTextValue', log);
}

function makeSheet(spec, log) {
  const grid = spec.grid;
  const nRows = grid.length;
  const nCols = Math.max(...grid.map(r => r.length));
  const values = spec.values || {}, rich = spec.rich || {}, formulas = spec.formulas || {};
  const merges = (spec.merges || []).map(a1Range);
  const key = (r, c) => String.fromCharCode(64 + c) + r;   // single-letter columns are enough here
  const display = (r, c) => ((grid[r - 1] || [])[c - 1] ?? '');
  const value = (r, c) => (key(r, c) in values ? values[key(r, c)] : display(r, c));
  const richAt = (r, c) => (typeof value(r, c) === 'string' ? makeRich(display(r, c), rich[key(r, c)], log) : null);
  const formula = (r, c) => formulas[key(r, c)] || '';

  function range(r, c, nr, nc) {
    const mat = fn => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => fn(r + i, c + j)));
    const hits = m => m.r1 <= r + nr - 1 && m.r2 >= r && m.c1 <= c + nc - 1 && m.c2 >= c;
    return guard({
      getRow: () => r, getColumn: () => c, getNumRows: () => nr, getNumColumns: () => nc,
      getLastRow: () => r + nr - 1, getLastColumn: () => c + nc - 1,
      getDisplayValues: () => { if (spec.failOn === 'getDisplayValues') throw new Error('boom'); return mat(display); },
      getValues: () => mat(value),
      getRichTextValues: () => { if (spec.failOn === 'getRichTextValues') throw new Error('Service error: Spreadsheets'); return mat(richAt); },
      getFormulas: () => mat(formula),
      getDisplayValue: () => display(r, c),
      getValue: () => value(r, c),
      getMergedRanges: () => merges.filter(hits).map(m => range(m.r1, m.c1, m.r2 - m.r1 + 1, m.c2 - m.c1 + 1)),
    }, 'Range', log);
  }

  return guard({
    getName: () => spec.name,
    getSheetId: () => spec.gid,
    isSheetHidden: () => !!spec.hidden,
    getLastRow: () => nRows,
    getLastColumn: () => nCols,
    getMaxRows: () => nRows + 100,
    getMaxColumns: () => nCols + 5,
    getDataRange: () => range(1, 1, nRows, nCols),
    getRange: (r, c, nr = 1, nc = 1) => {
      if (!(nr >= 1) || !(nc >= 1)) throw new Error('The number of rows or columns in the range must be at least 1.');
      return range(r, c, nr, nc);
    },
    isRowHiddenByUser: r => (spec.hiddenByUser || []).includes(r),
    isRowHiddenByFilter: r => (spec.hiddenByFilter || []).includes(r),
  }, 'Sheet', log);
}

function makeSpreadsheet(sheets, log, opts = {}) {
  const made = sheets.map(s => makeSheet(s, log));
  return guard({
    getId: () => SHEET_ID,
    getName: () => 'Synthetic spreadsheet',
    getSheets: () => { if (opts.getSheetsThrows) throw new Error(opts.getSheetsThrows); return made.slice(); },
  }, 'Spreadsheet', log);
}

// The Sheets advanced service (Sheets.Spreadsheets.get), answering only the row-metadata request Code.gs makes.
// Like the real API it leaves out startRow when it is 0 and false flags inside rowMetadata.
function makeSheetsApi(specs, log, mode) {
  const spreadsheets = {
    get(id, opts) {
      if (mode === 'throws') throw new Error(`GoogleJsonResponseException: API call to sheets.spreadsheets.get failed with error: Quota exceeded (${SHEET_ID})`);
      if (id !== SHEET_ID) throw new Error('Requested entity was not found.');
      const m = /^'((?:[^']|'')*)'!A(\d+):A(\d+)$/.exec(opts && opts.ranges && opts.ranges.length === 1 ? opts.ranges[0] : '');
      if (!m || !opts.fields || !opts.fields.includes('rowMetadata')) return {};
      const spec = specs.find(s => s.name === m[1].replace(/''/g, "'"));
      if (!spec) throw new Error('Unable to parse range');
      const r1 = Number(m[2]), r2 = Number(m[3]);
      const rowMetadata = [];
      for (let r = r1; r <= r2; r++) {
        const md = {};
        if ((spec.hiddenByUser || []).includes(r)) md.hiddenByUser = true;
        if ((spec.hiddenByFilter || []).includes(r)) md.hiddenByFilter = true;
        rowMetadata.push(md);
      }
      return { sheets: [{ data: [{ ...(r1 > 1 ? { startRow: r1 - 1 } : {}), rowMetadata }] }] };
    },
  };
  return guard({ Spreadsheets: guard(spreadsheets, 'AdvancedSheets', log) }, 'AdvancedSheetsRoot', log);
}

function utf8Bytes(s) { return Buffer.byteLength(s, 'utf8'); }

function makeCache(log, opts = {}) {
  const store = new Map();
  const cache = {
    get(k) {
      if (opts.throws) throw new Error('cache down');
      return store.has(k) ? store.get(k) : null;
    },
    getAll(keys) { const out = {}; for (const k of keys) if (store.has(k)) out[k] = store.get(k); return out; },
    put(k, v, ttl) { check(k, v, ttl); store.set(k, v); },
    putAll(obj, ttl) { for (const [k, v] of Object.entries(obj)) check(k, v, ttl); for (const [k, v] of Object.entries(obj)) store.set(k, v); },
  };
  function check(k, v, ttl) {
    if (typeof k !== 'string' || k.length > 250) throw new Error('cache key too long');
    if (typeof v !== 'string' || utf8Bytes(v) > 100 * 1024) throw new Error('Argument too large: value');
    if (!(ttl >= 1 && ttl <= 21600)) throw new Error('bad expiration');
    log.cacheTtls.push(ttl);
  }
  return { store, cache: guard(cache, 'Cache', log) };
}

// A Google environment plus a fresh copy of Code.gs; get(parameter) calls doGet like a web request.
// sheetsApi: 'on' (the manifest's Sheets advanced service), 'missing' (service turned off) or 'throws' (e.g. over its limit).
function env({ props = { SPREADSHEET_ID: SHEET_ID }, sheets = defaultSheets(), openThrows = null, getSheetsThrows = null, cacheThrows = false, sheetsApi = 'on' } = {}) {
  const log = { calls: [], violations: [], cacheTtls: [] };
  const spreadsheet = makeSpreadsheet(sheets, log, { getSheetsThrows });
  const { store, cache } = makeCache(log, { throws: cacheThrows });
  const ctx = {
    Date: FixedDate,
    SpreadsheetApp: guard({
      openById(id) {
        if (openThrows) throw new Error(openThrows);
        if (id !== SHEET_ID) throw new Error(`Exception: Unexpected error while getting the method or property openById on object SpreadsheetApp (id ${id}).`);
        return spreadsheet;
      },
    }, 'SpreadsheetApp', log),
    PropertiesService: guard({
      getScriptProperties: () => guard({
        getProperty: k => (Object.prototype.hasOwnProperty.call(props, k) ? String(props[k]) : null),
        getProperties: () => ({ ...props }),
        getKeys: () => Object.keys(props),
      }, 'ScriptProperties', log),
    }, 'PropertiesService', log),
    CacheService: guard({ getScriptCache: () => cache }, 'CacheService', log),
    ContentService: guard({
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput: content => {
        const out = { content, mimeType: 'text/plain' };
        return guard({
          setMimeType(m) { out.mimeType = m; return this; },
          getContent: () => out.content,
          getMimeType: () => out.mimeType,
        }, 'TextOutput', log, new Set(['setMimeType']));
      },
    }, 'ContentService', log, new Set(['createTextOutput'])),
  };
  if (sheetsApi !== 'missing') ctx.Sheets = makeSheetsApi(sheets, log, sheetsApi);
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: 'Code.gs' });
  const get = (parameter = {}) => {
    const output = ctx.doGet({ parameter, parameters: {}, queryString: '' });
    const body = output.getContent();
    return { output, body, json: JSON.parse(body) };
  };
  return { ctx, log, get, store };
}

// Plain objects from the vm realm, for deepStrictEqual.
const plain = v => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------------------------------------
// Synthetic spreadsheet: Sheet1 (the list), Notes (no Title header), Archive (hidden, synonym headers)

function defaultSheets() {
  const e = '';
  return [
    {
      name: 'Sheet1', gid: 0,
      grid: [
        ['Test list', e, e, e, e, e, e, e, e],
        ['updated as of 1 January 2026', e, e, e, e, e, e, e, e],
        ['Title', 'Author', 'ISBN', 'Banned By', 'Type', 'Year of Banning', 'Memo', 'Status', e],
        ['101 Creepy Jokes', 'Jovial Bob Stine', e, 'RS', 'Book', '2010-2011', e, 'Active', 'Notes: red = Ministry, blue = UAS'],
        ['1984', 'George Orwell', '9.79889E+12', 'Ministry', 'Book', '2024-2025', 'Memo 751459', 'Lifted 2025', 'Other codes: case by case'],
        ['Alchemist, The', 'Paulo Coelho', '817450835X', 'UAS', 'Book', '2023', 'See memo', e, e],
        ['Bad Link Book', 'Anon Writer', e, 'KES', 'Book', '2022', 'Click me', e, e],
        ['Merged One', 'Author A', e, 'Ministry', 'DVD', '2021', e, e, e],
        ['Merged Two', 'Author B', e, e, 'CD', '2021', e, e, e],
        ['Hidden By Filter', 'Author C', e, 'RS', 'Book', '2020', e, e, e],
        ['Hidden By User', 'Author D', e, 'UAS', 'Book', '2020', e, e, e],
        [e, e, e, e, e, e, e, 'Status only', e],
        [' ', '​', e, e, e, e, e, e, e],
      ],
      values: { A5: 1984, C5: 9798891808546 },
      rich: {
        A4: { link: 'https://example.org/books/creepy-jokes' },
        G5: { runs: [['Memo ', null], ['751459', 'https://drive.google.com/file/d/synthetic-memo-1/view']] },
        G7: { link: 'javascript:alert(1)' },
      },
      formulas: {
        G6: '=HYPERLINK("https://drive.google.com/file/d/synthetic-memo-2/view","See memo")',
        B7: '=HYPERLINK("http://insecure.example/","Anon Writer")',
      },
      merges: ['A1:G1', 'D8:D9', 'I4:I9'],
      hiddenByFilter: [10],
      hiddenByUser: [11],
    },
    { name: 'Notes', gid: 222, grid: [['Legend'], ['Red = Ministry'], ['Blue = UAS']] },
    {
      name: 'Archive', gid: 333, hidden: true,
      grid: [
        ['No.', 'Material', 'Author(s)', 'ISBN-13', 'Banned', 'Format', 'Year', 'Notes'],
        ['1', 'Old Title', 'Old Author', '978-0-00-000000-2', 'Ministry', 'Book', '2019', 'lifted?'],
      ],
    },
  ];
}

const SHEET1 = {
  name: 'Sheet1', gid: '0', hiddenTab: false, headerRow: 3,
  above: [['Test list'], ['updated as of 1 January 2026']],
  headers: ['Title', 'Author', 'ISBN', 'Banned By', 'Type', 'Year of Banning', 'Memo'],
  columns: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  lastColumn: 'H',
  rows: [
    { row: 4, values: ['101 Creepy Jokes', 'Jovial Bob Stine', '', 'RS', 'Book', '2010-2011', ''], raw: {}, links: { 0: 'https://example.org/books/creepy-jokes' }, hidden: false },
    { row: 5, values: ['1984', 'George Orwell', '9.79889E+12', 'Ministry', 'Book', '2024-2025', 'Memo 751459'], raw: { 2: '9798891808546' }, links: { 6: 'https://drive.google.com/file/d/synthetic-memo-1/view' }, hidden: false },
    { row: 6, values: ['Alchemist, The', 'Paulo Coelho', '817450835X', 'UAS', 'Book', '2023', 'See memo'], raw: { 2: '817450835X' }, links: { 6: 'https://drive.google.com/file/d/synthetic-memo-2/view' }, hidden: false },
    { row: 7, values: ['Bad Link Book', 'Anon Writer', '', 'KES', 'Book', '2022', 'Click me'], raw: {}, links: {}, hidden: false },
    { row: 8, values: ['Merged One', 'Author A', '', 'Ministry', 'DVD', '2021', ''], raw: {}, links: {}, hidden: false },
    { row: 9, values: ['Merged Two', 'Author B', '', 'Ministry', 'CD', '2021', ''], raw: {}, links: {}, hidden: false },
    { row: 10, values: ['Hidden By Filter', 'Author C', '', 'RS', 'Book', '2020', ''], raw: {}, links: {}, hidden: true },
    { row: 11, values: ['Hidden By User', 'Author D', '', 'UAS', 'Book', '2020', ''], raw: {}, links: {}, hidden: true },
  ],
};

const ARCHIVE = {
  name: 'Archive', gid: '333', hiddenTab: true, headerRow: 1,
  above: [],
  headers: ['Material', 'Author(s)', 'ISBN-13', 'Banned', 'Format', 'Year', 'Notes'],
  columns: ['B', 'C', 'D', 'E', 'F', 'G', 'H'],
  lastColumn: 'H',
  rows: [
    { row: 2, values: ['Old Title', 'Old Author', '978-0-00-000000-2', 'Ministry', 'Book', '2019', 'lifted?'], raw: { 2: '9780000000002' }, links: {}, hidden: false },
  ],
};

const EXPECTED = plain({ format: 'censorsearch-v1', spreadsheetId: SHEET_ID, fetchedAt: FIXED_NOW, tabs: [SHEET1], errors: [] });

function assertReadOnly(log) {
  assert.deepEqual(log.violations, [], 'no write-type method may be called');
  const sheetCalls = log.calls.filter(c => /^(SpreadsheetApp|Spreadsheet|Sheet|Range|RichText)/.test(c.label));
  const unexpected = [...new Set(sheetCalls.map(c => c.name).filter(n => !SPREADSHEET_GETTERS.has(n)))];
  assert.deepEqual(unexpected, [], 'only the listed getters are called on the spreadsheet');
  const propCalls = log.calls.filter(c => c.label === 'ScriptProperties').map(c => c.name);
  assert.ok(propCalls.every(n => n === 'getProperty'), 'script properties are only read');
  const apiCalls = log.calls.filter(c => /^AdvancedSheets/.test(c.label));
  assert.ok(apiCalls.every(c => c.label === 'AdvancedSheets' && c.name === 'get'), 'the Sheets service is only used for Spreadsheets.get');
  for (const c of apiCalls) assert.equal(c.args[1].fields, HIDDEN_FIELDS, 'and only for the hidden-row flags');
}
const apiGets = log => log.calls.filter(c => c.label === 'AdvancedSheets' && c.name === 'get');

// ------------------------------------------------------------------------------------------------
// The response

test('default config: JSON matches the contract exactly (mapped columns, merges, links, raw ISBNs, hidden rows)', () => {
  const { get, log } = env();
  const { output, body, json } = get();
  assert.equal(output.getMimeType(), 'application/json');
  assert.deepEqual(json, EXPECTED);
  assertReadOnly(log);
  // Never any unmapped column: Status (H) and the headerless notes cells (I) stay in the sheet.
  for (const leaked of ['Status', 'Active', 'Lifted 2025', 'Status only', 'Notes: red', 'Other codes', 'Legend']) {
    assert.ok(!body.includes(leaked), `response must not contain "${leaked}"`);
  }
  assert.ok(!body.includes('javascript:') && !body.includes('http://'), 'non-https links are dropped');
  assert.deepEqual(Object.keys(json), ['format', 'spreadsheetId', 'fetchedAt', 'tabs', 'errors']);
  assert.deepEqual(Object.keys(json.tabs[0]), ['name', 'gid', 'hiddenTab', 'headerRow', 'above', 'headers', 'columns', 'lastColumn', 'rows']);
  assert.deepEqual(Object.keys(json.tabs[0].rows[0]), ['row', 'values', 'raw', 'links', 'hidden']);
});

test('fixture test/fixtures/script-response.json holds exactly what the script produces', () => {
  const { json } = env().get();
  if (process.env.UPDATE_FIXTURES === '1' || !fs.existsSync(FIXTURE)) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(json, null, 2) + '\n');
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')), json);
});

test('hidden tabs and tabs without a Title header are left out by default', () => {
  const { json } = env().get();
  assert.deepEqual(json.tabs.map(t => t.name), ['Sheet1']);
  assert.deepEqual(json.errors, []);
});

// AS-3: v1 reads the main tab only; no other tab is published unless TABS names it.
test('without TABS only the first visible tab is served, even if another tab has a Title-like header', () => {
  const contacts = { name: 'Contacts', gid: 42, grid: [['Name', 'Email', 'Phone', 'Notes'], ['Jane Teacher', 'jane.teacher', '555-0100', 'on leave until May']] };
  let e = env({ sheets: [...defaultSheets(), contacts] });
  let r = e.get();
  assert.deepEqual(r.json, EXPECTED);
  for (const leaked of ['Jane', 'on leave', 'Contacts']) assert.ok(!r.body.includes(leaked), `response must not contain "${leaked}"`);
  assert.deepEqual(e.get({ gid: '42' }).json.errors, [{ tab: 'gid 42', message: 'This tab is not available from this script.' }]);
  assertReadOnly(e.log);

  // The first tab is hidden: the first visible one is served instead.
  const sheets = defaultSheets();
  sheets.unshift({ ...contacts, hidden: true });
  r = env({ sheets }).get();
  assert.deepEqual(r.json, EXPECTED);

  // TABS still opens any tab, in its order.
  r = env({ sheets: [...defaultSheets(), contacts], props: { SPREADSHEET_ID: SHEET_ID, TABS: '0,42' } }).get();
  assert.deepEqual(r.json.tabs.map(t => t.name), ['Sheet1', 'Contacts']);
});

test('without TABS, a first tab that is not a list or no visible tab at all is a plain error, never a silent empty list', () => {
  let r = env({ sheets: [{ name: 'Notes', gid: 222, grid: [['Legend']] }, ...defaultSheets()] }).get();
  assert.deepEqual(r.json.tabs, []);
  assert.deepEqual(r.json.errors, [{ tab: 'Notes', message: NO_TITLE }]);
  r = env({ sheets: [{ ...defaultSheets()[0], hidden: true }] }).get();
  assert.deepEqual(r.json.tabs, []);
  assert.deepEqual(r.json.errors, [{ tab: '', message: 'Every tab is hidden. Add the list\'s tab id to TABS in the script properties.' }]);
});

test('rows above the header keep one entry per row, empty rows as []', () => {
  const sheets = defaultSheets();
  sheets[0].grid.splice(1, 0, ['', '', '']);   // blank row 2; header moves to row 4
  const { json } = env({ sheets }).get();
  assert.equal(json.tabs[0].headerRow, 4);
  assert.deepEqual(json.tabs[0].above, [['Test list'], [], ['updated as of 1 January 2026']]);
  assert.equal(json.tabs[0].rows[0].row, 5);
});

test('a merge that starts above the data or in an unmapped column is not spread into the data', () => {
  const sheets = defaultSheets();
  sheets[0].merges = ['D3:D4', 'H8:H9', 'A8:G8'];   // header into data, Status column, full-width row merge
  const { json } = env({ sheets }).get();
  const rows = Object.fromEntries(json.tabs[0].rows.map(r => [r.row, r.values]));
  assert.deepEqual(rows[4], SHEET1.rows[0].values, 'header text is not copied into row 4');
  assert.equal(rows[9][3], '', 'without the D8:D9 merge, row 9 Banned By stays empty');
  assert.deepEqual(rows[8], SHEET1.rows[4].values, 'a one-row merge copies nothing');
});

// SEC-04 / COV-8: above the header only the list's title and its "updated as of" line leave the sheet.
test('above the header only the banner title and the "updated" line are returned, never other cells', () => {
  const e = '';
  const sheets = [{
    name: 'Sheet1', gid: 0,
    grid: [
      ['My list', e, e, e, e, e, e, e, e, 'PRIVATE: script owner phone 555-0100'],
      ['updated as of 1 Jan', e, e, e, e, e, e, 'Internal: do not share', e, e],
      ['Title', 'Author', 'ISBN', 'Banned By', 'Type', 'Year of Banning', 'Memo', e, e, e],
      ['Book A', 'Ann', e, 'Ministry', 'Book', '2024', e, e, e, 'secret J4'],
    ],
  }];
  const { json, body } = env({ sheets }).get();
  assert.deepEqual(json.tabs[0].above, [['My list'], ['updated as of 1 Jan']]);
  for (const leaked of ['PRIVATE', '555-0100', 'Internal', 'secret J4']) assert.ok(!body.includes(leaked), `response must not contain "${leaked}"`);
});

test('the kept cells give the page the same banner title and "updated" line as the CSV path', { skip: noSheetJs }, () => {
  const e = '';
  const layouts = [
    [['My list', e, e, 'note'], ['updated as of 1 Jan', e, 'other note', e]],
    [['updated as of 1 Jan', 'My list', 'note', e], [e, e, e, e]],          // "updated" first, banner after it
    [[e, e, e, 'note only'], ['updated as of 1 Jan', e, e, e]],               // the banner is whatever comes first
    [['Last updated list', e, e, e], ['updated as of 1 Jan', 'note', e, e]],  // two "updated" cells
    [[e, e, e, e], [e, e, e, e]],
  ];
  for (const top of layouts) {
    const grid = [...top, ['Title', 'Author', 'Banned By', e], ['Book A', 'Ann', 'Ministry', e]];
    const { json } = env({ sheets: [{ name: 'Sheet1', gid: 0, grid }] }).get();
    const viaScript = sheetJs.extractRows(sheetJs.tablesFromScript(json).tables[0], { schoolCode: 'UAS' }).meta;
    const viaCsv = sheetJs.extractRows(sheetJs.tableFromCsv(grid, { tab: 'Sheet1', gid: '0', sheetId: SHEET_ID }), { schoolCode: 'UAS' }).meta;
    assert.equal(viaScript.updatedAsOf, viaCsv.updatedAsOf, JSON.stringify(top));
    assert.equal(viaScript.bannerTitle, viaCsv.bannerTitle, JSON.stringify(top));
    assert.ok(json.tabs[0].above.flat().length <= 2, 'at most two cells above the header');
  }
});

// ------------------------------------------------------------------------------------------------
// Allow-list: TABS and ?gid=

test('TABS serves exactly the listed tabs, in that order, hidden ones included', () => {
  let r = env({ props: { SPREADSHEET_ID: SHEET_ID, TABS: '0,333' } }).get();
  assert.deepEqual(r.json.tabs, plain([SHEET1, ARCHIVE]));
  assert.deepEqual(r.json.errors, []);
  r = env({ props: { SPREADSHEET_ID: SHEET_ID, TABS: ' 333 , 0 ' } }).get();
  assert.deepEqual(r.json.tabs.map(t => t.gid), ['333', '0']);
});

test('TABS entries that are missing, headerless or not ids become errors; the rest still load', () => {
  let r = env({ props: { SPREADSHEET_ID: SHEET_ID, TABS: '0,222,444' } }).get();
  assert.deepEqual(r.json.tabs.map(t => t.name), ['Sheet1']);
  assert.deepEqual(r.json.errors, [
    { tab: 'Notes', message: NO_TITLE },
    { tab: 'gid 444', message: 'No tab with this id in the spreadsheet. Check TABS in the script properties.' },
  ]);
  r = env({ props: { SPREADSHEET_ID: SHEET_ID, TABS: '0,Sheet2' } }).get();
  assert.deepEqual(r.json.tabs.map(t => t.name), ['Sheet1']);
  assert.equal(r.json.errors.length, 1);
  assert.equal(r.json.errors[0].tab, 'TABS');
});

test('?gid= picks tabs within the allow-list only', () => {
  const e = env();
  assert.deepEqual(e.get({ gid: '0' }).json.tabs, plain([SHEET1]));
  assert.deepEqual(e.get({ gid: ' 0 , 0 ' }).json.tabs.map(t => t.gid), ['0']);
  assert.deepEqual(e.get({ gid: '' }).json, EXPECTED, 'an empty gid means all tabs');

  let j = e.get({ gid: '0,999' }).json;
  assert.deepEqual(j.tabs.map(t => t.gid), ['0']);
  assert.deepEqual(j.errors, [{ tab: 'gid 999', message: 'This tab is not available from this script.' }]);

  j = e.get({ gid: '333' }).json;   // hidden and not in TABS: same answer as a tab that doesn't exist
  assert.deepEqual(j.tabs, []);
  assert.deepEqual(j.errors, [{ tab: 'gid 333', message: 'This tab is not available from this script.' }]);

  j = e.get({ gid: '222' }).json;   // visible but not the first tab, and not in TABS
  assert.deepEqual(j.tabs, []);
  assert.deepEqual(j.errors, [{ tab: 'gid 222', message: 'This tab is not available from this script.' }]);

  j = env({ props: { SPREADSHEET_ID: SHEET_ID, TABS: '0,222' } }).get({ gid: '222' }).json;
  assert.deepEqual(j.tabs, []);
  assert.deepEqual(j.errors, [{ tab: 'Notes', message: NO_TITLE }]);

  j = e.get({ gid: 'abc' }).json;
  assert.deepEqual(j.tabs, []);
  assert.equal(j.errors.length, 1);
  assert.equal(j.errors[0].tab, 'gid');

  j = e.get({ gid: Array.from({ length: 30 }, (_, i) => i).join(',') }).json;
  assert.equal(j.errors.filter(x => x.tab === 'gid').length, 1, 'more than 20 ids is refused with one error');

  const t = env({ props: { SPREADSHEET_ID: SHEET_ID, TABS: '0' } });
  j = t.get({ gid: '333' }).json;
  assert.deepEqual(j.tabs, []);
  assert.deepEqual(j.errors, [{ tab: 'gid 333', message: 'This tab is not available from this script.' }]);
  assertReadOnly(e.log);
  assertReadOnly(t.log);
});

test('every parameter other than gid is ignored', () => {
  const e = env();
  const { body } = e.get({ callback: 'alert', sheet: 'https://docs.google.com/spreadsheets/d/other/edit', script: 'x', format: 'csv', tabs: '333', q: '1984' });
  assert.deepEqual(JSON.parse(body), EXPECTED);
  assert.ok(!body.includes('alert'));
  assert.equal(typeof e.ctx.doPost, 'undefined', 'GET only: no doPost');
});

test('no Title header anywhere: an error entry, never a silent empty list', () => {
  const sheets = [{ name: 'Notes', gid: 222, grid: [['Legend'], ['Red = Ministry']] }];
  const { json } = env({ sheets }).get();
  assert.deepEqual(json.tabs, []);
  assert.deepEqual(json.errors, [{ tab: 'Notes', message: NO_TITLE }]);
});

test('a tab that fails to read becomes an error entry; other tabs still load', () => {
  const sheets = defaultSheets();
  sheets[0].failOn = 'getRichTextValues';
  const { json, body } = env({ sheets, props: { SPREADSHEET_ID: SHEET_ID, TABS: '0,333' } }).get();
  assert.deepEqual(json.tabs, plain([ARCHIVE]));
  assert.deepEqual(json.errors, [{ tab: 'Sheet1', message: 'Could not read this tab. Try again in a minute.' }]);
  assert.ok(!body.includes('Service error'));
});

// ------------------------------------------------------------------------------------------------
// Hidden rows (AS-2): one Sheets API call per tab, never two service calls per row

function bigSheet(n, extra = {}) {
  const grid = [['Banned list'], ['updated as of 1 Jan'], ['Title', 'Author', 'ISBN', 'Banned By', 'Type', 'Year of Banning', 'Memo']];
  for (let i = 0; i < n; i++) grid.push([`Book ${i}`, `Author ${i}`, '', 'Ministry', 'Book', '2024', '']);
  return { name: 'Sheet1', gid: 0, grid, ...extra };
}

test('hidden flags come from one Sheets API call per tab, so the work does not grow with the row count', () => {
  const small = env({ sheets: [bigSheet(10)] });
  small.get();
  const big = env({ sheets: [bigSheet(1200, { hiddenByUser: [700], hiddenByFilter: [1150, 1203] })] });
  const { json } = big.get();
  assertReadOnly(big.log);
  assert.equal(big.log.calls.filter(c => /^isRowHidden/.test(c.name)).length, 0, 'no per-row isRowHidden* calls');
  const gets = apiGets(big.log);
  assert.equal(gets.length, 1);
  assert.deepEqual(plain(gets[0].args), [SHEET_ID, { ranges: ["'Sheet1'!A4:A1203"], fields: HIDDEN_FIELDS }]);
  const serviceCalls = log => log.calls.filter(c => /^(SpreadsheetApp|Spreadsheet|Sheet|Range|AdvancedSheets)$/.test(c.label)).length;
  assert.equal(serviceCalls(big.log), serviceCalls(small.log), '1,200 rows take as many service calls as 10');
  const rows = json.tabs[0].rows;
  assert.equal(rows.length, 1200);
  assert.deepEqual(rows.filter(r => r.hidden).map(r => r.row), [700, 1150, 1203]);
  assert.ok(rows.every(r => typeof r.hidden === 'boolean'));
});

test('a tab name with quotes is quoted for the Sheets API range', () => {
  const sheets = defaultSheets();
  sheets[0].name = "Bob's 'list'";
  const e = env({ sheets });
  const { json } = e.get();
  assert.deepEqual(plain(apiGets(e.log)[0].args[1].ranges), ["'Bob''s ''list'''!A4:A13"]);
  assert.deepEqual(json.tabs[0].rows.filter(r => r.hidden).map(r => r.row), [10, 11]);
});

test('without the Sheets service, or when it fails, rows come back with hidden: null and the list still loads', () => {
  for (const sheetsApi of ['missing', 'throws']) {
    const e = env({ sheetsApi });
    const { json, body } = e.get();
    assert.deepEqual(json.errors, [], sheetsApi);
    const expected = plain(SHEET1);
    expected.rows.forEach(r => { r.hidden = null; });
    assert.deepEqual(json.tabs, [expected], sheetsApi);
    assert.ok(!body.includes('Quota') && !body.includes('Exception'), 'Google\'s error text stays out of the response');
    assertReadOnly(e.log);
    if (sheetJs) {
      const { rows } = sheetJs.extractRows(sheetJs.tablesFromScript(json).tables[0], { schoolCode: 'UAS' });
      assert.ok(rows.length === 8 && rows.every(r => r.hidden === null), 'the page treats the flags as unknown');
    }
  }
});

// ------------------------------------------------------------------------------------------------
// Errors

function assertPlainError(json, includes) {
  assert.deepEqual(Object.keys(json), ['format', 'error']);
  assert.equal(json.format, 'censorsearch-v1');
  assert.equal(typeof json.error, 'string');
  if (includes) assert.ok(json.error.includes(includes), json.error);
  assert.ok(!/@/.test(json.error), 'no email address');
  assert.ok(!json.error.includes(SHEET_ID), 'no spreadsheet id');
  assert.ok(!/\bat\b.*\(|Code\.gs|\n\s+at /.test(json.error), 'no stack trace');
  assert.ok(!/Exception|Service error/.test(json.error), "no Google exception text");
}

test('missing or malformed SPREADSHEET_ID gives a plain setup error', () => {
  let r = env({ props: {} });
  assertPlainError(r.get().json, 'SPREADSHEET_ID');
  assert.equal(r.log.calls.filter(c => c.label === 'SpreadsheetApp').length, 0);
  r = env({ props: { SPREADSHEET_ID: '   ' } });
  assertPlainError(r.get().json, 'SPREADSHEET_ID');
  r = env({ props: { SPREADSHEET_ID: 'not an id!' } });
  assertPlainError(r.get().json, 'SPREADSHEET_ID');
});

test('SPREADSHEET_ID may be the whole sheet link', () => {
  const { json } = env({ props: { SPREADSHEET_ID: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing#gid=0` } }).get();
  assert.deepEqual(json, EXPECTED);
});

test('a spreadsheet the account cannot open gives a plain error without ids, emails or stack', () => {
  const { json } = env({ openThrows: `Exception: You do not have permission to access the requested document. (teacher@school.example, ${SHEET_ID})` }).get();
  assertPlainError(json, "Can't open the spreadsheet");
});

// AS-1: a missing permission is named as such, instead of sending the maintainer to check the id and sharing.
test('a script without permission to open spreadsheets says so and points to appsscript.json', () => {
  const { json } = env({ openThrows: 'Exception: You do not have permission to call SpreadsheetApp.openById. Required permissions: https://www.googleapis.com/auth/spreadsheets' }).get();
  assertPlainError(json, 'appsscript.json');
  assert.ok(!json.error.includes("Can't open the spreadsheet"), json.error);
});

test('an unexpected failure gives a generic plain error', () => {
  const { json } = env({ getSheetsThrows: `Service error: Spreadsheets (${SHEET_ID}) at readSpreadsheet_ (Code.gs:120)` }).get();
  assertPlainError(json, 'could not read the sheet');
});

// ------------------------------------------------------------------------------------------------
// Cache

test('caching is off by default: the cache is never touched', () => {
  const e = env();
  e.get(); e.get({ gid: '0' });
  assert.equal(e.log.calls.filter(c => /Cache/.test(c.label)).length, 0);
  assert.equal(e.store.size, 0);
  assert.equal(e.log.calls.filter(c => c.name === 'openById').length, 2, 'each request reads the sheet');
});

test('CACHE_SECONDS=0, negative, fractional below 1 or not a number: no cache', () => {
  for (const v of ['0', '-5', '0.5', 'abc', '']) {
    const e = env({ props: { SPREADSHEET_ID: SHEET_ID, CACHE_SECONDS: v } });
    e.get(); e.get();
    assert.equal(e.log.calls.filter(c => /Cache/.test(c.label)).length, 0, `CACHE_SECONDS=${JSON.stringify(v)}`);
  }
});

test('CACHE_SECONDS > 0 serves repeat requests from the script cache', () => {
  const e = env({ props: { SPREADSHEET_ID: SHEET_ID, CACHE_SECONDS: '120' } });
  const first = e.get();
  const second = e.get();
  assert.equal(second.body, first.body);
  assert.deepEqual(first.json, EXPECTED);
  assert.equal(e.log.calls.filter(c => c.name === 'openById').length, 1);
  assert.ok(e.log.cacheTtls.length > 0 && e.log.cacheTtls.every(t => t === 120));
  // A different tab selection is a different entry.
  e.get({ gid: '0' });
  assert.equal(e.log.calls.filter(c => c.name === 'openById').length, 2);
  assertReadOnly(e.log);
});

test('CACHE_SECONDS is clamped to 300', () => {
  const e = env({ props: { SPREADSHEET_ID: SHEET_ID, CACHE_SECONDS: '99999' } });
  e.get();
  assert.ok(e.log.cacheTtls.length > 0 && e.log.cacheTtls.every(t => t === 300));
});

test('responses with errors are not cached', () => {
  const e = env({ props: { SPREADSHEET_ID: SHEET_ID, CACHE_SECONDS: '60' } });
  e.get({ gid: '0,999' });
  e.get({ gid: '0,999' });
  assert.equal(e.store.size, 0);
  assert.equal(e.log.calls.filter(c => c.name === 'openById').length, 2);
});

test('a broken cache never breaks the response', () => {
  const e = env({ props: { SPREADSHEET_ID: SHEET_ID, CACHE_SECONDS: '60' }, cacheThrows: true });
  assert.deepEqual(e.get().json, EXPECTED);
});

test('a response over 100 KB is cached in chunks and read back intact', () => {
  const rows = [['Title', 'Author', 'ISBN', 'Banned By', 'Type', 'Year of Banning', 'Memo']];
  for (let i = 0; i < 2500; i++) {
    rows.push([`Synthetic title number ${i} — كتاب رقم ${i} 📚`, `Author ${i}`, String(9780000000000 + i), i % 3 ? 'RS' : 'Ministry', 'Book', '2024-2025', `memo ${i}`]);
  }
  const sheets = [{ name: 'Big', gid: 0, grid: rows }];
  const e = env({ sheets, props: { SPREADSHEET_ID: SHEET_ID, CACHE_SECONDS: '300' } });
  const first = e.get();
  assert.ok(utf8Bytes(first.body) > 300 * 1024, 'test payload is well over 100 KB');
  const values = [...e.store.values()];
  assert.ok(values.length >= 4, 'stored in several chunks plus a head entry');
  assert.ok(values.every(v => utf8Bytes(v) <= 100 * 1024), 'every cache value stays under 100 KB');
  const second = e.get();
  assert.equal(second.body, first.body);
  assert.equal(e.log.calls.filter(c => c.name === 'openById').length, 1);
  assert.equal(first.json.tabs[0].rows.length, 2500);
});

// ------------------------------------------------------------------------------------------------
// Helpers inside Code.gs

test('links: https only, from rich text or =HYPERLINK', () => {
  const { ctx } = env();
  const f = s => ctx.linkFromFormula_(s);
  assert.equal(f('=HYPERLINK("https://a.example/x","label")'), 'https://a.example/x');
  assert.equal(f('=hyperlink( "https://a.example/x" ; "label")'), 'https://a.example/x');
  assert.equal(f('=HYPERLINK("https://a.example/?q=""x""")'), null, 'a doubled quote unescapes to ", which is refused');
  assert.equal(f('=IF(A1="","",HYPERLINK("https://a.example/y","label"))'), 'https://a.example/y');
  assert.equal(f('=HYPERLINK("http://a.example/x","label")'), null);
  assert.equal(f('=HYPERLINK("javascript:alert(1)","label")'), null);
  assert.equal(f('=HYPERLINK(A1,"label")'), null);
  assert.equal(f(''), null);
  const h = s => ctx.httpsOnly_(s);
  assert.equal(h(' https://drive.google.com/file/d/x/view?usp=sharing '), 'https://drive.google.com/file/d/x/view?usp=sharing');
  assert.equal(h('HTTPS://EXAMPLE.ORG/A'), 'HTTPS://EXAMPLE.ORG/A');
  assert.equal(h('https://example.org:8443/a'), 'https://example.org:8443/a');
  for (const bad of ['http://example.org', 'javascript:alert(1)', 'data:text/html,x', '//example.org', 'https:///x',
    'https://user@evil.example/', 'https://example.org/a b', 'https://example.org/"x"', 'https://example.org/<x>', null, 42, '']) {
    assert.equal(h(bad), null, String(bad));
  }
});

test('raw ISBN digits', () => {
  const { ctx } = env();
  const r = v => ctx.isbnRawText_(v);
  assert.equal(r(9798891808546), '9798891808546');
  assert.equal(r(8174508355), '8174508355');
  assert.equal(r('817450835X'), '817450835X');
  assert.equal(r('817450835x'), '817450835X');
  assert.equal(r('978-0-06-112008-4'), '9780061120084');
  assert.equal(r('ISBN 978-0-06-112008-4'), '9780061120084');
  assert.equal(r('ISBN-13: 978 0 06 112008 4'), '9780061120084');
  assert.equal(r(123456789), '123456789', 'a 9-digit number (lost leading 0) is kept; the page restores the 0');
  // E2-05: only one whole ISBN (9, 10 or 13 characters). Several ISBNs in a cell are left to the page, which splits the display.
  for (const bad of [9.5, -3, '', '978-0-06-112008-4, 978-0-06-112009-1', 'unknown', null, undefined, true,
    '9780394747231\n9780679748403', '9780062498533 9780062498540', '0394747231 9780679748403', '12345', 12345, 978039474723, '97803947472311']) {
    assert.equal(r(bad), '', JSON.stringify(bad));
  }
});

test('a cell with two ISBNs sends no raw value, and the page finds both ISBNs as on the CSV path', { skip: noEngine }, () => {
  const sheets = defaultSheets();
  sheets[0].grid[5][2] = '9780394747231\n9780679748403';   // row 6, ISBN column: two ISBNs on two lines (a text cell)
  const { json } = env({ sheets }).get();
  const row6 = json.tabs[0].rows.find(r => r.row === 6);
  assert.deepEqual(row6.raw, {});
  const { rows } = sheetJs.extractRows(sheetJs.tablesFromScript(json).tables[0], { schoolCode: 'UAS' });
  rows.forEach((row, i) => { row.id = i; });
  const ix = engine.buildIndex(rows);
  for (const isbn of ['9780394747231', '9780679748403']) {
    const hits = engine.search(isbn, ix).main.map(h => h.row.row);
    assert.deepEqual(hits, [6], `ISBN ${isbn}`);
  }
});

test('cache chunks never split a surrogate pair and rejoin exactly', () => {
  const { ctx } = env();
  const s = 'a'.repeat(99999) + '📚' + 'كتاب'.repeat(40000) + 'z';
  const chunks = [...ctx.splitForCache_(s)];
  assert.equal(chunks.join(''), s);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0], 'a'.repeat(99999), 'the 4-byte emoji moves whole to the next chunk');
  assert.ok(chunks.every(c => utf8Bytes(c) <= 100000));
  assert.deepEqual([...ctx.splitForCache_('{}')], ['{}']);
});

// ------------------------------------------------------------------------------------------------
// Static checks: source, manifest, README

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');
}

test('Code.gs calls no write, Drive, network, mail or logging API', () => {
  const src = stripComments(CODE);
  const writes = src.match(/\.(set(?!MimeType\b)\w+|insert\w*|delete\w*|clear\w*|append\w*|copy\w*|move\w*|remove\w*|protect\w*|hide\w*|show\w*|activate\w*|merge\w*|breakApart|create(?!TextOutput\b)\w*|add[A-Z]\w*|duplicate\w*|trimWhitespace|auto[A-Z]\w*|flush)\s*\(/g);
  assert.equal(writes, null, `write-type calls found: ${writes}`);
  const services = src.match(/\b(DriveApp|UrlFetchApp|MailApp|GmailApp|Logger|console|DocumentApp|FormApp|ScriptApp|Session|LockService|HtmlService|Utilities)\b/g);
  assert.equal(services, null, `unexpected services: ${services}`);
  assert.ok(!/\bfunction\s+doPost\b/.test(src), 'GET only');
  assert.ok(!/eval\s*\(|new Function/.test(src));
  const sheetsApi = src.match(/\bSheets\s*\.[\w.\s]*/g) || [];
  assert.deepEqual([...new Set(sheetsApi.map(x => x.replace(/\s/g, '')))], ['Sheets.Spreadsheets.get'], 'the Sheets service is used for Spreadsheets.get only');
});

test('no email address or spreadsheet id in the script or its README', () => {
  for (const [name, text] of [['Code.gs', CODE], ['README.md', README]]) {
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text), `${name} contains an email address`);
    const idLike = /(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}/;   // letters and digits, 40+ long
    assert.ok(!idLike.test(text.replace(/https?:\/\/\S+/g, '')), `${name} contains what looks like an id`);
  }
});

// AS-1: SpreadsheetApp.openById accepts only the spreadsheets scope (Google's reference lists no read-only scope for it);
// the script stays read-only because it calls getters only and its account has Viewer access (PRD, "Fallback path").
test('manifest: V8, the spreadsheets scope openById needs, Sheets service, web app runs as the deploying account for anyone', () => {
  assert.equal(MANIFEST.runtimeVersion, 'V8');
  assert.deepEqual(MANIFEST.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets']);
  assert.deepEqual(MANIFEST.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  assert.equal(MANIFEST.exceptionLogging, 'STACKDRIVER');
  assert.deepEqual(MANIFEST.dependencies, { enabledAdvancedServices: [{ userSymbol: 'Sheets', serviceId: 'sheets', version: 'v4' }] },
    'no libraries; one advanced service, Sheets, for the hidden-row flags');
  assert.ok(!README.includes('spreadsheets.readonly') && !/read-only permission/i.test(README), 'the README does not promise a read-only permission');
});

test('README covers the deployment steps a teacher needs', () => {
  for (const must of ['script.google.com', 'appsscript.json', 'SPREADSHEET_ID', 'TABS', 'CACHE_SECONDS', 'New deployment',
    'Web app', 'Execute as', 'Anyone', '/exec', '?script=', 'scriptUrl', 'config.js', 'Viewer', 'New version', 'Manage deployments',
    'Workspace', 'role account', '30', 'mapped columns']) {
    assert.ok(README.includes(must), `README should mention ${must}`);
  }
});

// ------------------------------------------------------------------------------------------------
// The page's adapter (src/sheet.js), when it exists

test('src/sheet.js accepts the script JSON and yields the right rows', { skip: noSheetJs }, () => {
  const json = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const conv = sheetJs.tablesFromScript(json);
  assert.deepEqual(conv.errors, []);
  assert.equal(conv.sheetId, SHEET_ID);
  assert.equal(conv.tables.length, 1);
  const table = conv.tables[0];
  assert.equal(table.tab, 'Sheet1');
  assert.equal(table.gid, '0');
  if (typeof sheetJs.extractRows !== 'function') return;
  const { rows, meta } = sheetJs.extractRows(table, { schoolCode: 'UAS' });
  const byRow = Object.fromEntries(rows.map(r => [r.row, r]));
  assert.deepEqual(rows.map(r => r.row), [4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(meta.headerRow, 3);
  assert.equal(meta.updatedAsOf, 'updated as of 1 January 2026');
  assert.equal(meta.bannerTitle, 'Test list');
  assert.equal(meta.lastCol, 'H');
  assert.equal(byRow[4].title, '101 Creepy Jokes');
  assert.equal(byRow[4].titleUrl, 'https://example.org/books/creepy-jokes');
  assert.equal(byRow[5].title, '1984');
  assert.equal(byRow[5].isbn, '9.79889E+12');
  assert.equal(byRow[5].isbnRaw, '9798891808546');
  assert.equal(byRow[5].memoUrl, 'https://drive.google.com/file/d/synthetic-memo-1/view');
  assert.equal(byRow[6].isbnRaw, '817450835X');
  assert.equal(byRow[6].memoUrl, 'https://drive.google.com/file/d/synthetic-memo-2/view');
  assert.equal(byRow[7].memoUrl, null);
  assert.equal(byRow[9].bannedBy, 'Ministry');
  assert.equal(byRow[9].status.level, 'ministry');
  assert.equal(byRow[10].hidden, true);
  assert.equal(byRow[11].hidden, true);
  assert.equal(byRow[4].hidden, false);
  for (const r of rows) {
    assert.equal(r.sheetId, SHEET_ID);
    assert.deepEqual(r.extra, [], 'the script returns no unmapped columns');
  }
});

test('Code.gs maps header rows exactly like src/sheet.js', { skip: noSheetJs || (typeof (sheetJs && sheetJs.tableFromCsv) !== 'function' ? 'src/sheet.js has no tableFromCsv' : false) }, () => {
  const { ctx } = env();
  const headerRows = [
    ['Title', 'Author', 'ISBN', 'Banned By', 'Type', 'Year of Banning', 'Memo', 'Status', ''],
    ['No.', 'Material', 'Author(s)', 'ISBN-13', 'Banned', 'Format', 'Year', 'Notes'],
    ['Name', 'Title', 'Writer', 'Material Type', 'Year Banned', 'Memo Link', 'Link'],
    ['Book Title', 'Authors', 'ISBNs', 'BannedBy', 'Media Type', 'Notes', 'Memo'],
    ['Title ', '  AUTHOR', 'isbn/ean', 'Banned by:', 'type', 'year of banning', 'notes'],
    ['Materials', 'Author Name', 'ISBN 10', 'Banned', 'Type of material', 'Year', 'Memos'],
  ];
  for (const header of headerRows) {
    const grid = [header, header.map(() => 'x')];
    const { meta } = sheetJs.extractRows(sheetJs.tableFromCsv(grid, { tab: 'T', gid: '0', sheetId: SHEET_ID }), { schoolCode: 'UAS' });
    const ours = plain(ctx.mapHeaders_(header.map(h => h.trim())));
    assert.deepEqual(ours, plain(meta.mapping), `mapping of ${JSON.stringify(header)}`);
    assert.equal(header.some(h => ctx.isTitleHeader_(h)), true);
  }
});

// Local only: the gitignored CSV exports of the live test copy, served through Code.gs as if the script read
// the sheet, must give the page the same rows as the CSV path. Skips when test/data/*.csv is absent (e.g. CI).
const LIVE = [
  { file: 'live-sheet1.csv', name: 'Sheet1', gid: 0 },
  { file: 'live-other.csv', name: 'Other Materials', gid: 1111920478 },
].map(t => ({ ...t, path: path.join(__dirname, 'data', t.file) }));
const noLive = !sheetJs ? noSheetJs
  : typeof sheetJs.parseCsv !== 'function' || typeof sheetJs.tableFromCsv !== 'function' || typeof sheetJs.extractRows !== 'function'
    ? 'src/sheet.js lacks parseCsv/tableFromCsv/extractRows'
    : LIVE.every(t => fs.existsSync(t.path)) ? false : 'sample CSVs (gitignored) not present';

test('sample sheet via Code.gs gives the page the same rows as the CSV path', { skip: noLive }, () => {
  const tabs = LIVE.map(t => ({ ...t, grid: sheetJs.parseCsv(fs.readFileSync(t.path, 'utf8')) }));
  const width = Math.max(...tabs.flatMap(t => t.grid.map(r => r.length)));
  const sheets = tabs.map(t => ({ name: t.name, gid: t.gid, grid: t.grid.map(r => [...r, ...Array(width - r.length).fill('')]) }));
  const { json, body } = env({ sheets, props: { SPREADSHEET_ID: SHEET_ID, TABS: LIVE.map(t => t.gid).join(',') } }).get();
  assert.deepEqual(json.errors, []);
  assert.deepEqual(json.tabs.map(t => t.name), ['Sheet1', 'Other Materials']);
  assert.ok(!/Notes:/.test(body), 'the Sheet1 notes box (headerless column) is not returned');
  const core = r => ({ row: r.row, title: r.title, author: r.author, isbn: r.isbn, bannedBy: r.bannedBy, type: r.type,
    year: r.year, memo: r.memo, section: r.section, status: r.status, lastCol: r.lastCol });
  const conv = sheetJs.tablesFromScript(json);
  assert.deepEqual(conv.errors, []);
  tabs.forEach((t, i) => {
    const viaCsv = sheetJs.extractRows(sheetJs.tableFromCsv(t.grid, { tab: t.name, gid: String(t.gid), sheetId: SHEET_ID }), { schoolCode: 'UAS' });
    const viaScript = sheetJs.extractRows(conv.tables[i], { schoolCode: 'UAS' });
    assert.ok(viaCsv.rows.length > 0);
    assert.deepEqual(viaScript.rows.map(core), viaCsv.rows.map(core), t.name);
    assert.equal(viaScript.meta.updatedAsOf, viaCsv.meta.updatedAsOf);
    assert.equal(viaScript.meta.headerRow, viaCsv.meta.headerRow);
    assert.ok(viaScript.rows.every(r => r.hidden === false), 'the script path knows rows are visible');
  });
});
