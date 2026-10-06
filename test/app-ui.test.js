// Tests for src/app.js (the page controller), run in Node against a small fake DOM with fake timers and a stubbed
// fetch. Synthetic sheet data only. The fake DOM supports just what app.js uses; every element id it creates must
// exist in index.html (checked below), so the page and the harness can't drift apart.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SOURCES = { sheet: read('src/sheet.js'), signin: read('src/signin.js'), engine: read('src/engine.js'), app: read('src/app.js') };
const G = require('./helpers/google.js');
const SID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';
const SID2 = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-wxyz';
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx_Example-Deployment_0123456789abcdef/exec';
const OTHER_SCRIPT = 'https://script.google.com/macros/s/AKfycbAttackerDeploymentId0000000000/exec';
const MINUTE = 60 * 1000;

// ------------------------------------------------------------------------------------------------
// Fake DOM

const PAGE_IDS = [
  ['form', 'search-form'], ['textarea', 'q'], ['div', 'override-note'],
  ['p', 'status', { tabindex: '-1' }], ['p', 'status-warning'], ['p', 'status-actions'], ['p', 'source'],
  ['details', 'filter-box'], ['summary', 'filter-summary'], ['div', 'filter-codes'], ['button', 'filter-all'], ['button', 'filter-none'],
  ['p', 'notice', { tabindex: '-1' }], ['p', 'summary'], ['div', 'results'],
  ['details', 'maintainer-notes'], ['summary', 'maintainer-summary'], ['ul', 'maintainer-list'], ['a', 'footer-sheet'], ['a', 'footer-repo'],
];

// crypto.subtle.digest runs on Node's thread pool, so its promise can settle after flush() on a slow machine (CI).
// This stand-in computes the same SHA-256 synchronously and settles as a microtask, keeping the tests deterministic.
const syncCrypto = {
  subtle: {
    digest: async (alg, data) => {
      const h = require('crypto').createHash(String(alg).replace('-', '').toLowerCase()).update(Buffer.from(data)).digest();
      return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength);
    },
  },
};

function makePage(opts = {}) {
  // The clock stands still except in advance(): real time spent running the page (slow on a busy CI runner) must not
  // move timers set later past the end of an advance() and leave them unrun.
  const RealDate = Date;
  const START = RealDate.now();
  const clock = { offset: 0 };
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(START + clock.offset); }
    static now() { return START + clock.offset; }
  }
  const now = () => FakeDate.now();
  let tid = 1;
  const timers = new Map();
  const setTimeout_ = (fn, ms) => { const id = tid++; timers.set(id, { fn, due: now() + (ms || 0), every: 0 }); return id; };
  const setInterval_ = (fn, ms) => { const id = tid++; timers.set(id, { fn, due: now() + ms, every: ms }); return id; };
  const clear = id => { timers.delete(id); };
  const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
  async function advance(ms) {
    const end = now() + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.due <= end && (!next || t.due < next[1].due)) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      clock.offset += Math.max(0, t.due - now());
      if (t.every) t.due += t.every; else timers.delete(id);
      t.fn();
      await flush();
    }
    clock.offset += Math.max(0, end - now());
    await flush();
  }

  let doc;
  class Node_ {
    constructor() { this.parentNode = null; this.childNodes = []; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc.documentElement; }
  }
  class Text_ extends Node_ {
    constructor(t) { super(); this.data = String(t); }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
  }
  const FOCUSABLE = ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'];
  class Element_ extends Node_ {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.listeners = {}; this.dataset = {}; this.style = {};
      this.hidden = false; this.disabled = false; this.checked = false; this.value = '';
    }
    get id() { return this.attrs.get('id') || ''; } set id(v) { this.attrs.set('id', String(v)); }
    get className() { return this.attrs.get('class') || ''; } set className(v) { this.attrs.set('class', String(v)); }
    get href() { return this.attrs.get('href') || ''; } set href(v) { this.attrs.set('href', String(v)); }
    get target() { return this.attrs.get('target') || ''; } set target(v) { this.attrs.set('target', String(v)); }
    get rel() { return this.attrs.get('rel') || ''; } set rel(v) { this.attrs.set('rel', String(v)); }
    get type() { return this.attrs.get('type') || ''; } set type(v) { this.attrs.set('type', String(v)); }
    get scrollHeight() { return 20 * (1 + (String(this.value).match(/\n/g) || []).length); }
    setAttribute(k, v) { if (k === 'hidden') this.hidden = true; else this.attrs.set(k, String(v)); }
    getAttribute(k) { return k === 'hidden' ? (this.hidden ? '' : null) : this.attrs.has(k) ? this.attrs.get(k) : null; }
    removeAttribute(k) { if (k === 'hidden') this.hidden = false; else this.attrs.delete(k); }
    hasAttribute(k) { return k === 'hidden' ? this.hidden : this.attrs.has(k); }
    _adopt(c) { if (!(c instanceof Node_)) c = new Text_(c); if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; return c; }
    append(...cs) { for (const c of cs) this.childNodes.push(this._adopt(c)); }
    appendChild(c) { this.append(c); return c; }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; blurDetached(); return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    replaceChildren(...cs) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...cs); blurDetached(); }
    get children() { return this.childNodes.filter(c => c instanceof Element_); }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { this.replaceChildren(); if (String(v)) this.append(String(v)); }
    focus() {
      if (!this.isConnected) return;
      for (let n = this; n instanceof Element_; n = n.parentNode) if (n.hidden) return;
      const ok = FOCUSABLE.includes(this.tagName) || (this.tagName === 'A' && this.attrs.has('href')) || this.attrs.has('tabindex');
      if (ok && !this.disabled) doc.activeElement = this;
    }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    dispatchEvent(ev) {
      if (!ev.target) ev.target = this;
      for (let n = this; n; n = ev.bubbles === false ? null : n.parentNode) {
        ev.currentTarget = n;
        for (const fn of (n.listeners && n.listeners[ev.type]) || []) fn(ev);
      }
      return !ev.defaultPrevented;
    }
    matches(sel) {
      return sel.split(',').some(s => {
        const m = s.trim().match(/^([a-z0-9]*)((?:\.[\w-]+)*)(?:#([\w-]+))?$/i);
        if (!m) throw new Error('unsupported selector ' + s);
        if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
        const cls = this.className.split(/\s+/);
        if ((m[2] || '').split('.').filter(Boolean).some(c => !cls.includes(c))) return false;
        return !m[3] || this.id === m[3];
      });
    }
    closest(sel) { for (let n = this; n instanceof Element_; n = n.parentNode) if (n.matches(sel)) return n; return null; }
    querySelectorAll(sel) {
      const out = [];
      const walk = n => { for (const c of n.childNodes) if (c instanceof Element_) { if (c.matches(sel)) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  function blurDetached() { if (doc && doc.activeElement && !doc.activeElement.isConnected) doc.activeElement = doc.body; }

  doc = {
    listeners: {}, visibilityState: 'visible',
    createElement: t => new Element_(t),
    createTextNode: t => new Text_(t),
    getElementById(id) { return doc.documentElement.querySelectorAll('#' + id)[0] || null; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
  };
  doc.documentElement = new Element_('html');
  doc.body = new Element_('body');
  doc.documentElement.append(doc.body);
  doc.activeElement = doc.body;
  const byId = {};
  for (const [tag, id, attrs] of PAGE_IDS) {
    const e = new Element_(tag); e.id = id;
    for (const k of Object.keys(attrs || {})) e.setAttribute(k, attrs[k]);
    byId[id] = e;
  }
  byId['search-form'].append(byId.q);
  for (const [, id] of PAGE_IDS) if (id !== 'q') doc.body.append(byId[id]);
  for (const id of ['filter-box', 'maintainer-notes', 'footer-sheet', 'footer-repo', 'status-actions', 'notice', 'override-note']) byId[id].hidden = true;

  const href = opts.href || 'https://school.example/censorsearch/';
  const u = new URL(href);
  const opened = [];
  const logs = [];
  const win = {
    document: doc, location: { href, search: u.search, hash: u.hash, pathname: u.pathname, origin: u.origin },
    console: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a), info() {}, debug() {} },
    URL, URLSearchParams, Response, Headers, AbortController, DOMException, TextEncoder, crypto: syncCrypto,
    Date: FakeDate, setTimeout: setTimeout_, clearTimeout: clear, setInterval: setInterval_, clearInterval: clear,
    Node: Node_,
    listeners: {},
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    CENSORSEARCH_CONFIG: Object.assign({
      sheetUrl: 'https://docs.google.com/spreadsheets/d/' + SID + '/edit#gid=0',
      tabs: [{ gid: '0', name: 'Sheet1' }], scriptUrl: '', schoolCode: 'UAS', aliasesUrl: 'aliases.json', repoUrl: '',
    }, opts.config || {}),
  };
  win.open = opts.open || ((url, target) => {
    const w = {
      url, target, opener: win, closed: false, document: { title: '', body: { textContent: '' } },
      location: { _href: url, set href(v) { this._href = v; w.url = v; }, get href() { return this._href; }, replace(v) { this.href = v; } },
      close() { this.closed = true; },
    };
    opened.push(w);
    return w;
  });
  win.window = win; win.self = win; win.globalThis = win;
  if (opts.google) win.google = opts.google;
  win.fetch = (url, init) => opts.fetch(String(url), init);
  const ctx = vm.createContext(win);
  vm.runInContext(SOURCES.sheet, ctx, { filename: 'src/sheet.js' });
  vm.runInContext(SOURCES.signin, ctx, { filename: 'src/signin.js' });
  vm.runInContext(SOURCES.engine, ctx, { filename: 'src/engine.js' });

  const $ = id => byId[id];
  const page = {
    win, doc, $, box: byId.q, clock, opened, logs, advance, flush,
    start() { vm.runInContext(SOURCES.app, ctx, { filename: 'src/app.js' }); },
    async type(text) { byId.q.value = text; byId.q.dispatchEvent({ type: 'input', bubbles: true }); await advance(500); },
    async enter() { byId.q.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true, preventDefault() { this.defaultPrevented = true; } }); await flush(); },
    click(el) {
      const ev = { type: 'click', button: 0, bubbles: true, target: el, preventDefault() { this.defaultPrevented = true; } };
      el.dispatchEvent(ev);
      return ev;
    },
    change(input, checked) { input.checked = checked; input.dispatchEvent({ type: 'change', bubbles: true }); },
    text: id => byId[id].textContent,
    cards: () => byId.results.querySelectorAll('.card'),
    codeInput(code) { return byId['filter-codes'].querySelectorAll('input').find(i => i.parentNode.textContent.trim().startsWith(code + ' (')); },
    tab: key => byId.results.querySelector('#tab-' + key),
    async lineTab(key) { page.click(page.tab(key)); await flush(); },
    async key(el, key) { el.dispatchEvent({ type: 'keydown', key, bubbles: true, preventDefault() { this.defaultPrevented = true; } }); await flush(); },
    lines: () => byId.results.querySelectorAll('section.line').map(s => s.querySelector('h2').textContent),
    focused: () => doc.activeElement,
  };
  return page;
}

// ------------------------------------------------------------------------------------------------
// Synthetic sheet data and fetch stubs

const HEAD = ['Synthetic Banned List 2004-2026,,,,,,', 'updated as of 1 January 2026,,,,,,', 'Title,Author,ISBN,Banned By,Type,Year of Banning,Memo'];
const BASE_ROWS = [
  'Creepy Riddles for Kids,Pat Writer,,RS,Book,2010-2011,',     // 4: listed under RS only
  'Riddles of the Moon,Moon Author,,Ministry,Book,2011-2012,',   // 5
  'Zebra Tales,Zed Author,,Ministry,Book,2020-2021,memo one',    // 6
  'Quantum Garden ,Lee Author,9781234567897,KES,Book,2019-2020,',// 7: title ends with a space
  'Orchard Mysteries,Kim Doe,,Ministry,Book,2021-2022,',         // 8
  'Harbor Lights,Ann Other,,UAS,DVD,2022-2023,',                 // 9
];
const sheetCsv = (rows = BASE_ROWS, head = HEAD) => head.concat(rows).join('\r\n');
const csvResponse = (body, tab = 'Sheet1') => new Response(body, {
  status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': "attachment; filename*=UTF-8''My%20List%20-%20" + encodeURIComponent(tab) + '.csv' },
});
const aliasesResponse = () => new Response('{"aliases":[]}', { status: 200, headers: { 'content-type': 'application/json' } });

// fetch stub: aliases.json answers at once; sheet requests go to `sheet(url, n)` (a CSV string, a Response, an Error or a Promise).
function stubFetch(sheet) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (/aliases\.json/.test(url)) return aliasesResponse();
    const out = await sheet(url, calls.length);
    if (out instanceof Error) throw out;
    return typeof out === 'string' ? csvResponse(out) : out;
  };
  fn.calls = calls;
  return fn;
}

