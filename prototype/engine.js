// Prototype search engine: the PRD's matching design plus the rule changes (F1-F17) found by the stress test.
// Every change is tagged "FIX Fn" in the code; README.md lists them.
'use strict';

// ---------- 1. character-level fold (identical for cells and queries) ----------
const SPECIAL = { 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'ł': 'l', 'þ': 'th', 'ı': 'i' };
function fold(input) {
  let s = typeof input === 'number' ? String(input) : String(input ?? '');
  s = s.replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660))           // FIX F1: Arabic-Indic digits
       .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x6F0));          //         Persian digits
  s = s.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/\p{Cf}+/gu, '');         // FIX F1: soft hyphen, ZW*, BOM, LRM/RLM
  s = s.toLowerCase().replace(/[ßæœøđðłþı]/g, c => SPECIAL[c]);
  s = s.replace(/[‘’‚‛′ʼ`´]/g, "'")
       .replace(/[“”„‟″«»]/g, '"')
       .replace(/[‐-―−﹘﹣－]/g, '-')
       .replace(/\s*&\s*|\s\+\s/g, ' and ')
       .replace(/(^|\s)'?n'(?=\s|$)/g, '$1and')
       .replace(/[\s ]+/g, ' ').trim();
  return s;
}

// ---------- 2. inverted-article repair (title field) ----------
const ART = '(the|a|an)';
function uninvertArticle(f) {
  const m = f.match(new RegExp(`^(.+?),\\s*${ART}\\s*(?=$|[:;(\\[.\\-])(.*)$`));
  return m ? `${m[2]} ${m[1]}${m[3]}` : f;
}

// ---------- 3. tokeniser producing slots of alternative forms ----------
const UNITS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90, hundredth: 100 };
const CONTEXT = { volume: 'volume', vol: 'volume', vols: 'volume', book: 'book', bk: 'book', part: 'part', pt: 'part', chapter: 'chapter', ch: 'chapter', chap: 'chapter', unit: 'unit', grade: 'grade', gr: 'grade', level: 'level', lvl: 'level', season: 'season', series: 'series', episode: 'episode', ep: 'episode', act: 'act', no: 'number', num: 'number', number: 'number', edition: 'edition', ed: 'edition', edn: 'edition', class: 'class', standard: 'standard', std: 'standard', issue: 'issue', year: 'year', stage: 'stage', module: 'module', lesson: 'lesson' };
const PAIR_GROUP = { grade: 'grade', class: 'grade', standard: 'grade' };                 // FIX F7: school-level synonyms
const ROMAN = /^(x{0,3})(ix|iv|v?i{0,3})$/;
function roman(t) { if (!t || !ROMAN.test(t)) return null; const v = { i: 1, v: 5, x: 10 }; let n = 0; for (let i = 0; i < t.length; i++) { const a = v[t[i]], b = v[t[i + 1]] || 0; n += a < b ? -a : a; } return n || null; }

function under100(w, i) {
  const a = w[i], b = w[i + 1];
  if (a in TENS) {
    if (b in UNITS && UNITS[b] > 0 && UNITS[b] < 10) return { v: TENS[a] + UNITS[b], n: 2 };
    if (b in ORD && ORD[b] < 10) return { v: TENS[a] + ORD[b], n: 2, ord: true };
    return { v: TENS[a], n: 1 };
  }
  if (a in UNITS && a !== 'oh') return { v: UNITS[a], n: 1 };
  return null;
}
function tail(w, i, base, n, mult) {
  let k = i + n; if (w[k] === 'and') k++;
  const y = mult === 1000 ? under1000(w, k) : under100(w, k);
  return y ? { v: base + y.v, n: k + y.n - i, ord: y.ord } : { v: base, n };
}
function under1000(w, i) {
  const x = under100(w, i) || (w[i] === 'hundred' ? { v: 1, n: 0 } : null);
  if (!x || x.ord) return x;
  if (w[i + x.n] === 'hundred') return tail(w, i, x.v * 100, x.n + 1, 100);
  return x;
}
function readNumber(w, i) {
  const x = under1000(w, i) || (w[i] === 'thousand' ? { v: 1, n: 0 } : null);
  if (!x || x.ord) return x;
  if (w[i + x.n] === 'thousand') return tail(w, i, x.v * 1000, x.n + 1, 1000);
  if (x.v >= 10 && x.v < 100) { const y = under100(w, i + x.n); if (y && y.v >= 10) return { v: x.v * 100 + y.v, n: x.n + y.n }; }
  return x;
}

const OPTIONAL = new Set(['the', 'a', 'an', 'and', 'by', 'of', 'for', 'to', 'in', 'on', 'at', 'with', 'et', 'al']);
// FIX F4: format / edition words never block a match (they only add score)
const SOFT = new Set(['book', 'books', 'disc', 'discs', 'dvd', 'dvds', 'cd', 'cds', 'video', 'edition', 'ed', 'paperback', 'hardcover', 'hardback', 'kindle', 'ebook', 'audiobook', 'audio', 'novel', 'unabridged', 'abridged', 'illustrated', 'anniversary', 'deluxe', 'reprint']);
const isLetter1 = s => s.orig.length === 1 && /\p{L}/u.test(s.orig);
const numOf = s => { for (const f of s.forms) if (/^\d+$/.test(f)) return String(+f); return null; };

function tokenize(folded) {
  let slots = [];
  const add = (orig, forms, extra) => slots.push({ orig, forms: new Set(forms.filter(Boolean)), opt: OPTIONAL.has(orig), ...extra });
  for (const chunk of folded.split(' ')) {
    const c = chunk.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!c) continue;
    if (/'/.test(c)) {
      const joined = c.replace(/'/g, '');
      const forms = [joined];
      if (/'s$/.test(c)) forms.push(c.slice(0, -2).replace(/'/g, ''));
      c.split("'").filter(p => p.length > 1).forEach(p => forms.push(p));
      add(joined, forms); continue;
    }
    const parts = c.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (parts.length > 1) {
      const joined = parts.join('');
      const allInitials = parts.every(p => p.length === 1 && /\p{L}/u.test(p));
      if (allInitials) { add(joined, [joined, ...parts], { initials: true }); continue; }   // FIX F8: r.l. -> {rl, r, l}, marked initials
      parts.forEach((p, i) => add(p, [p, i === 0 ? joined : null]));
      continue;
    }
    add(c, [c]);
  }
  // FIX F8: a run of 2+ single letters ("r l", "r. l.") becomes ONE initials slot instead of 2 required slots
  const merged = [];
  for (let i = 0; i < slots.length; i++) {
    if (isLetter1(slots[i]) && !slots[i].opt && i + 1 < slots.length && isLetter1(slots[i + 1]) && !slots[i + 1].opt) {
      let j = i; const letters = []; while (j < slots.length && isLetter1(slots[j]) && !slots[j].opt) letters.push(slots[j++].orig);
      merged.push({ orig: letters.join(''), forms: new Set([letters.join(''), ...letters]), opt: false, initials: true }); i = j - 1;
    } else merged.push(slots[i]);
  }
  slots = merged;
  for (const s of slots) {
    const t = s.orig; let m;
    if ((m = t.match(/^(\d+)(st|nd|rd|th)$/))) { s.forms.add(`${+m[1]}th`); s.forms.add(String(+m[1])); s.ordinal = true; }
    else if (/^\d+$/.test(t)) s.forms.add(String(+t));
    else if (/\d/.test(t) && /\p{L}/u.test(t)) t.split(/(?<=\d)(?=\p{L})|(?<=\p{L})(?=\d)/u).forEach(p => s.forms.add(p));
    if (ORD[t]) { s.forms.add(`${ORD[t]}th`); s.forms.add(String(ORD[t])); s.ordinal = true; }
    if (CONTEXT[t]) s.forms.add(CONTEXT[t]);
  }
  const w = slots.map(s => s.orig);
  for (let i = 0; i < w.length; i++) {
    // FIX F11: spoken digit groups: "four fifty one" -> 451, "two eleven" -> 211, "three sixty" -> 360
    const u = under100(w, i);
    if (u && u.n === 1 && u.v >= 1 && u.v <= 9 && !(w[i + 1] === 'hundred' || w[i + 1] === 'thousand')) {
      const y = under100(w, i + 1);
      if (y && y.v >= 10 && !y.ord) { slots[i].forms.add(String(u.v * 100 + y.v)); for (let k = i + 1; k < i + 1 + y.n; k++) slots[k].absorbedBy = i; }
    }
    const x = readNumber(w, i);
    if (!x || x.n < 1) continue;
    slots[i].forms.add(String(x.v)); if (x.ord) slots[i].forms.add(`${x.v}th`);
    for (let k = i + 1; k < i + x.n; k++) slots[k].absorbedBy = i;
    i += x.n - 1;
  }
  slots.forEach((s, i) => {
    const r = roman(s.orig); if (!r) return;
    const ctx = i > 0 && CONTEXT[slots[i - 1].orig];
    if (ctx || s.orig.length >= 2) s.forms.add(String(r));
  });
  // FIX F7: label+number pairs ("unit 8", "class - 8", "volume one", "5th grade") get one joined term, e.g. unit8 / grade8
  slots.pairs = [];
  for (let i = 0; i < slots.length - 1; i++) {
    const a = slots[i], b = slots[i + 1];
    if (CONTEXT[a.orig] && numOf(b) && !CONTEXT[b.orig]) { const c = CONTEXT[a.orig]; slots.pairs.push({ i, j: i + 1, term: (PAIR_GROUP[c] || c) + numOf(b) }); }
    else if (a.ordinal && numOf(a) && CONTEXT[b.orig]) { const c = CONTEXT[b.orig]; slots.pairs.push({ i, j: i + 1, term: (PAIR_GROUP[c] || c) + numOf(a) }); }
  }
  return slots;
}

// ---------- ISBN ----------
function isbnForms(v) {
  if (v === '' || v == null) return [];
  let d = typeof v === 'number' ? v.toFixed(0) : String(v).replace(/[^0-9xX]/g, '').toLowerCase();
  if (d.length === 9) d = '0' + d;
  const out = [d];
  if (d.length === 10) { const b = '978' + d.slice(0, 9); let s = 0; for (let i = 0; i < 12; i++) s += +b[i] * (i % 2 ? 3 : 1); out.push(b + ((10 - s % 10) % 10)); }
  if (d.length === 13 && d.startsWith('978')) { const b = d.slice(3, 12); let s = 0; for (let i = 0; i < 9; i++) s += +b[i] * (10 - i); const c = (11 - s % 11) % 11; out.push(b + (c === 10 ? 'x' : c)); }
  return out;
}
// FIX F10: drop "ISBN"/"ISBN-13:" labels and collapse hyphen/space-separated digit groups that add up to 10 or 13 characters
function prepIsbn(raw) {
  const ch = raw.replace(/\bisbn(?:[\s-]*1[03])?\s*[:#]?/gi, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < ch.length; i++) {
    let done = false;
    for (let j = Math.min(ch.length - 1, i + 5); j >= i && !done; j--) {
      const win = ch.slice(i, j + 1);
      if (!win.every(c => /^[\d-]*\d[\d-]*[xX]?$|^[\d-]+[xX]$/.test(c))) continue;
      const d = win.join('').replace(/-/g, '');
      if ((/^\d{9}[\dxX]$/.test(d) || /^\d{13}$/.test(d)) && (j > i || /-/.test(win[0]) || d.length >= 10)) { out.push(d.toLowerCase()); i = j; done = true; }
    }
    if (!done) out.push(ch[i]);
  }
  return out.join(' ');
}

// ---------- edit distance (OSA, bounded) ----------
function osa(a, b, k, prefix) {
  const n = a.length, m = b.length;
  if (!prefix && Math.abs(n - m) > k) return k + 1;
  if (prefix && m < n - k) return k + 1;
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
    [pp, p, c] = [p, c, pp || new Array(m + 1)];
  }
  if (prefix) { let mn = k + 1; for (let j = Math.max(0, n - k); j <= m; j++) mn = Math.min(mn, p[j]); return mn; }
  return p[m];
}
const maxEdits = t => /^\d+$/.test(t) || t in UNITS || t in TENS || t in ORD || t === 'hundred' || t === 'thousand' ? 0 : t.length <= 3 ? 0 : t.length <= 7 ? 1 : 2; // FIX F11b: number words never fuzzy (four != for); FIX F17: 1 edit up to 7 letters, 2 from 8

// ---------- index ----------
const FIELDS = { title: 3, author: 2, memo: 1, meta: 0.5 };
const META_W = 0.5;
function buildIndex(rows) {
  const vocab = new Map(), uni = new Set();
  const docs = rows.map((r, id) => {
    const titleF = uninvertArticle(fold(r.title)).replace(/\+[0-9a-z:]*:[0-9a-z:]*$/, '');           // FIX F14: paste residue "+3:15A13:…"
    const authorF = fold(r.author).replace(/(\s+et\.?\s+al\.?|\s+and\s+others)\s*$/, '');           // FIX F6: "Et Al" is not an author
    const f = { title: titleF, author: authorF, memo: fold(r.memo), meta: fold([r.bannedBy, r.type].join(' ')) }; // FIX F2: Year of Banning not searchable
    const doc = { id, r, slots: {}, titleKey: null, pairLabels: new Set(), labelWords: new Set() };
    for (const [field, w] of Object.entries(FIELDS)) {
      const slots = tokenize(f[field]); doc.slots[field] = slots;
      for (const s of slots) for (const t of s.forms) { post(t, id, w); uni.add(t); }
      for (let i = 0; i < slots.length - 1; i++) post(slots[i].orig + slots[i + 1].orig, id, w * 0.9);
      for (const p of slots.pairs) { post(p.term, id, w); doc.pairLabels.add(p.term.replace(/\d+$/, '')); } // FIX F7
    }
    for (const s of doc.slots.title) if (CONTEXT[s.orig]) doc.labelWords.add(PAIR_GROUP[CONTEXT[s.orig]] || CONTEXT[s.orig]);
    for (const t of isbnForms(r.isbn)) post(t, id, 3);
    doc.titleKey = key(doc.slots.title);
    return doc;
  });
  function post(t, id, w) { let m = vocab.get(t); if (!m) vocab.set(t, m = new Map()); if ((m.get(id) || 0) < w) m.set(id, w); }
  const byLen = [];
  for (const t of uni) (byLen[t.length] ||= []).push(t);
  const sorted = [...vocab.keys()].sort();
  return { docs, vocab, byLen, sorted };
}
function key(slots) {
  const core = slots.filter((s, i) => s.absorbedBy == null && !((i === 0 || i === slots.length - 1) && ['the', 'a', 'an'].includes(s.orig)));
  return core.map(s => [...s.forms].find(f => /^\d+(th)?$/.test(f)) || s.orig).join(' ');
}

// ---------- search ----------
function termsFor(form, isLast, ix) {
  const out = new Map();
  const put = (t, q, kind) => { const o = out.get(t); if (!o || o.q < q) out.set(t, { q, kind }); };
  if (ix.vocab.has(form)) put(form, 1, 'exact');
  const numeric = /^\d+$/.test(form);
  if (form.length >= 2 && (isLast || form.length >= 3) && !(numeric && form.length < 3)) {             // FIX F3: digit prefix only from 3 digits
    let lo = 0, hi = ix.sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; ix.sorted[mid] < form ? lo = mid + 1 : hi = mid; }
    for (let i = lo; i < ix.sorted.length && ix.sorted[i].startsWith(form); i++) put(ix.sorted[i], 0.8, 'prefix');
  }
  const k = maxEdits(form);
  if (k) {
    const maxLen = isLast ? 60 : form.length + k;
    for (let L = Math.max(1, form.length - k); L <= Math.min(maxLen, ix.byLen.length - 1); L++)
      for (const t of ix.byLen[L] || []) {
        if (t[0] !== form[0] && t[1] !== form[1]) continue;
        const pm = isLast && L > form.length + k; /* FIX F17: unfinished last word gets at most 1 edit */ const d = osa(form, t, pm ? Math.min(k, 1) : k, pm);
        if (d > 0 && d <= k) put(t, d === 1 ? 0.6 : 0.4, `fuzzy${d}`);
      }
  }
  return out;
}

const VOWELLESS = /^[b-df-hj-np-tv-xz]{2,3}$/;
function search(query, ix, opts = {}) {
  const prepped = prepIsbn(query);                                                                    // FIX F10
  const raw = prepped.trim();
  const digits = raw.replace(/[\s-]/g, '');
  if (/^\d{9,12}[\dxX]$/.test(digits)) {                                                               // ISBN-shaped query (10-13 chars)
    const hits = new Map();
    for (const f of isbnForms(digits)) for (const [id] of ix.vocab.get(f) || []) hits.set(id, 100);
    if (!hits.size) {                                                                                  // FIX F10: still typing -> prefix on ISBNs
      const d = digits.toLowerCase(); let lo = 0, hi = ix.sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; ix.sorted[mid] < d ? lo = mid + 1 : hi = mid; }
      for (let i = lo; i < ix.sorted.length && ix.sorted[i].startsWith(d); i++) for (const [id] of ix.vocab.get(ix.sorted[i])) hits.set(id, 80);
    }
    if (hits.size) return { strong: [...hits].map(([id, s]) => ({ doc: ix.docs[id], score: s, why: 'ISBN' })), possible: [] };
  }
  const folded = fold(raw);
  if (folded.replace(/[^\p{L}\p{N}]/gu, '').length < (opts.enter ? 1 : 2)) return { tooShort: true, strong: [], possible: [] };
  const allSlots = tokenize(folded);
  const qKey = key(allSlots);
  // FIX F7: merge label+number pairs into one required slot (loose fallback: the bare number, weak)
  const pairAt = new Map(allSlots.pairs.map(p => [p.i, p]));
  let slots = [];
  for (let i = 0; i < allSlots.length; i++) {
    const p = pairAt.get(i);
    if (p) { const numSlot = allSlots[CONTEXT[allSlots[p.i].orig] ? p.j : p.i]; slots.push({ orig: allSlots[p.i].orig + ' ' + allSlots[p.j].orig, forms: new Set([p.term]), loose: new Set([...numSlot.forms].filter(f => /^\d+$/.test(f))), opt: false, pair: true }); i = p.j; }
    else slots.push(allSlots[i]);
  }
  // FIX F11: words absorbed into a number stay as optional slots instead of being dropped
  for (const s of slots) if (s.absorbedBy != null) s.opt = true;
  for (const s of slots) {
    if (SOFT.has(s.orig) && !s.pair) { s.opt = true; s.soft = true; }                                // FIX F4
    if (/^(\d{10}|\d{9}x|\d{13})$/.test(s.orig)) { s.opt = true; s.isbn = true; for (const f of isbnForms(s.orig)) s.forms.add(f); } // FIX F10: ISBN inside text
  }
  const hasWord = () => slots.some(s => !s.opt && !s.initials && !VOWELLESS.test(s.orig));
  if (hasWord()) for (const s of slots) if (s.initials || (VOWELLESS.test(s.orig) && !s.pair && !/\d/.test(s.orig)) || (s.orig.length === 1 && /\p{L}/u.test(s.orig))) { s.opt = true; s.initials = true; } // FIX F8
  if (slots.every(s => s.opt)) {                                                                      // FIX F5
    const promotable = slots.filter(s => s.soft || s.initials || s.isbn || (s.absorbedBy != null && !OPTIONAL.has(s.orig)));
    if (promotable.length) promotable.forEach(s => s.opt = false);
    else {                                                                                             // only the/a/of/… -> hint, exact title only
      const exact = ix.docs.filter(d => d.titleKey && d.titleKey === qKey).map(doc => ({ doc, score: 100 }));
      return { stopwordsOnly: true, strong: exact, possible: [] };
    }
  }
  const last = slots.length - 1;
  const endsWithSpace = /\s$/.test(query);
  const perSlot = slots.map((s, i) => {
    const hits = new Map();
    const collect = (form, forceKind) => {
      for (const [t, { q, kind }] of termsFor(form, i === last && !endsWithSpace && !s.pair, ix))
        for (const [id, w] of ix.vocab.get(t)) { const sc = q * w; const o = hits.get(id); if (!o || o.score < sc) hits.set(id, { score: sc, kind: forceKind || kind, term: t, w }); }
    };
    if (s.pair) {                                                                                      // FIX F7: pair terms exact only
      for (const f of s.forms) for (const [id, w] of ix.vocab.get(f) || []) hits.set(id, { score: w, kind: 'exact', term: f, w });
      const label = [...s.forms][0].replace(/\d+$/, '');
      for (const f of s.loose) for (const [id, w] of ix.vocab.get(f) || []) if (!hits.has(id))
        if (ix.docs[id].pairLabels.has(label)) hits.set(id, { score: 0.3 * w, kind: 'loose', term: f, w });        // same label, other number: weak
        else if (ix.docs[id].labelWords.has(label)) hits.set(id, { score: 0.8 * w, kind: 'variant', term: f, w });   // label + number both present, unpaired
        // FIX F7b: row without the label word at all -> the bare number does not satisfy "book 3"
    } else for (const f of s.forms) collect(f);
    // FIX F13: query plural -> singular (grandmothers -> grandmother, also against joined pairs)
    if (s.orig.length >= 5 && /[^su]s$/.test(s.orig) && !/is$/.test(s.orig)) {
      const sg = s.orig.slice(0, -1);
      for (const [id, w] of ix.vocab.get(sg) || []) { const sc = 0.9 * w; const o = hits.get(id); if (!o || o.score < sc) hits.set(id, { score: sc, kind: 'variant', term: sg, w }); }
    }
    if (s.orig.length >= 6 && !s.pair) for (let c = 3; c <= s.orig.length - 3; c++) {
      const a = s.orig.slice(0, c), b = s.orig.slice(c), A = ix.vocab.get(a), B = ix.vocab.get(b);
      if (A && B) for (const [id, w] of A) if (B.has(id) && !hits.has(id)) hits.set(id, { score: 0.9 * w, kind: 'split', term: a + ' ' + b, w });
    }
    return hits;
  });
  for (let i = 0; i < slots.length - 1; i++) {
    if (slots[i].pair || slots[i + 1].pair) continue;
    const j = ix.vocab.get(slots[i].orig + slots[i + 1].orig);
    if (j) for (const [id, w] of j) for (const k of [i, i + 1]) if (!perSlot[k].has(id)) perSlot[k].set(id, { score: 0.9 * w, kind: 'join', w });
  }
  const required = slots.map((s, i) => i).filter(i => !slots[i].opt);
  // FIX F9: one-word query whose word exists as typed -> rows reached only by fuzzy spelling are Possible, not Strong
  const oneWordExact = required.length === 1 && [...perSlot[required[0]].values()].some(h => !/^fuzzy/.test(h.kind));
  const cands = new Set(); perSlot.forEach((m, i) => { if (!slots[i].opt || slots[i].isbn) for (const id of m.keys()) cands.add(id); });
  const strong = [], possible = [];
  const matchedTerms = new Set(), matchedExact = new Set(); perSlot.forEach(m => m.forEach(v => { if (v.term) { matchedTerms.add(v.term); if (!/^fuzzy|^prefix|^loose/.test(v.kind)) matchedExact.add(v.term); } }));
  for (const id of cands) {
    const doc = ix.docs[id];
    let score = 0, got = 0, weak = false, anchored = 0, isbnHit = false;
    for (let i = 0; i < slots.length; i++) {
      const h = perSlot[i].get(id); if (!h) continue;
      score += h.score;
      if (slots[i].isbn && h.w === 3) isbnHit = true;
      if (!slots[i].opt) {
        got++;
        if (h.kind === 'fuzzy2' || h.kind === 'loose' || (h.kind === 'fuzzy1' && slots[i].orig.length < 5) || (oneWordExact && /^fuzzy/.test(h.kind))) weak = true;
        // FIX F2: a match found only in Type/Banned By never anchors a partial (Possible) match
        if (!/^fuzzy/.test(h.kind) && h.kind !== 'loose' && h.w > META_W) anchored++;                    // FIX F16: fuzzy never anchors a partial match
      }
    }
    const coverage = got / required.length;
    const tReq = doc.slots.title.filter(s => !s.opt && s.absorbedBy == null);
    const titleInside = tReq.length > 0 && tReq.every(s => [...s.forms].some(f => (tReq.length === 1 ? matchedExact : matchedTerms).has(f))); // FIX F15
    // FIX F12: a one-word title ("1984") inside a long pasted query counts when an author word is also in the query
    const authorInQuery = doc.slots.author.some(s => !s.opt && s.orig.length >= 3 && [...s.forms].some(f => matchedTerms.has(f)) && perSlot.some((m, i) => m.get(id) && m.get(id).w === 2));
    let tier;
    if (isbnHit) { tier = 'strong'; score += 60; }
    else if (doc.titleKey && doc.titleKey === qKey) { tier = 'strong'; score += 50; }
    else if (coverage === 1 && !weak) tier = 'strong';
    else if (titleInside && (tReq.length >= 2 || required.length <= 3 || authorInQuery)) { tier = 'strong'; score += 5; }
    else if (coverage === 1 || (anchored / required.length >= 0.5 && anchored >= 1)) tier = 'possible';
    else continue;
    (tier === 'strong' ? strong : possible).push({ doc, score: score * (0.5 + coverage / 2), coverage });
  }
  const order = (a, b) => b.score - a.score || a.doc.id - b.doc.id;
  return { strong: strong.sort(order), possible: possible.sort(order) };
}

module.exports = { fold, uninvertArticle, tokenize, buildIndex, search, isbnForms, osa, prepIsbn };
