// The inventory check page (inventory.html, browser only). A teacher signs in with Google, pastes the link to a
// classroom inventory sheet, picks its tabs, and every title in them is checked against the banned list (config.js's
// sheet, read with the same sign-in). The report gives one summary row per classroom tab, then the matches tab by tab;
// it downloads as CSV and, only when the teacher ticks the option, is written into a "CensorSearch results" tab of
// the inventory sheet with a separate sign-in that may edit sheets.
//
// Safety rules as on the search page: sheet text reaches the page only as text nodes; links are built only from
// https URLs; the sign-in tokens stay in memory; nothing is written to browser storage. The search page's own
// interface (index.html, src/app.js) is untouched by this page.
(function () {
  'use strict';

  const Sheet = window.CensorSheet;
  const Engine = window.CensorEngine;
  const SignIn = window.CensorSignIn;
  const Inv = window.CensorInventory;
  const cfg = Object.assign(
    { sheetUrl: '', tabs: [], googleClientId: '', schoolCode: 'UAS', aliasesUrl: 'aliases.json' },
    window.CENSORSEARCH_CONFIG || {}
  );

  const RANGES_PER_CALL = 20;          // tabs read per values:batchGet call (keeps the address short)
  const JOB_SIZE = 250;                // items per job handed to a worker
  const TIMEOUT = 60000;
  const ALIASES_TIMEOUT = 5000;
  const TEXT = {
    noSignIn: "The inventory check reads sheets with each teacher's own Google sign-in, which isn't set up for this page. A list maintainer can set it up (README, \"Signing in\").",
    signin: 'Sign in with Google to check an inventory. The page reads the banned list and the inventory with your own access.',
    expired: 'Your Google sign-in has run out. Sign in again to go on.',
    badLink: "This isn't a Google Sheets link. Open the inventory sheet and copy the address from the browser's address bar: it starts with https://docs.google.com/spreadsheets/d/.",
    noLink: "Paste the inventory sheet's link.",
    noAccessWrite: "Your Google account can view the inventory but not edit it, so the results weren't written into it. Download them instead.",
  };

  const $ = id => document.getElementById(id);
  const ui = {
    status: $('inv-status'), list: $('inv-list'), signin: $('inv-signin'),
    form: $('inv-form'), url: $('inv-url'), find: $('inv-find'), urlError: $('inv-url-error'),
    tabsBox: $('inv-tabs-box'), sheetName: $('inv-sheet-name'), all: $('inv-all'), none: $('inv-none'), only: $('inv-only'),
    count: $('inv-count'), tabsDetails: $('inv-tabs-details'), tabList: $('inv-tab-list'), write: $('inv-write'), check: $('inv-check'),
    progressText: $('inv-progress-text'), progress: $('inv-progress'),
    report: $('inv-report'), summary: $('inv-summary'), writeStatus: $('inv-write-status'),
    download: $('inv-download'), downloadSummary: $('inv-download-summary'),
    tableBody: $('inv-table-body'), problems: $('inv-problems'), tabsResults: $('inv-tabs-results'),
  };

  const state = {
    read: null,            // sign-in client that reads sheets
    write: null,           // sign-in client that may edit sheets (made only when the teacher asks to write results)
    list: null,            // the banned list as CensorSheet.load returns it
    listError: '',
    listPromise: null,
    aliases: null,
    index: null,           // the banned list's search index on this thread (only when workers aren't available)
    sheet: null,           // { id, gid, title, tabs: [{ gid, title, hidden }] }
    boxes: [],             // [{ input, tab }]
    running: false,
    report: null,
    checkedAt: null,
  };

  // ---------------------------------------------------------------------------------------------
  // Small helpers

  const str = v => (v == null ? '' : typeof v === 'string' ? v : String(v));
  const fmtInt = n => Number(n || 0).toLocaleString('en-US');
  const plural = (n, one, many) => fmtInt(n) + ' ' + (n === 1 ? one : many);

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : String(v));
    for (const k of kids) if (k != null && k !== false) e.append(k);
    return e;
  }

  function httpsUrl(u) {
    const s = Sheet.safeHttpsUrl(u);
    return s || null;
  }

  function extLink(url, text, cls) {
    const u = httpsUrl(url);
    if (!u) return null;
    return el('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: cls || null }, text);
  }

  function setStatus(text, focus) {
    ui.status.textContent = text;
    if (focus) ui.status.focus();
  }

  function timeText(d) {
    try { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return d.toISOString(); }
  }

  const api = (url, token, write) => Sheet.fetchApi(window.fetch.bind(window), url, token, TIMEOUT, write);
  const base = id => Sheet.API_BASE + encodeURIComponent(id);

  // ---------------------------------------------------------------------------------------------
  // Sign-in

  function signInButton(label, onDone) {
    const b = el('button', { type: 'button', id: 'inv-signin-button' }, label);
    b.addEventListener('click', () => {
      b.disabled = true;
      state.read.signIn({ chooseAccount: !!state.read.token() }).then(() => {
        ui.signin.hidden = true;
        ui.signin.replaceChildren();
        onDone();
      }, err => {
        b.disabled = false;
        setStatus(err && err.message ? err.message : SignIn.messageFor('failed'));
      });
    });
    ui.signin.replaceChildren(b);
    ui.signin.hidden = false;
    return b;
  }

  function askToSignIn(message, onDone) {
    setStatus(message);
    signInButton('Sign in with Google', onDone);
  }

  // The read token, or null after showing the sign-in button again.
  function readToken() {
    const t = state.read.token();
    if (!t) askToSignIn(TEXT.expired, () => setStatus('Signed in.'));
    return t;
  }

  // ---------------------------------------------------------------------------------------------
  // The banned list

  async function loadAliases() {
    if (!cfg.aliasesUrl) return null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ALIASES_TIMEOUT) : 0;
    try {
      const url = new URL(String(cfg.aliasesUrl), location.href);
      if (url.origin !== location.origin) throw new Error('aliasesUrl must be on the same site as the page');
      const res = await fetch(url.href, Object.assign({ cache: 'no-cache', credentials: 'omit' }, ctrl ? { signal: ctrl.signal } : {}));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json || !Array.isArray(json.aliases)) throw new Error('no "aliases" list');
      return json.aliases;
    } catch (e) {
      console.warn('CensorSearch: continuing without aliases (' + (e && e.message ? e.message : e) + ')');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function loadList() {
    if (state.listPromise) return state.listPromise;
    ui.list.hidden = false;
    ui.list.textContent = 'Reading the banned list…';
    state.listPromise = (async () => {
      const p = Sheet.parseSheetUrl(str(cfg.sheetUrl));
      const token = state.read.token();
      const [data, aliases] = await Promise.all([
        p ? Sheet.load({ kind: 'api', sheetId: p.id, tabs: Array.isArray(cfg.tabs) ? cfg.tabs : [] }, { accessToken: token || '', schoolCode: cfg.schoolCode })
          : Promise.resolve({ rows: [], errors: [{ message: "config.js doesn't name the banned list's sheet." }] }),
        loadAliases(),
      ]);
      state.aliases = aliases;
      if (!data.rows.length) {
        const why = data.errors.map(e => e.message).filter(Boolean).join(' ') || 'The banned list is empty.';
        throw new Error(why);
      }
      state.list = data;
      state.index = null;
      const warn = data.errors.length ? ' Some of its tabs couldn\'t be read: ' + data.errors.map(e => (e.tab ? e.tab + ': ' : '') + e.message).join(' ') : '';
      ui.list.replaceChildren('Banned list: ' + plural(data.rows.length, 'item', 'items') + ', read at ' + timeText(data.fetchedAt) + ' ',
        extLink(Sheet.sheetUrl(data.sheetId, data.tabs[0] && data.tabs[0].gid), '(open it)'), warn);
      return data;
    })().catch(err => {
      state.listPromise = null;
      state.listError = err && err.message ? err.message : String(err);
      ui.list.textContent = "Couldn't read the banned list: " + state.listError;
      throw err;
    });
    state.listPromise.catch(() => {});
    return state.listPromise;
  }

  // ---------------------------------------------------------------------------------------------
  // Finding the inventory's tabs

  function showUrlError(text) {
    ui.urlError.textContent = text;
    ui.urlError.hidden = !text;
    if (text) ui.url.setAttribute('aria-invalid', 'true'); else ui.url.removeAttribute('aria-invalid');
  }

  async function findTabs(ev) {
    if (ev) ev.preventDefault();
    if (state.running) return;
    const value = ui.url.value.trim();
    if (!value) { showUrlError(TEXT.noLink); ui.url.focus(); return; }
    const p = Sheet.parseSheetUrl(value);
    if (!p) { showUrlError(TEXT.badLink); ui.url.focus(); return; }
    showUrlError('');
    const token = readToken();
    if (!token) return;
    ui.find.disabled = true;
    setStatus('Finding the inventory\'s tabs…');
    try {
      const info = await api(base(p.id) + '?fields=' + encodeURIComponent('properties.title,sheets.properties(sheetId,title,hidden)'), token);
      const tabs = (Array.isArray(info.sheets) ? info.sheets : []).map(s => s && s.properties).filter(x => x && x.title != null)
        .map(x => ({ gid: str(x.sheetId != null ? x.sheetId : 0), title: str(x.title), hidden: x.hidden === true }));
      if (!tabs.length) throw new Error('This spreadsheet has no tabs.');
      state.sheet = { id: p.id, gid: p.gid, title: str(info.properties && info.properties.title), tabs };
      renderTabs();
      setStatus('Found ' + plural(tabs.length, 'tab', 'tabs') + '. Choose which to check.');
      ui.tabsBox.hidden = false;
    } catch (err) {
      if (err && err.kind === 'auth') { state.read.forget(); askToSignIn(TEXT.expired, () => findTabs()); }
      else showUrlError(err && err.message ? err.message : String(err));
      setStatus('Paste the inventory sheet\'s link.');
    } finally {
      ui.find.disabled = false;
    }
  }

  function renderTabs() {
    const s = state.sheet;
    ui.sheetName.replaceChildren(s.title ? '“' + s.title + '” ' : '', extLink(Sheet.sheetUrl(s.id, s.gid), '(open it)'));
    state.boxes = [];
    const items = s.tabs.map((t, i) => {
      const own = t.title === Inv.RESULTS_TAB;
      const input = el('input', { type: 'checkbox', id: 'inv-tab-' + i, disabled: own || null });
      input.checked = !own && !t.hidden;
      input.addEventListener('change', updateCount);
      if (!own) state.boxes.push({ input, tab: t });
      const label = el('label', { for: 'inv-tab-' + i }, t.title);
      if (t.hidden) label.append(el('span', { class: 'muted' }, ' (hidden tab)'));
      if (own) label.append(el('span', { class: 'muted' }, " (this page's own results; not checked)"));
      return el('li', { class: 'choice' }, input, ' ', label);
    });
    ui.tabList.replaceChildren(...items);
    ui.tabsDetails.open = true;
    const linked = s.gid != null ? s.tabs.find(t => t.gid === s.gid && t.title !== Inv.RESULTS_TAB) : null;
    ui.only.hidden = !(linked && state.boxes.length > 1);
    if (linked) ui.only.textContent = 'Only “' + linked.title + '”';
    ui.only.setAttribute('data-gid', linked ? linked.gid : '');
    updateCount();
  }

  function selectedTabs() { return state.boxes.filter(b => b.input.checked).map(b => b.tab); }

  function updateCount() {
    const n = selectedTabs().length;
    ui.count.textContent = 'Tabs (' + fmtInt(n) + ' of ' + fmtInt(state.boxes.length) + ' selected)';
    ui.check.disabled = !n || state.running;
    ui.check.textContent = n === 1 ? 'Check the selected tab' : 'Check the ' + fmtInt(n) + ' selected tabs';
  }

  function setAll(on) { for (const b of state.boxes) b.input.checked = on; updateCount(); }

  // ---------------------------------------------------------------------------------------------
  // Running the check

  function progress(text, done, total) {
    ui.progressText.hidden = false;
    ui.progressText.textContent = text;
    ui.progress.hidden = total == null;
    if (total != null) { ui.progress.max = Math.max(1, total); ui.progress.value = done; }
  }

  function onCheck() {
    if (state.running || !state.sheet) return;
    const tabs = selectedTabs();
    if (!tabs.length) return;
    const write = ui.write.checked;
    // Google's sign-in window must open straight from the click, before anything is awaited.
    let auth;
    if (write) {
      if (!state.write) state.write = SignIn.create(window, cfg.googleClientId, { scope: SignIn.WRITE_SCOPE });
      auth = state.write.token() ? Promise.resolve() : state.write.signIn();
    } else {
      auth = state.read.token() ? Promise.resolve() : state.read.signIn();
    }
    state.running = true;
    ui.tabsDetails.open = false;   // the list folds away so the progress and report come into view
    updateCount();
    auth.then(() => run(tabs, write), err => {
      setStatus(err && err.message ? err.message : SignIn.messageFor('failed'), true);
      state.running = false;
      updateCount();
    });
  }

  async function run(tabs, write) {
    const token = () => (write ? state.write.token() : state.read.token()) || state.read.token();
    const s = state.sheet;
    ui.report.hidden = true;
    ui.find.disabled = true;
    try {
      progress('Reading the banned list…');
      try { await loadList(); } catch (e) { throw new Error("Couldn't read the banned list: " + state.listError); }

      // 1. The tabs' cells, a few tabs per call.
      const parts = tabs.map(t => ({ gid: t.gid, title: t.title, parsed: null, results: [] }));
      for (let i = 0; i < parts.length; i += RANGES_PER_CALL) {
        progress('Reading tabs: ' + fmtInt(i) + ' of ' + fmtInt(parts.length) + '…', i, parts.length);
        const chunk = parts.slice(i, i + RANGES_PER_CALL);
        const ranges = chunk.map(t => 'ranges=' + encodeURIComponent(Sheet.a1Sheet(t.title))).join('&');
        const url = base(s.id) + '/values:batchGet?' + ranges + '&majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&fields=' + encodeURIComponent('valueRanges(values)');
        const tok = token();
        if (!tok) throw Object.assign(new Error(TEXT.expired), { kind: 'auth' });
        try {
          const got = await api(url, tok);
          const vr = Array.isArray(got.valueRanges) ? got.valueRanges : [];
          chunk.forEach((t, j) => { t.parsed = Inv.parseTab(vr[j] && vr[j].values, { tab: t.title, gid: t.gid, sheetId: s.id }); });
        } catch (e) {
          if (e && e.kind === 'auth') throw e;
          chunk.forEach(t => { t.parsed = { error: e && e.message ? e.message : String(e) }; });
        }
      }

      // 2. Every item, in workers when the browser has them.
      const total = parts.reduce((n, t) => n + ((t.parsed && t.parsed.items) || []).length, 0);
      progress('Checking titles: 0 of ' + fmtInt(total) + '…', 0, total);
      await checkAll(parts, total);

      state.checkedAt = new Date();
      state.report = Inv.report(parts);
      renderReport();
      ui.progressText.hidden = true;
      ui.progress.hidden = true;
      setStatus('Done: checked ' + plural(state.report.totals.items, 'title', 'titles') + ' in ' + plural(state.report.totals.read, 'tab', 'tabs') + '.');
      ui.report.hidden = false;
      ui.report.focus();
      if (write) await writeResults(state.write.token());
    } catch (err) {
      ui.progressText.hidden = true;
      ui.progress.hidden = true;
      if (err && err.kind === 'auth') {
        (write ? state.write : state.read).forget();
        askToSignIn(TEXT.expired, () => setStatus('Signed in. Check the tabs again.'));
      } else setStatus(err && err.message ? err.message : String(err), true);
    } finally {
      state.running = false;
      ui.find.disabled = false;
      updateCount();
    }
  }

  // Fills parts[i].results. Workers (up to 4) when available; otherwise on this thread, yielding between jobs.
  async function checkAll(parts, total) {
    const jobs = Inv.jobs(parts, JOB_SIZE);
    let done = 0;
    const store = (job, results) => {
      const rows = state.list.rows;
      results.forEach((r, k) => { parts[job.tab].results[job.start + k] = r.hits && r.hits.length && r.hits[0].id !== undefined ? Inv.expand(r, rows) : r; });
      done += job.items.length;
      progress('Checking titles: ' + fmtInt(done) + ' of ' + fmtInt(total) + '…', done, total);
    };
    if (!jobs.length) return;
    let viaWorkers = false;
    try { viaWorkers = await inWorkers(jobs, store); } catch (e) { viaWorkers = false; }
    if (viaWorkers) return;
    done = 0;
    if (!state.index) state.index = Engine.buildIndex(state.list.rows, state.aliases ? { aliases: state.aliases } : {});
    for (const job of jobs) {
      store(job, job.items.map(it => Inv.checkItem(state.index, it)));
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // Resolves true when every job was checked in workers, false when workers aren't available; rejects on a worker error.
  function inWorkers(jobs, store) {
    if (typeof window.Worker !== 'function') return Promise.resolve(false);
    const cores = (typeof navigator !== 'undefined' && Number(navigator.hardwareConcurrency)) || 2;
    const n = Math.max(1, Math.min(4, cores - 1, jobs.length));
    return new Promise((resolve, reject) => {
      const workers = [];
      let next = 0, finished = 0, failed = false;
      const stop = () => workers.forEach(w => w.terminate());
      const fail = err => { if (failed) return; failed = true; stop(); reject(err instanceof Error ? err : new Error(String(err && err.message || err))); };
      const give = w => {
        if (next >= jobs.length) return;
        const id = next++;
        w.postMessage({ type: 'check', job: id, items: jobs[id].items });
      };
      try {
        for (let i = 0; i < n; i++) {
          const w = new Worker('src/inventory-worker.js');
          workers.push(w);
          w.onerror = e => { if (e && e.preventDefault) e.preventDefault(); fail(new Error('worker failed')); };
          w.onmessage = e => {
            const m = e.data || {};
            if (failed) return;
            if (m.type === 'ready') give(w);
            else if (m.type === 'done') {
              store(jobs[m.job], m.results || []);
              if (++finished === jobs.length) { stop(); resolve(true); } else give(w);
            } else if (m.type === 'error') fail(new Error(m.message));
          };
          w.postMessage({ type: 'index', rows: state.list.rows, aliases: state.aliases });
        }
      } catch (e) { fail(e); }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // The report

  const links = () => ({
    inventory: (t, row) => Sheet.rowUrl(state.sheet.id, t.gid, row, t.lastCol || 'B'),
    list: r => (r && r.sheetId ? Sheet.rowUrl(r.sheetId, r.gid, r.row, r.lastCol || 'G') : ''),
  });
  const tabAnchor = t => 'inv-t-' + t.gid;
  const nameOf = t => t.room || t.title;

  function renderReport() {
    const rep = state.report, T = rep.totals, s = state.sheet;
    const bits = ['Checked ' + plural(T.items, 'title', 'titles') + ' in ' + plural(T.read, 'tab', 'tabs') + (s.title ? ' of “' + s.title + '”' : '') + ': '];
    bits.push(plural(T.likely, 'likely banned', 'likely banned') + (T.likely ? ' (in ' + plural(T.tabsWithLikely, 'tab', 'tabs') + ')' : '') + ', ');
    bits.push(plural(T.look, 'worth a look', 'worth a look') + '.');
    if (T.failed) bits.push(' ' + plural(T.failed, "tab couldn't", "tabs couldn't") + ' be read.');
    bits.push(' Banned list read at ' + timeText(state.list.fetchedAt) + '.');
    ui.summary.textContent = bits.join('');
    ui.writeStatus.hidden = true;

    // One row per tab.
    ui.tableBody.replaceChildren(...rep.tabs.map(t => {
      const name = el('th', { scope: 'row' });
      const go = t.findings.length || t.error ? el('a', { href: '#' + tabAnchor(t) }, nameOf(t)) : nameOf(t);
      name.append(go);
      if (t.room && t.room !== t.title) name.append(el('span', { class: 'inv-tab-name' }, t.title));
      const num = (n, strong) => el('td', { class: 'num' }, t.error ? '—' : n && strong ? el('strong', null, fmtInt(n)) : fmtInt(n));
      const checked = el('td');
      if (t.error) checked.append(el('span', { class: 'warn-text' }, "Couldn't be read"));
      else if (t.checked && t.checked.value) checked.append(t.checked.value);
      else if (t.checked) checked.append(el('span', { class: 'muted' }, 'not filled in'));
      return el('tr', { class: t.likely ? 'has-likely' : null }, name, num(t.items), num(t.likely, true), num(t.look, true), checked);
    }));

    // Tabs that couldn't be read.
    const bad = rep.tabs.filter(t => t.error);
    ui.problems.hidden = !bad.length;
    ui.problems.replaceChildren();
    if (bad.length) {
      ui.problems.append(el('h3', null, plural(bad.length, "tab couldn't be read", "tabs couldn't be read")),
        el('ul', null, ...bad.map(t => el('li', { id: tabAnchor(t) }, el('strong', null, t.title + ': '), t.error))));
    }

    // Each tab with matches.
    const L = links();
    ui.tabsResults.replaceChildren(...rep.tabs.filter(t => t.findings.length).map(t => {
      const sec = el('section', { class: 'inv-tab', id: tabAnchor(t), 'aria-labelledby': tabAnchor(t) + '-h' });
      sec.append(el('h3', { id: tabAnchor(t) + '-h' }, nameOf(t)));
      const meta = el('p', { class: 'check-source' });
      const words = [];
      if (t.room && t.room !== t.title) words.push('Tab “' + t.title + '”');
      words.push(plural(t.items, 'title', 'titles') + ': ' + fmtInt(t.likely) + ' likely banned, ' + fmtInt(t.look) + ' worth a look');
      if (t.checked) words.push('checked and updated by: ' + (t.checked.value || 'not filled in'));
      meta.append(words.join(' · ') + ' · ', extLink(Sheet.sheetUrl(state.sheet.id, t.gid), 'Open the tab'));
      sec.append(meta);
      for (const n of t.notes) sec.append(el('p', { class: 'note' }, n));
      const list = el('div', { class: 'hits' });
      for (const f of t.findings) list.append(findingCard(t, f, L));
      sec.append(list);
      return sec;
    }));
  }

  function findingCard(t, f, L) {
    const first = f.hits[0] && f.hits[0].row;
    const lvl = (first && first.status && first.status.level) || 'blank';
    const art = el('article', { class: 'card card-' + lvl + ' tier-' + (f.verdict === 'likely' ? 'match' : 'possible') });
    art.append(el('h4', { class: 'card-title' }, f.item.title));
    art.append(f.item.author ? el('p', { class: 'author' }, f.item.author) : el('p', { class: 'author missing' }, 'author not given'));
    art.append(el('p', { class: 'status status-' + lvl }, Inv.VERDICT[f.verdict] + ': ' + ((first && first.status && first.status.label) || 'status not stated')));
    const ul = el('ul', { class: 'inv-hits' });
    for (const h of f.hits) {
      const r = h.row;
      const li = el('li', null, el('span', { class: 'label' }, h.strength === 'likely' ? 'Listed as ' : 'Similar listing: '),
        '“' + str(r.title) + '”', r.author ? ', ' + str(r.author) : '', ' · ' + ((r.status && r.status.label) || 'status not stated'));
      if (h.why.length) li.append(el('span', { class: 'why' }, ' (' + h.why.join('; ') + ')'));
      const a = extLink(L.list(r), 'Open in the banned list', 'row-link');
      if (a) li.append(' ', a);
      ul.append(li);
    }
    if (f.more) ul.append(el('li', { class: 'muted' }, 'and ' + plural(f.more, 'more listing', 'more listings')));
    art.append(ul);
    const where = el('p', { class: 'where' }, 'Row ' + f.item.row);
    const a = extLink(L.inventory(t, f.item.row), 'Open in the inventory', 'row-link');
    if (a) where.append(a);
    art.append(where);
    return art;
  }

  // ---------------------------------------------------------------------------------------------
  // Downloads and writing back

  function fileName(what) {
    const d = state.checkedAt || new Date();
    const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const title = str(state.sheet && state.sheet.title).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    return 'CensorSearch ' + what + (title ? ' - ' + title : '') + ' - ' + day + '.csv';
  }

  function save(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = el('a', { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function writeResults(token) {
    const s = state.sheet;
    const say = (...nodes) => { ui.writeStatus.hidden = false; ui.writeStatus.replaceChildren(...nodes); };
    if (!token) { say(TEXT.expired); return; }
    say('Writing the results into the “' + Inv.RESULTS_TAB + '” tab…');
    try {
      const when = state.checkedAt.toLocaleString();
      const grid = Inv.sheetGrid(state.report, links(), when);
      const rowCount = grid.length + 5, columnCount = grid[0].length;
      const info = await api(base(s.id) + '?fields=' + encodeURIComponent('sheets.properties(sheetId,title)'), token);
      const found = (Array.isArray(info.sheets) ? info.sheets : []).map(x => x && x.properties).find(p => p && p.title === Inv.RESULTS_TAB);
      let gid;
      if (found) {
        gid = str(found.sheetId != null ? found.sheetId : 0);
        await api(base(s.id) + ':batchUpdate', token, { body: { requests: [{ updateSheetProperties: {
          properties: { sheetId: Number(gid), gridProperties: { rowCount, columnCount } }, fields: 'gridProperties.rowCount,gridProperties.columnCount' } }] } });
        await api(base(s.id) + '/values/' + encodeURIComponent(Sheet.a1Sheet(Inv.RESULTS_TAB)) + ':clear', token, { body: {} });
      } else {
        const made = await api(base(s.id) + ':batchUpdate', token, { body: { requests: [{ addSheet: {
          properties: { title: Inv.RESULTS_TAB, gridProperties: { rowCount, columnCount, frozenRowCount: 3 } } } }] } });
        const p = made.replies && made.replies[0] && made.replies[0].addSheet && made.replies[0].addSheet.properties;
        gid = str(p && p.sheetId != null ? p.sheetId : 0);
      }
      await api(base(s.id) + '/values/' + encodeURIComponent(Sheet.a1Sheet(Inv.RESULTS_TAB) + '!A1') + '?valueInputOption=RAW', token,
        { method: 'PUT', body: { majorDimension: 'ROWS', values: grid } });
      say('Written into the “' + Inv.RESULTS_TAB + '” tab of the inventory. ', extLink(Sheet.sheetUrl(s.id, gid), 'Open it'));
    } catch (err) {
      say(err && err.kind === 'access' ? TEXT.noAccessWrite : "The results weren't written into the sheet: " + (err && err.message ? err.message : String(err)));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Start

  function start() {
    if (!Sheet || !Engine || !SignIn || !Inv || typeof Sheet.fetchApi !== 'function') {
      setStatus("Part of the page didn't load. Reload the page to try again.");
      return;
    }
    ui.form.addEventListener('submit', findTabs);
    ui.all.addEventListener('click', () => setAll(true));
    ui.none.addEventListener('click', () => setAll(false));
    ui.only.addEventListener('click', () => { for (const b of state.boxes) b.input.checked = b.tab.gid === ui.only.getAttribute('data-gid'); updateCount(); });
    ui.check.addEventListener('click', onCheck);
    ui.download.addEventListener('click', () => { if (state.report) save(fileName('results'), Inv.toCsv(Inv.resultGrid(state.report, links()))); });
    ui.downloadSummary.addEventListener('click', () => { if (state.report) save(fileName('summary'), Inv.toCsv(Inv.summaryGrid(state.report))); });

    if (!SignIn.isClientId(cfg.googleClientId)) { setStatus(TEXT.noSignIn); return; }
    state.read = SignIn.create(window, cfg.googleClientId);
    setStatus('Loading Google sign-in…');
    state.read.load().then(() => {
      askToSignIn(TEXT.signin, () => {
        setStatus('Signed in. Paste the inventory sheet\'s link.');
        ui.form.hidden = false;
        loadList();
        ui.url.focus();
      });
    }, err => setStatus(err && err.message ? err.message : SignIn.messageFor('load')));
  }

  start();
})();
