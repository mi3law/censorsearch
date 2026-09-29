// CensorSearch page controller (browser only). Picks the source, loads the sheet through CensorSheet (src/sheet.js),
// builds the index and searches through CensorEngine (src/engine.js), and renders every state described in PRD.md.
//
// Safety rules kept throughout: cell text only ever reaches the page as text nodes (textContent / append(string));
// links are made only from https URLs and open with rel="noopener noreferrer"; nothing is stored (no storage APIs,
// no cookies), and the query never goes into the page address or over the network.
(function () {
  'use strict';

  const Sheet = window.CensorSheet;
  const Engine = window.CensorEngine;
  const cfg = Object.assign(
    { sheetUrl: '', tabs: [], scriptUrl: '', schoolCode: 'UAS', aliasesUrl: 'aliases.json', repoUrl: '' },
    window.CENSORSEARCH_CONFIG || {}
  );

  const LIMITS = { main: 50, possible: 25, isbnPrefix: 25 };
  const MINUTE = 60 * 1000;
  const REFRESH_AFTER = 5 * MINUTE;      // silent refresh while visible, and re-check a row before opening it
  const RELOAD_AFTER = 30 * MINUTE;      // reload on focus / returning to the tab
  const LONG_QUERY = 300;                // characters: above this, search after 400 ms or on Enter
  const DELAY = 150, LONG_DELAY = 400;
  const TEXT = {
    loading: 'Loading the list…',
    tooShort: 'Type at least 2 characters, or press Enter to search 1 character.',
    keepTyping: 'Keep typing…',
    truncated: 'Long text: matched on its first 12 main words.',
    noListing: 'No listing found. This does not mean the item is permitted.',
    network: "Can't read this sheet: it may not be shared by link, or a network filter may block Google.",
    isbnFallback: 'No ISBN match. Most rows have no ISBN, so search the title and author.',
    filterNote: "Extend the sheet's filter to cover the Memo column (A:G) so sorting keeps memos beside their titles.",
  };
  const FIELD_NAMES = { title: 'title', author: 'author', isbn: 'ISBN', memo: 'memo', type: 'type', bannedBy: 'Banned By' };

  const $ = id => document.getElementById(id);
  const ui = {
    box: $('q'), form: $('search-form'),
    status: $('status'), warning: $('status-warning'), actions: $('status-actions'), source: $('source'),
    filterBox: $('filter-box'), filterSummary: $('filter-summary'), filterCodes: $('filter-codes'),
    filterAll: $('filter-all'), filterNone: $('filter-none'),
    notice: $('notice'), summary: $('summary'), results: $('results'),
    notes: $('maintainer-notes'), notesSummary: $('maintainer-summary'), notesList: $('maintainer-list'),
    footerSheet: $('footer-sheet'), footerRepo: $('footer-repo'),
  };

  const state = {
    source: null,          // what CensorSheet.load reads
    overridden: false,     // ?sheet= or ?script= in the page address
    phase: 'loading',      // 'config' | 'loading' | 'loaded' | 'partial' | 'failed'
    configError: '',
    failure: null,         // { errors, sheetId } when nothing loaded
    data: null,            // { rows, tabs, errors, issues, fetchedAt, sheetId, signature }
    index: null,
    loading: null,         // in-flight load promise
    manualRetry: false,
    refreshError: null,    // { at: Date } when a background refresh failed and old data is kept
    aliases: null,
    aliasesPromise: null,
    codes: [], codeInputs: new Map(), unticked: new Set(),
    run: null,             // last search: { kind: 'single'|'multi', value, result | lines }
    enter: false,
    debounce: 0,
    expanded: new Set(), expandedFor: null,
    sectionEls: new Map(), // expansion key -> section element (for focus after "Show all")
    moves: new Map(),      // gid + fp + newRow -> { from, to }
    shown: [],             // rows rendered by the last render (for row-move detection)
    linkRows: [],          // [{ el, row }] row links rendered by the last render
  };
  const linkRow = new WeakMap();

  // ---------------------------------------------------------------------------------------------
  // Small helpers

  function el(tag, attrs) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : String(c));   // strings become text nodes
    }
    return node;
  }

  function httpsUrl(u) {
    if (typeof u !== 'string') return null;
    const s = u.trim();
    if (!/^https:\/\//i.test(s)) return null;
    try {
      const url = new URL(s);
      return url.protocol === 'https:' && url.hostname ? url.href : null;
    } catch (e) { return null; }
  }

  // An external link, only for https URLs; content may be a string or nodes.
  function extLink(url, content, cls) {
    const href = httpsUrl(url);
    if (!href) return null;
    const a = el('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls || null });
    a.append(content instanceof Node ? content : String(content));
    return a;
  }

  function defaultPageLink(label) {
    return el('a', { href: location.pathname }, label);
  }

  const pad2 = n => String(n).padStart(2, '0');
  const hhmm = d => (d instanceof Date && !isNaN(d) ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : '');
  const fmtInt = n => Number(n || 0).toLocaleString('en-US');
  const plural = (n, one, many) => fmtInt(n) + ' ' + (n === 1 ? one : many);
  const arr = v => (Array.isArray(v) ? v : []);
  const str = v => (v == null ? '' : String(v));
  const sentence = s => { const t = str(s).trim(); return !t || /[.!?…]$/.test(t) ? t : t + '.'; };
  const stripStop = s => str(s).trim().replace(/[.]+$/, '');
  const lcFirstUpdated = s => str(s).trim().replace(/^Updated\b/, 'updated');
  const foldCodes = s => str(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const codesOf = row => (row && row.status && Array.isArray(row.status.codes) ? row.status.codes : []);
  const fpOf = row => str(row.fingerprint) || (typeof Sheet.fingerprint === 'function' ? Sheet.fingerprint(row) : [row.title, row.author, row.bannedBy, row.year].join('|'));
  const ageMs = () => (state.data && state.data.fetchedAt instanceof Date ? Date.now() - state.data.fetchedAt.getTime() : 0);

  function listText(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  function nearest(rowNumbers, target) {
    let best = null;
    for (const n of rowNumbers) if (best == null || Math.abs(n - target) < Math.abs(best - target)) best = n;
    return best;
  }

  // Appends text to parent with <mark> around the given [start, end) ranges (sorted, merged, clamped).
  function appendHighlighted(parent, text, ranges) {
    const s = str(text);
    const rs = arr(ranges)
      .filter(r => Array.isArray(r) && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1])))
      .map(r => [Math.max(0, Math.min(s.length, Math.floor(Number(r[0])))), Math.max(0, Math.min(s.length, Math.floor(Number(r[1]))))])
      .filter(r => r[1] > r[0])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const r of rs) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    let pos = 0;
    for (const [a, b] of merged) {
      if (a > pos) parent.append(s.slice(pos, a));
      parent.append(el('mark', null, s.slice(a, b)));
      pos = b;
    }
    if (pos < s.length) parent.append(s.slice(pos));
  }

  // ---------------------------------------------------------------------------------------------
  // Source selection: ?script= > ?sheet= > config.scriptUrl > config.sheetUrl + config.tabs

  function chooseSource() {
    const params = new URLSearchParams(location.search);
    if (params.has('script')) {
      const url = Sheet.parseScriptUrl(params.get('script') || '');
      if (!url) return { error: "This page's address asks to read an Apps Script link that isn't an Apps Script web app link (https://script.google.com/macros/s/…/exec), so there is nothing to search.", overridden: true };
      return { source: { kind: 'script', url, tabs: null }, overridden: true };
    }
    if (params.has('sheet')) {
      const p = Sheet.parseSheetUrl(params.get('sheet') || '');
      if (!p) return { error: "This page's address asks to read a sheet link that isn't a Google Sheets link (https://docs.google.com/spreadsheets/d/…), so there is nothing to search.", overridden: true };
      // A pasted link's own #gid=… or &gid=… can end up in this page's address instead of inside ?sheet=.
      const pageGid = params.get('gid') || new URLSearchParams(location.hash.replace(/^#/, '')).get('gid');
      const gid = p.gid || (/^\d{1,12}$/.test(pageGid || '') ? pageGid : '0');
      return { source: { kind: 'csv', sheetId: p.id, tabs: [{ gid, name: null }] }, overridden: true };
    }
    if (cfg.scriptUrl) {
      const url = Sheet.parseScriptUrl(String(cfg.scriptUrl));
      if (!url) return { error: 'The scriptUrl in config.js is not an Apps Script web app link (https://script.google.com/macros/s/…/exec).' };
      return { source: { kind: 'script', url, tabs: null }, overridden: false };
    }
    const p = Sheet.parseSheetUrl(String(cfg.sheetUrl || ''));
    if (!p) return { error: 'The sheetUrl in config.js is not a Google Sheets link.' };
    const tabs = arr(cfg.tabs).filter(t => t && t.gid != null).map(t => ({ gid: String(t.gid), name: t.name ? String(t.name) : null }));
    return { source: { kind: 'csv', sheetId: p.id, tabs: tabs.length ? tabs : [{ gid: p.gid || '0', name: null }] }, overridden: false };
  }

  // ---------------------------------------------------------------------------------------------
  // Loading

  async function loadAliases() {
    if (!cfg.aliasesUrl) return null;
    try {
      const url = new URL(String(cfg.aliasesUrl), location.href);
      if (url.origin !== location.origin) throw new Error('aliasesUrl must be on the same site as the page');
      const res = await fetch(url.href, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json || !Array.isArray(json.aliases)) throw new Error('no "aliases" list');
      return json;
    } catch (e) {
      console.warn('CensorSearch: continuing without aliases (' + (e && e.message ? e.message : e) + ')');
      return null;
    }
  }

  function signatureOf(rows, tabs) {
    return JSON.stringify([
      rows.map(r => [r.tab, r.gid, r.row, r.title, r.author, r.isbn, r.isbnRaw, r.bannedBy, r.type, r.year, r.memo,
        r.memoUrl, r.titleUrl, r.hidden, r.section, r.extra, r.status && r.status.label, r.lastCol]),
      tabs.map(t => [t.tab, t.gid]),
    ]);
  }

  // Loads (or reloads) the list. Background loads keep the current data on screen until new data is ready,
  // and keep it if the new load fails. Resolves true when usable data is in place afterwards and fresh.
  function reload(opts) {
    if (state.loading) return state.loading;
    const background = !!(opts && opts.background) && !!state.data;
    state.manualRetry = !!(opts && opts.manual) && background;
    if (!background) { state.phase = 'loading'; renderStatus(); renderResults(); }
    else if (state.manualRetry) renderStatus();
    state.loading = doLoad(background).finally(() => { state.loading = null; state.manualRetry = false; });
    return state.loading;
  }

  async function doLoad(background) {
    const before = state.shown.map(r => ({ gid: str(r.gid), fp: fpOf(r), row: r.row }));
    let result;
    try {
      result = await Sheet.load(state.source, { fetch: window.fetch.bind(window), schoolCode: cfg.schoolCode });
    } catch (e) {
      result = { rows: [], tabs: [], issues: [], errors: [{ tab: null, message: e && e.message ? e.message : String(e), kind: 'network' }] };
    }
    if (state.aliasesPromise) { state.aliases = await state.aliasesPromise; state.aliasesPromise = null; }

    state.manualRetry = false;
    const rows = arr(result && result.rows);
    const tabs = arr(result && result.tabs);
    const errors = arr(result && result.errors);
    const issues = arr(result && result.issues);
    const fetchedAt = result && result.fetchedAt instanceof Date && !isNaN(result.fetchedAt) ? result.fetchedAt : new Date();
    const sheetId = (result && result.sheetId) || state.source.sheetId || null;

    if (background) {
      // Keep the old data unless every tab it had loaded again.
      const had = state.data.tabs.map(t => str(t.gid));
      const got = new Set(tabs.map(t => str(t.gid)));
      if (!rows.length || !had.every(g => got.has(g))) {
        state.refreshError = { at: new Date() };
        renderStatus();
        return false;
      }
    }
    if (!rows.length) {
      state.data = null; state.index = null; state.shown = []; state.linkRows = [];
      state.phase = 'failed';
      state.failure = { errors, sheetId };
      renderStatus(); renderSource(); renderNotes(); ui.filterBox.hidden = true;
      renderResults();
      return false;
    }

    const signature = signatureOf(rows, tabs);
    if (state.data && state.index && signature === state.data.signature) {
      // Same content: keep the rendered results (and their elements) and just note the new fetch time.
      Object.assign(state.data, { tabs, errors, issues, fetchedAt, sheetId });
      state.phase = errors.length ? 'partial' : 'loaded';
      state.refreshError = null;
      renderStatus(); renderSource(); renderNotes();
      return true;
    }

    let index;
    try {
      index = Engine.buildIndex(rows, state.aliases ? { aliases: state.aliases } : {});
    } catch (e) {
      console.error(e);
      if (background) { state.refreshError = { at: new Date() }; renderStatus(); return false; }
      state.data = null; state.index = null; state.phase = 'failed';
      state.failure = { errors: [{ tab: null, message: "Couldn't prepare the search: " + (e && e.message ? e.message : e), kind: 'index' }], sheetId };
      renderStatus(); renderResults();
      return false;
    }

    state.data = { rows, tabs, errors, issues, fetchedAt, sheetId, signature };
    state.index = index;
    state.phase = errors.length ? 'partial' : 'loaded';
    state.refreshError = null;
    state.failure = null;
    computeMoves(before, rows);
    rebuildFilter();
    renderStatus(); renderSource(); renderNotes();
    if (ui.box.value.trim()) runSearch(state.enter, { keepNotice: true });
    else { state.run = null; renderResults(); }
    return true;
  }

  // Notes "moved from row 7 to 8" for rows shown before this reload that now sit at another row of the same tab.
  function computeMoves(before, rows) {
    const byKey = new Map();
    for (const r of rows) {
      const k = str(r.gid) + '\u0000' + fpOf(r);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r.row);
    }
    const moves = new Map();
    for (const b of before) {
      const cands = byKey.get(b.gid + '\u0000' + b.fp);
      if (!cands || cands.includes(b.row)) continue;
      const to = nearest(cands, b.row);
      moves.set(b.gid + '\u0000' + b.fp + '\u0000' + to, { from: b.row, to });
    }
    state.moves = moves;
  }

  function moveOf(row) {
    return state.moves.get(str(row.gid) + '\u0000' + fpOf(row) + '\u0000' + row.row) || null;
  }

  // ---------------------------------------------------------------------------------------------
  // Status line, source line, maintainer notes

  function retryButton() {
    const b = el('button', { type: 'button' }, 'Retry');
    b.addEventListener('click', () => {
      b.disabled = true;
      reload(state.data ? { background: true, manual: true } : {});
    });
    return b;
  }

  function sheetLinkUrl() {
    const sheetId = (state.data && state.data.sheetId) || (state.failure && state.failure.sheetId) || (state.source && state.source.sheetId);
    if (!sheetId) return null;
    const tabs = state.data && state.data.tabs.length ? state.data.tabs : arr(state.source && state.source.tabs);
    return Sheet.sheetUrl(sheetId, tabs.length ? tabs[0].gid : null);
  }

  function tabRowCount(gid) {
    let n = 0;
    for (const r of state.data.rows) if (str(r.gid) === str(gid)) n++;
    return n;
  }

  function loadedText() {
    const d = state.data;
    let t = plural(d.rows.length, 'item', 'items');
    if (d.tabs.length > 1) t += ' (' + d.tabs.map(tb => tb.tab + ' ' + fmtInt(tabRowCount(tb.gid))).join(', ') + ')';
    const upd = d.tabs.filter(tb => tb.updatedAsOf && str(tb.updatedAsOf).trim());
    if (upd.length && d.tabs.length === 1) t += ' · ' + lcFirstUpdated(upd[0].updatedAsOf) + ' (from the sheet)';
    else if (upd.length) t += ' · ' + upd.map(tb => tb.tab + ' ' + lcFirstUpdated(tb.updatedAsOf)).join(', ') + ' (from the sheet)';
    t += ' · fetched ' + hhmm(d.fetchedAt);
    return t;
  }

  function failureText(errors) {
    if (!errors.length) return "The sheet loaded, but no listed items were found under a Title header, so there is nothing to search.";
    if (errors.every(e => e.kind === 'network')) {
      const msgs = [...new Set(errors.map(e => sentence(e.message)))];
      return msgs.length === 1 && msgs[0] ? msgs[0] : TEXT.network;
    }
    const msgs = [...new Set(errors.map(e => sentence(e.message)))];
    if (msgs.length === 1) return "Can't load the list. " + msgs[0];
    return "Can't load the list. " + errors.map(e => (e.tab ? e.tab + ': ' : '') + sentence(e.message)).join(' ');
  }

  function renderStatus() {
    ui.warning.textContent = '';
    ui.actions.replaceChildren();
    ui.actions.hidden = true;
    const showActions = (...nodes) => { ui.actions.append(...nodes.filter(Boolean)); ui.actions.hidden = false; };

    if (state.phase === 'config') {
      ui.status.textContent = state.configError;
      if (state.overridden) showActions(defaultPageLink('Use the default list'));
      return;
    }
    if (state.phase === 'loading') { ui.status.textContent = TEXT.loading; return; }
    if (state.phase === 'failed') {
      const f = state.failure || { errors: [] };
      ui.status.textContent = failureText(arr(f.errors));
      const url = sheetLinkUrl();
      showActions(retryButton(), url ? ' ' : null, url ? extLink(url, 'Open the sheet') : null,
        state.overridden ? ' · ' : null, state.overridden ? defaultPageLink('Use the default list') : null);
      return;
    }
    ui.status.textContent = loadedText();
    const warn = [];
    const d = state.data;
    if (d.errors.length) {
      const loaded = d.tabs.map(t => t.tab);
      warn.push('Loaded ' + listText(loaded) + "; couldn't load " +
        d.errors.map(e => (e.tab || 'a tab') + ': ' + stripStop(e.message)).join('; ') + '.');
    }
    if (state.manualRetry) warn.push('Checking the sheet again…');
    else if (state.refreshError) warn.push("Couldn't refresh at " + hhmm(state.refreshError.at) + '; showing data fetched at ' + hhmm(d.fetchedAt) + '.');
    if (warn.length) {
      ui.warning.textContent = warn.join(' ');
      showActions(retryButton());
    }
  }

  function renderSource() {
    const s = state.source;
    ui.source.replaceChildren();
    if (!s) return;
    const tabs = state.data && state.data.tabs.length
      ? state.data.tabs.map(t => t.tab)
      : arr(s.tabs).map(t => t.name).filter(Boolean);
    const url = sheetLinkUrl();
    ui.source.append('Reading ');
    if (tabs.length) ui.source.append(listText(tabs), ' of ');
    ui.source.append(url ? extLink(url, 'this Google Sheet') : 'the Google Sheet');
    if (s.kind === 'script') ui.source.append(' through its Apps Script web app');
    if (state.overridden) ui.source.append(", as this page's address asks. ", defaultPageLink('Use the default list'), '.');
    else ui.source.append('.');

    if (url) {
      ui.footerSheet.href = url;
      ui.footerSheet.target = '_blank';
      ui.footerSheet.rel = 'noopener noreferrer';
      ui.footerSheet.hidden = false;
    } else ui.footerSheet.hidden = true;
  }

  function renderNotes() {
    const issues = state.data ? arr(state.data.issues) : [];
    ui.notesList.replaceChildren();
    for (const i of issues) {
      const where = (i.tab || 'Sheet') + (i.row != null ? ' row ' + i.row : '');
      ui.notesList.append(el('li', null, where + ': ' + str(i.message)));
    }
    ui.notesList.append(el('li', null, TEXT.filterNote));
    ui.notesSummary.textContent = "Notes for the list's maintainers (" + (issues.length + 1) + ')';
    ui.notes.hidden = !state.data;
  }

  // ---------------------------------------------------------------------------------------------
  // Banned By filter

  function rebuildFilter() {
    const counts = new Map();
    for (const r of state.data.rows) for (const c of codesOf(r)) counts.set(c, (counts.get(c) || 0) + 1);
    state.codes = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
    for (const c of [...state.unticked]) if (!counts.has(c)) state.unticked.delete(c);
    ui.filterCodes.replaceChildren();
    state.codeInputs = new Map();
    state.codes.forEach((code, i) => {
      const id = 'code-' + i;
      const input = el('input', { type: 'checkbox', id });
      input.checked = !state.unticked.has(code);
      input.addEventListener('change', () => {
        if (input.checked) state.unticked.delete(code); else state.unticked.add(code);
        updateFilterSummary();
        renderResults();
      });
      state.codeInputs.set(code, input);
      ui.filterCodes.append(el('div', { class: 'code' }, input, ' ',
        el('label', { for: id }, code, el('span', { class: 'count' }, ' (' + fmtInt(counts.get(code)) + ')'))));
    });
    ui.filterBox.hidden = state.codes.length === 0;
    updateFilterSummary();
  }

  function updateFilterSummary() {
    const n = state.codes.length, off = state.unticked.size;
    ui.filterSummary.textContent = off
      ? 'Filter by Banned By: ' + fmtInt(off) + ' of ' + plural(n, 'code', 'codes') + ' unticked'
      : 'Filter by Banned By (all ' + plural(n, 'code', 'codes') + ' shown)';
  }

  function setAllCodes(on) {
    if (on) state.unticked.clear(); else state.codes.forEach(c => state.unticked.add(c));
    for (const input of state.codeInputs.values()) input.checked = on;
    updateFilterSummary();
    renderResults();
  }

  // A hit is hidden only when its row has codes and none of them is ticked; blank Banned By rows always show.
  function isVisible(hit) {
    const codes = codesOf(hit.row);
    return !codes.length || codes.some(c => !state.unticked.has(c));
  }

  function splitHidden(hits) {
    const shown = [];
    let hidden = 0;
    for (const h of arr(hits)) { if (h && h.row) { if (isVisible(h)) shown.push(h); else hidden++; } }
    return { shown, hidden };
  }

  // ---------------------------------------------------------------------------------------------
  // Searching

  function normResult(r) {
    const o = r || {};
    return {
      state: o.state || 'ok', query: o.query, truncated: !!o.truncated, isbnQuery: !!o.isbnQuery,
      main: arr(o.main), possible: arr(o.possible), isbnPrefix: arr(o.isbnPrefix), hints: arr(o.hints).filter(h => h && h.text),
    };
  }

  function safeSearch(query, enter) {
    try {
      return normResult(Engine.search(query, state.index, { enter: !!enter }));
    } catch (e) {
      console.error(e);
      return { state: 'error', message: e && e.message ? e.message : String(e), main: [], possible: [], isbnPrefix: [], hints: [] };
    }
  }

  function runSearch(enter, opts) {
    clearTimeout(state.debounce);
    state.enter = !!enter;
    if (!(opts && opts.keepNotice)) clearNotice();
    const value = ui.box.value;
    if (value !== state.expandedFor) { state.expanded.clear(); state.expandedFor = value; }
    if (!state.index) { state.run = null; renderResults(); return; }   // never search an empty dataset
    const lines = arr(Engine.splitLines(value));
    if (lines.length >= 2) {
      state.run = { kind: 'multi', value, lines: lines.map(line => ({ line, result: safeSearch(line, true) })) };
    } else {
      state.run = { kind: 'single', value, result: safeSearch(value, state.enter) };
    }
    renderResults();
  }

  function onInput() {
    autoGrow();
    clearTimeout(state.debounce);
    state.enter = false;
    const v = ui.box.value;
    if (!v.trim()) { runSearch(false); return; }
    state.debounce = setTimeout(() => runSearch(false), v.length > LONG_QUERY ? LONG_DELAY : DELAY);
  }

  function autoGrow() {
    // Grow the box with its content (up to the CSS max-height), so a pasted list stays readable.
    ui.box.style.height = 'auto';
    ui.box.style.height = Math.max(ui.box.scrollHeight + 4, 0) + 'px';
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering results

  function clearNotice() {
    ui.notice.hidden = true;
    ui.notice.replaceChildren();
  }

  function setNotice(...nodes) {
    ui.notice.replaceChildren(...nodes.filter(Boolean).map(n => (n instanceof Node ? n : String(n))));
    ui.notice.hidden = false;
    ui.notice.focus();
  }

  function renderResults() {
    const out = ui.results;
    out.replaceChildren();
    state.shown = [];
    state.linkRows = [];
    state.sectionEls = new Map();
    ui.summary.textContent = '';
    if (!state.index) {
      if (state.phase === 'loading' && ui.box.value.trim()) {
        out.append(el('p', { class: 'hint' }, 'The list is still loading; your search will run as soon as it arrives.'));
      }
      return;
    }
    const run = state.run;
    if (!run) return;
    if (run.kind === 'multi') renderMulti(run, out);
    else renderSingle(run.result, out);
  }

  function hiddenNote(count, shownCount) {
    const p = el('p', { class: 'hidden-by-filter' });
    p.append(shownCount
      ? plural(count, 'more listing', 'more listings') + ' hidden by the Banned By filter.'
      : plural(count, 'listing', 'listings') + ' hidden by the Banned By filter.');
    const b = el('button', { type: 'button' }, 'Show them');
    b.addEventListener('click', () => {
      setAllCodes(true);
      const first = ui.results.querySelector('.card');
      if (first) first.focus();
    });
    p.append(' ', b);
    return p;
  }

  // Engine hints; for an ISBN search with no hit at all, the ISBN hint leads (the engine's, or ours if it gave none).
  function hintList(res, noHits) {
    const texts = [];
    const hints = arr(res.hints);
    if (res.isbnQuery && noHits && !hints.some(h => h.code === 'isbnNoMatch')) texts.push(TEXT.isbnFallback);
    for (const h of hints) texts.push(str(h.text));
    return [...new Set(texts.filter(Boolean))];
  }

  function noResults(res) {
    const box = el('div', { class: 'no-results', role: 'region', 'aria-label': 'No listing found' });
    box.append(el('p', { class: 'no-results-head' }, el('strong', null, TEXT.noListing)));
    const fetched = state.data ? ' (the list was fetched at ' + hhmm(state.data.fetchedAt) + ')' : '';
    box.append(el('p', null, 'The list may name it with another spelling, title or edition, or the sheet may have changed since this page loaded' + fetched + '.'));
    box.append(el('p', null, 'Try:'));
    box.append(el('ul', null,
      el('li', null, "the author's surname alone"),
      el('li', null, 'one distinctive word from the title'),
      el('li', null, 'the ISBN')));
    const hints = hintList(res, true);
    if (hints.length) box.append(el('ul', { class: 'hints' }, ...hints.map(h => el('li', null, h))));
    const url = sheetLinkUrl();
    if (url) box.append(el('p', null, 'The sheet is the source of truth: ', extLink(url, 'open the sheet'), '.'));
    return box;
  }

  function renderSingle(res, out) {
    if (res.state === 'error') {
      out.append(el('p', { class: 'warning' }, "Something went wrong with this search (" + res.message + "). Try other words, or search the sheet itself."));
      return;
    }
    if (res.state === 'empty') return;
    if (res.state === 'tooShort') { ui.summary.textContent = TEXT.tooShort; return; }

    const main = splitHidden(res.main), possible = splitHidden(res.possible), prefix = splitHidden(res.isbnPrefix);
    const shown = main.shown.length + possible.shown.length + prefix.shown.length;
    const hidden = main.hidden + possible.hidden + prefix.hidden;

    const summary = [];
    if (res.state === 'stopwordsOnly') summary.push(TEXT.keepTyping);
    if (main.shown.length) summary.push(plural(main.shown.length, 'listing found', 'listings found'));
    if (possible.shown.length) summary.push(plural(possible.shown.length, 'possible match', 'possible matches'));
    if (prefix.shown.length) summary.push(plural(prefix.shown.length, 'ISBN starting with these digits', 'ISBNs starting with these digits'));
    if (hidden) summary.push((shown ? '' : 'No listing shown; ') + fmtInt(hidden) + ' hidden by the Banned By filter');
    if (!shown && !hidden && res.state === 'ok') summary.push('No listing found.');
    ui.summary.textContent = summary.join(' · ');

    if (res.truncated) out.append(el('p', { class: 'note' }, TEXT.truncated));
    if (hidden) out.append(hiddenNote(hidden, shown));

    if (main.shown.length) {
      out.append(section({ key: 'main', title: 'Listings found', hits: main.shown, limit: LIMITS.main, level: 2, noun: 'listings' }));
    }
    if (possible.shown.length) {
      out.append(section({
        key: 'possible', title: 'Possible matches', hits: possible.shown, limit: LIMITS.possible, level: 2, noun: 'possible matches',
        intro: main.shown.length
          ? 'These rows share some of your words. Open each one to check.'
          : 'No row matches every word, but these rows share some of your words. Open each one to check.',
      }));
    }
    if (prefix.shown.length) {
      out.append(section({
        key: 'isbnPrefix', title: 'ISBN starts with…', hits: prefix.shown, limit: LIMITS.isbnPrefix, level: 2, noun: 'rows',
        intro: 'Rows whose ISBN begins with the digits typed so far.',
      }));
    }
    if (!shown && !hidden && res.state === 'ok') out.append(noResults(res));
    else if (shown && !main.shown.length && res.state === 'ok') {
      const hints = hintList(res, false);
      if (hints.length) out.append(el('ul', { class: 'hints' }, ...hints.map(h => el('li', null, h))));
    }
  }

  function renderMulti(run, out) {
    let withMatches = 0, possibleOnly = 0, without = 0;
    const blocks = run.lines.map((ln, i) => {
      const res = ln.result;
      const main = splitHidden(res.main), possible = splitHidden(res.possible), prefix = splitHidden(res.isbnPrefix);
      const shown = main.shown.length + possible.shown.length + prefix.shown.length;
      const hidden = main.hidden + possible.hidden + prefix.hidden;
      if (main.shown.length) withMatches++;
      else if (shown) possibleOnly++;
      else without++;

      const id = 'line-' + (i + 1);
      const sec = el('section', { class: 'line', 'aria-labelledby': id });
      sec.append(el('h2', { id }, 'Line ' + (i + 1) + ': “' + ln.line + '”'));
      const counts = [];
      if (main.shown.length) counts.push(plural(main.shown.length, 'listing found', 'listings found'));
      if (possible.shown.length) counts.push(plural(possible.shown.length, 'possible match', 'possible matches'));
      if (prefix.shown.length) counts.push(plural(prefix.shown.length, 'ISBN starting with these digits', 'ISBNs starting with these digits'));
      if (hidden && !shown) counts.push('No listing shown');
      if (counts.length) sec.append(el('p', { class: 'line-count' }, counts.join(' · ')));

      if (res.state === 'error') sec.append(el('p', { class: 'warning' }, 'Something went wrong with this line (' + res.message + ').'));
      if (res.truncated) sec.append(el('p', { class: 'note' }, TEXT.truncated));
      if (hidden) sec.append(hiddenNote(hidden, shown));
      if (main.shown.length) appendHits(sec, 'l' + i + ':main', main.shown, LIMITS.main, 3, 'listings');
      if (possible.shown.length) {
        sec.append(section({ key: 'l' + i + ':possible', title: 'Possible matches', hits: possible.shown, limit: LIMITS.possible, level: 3, noun: 'possible matches' }));
      }
      if (prefix.shown.length) {
        sec.append(section({ key: 'l' + i + ':isbnPrefix', title: 'ISBN starts with…', hits: prefix.shown, limit: LIMITS.isbnPrefix, level: 3, noun: 'rows' }));
      }
      if (!shown && !hidden) {
        const box = el('div', { class: 'line-empty' }, el('p', null, el('strong', null, 'No listing found')));
        if (res.state === 'stopwordsOnly') box.append(el('p', { class: 'note' }, 'This line has only common words such as “the”.'));
        const hints = hintList(res, true);
        if (hints.length) box.append(el('ul', { class: 'hints' }, ...hints.map(h => el('li', null, h))));
        sec.append(box);
      }
      return sec;
    });

    const n = run.lines.length;
    let summary = n + ' lines: ' + fmtInt(withMatches) + ' with matches, ';
    if (possibleOnly) summary += fmtInt(possibleOnly) + ' with possible matches only, ';
    summary += fmtInt(without) + ' without';
    ui.summary.textContent = summary;
    if (without) {
      out.append(el('p', { class: 'note' },
        (without === 1 ? 'One line has' : fmtInt(without) + ' lines have') + ' no listing. ' + TEXT.noListing.replace(/^No listing found\. /, '')));
    }
    out.append(...blocks);
  }

  // A titled results section with its count, first `limit` hits and a "Show all N" control.
  function section(o) {
    const id = 'sec-' + o.key.replace(/[^A-Za-z0-9_-]/g, '-');
    const sec = el('section', { class: 'results-section', 'aria-labelledby': id });
    sec.append(el('h' + o.level, { id }, o.title + ' (' + fmtInt(o.hits.length) + ')'));
    if (o.intro) sec.append(el('p', { class: 'section-intro' }, o.intro));
    appendHits(sec, o.key, o.hits, o.limit, o.level + 1, o.noun);
    return sec;
  }

  function cutIndex(hits, limit) {
    if (hits.length <= limit) return hits.length;
    let cut = limit;
    const k = hits[cut - 1].groupKey;
    if (k) while (cut < hits.length && hits[cut].groupKey === k) cut++;   // never split a "Listed N times" group
    return cut;
  }

  function appendHits(parent, key, hits, limit, level, noun) {
    const expanded = state.expanded.has(key);
    const cut = expanded ? hits.length : cutIndex(hits, limit);
    const container = el('div', { class: 'hits' });
    renderHitList(container, hits.slice(0, cut), level);
    parent.append(container);
    state.sectionEls.set(key, container);
    if (cut < hits.length) {
      const b = el('button', { type: 'button' }, 'Show all ' + fmtInt(hits.length) + ' ' + noun);
      b.addEventListener('click', () => {
        state.expanded.add(key);
        renderResults();
        const again = state.sectionEls.get(key);
        const cards = again ? again.querySelectorAll('.card') : [];
        if (cards[cut]) cards[cut].focus();
      });
      parent.append(el('p', { class: 'more' }, 'Showing the first ' + fmtInt(cut) + ' of ' + fmtInt(hits.length) + '.', ' ', b));
    }
  }

  // Consecutive hits sharing a groupKey go in one "Listed N times" container (the engine puts the Ministry row first).
  function renderHitList(parent, hits, level) {
    for (let i = 0; i < hits.length;) {
      let j = i + 1;
      const k = hits[i].groupKey;
      if (k) while (j < hits.length && hits[j].groupKey === k) j++;
      if (j - i > 1) {
        const label = 'Listed ' + (j - i) + ' times';
        const g = el('div', { class: 'group', role: 'group', 'aria-label': label }, el('p', { class: 'group-head' }, label));
        for (let x = i; x < j; x++) g.append(card(hits[x], level));
        parent.append(g);
      } else parent.append(card(hits[i], level));
      i = j;
    }
  }

  function card(hit, level) {
    const row = hit.row;
    state.shown.push(row);
    const lvl = (row.status && row.status.level) || 'blank';
    const art = el('article', { class: 'card card-' + lvl + ' tier-' + (hit.tier || 'match'), tabindex: '-1' });
    const hl = hit.highlights || {};

    // Title (display form, highlighted) and the form as written when different
    const display = hit.display || {};
    const title = display.title != null ? str(display.title)
      : (typeof Engine.normalizeTitleForDisplay === 'function' ? str(Engine.normalizeTitleForDisplay(str(row.title))) : str(row.title));
    const asWritten = display.titleAsWritten != null ? str(display.titleAsWritten) : str(row.title);
    const h = el('h' + Math.min(level, 6), { class: 'card-title' });
    if (title.trim()) appendHighlighted(h, title, hl.title);
    else h.append(el('span', { class: 'missing' }, 'title not listed'));
    art.append(h);
    if (asWritten.trim() && asWritten !== title) art.append(el('p', { class: 'as-written' }, 'listed as “' + asWritten + '”'));

    // Author
    if (str(row.author).trim()) {
      const p = el('p', { class: 'author' });
      appendHighlighted(p, row.author, hl.author);
      art.append(p);
    } else art.append(el('p', { class: 'author missing' }, 'author not listed'));

    // Status from Banned By (plus the cell as written when the label doesn't already say it)
    const label = (row.status && row.status.label) || 'Status not stated, open the row';
    const st = el('p', { class: 'status status-' + lvl });
    st.append(lvl === 'ministry' || lvl === 'uas' ? el('strong', null, label) : label);
    const raw = str(row.bannedBy).trim();
    const codes = codesOf(row);
    const said = lvl === 'other' ? codes.join(' ') : codes.length === 1 ? codes[0] : '';
    if (raw && foldCodes(raw) !== foldCodes(said)) st.append(' ', el('span', { class: 'raw' }, '(Banned By: ' + raw + ')'));
    art.append(st);

    // Type · Year of Banning · ISBN
    const meta = el('p', { class: 'meta' });
    const bits = [];
    if (str(row.type).trim()) bits.push([el('span', { class: 'label' }, 'Type: '), row.type]);
    if (str(row.year).trim()) bits.push([el('span', { class: 'label' }, 'Year of Banning: '), row.year]);
    if (str(row.isbn).trim()) {
      const isbn = el('span', { class: 'isbn' });
      appendHighlighted(isbn, row.isbn, hl.isbn);
      const extra = row.isbnRaw && str(row.isbnRaw) !== str(row.isbn).trim() ? ' (exact value ' + row.isbnRaw + ')' : null;
      bits.push([el('span', { class: 'label' }, 'ISBN: '), isbn, extra]);
    }
    bits.forEach((b, i) => { if (i) meta.append(' · '); b.forEach(x => { if (x != null) meta.append(x); }); });
    if (bits.length) art.append(meta);

    // Memo (a link only when the path gave an https URL)
    const memoUrl = httpsUrl(row.memoUrl);
    if (str(row.memo).trim() || memoUrl) {
      const p = el('p', { class: 'memo' }, el('span', { class: 'label' }, 'Memo: '));
      const text = el('span');
      if (str(row.memo).trim()) appendHighlighted(text, row.memo, hl.memo); else text.append('open the memo');
      p.append(memoUrl ? extLink(memoUrl, text) : text);
      art.append(p);
    }
    const titleUrl = httpsUrl(row.titleUrl);
    if (titleUrl) art.append(el('p', { class: 'title-link' }, el('span', { class: 'label' }, 'Link in the title cell: '), extLink(titleUrl, 'open it')));

    // Other columns (e.g. Status, Reason) and the section heading the row sits under
    for (const x of arr(row.extra)) {
      if (!x || !str(x.value).trim()) continue;
      art.append(el('p', { class: 'extra' }, el('span', { class: 'label' }, str(x.header) + ': '), str(x.value)));
    }
    if (str(row.section).trim()) art.append(el('p', { class: 'section-name' }, el('span', { class: 'label' }, 'Under the heading: '), str(row.section)));

    // Why it matched
    const reasons = arr(hit.reasons).map(str).filter(Boolean);
    if (hit.tier === 'close' && reasons.length) art.append(el('p', { class: 'reasons' }, el('span', { class: 'badge' }, reasons.join('; '))));
    else if (hit.tier === 'possible') art.append(el('p', { class: 'reasons' }, 'Possible match: ' + (reasons.join('; ') || 'shares some of your words')));
    else if (reasons.length) art.append(el('p', { class: 'reasons' }, 'Why it matched: ' + reasons.join('; ')));
    const fields = arr(hit.fields).map(f => FIELD_NAMES[f] || f).filter(Boolean);
    if (fields.length) art.append(el('p', { class: 'matched-in' }, 'Matched in: ' + [...new Set(fields)].join(', ')));

    // Notes from the engine, and a row that moved since the page loaded
    const notes = arr(hit.notes).map(str).filter(Boolean);
    if (notes.length) art.append(el('ul', { class: 'notes' }, ...notes.map(n => el('li', null, n))));
    const moved = moveOf(row);
    if (moved) art.append(el('p', { class: 'moved' }, 'moved from row ' + moved.from + ' to ' + moved.to));

    // Where it is: "Sheet1 · row 16" as text, plus a link to that row
    const where = el('p', { class: 'where' }, str(row.tab) + ' · row ' + row.row);
    const link = extLink(Sheet.rowUrl(row.sheetId, row.gid, row.row, row.lastCol || 'G'), 'Open in the sheet', 'row-link');
    if (link) {
      link.append(el('span', { class: 'visually-hidden' }, ' (' + str(row.tab) + ' row ' + row.row + ')'));
      linkRow.set(link, row);
      state.linkRows.push({ el: link, row });
      where.append(' · ', link);
    }
    art.append(where);
    if (row.hidden === true) art.append(el('p', { class: 'hidden-flag' }, "may be hidden by the sheet's filter"));
    return art;
  }

  // ---------------------------------------------------------------------------------------------
  // Row links: when the data is 5+ minutes old, check the sheet again before opening a row

  async function checkAgain(link) {
    const row = linkRow.get(link);
    if (!row) return;
    const oldRow = row.row, gid = str(row.gid), fp = fpOf(row);
    link.textContent = 'Checking the sheet again…';
    link.setAttribute('aria-busy', 'true');
    const ok = await reload({ background: true });

    if (!ok) {
      const current = state.linkRows.find(e => e.row === row);
      const target = current ? current.el : link;
      target.removeAttribute('aria-busy');
      target.textContent = "Couldn't check again; open row " + oldRow + ' as loaded at ' + hhmm(state.data && state.data.fetchedAt);
      target.dataset.checked = '1';
      if (target.isConnected) target.focus();
      return;
    }
    const cands = state.data.rows.filter(r => str(r.gid) === gid && fpOf(r) === fp);
    const newRowNumber = nearest(cands.map(r => r.row), oldRow);
    const target = newRowNumber == null ? null : cands.find(r => r.row === newRowNumber);
    const entry = target && state.linkRows.find(e => e.row === target);
    const msg = target
      ? (target.row === oldRow ? 'Checked again: still at row ' + target.row + ' — open it' : 'Checked again: now at row ' + target.row + ' — open it')
      : null;
    if (entry) {
      entry.el.removeAttribute('aria-busy');
      entry.el.textContent = msg;
      entry.el.dataset.checked = '1';
      entry.el.focus();
      return;
    }
    if (target) {
      const a = extLink(Sheet.rowUrl(target.sheetId, target.gid, target.row, target.lastCol || 'G'), msg, 'row-link');
      a.dataset.checked = '1';
      setNotice(str(row.tab) + ' row ' + oldRow + ' (“' + str(row.title) + '”): ', a);
      return;
    }
    const url = Sheet.sheetUrl(row.sheetId, row.gid);
    setNotice('Checked again: “' + str(row.title) + '” (' + str(row.tab) + ' row ' + oldRow + ") isn't in the sheet as it was; it may have been edited or removed. ",
      extLink(url, 'Open the sheet'));
  }

  function onResultsClick(e) {
    const a = e.target && e.target.closest ? e.target.closest('a.row-link') : null;
    if (!a || a.dataset.checked === '1' || e.button !== 0) return;
    if (!state.data || !linkRow.has(a) || ageMs() < REFRESH_AFTER) return;
    e.preventDefault();
    checkAgain(a);
  }

  // ---------------------------------------------------------------------------------------------
  // Freshness: silent refresh every 5 minutes while visible; reload after 30+ minutes on return

  function maybeRefresh(minAge) {
    if (!state.data || state.loading || document.visibilityState !== 'visible') return;
    if (ageMs() >= minAge) reload({ background: true });
  }

  // ---------------------------------------------------------------------------------------------
  // Start

  function start() {
    if (!ui.box || !ui.results || !ui.status) return;
    if (!Sheet || !Engine) {
      ui.status.textContent = "The page's scripts didn't load, so the list can't be searched. Reload the page to try again.";
      return;
    }
    const repo = httpsUrl(cfg.repoUrl);
    if (repo) Object.assign(ui.footerRepo, { href: repo, target: '_blank', rel: 'noopener noreferrer', hidden: false });

    ui.box.addEventListener('input', onInput);
    ui.box.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        runSearch(true);
      } else if (e.key === 'Escape' && ui.box.value) {
        e.preventDefault();
        ui.box.value = '';
        autoGrow();
        runSearch(false);
      }
    });
    ui.form.addEventListener('submit', e => { e.preventDefault(); runSearch(true); });
    ui.results.addEventListener('click', onResultsClick);
    ui.filterAll.addEventListener('click', () => setAllCodes(true));
    ui.filterNone.addEventListener('click', () => setAllCodes(false));
    setInterval(() => maybeRefresh(REFRESH_AFTER), MINUTE);
    document.addEventListener('visibilitychange', () => maybeRefresh(RELOAD_AFTER));
    window.addEventListener('focus', () => maybeRefresh(RELOAD_AFTER));
    window.addEventListener('pageshow', e => { if (e.persisted) maybeRefresh(RELOAD_AFTER); });

    const choice = chooseSource();
    state.overridden = !!choice.overridden;
    if (choice.error) {
      state.phase = 'config';
      state.configError = choice.error;
      renderStatus();
      return;
    }
    state.source = choice.source;
    renderSource();
    state.aliasesPromise = loadAliases();
    if (ui.box.value) autoGrow();
    reload({});
  }

  start();
})();