async function loaded(opts = {}) {
  let csvText = opts.csv || sheetCsv();
  const fetch = opts.fetch || stubFetch(() => csvText);
  const page = makePage(Object.assign({}, opts, { fetch }));
  page.start();
  await page.flush();
  page.setCsv = t => { csvText = t; };
  return page;
}

// ------------------------------------------------------------------------------------------------
test('harness: every element id the fake page uses exists in index.html', () => {
  const html = read('index.html');
  for (const [, id] of PAGE_IDS) assert.match(html, new RegExp('id="' + id + '"'), id);
  assert.match(html, /id="status"[^>]*tabindex="-1"/, 'the status line can take focus');
});

test('loaded state, a card, and the no-results box', async () => {
  const p = await loaded();
  assert.match(p.text('status'), /^6 items · updated as of 1 January 2026 \(from the sheet\) · fetched \d\d:\d\d$/);
  const sheetLink = p.$('status').querySelector('a');
  assert.equal(sheetLink.textContent, 'from the sheet');
  assert.match(sheetLink.href, /^https:\/\/docs\.google\.com\/spreadsheets\/d\//);
  await p.type('zebra tales');
  assert.equal(p.text('summary'), '1 listing found');
  const c = p.cards()[0];
  assert.match(c.textContent, /Zebra Tales/);
  assert.match(c.textContent, /Must remove \(Ministry\)/);
  assert.match(c.textContent, /Sheet1 · row 6/);
  const a = c.querySelector('a.row-link');
  assert.equal(a.href, 'https://docs.google.com/spreadsheets/d/' + SID + '/edit?gid=0#gid=0&range=A6:G6');
  assert.equal(a.rel, 'noopener noreferrer');
  await p.type('xyzzy plugh');
  assert.match(p.text('results'), /No listing found\. This does not mean the item is permitted\./);
  assert.match(p.text('results'), /the author's surname alone/);
});

test('before a search, a "View the entire list" button opens the sheet; it goes while a search is typed', async () => {
  const p = await loaded();
  const viewAll = () => p.$('results').querySelectorAll('a').filter(a => a.textContent === 'View the entire list');
  assert.equal(viewAll().length, 1);
  assert.equal(viewAll()[0].href, 'https://docs.google.com/spreadsheets/d/' + SID + '/edit?gid=0#gid=0');
  assert.equal(viewAll()[0].target, '_blank');
  await p.type('zebra tales');
  assert.equal(viewAll().length, 0);
  await p.type('');
  assert.equal(viewAll().length, 1);

  // No sheet link (an unknown ?script=): no button
  const q = await loaded({ href: 'https://school.example/censorsearch/?script=' + encodeURIComponent(OTHER_SCRIPT), fetch: stubFetch(() => jsonResponse(scriptBody(SID))) });
  assert.equal(q.$('results').querySelectorAll('a').length, 0);
});

// ------------------------------------------------------------------------------------------------
// Banned By filter: never hide silently, never report a hidden match as "no listing"

test('multi-line: a line whose matches are all hidden by the filter is not counted as "without" (BROWSER-1, APPSHEET-03, COV-2)', async () => {
  const p = await loaded();
  p.change(p.codeInput('RS'), false);
  await p.type('creepy\nzebra tales');
  const summary = p.text('summary');
  assert.doesNotMatch(summary, /1 without/, summary);
  assert.match(summary, /2 lines: 1 with matches, 1 with matches hidden by the Banned By filter, 0 without/);
  assert.doesNotMatch(p.text('results'), /line has no listing|lines have no listing/);
  await p.lineTab('none');
  assert.match(p.text('results'), /1 listing hidden by the Banned By filter/);

  p.click(p.$('filter-none'));
  await p.flush();
  assert.match(p.text('summary'), /2 lines: 0 with matches, 2 with matches hidden by the Banned By filter, 0 without/);
  assert.doesNotMatch(p.text('results'), /no listing\./);
});

test('possible-section intro never says "No row matches every word" while a full match is hidden (BROWSER-2, APPSHEET-04, COV-3)', async () => {
  const p = await loaded();
  await p.type('creepy riddles');
  assert.equal(p.cards().length, 2, 'the RS row matches every word; "Riddles of the Moon" is a possible match');
  p.change(p.codeInput('RS'), false);
  await p.flush();
  assert.match(p.text('results'), /1 more listing hidden by the Banned By filter/);
  assert.match(p.text('results'), /Possible matches \(1\)/);
  assert.doesNotMatch(p.text('results'), /No row matches every word/);
  assert.match(p.text('results'), /Rows that match every word are hidden by the Banned By filter/);
  p.change(p.codeInput('RS'), true);
  await p.type('riddles moon creepy');
  assert.ok(p.text('results').length > 0);
});

// ------------------------------------------------------------------------------------------------
// Cards

test('"listed as" appears only when the title differs beyond whitespace (BROWSER-6, COV-9)', async () => {
  const p = await loaded();
  await p.type('quantum garden');
  assert.equal(p.cards().length, 1);
  assert.equal(p.cards()[0].querySelector('.as-written'), null, p.cards()[0].textContent);
  const rows = BASE_ROWS.concat(['"Seventh Lantern, The",Some Author,,KES,Book,2020-2021,']);
  const q = await loaded({ csv: sheetCsv(rows) });
  await q.type('the seventh lantern');
  assert.match(q.cards()[0].querySelector('.as-written').textContent, /listed as “Seventh Lantern, The”/);
});

// ------------------------------------------------------------------------------------------------
// No results, keep typing, ISBN, semicolons, multi-line wording

test('multi-line: a line without a listing says so on its own row, with no shared block (BROWSER-7)', async () => {
  const p = await loaded();
  await p.type('zebra tales\nxyzzy plugh');
  await p.lineTab('all');
  assert.match(p.text('results'), /Line 2: “xyzzy plugh”No listing found/);
  assert.equal(p.$('results').querySelectorAll('.no-results').length, 0, 'no shared block');
  assert.equal(p.text('summary'), '2 lines: 1 with matches, 1 without');
});

test('multi-line: an error line is not counted as "no listing" (APPSHEET-12)', async () => {
  const p = await loaded();
  const real = p.win.CensorEngine.search;
  p.win.CensorEngine.search = (q, ix, o) => { if (q === 'orchard') throw new Error('boom'); return real(q, ix, o); };
  await p.type('orchard\nzebra tales');
  await p.lineTab('all');
  const s = p.text('summary');
  assert.match(s, /2 lines: 1 with matches, 1 couldn't be searched, 0 without/, s);
  const line1 = p.$('results').querySelectorAll('section.line')[0].textContent;
  assert.match(line1, /Something went wrong with this line \(boom\)/);
  assert.doesNotMatch(line1, /No listing found/);
  assert.doesNotMatch(p.text('results'), /line has no listing/);
});

test('multi-line: a line of only common words says it was not searched (COV-15)', async () => {
  const p = await loaded();
  await p.type('the\nzebra tales');
  await p.lineTab('all');
  const s = p.text('summary');
  assert.match(s, /2 lines: 1 with matches, 1 not searched \(only common words\), 0 without/, s);
  const line1 = p.$('results').querySelectorAll('section.line')[0].textContent;
  assert.match(line1, /Not searched: this line has only common words such as “the”\./);
  assert.doesNotMatch(line1, /No listing found/);
  assert.doesNotMatch(p.text('results'), /line has no listing/);
});

test('multi-line: tabs sort the lines, banned first and chosen by default; "All lines" keeps the pasted order', async () => {
  const p = await loaded();
  await p.type('xyzzy plugh\nmoon garden\nzebra tales\nharbor lights');
  const bar = p.$('results').querySelector('.line-tabs');
  assert.equal(bar.getAttribute('role'), 'tablist');
  const tabs = bar.querySelectorAll('button');
  assert.deepEqual(tabs.map(t => t.textContent), ['Banned (2)', 'Possible matches (1)', 'No listing (1)', 'All lines (4)']);
  assert.deepEqual(tabs.map(t => t.getAttribute('aria-selected')), ['true', 'false', 'false', 'false']);
  assert.deepEqual(tabs.map(t => t.getAttribute('tabindex')), ['0', '-1', '-1', '-1']);
  const panel = p.$('results').querySelector('.line-panel');
  assert.equal(panel.getAttribute('aria-labelledby'), p.tab('listed').id);
  assert.deepEqual(p.lines(), ['Line 3: “zebra tales”', 'Line 4: “harbor lights”']);
  assert.match(p.text('summary'), /^4 lines: 2 with matches, 1 with possible matches only, 1 without$/, 'the summary still counts every line');

  await p.lineTab('none');
  assert.deepEqual(p.lines(), ['Line 1: “xyzzy plugh”']);
  assert.equal(p.focused(), p.tab('none'), 'focus stays on the chosen tab');
  assert.equal(p.tab('none').getAttribute('aria-selected'), 'true');
  await p.lineTab('all');
  assert.deepEqual(p.lines().map(t => t.split(':')[0]), ['Line 1', 'Line 2', 'Line 3', 'Line 4']);

  // Arrow keys move between tabs (wrapping) and show the tab they land on.
  await p.key(p.tab('all'), 'ArrowRight');
  assert.equal(p.focused(), p.tab('listed'));
  assert.equal(p.lines().length, 2);
  await p.key(p.tab('listed'), 'End');
  assert.equal(p.focused(), p.tab('all'));
  await p.key(p.tab('all'), 'ArrowLeft');
  assert.equal(p.focused(), p.tab('none'));
});

test('multi-line: no tabs when every line has the same outcome', async () => {
  const p = await loaded();
  await p.type('zebra tales\nharbor lights');
  assert.equal(p.$('results').querySelector('.line-tabs'), null);
  assert.equal(p.lines().length, 2);
});

test('multi-line: the chosen tab survives a filter change, falls back while empty, and resets for new text', async () => {
  const p = await loaded();
  const list = 'zebra tales\nxyzzy plugh\ncreepy\nriddles banana\nharbor lights';
  await p.type(list);
  await p.lineTab('possible');
  assert.deepEqual(p.lines().map(t => t.split(':')[0]), ['Line 4']);
  p.change(p.codeInput('RS'), false);   // "creepy" is listed under RS only: it moves to "No listing"
  await p.flush();
  assert.equal(p.tab('possible').getAttribute('aria-selected'), 'true', 'kept across a filter change');
  assert.deepEqual(p.lines().map(t => t.split(':')[0]), ['Line 4']);
  p.change(p.codeInput('Ministry'), false);   // no possible match left: the first tab shows meanwhile
  await p.flush();
  assert.equal(p.tab('possible'), null);
  assert.equal(p.tab('listed').getAttribute('aria-selected'), 'true');
  assert.deepEqual(p.lines(), ['Line 5: “harbor lights”']);
  p.change(p.codeInput('Ministry'), true);
  await p.flush();
  assert.equal(p.tab('possible').getAttribute('aria-selected'), 'true', 'and comes back when it has lines again');
  await p.type(list + '\norchard');
  assert.equal(p.tab('listed').getAttribute('aria-selected'), 'true', 'new text starts on the first tab');
});

test('a 1–2 letter unfinished query with no hit shows "Keep typing…", not the no-results box (COV-14)', async () => {
  const p = await loaded();
  await p.type('zz');
  assert.equal(p.text('summary'), 'Keep typing…');
  assert.equal(p.$('results').querySelector('.no-results'), null);
  await p.enter();
  assert.match(p.text('results'), /No listing found\. This does not mean the item is permitted\./, 'Enter searches it as typed');
});

test('an ISBN search with no hit leads with the ISBN message and drops the "the ISBN" tip (COV-10)', async () => {
  const p = await loaded();
  await p.type('9780140449136');
  const box = p.$('results').querySelector('.no-results');
  const t = box.textContent;
  assert.match(t, /No ISBN match\. Most rows have no ISBN, so search the title and author\./);
  assert.ok(t.indexOf('No ISBN match') < t.indexOf('Try:'), 'the ISBN message comes before the tips');
  assert.ok(!box.querySelectorAll('li').some(li => li.textContent === 'the ISBN'));
});

test('a one-line search with a semicolon notes that semicolons do not split searches yet (E1-11)', async () => {
  const p = await loaded();
  await p.type('zebra tales; orchard');
  assert.match(p.text('results'), /Semicolons don't split a search yet: everything in the box was searched together\. To check several titles, put each on its own line\./);
  await p.type('zebra tales؛ orchard');
  assert.match(p.text('results'), /Semicolons don't split a search yet/);
  await p.type('zebra tales');
  assert.doesNotMatch(p.text('results'), /Semicolons/);
});

// ------------------------------------------------------------------------------------------------
// Loading, failure and sources

const HEADERS = ['Title', 'Author', 'ISBN', 'Banned By', 'Type', 'Year of Banning', 'Memo'];
const scriptBody = (spreadsheetId, extra = {}) => JSON.stringify(Object.assign({
  format: 'censorsearch-v1', spreadsheetId,
  tabs: [{
    name: 'Sheet1', gid: '0', headerRow: 3, above: [['Synthetic Banned List'], ['updated as of 1 January 2026']],
    headers: HEADERS, columns: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], lastColumn: 'G',
    rows: [
      { row: 4, values: ['Zebra Tales', 'Zed Author', '', 'RS', 'Book', '2020-2021', ''] },
      { row: 5, values: ['Orchard Mysteries', 'Kim Doe', '', 'Ministry', 'Book', '2021-2022', ''] },
    ],
  }],
}, extra));
const jsonResponse = body => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const sheetHref = (id, suffix = '/edit?usp=sharing') => 'https://school.example/censorsearch/?sheet=' + encodeURIComponent('https://docs.google.com/spreadsheets/d/' + id + suffix);

test('config script path: a failed load still links to the sheet named by sheetUrl (BROWSER-3, APPSHEET-05)', async () => {
  const p = await loaded({ config: { scriptUrl: SCRIPT_URL }, fetch: stubFetch(() => new TypeError('Failed to fetch')) });
  assert.match(p.text('status'), /Can't reach the sheet's script/);
  const links = p.$('status-actions').querySelectorAll('a');
  assert.deepEqual(links.map(a => [a.textContent, a.href]), [['Open the sheet', 'https://docs.google.com/spreadsheets/d/' + SID + '/edit?gid=0#gid=0']]);
  assert.equal(p.$('footer-sheet').hidden, true, 'the footer link is never shown');
  assert.ok(p.$('status-actions').querySelector('button'), 'Retry');

  // With a ?script= link the sheet isn't known, so there is no sheet link.
  const q = await loaded({ href: 'https://school.example/censorsearch/?script=' + encodeURIComponent(OTHER_SCRIPT), fetch: stubFetch(() => new TypeError('Failed to fetch')) });
  assert.deepEqual(q.$('status-actions').querySelectorAll('a').map(a => a.textContent), ['Use the default list']);
});

test('Retry keeps keyboard focus: on the new Retry button, or on the status line once loaded (BROWSER-8)', async () => {
  let fail = true;
  const p = await loaded({ fetch: stubFetch(() => (fail ? new TypeError('Failed to fetch') : sheetCsv())) });
  let retry = p.$('status-actions').querySelector('button');
  retry.focus();
  p.click(retry);
  await p.flush();
  assert.equal(p.focused().textContent, 'Retry');
  assert.ok(p.focused().isConnected);
  fail = false;
  retry = p.focused();
  p.click(retry);
  await p.flush();
  assert.match(p.text('status'), /^6 items/);
  assert.equal(p.focused(), p.$('status'));
});

test('?sheet= link without a gid reads the first tab; row links name gid 0 only when it is that tab (BROWSER-4, APPSHEET-08, COV-6)', async () => {
  const first = /\/export\?format=csv$/;
  // gid 0 is the first tab (the usual case): links keep their row range
  let f = stubFetch(url => (first.test(url) || /gid=0$/.test(url) ? csvResponse(sheetCsv(), 'Sheet1') : new Response('', { status: 400 })));
  let p = await loaded({ href: sheetHref(SID2), fetch: f });
  assert.ok(f.calls.some(c => first.test(c.url)), 'the data comes from the export without a gid');
  await p.type('zebra tales');
  assert.equal(p.cards()[0].querySelector('a.row-link').href, 'https://docs.google.com/spreadsheets/d/' + SID2 + '/edit?gid=0#gid=0&range=A6:G6');

  // gid 0 was deleted: Google answers 400 for it, but the first tab still loads
  f = stubFetch(url => (first.test(url) ? csvResponse(sheetCsv(), 'Main List') : new Response('', { status: 400 })));
  p = await loaded({ href: sheetHref(SID2), fetch: f });
  assert.match(p.text('status'), /^6 items/);
  await p.type('zebra tales');
  assert.match(p.cards()[0].textContent, /Main List · row 6/);
  assert.equal(p.cards()[0].querySelector('a.row-link').href, 'https://docs.google.com/spreadsheets/d/' + SID2 + '/edit');

  // gid 0 is a later tab: the first tab is still the one searched
  f = stubFetch(url => (first.test(url) ? csvResponse(sheetCsv(), 'Main List') : csvResponse(sheetCsv(['Archive Only Title,,,KES,Book,2001,']), 'Archive')));
  p = await loaded({ href: sheetHref(SID2), fetch: f });
  await p.type('zebra tales');
  assert.equal(p.cards().length, 1);
  assert.match(p.cards()[0].textContent, /Main List · row 6/);
  await p.type('archive only title');
  assert.equal(p.cards().length, 0);
});

test('?script= to an unknown deployment is marked as not the usual list, and gets no sheet or row links (SEC-01)', async () => {
  const href = 'https://school.example/censorsearch/?script=' + encodeURIComponent(OTHER_SCRIPT);
  const p = await loaded({ href, fetch: stubFetch(() => jsonResponse(scriptBody(SID))) });
  const note = p.$('override-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /not this page's usual list/);
  assert.match(note.textContent, /AKfycbAttackerDeploymentId0000000000/);
  assert.ok(note.querySelectorAll('a').some(a => a.textContent === 'Use the default list'));
  assert.ok(!p.$('source').querySelectorAll('a').some(a => a.href.includes(SID)), 'no link to the sheet the script claims');
  assert.equal(p.$('footer-sheet').hidden, true);
  await p.type('zebra tales');
  assert.equal(p.cards().length, 1);
  assert.equal(p.$('results').querySelector('a.row-link'), null);
  assert.match(p.cards()[0].textContent, /Sheet1 · row 4/);

  // A script's own error text is quoted, not presented as the page's words
  const q = await loaded({ href, fetch: stubFetch(() => jsonResponse(JSON.stringify({ format: 'censorsearch-v1', error: 'Call 555-0100 to confirm.' }))) });
  assert.match(q.text('status'), /The script says: “Call 555-0100 to confirm\.”/);
});

test("?script= for the page's own script (config.scriptUrl or config.trustedScripts) is trusted (SEC-01)", async () => {
  const href = 'https://school.example/censorsearch/?script=' + encodeURIComponent(SCRIPT_URL);
  let p = await loaded({ href, config: { scriptUrl: SCRIPT_URL }, fetch: stubFetch(() => jsonResponse(scriptBody(SID))) });
  assert.equal(p.$('override-note').hidden, true);
  await p.type('zebra tales');
  assert.ok(p.$('results').querySelector('a.row-link'));

  const digest = require('crypto').createHash('sha256').update(SCRIPT_URL).digest('hex');
  p = await loaded({ href, config: { trustedScripts: [digest] }, fetch: stubFetch(() => jsonResponse(scriptBody(SID))) });
  assert.equal(p.$('override-note').hidden, true);
  await p.type('zebra tales');
  assert.equal(p.cards()[0].querySelector('a.row-link').href, 'https://docs.google.com/spreadsheets/d/' + SID + '/edit?gid=0#gid=0&range=A4:G4');

  // An untrusted script's maintainer note gives the digest to add
  p = await loaded({ href, fetch: stubFetch(() => jsonResponse(scriptBody(SID))) });
  assert.equal(p.$('override-note').hidden, false);
  assert.match(p.text('maintainer-list'), new RegExp(digest));
});

test('?sheet= override shows a warning that names the sheet being read (SEC-03)', async () => {
  const p = await loaded({ href: sheetHref(SID2, '/edit#gid=0'), fetch: stubFetch(() => csvResponse(sheetCsv(), 'Sheet1')) });
  const note = p.$('override-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /This page is showing another sheet, not its usual list: “Synthetic Banned List 2004-2026” \(sheet 1ZyXwV…wxyz\)\./);
  assert.ok(note.querySelectorAll('a').some(a => a.textContent === 'Use the default list'));
  const d = await loaded();
  assert.equal(d.$('override-note').hidden, true);
  const own = await loaded({ href: sheetHref(SID, '/edit#gid=123'), fetch: stubFetch(() => csvResponse(sheetCsv(), 'Other')) });
  assert.equal(own.$('override-note').hidden, true, "another tab of the page's own sheet is not a warning");
  assert.match(own.text('source'), /as this page's address asks/);
});

test('partial load: the no-results text says which tab was not searched (APPSHEET-06)', async () => {
  const f = stubFetch(url => (/gid=123/.test(url) ? new Response('oops', { status: 500 }) : sheetCsv()));
  const p = await loaded({ config: { tabs: [{ gid: '0', name: 'Sheet1' }, { gid: '123', name: 'Other Materials' }] }, fetch: f });
  await p.type('xyzzy plugh');
  assert.match(p.$('results').querySelector('.no-results').textContent, /Other Materials couldn't be loaded, so it wasn't searched\./);
  await p.type('zebra tales\nxyzzy plugh');
  assert.match(p.text('results'), /Other Materials couldn't be loaded, so it wasn't searched\./);
});

test('a stalled aliases.json does not keep the page loading (APPSHEET-07)', async () => {
  const fetch = url => (/aliases/.test(url) ? new Promise(() => {}) : Promise.resolve(csvResponse(sheetCsv())));
  const p = makePage({ fetch });
  p.start();
  await p.type('zebra tales');
  await p.advance(10 * 1000);
  assert.match(p.text('status'), /^6 items/);
  assert.equal(p.text('summary'), '1 listing found');
});

// ------------------------------------------------------------------------------------------------
// Freshness: moved rows, the click re-check, and focus

const rowLink = (id, row) => 'https://docs.google.com/spreadsheets/d/' + id + '/edit?gid=0#gid=0&range=A' + row + ':G' + row;
function heldFetch(getCsv) {
  const state = { hold: null };
  const fn = stubFetch(async () => { if (state.hold) await state.hold.promise; return getCsv(); });
  fn.hold = () => { let release; const promise = new Promise(r => { release = r; }); state.hold = { promise, release }; };
  fn.release = async page => { const h = state.hold; state.hold = null; if (h) h.release(); await page.flush(); };
  return fn;
}
async function ageData(p, minutes = 6) {
  p.doc.visibilityState = 'hidden';
  await p.advance(minutes * MINUTE);
  p.doc.visibilityState = 'visible';
}
async function loadedHeld(rows, opts = {}) {
  let text = sheetCsv(rows);
  const fetch = heldFetch(() => text);
  const p = makePage(Object.assign({}, opts, { fetch }));
  p.start();
  await p.flush();
  p.setCsv = t => { text = t; };
  p.fetch = fetch;
  return p;
}
const cardOf = (p, typeText) => p.cards().find(c => c.querySelector('.meta').textContent.includes(typeText));

const DUP_V1 = ['Alpha Book,A Writer,,KES,Book,2020,', 'Beta Book,B Writer,,KES,Book,2020,', 'Zebra Tales,Zed Author,,Ministry,Book,2020,memo one',
  'Delta Book,D Writer,,KES,Book,2020,', 'Zebra Tales,Zed Author,,Ministry,DVD,2020,memo two'];   // Zebra: Book row 6, DVD row 8
const DUP_V2 = ['Aardvark Book,New Writer,,KES,Book,2021,'].concat(DUP_V1);                         // Zebra: Book row 7, DVD row 9

test('rows sharing a fingerprint: each card notes its own move after a silent refresh (APPSHEET-01)', async () => {
  const p = await loadedHeld(DUP_V1);
  await p.type('zebra tales');
  assert.equal(p.cards().length, 2);
  p.setCsv(sheetCsv(DUP_V2));
  await p.advance(6 * MINUTE);
  const book = cardOf(p, 'Type: Book'), dvd = cardOf(p, 'Type: DVD');
  assert.equal(book.querySelector('.moved').textContent, 'moved from row 6 to 7');
  assert.equal(dvd.querySelector('.moved').textContent, 'moved from row 8 to 9');
});

test('rows sharing a fingerprint: the click re-check opens the clicked row at its new place (APPSHEET-01, COV-11)', async () => {
  const p = await loadedHeld(DUP_V1);
  await p.type('zebra tales');
  await ageData(p);
  p.setCsv(sheetCsv(DUP_V2));
  const link = cardOf(p, 'Type: DVD').querySelector('a.row-link');
  const ev = p.click(link);
  assert.ok(ev.defaultPrevented);
  assert.equal(p.opened.length, 1, 'a tab opens at once, inside the click');
  assert.equal(p.opened[0].opener, null);
  await p.flush();
  assert.equal(p.opened[0].url, rowLink(SID, 9));
  const dvd = cardOf(p, 'Type: DVD').querySelector('a.row-link');
  assert.equal(dvd.textContent, 'Checked again: now at row 9 — open it');
  assert.equal(dvd.href, rowLink(SID, 9));
  assert.equal(cardOf(p, 'Type: Book').querySelector('a.row-link').textContent, 'Open in the sheet (Sheet1 row 7)');
});

test('click re-check: failure opens the row as loaded; a removed row closes the tab and says so (COV-11)', async () => {
  const p = await loadedHeld(BASE_ROWS);
  await p.type('orchard');
  await ageData(p);
  p.fetch.hold();
  p.click(p.$('results').querySelector('a.row-link'));
  assert.equal(p.opened.length, 1);
  p.setCsv(new TypeError('Failed to fetch'));
  p.fetch.release(p);
  await p.flush();
  // stubFetch throws an Error value returned by the sheet function
  assert.equal(p.opened[0].url, rowLink(SID, 8));
  assert.match(p.$('results').querySelector('a.row-link').textContent, /^Couldn't check again; opened row 8 as loaded at \d\d:\d\d$/);

  const q = await loadedHeld(BASE_ROWS);
  await q.type('orchard');
  await ageData(q);
  q.setCsv(sheetCsv(BASE_ROWS.filter(r => !r.startsWith('Orchard'))));
  q.click(q.$('results').querySelector('a.row-link'));
  await q.flush();
  assert.equal(q.opened[0].closed, true);
  assert.match(q.text('notice'), /isn't in the sheet as it was/);
});

test('a "Checked again" notice does not outlive a refresh that changes the data; the re-check never takes focus from the search box (APPSHEET-02, APPSHEET-09)', async () => {
  const p = await loadedHeld(BASE_ROWS, { open: () => null });   // popup blocked: the page falls back to the in-page link
  await p.type('orchard');
  await ageData(p);
  p.setCsv(sheetCsv(['Aaa One,X,,KES,Book,2020,', 'Aab Two,Y,,KES,Book,2020,'].concat(BASE_ROWS)));
  p.fetch.hold();
  p.click(p.$('results').querySelector('a.row-link'));
  p.box.focus();
  await p.type('zebra tales');
  await p.fetch.release(p);
  assert.match(p.text('notice'), /Sheet1 row 8 \(“Orchard Mysteries”\): Checked again: now at row 10 — open it/);
  assert.equal(p.focused(), p.box, 'focus stays in the search box');

  p.setCsv(sheetCsv(['Aaa One,X,,KES,Book,2020,', 'Aab Two,Y,,KES,Book,2020,', 'Aac Three,Z,,KES,Book,2020,'].concat(BASE_ROWS)));
  await p.advance(6 * MINUTE);
  assert.equal(p.$('notice').hidden, true, 'the notice about row 10 is gone once the data changed again');
  assert.equal(p.focused(), p.box);
});

test('click re-check with the row still on screen: focus moves to the link only if it was there (APPSHEET-09)', async () => {
  const p = await loadedHeld(BASE_ROWS, { open: () => null });
  await p.type('orchard');
  await ageData(p);
  p.fetch.hold();
  const link = p.$('results').querySelector('a.row-link');
  link.focus();
  p.click(link);
  p.box.focus();
  await p.fetch.release(p);
  assert.equal(p.$('results').querySelector('a.row-link').textContent, 'Checked again: still at row 8 — open it');
  assert.equal(p.focused(), p.box);
});

test('the same row shown twice: the clicked link gets the result, not the first one (APPSHEET-10)', async () => {
  const p = await loadedHeld(BASE_ROWS, { open: () => null });
  await p.type('orchard\nkim doe');
  const links = p.$('results').querySelectorAll('a.row-link');
  assert.equal(links.length, 2);
  await ageData(p);
  links[1].focus();
  p.click(links[1]);
  await p.flush();
  assert.equal(links[1].textContent, 'Checked again: still at row 8 — open it');
  assert.equal(links[1].getAttribute('aria-busy'), null);
  assert.equal(p.focused(), links[1]);
  assert.equal(links[0].textContent, 'Open in the sheet (Sheet1 row 8)');
});

test('a silent refresh that changes the data keeps focus on the same card and filter checkbox (APPSHEET-11)', async () => {
  const dragons = Array.from({ length: 60 }, (_, i) => 'Dragon Tale ' + (i + 1) + ',Dee Writer,,' + (i % 2 ? 'KES' : 'Ministry') + ',Book,2020,');
  const p = await loadedHeld(dragons);
  await p.type('dragon tale');
  const more = p.$('results').querySelectorAll('button').find(b => /^Show all 60/.test(b.textContent));
  p.click(more);
  const before = p.focused();
  assert.equal(before.className.split(' ')[0], 'card');
  const title = before.querySelector('.card-title').textContent;
  p.setCsv(sheetCsv(['Aardvark,New,,KES,Book,2021,'].concat(dragons)));
  await p.advance(6 * MINUTE);
  assert.notEqual(p.focused(), before, 'the results were rebuilt');
  assert.equal(p.focused().querySelector('.card-title').textContent, title);

  const kes = p.codeInput('KES');
  kes.focus();
  p.setCsv(sheetCsv(['Aardvark,New,,KES,Book,2021,', 'Aardwolf,New,,KES,Book,2021,'].concat(dragons)));
  await p.advance(6 * MINUTE);
  assert.equal(p.focused(), p.codeInput('KES'));
  assert.match(p.codeInput('KES').parentNode.textContent, /KES \(32\)/);
});

test('"moved" notes go on the cards on screen when the new data lands (APPSHEET-13)', async () => {
  const p = await loadedHeld(BASE_ROWS);
  await p.type('orchard');
  p.fetch.hold();
  await p.advance(6 * MINUTE);                 // the silent refresh starts and waits
  await p.type('zebra tales');
  p.setCsv(sheetCsv(['Aaa One,X,,KES,Book,2020,'].concat(BASE_ROWS)));
  await p.fetch.release(p);
  assert.equal(p.cards()[0].querySelector('.moved').textContent, 'moved from row 6 to 7');
  await p.type('orchard');
  assert.equal(p.cards()[0].querySelector('.moved'), null, 'not on screen when the data changed');
});

// ------------------------------------------------------------------------------------------------
// Review round 2

test('an unknown ?script= gets no memo or title-cell links either; the memo text still shows (WEB2-1, BR2-1)', async () => {
  const withLinks = scriptBody(SID, {});
  const json = JSON.parse(withLinks);
  json.tabs[0].rows[0].values[6] = 'Ministry memo 751459';
  json.tabs[0].rows[0].links = { 0: 'https://accounts-google.example/signin', 6: 'https://accounts-google.example/memo' };
  const body = JSON.stringify(json);
  const href = 'https://school.example/censorsearch/?script=' + encodeURIComponent(OTHER_SCRIPT);
  const p = await loaded({ href, fetch: stubFetch(() => jsonResponse(body)) });
  assert.match(p.$('override-note').textContent, /its rows get no links/);
  await p.type('zebra tales');
  const c = p.cards()[0];
  assert.deepEqual(c.querySelectorAll('a').map(a => a.href), [], 'no link of any kind from the unknown script');
  assert.match(c.querySelector('.memo').textContent, /^Memo: Ministry memo 751459$/);

  // The page's own script keeps them
  const own = await loaded({ config: { scriptUrl: SCRIPT_URL }, fetch: stubFetch(() => jsonResponse(body)) });
  await own.type('zebra tales');
  const hrefs = own.cards()[0].querySelectorAll('a').map(a => a.href);
  assert.ok(hrefs.includes('https://accounts-google.example/memo') && hrefs.includes('https://accounts-google.example/signin'), hrefs.join(' '));
});

test('a complete query ending in a 1–2 letter word gets the no-results box; a lone short word still says "Keep typing…" (WEB2-2)', async () => {
  const p = await loaded();
  for (const q of ['it ends with us', 'the wizard of oz']) {
    await p.type(q);
    assert.equal(p.text('summary'), 'No listing found. This does not mean the item is permitted.', q);
    const box = p.$('results').querySelector('.no-results');
    assert.ok(box, q);
    assert.match(box.textContent, /No listing found\. This does not mean the item is permitted\./);
    assert.match(box.textContent, /the author's surname alone/);
  }
  await p.type('oz');
  assert.equal(p.text('summary'), 'Keep typing…');
  assert.equal(p.$('results').querySelector('.no-results'), null);
});

test('a refresh that reads every tab again is kept: a first tab whose id became known, a script that dropped a tab (WEB2-3)', async () => {
  // ?sheet= without a gid: the gid 0 check fails on the first load, then works; the sheet gains a row above Zebra Tales
  const first = /\/export\?format=csv$/;
  let probeFails = true, csv = sheetCsv();
  const f = stubFetch(url => {
    if (/gid=0$/.test(url)) return probeFails ? new Response('', { status: 429 }) : csvResponse(csv, 'Sheet1');
    if (first.test(url)) return csvResponse(csv, 'Sheet1');
    return new Response('', { status: 400 });
  });
  const p = await loaded({ href: sheetHref(SID2), fetch: f });
  await p.type('zebra tales');
  assert.equal(p.cards()[0].querySelector('a.row-link').href, 'https://docs.google.com/spreadsheets/d/' + SID2 + '/edit');
  probeFails = false;
  csv = sheetCsv(['Aardvark,New,,KES,Book,2021,'].concat(BASE_ROWS));
  await p.advance(6 * MINUTE);
  assert.match(p.text('status'), /^7 items/);
  assert.equal(p.text('status-warning'), '');
  let card = p.cards()[0];
  assert.match(card.textContent, /Sheet1 · row 7/);
  assert.equal(card.querySelector('.moved').textContent, 'moved from row 6 to 7', 'the same row, now with its tab id');
  assert.equal(card.querySelector('a.row-link').href, rowLink(SID2, 7));
  // The tab's id is kept from then on: later refreshes read gid 0 directly, so the row links keep their row
  const before = f.calls.length;
  csv = sheetCsv(['Aardvark,New,,KES,Book,2021,', 'Aardwolf,New,,KES,Book,2021,'].concat(BASE_ROWS));
  await p.advance(6 * MINUTE);
  assert.ok(f.calls.length > before);
  assert.ok(f.calls.slice(before).every(c => !first.test(c.url)), f.calls.slice(before).map(c => c.url).join(' '));
  card = p.cards()[0];
  assert.equal(card.querySelector('a.row-link').href, rowLink(SID2, 8));

  // Script path: the maintainer drops Other Materials from the script and adds a row to Sheet1
  const tab = (name, gid, rows) => ({ name, gid, headerRow: 3, above: [['L'], ['updated as of 1 January 2026']], headers: HEADERS, rows });
  let mode = 'both';
  const body = () => JSON.stringify({
    format: 'censorsearch-v1', spreadsheetId: SID,
    tabs: [tab('Sheet1', '0', [{ row: 4, values: ['Zebra Tales', 'Zed', '', 'Ministry', 'Book', '2020', ''] }]
      .concat(mode === 'both' ? [] : [{ row: 5, values: ['Newly Banned Title', 'X', '', 'Ministry', 'Book', '2026', ''] }]))]
      .concat(mode === 'both' ? [tab('Other Materials', '111', [{ row: 4, values: ['Amplify Unit', '', '', 'Ministry', 'Book', '2020', ''] }])] : []),
    errors: mode === 'error' ? [{ tab: 'Other Materials', message: 'Tab not readable.' }] : [],
  });
  const s = await loaded({ config: { scriptUrl: SCRIPT_URL }, fetch: stubFetch(() => jsonResponse(body())) });
  assert.match(s.text('status'), /^2 items \(Sheet1 1, Other Materials 1\)/);
  mode = 'error';                       // the script says it couldn't read the tab: keep the full list
  await s.advance(6 * MINUTE);
  assert.match(s.text('status'), /^2 items \(Sheet1 1, Other Materials 1\)/);
  assert.match(s.text('status-warning'), /^Couldn't refresh since \d\d:\d\d; showing data fetched at \d\d:\d\d\.$/);
  mode = 'dropped';                     // the script no longer returns the tab, and says nothing is wrong
  await s.advance(MINUTE);
  assert.match(s.text('status'), /^2 items · updated as of 1 January 2026/);
  assert.equal(s.text('status-warning'), '');
  await s.type('newly banned title');
  assert.equal(s.text('summary'), '1 listing found');
});

test('background checks keep keyboard focus on Retry and do not rewrite unchanged status text (WEB2-5)', async () => {
  // partial list: the silent refresh every 5 minutes rebuilds the status
  const f = stubFetch(url => (/gid=123/.test(url) ? new Response('oops', { status: 500 }) : sheetCsv()));
  const p = await loaded({ config: { tabs: [{ gid: '0', name: 'Sheet1' }, { gid: '123', name: 'Other Materials' }] }, fetch: f });
  p.$('status-actions').querySelector('button').focus();
  await p.advance(6 * MINUTE);
  assert.equal(p.focused().tagName, 'BUTTON');
  assert.equal(p.focused().textContent, 'Retry');
  assert.ok(p.focused().isConnected);

  // refreshes failing every minute: same words, same text node, focus stays
  const q = await loaded();
  q.setCsv(new TypeError('Failed to fetch'));
  await q.advance(6 * MINUTE);
  const warning = q.text('status-warning');
  assert.match(warning, /^Couldn't refresh since \d\d:\d\d; showing data fetched at \d\d:\d\d\.$/);
  const node = q.$('status-warning').childNodes[0], statusNode = q.$('status').childNodes[0];
  q.$('status-actions').querySelector('button').focus();
  await q.advance(3 * MINUTE);
  assert.equal(q.text('status-warning'), warning);
  assert.equal(q.$('status-warning').childNodes[0], node, 'the live region is not rewritten');
  assert.equal(q.$('status').childNodes[0], statusNode);
  assert.equal(q.focused().textContent, 'Retry');
  assert.ok(q.focused().isConnected);
  // once a refresh works, the Retry button goes and focus moves to the status line
  q.setCsv(sheetCsv());
  await q.advance(MINUTE);
  assert.equal(q.text('status-warning'), '');
  assert.equal(q.focused(), q.$('status'));
});

test('over plain http (no crypto.subtle) the maintainer note explains how to trust the script (WEB2-6)', async () => {
  const digest = require('crypto').createHash('sha256').update(SCRIPT_URL).digest('hex');
  const href = 'http://intranet.school.example/censorsearch/?script=' + encodeURIComponent(SCRIPT_URL);
  const open = async config => {
    const p = makePage({ href, config, fetch: stubFetch(() => jsonResponse(scriptBody(SID))) });
    p.win.crypto = { getRandomValues() {} };
    p.start();
    await p.flush();
    return p;
  };
  let p = await open({ trustedScripts: [digest] });
  assert.equal(p.$('override-note').hidden, false);
  const notes = p.text('maintainer-list');
  assert.match(notes, /needs the page to be served over https/);
  assert.ok(notes.includes('add its full address (' + SCRIPT_URL + ') to trustedScripts'), notes);
  assert.match(p.text('maintainer-summary'), /\(2\)$/);
  // the full address works without crypto.subtle
  p = await open({ trustedScripts: [SCRIPT_URL] });
  assert.equal(p.$('override-note').hidden, true);
  await p.type('zebra tales');
  assert.ok(p.$('results').querySelector('a.row-link'));
});

test('multi-line summary counts a full match hidden by the filter, and totals the hidden listings (BR2-2)', async () => {
  const p = await loaded();
  p.change(p.codeInput('RS'), false);
  await p.type('creepy riddles\nxyzzy plugh\nriddles');
  assert.equal(p.text('summary'),
    '3 lines: 1 with matches, 1 with matches hidden by the Banned By filter, 1 without · 2 listings hidden by the Banned By filter');
  await p.lineTab('all');
  const line1 = p.$('results').querySelectorAll('section.line')[0].textContent;
  assert.match(line1, /1 possible match/);
  assert.match(line1, /1 more listing hidden by the Banned By filter/);
  p.change(p.codeInput('RS'), true);
  assert.equal(p.text('summary'), '3 lines: 2 with matches, 1 without');
});

test('focus on a "Show all N" button survives a refresh that changes N (BR2-3)', async () => {
  const dragons = Array.from({ length: 60 }, (_, i) => 'Dragon Tale ' + (i + 1) + ',Dee Writer,,Ministry,Book,2020,');
  const p = await loaded({ csv: sheetCsv(dragons) });
  await p.type('dragon tale');
  p.$('results').querySelectorAll('button').find(b => b.textContent === 'Show all 60 listings').focus();
  p.setCsv(sheetCsv(dragons.concat(['Dragon Tale 61,Dee Writer,,Ministry,Book,2020,'])));
  await p.advance(6 * MINUTE);
  assert.equal(p.focused().tagName, 'BUTTON');
  assert.equal(p.focused().textContent, 'Show all 61 listings');
  assert.ok(p.focused().isConnected);
});

test('a partial-load warning quoting a script message ends with one full stop (BR2-4)', async () => {
  const body = scriptBody(SID, { errors: [{ tab: 'Other Materials', message: 'Tab not found.' }] });
  const href = 'https://school.example/censorsearch/?script=' + encodeURIComponent(OTHER_SCRIPT);
  const p = await loaded({ href, fetch: stubFetch(() => jsonResponse(body)) });
  assert.equal(p.text('status-warning'), "Loaded Sheet1; couldn't load Other Materials: The script says: “Tab not found.”");
  const q = await loaded({ config: { tabs: [{ gid: '0', name: 'Sheet1' }, { gid: '123', name: 'Other Materials' }] },
    fetch: stubFetch(url => (/gid=123/.test(url) ? new Response('oops', { status: 500 }) : sheetCsv())) });
  assert.equal(q.text('status-warning'), "Loaded Sheet1; couldn't load Other Materials: Google answered with an error (HTTP 500): try again in a moment.");
});

// ------------------------------------------------------------------------------------------------
// Signed in (config.googleClientId): each visitor reads the sheet with their own Google account

const SIGNED_IN = { googleClientId: G.CLIENT_ID };
const API_ROWS = HEAD.concat(BASE_ROWS).map(line => line.split(','));

// Answers aliases.json and the Sheets API (G.sheetsApi); anything else fails, so no other read can sneak in.
function apiFetch(opts = {}) {
  const api = G.sheetsApi(SID, [{ title: 'Sheet1', gid: '0', rows: opts.rows || API_ROWS }], opts);
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (/aliases\.json/.test(url)) return aliasesResponse();
    const r = api(url, init);
    if (r) return r;
    throw new TypeError('unexpected fetch ' + url);
  };
  fetch.calls = calls;
  return { fetch, api };
}

async function signedIn(opts = {}) {
  const gis = opts.gis || G.fakeGis();
  const { fetch, api } = apiFetch(opts);
  const p = makePage({ config: Object.assign({}, SIGNED_IN, opts.config), google: gis, fetch });
  p.start();
  await p.flush();
  Object.assign(p, { gis, api, fetchCalls: fetch.calls, button: () => p.$('status-actions').querySelector('button') });
  return p;
}

test('signed in: nothing is read until the visitor signs in, then the list is read with their own token (SIGNIN-1)', async () => {
  const p = await signedIn();
  assert.equal(p.text('status'), 'Sign in with Google to search the list. Only people who can view the sheet can search it.');
  assert.equal(p.$('status').getAttribute('data-phase'), 'signin');
  assert.equal(p.button().textContent, 'Sign in with Google');
  assert.equal(p.api.calls.length, 0, 'nothing read before signing in');
  assert.equal(p.text('source'), 'Reading Sheet1 of this Google Sheet with your Google sign-in.');
  await p.type('zebra');
  assert.match(p.text('results'), /Sign in to search: your search will run as soon as the list arrives\./);

  p.click(p.button());
  await p.flush();
  assert.deepEqual(p.gis.requests, [{ clientId: G.CLIENT_ID, scope: G.SCOPE, prompt: '' }]);
  assert.equal(p.api.calls.length, 2);
  assert.ok(p.api.calls.every(c => c.init.headers.Authorization === 'Bearer ' + G.TOKEN && !c.url.includes(G.TOKEN)));
  assert.ok(p.fetchCalls.every(c => !/docs\.google\.com|script\.google\.com/.test(c.url)), 'never read by link or script');
  assert.match(p.text('status'), /^6 items · updated as of 1 January 2026 \(from the sheet\) · fetched \d\d:\d\d$/);
  assert.equal(p.text('summary'), '1 listing found', 'the search typed before signing in runs');
  assert.equal(p.cards()[0].querySelector('a.row-link').href, 'https://docs.google.com/spreadsheets/d/' + SID + '/edit?gid=0#gid=0&range=A6:G6');
  assert.equal(p.$('status-actions').hidden, true);
  assert.ok(!p.text('results').includes(G.TOKEN) && !p.text('status').includes(G.TOKEN));
});

test("signed in: an account that can't view the sheet is told so, and can sign in with another one (SIGNIN-2)", async () => {
  let allowed = false;
  const p = await signedIn({ canView: () => allowed });
  p.click(p.button());
  await p.flush();
  assert.equal(p.$('status').getAttribute('data-phase'), 'failed');
  assert.equal(p.text('status'), "Can't load the list. The Google account you signed in with can't view this sheet. Sign in with an account that can view it, or ask the sheet's owner for access.");
  const b = p.button();
  assert.equal(b.textContent, 'Sign in with another account');
  assert.deepEqual(p.$('status-actions').querySelectorAll('a').map(a => a.textContent), ['Open the sheet']);
  allowed = true;
  p.click(b);
  await p.flush();
  assert.deepEqual(p.gis.requests.map(r => r.prompt), ['', 'select_account']);
  assert.match(p.text('status'), /^6 items/);
});

test('signed in: a sign-in that runs out keeps the list on screen and asks to sign in again (SIGNIN-3)', async () => {
  const p = await signedIn();
  p.click(p.button());
  await p.flush();
  const reads = () => p.api.calls.length / 2;
  assert.equal(reads(), 1);
  await p.advance(30 * MINUTE);
  assert.ok(reads() >= 6, 'refreshed every 5 minutes while signed in');
  // The sign-in lasts an hour: the first refresh due after it runs out finds it gone.
  await p.advance(40 * MINUTE);
  const before = reads();
  assert.equal(p.text('status-warning'), "Your Google sign-in has run out, so the list isn't being refreshed; showing data fetched at " + p.text('status').match(/fetched (\d\d:\d\d)$/)[1] + '.');
  assert.equal(p.button().textContent, 'Sign in again');
  await p.advance(10 * MINUTE);
  assert.equal(reads(), before, 'no reads without a sign-in');
  await p.type('orchard');
  assert.equal(p.text('summary'), '1 listing found', 'the list on screen still searches');
  // A row link opens the row as loaded: checking it again would need a sign-in.
  const ev = p.click(p.cards()[0].querySelector('a.row-link'));
  assert.equal(ev.defaultPrevented, undefined);
  assert.equal(p.opened.length, 0);

  p.click(p.button());
  await p.flush();
  assert.equal(reads(), before + 1);
  assert.equal(p.text('status-warning'), '');
  assert.equal(p.$('status-actions').hidden, true);
});

test("signed in: Google's script blocked, a closed sign-in window, and a bad client ID (SIGNIN-4)", async () => {
  const { fetch } = apiFetch();
  const p = makePage({ config: SIGNED_IN, fetch });
  p.start();
  await p.flush();
  assert.equal(p.text('status'), 'Loading Google sign-in…');
  assert.equal(p.$('status-actions').hidden, true);
  await p.advance(20000);
  assert.equal(p.text('status'), "Google sign-in didn't load: a network filter or browser extension may block accounts.google.com.");
  assert.equal(p.$('status-actions').querySelector('button').textContent, 'Try again');
  p.win.google = G.fakeGis([{ popup: 'popup_closed' }, { access_token: G.TOKEN, expires_in: 3599, scope: G.SCOPE }]);
  p.click(p.$('status-actions').querySelector('button'));
  await p.flush();
  assert.equal(p.$('status-actions').querySelector('button').textContent, 'Sign in with Google');
  p.click(p.$('status-actions').querySelector('button'));
  await p.flush();
  assert.equal(p.text('status'), 'The sign-in window closed before signing in finished.');
  assert.equal(p.$('status-actions').querySelector('button').textContent, 'Sign in again');
  p.click(p.$('status-actions').querySelector('button'));
  await p.flush();
  assert.match(p.text('status'), /^6 items/);

  const q = makePage({ config: { googleClientId: G.FAKE_SECRET }, fetch, google: G.fakeGis() });
  q.start();
  await q.flush();
  assert.equal(q.$('status').getAttribute('data-phase'), 'config');
  assert.match(q.text('status'), /^The googleClientId in config\.js is not a Google sign-in client ID/);
});

test('signed in: ?sheet= links still read by link, without signing in (SIGNIN-5)', async () => {
  const gis = G.fakeGis();
  const p = makePage({ href: sheetHref(SID2, '/edit#gid=0'), config: SIGNED_IN, google: gis, fetch: stubFetch(() => sheetCsv()) });
  p.start();
  await p.flush();
  assert.match(p.text('status'), /^6 items/);
  assert.equal(gis.requests.length, 0);
});

test('index.html allows Google sign-in and the Sheets API in its CSP; the token is never stored or logged (SIGNIN-10)', () => {
  const html = read('index.html');
  assert.ok(html.includes('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    "script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' https://accounts.google.com/gsi/style; img-src 'self' data:; " +
    "connect-src 'self' https://docs.google.com https://*.googleusercontent.com https://script.google.com https://sheets.googleapis.com " +
    "https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; base-uri 'none'; form-action 'none'\">"), 'CSP');
  // Google's sign-in checks where its window was opened from; only the site's address is sent, never a page's path.
  assert.match(html, /<meta name="referrer" content="strict-origin">/);
  assert.deepEqual([...html.matchAll(/<script ([^>]*)><\/script>/g)].map(m => m[1]),
    ['defer src="config.js"', 'defer src="src/sheet.js"', 'defer src="src/signin.js"', 'defer src="src/engine.js"', 'defer src="src/app.js"']);
  const signin = read('src/signin.js');
  for (const src of [signin, read('src/app.js'), read('src/sheet.js')]) {
    for (const bad of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'innerHTML']) assert.ok(!src.includes(bad), bad);
  }
  assert.ok(!/console\./.test(signin), 'signin.js logs nothing');
});
