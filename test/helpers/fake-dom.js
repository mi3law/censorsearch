// A small fake browser for page tests: it parses one of this site's HTML files into a fake DOM, runs the page's
// <script src> files in a vm context with fake timers and a stubbed fetch, and loads scripts the page adds later.
// It supports only what the pages use, and its HTML parser is strict on purpose: a closing tag that doesn't match, or
// a block element inside <p> (which a browser would silently restructure), is an error, so the markup stays valid.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
const BOOLEAN_ATTRS = ['hidden', 'disabled', 'open', 'required', 'readonly', 'multiple'];
const FOCUSABLE = ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY'];
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: String.fromCharCode(160) };

const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  if (!(e.toLowerCase() in ENTITIES)) throw new Error('unknown entity ' + m);
  return ENTITIES[e.toLowerCase()];
});

// crypto.subtle.digest on Node's thread pool can settle after a flush; this computes the same digest synchronously.
const syncCrypto = {
  subtle: {
    digest: async (alg, data) => {
      const h = nodeCrypto.createHash(String(alg).replace('-', '').toLowerCase()).update(Buffer.from(data)).digest();
      return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength);
    },
  },
};

function makeBrowser(opts = {}) {
  // ---------------------------------------------------------------------------------------------
  // Clock and timers
  const RealDate = Date;
  const clock = { offset: 0 };
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + clock.offset); }
    static now() { return RealDate.now() + clock.offset; }
  }
  const now = () => FakeDate.now();
  let tid = 1;
  const timers = new Map();
  const setTimeout_ = (fn, ms) => { const id = tid++; timers.set(id, { fn, due: now() + (ms || 0), every: 0 }); return id; };
  const setInterval_ = (fn, ms) => { const id = tid++; timers.set(id, { fn, due: now() + ms, every: ms }); return id; };
  const clear = id => { timers.delete(id); };
  const flush = async () => { for (let i = 0; i < 60; i++) await new Promise(r => setImmediate(r)); };
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

  // ---------------------------------------------------------------------------------------------
  // DOM
  let doc, ctx;
  const scriptLoads = [];

  class Node_ {
    constructor() { this.parentNode = null; this.childNodes = []; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc; }
  }
  class Text_ extends Node_ {
    constructor(t) { super(); this.data = String(t); this.nodeType = 3; }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
  }

  class ClassList {
    constructor(el) { this.el = el; }
    _list() { return this.el.className.split(/\s+/).filter(Boolean); }
    contains(c) { return this._list().includes(c); }
    add(...cs) { const l = this._list(); for (const c of cs) if (!l.includes(c)) l.push(c); this.el.className = l.join(' '); }
    remove(...cs) { this.el.className = this._list().filter(c => !cs.includes(c)).join(' '); }
    toggle(c, force) { const on = force == null ? !this.contains(c) : !!force; if (on) this.add(c); else this.remove(c); return on; }
  }

  class Element_ extends Node_ {
    constructor(tag) {
      super();
      this.nodeType = 1;
      this.tagName = String(tag).toUpperCase();
      this.localName = String(tag).toLowerCase();
      this.attrs = new Map();
      this.listeners = {};
      this.classList = new ClassList(this);
      this._value = null;
      this._checked = null;
      this.style = {};
    }
    get id() { return this.getAttribute('id') || ''; } set id(v) { this.setAttribute('id', v); }
    get className() { return this.getAttribute('class') || ''; } set className(v) { this.setAttribute('class', v); }
    get href() { return this.getAttribute('href') || ''; } set href(v) { this.setAttribute('href', v); }
    get src() { return this.getAttribute('src') || ''; } set src(v) { this.setAttribute('src', v); }
    get type() { return this.getAttribute('type') || (this.tagName === 'BUTTON' ? 'submit' : this.tagName === 'INPUT' ? 'text' : ''); }
    set type(v) { this.setAttribute('type', v); }
    get name() { return this.getAttribute('name') || ''; } set name(v) { this.setAttribute('name', v); }
    get rel() { return this.getAttribute('rel') || ''; } set rel(v) { this.setAttribute('rel', v); }
    get target() { return this.getAttribute('target') || ''; } set target(v) { this.setAttribute('target', v); }
    get htmlFor() { return this.getAttribute('for') || ''; }
    get value() {
      if (this._value != null) return this._value;
      if (this.tagName === 'TEXTAREA') return this.textContent;
      return this.getAttribute('value') || (this.tagName === 'INPUT' && /^(radio|checkbox)$/.test(this.type) ? 'on' : '');
    }
    set value(v) { this._value = this.tagName === 'INPUT' ? String(v).replace(/[\r\n]/g, '') : String(v); }
    get checked() { return this._checked != null ? this._checked : this.hasAttribute('checked'); }
    set checked(v) {
      this._checked = !!v;
      if (v && this.type === 'radio' && this.name) {
        const group = (this.closest('form') || doc.documentElement).querySelectorAll('input');
        for (const o of group) if (o !== this && o.type === 'radio' && o.name === this.name) o._checked = false;
      }
    }
    get form() { return this.closest('form'); }
    setAttribute(k, v) { this.attrs.set(String(k).toLowerCase(), String(v)); }
    getAttribute(k) { const key = String(k).toLowerCase(); return this.attrs.has(key) ? this.attrs.get(key) : null; }
    removeAttribute(k) { this.attrs.delete(String(k).toLowerCase()); }
    hasAttribute(k) { return this.attrs.has(String(k).toLowerCase()); }
    _adopt(c) {
      if (!(c instanceof Node_)) c = new Text_(c);
      if (c.parentNode) c.parentNode.removeChild(c, true);
      c.parentNode = this;
      return c;
    }
    _connected(c) { if (c instanceof Element_ && c.isConnected) for (const s of [c, ...c.querySelectorAll('script')]) if (s.tagName === 'SCRIPT') loadScript(s); }
    append(...cs) { for (const c of cs) { const n = this._adopt(c); this.childNodes.push(n); this._connected(n); } }
    prepend(...cs) { const ns = cs.map(c => this._adopt(c)); this.childNodes.unshift(...ns); ns.forEach(n => this._connected(n)); }
    appendChild(c) { this.append(c); return c; }
    insertBefore(c, ref) {
      if (!ref) return this.appendChild(c);
      const n = this._adopt(c);
      this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
      this._connected(n);
      return n;
    }
    removeChild(c, moving) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      c.parentNode = null;
      if (!moving) blurDetached();
      return c;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    replaceChildren(...cs) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...cs); blurDetached(); }
    get children() { return this.childNodes.filter(c => c instanceof Element_); }
    get firstChild() { return this.childNodes[0] || null; }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { this.replaceChildren(); if (String(v)) this.append(String(v)); }
    get innerHTML() { throw new Error('innerHTML is not allowed on these pages'); }
    set innerHTML(v) { throw new Error('innerHTML is not allowed on these pages'); }
    get isRendered() {
      for (let n = this; n instanceof Element_; n = n.parentNode) {
        if (n.hidden) return false;
        const p = n.parentNode;
        if (p instanceof Element_ && p.tagName === 'DETAILS' && !p.open && n.tagName !== 'SUMMARY') return false;
      }
      return true;
    }
    focus() {
      if (!this.isConnected || !this.isRendered) return;
      const ok = FOCUSABLE.includes(this.tagName) || (this.tagName === 'A' && this.hasAttribute('href')) || this.hasAttribute('tabindex');
      if (ok && !this.disabled) doc.activeElement = this;
    }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { const l = this.listeners[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    dispatchEvent(ev) {
      if (!ev.preventDefault) ev.preventDefault = function () { this.defaultPrevented = true; };
      if (!ev.target) ev.target = this;
      for (let n = this; n; n = ev.bubbles === false ? null : n.parentNode) {
        ev.currentTarget = n;
        for (const fn of ((n.listeners && n.listeners[ev.type]) || []).slice()) fn.call(n, ev);
      }
      return !ev.defaultPrevented;
    }
    click() {
      if (this.disabled) return;
      if (this.tagName === 'INPUT' && (this.type === 'radio' || this.type === 'checkbox')) {
        this.checked = this.type === 'radio' ? true : !this.checked;
        this.dispatchEvent({ type: 'click', bubbles: true });
        this.dispatchEvent({ type: 'input', bubbles: true });
        this.dispatchEvent({ type: 'change', bubbles: true });
        return;
      }
      const ok = this.dispatchEvent({ type: 'click', bubbles: true, button: 0 });
      if (ok && this.tagName === 'BUTTON' && this.type === 'submit' && this.form) this.form.dispatchEvent({ type: 'submit', bubbles: true });
      if (ok && this.tagName === 'SUMMARY' && this.parentNode && this.parentNode.tagName === 'DETAILS') this.parentNode.open = !this.parentNode.open;
    }
    matches(sel) { return sel.split(',').some(s => matchComplex(this, s.trim())); }
    closest(sel) { for (let n = this; n instanceof Element_; n = n.parentNode) if (n.matches(sel)) return n; return null; }
    querySelectorAll(sel) {
      const out = [];
      const walk = n => { for (const c of n.childNodes) if (c instanceof Element_) { if (c.matches(sel)) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  for (const a of BOOLEAN_ATTRS) {
    Object.defineProperty(Element_.prototype, a, {
      get() { return this.hasAttribute(a); },
      set(v) { if (v) this.setAttribute(a, ''); else this.removeAttribute(a); },
    });
  }

  // Selectors: tag, #id, .class, [attr], [attr="value"], combined, with descendant combinators and comma lists.
  function matchCompound(el, s) {
    const re = /^([a-z][a-z0-9-]*|\*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i;
    const m = s.match(re);
    if (!m) throw new Error('unsupported selector ' + s);
    if (m[1] && m[1] !== '*' && el.localName !== m[1].toLowerCase()) return false;
    const parts = m[2].match(/#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) || [];
    return parts.every(p => {
      if (p[0] === '#') return el.id === p.slice(1);
      if (p[0] === '.') return el.classList.contains(p.slice(1));
      const a = p.slice(1, -1).match(/^([\w-]+)(?:="([^"]*)")?$/);
      return a[2] == null ? el.hasAttribute(a[1]) : el.getAttribute(a[1]) === a[2];
    });
  }
  function matchComplex(el, s) {
    const parts = s.split(/\s+/).filter(Boolean);
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    let n = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (n instanceof Element_ && !matchCompound(n, parts[i])) n = n.parentNode;
      if (!(n instanceof Element_)) return false;
      n = n.parentNode;
    }
    return true;
  }
  function blurDetached() { if (doc && doc.activeElement && !doc.activeElement.isConnected) doc.activeElement = doc.body; }

  // ---------------------------------------------------------------------------------------------
  // HTML parser (well-formed markup only)
  function parse(html) {
    const top = new Element_('#document-fragment');
    const stack = [top];
    const TOKEN = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|[^<]+/gi;
    let m, last = 0;
    while ((m = TOKEN.exec(html))) {
      if (m.index !== last) throw new Error('unparsed markup at ' + last + ': ' + html.slice(last, last + 40));
      last = TOKEN.lastIndex;
      const parent = stack[stack.length - 1];
      if (m[0].startsWith('<!')) continue;
      if (m[1]) {
        const tag = m[1].toLowerCase();
        if (parent.localName !== tag) throw new Error('</' + tag + '> closes <' + parent.localName + '> at ' + m.index);
        stack.pop();
        continue;
      }
      if (m[2]) {
        const tag = m[2].toLowerCase();
        if (BLOCK.has(tag) && stack.some(e => e.localName === 'p')) throw new Error('<' + tag + '> inside <p> at ' + m.index);
        const e = new Element_(tag);
        const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        let a;
        while ((a = ATTR.exec(m[3] || ''))) {
          const v = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : '';
          if (e.hasAttribute(a[1])) throw new Error('duplicate attribute ' + a[1] + ' on <' + tag + '>');
          e.setAttribute(a[1], decode(v));
        }
        parent.childNodes.push(e);
        e.parentNode = parent;
        if (VOID.has(tag)) continue;
        if (RAW.has(tag)) {
          const close = html.toLowerCase().indexOf('</' + tag, TOKEN.lastIndex);
          if (close < 0) throw new Error('unclosed <' + tag + '>');
          const raw = html.slice(TOKEN.lastIndex, close);
          if (raw) { const t = new Text_(tag === 'textarea' || tag === 'title' ? decode(raw) : raw); t.parentNode = e; e.childNodes.push(t); }
          const end = html.indexOf('>', close);
          TOKEN.lastIndex = end + 1;
          last = TOKEN.lastIndex;
          continue;
        }
        stack.push(e);
        continue;
      }
      const t = new Text_(decode(m[0]));
      t.parentNode = parent;
      parent.childNodes.push(t);
    }
    if (last !== html.length) throw new Error('unparsed markup at the end');
    if (stack.length !== 1) throw new Error('unclosed <' + stack[stack.length - 1].localName + '>');
    return top.children;
  }

  // ---------------------------------------------------------------------------------------------
  // Document, window and scripts
  const href = opts.href || 'https://school.example/censorsearch/settings.html';
  const u = new URL(href);
  doc = {
    nodeType: 9, listeners: {}, visibilityState: 'visible', baseURI: href, childNodes: [],
    createElement: t => new Element_(t),
    createTextNode: t => new Text_(t),
    getElementById(id) { return doc.documentElement.querySelectorAll('#' + id)[0] || null; },
    querySelector(s) { return doc.documentElement.querySelector(s); },
    querySelectorAll(s) { return doc.documentElement.querySelectorAll(s); },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
  };
  const html = parse(opts.html != null ? opts.html : fs.readFileSync(path.join(ROOT, opts.page || 'index.html'), 'utf8'));
  doc.documentElement = html.find(e => e.localName === 'html');
  if (!doc.documentElement) throw new Error('no <html> element');
  doc.documentElement.parentNode = doc;
  doc.childNodes = [doc.documentElement];
  doc.head = doc.documentElement.querySelector('head');
  doc.body = doc.documentElement.querySelector('body');
  doc.activeElement = doc.body;

  const logs = [];
  const fetchCalls = [];
  const win = {
    document: doc,
    location: { href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, protocol: u.protocol, host: u.host },
    console: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a), info: (...a) => logs.push(a), debug: (...a) => logs.push(a) },
    URL, URLSearchParams, Response, Headers, AbortController, DOMException, TextEncoder, TextDecoder, atob, btoa,
    crypto: opts.crypto === null ? undefined : syncCrypto,
    Date: FakeDate, setTimeout: setTimeout_, clearTimeout: clear, setInterval: setInterval_, clearInterval: clear,
    Node: Node_, Element: Element_,
    listeners: {},
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
  };
  win.window = win;
  win.self = win;
  win.top = opts.framed ? { notTheSameWindow: true } : win;
  win.globalThis = win;
  win.fetch = async (url, init) => {
    const call = { url: String(url), init: init || {} };
    fetchCalls.push(call);
    if (!opts.fetch) throw new TypeError('Failed to fetch');
    return opts.fetch(call.url, call.init, call);
  };
  ctx = vm.createContext(win);

  // opts.scripts: { src: text } or a function of src; null means the script fails to load, undefined reads the file.
  const sourceOf = src => {
    const clean = String(src).split('?')[0];
    if (typeof opts.scripts === 'function') { const t = opts.scripts(src); if (t !== undefined) return t; }
    if (opts.scripts && Object.prototype.hasOwnProperty.call(opts.scripts, src)) return opts.scripts[src];
    if (opts.scripts && Object.prototype.hasOwnProperty.call(opts.scripts, clean)) return opts.scripts[clean];
    return fs.readFileSync(path.join(ROOT, clean), 'utf8');
  };
  // A script added by the page loads after the current task, then fires load (or error when its source is null).
  function loadScript(s) {
    if (s._started || !s.hasAttribute('src') || !started) return;
    s._started = true;
    const src = s.getAttribute('src');
    scriptLoads.push(src);
    setImmediate(() => {
      let text;
      try { text = sourceOf(src); } catch (e) { text = null; }
      if (text == null) { s.dispatchEvent({ type: 'error', bubbles: false }); return; }
      vm.runInContext(text, ctx, { filename: src });
      s.dispatchEvent({ type: 'load', bubbles: false });
    });
  }
  let started = false;

  const byId = id => doc.getElementById(id);
  const browser = {
    win, doc, clock, logs, fetchCalls, scriptLoads, advance, flush, $: byId,
    // Runs the page's own <script src> elements in order, as deferred scripts do once the page is parsed.
    start() {
      for (const s of doc.documentElement.querySelectorAll('script')) {
        if (!s.hasAttribute('src')) throw new Error('inline script in the page');
        s._started = true;
        const text = sourceOf(s.getAttribute('src'));
        if (text != null) vm.runInContext(text, ctx, { filename: s.getAttribute('src') });
      }
      started = true;
    },
    text: id => byId(id).textContent,
    // Typing: sets the value and fires input, then change (as leaving the field does).
    type(el, value, { change = true } = {}) {
      el.value = value;
      el.dispatchEvent({ type: 'input', bubbles: true });
      if (change) el.dispatchEvent({ type: 'change', bubbles: true });
    },
    click(el) { el.click(); },
    key(el, key) { const ev = { type: 'keydown', key, bubbles: true }; el.dispatchEvent(ev); return ev; },
    submit(form) { const ev = { type: 'submit', bubbles: true }; form.dispatchEvent(ev); return ev; },
    focused: () => doc.activeElement,
    // Every text and attribute value in the page, for checks that something never appears in it.
    everything() {
      const out = [];
      const walk = n => {
        for (const c of n.childNodes) {
          if (c instanceof Text_) out.push(c.data);
          else { for (const [k, v] of c.attrs) out.push(k + '=' + v); walk(c); }
        }
      };
      walk(doc.documentElement);
      return out.join('\n');
    },
  };
  return browser;
}

module.exports = { makeBrowser, ROOT };
