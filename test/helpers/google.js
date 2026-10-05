// Fakes for Google's side of the signed-in path, shared by the page tests: the Sheets API (answers shaped like
// spreadsheets.get, leaving zeros out as Google does) and Google Identity Services' token client. Synthetic data only;
// every token is a made-up string.
'use strict';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN = 'ya29.fake-test-token-not-real';
// Built from parts, so secret scanners don't mistake these made-up values for real ones.
const CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz012345' + '.apps.googleusercontent' + '.com';
const FAKE_SECRET = 'GOCSPX' + '-' + 'FAKE0TEST0not0real0'.padEnd(28, 'x');

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=UTF-8' } });
const apiError = (code, status, message, details) => json(code, { error: Object.assign({ code, status, message }, details ? { details } : {}) });

// A cell: a string as displayed, or { text, number (the value behind it), link (whole cell), runLink (part of the text),
// formula }.
function cellData(c) {
  if (c == null || c === '') return {};
  if (typeof c === 'string') return { formattedValue: c };
  const v = { formattedValue: c.text };
  if (c.number != null) v.effectiveValue = { numberValue: c.number };
  if (c.link) v.hyperlink = c.link;
  if (c.runLink) v.textFormatRuns = [{ format: {} }, { startIndex: 1, format: { link: { uri: c.runLink } } }];
  if (c.formula) v.userEnteredValue = { formulaValue: c.formula };
  return v;
}

const without0 = (o, k, v) => { if (v) o[k] = v; return o; };

// tab: { title, gid, hidden, rows: [[cell, …], …] from row 1, hiddenRows: [row numbers], merges: [[first row, rows, column index]] }
function gridSheet(tab) {
  const props = without0({ title: tab.title }, 'sheetId', Number(tab.gid));
  if (tab.hidden) props.hidden = true;
  const hidden = new Set(tab.hiddenRows || []);
  const rows = tab.rows || [];
  return {
    properties: props,
    merges: (tab.merges || []).map(([top, n, col]) => without0(without0({ sheetId: Number(tab.gid), endRowIndex: top - 1 + n, endColumnIndex: col + 1 },
      'startRowIndex', top - 1), 'startColumnIndex', col)),
    data: [{
      rowMetadata: rows.map((r, i) => (hidden.has(i + 1) ? { pixelSize: 21, hiddenByUser: true } : { pixelSize: 21 })),
      rowData: rows.map(r => ({ values: r.map(cellData) })),
    }],
  };
}

// A Sheets API for one spreadsheet. Returns a handler (url, init) -> Response, or null for any other address; it
// records its calls. opts.canView(token) decides who can view the sheet (default: the TOKEN); opts.answer(u, n) may
// answer instead (an error, say).
function sheetsApi(spreadsheetId, tabs, opts = {}) {
  const calls = [];
  const canView = opts.canView || (t => t === TOKEN);
  const handle = (url, init) => {
    const u = new URL(url);
    if (u.hostname !== 'sheets.googleapis.com') return null;
    calls.push({ url, init: init || {} });
    if (opts.answer) { const r = opts.answer(u, calls.length); if (r) return r; }
    const auth = init && init.headers ? init.headers.Authorization : '';
    const token = /^Bearer (\S+)$/.exec(auth || '');
    if (!token) return apiError(401, 'UNAUTHENTICATED', 'Request is missing required authentication credential.');
    const m = u.pathname.match(/^\/v4\/spreadsheets\/([^/]+)$/);
    if (!m || decodeURIComponent(m[1]) !== spreadsheetId) return apiError(404, 'NOT_FOUND', 'Requested entity was not found.');
    if (!canView(token[1])) return apiError(403, 'PERMISSION_DENIED', 'The caller does not have permission');
    if (u.searchParams.get('includeGridData') === 'true') {
      const titles = u.searchParams.getAll('ranges').map(r => r.replace(/^'([\s\S]*)'$/, '$1').replace(/''/g, "'"));
      return json(200, { sheets: tabs.filter(t => titles.includes(t.title)).map(gridSheet) });
    }
    return json(200, { sheets: tabs.map(t => ({ properties: gridSheet(t).properties })) });
  };
  handle.calls = calls;
  return handle;
}

// google.accounts.oauth2 as the page sees it. Each requestAccessToken answers (as a microtask, like a quick click
// through Google's window) with the next answer: { access_token, expires_in, scope }, { error }, or { popup: type }.
// The last answer repeats.
function fakeGis(answers = [{ access_token: TOKEN, expires_in: 3599, scope: SCOPE }]) {
  const queue = answers.slice();
  const requests = [];
  const oauth2 = {
    initTokenClient(cfg) {
      return {
        requestAccessToken(o) {
          requests.push({ clientId: cfg.client_id, scope: cfg.scope, prompt: o ? o.prompt : undefined });
          const a = queue.length > 1 ? queue.shift() : queue[0];
          Promise.resolve().then(() => (a.popup ? cfg.error_callback({ type: a.popup }) : cfg.callback(Object.assign({}, a))));
        },
      };
    },
    hasGrantedAllScopes: (resp, scope) => String(resp.scope || '').split(' ').includes(scope),
  };
  return { accounts: { oauth2 }, requests };
}

module.exports = { SCOPE, TOKEN, CLIENT_ID, FAKE_SECRET, json, apiError, gridSheet, sheetsApi, fakeGis };
