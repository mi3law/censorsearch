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
    { sheetUrl: '', tabs: [], scriptUrl: '', trustedScripts: [], schoolCode: 'UAS', aliasesUrl: 'aliases.json', repoUrl: '' },
    window.CENSORSEARCH_CONFIG || {}
  );

  const LIMITS = { main: 50, possible: 25, isbnPrefix: 25 };
  const MINUTE = 60 * 1000;
  const REFRESH_AFTER = 5 * MINUTE;      // silent refresh while visible, and re-check a row before opening it
  const ALIASES_TIMEOUT = 5000;          // the optional alias list never holds up the sheet
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
    semicolon: "Semicolons don't split a search yet: everything in the box was searched together. To check several titles, put each on its own line.",
    isbnFallback: 'No ISBN match. Most rows have no ISBN, so search the title and author.',
    filterNote: "Extend the sheet's filter to cover the Memo column (A:G) so sorting keeps memos beside their titles.",
  };
  const FIELD_NAMES = { title: 'title', author: 'author', isbn: 'ISBN', memo: 'memo', type: 'type', bannedBy: 'Banned By' };

  const $ = id => document.getElementById(id);
  const ui = {
    box: $('q'), form: $('search-form'), override: $('override-note'),
    status: $('status'), warning: $('status-warning'), actions: $('status-actions'), source: $('source'),
    filterBox: $('filter-box'), filterSummary: $('filter-summary'), filterCodes: $('filter-codes'),
    filterAll: $('filter-all'), filterNone: $('filter-none'),
    notice: $('notice'), summary: $('summary'), results: $('results'),
    notes: $('maintainer-notes'), notesSummary: $('maintainer-summary'), notesList: $('maintainer-list'),
    footerSheet: $('footer-sheet'), footerRepo: $('footer-repo'),
  };

  const state = {
    source: null,          // what CensorSheet.load reads
    overridden: false,     // ?sheet= or ?script= in the page address (a ?script= of this page's own script doesn't count)
    untrusted: false,      // ?script= to a script this page doesn't know: no sheet or row links from its claims
    scriptDigest: '',      // SHA-256 of that script's address, for config.trustedScripts
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
    moves: new Map(),      // new row -> { from, to } for rows on screen when the data changed
    rowPairs: null,        // old row -> the same row in the data loaded after it (see pairRows)
    shown: [],             // rows rendered by the last render (for row-move detection)
    cardEls: [],           // [{ el, row }] cards rendered by the last render
    linkRows: [],          // [{ el, row }] row links rendered by the last render
    codeCounts: new Map(), // code -> the count element beside its checkbox
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
  const sentence = s => { const t = str(s).trim(); return !t || /[.!?…]["”’)]*$/.test(t) ? t : t + '.'; };
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

  const isFocusLost = () => { const a = document.activeElement; return !a || a === document.body || !a.isConnected; };
  const within = (node, root) => { for (let n = node; n; n = n.parentNode) if (n === root) return true; return false; };
  const shortId = id => (str(id).length > 12 ? str(id).slice(0, 6) + '…' + str(id).slice(-4) : str(id));

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

  // A gid of null means the sheet's first tab (the link had none).
  function chooseSource() {
    const params = new URLSearchParams(location.search);
    const ownScript = cfg.scriptUrl ? Sheet.parseScriptUrl(String(cfg.scriptUrl)) : null;
    // The page's own script reads the sheet that config.sheetUrl names: link to it even when the script can't be reached.
    const ownSheet = () => { const p = Sheet.parseSheetUrl(String(cfg.sheetUrl || '')); return p ? { sheetId: p.id, sheetGid: p.gid } : {}; };
    if (params.has('script')) {
      const url = Sheet.parseScriptUrl(params.get('script') || '');
      if (!url) return { error: "This page's address asks to read an Apps Script link that isn't an Apps Script web app link (https://script.google.com/macros/s/…/exec), so there is nothing to search.", overridden: true };
      if (url === ownScript) return { source: Object.assign({ kind: 'script', url, tabs: null }, ownSheet()), overridden: false };
      return { source: { kind: 'script', url, tabs: null }, overridden: true };
    }
    if (params.has('sheet')) {
      const p = Sheet.parseSheetUrl(params.get('sheet') || '');
      if (!p) return { error: "This page's address asks to read a sheet link that isn't a Google Sheets link (https://docs.google.com/spreadsheets/d/…), so there is nothing to search.", overridden: true };
      // A pasted link's own #gid=… or &gid=… can end up in this page's address instead of inside ?sheet=.
      const pageGid = params.get('gid') || new URLSearchParams(location.hash.replace(/^#/, '')).get('gid');
      const gid = p.gid || (/^\d{1,12}$/.test(pageGid || '') ? pageGid : null);
      return { source: { kind: 'csv', sheetId: p.id, tabs: [{ gid, name: null }] }, overridden: true };
    }
    if (cfg.scriptUrl) {
      if (!ownScript) return { error: 'The scriptUrl in config.js is not an Apps Script web app link (https://script.google.com/macros/s/…/exec).' };
      return { source: Object.assign({ kind: 'script', url: ownScript, tabs: null }, ownSheet()), overridden: false };
    }
    const p = Sheet.parseSheetUrl(String(cfg.sheetUrl || ''));
    if (!p) return { error: 'The sheetUrl in config.js is not a Google Sheets link.' };
    const tabs = arr(cfg.tabs).filter(t => t && t.gid != null).map(t => ({ gid: String(t.gid), name: t.name ? String(t.name) : null }));
    return { source: { kind: 'csv', sheetId: p.id, tabs: tabs.length ? tabs : [{ gid: p.gid, name: null }] }, overridden: false };
  }

  // SHA-256 (hex) of a script address. config.trustedScripts lists these for the school's own ?script= links, so the
  // page can recognise them without the address itself appearing in the public code.
  async function scriptDigest(url) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
      return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      return '';
    }
  }

  function isTrustedScript(url, digest) {
    return arr(cfg.trustedScripts).some(t => {
      const v = str(t).trim();
      return (digest && v.toLowerCase() === digest) || Sheet.parseScriptUrl(v) === url;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Loading

  async function loadAliases() {
    if (!cfg.aliasesUrl) return null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = 0;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => { if (ctrl) ctrl.abort(); reject(new Error('no answer in ' + ALIASES_TIMEOUT / 1000 + ' s')); }, ALIASES_TIMEOUT);
    });
    try {
      const url = new URL(String(cfg.aliasesUrl), location.href);
      if (url.origin !== location.origin) throw new Error('aliasesUrl must be on the same site as the page');
      const res = await Promise.race([fetch(url.href, { cache: 'no-store', credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined }), timeout]);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await Promise.race([res.json(), timeout]);
      if (!json || !Array.isArray(json.aliases)) throw new Error('no "aliases" list');
      return json;
    } catch (e) {
      console.warn('CensorSearch: continuing without aliases (' + (e && e.message ? e.message : e) + ')');
      return null;
    } finally {
      clearTimeout(timer);
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
    let errors = arr(result && result.errors);
    const issues = arr(result && result.issues);
    const fetchedAt = result && result.fetchedAt instanceof Date && !isNaN(result.fetchedAt) ? result.fetchedAt : new Date();
    let sheetId = (result && result.sheetId) || state.source.sheetId || null;
    if (state.untrusted) {
      // A script this page doesn't know can claim any spreadsheet id and any link: never turn its claims into links
      // (sheet, row, memo or title cell; the memo text still shows), and quote its words.
      sheetId = null;
      for (const r of rows) { r.sheetId = ''; r.memoUrl = null; r.titleUrl = null; }
      errors = errors.map(e => (e.kind === 'script' ? Object.assign({}, e, { message: 'The script says: “' + sentence(e.message) + '”' }) : e));
    }

    if (background) {
      // Keep the old data when a tab it had failed to load again. When every tab the source names answered, the new
      // data is what a fresh page load would show (a script that stopped returning a tab, a first tab whose id is now
      // known), so it replaces the old.
      const had = state.data.tabs.map(t => str(t.gid));
      const got = new Set(tabs.map(t => str(t.gid)));
      if (!rows.length || (errors.length && !had.every(g => got.has(g)))) {
        state.refreshError = state.refreshError || { at: new Date() };
        renderStatus();
        return false;
      }
    }
    pinFirstTab(tabs);
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
      if (background) { state.refreshError = state.refreshError || { at: new Date() }; renderStatus(); return false; }
      state.data = null; state.index = null; state.phase = 'failed';
      state.failure = { errors: [{ tab: null, message: "Couldn't prepare the search: " + (e && e.message ? e.message : e), kind: 'index' }], sheetId };
      renderStatus(); renderResults();
      return false;
    }

    // The rows on screen now (not when the fetch started) get the "moved" notes; the pairing also serves the click re-check.
    const focus = focusKey();
    // Rows read before the first tab's id was known (gid '') are the same tab as the one tab read now.
    const oldTabs = state.data ? state.data.tabs : [];
    const firstGid = oldTabs.length === 1 && str(oldTabs[0].gid) === '' && tabs.length === 1 ? str(tabs[0].gid) : null;
    state.rowPairs = pairRows(state.data ? state.data.rows : [], rows, firstGid);
    state.moves = new Map();
    for (const old of state.shown) {
      const now = state.rowPairs.get(old);
      if (now && now.row !== old.row) state.moves.set(now, { from: old.row, to: now.row });
    }
    state.data = { rows, tabs, errors, issues, fetchedAt, sheetId, signature };
    state.index = index;
    state.phase = errors.length ? 'partial' : 'loaded';
    state.refreshError = null;
    state.failure = null;
    clearNotice();   // a "Checked again: now at row N" notice may no longer be true
    rebuildFilter();
    renderStatus(); renderSource(); renderNotes();
    if (ui.box.value.trim()) runSearch(state.enter);
    else { state.run = null; renderResults(); }
    restoreFocus(focus);
    return true;
  }

  // Pairs each old row with the same row in the new data: same tab and fingerprint, and rows sharing a fingerprint
  // pair up in order (the k-th old one with the k-th new one), so two identical listings never claim the same new row.
  // When a copy was added or removed, each old row takes the nearest new row not already taken. firstGid, when given, is
  // the id now known for the old rows' gid ''.
  function pairRows(oldRows, newRows, firstGid) {
    const group = (rows, gidOf) => {
      const m = new Map();
      for (const r of rows) {
        const k = gidOf(r) + '\u0000' + fpOf(r);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      return m;
    };
    const next = group(newRows, r => str(r.gid)), pairs = new Map();
    for (const [k, olds] of group(oldRows, r => (firstGid != null && str(r.gid) === '' ? firstGid : str(r.gid)))) {
      const free = (next.get(k) || []).slice();
      if (!free.length) continue;
      if (free.length === olds.length) { olds.forEach((r, i) => pairs.set(r, free[i])); continue; }
      for (const r of olds) {
        if (!free.length) break;
        let best = 0;
        free.forEach((n, i) => { if (Math.abs(n.row - r.row) < Math.abs(free[best].row - r.row)) best = i; });
        pairs.set(r, free.splice(best, 1)[0]);
      }
    }
    return pairs;
  }

  // A link without a gid reads the sheet's first tab. Once a load has confirmed that tab's id, keep reading it by that
  // id, so a later failed check of the id can't take the rows out of the row links (and the check isn't repeated).
  function pinFirstTab(tabs) {
    const s = state.source;
    if (!s || s.kind !== 'csv' || arr(s.tabs).length !== 1 || s.tabs[0].gid || tabs.length !== 1 || !str(tabs[0].gid)) return;
    state.source = Object.assign({}, s, { tabs: [{ gid: str(tabs[0].gid), name: s.tabs[0].name }] });
  }

  function moveOf(row) {
    return state.moves.get(row) || null;
  }

  // Keyboard focus across a refresh that rebuilds the results: remember the focused card (or its row link), results
  // button or filter checkbox, and put focus back on the same one afterwards if the rebuild dropped it. Results buttons
  // are found again by their data-key (a "Show all N" count can change), else by their text.
  function focusKey() {
    const a = document.activeElement;
    if (!a || a === document.body) return null;
    for (const [code, input] of state.codeInputs) if (input === a) return { kind: 'code', code };
    if (!within(a, ui.results)) return null;
    const c = state.cardEls.find(x => x.el === a || within(a, x.el));
    if (c) {
      const same = state.cardEls.filter(x => x.row === c.row);
      return { kind: 'card', row: c.row, index: same.indexOf(c), link: a !== c.el && a.matches('a.row-link') };
    }
    return a.tagName === 'BUTTON' ? { kind: 'button', key: a.getAttribute('data-key'), text: a.textContent } : null;
  }

  function restoreFocus(key) {
    if (!key || !isFocusLost()) return;
    let target = null;
    if (key.kind === 'code') target = state.codeInputs.get(key.code) || null;
    else if (key.kind === 'card') {
      const row = (state.rowPairs && state.rowPairs.get(key.row)) || key.row;
      const same = state.cardEls.filter(x => x.row === row);
      const c = same[key.index] || same[0];
      if (c) target = (key.link && c.el.querySelector('a.row-link')) || c.el;
    } else {
      const buttons = Array.from(ui.results.querySelectorAll('button'));
      target = (key.key && buttons.find(b => b.getAttribute('data-key') === key.key)) || buttons.find(b => b.textContent === key.text) || null;
    }
    if (target) target.focus();
  }

  // ---------------------------------------------------------------------------------------------
  // Status line, source line, maintainer notes

  // Re-rendering the status replaces this button; keyboard focus then moves to the new Retry button, or to the
  // status line once the list has loaded.
  function retryButton() {
    const b = el('button', { type: 'button' }, 'Retry');
    b.addEventListener('click', () => {
      const hadFocus = document.activeElement === b;
      b.disabled = true;
      const done = reload(state.data ? { background: true, manual: true } : {});
      if (hadFocus) {
        done.then(() => {
          if (!isFocusLost()) return;
          const again = ui.actions.hidden ? null : ui.actions.querySelector('button');
          (again || ui.status).focus();
        });
      }
    });
    return b;
  }

  function sheetLinkUrl() {
    if (state.untrusted) return null;
    const sheetId = (state.data && state.data.sheetId) || (state.failure && state.failure.sheetId) || (state.source && state.source.sheetId);
    if (!sheetId) return null;
    const tabs = state.data && state.data.tabs.length ? state.data.tabs : arr(state.source && state.source.tabs);
    return Sheet.sheetUrl(sheetId, tabs.length ? tabs[0].gid : state.source && state.source.sheetGid);
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

  // Re-rendering replaces the status actions. Keyboard focus on one of them moves to its replacement, or to the status
  // line once there is none (while a Retry is loading, its click handler places focus when the load ends). The live
  // status lines are rewritten only when their words change, so a screen reader doesn't hear them again on every check.
  function renderStatus() {
    const a = document.activeElement;
    const focused = a && a !== ui.actions && within(a, ui.actions) ? a.textContent : null;
    const view = statusView();
    setText(ui.status, view.status);
    setText(ui.warning, view.warning || '');
    const actions = arr(view.actions).filter(Boolean);
    ui.actions.replaceChildren(...actions);
    ui.actions.hidden = !actions.length;
    if (focused == null || !isFocusLost()) return;
    const again = ui.actions.hidden ? [] : Array.from(ui.actions.querySelectorAll('button, a'));
    const target = again.find(x => x.textContent === focused) || again[0] || (state.phase === 'loading' ? null : ui.status);
    if (target) target.focus();
  }

  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  function statusView() {
    if (state.phase === 'config') {
      return { status: state.configError, actions: [state.overridden ? defaultPageLink('Use the default list') : null] };
    }
    if (state.phase === 'loading') return { status: TEXT.loading };
    if (state.phase === 'failed') {
      const f = state.failure || { errors: [] };
      const url = sheetLinkUrl();
      return {
        status: failureText(arr(f.errors)),
        actions: [retryButton(), url ? ' ' : null, url ? extLink(url, 'Open the sheet') : null,
          state.overridden ? ' · ' : null, state.overridden ? defaultPageLink('Use the default list') : null],
      };
    }
    const warn = [];
    const d = state.data;
    if (d.errors.length) {
      const loaded = d.tabs.map(t => t.tab);
      // sentence(): a message that ends in a quoted sentence (“Tab not found.”) gets no second full stop
      warn.push(sentence('Loaded ' + listText(loaded) + "; couldn't load " +
        d.errors.map(e => (e.tab || 'a tab') + ': ' + stripStop(e.message)).join('; ')));
    }
    if (state.manualRetry) warn.push('Checking the sheet again…');
    else if (state.refreshError) warn.push("Couldn't refresh since " + hhmm(state.refreshError.at) + '; showing data fetched at ' + hhmm(d.fetchedAt) + '.');
    return { status: loadedText(), warning: warn.join(' '), actions: warn.length ? [retryButton()] : [] };
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
    if (state.untrusted) {
      if (tabs.length) ui.source.append(listText(tabs), ' ');
      ui.source.append("through an Apps Script web app this page doesn't know");
    } else {
      if (tabs.length) ui.source.append(listText(tabs), ' of ');
      ui.source.append(url ? extLink(url, 'this Google Sheet') : 'the Google Sheet');
      if (s.kind === 'script') ui.source.append(' through its Apps Script web app');
    }
    if (state.overridden) ui.source.append(", as this page's address asks. ", defaultPageLink('Use the default list'), '.');
    else ui.source.append('.');
    renderOverride();

    if (url) {
      ui.footerSheet.href = url;
      ui.footerSheet.target = '_blank';
      ui.footerSheet.rel = 'noopener noreferrer';
      ui.footerSheet.hidden = false;
    } else ui.footerSheet.hidden = true;
  }

  // A warning above the search box whenever the page isn't showing its usual list, naming what it shows instead.
  function renderOverride() {
    const box = ui.override;
    if (!box) return;
    box.replaceChildren();
    const s = state.source;
    const own = Sheet.parseSheetUrl(String(cfg.sheetUrl || ''));
    // Another tab of the page's own spreadsheet is still its usual list.
    box.hidden = !state.overridden || !s || (s.kind === 'csv' && !!own && own.id === s.sheetId);
    if (box.hidden) return;
    if (s.kind === 'script') {
      const id = (str(s.url).match(/\/s\/([^/]+)\/exec$/) || [])[1] || '';
      box.append(el('strong', null, "This page is reading a list through an Apps Script web app, not this page's usual list"),
        ' (deployment ' + id + '). It may not match the school\'s list, and its rows get no links because the sheet behind the script can\'t be checked. ');
    } else {
      const tab = state.data && state.data.tabs[0];
      const title = tab && str(tab.bannerTitle).trim();
      box.append(el('strong', null, 'This page is showing another sheet, not its usual list'),
        (title ? ': “' + title + '”' : '') + ' (sheet ' + shortId(s.sheetId) + '). ');
    }
    box.append(defaultPageLink('Use the default list'), '.');
  }

  function renderNotes() {
    const issues = state.data ? arr(state.data.issues) : [];
    ui.notesList.replaceChildren();
    for (const i of issues) {
      const where = (i.tab || 'Sheet') + (i.row != null ? ' row ' + i.row : '');
      ui.notesList.append(el('li', null, where + ': ' + str(i.message)));
    }
    ui.notesList.append(el('li', null, TEXT.filterNote));
    let n = issues.length + 1;
    if (state.untrusted) {
      const why = "This page's address names an Apps Script web app that config.js doesn't list, so the page marks it as not its usual list and shows no sheet or row links. ";
      // Without crypto.subtle (a page served over plain http) the code can't be worked out; the full address still works.
      ui.notesList.append(el('li', null, why + (state.scriptDigest
        ? "If it is the school's own script, add \"" + state.scriptDigest + '" to trustedScripts in config.js (this code stands for the script\'s address without revealing it).'
        : "This browser couldn't work out the code for trustedScripts: that needs the page to be served over https. Serve it over https and this note gives the code; or, if it is the school's own script, add its full address (" +
          str(state.source && state.source.url) + ') to trustedScripts in config.js.')));
      n++;
    }
    ui.notesSummary.textContent = "Notes for the list's maintainers (" + n + ')';
    ui.notes.hidden = !state.data;
  }

  // ---------------------------------------------------------------------------------------------
  // Banned By filter

  // Keeps the checkboxes (and so keyboard focus on one) when a refresh brings the same codes; only the counts change.
  function rebuildFilter() {
    const counts = new Map();
    for (const r of state.data.rows) for (const c of codesOf(r)) counts.set(c, (counts.get(c) || 0) + 1);
    const codes = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
    for (const c of [...state.unticked]) if (!counts.has(c)) state.unticked.delete(c);
    const countText = code => ' (' + fmtInt(counts.get(code)) + ')';
    if (codes.length && codes.length === state.codes.length && codes.every((c, i) => c === state.codes[i])) {
      for (const code of codes) { const n = state.codeCounts.get(code); if (n) n.textContent = countText(code); }
    } else {
      state.codes = codes;
      ui.filterCodes.replaceChildren();
      state.codeInputs = new Map();
      state.codeCounts = new Map();
      codes.forEach((code, i) => {
        const id = 'code-' + i;
        const input = el('input', { type: 'checkbox', id });
        input.checked = !state.unticked.has(code);
        input.addEventListener('change', () => {
          if (input.checked) state.unticked.delete(code); else state.unticked.add(code);
          updateFilterSummary();
          renderResults();
        });
        const count = el('span', { class: 'count' }, countText(code));
        state.codeInputs.set(code, input);
        state.codeCounts.set(code, count);
        ui.filterCodes.append(el('div', { class: 'code' }, input, ' ', el('label', { for: id }, code, count)));
      });
    }
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

  // finished: the text is complete (a line of a pasted list), so its last word is not matched as a prefix.
  function safeSearch(query, enter, finished) {
    try {
      return normResult(Engine.search(query, state.index, { enter: !!enter, finished: !!finished }));
    } catch (e) {
      console.error(e);
      return { state: 'error', message: e && e.message ? e.message : String(e), main: [], possible: [], isbnPrefix: [], hints: [] };
    }
  }

  const wordCount = s => (str(s).match(/[\p{L}\p{N}]+/gu) || []).length;

  function runSearch(enter) {
    clearTimeout(state.debounce);
    state.enter = !!enter;
    clearNotice();
    const value = ui.box.value;
    if (value !== state.expandedFor) { state.expanded.clear(); state.expandedFor = value; }
    if (!state.index) { state.run = null; renderResults(); return; }   // never search an empty dataset
    const lines = arr(Engine.splitLines(value));
    if (lines.length >= 2) {
      state.run = { kind: 'multi', value, lines: lines.map(line => ({ line, result: safeSearch(line, true, true) })) };
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

  function setNotice(focus, ...nodes) {
    ui.notice.replaceChildren(...nodes.filter(Boolean).map(n => (n instanceof Node ? n : String(n))));
    ui.notice.hidden = false;
    if (focus) ui.notice.focus();
  }

  function renderResults() {
    const out = ui.results;
    out.replaceChildren();
    state.shown = [];
    state.cardEls = [];
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
    else renderSingle(run.result, out, run.value);
  }

  function hiddenNote(count, shownCount, key) {
    const p = el('p', { class: 'hidden-by-filter' });
    p.append(shownCount
      ? plural(count, 'more listing', 'more listings') + ' hidden by the Banned By filter.'
      : plural(count, 'listing', 'listings') + ' hidden by the Banned By filter.');
    const b = el('button', { type: 'button', 'data-key': 'reveal:' + key }, 'Show them');
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
    for (const h of hints) if (h.code === 'isbnNoMatch') texts.push(str(h.text));
    for (const h of hints) if (h.code !== 'isbnNoMatch') texts.push(str(h.text));
    return [...new Set(texts.filter(Boolean))];
  }

  const hintsEl = hints => el('ul', { class: 'hints' }, ...hints.map(h => el('li', null, h)));

  // What every "no listing" message carries: a tab that wasn't loaded (so wasn't searched), why the list may name the
  // item differently, what to try (not "the ISBN" after an ISBN search), and the sheet as the source of truth.
  function appendNoListingHelp(box, isbnQuery, hints) {
    const errs = state.data ? arr(state.data.errors) : [];
    if (errs.length) {
      const names = [...new Set(errs.map(e => str(e.tab).trim()).filter(Boolean))];
      box.append(el('p', { class: 'unloaded' }, names.length
        ? listText(names) + " couldn't be loaded, so " + (names.length === 1 ? "it wasn't" : "they weren't") + ' searched.'
        : "Part of the list couldn't be loaded, so it wasn't searched."));
    }
    if (isbnQuery && hints.length) box.append(hintsEl(hints));
    const fetched = state.data ? ' (the list was fetched at ' + hhmm(state.data.fetchedAt) + ')' : '';
    box.append(el('p', null, 'The list may name it with another spelling, title or edition, or the sheet may have changed since this page loaded' + fetched + '.'));
    box.append(el('p', null, 'Try:'));
    box.append(el('ul', null,
      el('li', null, "the author's surname alone"),
      el('li', null, 'one distinctive word from the title'),
      isbnQuery ? null : el('li', null, 'the ISBN')));
    if (!isbnQuery && hints.length) box.append(hintsEl(hints));
    const url = sheetLinkUrl();
    if (url) box.append(el('p', null, 'The sheet is the source of truth: ', extLink(url, 'open the sheet'), '.'));
  }

  function noResults(res) {
    const box = el('div', { class: 'no-results', role: 'region', 'aria-label': 'No listing found' });
    box.append(el('p', { class: 'no-results-head' }, el('strong', null, TEXT.noListing)));
    appendNoListingHelp(box, res.isbnQuery, hintList(res, true));
    return box;
  }

  function renderSingle(res, out, value) {
    if (res.state === 'error') {
      out.append(el('p', { class: 'warning' }, "Something went wrong with this search (" + res.message + "). Try other words, or search the sheet itself."));
      return;
    }
    if (res.state === 'empty') return;
    if (res.state === 'tooShort') { ui.summary.textContent = TEXT.tooShort; return; }
    if (/[;؛]/.test(str(value))) out.append(el('p', { class: 'note' }, TEXT.semicolon));

    const main = splitHidden(res.main), possible = splitHidden(res.possible), prefix = splitHidden(res.isbnPrefix);
    const shown = main.shown.length + possible.shown.length + prefix.shown.length;
    const hidden = main.hidden + possible.hidden + prefix.hidden;
    if (!shown && !hidden && res.state === 'ok' && res.hints.some(h => h.code === 'keepTyping') && wordCount(value) <= 1) {
      // A query that is a single 1–2 letter unfinished word, with nothing found yet: not a verdict (Enter searches it as
      // typed). A longer query ending in a short word ("it ends with us") may be complete, so it gets the no-results box.
      ui.summary.textContent = TEXT.keepTyping;
      out.append(el('p', { class: 'hint' }, ...hintList(res, false)));
      return;
    }

    const summary = [];
    if (res.state === 'stopwordsOnly') summary.push(TEXT.keepTyping);
    if (main.shown.length) summary.push(plural(main.shown.length, 'listing found', 'listings found'));
    if (possible.shown.length) summary.push(plural(possible.shown.length, 'possible match', 'possible matches'));
    if (prefix.shown.length) summary.push(plural(prefix.shown.length, 'ISBN starting with these digits', 'ISBNs starting with these digits'));
    if (hidden) summary.push((shown ? '' : 'No listing shown; ') + fmtInt(hidden) + ' hidden by the Banned By filter');
    if (!shown && !hidden && res.state === 'ok') summary.push('No listing found.');
    ui.summary.textContent = summary.join(' · ');

    if (res.truncated) out.append(el('p', { class: 'note' }, TEXT.truncated));
    if (hidden) out.append(hiddenNote(hidden, shown, 'single'));

    if (main.shown.length) {
      out.append(section({ key: 'main', title: 'Listings found', hits: main.shown, limit: LIMITS.main, level: 2, noun: 'listings' }));
    }
    if (possible.shown.length) {
      out.append(section({
        key: 'possible', title: 'Possible matches', hits: possible.shown, limit: LIMITS.possible, level: 2, noun: 'possible matches',
        intro: main.shown.length
          ? 'These rows share some of your words. Open each one to check.'
          : main.hidden
            ? 'Rows that match every word are hidden by the Banned By filter; these rows share some of your words. Open each one to check.'
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
      if (hints.length) out.append(hintsEl(hints));
    }
  }

  // Each line is counted once: with matches, matches all hidden by the filter (even beside visible possible matches),
  // possible matches only, couldn't be searched (an error), not searched (only common words), or without a listing.
  // Only the last is "no listing". The summary also totals the listings the filter hides on every line.
  function renderMulti(run, out) {
    let withMatches = 0, possibleOnly = 0, hiddenOnly = 0, failed = 0, notSearched = 0, without = 0, hiddenTotal = 0;
    const blocks = run.lines.map((ln, i) => {
      const res = ln.result;
      const main = splitHidden(res.main), possible = splitHidden(res.possible), prefix = splitHidden(res.isbnPrefix);
      const shown = main.shown.length + possible.shown.length + prefix.shown.length;
      const hidden = main.hidden + possible.hidden + prefix.hidden;
      const commonOnly = res.state === 'stopwordsOnly' && !shown && !hidden;
      hiddenTotal += hidden;
      if (main.shown.length) withMatches++;
      else if (main.hidden || (hidden && !shown)) hiddenOnly++;
      else if (shown) possibleOnly++;
      else if (res.state === 'error') failed++;
      else if (commonOnly) notSearched++;
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
      if (hidden) sec.append(hiddenNote(hidden, shown, 'l' + i));
      if (main.shown.length) appendHits(sec, 'l' + i + ':main', main.shown, LIMITS.main, 3, 'listings');
      if (possible.shown.length) {
        sec.append(section({ key: 'l' + i + ':possible', title: 'Possible matches', hits: possible.shown, limit: LIMITS.possible, level: 3, noun: 'possible matches' }));
      }
      if (prefix.shown.length) {
        sec.append(section({ key: 'l' + i + ':isbnPrefix', title: 'ISBN starts with…', hits: prefix.shown, limit: LIMITS.isbnPrefix, level: 3, noun: 'rows' }));
      }
      if (commonOnly) {
        sec.append(el('div', { class: 'line-empty' }, el('p', null, 'Not searched: this line has only common words such as “the”.')));
      } else if (!shown && !hidden && res.state !== 'error') {
        const box = el('div', { class: 'line-empty' }, el('p', null, el('strong', null, 'No listing found')));
        const hints = hintList(res, true);
        if (hints.length) box.append(hintsEl(hints));
        sec.append(box);
      }
      return sec;
    });

    const counts = [fmtInt(withMatches) + ' with matches'];
    if (possibleOnly) counts.push(fmtInt(possibleOnly) + ' with possible matches only');
    if (hiddenOnly) counts.push(fmtInt(hiddenOnly) + ' with matches hidden by the Banned By filter');
    if (failed) counts.push(fmtInt(failed) + " couldn't be searched");
    if (notSearched) counts.push(fmtInt(notSearched) + ' not searched (only common words)');
    counts.push(fmtInt(without) + ' without');
    ui.summary.textContent = run.lines.length + ' lines: ' + counts.join(', ') +
      (hiddenTotal ? ' · ' + plural(hiddenTotal, 'listing', 'listings') + ' hidden by the Banned By filter' : '');
    if (without) {
      // One shared "why it may differ" block for every line without a listing.
      const box = el('div', { class: 'no-results', role: 'region', 'aria-label': 'Lines with no listing' });
      box.append(el('p', { class: 'no-results-head' }, el('strong', null,
        (without === 1 ? 'One line has' : fmtInt(without) + ' lines have') + ' no listing. ' + TEXT.noListing.replace(/^No listing found\. /, ''))));
      appendNoListingHelp(box, false, []);
      out.append(box);
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
      const b = el('button', { type: 'button', 'data-key': 'more:' + key }, 'Show all ' + fmtInt(hits.length) + ' ' + noun);
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
    state.cardEls.push({ el: art, row });
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
    const flat = t => t.replace(/\s+/g, ' ').trim();
    if (flat(asWritten) && flat(asWritten) !== flat(title)) art.append(el('p', { class: 'as-written' }, 'listed as “' + asWritten + '”'));

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
    const link = row.sheetId ? extLink(Sheet.rowUrl(row.sheetId, row.gid, row.row, row.lastCol || 'G'), 'Open in the sheet', 'row-link') : null;
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
  // Row links: when the data is 5+ minutes old, check the sheet again before opening a row. The new tab opens inside
  // the click (so popup blockers allow it), shows "Checking…", and is sent to the row's current place once found.

  function openBlankTab() {
    let w = null;
    try { w = window.open('', '_blank'); } catch (e) { w = null; }
    if (!w) return null;
    try { w.opener = null; } catch (e) { /* ignore */ }
    try { w.document.title = 'Checking the sheet again…'; w.document.body.textContent = 'Checking the sheet again…'; } catch (e) { /* ignore */ }
    return w;
  }

  // The teacher may have closed the tab meanwhile.
  function sendTab(tab, url) {
    try { if (tab && !tab.closed) { if (url) tab.location.replace(url); else tab.close(); } } catch (e) { /* ignore */ }
  }

  async function checkAgain(link, tab) {
    const row = linkRow.get(link);
    if (!row) { sendTab(tab, null); return; }
    const oldRow = row.row;
    // The same row can be shown more than once (multi-line); remember which of its links was clicked.
    const occurrence = Math.max(0, state.linkRows.filter(e => e.row === row).findIndex(e => e.el === link));
    link.textContent = 'Checking the sheet again…';
    link.setAttribute('aria-busy', 'true');
    const ok = await reload({ background: true });

    // Focus follows the answer only if the teacher left it on the link (or a re-render dropped it), never from the box.
    const mayFocus = document.activeElement === link || isFocusLost();
    const linkFor = r => {
      if (r === row && link.isConnected) return link;
      const same = state.linkRows.filter(e => e.row === r);
      return (same[occurrence] || same[0] || {}).el || null;
    };
    const answer = (a, text) => {
      a.removeAttribute('aria-busy');
      a.textContent = text;
      a.dataset.checked = '1';
      if (mayFocus && a.isConnected) a.focus();
    };

    if (!ok) {
      sendTab(tab, Sheet.rowUrl(row.sheetId, row.gid, oldRow, row.lastCol || 'G'));
      answer(linkFor(row) || link, "Couldn't check again; " + (tab ? 'opened' : 'open') + ' row ' + oldRow + ' as loaded at ' + hhmm(state.data && state.data.fetchedAt));
      return;
    }
    const target = state.data.rows.includes(row) ? row : (state.rowPairs && state.rowPairs.get(row)) || null;
    if (!target) {
      sendTab(tab, null);
      const url = Sheet.sheetUrl(row.sheetId, row.gid);
      setNotice(mayFocus, 'Checked again: “' + str(row.title) + '” (' + str(row.tab) + ' row ' + oldRow + ") isn't in the sheet as it was; it may have been edited or removed. ",
        extLink(url, 'Open the sheet'));
      return;
    }
    const url = Sheet.rowUrl(target.sheetId, target.gid, target.row, target.lastCol || 'G');
    sendTab(tab, url);
    const msg = target.row === oldRow ? 'Checked again: still at row ' + target.row + ' — open it' : 'Checked again: now at row ' + target.row + ' — open it';
    const shownLink = linkFor(target);
    if (shownLink) { answer(shownLink, msg); return; }
    const a = extLink(url, msg, 'row-link');
    a.dataset.checked = '1';
    setNotice(mayFocus, str(row.tab) + ' row ' + oldRow + ' (“' + str(row.title) + '”): ', a);
  }

  function onResultsClick(e) {
    const a = e.target && e.target.closest ? e.target.closest('a.row-link') : null;
    if (!a || a.dataset.checked === '1' || e.button !== 0) return;
    if (!state.data || !linkRow.has(a) || ageMs() < REFRESH_AFTER) return;
    e.preventDefault();
    checkAgain(a, openBlankTab());
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
    if (ui.box.value) autoGrow();
    const go = () => {
      renderSource();
      state.aliasesPromise = loadAliases();
      reload({});
    };
    if (state.source.kind !== 'script' || !state.overridden) { go(); return; }
    // ?script= to another script: trusted only when config.trustedScripts lists it (by address or its SHA-256).
    scriptDigest(state.source.url).then(digest => {
      state.scriptDigest = digest;
      if (isTrustedScript(state.source.url, digest)) state.overridden = false;
      state.untrusted = state.overridden;
      go();
    });
  }

  start();
})();
