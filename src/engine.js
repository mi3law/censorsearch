// CensorSearch engine: one normalizer for sheet cells and queries, an in-memory index, and a tiered search
// (Match / Close / Possible) with reasons, notes, hints and highlights. Pure and dependency-free: it runs in Node
// (module.exports) and in browsers (window.CensorEngine), ES2020 plus Unicode property escapes.
//
// Spec: PRD.md, with the rule-by-rule consolidation in ENGINE_SPEC.md (section letters a-g are cited as "(b6)",
// "(e5c)" and so on). The matching core is ported from prototype/engine.js; its stress-test fixes keep their
// "FIX Fn" tags (prototype/README.md lists them).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CensorEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 0. vocabulary ----------
  const list = s => s.split(' ');
  const table = o => Object.assign(Object.create(null), o);  // lookup tables: no prototype keys ("constructor" is an ordinary word)
  const SMALL = new Set(list('the a an of and or to in on at for by with from'));          // ignorable (AWO-2)
  const FORMAT = new Set(list('book books disc discs disk dvd dvds cd cds video videos vhs bluray paperback hardcover hardback ' +
    'softcover kindle ebook audiobook audio novel edition editions ed edn anniversary illustrated unabridged abridged deluxe ' +
    'reprint revised expanded'));                                                              // FIX F4: format words are soft
  const QUESTION = new Set(list('is are was can could may banned ban allowed permitted prohibited ok okay appropriate suitable'));
  const ASKING = new Set(list('i we use read teach class'));                // optional too in a question: "can we read speak in class"
  const ROLE = new Set(list('jr sr dr mr sir dame prof rev author authors editor editors ed illustrator illustrators translator translators'));
  const PUBLISHER = new Set(list('company press publisher publishers books inc'));
  const FOREIGN_ART = new Set(list('le la les el los las il der die das'));
  const PLACEHOLDER = new Set(list('unknown unknownauthor anonymous anon various variousauthors variousartists multipleauthors ' +
    'noauthor unknownartist unknownartists na none nil notknown notlisted notstated notavailable tbd tba'));
  const EDITION_WORDS = new Set(list('edition ed edn anniversary'));

  const UNITS = table({}), TENS = table({}), ORDS = table({});
  list('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen ' +
    'eighteen nineteen').forEach((w, i) => { UNITS[w] = i; });
  list('twenty thirty forty fifty sixty seventy eighty ninety').forEach((w, i) => { TENS[w] = 20 + 10 * i; });
  list('first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth ' +
    'sixteenth seventeenth eighteenth nineteenth').forEach((w, i) => { ORDS[w] = i + 1; });
  list('twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth').forEach((w, i) => { ORDS[w] = 20 + 10 * i; });
  ORDS.hundredth = 100; ORDS.thousandth = 1000;
  const NUMW = Object.assign(table({ hundred: 100, thousand: 1000 }), UNITS, TENS);               // cardinal number words ('oh' is not one)
  const isNumWord = w => NUMW[w] !== undefined || ORDS[w] !== undefined;
  // (b8) common misspellings, read before numbers and before fuzzy matching (the typed word stays literal too)
  const MISSPELL = table({ ninteen: 'nineteen', ninty: 'ninety', fourty: 'forty', eigth: 'eighth', eigthy: 'eighty', twelth: 'twelfth',
    nineth: 'ninth', fith: 'fifth', fourtieth: 'fortieth', eightteen: 'eighteen' });
  // (e1) number words a word being typed may become: "sevent" -> seventh, seventeen…; "nint" -> ninth, ninety (via "ninty")
  const NUM_KEYS = Object.keys(NUMW).concat(Object.keys(ORDS), Object.keys(MISSPELL));
  function numCompletions(w, self) {
    const out = new Set();
    for (const k of NUM_KEYS) if (k.startsWith(w) && (self || k !== w)) out.add(MISSPELL[k] || k);
    return [...out];
  }
  const numForms = c => (ORDS[c] !== undefined ? [ORDS[c] + 'th', String(ORDS[c])] : [String(NUMW[c])]);
  const ONE_TO_NINE = list('one two three four five six seven eight nine');

  // (b6) label + number pairs: label word -> key. FIX F7: class/grade/standard share the grade key.
  const LABELS = table({});
  const labelKey = (key, s) => list(s).forEach(w => { LABELS[w] = key; });
  labelKey('book', 'book books bk bks volume volumes vol vols number no nos num');
  labelKey('grade', 'grade grades gr class standard std');
  labelKey('part', 'part parts pt'); labelKey('unit', 'unit units'); labelKey('chapter', 'chapter chapters ch chap');
  labelKey('level', 'level levels lvl'); labelKey('season', 'season seasons'); labelKey('episode', 'episode episodes ep');
  labelKey('edition', 'edition ed edn');
  list('lesson module stage act issue series year').forEach(w => { LABELS[w] = w; });

  // Field codes and weights. CONTENT fields (title, author, memo, isbn) can create a match; META (type, bannedBy) only completes one.
  const F_T = 0, F_A = 1, F_M = 2, F_I = 3, F_Y = 4, F_B = 5;
  const FIELD_W = [3, 2, 1, 3, 0.5, 0.5];
  const FIELD_NAMES = ['title', 'author', 'memo', 'isbn', 'type', 'bannedBy'];
  const FIELD_ORDER = [F_T, F_A, F_I, F_M, F_Y, F_B];                                      // order of Hit.fields (g6)
  // Hit kinds. exact-class = exact, alternate (incl. ordinal<->cardinal crossing), prefix.
  const K_EXACT = 0, K_ALT = 1, K_ALTX = 2, K_PREFIX = 3, K_COMP = 4, K_FZ1 = 5, K_FZ2 = 6, K_LOOSE = 7;
  const KIND_W = [1, 0.9, 0.75, 0.8, 0.9, 0.6, 0.4, 0.3];                                  // a crossing is the weakest exact-class hit
  const KIND_CLASS = [3, 3, 3, 3, 2, 1, 1, 0];
  const isExactish = k => k <= K_ALTX;                                                      // exact or through an alternate
  const hitValue = h => (h.f >= F_Y ? 30 : KIND_CLASS[h.k] * 10) + KIND_W[h.k] * FIELD_W[h.f];

  // ---------- (a) fold: one normalizer for sheet cells and queries ----------
  const APOS = new Set(['\u0027', '\u2018', '\u2019', '\u201a', '\u201b', '\u2032', '\u02b9', '\u02bb', '\u02bc', '`', '\u00b4', '\uff07']);
  const SYMBOL_MARKS = new Set(['\u2122', '\u2120', '\u00a9', '\u00ae', '\u2117']);
  const SPECIAL = table({ 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'ł': 'l', 'þ': 'th', 'ı': 'i' });
  const DROP = /[\p{M}\p{Cf}]/u;
  const charCache = new Map();
  // One source character (code point) -> its folded text: apostrophes unified and marks spaced BEFORE NFKD (so ´ is not
  // "' s"), FIX F1 Arabic-Indic/Persian digits, NFKD, accents and invisible format characters deleted, lower case, ß/æ/ø...
  function foldChar(ch) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) return c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : c === 0x60 ? "'" : ch;
    let out = charCache.get(ch);
    if (out !== undefined) return out;
    if (APOS.has(ch)) out = "'";
    else if (SYMBOL_MARKS.has(ch)) out = ' ';
    else if (c >= 0x660 && c <= 0x669) out = String(c - 0x660);
    else if (c >= 0x6F0 && c <= 0x6F9) out = String(c - 0x6F0);
    else {
      out = '';
      for (const d of ch.normalize('NFKD')) {
        if (DROP.test(d)) continue;
        for (const l of d.toLowerCase()) out += SPECIAL[l] !== undefined ? SPECIAL[l] : l;
      }
    }
    charCache.set(ch, out);
    return out;
  }
  // Replaces every match of a global regex, keeping the map from folded characters back to source ranges.
  function rewrite(st, re, repl) {
    re.lastIndex = 0;
    let m = re.exec(st.s);
    if (!m) return st;
    let s = '', last = 0;
    const a = [], b = [];
    const copy = (from, to) => { s += st.s.slice(from, to); for (let i = from; i < to; i++) { a.push(st.a[i]); b.push(st.b[i]); } };
    while (m) {
      copy(last, m.index);
      const r = typeof repl === 'string' ? repl : repl(m[0]);
      const end = m.index + m[0].length;
      const from = end > m.index ? st.a[m.index] : 0, to = end > m.index ? st.b[end - 1] : 0;
      s += r;
      for (let i = 0; i < r.length; i++) { a.push(from); b.push(to); }
      last = end;
      if (end === m.index) re.lastIndex++;
      m = re.exec(st.s);
    }
    copy(last, st.s.length);
    return { s, a, b };
  }
  const SYMBOLS = table({ 'c++': 'cplusplus', 'c#': 'csharp', 'f#': 'fsharp', 'a+': 'aplus' });      // PUNC-10 (a 4-entry table)
  const SYMBOL_RE = /(?<=^|\s)(?:c\+\+|c#|f#|a\+)(?=$|[\s\p{P}\p{S}])/gu;
  // foldWithMap(text) -> { s: folded text, a, b }: folded char i came from source range [a[i], b[i]) (used for highlights).
  function foldWithMap(text) {
    const src = String(text ?? '');
    let s = '';
    const a = [], b = [];
    for (let i = 0; i < src.length;) {
      const c = src.charCodeAt(i);
      const n = c >= 0xD800 && c <= 0xDBFF && i + 1 < src.length ? 2 : 1;
      const out = foldChar(n === 1 ? src[i] : src.slice(i, i + 2));
      for (let k = 0; k < out.length; k++) { a.push(i); b.push(i + n); }
      s += out; i += n;
    }
    let st = { s, a, b };
    if (/[+#]/.test(s)) st = rewrite(st, SYMBOL_RE, m => SYMBOLS[m]);
    if (/[&+]|'n|n'/.test(st.s)) {
      st = rewrite(st, /&/g, ' and ');                                                        // AT&T -> at and t
      st = rewrite(st, /(?<=^|\s)\+(?=\s|$)/g, ' and ');
      st = rewrite(st, /(?<=^|\s)(?:'n'|n'|'n)(?=\s|$)/g, 'and');                             // rock 'n' roll
    }
    if (/\d,\d/.test(st.s)) st = rewrite(st, /\b\d{1,3}(?:,\d{3})+\b/g, m => m.replace(/,/g, '')); // NUM-10: 20,000 -> 20000
    if (/\s\s|[^\S ]|^\s|\s$/.test(st.s)) {                                                   // every whitespace run -> one space, trimmed
      st = rewrite(st, /\s+/g, ' ');
      const lead = st.s[0] === ' ' ? 1 : 0, trail = st.s.length > lead && st.s[st.s.length - 1] === ' ' ? 1 : 0;
      if (lead || trail) st = { s: st.s.slice(lead, st.s.length - trail), a: st.a.slice(lead, st.a.length - trail), b: st.b.slice(lead, st.b.length - trail) };
    }
    return st;
  }
  const fold = text => foldWithMap(text).s;

  // ---------- (g5) display title: move a trailing article back to the front ----------
  const ART_RE = /^\s*(the|a|an|le|la|les|el|los|las|il|der|die|das)(?![\p{L}\p{N}'\u2019])/iu;
  const REST_OK = /^(?:$|\s*[:;.,(\[{\/!?\p{Pd}\u2212\u2122\u00ae\u00a9])/u;
  // Returns the title with the article moved, or null when the title has no movable ", The" (shortest head first). Invisible
  // format characters (zero-width space, LRM/RLM) are dropped from a moved title; stray commas before the article too.
  function moveArticle(text) {
    const t = String(text ?? '').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
    for (let ci = t.indexOf(','); ci !== -1; ci = t.indexOf(',', ci + 1)) {
      const head = t.slice(0, ci).replace(/[\s,]+$/, '');
      if (!head) continue;
      const m = ART_RE.exec(t.slice(ci + 1));
      if (!m) continue;
      const rest = t.slice(ci + 1 + m[0].length);
      if (!REST_OK.test(rest)) continue;
      // letter-range guard (AWO-8), only for the article A: "Animals, A-Z", "Seashells, A – Z"
      if (m[1].toLowerCase() === 'a' && (/^[\p{Pd}\u2212][\p{L}\p{N}]/u.test(rest) || /^\s*[\p{Pd}\u2212]\s*\p{L}(?!\p{L})/u.test(rest))) continue;
      return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + head + rest;
    }
    return null;
  }
  // "7th Knot, The" -> "The 7th Knot"; "Alchemist, The: A Fable…" -> "The Alchemist: A Fable…"; whitespace collapsed, nothing else changes.
  function normalizeTitleForDisplay(title) {
    return moveArticle(title) ?? String(title ?? '').replace(/\s+/g, ' ').trim();
  }

  // (g7) multi-line paste: non-empty trimmed lines ([] for blank text, [line] for one line). search() itself never splits.
  // U+000B/U+000C are PowerPoint/Office line breaks. In a list of 2+ lines, a leading list marker ("1.", "2)", "(3)", "-", "•")
  // is not part of the title and is dropped.
  const LIST_MARK = /^(?:\(?\d{1,3}[.)]|[-*\u2022\u00b7\u2023\u25e6\u25aa\u2013\u2014])\s+(?=\S)/u;
  function splitLines(text) {
    const lines = String(text ?? '').split(/\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029]/)
      .map(l => l.replace(/\p{Cf}/gu, '').trim()).filter(l => /[\p{L}\p{N}]/u.test(l));
    return lines.length >= 2 ? lines.map(l => l.replace(LIST_MARK, '')) : lines;
  }

  // ---------- (b) tokenizer and alternate forms ----------
  // analyze(folded) -> Word[] with .chunks, .runs and .pairs. A Word is one searchable word: its apostrophe-free text w,
  // [s, e) offsets into the folded text, the break characters before it (brk), its chunk (hyphen / letter-digit group) and
  // its alternates [term, kind, explain?, numeric?]. Alternates are added, never replace the word, and are never re-read (PN-0).
  const WORD_RE = /[\p{L}\p{N}']+/gu;
  const DASH1 = /^[\p{Pd}\u2212\u2043]$/u;                        // a hyphen: one dash with word characters on both sides (b2)
  const DASH_SP = /^\s*[\p{Pd}\u2212\u2043]\s*$/u;
  const HAS_L = /\p{L}/u, ONLY_L = /^\p{L}+$/u, ONLY_D = /^\d+$/;
  const ROMAN_RE = /^(x{0,3})(ix|iv|v?i{0,3})$/;
  function romanValue(t) {
    if (!t || !ROMAN_RE.test(t)) return 0;
    const v = { i: 1, v: 5, x: 10 };
    let n = 0;
    for (let i = 0; i < t.length; i++) { const a = v[t[i]], b = v[t[i + 1]] || 0; n += a < b ? -a : a; }
    return n;
  }
  const stripZeros = d => d.replace(/^0+(?=\d)/, '');
  function mkWord(w, s, e, brk, ch) {
    return { w, s, e, brk, ch, alts: [], digits: ONLY_D.test(w), letters: ONLY_L.test(w), nw: w, num: null, ord: false,
      roman: 0, initials: null, run: null, pair: null };
  }
  function addAlt(x, t, k, explain, numeric) {
    if (t && t !== x.w && !x.alts.some(a => a[0] === t)) x.alts.push([t, k, explain ? 1 : 0, numeric ? 1 : 0]);
  }

  // Cardinal grammar over number words (b8): TENS[-UNIT], UNIT/TEEN, N hundred [and] M, N thousand [and] M, "20 thousand".
  // Returns { v, ord } only when the WHOLE token list reads as one number.
  function cardinal(ts) {
    let i = 0;
    const under100 = () => {
      const a = ts[i];
      if (TENS[a] !== undefined) {
        const b = ts[++i];
        if (UNITS[b] >= 1 && UNITS[b] <= 9) { i++; return { v: TENS[a] + UNITS[b] }; }
        if (ORDS[b] >= 1 && ORDS[b] <= 9) { i++; return { v: TENS[a] + ORDS[b], ord: true }; }   // twenty-first
        return { v: TENS[a] };
      }
      if (UNITS[a] !== undefined) { i++; return { v: UNITS[a] }; }
      if (ORDS[a] !== undefined) { i++; return { v: ORDS[a], ord: true }; }
      return null;
    };
    const under1000 = () => {
      const x = ONLY_D.test(ts[i] || '') && (ts[i + 1] === 'hundred' || ts[i + 1] === 'thousand') ? { v: +ts[i++] } : under100();
      if (ts[i] !== 'hundred' || (x && x.ord)) return x;
      const n = x ? x.v : 1;
      if (n < 1 || n > 99) return null;
      if (ts[++i] === 'and') i++;
      const y = under100();
      return { v: n * 100 + (y ? y.v : 0), ord: !!(y && y.ord) };
    };
    let x = under1000();
    if (ts[i] === 'thousand' && !(x && x.ord)) {
      const n = x ? x.v : 1;
      if (n < 1 || n > 999) return null;
      if (ts[++i] === 'and') i++;
      const y = under1000();
      x = { v: n * 1000 + (y ? y.v : 0), ord: !!(y && y.ord) };
    }
    return x && i === ts.length ? x : null;
  }
  // Two groups A B read together (FIX F11): years "nineteen eighty-four" = 1984, spoken digits "four fifty-one" = 451.
  function twoGroups(ts) {
    const group = i => {
      const a = ts[i];
      if (TENS[a] !== undefined) return UNITS[ts[i + 1]] >= 1 && UNITS[ts[i + 1]] <= 9 ? { v: TENS[a] + UNITS[ts[i + 1]], n: 2 } : { v: TENS[a], n: 1 };
      return UNITS[a] !== undefined ? { v: UNITS[a], n: 1 } : null;
    };
    const A = group(0), B = A && group(A.n);
    if (!B || A.n + B.n !== ts.length || A.v < 1 || B.v < 10 || B.v > 99) return null;
    return { v: A.v * 100 + B.v, A: A.v, B: B.v, split: A.n };
  }
  function readRun(ts) {
    const c = cardinal(ts), two = twoGroups(ts);
    if (!c && !two) return null;
    const vals = c ? [String(c.v)] : [];
    if (two && (!c || c.v !== two.v)) vals.push(String(two.v));
    return { vals, ord: !!(c && c.ord), two };
  }
  // Run-together number words: twentyone -> 21, nineteeneightyfour -> 1984, ninteeneightyfour (misspelt parts too) -> 1984
  // (tenfour reads as nothing).
  const NUM_PARTS = Object.keys(NUMW).concat(Object.keys(ORDS), Object.keys(MISSPELL)).sort((a, b) => b.length - a.length);
  const RUN_TOGETHER = new RegExp('^(?:' + NUM_PARTS.join('|') + '){2,}$');
  function runTogether(t) {
    if (t.length < 6 || !RUN_TOGETHER.test(t)) return null;
    const split = (i, out) => {
      if (i === t.length) return out.length >= 2 ? readRun(out) : null;
      for (const p of NUM_PARTS) if (t.startsWith(p, i)) { const r = split(i + p.length, out.concat(MISSPELL[p] || p)); if (r) return r; }
      return null;
    };
    const r = split(0, []);
    return r ? r.vals[0] : null;
  }

  function analyze(text) {
    let W = [], prev = 0, chunk = -1, m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) {
      const raw = m[0], s = m.index, e = s + raw.length, w = raw.replace(/'/g, '');
      if (!w) continue;
      const brk = text.slice(prev, s);
      prev = e;
      if (!(W.length && DASH1.test(brk))) chunk++;
      if (HAS_L.test(w) && /\d/.test(w) && !/^\d+(?:st|nd|rd|th)$/.test(w)) {           // (b3) 10minute, covid19: parts + joined form
        const re = /[\p{L}']+|[^\p{L}']+/gu;
        let p, first = true;
        while ((p = re.exec(raw))) {
          const pw = p[0].replace(/'/g, '');
          if (pw) { W.push(mkWord(pw, s + p.index, s + p.index + p[0].length, first ? brk : '', chunk)); first = false; }
        }
        continue;
      }
      const x = mkWord(w, s, e, brk, chunk);
      x.dot = text[e] === '.';
      if (raw !== w) {                                                                   // (b4) aaron's -> aarons + aaron; l'engle -> engle
        if (/'s$/.test(raw)) addAlt(x, raw.slice(0, -2).replace(/'/g, ''), K_ALT);
        const el = /^[odl]'(.+)$/.exec(raw);
        if (el && el[1].replace(/'/g, '').length >= 2) addAlt(x, el[1].replace(/'/g, ''), K_ALT);
      }
      W.push(x);
    }
    // (b5) FIX F8: 2+ single letters separated only by spaces or periods are ONE initials word: R.L. / R. L. / r l -> rl.
    // "a" is an initial only when a period follows it or joins it to the letter before (A.I., U.S.A., A. A. Milne); a
    // space-separated "a" stays the small word.
    const size = {};
    for (const x of W) size[x.ch] = (size[x.ch] || 0) + 1;
    const single = x => x.w.length === 1 && x.letters && size[x.ch] === 1;
    const isInit = i => single(W[i]) && (W[i].w !== 'a' || W[i].dot || (i > 0 && single(W[i - 1]) && W[i].brk.includes('.')));
    const merged = [];
    for (let i = 0; i < W.length; i++) {
      if (isInit(i) && i + 1 < W.length && isInit(i + 1) && /^[\s.]+$/.test(W[i + 1].brk)) {
        let j = i;
        const letters = [W[i].w];
        while (j + 1 < W.length && isInit(j + 1) && /^[\s.]+$/.test(W[j + 1].brk)) letters.push(W[++j].w);
        const x = mkWord(letters.join(''), W[i].s, W[j].e, W[i].brk, W[i].ch);
        x.initials = letters;
        merged.push(x);
        i = j;
      } else merged.push(W[i]);
    }
    W = merged;
    // (b8, b9, b7) misspelled number words, digits, ordinals, number words, run-together numbers, Roman numerals
    for (const x of W) {
      if (x.initials) continue;
      if (MISSPELL[x.w]) { x.nw = MISSPELL[x.w]; addAlt(x, x.nw, K_ALT, true); }
      const t = x.nw;
      let mm;
      if (x.digits) { x.num = stripZeros(t); addAlt(x, x.num, K_ALT, false, true); }
      else if ((mm = /^(\d+)(?:st|nd|rd|th)$/.exec(t)) || ORDS[t]) {                      // 7th / seventh -> key 7th, crossing to 7
        x.num = mm ? stripZeros(mm[1]) : String(ORDS[t]);
        x.ord = true;
        addAlt(x, x.num + 'th', K_ALT, true, true);
        addAlt(x, x.num, K_ALTX, true, true);
      } else if (NUMW[t] !== undefined) { x.num = String(NUMW[t]); addAlt(x, x.num, K_ALT, true, true); }  // FIX F11b: never fuzzy
      else if (x.letters) {
        const v = runTogether(t);
        if (v) addAlt(x, v, K_ALT, true, true);
        else if (t.length >= 2) { const r = romanValue(t); if (r >= 2 && r <= 30) { x.roman = r; addAlt(x, String(r), K_ALT, true, true); } }
      }
    }
    // (b8) number-word runs: one unit / one indexed value; the words stay literal too
    W.runs = [];
    const isMult = x => !!x && (x.nw === 'hundred' || x.nw === 'thousand');
    const startable = i => !W[i].initials && (isNumWord(W[i].nw) || (W[i].digits && isMult(W[i + 1])));
    const joinable = b => {
      const y = W[b];
      if (!(y.brk === ' ' || DASH1.test(y.brk))) return false;
      if (isNumWord(y.nw)) return true;
      return y.w === 'and' && isMult(W[b - 1]) && b + 1 < W.length && NUMW[W[b + 1].nw] !== undefined && W[b + 1].brk === ' ';
    };
    for (let i = 0; i < W.length; i++) {
      if (!startable(i)) continue;
      let j = i;
      while (j + 1 < W.length && j - i < 7 && joinable(j + 1)) j++;
      for (let len = j - i + 1; len >= 2; len--) {
        const r = readRun(W.slice(i, i + len).map(x => (x.digits ? x.num : x.nw)));
        if (!r) continue;
        const run = Object.assign(r, { i, j: i + len - 1 });
        for (let k = i; k <= run.j; k++) W[k].run = run;
        W.runs.push(run);
        i = run.j;
        break;
      }
    }
    // (b6) FIX F7 label + number pairs -> '#book3', '#grade8' (pair namespace); (b6r) ranges "Books 4–6", "Volumes I–III" ->
    // #book4..#book6; lists "Books 1 & 2", "Volumes 1, 2 and 3", "Parts One and Two" -> a pair term for each number
    W.pairs = [];
    for (let i = 0; i < W.length; i++) {
      const x = W[i];
      if (x.pair) continue;
      if (x.w === 'kindergarten') { addPair(W, 'grade', 0, i, i, i, null, null); continue; }
      const key = LABELS[x.w];
      const n = key && pairNumber(W, i + 1, key);
      if (n) {
        let end = n.end, rng = null;
        const k = end + 1;
        if (k < W.length) {
          const to = /^(?:to|through|thru)$/.test(W[k].w);
          const mm = DASH_SP.test(W[k].brk) ? pairNumber(W, k, key) : to ? pairNumber(W, k + 1, key) : null;
          if (mm && !mm.roman === !n.roman && mm.v > n.v) { rng = { n: n.v, m: mm.v, k: !!n.k }; end = mm.end; }
        }
        if (!rng) {
          const list = [n.v];
          for (let e = end; e + 1 < W.length;) {
            const y = W[e + 1];
            const nx = y.w === 'and' ? pairNumber(W, e + 2, key) : /^\s*[,\/+]\s*$/.test(y.brk) ? pairNumber(W, e + 1, key) : null;
            if (!nx || !nx.roman !== !n.roman || nx.v <= list[list.length - 1]) break;
            list.push(nx.v);
            end = e = nx.end;
            if (nx.roman) addAlt(W[nx.end], String(nx.v), K_ALT, true, true);
          }
          if (list.length > 1) rng = { n: list[0], m: list[list.length - 1], k: !!n.k, list };
        }
        addPair(W, key, n.v, i, i, end, rng, n);
        i = end;
        continue;
      }
      if (x.ord && !x.run && i + 1 < W.length && LABELS[W[i + 1].w] && !W[i + 1].pair) {  // 5th grade, second book
        addPair(W, LABELS[W[i + 1].w], +x.num, i + 1, i, i + 1, null, null);
        i++;
        continue;
      }
      if (x.digits && !x.run && +x.num < 100 && /#\s*$/.test(x.brk)) addPair(W, 'book', +x.num, -1, i, i, null, null);   // "#3"
    }
    // (b11) 9/11 -> 911 (the only digit join)
    for (let i = 0; i + 1 < W.length; i++)
      if (W[i].w === '9' && W[i + 1].w === '11' && /^\s*\/\s*$/.test(W[i + 1].brk)) { addAlt(W[i], '911', K_ALT); addAlt(W[i + 1], '911', K_ALT); }
    // (b2, b3) chunks: the whole chain joined plus each adjacent pair; two all-digit parts are never joined (FIX F3, NUM-11)
    W.chunks = [];
    for (let i = 0; i < W.length;) {
      let j = i;
      while (j + 1 < W.length && W[j + 1].ch === W[i].ch) j++;
      if (j > i) {
        const parts = W.slice(i, j + 1), joins = [];
        const dd = k => parts[k].digits && parts[k - 1].digits;
        if (!parts.some((p, k) => k && dd(k))) joins.push({ t: parts.map(p => p.w).join(''), a: i, b: j });
        if (parts.length > 2) for (let k = 1; k < parts.length; k++) if (!dd(k)) joins.push({ t: parts[k - 1].w + parts[k].w, a: i + k - 1, b: i + k });
        W.chunks.push({ a: i, b: j, joins });
      }
      i = j + 1;
    }
    return W;
  }
  // The number after a label. 100 and over is never a volume, grade or unit ("book 1984", "#451", "year 2023-2024"): the label stays a
  // word and the number a title word or year.
  function pairNumber(W, j, key) {
    const y = W[j];
    if (!y || y.pair || y.initials) return null;
    if (y.run) return y.run.i === j && +y.run.vals[0] < 100 ? { v: +y.run.vals[0], end: y.run.j } : null;
    if (y.num !== null && !y.ord) return +y.num < 100 ? { v: +y.num, end: j } : null;
    const r = y.letters ? romanValue(y.w) : 0;
    if (r >= 1 && r <= 30) return { v: r, end: j, roman: true };                            // Volume II, Class VIII, Part I
    if (key === 'grade' && (y.w === 'k' || y.w === 'kg')) return { v: 0, end: j, k: true };  // Grade K = grade 0
    return null;
  }
  function addPair(W, key, v, li, a, b, rng, n) {
    const p = { key, v, li, a, b, rng, terms: [] };
    if (!rng) p.terms.push('#' + key + v);
    else if (rng.list) for (const k of rng.list) p.terms.push('#' + key + k);
    else if (rng.m - rng.n <= 19) for (let k = rng.n; k <= rng.m; k++) p.terms.push('#' + key + k);
    else p.terms.push('#' + key + rng.n, '#' + key + rng.m);
    for (let k = a; k <= b; k++) W[k].pair = p;
    if (n && n.roman) addAlt(W[n.end], String(v), K_ALT, true, true);
    W.pairs.push(p);
  }

  // ---------- ISBN helpers (c5) ----------
  const isbnKey = d => (d.length === 10 ? '978' + d.slice(0, 9) : d.slice(0, 12));          // check digit ignored
  function check13(b12) { let s = 0; for (let i = 0; i < 12; i++) s += +b12[i] * (i % 2 ? 3 : 1); return b12 + ((10 - (s % 10)) % 10); }
  function check10(b9) { let s = 0; for (let i = 0; i < 9; i++) s += +b9[i] * (10 - i); const c = (11 - (s % 11)) % 11; return b9 + (c === 10 ? 'x' : c); }
  const isbnPrefixForms = d => (d.length === 10 ? [d, check13('978' + d.slice(0, 9))] : d.startsWith('978') ? [d, check10(d.slice(3, 12))] : [d]);
  const completeIsbn = d => /^\d{9}[\dx]$/.test(d) || /^97[89]\d{10}$/.test(d);
  // Digit groups joined by single hyphens or spaces, each complete ISBN in them (a 13-digit 978/979 one before an ISBN-10 that
  // starts it): "978-0-374-37152-4 (pbk.)", "9780062498533 9780062498540". add(digits, start, end) gets each one.
  function isbnScan(t, off, add) {
    const g = [...t.matchAll(/\d+(?:x(?![a-z]))?|(?<=\d[ -])x(?![a-z])/gi)];
    for (let i = 0; i < g.length;) {
      let d = '', pick = -1, pd = '';
      for (let j = i; j < g.length; j++) {
        if (j > i && !/^[ -]$/.test(t.slice(g[j - 1].index + g[j - 1][0].length, g[j].index))) break;
        d += g[j][0].toLowerCase();
        if (d.length > 13) break;
        if (/^97[89]\d{10}$/.test(d)) { pick = j; pd = d; break; }
        if (/^\d{9}[\dx]$/.test(d)) { pick = j; pd = d; }
      }
      if (pick < 0) { i++; continue; }
      add(pd, off + g[i].index, off + g[pick].index + g[pick][0].length);
      i = pick + 1;
    }
  }
  // Every ISBN-shaped run in a cell with its [start, end) in the cell. Scientific notation ("9.79889E+12") has lost its
  // digits and gives nothing; placeholders (N/A, -, none…) give nothing; a bad checksum is never rejected. Every dash counts as
  // a hyphen, and a number formatted with digit-group commas ("9,781,400,033,416") is one number.
  function isbnRuns(value) {
    let cell = String(value ?? '').replace(/[\p{Pd}\u2212]/gu, '-');                          // same length: positions hold
    if (!/\d/.test(cell) || /^\s*[\d.]+e[+-]?\d+\s*$/i.test(cell)) return [];
    if (/^\s*\d{1,3}(?:,\d{3}){2,}\s*$/.test(cell)) cell = cell.replace(/,/g, '-');
    const text = cell.replace(/\bisbn(?:[\s-]*1[03])?\s*[:#]?/gi, m => ' '.repeat(m.length));
    const out = [], cuts = [];
    const add = (d, s, e) => {
      d = d.toLowerCase();
      if (/^\d{9}$/.test(d)) d = '0' + d;                                                    // a lost leading 0
      if (completeIsbn(d)) out.push({ d, s, e, key: isbnKey(d) });
    };
    const SPLIT = /[\/,;|\n\r&]|\b(?:or|and)\b/gi;
    let last = 0, m;
    while ((m = SPLIT.exec(text))) { cuts.push([last, m.index]); last = m.index + m[0].length; }
    cuts.push([last, text.length]);
    for (const [a, b] of cuts) {
      const piece = text.slice(a, b), t = piece.trim();
      if (!/\d/.test(t)) continue;
      const off = a + piece.indexOf(t), d = t.replace(/[\s-]/g, '');
      if (/^[\d\s-]+[xX]?$/.test(t) && (d.length === 9 || d.length === 10 || d.length === 13)) { add(d, off, off + t.length); continue; }
      isbnScan(t, off, add);
    }
    return out;
  }

  // ---------- (c) index ----------
  const RESIDUE_RE = /\+\d[0-9a-z]*(?::[0-9a-z]*)+\s*$/i;                                   // (c3) FIX F14 "+3:15A13:153:…"
  // A posting: row, field, kind, source [s, e), word indices wi..wj, paired?, x = explain flag (compounds: first word's length)
  function post(ix, t, r, f, k, s, e, wi, wj, paired, explain) {
    let l = ix.terms.get(t);
    if (!l) ix.terms.set(t, (l = []));
    l.push({ r, f, k, s, e, wi, wj, p: paired, x: explain });
  }
  const canFuzzy = x => x.letters && !x.initials && !SMALL.has(x.w) && !isNumWord(x.nw) && !MISSPELL[x.w];
  // Index one field of one row: words, alternates, number values, pairs, hyphen joins and compounds (c2).
  function indexField(ix, doc, f, text, fuzzy) {
    const st = foldWithMap(text), W = analyze(st.s), r = doc.r, meta = f >= F_Y;
    const fd = { W, st, text };
    doc.fw[f] = fd;
    if (f === F_A) {                                                                         // FIX F6: "Et Al" / "and others" are not authors
      for (let i = 0; i + 1 < W.length; i++) if (W[i].w === 'et' && W[i + 1].w === 'al') { W[i].skip = W[i + 1].skip = true; doc.etAl = true; }
      const n = W.length;
      if (n >= 2 && W[n - 2].w === 'and' && W[n - 1].w === 'others') { W[n - 2].skip = W[n - 1].skip = true; doc.etAl = true; }
    }
    const S = x => st.a[x.s], E = x => st.b[x.e - 1];
    W.forEach((x, i) => {
      if (x.skip || (meta && !HAS_L.test(x.w))) return;
      const s = S(x), e = E(x), paired = !!x.pair;
      post(ix, x.w, r, f, K_EXACT, s, e, i, i, paired, 0);
      // numeric alternates: not in Type/Banned By, not on run words (the run posts its value), no Roman numerals in names ("Xi")
      for (const [t, k, why, num] of x.alts) if (!(num && (meta || x.run || (f === F_A && x.roman)))) post(ix, t, r, f, k, s, e, i, i, paired, why);
      if (!meta && !ix.spell.has(x.w)) ix.spell.set(x.w, text.slice(s, e));
      if (!meta && canFuzzy(x)) fuzzy.add(x.w);
      if (LABELS[x.w] && !meta) { doc.labelKeys.add(LABELS[x.w]); if (!paired) doc.unpairedLabels.add(LABELS[x.w]); }
    });
    for (const c of W.chunks) for (const j of c.joins) {
      if (W[j.a].skip || W[j.b].skip || (meta && !HAS_L.test(j.t))) continue;
      post(ix, j.t, r, f, K_ALT, S(W[j.a]), E(W[j.b]), j.a, j.b, false, 0);
      if (!meta && ONLY_L.test(j.t)) fuzzy.add(j.t);
    }
    if (meta) return;
    for (const run of W.runs) {                                                             // (b8) values on the run span
      const a = W[run.i], s = S(a), e = E(W[run.j]), p = !!a.pair;
      if (run.ord) { post(ix, run.vals[0] + 'th', r, f, K_ALT, s, e, run.i, run.j, p, 1); post(ix, run.vals[0], r, f, K_ALTX, s, e, run.i, run.j, p, 1); }
      else for (const v of run.vals) post(ix, v, r, f, K_ALT, s, e, run.i, run.j, p, 1);
      if (run.two) {                                                                        // two-group readings also post A and B
        const sp = run.i + run.two.split;
        post(ix, String(run.two.A), r, f, K_ALT, s, E(W[sp - 1]), run.i, sp - 1, p, 1);
        post(ix, String(run.two.B), r, f, K_ALT, S(W[sp]), e, sp, run.j, p, 1);
      }
    }
    for (const p of W.pairs) {                                                             // (b6) pair namespace
      const s = S(W[p.a]), e = E(W[p.b]), ni = p.li === p.b ? p.a : p.b;
      for (const t of p.terms) post(ix, t, r, f, p.rng ? K_ALT : K_EXACT, s, e, ni, p.li >= 0 ? p.li : ni, true, 0);
      doc.pairs.push({ key: p.key, v: p.v, rng: p.rng, f, s, e, wi: ni, wj: p.li >= 0 ? p.li : ni });
      if (!ix.pairKeyRows.has(p.key)) ix.pairKeyRows.set(p.key, new Set());
      ix.pairKeyRows.get(p.key).add(r);
    }
    for (let i = 1; i < W.length; i++) {                                                   // (c2) compounds: Grand Mother -> grandmother
      const x = W[i - 1], y = W[i];
      if (!x.skip && !y.skip && y.brk === ' ' && HAS_L.test(x.w) && HAS_L.test(y.w)) post(ix, x.w + y.w, r, f, K_COMP, S(x), E(y), i - 1, i, false, x.w.length);
    }
    // non-SMALL position of every word (words in order, f2) and whether it is an author word (e5c, e5d)
    let n = 0;
    fd.pos = W.map(x => (SMALL.has(x.w) || x.skip ? -1 : n++));
  }

  function seriesMarkers(W) {                                                              // (e5d) whole-series wording in a title
    const out = new Set(), w = i => (W[i] ? W[i].w : '');
    for (let i = 0; i < W.length; i++) {
      if (w(i) === 'series' && w(i + 1) !== 'of' && !W[i].pair) out.add(i);                 // not "Doctor Who Series 3" (one season)
      if (/^(?:collection|boxset|trilogy|omnibus)$/.test(w(i))) out.add(i);
      if ((w(i) === 'all' && /^(?:titles|books|works)$/.test(w(i + 1))) || (w(i) === 'complete' && /^(?:works|series)$/.test(w(i + 1))) ||
          (/^box(?:ed)?$/.test(w(i)) && w(i + 1) === 'set')) { out.add(i); out.add(i + 1); }
    }
    return out;
  }
  // Surnames (c7: the authorHasOthers hint, series lifts, short surnames): split names on ; / & and. A comma is "Last, Given"
  // ("Rowling, J. K.", "King, Martin Luther") unless every comma part is a full name of 2+ words that are not initials
  // ("Jack Canfield, Mark Victor Hansen").
  function surnamesOf(author) {
    const a = String(author ?? '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\bet\.?\s*al\b\.?/gi, ' ').replace(/(?:and|&)\s+others\s*$/i, ' ');
    const out = [];
    const lastWord = s => {
      const ws = s.split(/\s+/).map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(t => t && !ROLE.has(fold(t).replace(/\W/g, '')));
      if (ws.length) out.push(ws[ws.length - 1]);
    };
    for (const name of a.split(/\s*(?:;|\/|&|\band\b)\s*/i)) {
      const parts = name.split(',').map(t => t.trim()).filter(Boolean);
      if (!parts.length) continue;
      const full = p => p.split(/\s+/).filter(t => bare(t).length >= 2 && !ROLE.has(bare(t))).length >= 2;
      if (parts.length > 1 && parts.every(full)) parts.forEach(lastWord);
      else lastWord(parts[0]);
    }
    return out;
  }
  const bare = t => fold(t).replace(/[^\p{L}\p{N}]/gu, '');

  function indexRow(ix, row, r, fuzzy) {
    const display = normalizeTitleForDisplay(row.title);
    const doc = { r, row, id: typeof row.id === 'number' ? row.id : r, display, fw: [], pairs: [], labelKeys: new Set(),
      unpairedLabels: new Set(), etAl: false, notes: [] };
    ix.docs.push(doc);
    const residue = RESIDUE_RE.exec(display);
    indexField(ix, doc, F_T, residue ? display.slice(0, residue.index) : display, fuzzy);
    const author = String(row.author ?? '');
    // (c4) N/A, Unknown, Various Artists, Author Unknown, - … index nothing (role words aside: "Anonymous Author" = anonymous)
    const placeholder = !bare(author) || PLACEHOLDER.has(bare(author)) || PLACEHOLDER.has(analyze(fold(author)).filter(x => !ROLE.has(x.w)).map(x => x.w).join(''));
    if (!placeholder) indexField(ix, doc, F_A, author, fuzzy);
    if (doc.etAl) ix.hasEtAl = true;
    if (String(row.memo ?? '')) indexField(ix, doc, F_M, String(row.memo), fuzzy);
    if (String(row.type ?? '')) indexField(ix, doc, F_Y, String(row.type), fuzzy);           // FIX F2: Type / Banned By only complete
    if (String(row.bannedBy ?? '')) indexField(ix, doc, F_B, String(row.bannedBy), fuzzy);  //         a match; Year is never indexed
    // ISBNs (c5): separate index, never in the word vocabulary
    const raw = /^(?:\d{9}|\d{9}[\dXx]|\d{13})$/.test(String(row.isbnRaw ?? '')) ? String(row.isbnRaw) : '';   // exact raw digits only when they are one ISBN
    doc.isbn = raw ? isbnRuns(raw).map(x => Object.assign(x, { s: 0, e: String(row.isbn ?? '').length })) : isbnRuns(row.isbn);
    for (const x of doc.isbn) {
      if (!ix.isbnKeys.has(x.key)) ix.isbnKeys.set(x.key, []);
      ix.isbnKeys.get(x.key).push({ r, s: x.s, e: x.e });
      for (const f of isbnPrefixForms(x.d)) ix.isbnForms.push({ f, r, s: x.s, e: x.e });
    }
    if (doc.isbn.length) ix.isbnRowCount++;
    // (c7) title metadata: meaningful words, group key, whole-series flag, notes
    const T = doc.fw[F_T], TW = T.W, S = x => T.st.a[x.s], E = x => T.st.b[x.e - 1];
    const markers = seriesMarkers(TW), used = new Set(), items = [];
    const bookVals = new Set(TW.pairs.filter(p => p.key === 'book' && !p.rng).map(p => p.v)), anyRange = TW.pairs.some(p => p.rng);
    doc.series = markers.size > 0 && !(bookVals.size === 1 && !anyRange);
    TW.forEach((x, i) => {                                                                // edition statements: "2nd edition", "60th anniversary"
      if (x.num !== null && TW[i + 1] && EDITION_WORDS.has(TW[i + 1].w)) { used.add(i); used.add(i + 1); }
    });
    for (const p of TW.pairs) {
      for (let k = p.a; k <= p.b; k++) used.add(k);
      if (p.key !== 'edition') items.push({ keys: p.terms, wis: range(p.a, p.b) });
    }
    for (const run of TW.runs) {
      if (range(run.i, run.j).some(k => used.has(k))) continue;
      for (let k = run.i; k <= run.j; k++) used.add(k);
      items.push({ keys: run.vals, wis: range(run.i, run.j) });
    }
    TW.forEach((x, i) => {
      if (!used.has(i) && !SMALL.has(x.w) && !FORMAT.has(x.w) && !markers.has(i)) items.push({ keys: [x.num !== null ? x.num : x.w], wis: [i] });
    });
    doc.items = items;
    doc.allSmall = TW.length > 0 && TW.every(x => SMALL.has(x.w));
    const gtk = TW.filter(x => !SMALL.has(x.w)).map(x => x.w).join(' ') || TW.map(x => x.w).join(' ');
    doc.gtk = gtk;
    if (gtk) { if (!ix.titleKeyRows.has(gtk)) ix.titleKeyRows.set(gtk, []); ix.titleKeyRows.get(gtk).push(r); }
    for (const p of TW.pairs) {
      const label = p.li >= 0 ? T.text.slice(S(TW[p.li]), E(TW[p.li])) : '';
      if (p.rng && !p.rng.list) {                                                        // a list names its volumes itself
        const L = label ? label[0].toUpperCase() + label.slice(1) : 'Books';
        doc.notes.push(`Covers ${L} ${p.rng.k ? 'K' : p.rng.n}\u2013${p.rng.m}`);
      }
    }
    if (bookVals.size === 1 && !anyRange && !doc.series) {                                // (g2) single-volume note, in the title's own
      const p = TW.pairs.find(q => q.key === 'book'), lw = p.li >= 0 ? TW[p.li].w : '';  //      label ("Symphony No. 9" -> "No. 9")
      const L = /^vol(?:ume)?s?$/.test(lw) ? 'Volume' : /^(?:no|nos|num|number)$/.test(lw) ? 'No.' : 'Book';
      doc.notes.push(`This listing names ${L} ${p.v} only.`);
    }
    if (doc.series) doc.notes.push('Covers a whole series');
    // author metadata: sorted key, author words (3+ letters), surnames
    const A = doc.fw[F_A], AW = A ? A.W : [];
    doc.authorless = !AW.some(x => !x.skip);
    const aw = AW.filter(x => !x.skip && !ROLE.has(x.w));
    doc.authorKey = aw.map(x => x.w).sort().join(' ');
    doc.authorWordIdx = new Set();
    AW.forEach((x, i) => {
      if (!x.skip && !x.initials && x.w.length >= 3 && HAS_L.test(x.w) && !ROLE.has(x.w) && !PUBLISHER.has(x.w) && !FORMAT.has(x.w) && !SMALL.has(x.w)) doc.authorWordIdx.add(i);
    });
    // group key (f3): title words with numbers as values, so "Seven Habits…" groups with "7 Habits…"
    const canon = [];
    for (let i = 0; i < TW.length; i++) {
      const x = TW[i];
      if (x.run && x.run.i === i) { canon.push(x.run.vals[0]); i = x.run.j; }
      else if (!SMALL.has(x.w)) canon.push(x.num !== null ? x.num : x.roman ? String(x.roman) : x.w);
    }
    // the people in the cell (word indices), split like surnamesOf; and the surname words (e3 initials, e5d series lift)
    doc.persons = [];
    let cur = [];
    const people = [];
    AW.forEach((x, i) => {
      if (x.skip) return;
      if (x.w === 'and') { if (cur.length) people.push(cur); cur = []; return; }
      if (/[;\/]/.test(x.brk) && cur.length) { people.push(cur); cur = []; }
      cur.push(i);
    });
    if (cur.length) people.push(cur);
    for (const g of people) {
      const parts = [[]];
      for (const i of g) { if (parts[parts.length - 1].length && AW[i].brk.includes(',')) parts.push([]); parts[parts.length - 1].push(i); }
      const full = p => p.filter(i => !AW[i].initials && AW[i].w.length >= 2 && !ROLE.has(AW[i].w)).length >= 2;
      if (parts.length > 1 && parts.every(full)) doc.persons.push(...parts); else doc.persons.push(g);
    }
    const surnames = doc.authorless ? [] : surnamesOf(author), sns = new Set(surnames.map(bare));
    doc.surnameIdx = new Set();
    AW.forEach((x, i) => { if (!x.skip && sns.has(x.w)) doc.surnameIdx.add(i); });
    doc.groupKey = (canon.join(' ') || gtk || '\u0000' + r) + '|' + doc.authorKey;
    if (!ix.groupRows.has(doc.groupKey)) ix.groupRows.set(doc.groupKey, []);
    ix.groupRows.get(doc.groupKey).push(r);
    if (!doc.authorless) {
      const shown = author.trim().replace(/[\s,]*(?:et\.?\s*al\.?|(?:and|&)\s+others)\s*$/i, '').trim();
      for (const sn of surnames) {
        const k = bare(sn);
        if (!k) continue;
        if (!ix.surnames.has(k)) ix.surnames.set(k, []);
        ix.surnames.get(k).push({ r, authorKey: doc.authorKey, author: shown, surname: sn });
      }
    }
    const y = /^\s*(\d{4})\s*[-\/\u2013\u2014]\s*(\d{2}|\d{4})\s*$/.exec(String(row.year ?? ''));
    doc.year = y ? { start: +y[1], end: y[2].length === 2 ? Math.floor(+y[1] / 100) * 100 + +y[2] : +y[2] } : null;
  }
  const range = (a, b) => { const o = []; for (let k = a; k <= b; k++) o.push(k); return o; };

  // (c9) aliases.json: { aliases: [{ kind, names: [...] }] }; each name's key = its non-SMALL words, initials merged.
  function parseAliases(obj) {
    const groups = [];
    for (const g of obj && Array.isArray(obj.aliases) ? obj.aliases : []) {
      const names = (g && Array.isArray(g.names) ? g.names : []).filter(n => typeof n === 'string' && n.trim())
        .map(n => ({ text: n.trim(), key: analyze(fold(n)).filter(x => !SMALL.has(x.w)).map(x => x.w) })).filter(n => n.key.length);
      if (names.length >= 2) groups.push(names);
    }
    return groups;
  }

  function buildIndex(rows, opts = {}) {
    const ix = { rows: Array.isArray(rows) ? rows : [], docs: [], terms: new Map(), sorted: null, fuzzy: [], isbnKeys: new Map(),
      isbnForms: [], titleKeyRows: new Map(), groupRows: new Map(), pairKeyRows: new Map(), surnames: new Map(), spell: new Map(), hasEtAl: false,
      rowCount: 0, isbnRowCount: 0, aliases: parseAliases(opts && opts.aliases) };
    const fuzzy = new Set();
    ix.rows.forEach((row, r) => indexRow(ix, row || {}, r, fuzzy));
    ix.sorted = [...ix.terms.keys()].filter(t => t[0] !== '#').sort();                      // prefix list (no pair terms, no ISBNs)
    for (const t of fuzzy) (ix.fuzzy[t.length] || (ix.fuzzy[t.length] = [])).push(t);      // (c6) fuzzy vocabulary by length
    ix.isbnForms.sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : a.r - b.r));
    ix.rowCount = ix.rows.length;
    return ix;
  }

  // ---------- (b12) query-only alternates: plural/singular, British/American, abbreviations ----------
  const IRREGULAR = table({ woman: 'women', man: 'men', child: 'children', mouse: 'mice', person: 'people', foot: 'feet', tooth: 'teeth', goose: 'geese' });
  const BRIT = table({ pyjamas: 'pajamas', pyjama: 'pajama', grey: 'gray', mum: 'mom', mummy: 'mommy', aeroplane: 'airplane', programme: 'program',
    catalogue: 'catalog', dialogue: 'dialog', jewellery: 'jewelry', defence: 'defense', licence: 'license', plough: 'plow', tyre: 'tire',
    moustache: 'mustache', mould: 'mold', sceptic: 'skeptic', aluminium: 'aluminum', cosy: 'cozy', travelled: 'traveled', traveller: 'traveler' });
  const ABBR = table({ mr: 'mister', dr: 'doctor', st: 'saint', mt: 'mount' });
  const twoWay = o => { for (const [a, b] of Object.entries(o)) o[b] = a; return o; };
  twoWay(IRREGULAR); twoWay(BRIT); twoWay(ABBR);
  function pluralForms(w) {                                                                // SPV-4 (Title and Memo only), FIX F13
    const out = IRREGULAR[w] ? [IRREGULAR[w]] : [];
    if (w.length < 4) return out;
    if (/ies$/.test(w)) out.push(w.slice(0, -3) + 'y', w.slice(0, -1));
    else if (/ves$/.test(w)) out.push(w.slice(0, -3) + 'f', w.slice(0, -3) + 'fe', w.slice(0, -1));
    else if (/(?:s|x|z|ch|sh)es$/.test(w)) out.push(w.slice(0, -2));
    else if (/s$/.test(w) && !/(?:ss|us|is)$/.test(w)) out.push(w.slice(0, -1));
    if (/[^aeiou]oes$/.test(w) && w.length >= 6) out.push(w.slice(0, -2));                   // heroes -> hero, tomatoes -> tomato
    if (/[^aeiou]y$/.test(w)) out.push(w.slice(0, -1) + 'ies');
    else if (/fe$/.test(w)) out.push(w.slice(0, -2) + 'ves');
    else if (/f$/.test(w)) out.push(w.slice(0, -1) + 'ves');
    else if (/(?:s|x|z|ch|sh)$/.test(w)) out.push(w + 'es');
    else out.push(w + 's');
    if (/[^aeiou]o$/.test(w)) out.push(w + 'es');                                            // hero -> heroes, echo -> echoes
    return out;
  }
  function britAm(w) {                                                                     // SPV-5
    const out = BRIT[w] ? [BRIT[w]] : [];
    let m;
    if (w.length >= 5 && !/oor/.test(w)) {
      if ((m = /^(.+)our(s|ed|ite|ites)?$/.exec(w))) out.push(m[1] + 'or' + (m[2] || ''));
      else if ((m = /^(.+)or(s|ed|ite|ites)?$/.exec(w))) out.push(m[1] + 'our' + (m[2] || ''));
    }
    if (w.length >= 6) {
      if ((m = /^(.+)is(e|ed|es|ing|ation|ations|er|ers)$/.exec(w))) out.push(m[1] + 'iz' + m[2]);
      else if ((m = /^(.+)iz(e|ed|es|ing|ation|ations|er|ers)$/.exec(w))) out.push(m[1] + 'is' + m[2]);
    }
    if (w.length >= 5) {
      if ((m = /^(.+)tre(s?)$/.exec(w))) out.push(m[1] + 'ter' + m[2]);
      else if ((m = /^(.+)ter(s?)$/.exec(w))) out.push(m[1] + 'tre' + m[2]);
    }
    return out;
  }

  // ---------- (d) query parsing ----------
  const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
  const REMOVED_SPANS = [                                                                   // (d5) dates, star ratings, role tags
    new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'g'),
    new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+\\d{4}\\b`, 'g'),
    new RegExp(`\\b(?:${MONTHS})\\.?,?\\s+\\d{4}\\b`, 'g'),
    /\b\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})\b/g, /\b\d{4}-\d{1,2}-\d{1,2}\b/g, /\(\s*\d{4}\s*\)/g,
    /\b\d(?:\.\d)?\s+out\s+of\s+5\s+stars?\b/g, /\b\d\.\d\s*\/\s*5\b/g, /\b\d(?:\.\d)?\s+stars?\b/g,
    /\(\s*\d+\s+ratings?\s*\)/g, /\b\d+\s+(?:ratings?|reviews?)\b/g, /\bavg\.?\s+rating\s+\d(?:\.\d+)?\b/g,
    /\((?:goodreads\s+)?(?:author|illustrator|editor|translator|narrator|foreword|introduction|contributor)s?\)/g,
    /(?<=,\s*)(?:1[5-9]|20)\d\d\s*-(?!\s*\d)/g,                                                // a catalogue heading's open life dates: "Stine, R. L., 1943-"
  ];
  const ISBN_LABEL = /\bisbn(?:[\s-]*1[03])?\s*[:#]?/g;
  const ALL_F = 63, TAM = 7, TM = 5, CONTENT_F = 15;                                        // field masks (bit = 1 << field)
  const isYearTok = t => /^(?:19|20)\d\d$/.test(t);
  const isYearWord = x => !!x && x.digits && isYearTok(x.w) && !x.pair;
  const isShortWord = x => !SMALL.has(x.w) && !x.pair && (!!x.initials || (/^[a-z]$/.test(x.w) && x.w !== 'a') ||
    (/^[b-df-hj-np-tv-xz]{2,3}$/.test(x.w) && !FORMAT.has(x.w) && !ROLE.has(x.w)));        // SEO-3 (y counts as a vowel)

  // Pulls ISBNs out of the folded query (d7). Returns the text with ISBN spans blanked (\u0001 marks a removed span).
  function extractIsbns(q, Q) {
    const lab = q.replace(/[\p{Pd}\u2212]/gu, '-').replace(ISBN_LABEL, m => '\u0002' + ' '.repeat(m.length - 1));   // every dash is a hyphen
    const rest = lab.replace(/[\u0001\u0002]/g, ' ').trim();
    const nDigits = (rest.match(/\d/g) || []).length, joined = rest.replace(/[\s-]/g, '');
    // the whole query is one ISBN (or its start): one group, or groups after a label, starting 978/979, or making a complete
    // ISBN without a year; never more than 13 characters (two ISBNs, an ISBN and a year range, "101 451" go to the mixed path)
    if (/^[\d\s-]+x?$/.test(rest) && nDigits >= 6 && joined.length <= 13 && !/^(?:19|20)\d\d\s*(?:[-\/]\s*(?:\d{0,3}|(?:19|20)\d\d)|\s(?:19|20)\d\d)$/.test(rest)) {
      const groups = rest.split(/\s+/);
      if (groups.length === 1 || lab.includes('\u0002') || /^97[89]/.test(groups[0]) || (completeIsbn(joined) && !rest.split(/[\s-]+/).some(isYearTok))) {
        Q.isbnQuery = true;
        Q.digits = joined;
        if (completeIsbn(Q.digits)) Q.isbn.push({ kind: 'isbn', key: isbnKey(Q.digits), d: Q.digits, text: Q.digits });
        else if (/^\d{9}$/.test(Q.digits)) Q.isbn.push({ kind: 'isbn', key: isbnKey('0' + Q.digits), d: '0' + Q.digits, text: Q.digits });   // lost leading 0
        return '';
      }
    }
    const toks = [], re = /\S+/g;
    let m;
    while ((m = re.exec(lab))) toks.push({ t: m[0].replace(/^[(\[]+|[.,;:)\]]+$/g, ''), s: m.index, e: m.index + m[0].length });
    const spans = [];
    const add = (d, i, j) => {
      spans.push([toks[i].s, toks[j].e]);
      const u = { kind: 'isbn', key: completeIsbn(d) ? isbnKey(d) : null, d, text: d };
      if (u.key) Q.hasCompleteIsbn = true;
      Q.isbn.push(u);
    };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i].t;
      if (t[0] === '\u0002') {                                                               // after a label: up to 13 digits (or 10 with X)
        let j = i + 1, d = '';
        while (j < toks.length && /^[\d-]*\d[\d-]*x?$/.test(toks[j].t) && !/x/.test(d) && (d + toks[j].t.replace(/-/g, '')).replace(/x$/, '').length <= 13) d += toks[j++].t.replace(/-/g, '');
        if (d) { add(d, i, j - 1); i = j - 1; }
        continue;
      }
      let d = null;
      if (/^\d+-\d+-\d+-[\dx]$/.test(t) || /^\d+-\d+-\d+-\d+-\d$/.test(t)) {               // hyphenated ISBN shape
        const j = t.replace(/-/g, ''), n = t.split('-').length;
        if ((n === 4 && /^\d{9}[\dx]$/.test(j)) || (n === 5 && /^97[89]\d{10}$/.test(j))) d = j;
      } else if (/^97[89][\d-]*\d$/.test(t) && /^97[89]\d{10}$/.test(t.replace(/-/g, ''))) d = t.replace(/-/g, '');   // 978-0306406157
      else if (completeIsbn(t)) d = t;                                                      // unbroken 10-char or 978/979 13-digit token
      if (d) { add(d, i, i); continue; }
      if (/^97[89]\d*$/.test(t)) {                                                           // spaced groups starting 978/979, exactly 13 digits
        let j = i, s = '';
        while (j < toks.length && /^\d+$/.test(toks[j].t) && !(j > i && isYearTok(toks[j].t)) && (s + toks[j].t).length <= 13) s += toks[j++].t;
        if (s.length === 13 && j - 1 > i) { add(s, i, j - 1); i = j - 1; }
      }
    }
    let out = lab;
    for (const [s, e] of spans) out = out.slice(0, s) + ' \u0001' + ' '.repeat(Math.max(0, e - s - 2)) + out.slice(e);
    return out.replace(/\u0002/g, '\u0001');
  }

  // parseQuery -> Q: the query's words (W) and units. A unit is one thing the query asks for: a word, a number run, a label
  // pair or range, a year range, an ISBN or "et al"; it is required or optional (d8, d9).
  function parseQuery(text, unfinishedIn) {
    const moved = moveArticle(text);                                                         // (d3) "7th Knot, The" ≡ "The 7th Knot"
    const folded = fold(moved === null ? text : moved);
    let q = folded;
    for (const re of REMOVED_SPANS) q = q.replace(re, ' \u0001 ');
    if (!/[\p{L}\p{N}]/u.test(q)) q = folded;                                               // never remove everything
    const Q = { folded, units: [], req: [], fmt: [], isbn: [], years: [], etal: null, chunks: [], joins: [], tails: [], isbnQuery: false,
      digits: '', hasCompleteIsbn: false, state: 'ok', stopKey: null, W: [] };
    const t2 = extractIsbns(q, Q);
    Q.text = t2;
    const unit = (kind, a, b, extra) => {
      const u = Object.assign({ kind, a, b, text: t2.slice(W[a].s, W[b].e), map: null, req: false, soft: false, format: false, small: false,
        short: false, prefix: false, fuzzy: false }, extra);
      for (let k = a; k <= b; k++) W[k].unit = u;
      Q.units.push(u);
      return u;
    };
    if (Q.isbnQuery) {                                                                     // ISBN query: one exact whole-word unit + the key
      Q.W = [];
      Q.units.push({ kind: 'word', text: Q.digits, w: Q.digits, forms: [[Q.digits, K_EXACT, 0, TAM]], req: true, a: -1, b: -1 });
      Q.req = Q.units.slice();
      return Q;
    }
    const W = Q.W = analyze(t2);
    const last = W.length - 1;
    // the last word is still being typed unless a moved article was the last word ("7th Knot, The"; not "Alchemist, The: A Fab")
    const lastWord = t => { const m = fold(t).match(/[\p{L}\p{N}']+(?=[^\p{L}\p{N}']*$)/u); return m ? m[0] : ''; };
    const lastIdx = unfinishedIn && (moved === null || lastWord(moved) === lastWord(text)) && last >= 0 && !t2.slice(W[last].e).includes('\u0001') ? last : -1;
    // (d6) year ranges: 2023-2024, 2023/24, 2023 to 2024, "2008 2009" -> one optional unit (a lone 1984 stays a word)
    for (let i = 0; i < W.length; i++) {
      const a = W[i], b = W[i + 1];
      if (!isYearWord(a) || a.unit || !b) continue;
      let end = -1, j = i + 1;
      if (DASH_SP.test(b.brk) || /^\s*\/\s*$/.test(b.brk)) end = isYearWord(b) ? +b.w : b.digits && b.w.length === 2 ? Math.floor(+a.w / 100) * 100 + +b.w : -1;
      else if (b.w === 'to' && isYearWord(W[i + 2])) { end = +W[i + 2].w; j = i + 2; }
      else if (b.brk === ' ' && isYearWord(b) && +b.w === +a.w + 1) end = +b.w;
      if (end >= +a.w) { Q.years.push(unit('year', i, j, { start: +a.w, end })); i = j; }
      else if (unfinishedIn && i + 1 === last && b.digits && b.w.length <= 3 && (DASH_SP.test(b.brk) || /^\s*\/\s*$/.test(b.brk))) {
        Q.years.push(unit('year', i, i + 1, { start: +a.w, end: null }));                  // "2023-202": a range still being typed
        i++;
      }
    }
    const tail = W.length ? t2.slice(W[last].e) : '';                                      // "orwell 2023-": the same, before its end year
    if (unfinishedIn && isYearWord(W[last]) && !W[last].unit && /^\s*[\/\p{Pd}\u2212]\s*$/u.test(tail)) Q.years.push(unit('year', last, last, { start: +W[last].w, end: null }));
    // "et al" and a trailing "and others": one optional unit
    for (let i = 0; i + 1 < W.length; i++) if (W[i].w === 'et' && W[i + 1].w === 'al' && !W[i].unit) Q.etal = unit('etal', i, i + 1);
    if (W.length >= 2 && W[last - 1].w === 'and' && W[last].w === 'others' && !W[last].unit) Q.etal = unit('etal', last - 1, last);
    for (const p of W.pairs) {                                                             // label pairs and ranges: one unit each
      if (W[p.a].unit || W[p.b].unit) continue;
      const terms = [];
      if (p.rng && !p.rng.list) for (let k = p.rng.n; k <= Math.min(p.rng.m, p.rng.n + 200); k++) terms.push('#' + p.key + k);
      const u = unit('pair', p.a, p.b, { p, key: p.key, v: p.v, terms: p.rng && !p.rng.list ? terms : p.terms, soft: p.key === 'edition', format: p.key === 'edition' });
      if (p.li < 0) u.text = '#' + u.text;                                                  // "#3" (the reason reads "#3 = Book 3")
    }
    for (const run of W.runs) if (!W[run.i].unit && !W[run.j].unit) unit('run', run.i, run.j, { run, last: run.j === lastIdx });
    W.forEach((x, i) => {                                                                   // edition statements are soft: "25th anniversary"
      if (x.num !== null && !x.unit && W[i + 1] && EDITION_WORDS.has(W[i + 1].w) && !W[i + 1].unit) { x.edition = true; W[i + 1].edition = true; }
    });
    W.forEach((x, i) => {
      if (x.unit) return;
      const u = unit('word', i, i, { w: x.w, x });
      // a lone "n" between two words is the "and" of rock 'n' roll typed without apostrophes (fold reads 'n' as "and")
      u.small = SMALL.has(x.w) || (x.w === 'n' && !x.initials && i > 0 && i < last && W[i - 1].w.length > 1 && W[i + 1].w.length > 1);
      u.soft = !u.small && (FORMAT.has(x.w) || QUESTION.has(x.w) || ROLE.has(x.w) || PUBLISHER.has(x.w) || !!x.edition ||
        (ASKING.has(x.w) && W.some(y => QUESTION.has(y.w))) ||
        (/^years?$/.test(x.w) && !!W[i + 1] && !!W[i + 1].unit && W[i + 1].unit.kind === 'year'));       // "banned year 2023/24"
      u.format = FORMAT.has(x.w) || !!x.edition;
      u.short = isShortWord(x);
      u.partialIsbn = x.digits && x.w.length >= 9;
      u.forms = [[x.w, K_EXACT, 0, ALL_F]].concat(x.alts.map(a => [a[0], a[1], a[2], ALL_F]));
      if (x.letters && !x.initials && !isNumWord(x.nw) && !MISSPELL[x.w]) {
        for (const t of pluralForms(x.w)) u.forms.push([t, K_ALT, 0, TM]);
        for (const t of britAm(x.w)) u.forms.push([t, K_ALT, 1, TAM]);
        if (ABBR[x.w]) u.forms.push([ABBR[x.w], K_ALT, 1, TAM]);
      }
    });
    // (d9) required vs optional; (d10) stopwords only; (d11) promotion
    for (const u of Q.units) u.req = (u.kind === 'word' && !u.small && !u.soft && !u.partialIsbn) || u.kind === 'run' || (u.kind === 'pair' && !u.soft);
    if (W.length && W.every(x => SMALL.has(x.w)) && !Q.isbn.length) { Q.state = 'stop'; Q.stopKey = W.map(x => x.w).join(' '); return Q; }
    if (!Q.units.some(u => u.req)) for (const u of Q.units) if (u.soft) u.req = true;        // FIX F5: only soft words -> they are required
    if (!Q.units.some(u => u.req) && !Q.hasCompleteIsbn) { Q.state = 'stopwordsOnly'; return Q; }
    for (const u of Q.units) {
      if (u.kind !== 'word' || !u.req) continue;
      const x = u.x;
      u.prefix = u.a === lastIdx && x.w.length >= 3 && !SMALL.has(x.w);                     // (e1) unfinished last word, 3+ characters
      u.fuzzy = x.letters && !x.initials && !SMALL.has(x.w) && !isNumWord(x.nw) && !MISSPELL[x.w] && !u.short;
      u.last = u.a === lastIdx;
      if (u.prefix && x.letters && !x.initials && !isNumWord(x.nw) && !MISSPELL[x.w]) {    // (e1) and the forms of the number words and
        const pf = new Set();                                                                //      abbreviations it starts: sevent -> 7th, 7
        for (const c of numCompletions(x.w, false)) for (const t of numForms(c)) pf.add(t);
        for (const T of [ABBR, BRIT]) for (const k in T) if (k.length > x.w.length && k.startsWith(x.w)) pf.add(T[k]);
        if (pf.size) u.pforms = [...pf];
      }
    }
    // (e1, b8) number words before the word being typed: read them with each completion of it ("nineteen eig" -> 1918, 1980-1989;
    // "twenty thousan" -> 20000; "four fif" -> 415, 450-459). The values satisfy every unit of those words.
    const L = lastIdx > 0 ? W[lastIdx] : null;
    const cs = L && L.letters && !L.initials && L.w.length >= 3 ? numCompletions(L.nw, true) : [];
    if (cs.length) {
      const tok = x => (x.digits ? x.num : x.nw);
      let k = lastIdx;
      while (k > 0 && lastIdx - k < 3 && (W[k].brk === ' ' || DASH1.test(W[k].brk)) && !W[k - 1].initials &&
        (isNumWord(W[k - 1].nw) || (W[k - 1].digits && W[k - 1].w.length <= 3))) k--;
      for (let s = k; s < lastIdx; s++) {
        const prev = W.slice(s, lastIdx).map(tok), vals = new Set();
        const read = ts => { const r = readRun(ts); if (r) for (const v of r.vals) { vals.add(v); if (r.ord) vals.add(v + 'th'); } };
        for (const c of cs) {
          read(prev.concat(c));
          if (TENS[c] !== undefined) for (const n of ONE_TO_NINE) read(prev.concat(c, n));           // eighty -> eighty-one…
        }
        if (!vals.size) continue;
        const units = [...new Set(W.slice(s, lastIdx + 1).map(x => x.unit))].filter(v => v && (v.kind === 'word' || v.kind === 'run') && v.req);
        if (units.length) Q.tails.push({ units, forms: [...vals] });
        break;
      }
    }
    Q.req = Q.units.filter(u => u.req);
    Q.fmt = Q.units.filter(u => u.format && !u.req);
    for (const c of W.chunks) {                                                            // (e2) a chunk's joined form satisfies all its parts
      const whole = c.joins.find(j => j.a === c.a && j.b === c.b);
      const parts = W.slice(c.a, c.b + 1).map(x => x.unit).filter(u => u && u.kind === 'word');
      if (whole && parts.length >= 2) Q.chunks.push({ t: whole.t, units: parts });
    }
    for (let i = 0; i + 1 < W.length; i++) {                                               // (e1 ii) adjacent query words tried joined
      const u1 = W[i].unit, u2 = W[i + 1].unit;
      if (u1 !== u2 && u1.kind === 'word' && u2.kind === 'word' && HAS_L.test(u1.w) && HAS_L.test(u2.w) && (u1.req || u2.req)) Q.joins.push({ u1, u2, t: u1.w + u2.w });
    }
    // (d12) foreign article: "les miserables" is also searched as "miserables"
    if (W.length >= 2 && FOREIGN_ART.has(W[0].w) && W.slice(1).some(x => !SMALL.has(x.w))) Q.foreign = { word: W[0].w, text: t2.slice(W[0].e).replace(/\u0001/g, ' ') };
    return Q;
  }

  // ---------- (e) matching: per unit, per row, the best CONTENT hit (c) and the best META hit (m) ----------
  function addHit(map, h) {
    let E = map.get(h.r);
    if (!E) map.set(h.r, (E = { c: null, m: null, hits: [] }));
    E.hits.push(h);
    if (h.f >= F_Y) { if (!E.m || hitValue(h) > hitValue(E.m)) E.m = h; }
    else if (!E.c || hitValue(h) > hitValue(E.c)) E.c = h;
  }
  const combine = (qk, pk) => (pk === K_COMP ? K_COMP : qk === K_EXACT && pk === K_EXACT ? K_EXACT : qk === K_ALTX || pk === K_ALTX ? K_ALTX : K_ALT);
  const mkHit = (p, k, why, q, n) => ({ r: p.r, f: p.f, k, s: p.s, e: p.e, wi: p.wi, wj: p.wj, why, q, n: n || 0 });
  // exact / alternate lookups: forms are [term, kind, explain?, field mask]
  function lookupForms(ix, u, forms, map, only, noCompound) {
    for (const [t, qk, qx, mask] of forms) {
      const ps = ix.terms.get(t);
      if (ps) for (const p of ps) {
        if ((only && !only.has(p.r)) || !(mask & (1 << p.f)) || (noCompound && p.k === K_COMP)) continue;
        const k = combine(qk, p.k);
        addHit(map, mkHit(p, k, k === K_COMP ? 'c2' : k !== K_EXACT && (qx || p.x) ? 'eq' : '', u.text));
      }
    }
  }
  // prefix: the unfinished last word (e1); an all-digit prefix only reaches Title/Author/Memo numbers (FIX F3)
  function lookupPrefix(ix, u, w, map, only) {
    const S = ix.sorted, digits = ONLY_D.test(w);
    let lo = 0, hi = S.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (S[mid] < w) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < S.length && S[i].startsWith(w); i++) {
      if (S[i] === w || (digits && !ONLY_D.test(S[i]))) continue;
      for (const p of ix.terms.get(S[i])) {
        if ((only && !only.has(p.r)) || p.f === F_I || (digits && p.f >= F_Y) || (p.k === K_COMP && w.length <= p.x)) continue;
        addHit(map, p.k === K_COMP ? mkHit(p, K_COMP, 'c2', u.text) : mkHit(p, K_PREFIX, '', u.text, p.k === K_EXACT ? w.length : 0));
      }
    }
  }
  // Bounded OSA distance (an adjacent swap is one edit). It returns k + 1 as soon as k is exceeded and the caller compares
  // with the same k (the prototype compared a capped bound with a larger k: "anonymous" reached "International").
  let B0 = new Int32Array(64), B1 = new Int32Array(64), B2 = new Int32Array(64);
  function osa(a, b, k, prefixMode) {
    const n = a.length, m = prefixMode ? Math.min(b.length, n + 1) : b.length;
    if (!prefixMode && Math.abs(n - m) > k) return k + 1;
    if (m + 1 > B0.length) { B0 = new Int32Array(m + 1); B1 = new Int32Array(m + 1); B2 = new Int32Array(m + 1); }
    let pp = B0, p = B1, c = B2;
    for (let j = 0; j <= m; j++) p[j] = j;
    for (let i = 1; i <= n; i++) {
      c[0] = i;
      let rowMin = i;
      const ai = a.charCodeAt(i - 1), ap = i > 1 ? a.charCodeAt(i - 2) : -1;
      for (let j = 1; j <= m; j++) {
        const bj = b.charCodeAt(j - 1);
        let v = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (ai === bj ? 0 : 1));
        if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && ap === bj && pp[j - 2] + 1 < v) v = pp[j - 2] + 1;
        c[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > k) return k + 1;
      const t = pp; pp = p; p = c; c = t;
    }
    if (!prefixMode) return p[m];
    let best = k + 1;                                          // prefix mode: closest prefix of b of length n-1 .. n+1
    for (let j = Math.max(0, n - 1); j <= m; j++) if (p[j] < best) best = p[j];
    return best;
  }
  const budget = n => (n <= 3 ? 0 : n <= 7 ? 1 : 2);                                        // FIX F17, SPV-1: by the shorter word
  function lookupFuzzy(ix, u, map, only) {
    const w = u.w, n = w.length, c0 = w.charCodeAt(0), c1 = w.charCodeAt(1);
    const take = (t, d) => {
      for (const p of ix.terms.get(t)) if (!(only && !only.has(p.r)) && p.f <= F_M && p.k !== K_COMP) addHit(map, mkHit(p, d === 1 ? K_FZ1 : K_FZ2, 'fz', u.text));
    };
    for (let L = Math.max(1, n - 2); L <= n + 2; L++) {
      const k = budget(Math.min(n, L));
      if (!k || Math.abs(L - n) > k || !ix.fuzzy[L]) continue;
      for (const t of ix.fuzzy[L]) {
        if (t.charCodeAt(0) !== c0 && t.charCodeAt(1) !== c1) continue;                    // the first or second letter must agree
        const d = osa(w, t, k, false);
        if (d >= 1 && d <= k) take(t, d);
      }
    }
    if (u.last && n >= 4) {                                                                 // the word being typed: 1 edit from a longer word's start
      for (let L = n + 1; L < ix.fuzzy.length; L++) for (const t of ix.fuzzy[L] || []) {
        if ((t.charCodeAt(0) === c0 || t.charCodeAt(1) === c1) && osa(w, t, 1, true) === 1) take(t, 1);
      }
    }
  }
  // Rows present in every map, with each map's best content hit (kind forced when given).
  function allOf(maps, kind) {
    const out = new Map();
    for (const [r, E] of maps[0]) {
      if (!E.c || maps.some(m => !(m.get(r) && m.get(r).c))) continue;
      for (const m of maps) { const h = m.get(r).c; addHit(out, kind === undefined ? h : Object.assign({}, h, { k: kind })); }
    }
    return out;
  }
  const mergeInto = (dst, src) => { for (const E of src.values()) for (const h of E.hits) addHit(dst, h); };
  function literal(ix, u, x, prefix, only) {
    const m = new Map();
    lookupForms(ix, u, [[x.w, K_EXACT, 0, ALL_F]], m, only, true);
    if (prefix && x.w.length >= 3) lookupPrefix(ix, u, x.w, m, only);
    return m;
  }
  // (b8) a number run is one unit: its value, both groups of a two-group reading, or all its words literally
  function lookupRun(ix, Q, u, map, only) {
    const run = u.run, W = Q.W;
    const forms = run.ord ? [[run.vals[0] + 'th', K_ALT, 1, ALL_F], [run.vals[0], K_ALTX, 1, ALL_F]] : run.vals.map(v => [v, K_ALT, 1, ALL_F]);
    lookupForms(ix, u, forms, map, only, true);
    if (run.two) {
      const sp = run.i + run.two.split;
      const group = (a, b, v) => {
        const m = new Map();
        lookupForms(ix, u, [[String(v), K_ALT, 1, ALL_F]], m, only, true);
        mergeInto(m, allOf(range(a, b).map(k => literal(ix, u, W[k], false, only))));
        return m;
      };
      const two = allOf([group(run.i, sp - 1, run.two.A), group(sp, run.j, run.two.B)], K_ALT);
      for (const E of two.values()) for (const h of E.hits) if (h.why === 'eq') h.why = 'eq2';   // explained with both cell numbers (g1)
      mergeInto(map, two);
    }
    mergeInto(map, allOf(range(run.i, run.j).map(k => literal(ix, u, W[k], u.last && k === run.j, only))));
    if (u.last) {                                    // (e1) the run's last word is the start of a longer word: "sixty second" -> 60 + Seconds
      const hw = range(run.i, run.j - 1).map(k => W[k]);
      const head = hw.length > 1 ? readRun(hw.map(x => (x.digits ? x.num : x.nw))) : hw[0].num !== null && !hw[0].ord ? { vals: [hw[0].num] } : null;
      if (head && !head.ord) {
        const hm = new Map(), q = Q.text.slice(hw[0].s, hw[hw.length - 1].e);
        lookupForms(ix, u, head.vals.map(v => [v, K_ALT, 1, ALL_F]), hm, only, true);
        for (const E of hm.values()) for (const h of E.hits) h.q = q;
        const pm = new Map();
        lookupPrefix(ix, u, W[run.j].w, pm, only);
        mergeInto(map, allOf([hm, pm]));
      }
    }
  }
  // (b6, e5e d) label pairs: the pair term; a label word and the number unpaired in the row; else "loose" (same label, other number)
  function lookupPair(ix, u, map, only) {
    for (const t of u.terms) for (const p of ix.terms.get(t) || []) {
      if (!(only && !only.has(p.r)) && p.f <= F_M) addHit(map, mkHit(p, p.k === K_EXACT ? K_EXACT : K_ALT, 'pair', u.text));
    }
    if (!u.p.rng) {
      for (const p of ix.terms.get(String(u.v)) || []) {
        if ((only && !only.has(p.r)) || p.f > F_M || map.has(p.r)) continue;
        const doc = ix.docs[p.r];
        if (!p.p && doc.unpairedLabels.has(u.key)) addHit(map, mkHit(p, K_ALT, '', u.text));     // "World Book … 2001"
        else if (doc.labelKeys.has(u.key)) addHit(map, mkHit(p, K_LOOSE, '', u.text));          // "Activity Book – Grade 5"
      }
    }
    const vals = u.p.rng ? null : new Set([u.v]);
    for (const r of ix.pairKeyRows.get(u.key) || []) {
      if ((only && !only.has(r)) || (map.get(r) && map.get(r).c)) continue;
      for (const dp of ix.docs[r].pairs) if (dp.key === u.key && (!vals || !vals.has(dp.v) || dp.rng)) addHit(map, { r, f: dp.f, k: K_LOOSE, s: dp.s, e: dp.e, wi: dp.wi, wj: dp.wj, why: 'lo', q: u.text, n: 0 });
    }
  }
  // the completions of the word being typed (u.pforms, e1): prefix hits on the number or abbreviation the word starts
  function lookupCompletions(ix, u, map, only) {
    for (const t of u.pforms) for (const p of ix.terms.get(t) || []) {
      if ((only && !only.has(p.r)) || p.f > F_M || p.k === K_COMP) continue;
      addHit(map, mkHit(p, K_PREFIX, '', u.text, 0));
    }
  }
  function lookupUnit(ix, Q, u, only, map) {
    map = map || new Map();
    if (u.kind === 'word') {
      lookupForms(ix, u, u.forms, map, only, !u.req);                                       // optional words: exact / alternate only
      if (u.prefix) lookupPrefix(ix, u, u.w, map, only);
      if (u.prefix && u.pforms) lookupCompletions(ix, u, map, only);
      if (u.fuzzy) lookupFuzzy(ix, u, map, only);
    } else if (u.kind === 'run') lookupRun(ix, Q, u, map, only);
    else if (u.kind === 'pair') lookupPair(ix, u, map, only);
    else if (u.kind === 'isbn' && u.key) for (const h of ix.isbnKeys.get(u.key) || []) addHit(map, { r: h.r, f: F_I, k: K_EXACT, s: h.s, e: h.e, wi: -1, wj: -1, why: '', q: u.text, n: 0 });
    return map;
  }

  // evaluate(query) -> { Q, state, rows: Map row -> result } for one run of the query (d12/d13 runs call it again)
  function evaluate(ix, text, unfinished) {
    const Q = parseQuery(text, unfinished), out = { Q, state: 'ok', rows: new Map() };
    if (Q.state === 'stop') {                                                              // (d10) a title made only of small words
      for (const r of ix.titleKeyRows.get(Q.stopKey) || []) out.rows.set(r, { r, doc: ix.docs[r], tier: 'match', why: [], Q, stop: true });
      if (!out.rows.size) out.state = 'stopwordsOnly';
      return out;
    }
    if (Q.state !== 'ok') { out.state = Q.state; return out; }
    for (const u of Q.units.concat(Q.isbn)) u.map = u.req || u.format || u.kind === 'isbn' ? lookupUnit(ix, Q, u, null) : new Map();
    for (const c of Q.chunks) {                                                            // (e2) 10minute plays, spider-man
      const m = new Map();
      lookupForms(ix, c.units[0], [[c.t, K_ALT, 0, ALL_F]], m, null, true);
      for (const u of c.units) for (const E of m.values()) for (const h of E.hits) addHit(u.map, Object.assign({}, h, { q: u.text }));
    }
    for (const j of Q.joins) {                                                             // (e1 ii) "super man" -> Superman
      const m = new Map();
      lookupForms(ix, j.u1, [[j.t, K_EXACT, 0, CONTENT_F]].concat(pluralForms(j.t).map(t => [t, K_ALT, 0, TM])), m, null, true);
      if (j.u2.prefix) lookupPrefix(ix, j.u1, j.t, m, null);                                 // "sand cas" -> Sandcastle while typing
      for (const E of m.values()) for (const h of E.hits) if (h.f <= F_M) for (const u of [j.u1, j.u2]) addHit(u.map, Object.assign({}, h, { k: K_COMP, why: 'c1', q: j.u1.text + ' ' + j.u2.text }));
    }
    for (const t of Q.tails) {                                                              // (e1) number words ending in the word being typed
      const m = new Map();
      lookupForms(ix, t.units[0], t.forms.map(v => [v, K_ALT, 0, ALL_F]), m, null, true);
      for (const E of m.values()) for (const h of E.hits) if (h.f <= F_M) for (const u of t.units) addHit(u.map, Object.assign({}, h, { k: K_PREFIX, why: '', n: 0, q: u.text }));
    }
    const cand = new Set();
    for (const u of Q.units.concat(Q.isbn)) if (u.req || u.format || u.kind === 'isbn') for (const [r, E] of u.map) if (E.c) cand.add(r);
    for (const u of Q.units) if (!u.req && !u.format && u.kind !== 'isbn' && u.kind !== 'year' && u.kind !== 'etal') lookupUnit(ix, Q, u, cand, u.map);
    // (e4) author words: the name after a standalone "by" ("holes by louis sachar", up to the next small word), or a word with any
    // hit in an Author field, a misspelt one too ("george orwel"); (e6) one-word demotion; (e5e) two-author segments
    const byName = new Set();
    Q.W.forEach((x, i) => { if (x.w === 'by') for (let k = i + 1; k < Q.W.length && !SMALL.has(Q.W[k].w); k++) byName.add(k); });
    for (const u of Q.req) {
      u.authorWord = byName.has(u.a) || [...u.map.values()].some(E => E.hits.some(h => h.f === F_A && h.k !== K_LOOSE));
    }
    // (d9) role and publisher words are optional beside an author word, or when no title in the list has them; otherwise a row
    // needs them like any title word ("mr. men" is not Spider-Man, "company of wolves" is not The Wolves of…)
    Q.titled = Q.units.filter(u => u.kind === 'word' && u.soft && !u.req && (ROLE.has(u.w) || PUBLISHER.has(u.w)) && !FORMAT.has(u.w) &&
      !QUESTION.has(u.w) && u.forms.some(([t]) => (ix.terms.get(t) || []).some(p => p.f === F_T)));
    Q.demote = null;
    if (Q.req.length === 1) {
      let strong = false, fz1 = false;
      for (const E of Q.req[0].map.values()) if (E.c) { if (KIND_CLASS[E.c.k] >= 2) strong = true; else if (E.c.k === K_FZ1) fz1 = true; }
      Q.demote = strong ? 'fuzzy' : fz1 ? 'fz2' : null;
    }
    Q.ordered = Q.units.filter(u => u.a >= 0).sort((a, b) => a.a - b.a);
    Q.segments = null;
    if (Q.W.length) {
      const segs = [[]];
      for (const u of Q.ordered) {
        if (u.kind === 'word' && u.w === 'and') { segs.push([]); continue; }
        if (/[\/;]/.test(Q.W[u.a].brk) && segs[segs.length - 1].length) segs.push([]);
        if (u.req) segs[segs.length - 1].push(u);
      }
      // a comma also splits when each side is a full name ("jack canfield, mark victor hansen"), not "canfield, j."
      const byComma = seg => {
        const parts = [[]];
        for (const u of seg) { if (parts[parts.length - 1].length && Q.W[u.a].brk.includes(',')) parts.push([]); parts[parts.length - 1].push(u); }
        return parts.length > 1 && parts.every(p => p.filter(u => !u.short).length >= 2) ? parts : [seg];
      };
      const s = segs.filter(x => x.length).flatMap(byComma);
      if (s.length >= 2 && s.every(x => x.length <= 4)) Q.segments = s;
    }
    for (const r of cand) { const res = judge(ix, Q, r); if (res) out.rows.set(r, res); }
    return out;
  }

  // The non-SMALL query word beside u that hit the row's Author exactly, through an alternate or as a prefix (e3), or with any
  // hit (a similar spelling too) when fuzzy is set.
  function besideAuthor(Q, u, r, fuzzy) {
    const list = Q.ordered.filter(v => v === u || !v.small), i = list.indexOf(u);
    for (const v of [list[i - 1], list[i + 1]]) {
      const E = v && v.map && v.map.get(r);
      if (E && E.hits.some(h => h.f === F_A && (fuzzy ? h.k !== K_LOOSE : KIND_CLASS[h.k] === 3))) return v;
    }
    return null;
  }
  const hitSpan = h => (h.wi <= h.wj ? [h.wi, h.wj] : [h.wj, h.wi]);
  const isSubseq = (a, b) => { let i = 0; for (const ch of b) if (ch === a[i]) i++; return !!a && i === a.length; };
  function judge(ix, Q, r) {
    const doc = ix.docs[r], E = u => (u.map && u.map.get(r)) || null;
    const A = doc.fw[F_A], AW = A ? A.W : [];
    // author words the query hit exactly (e3): short words and initials are optional beside a matched author word, but only while
    // the row has given names left for them to be ("the bfg roald dahl" is not Dahl's initials), and never a listed surname ("ng")
    const usedA = new Set();
    if (AW.length) for (const u of Q.units) {
      const e = !u.small && E(u);
      if (e) for (const h of e.hits) if (h.f === F_A && KIND_CLASS[h.k] === 3) { const [a, b] = hitSpan(h); for (let x = a; x <= b; x++) usedA.add(x); }
    }
    const givenLeft = AW.some((x, i) => !x.skip && !usedA.has(i) && !ROLE.has(x.w) && HAS_L.test(x.w));
    // the first letters of the other given names of the person whose name the word nb hit ("Mark Victor Hansen" -> "mv")
    const givenOf = nb => {
      const near = new Set();
      for (const h of nb.map.get(r).hits) if (h.f === F_A) { const [a, b] = hitSpan(h); for (let x = a; x <= b; x++) near.add(x); }
      const person = doc.persons.find(p => p.some(i => near.has(i))) || [];
      return person.filter(i => !usedA.has(i) && !near.has(i) && !ROLE.has(AW[i].w) && HAS_L.test(AW[i].w)).map(i => (AW[i].initials || [AW[i].w[0]]).join('')).join('');
    };
    const typedInitials = u => (u.x.initials || [u.w]).join('');
    const req = [], exempt = [];
    const typing = u => u.last && u.w.length <= 2;                // a 1-2 letter word still being typed ("lemony snicket b…")
    for (const u of Q.req) {
      let nb = null;
      if (u.short && (givenLeft || typing(u)) && (u.x.initials || !ix.surnames.has(u.w))) {
        nb = besideAuthor(Q, u, r);
        if (!nb) {                                   // beside a similar spelling only when the letters agree ("melvin b" for Melvn Berger)
          const fz = besideAuthor(Q, u, r, true);
          if (fz && isSubseq(typedInitials(u), givenOf(fz))) nb = fz;
        }
      }
      if (nb) exempt.push([u, nb]); else req.push(u);
    }
    for (const u of Q.titled) if (!besideAuthor(Q, u, r)) req.push(u);                       // (d9) role words used as title words
    // typed given names whose first letters spell the row's initials, next to its matched surname: "robert lawrence stine" ->
    // R.L. Stine (Close, explained)
    let initialsWhy = '';
    if (usedA.size && AW.some(x => x.initials)) {
      const list = Q.ordered.filter(v => !v.small);
      const miss = req.filter(u => u.kind === 'word' && !u.short && u.x.letters && !(E(u) && (E(u).c || E(u).m))).sort((a, b) => a.a - b.a);
      const pos = miss.map(u => list.indexOf(u));
      const nextTo = v => { const e = v && E(v); return !!e && e.hits.some(h => h.f === F_A && KIND_CLASS[h.k] === 3); };
      if (miss.length && pos.every((p, k) => !k || p === pos[k - 1] + 1) && (nextTo(list[pos[0] - 1]) || nextTo(list[pos[pos.length - 1] + 1]))) {
        const iw = AW.findIndex((x, i) => x.initials && !usedA.has(i) && isSubseq(miss.map(u => u.w[0]).join(''), x.initials.join('')));
        if (iw >= 0) {
          for (const u of miss) req.splice(req.indexOf(u), 1);
          const end = A.st.b[AW[iw].e - 1];
          initialsWhy = `${miss.map(u => u.text).join(' ')} = ${A.text.slice(A.st.a[AW[iw].s], A.text[end] === '.' ? end + 1 : end)}`;
        }
      }
    }
    let gate = false, allHit = true, allExact = true, spelled = false, loose = false, anchors = 0;
    const unanchored = [];
    for (const u of req) {
      const e = E(u), c = e && e.c;
      if (c) gate = true;
      if (!c && !(e && e.m)) { allHit = false; allExact = false; unanchored.push(u); continue; }
      if (!c) { unanchored.push(u); continue; }                                            // a META hit completes as exact-class
      if (KIND_CLASS[c.k] >= 2) anchors++; else unanchored.push(u);
      if (c.k === K_LOOSE) { loose = true; allExact = false; } else if (KIND_CLASS[c.k] < 3) { spelled = true; allExact = false; }
    }
    if (!gate) gate = Q.fmt.some(u => { const e = E(u); return !!(e && e.c); });           // (e5) content gate
    const isbnExact = Q.isbn.some(u => u.map && u.map.has(r)), R = req.length, why = [];
    // title words hit by any non-SMALL unit (e5c): word index -> matched exactly / through an alternate?
    const tHit = new Map();
    let authorWordHit = false, surnameHit = false;
    for (const u of Q.units) {
      const e = !u.small && E(u);
      if (e) for (const h of e.hits) {
        if (h.k === K_LOOSE) continue;
        const [a, b] = hitSpan(h);
        if (h.f === F_T) for (let k = a; k <= b; k++) tHit.set(k, tHit.get(k) || isExactish(h.k));
        if (h.f === F_A && KIND_CLASS[h.k] === 3 && doc.authorWordIdx.has(a)) authorWordHit = true;
        if (h.f === F_A && KIND_CLASS[h.k] === 3) for (let k = a; k <= b; k++) if (doc.surnameIdx.has(k)) surnameHit = true;
      }
    }
    const T = doc.items;
    let titleInside = false;
    if (T.length && !doc.allSmall) {
      const hit = T.map(it => it.wis.some(k => tHit.has(k))), ex = T.map(it => it.wis.some(k => tHit.get(k)));
      titleInside = hit.every(Boolean) && (T.length >= 2 ? ex.some(Boolean) : ex[0] && authorWordHit);   // FIX F12, F15
    }
    const demoted = !!Q.demote && R === 1 && (() => { const e = E(req[0]), c = e && e.c; return !!c && (c.k === K_FZ2 || (c.k === K_FZ1 && Q.demote === 'fuzzy')); })();
    let tier = null, pinned = false;
    if (isbnExact || (gate && R && allHit && allExact)) tier = 'match';                    // (e5a)
    else if (gate && R && allHit && !loose && spelled && !demoted) tier = 'close';          // (e5b)
    else if (titleInside) { tier = 'close'; why.push('the whole listed title is in your search'); }   // (e5c)
    if (doc.series) {                                                                      // (e5d) a row covering a whole series
      // lifted by its series name read as the reverse check reads a title (every word hit, one exactly; a one-word name also needs
      // an author word), or by its author's surname (exactly, through an alternate or as a prefix; not a shared given name)
      const byName = T.length > 0 && T.every(it => it.wis.some(k => tHit.has(k))) && T.some(it => it.wis.some(k => tHit.get(k))) &&
        (T.length >= 2 || authorWordHit);
      if (byName || surnameHit) {
        pinned = true;
        if (tier !== 'match') tier = 'close';
        why.unshift(`covers a whole series: its ${byName ? 'series name' : 'author'} is in your search`);
      }
    }
    if (!tier) {                                                                           // (e5e) Possible
      let k = 0;
      if (Q.segments) for (const seg of Q.segments) {                                     // initials in a segment are optional beside its name
        const core = seg.filter(u => !u.short);
        if (core.length && core.every(u => { const e = E(u); return e && e.hits.some(h => h.f === F_A && KIND_CLASS[h.k] === 3); })) k++;
      }
      if (anchors >= 1 && doc.authorless && unanchored.length && unanchored.every(u => u.authorWord)) { tier = 'possible'; why.push('author not listed'); }
      else if (k >= 1) { tier = 'possible'; why.push(`matched ${k} of ${Q.segments.length} authors`); }
      else if (anchors >= 1 && anchors * 2 >= R) { tier = 'possible'; why.push(`matched ${anchors} of ${R} words`); }
      else if (doc.authorless && anchors >= 1 && unanchored.length <= 3 && T.length && !doc.allSmall && T.every(it => it.wis.some(k => tHit.get(k)))) {
        tier = 'possible'; why.push('author not listed');                                  // "holes louis sachar": the whole title, no author
      }
      else if (demoted) tier = 'possible';
      else if (gate && allHit && loose) { tier = 'possible'; if (R > 1) why.push(`matched ${anchors} of ${R} words`); }
    }
    if (!tier) return null;
    if (initialsWhy) { if (tier === 'match') tier = 'close'; why.push(initialsWhy); }
    // ranking data (f2)
    if (!doc.wiItem) { doc.wiItem = []; T.forEach((it, k) => it.wis.forEach(wi => { doc.wiItem[wi] = k; })); }
    const meaningful = Q.req.filter(u => u.kind !== 'isbn');
    let titleEq = false;
    if (meaningful.length && meaningful.length === T.length) {
      const opts = meaningful.map(u => { const e = E(u), s = new Set(); if (e) for (const h of e.hits) if (h.f === F_T && isExactish(h.k)) { const [a, b] = hitSpan(h); for (let x = a; x <= b; x++) if (doc.wiItem[x] !== undefined) s.add(doc.wiItem[x]); } return [...s]; });
      titleEq = perfectMatch(opts, T.length);
    }
    let inOrder = 0;
    for (const f of [F_T, F_A]) {
      const pos = doc.fw[f] && doc.fw[f].pos;
      if (!pos) continue;
      const seq = [];
      for (const u of Q.ordered) {
        const e = u.req && E(u);
        let a = Infinity, b = -1;
        if (e) for (const h of e.hits) if (h.f === f && h.k !== K_LOOSE) { const [x, y] = hitSpan(h); if (pos[x] >= 0 && pos[x] < a) { a = pos[x]; b = Math.max(pos[y], a); } }
        if (a !== Infinity) seq.push([a, b]);
      }
      if (seq.length < 2) continue;
      let ord = true, adj = true;
      for (let i = 1; i < seq.length; i++) { if (seq[i][0] <= seq[i - 1][1]) ord = false; if (seq[i][0] !== seq[i - 1][1] + 1) adj = false; }
      if (ord) inOrder = Math.max(inOrder, adj ? 2 : 1);
    }
    let quality = 0, optMatched = Q.etal && doc.etAl ? 1 : 0, authorUnits = 0, author1 = false;
    for (const u of Q.units) {
      const e = E(u), h = e && (e.c || e.m);
      if (!h) continue;
      quality += KIND_W[h.k] * FIELD_W[h.f];
      if (!u.req && u.kind !== 'isbn') optMatched++;
      if (u.req && e.hits.some(x => x.f === F_A)) { authorUnits++; if (e.hits.some(x => x.f === F_A && x.k !== K_LOOSE)) author1 = true; }
    }
    const year = Q.years.some(y => doc.year && doc.year.start === y.start && doc.year.end === y.end);
    // "given names differ" (e3): an optional initial that did not match and is not among the first letters of the given names of
    // the person whose surname matched ("G. R. R. Martin", "L. Anderson" for Laurie Halse Anderson, "M. V. Hansen" in a two-author cell)
    let givenNamesDiffer = false;
    for (const [u, nb] of exempt) {
      const e = E(u);
      if (!(e && (e.c || e.m)) && !(typing(u) && !givenLeft) && !isSubseq(typedInitials(u), givenOf(nb))) givenNamesDiffer = true;
    }
    return { r, doc, tier, why, pinned, Q, isbnExact, titleEq, author1: author1 && Q.req.length === 1, year, anchors, inOrder,
      authorUnits: Q.req.length > 1 ? authorUnits : 0, optMatched, quality, givenNamesDiffer, via: '', demoted, spelled: spelled && !titleInside, titleInside };
  }
  function perfectMatch(opts, n) {                                                         // bipartite: every unit gets its own title word
    const owner = new Array(n).fill(-1);
    const tryU = (u, seen) => {
      for (const it of opts[u]) {
        if (seen[it]) continue;
        seen[it] = true;
        if (owner[it] < 0 || tryU(owner[it], seen)) { owner[it] = u; return true; }
      }
      return false;
    };
    return opts.every((o, u) => tryU(u, new Array(n).fill(false)));
  }

  // ---------- search: runs, merge, groups, ranking ----------
  const TIER_RANK = { match: 3, close: 2, possible: 1 };
  // (d1) Long pasted text: search the first 12 main words (a main word has a letter or digit and a non-SMALL word).
  function truncateLong(text) {
    const re = /\S+/g;
    let m, count = 0, end = 0;
    while ((m = re.exec(text))) {
      if (!analyze(fold(m[0])).some(x => !SMALL.has(x.w))) continue;
      if (count === 12) return { text: text.slice(0, end).trim(), truncated: true };
      count++;
      end = m.index + m[0].length;
    }
    return { text, truncated: false };
  }
  // (d13) alias widening: a complete alias name in the query is replaced by each other name of its group (8 at most). The name's
  // last word may be the word being typed (3+ letters: "daniel han"); after a comma the words may come in any order ("Handler, Daniel").
  function aliasQueries(ix, Q, unfinished) {
    const out = [], W = Q.W.filter(x => !SMALL.has(x.w)), lastW = Q.W[Q.W.length - 1];
    for (const group of ix.aliases) for (const name of group) {
      const k = name.key;
      for (let i = 0; i + k.length <= W.length && out.length < 8; i++) {
        const win = W.slice(i, i + k.length), typing = unfinished && win[k.length - 1] === lastW && lastW.w.length >= 3;
        const same = k.every((w, j) => win[j].w === w || (typing && j === k.length - 1 && w.startsWith(win[j].w)));
        const sorted = a => a.slice().sort().join(' ');
        if (!same && !(k.length >= 2 && win.slice(1).some(x => x.brk.includes(',')) && sorted(win.map(x => x.w)) === sorted(k))) continue;
        const s = W[i].s, e = W[i + k.length - 1].e, t = Q.text;
        for (const other of group) if (other !== name && out.length < 8) {
          out.push({ text: (t.slice(0, s) + ' ' + fold(other.text) + ' ' + t.slice(e)).replace(/\u0001/g, ' '), typed: t.slice(s, e),
            name: other.text, atEnd: W[i + k.length - 1] === Q.W[Q.W.length - 1] });
        }
      }
    }
    return out;
  }
  const fieldText = (doc, f) => (f === F_T ? doc.display : String([doc.row.title, doc.row.author, doc.row.memo, doc.row.isbn, doc.row.type, doc.row.bannedBy][f] ?? ''));

  // (g1) reasons, most tier-defining first, at most 6; never a verdict about the item
  function reasonsFor(o) {
    const out = o.why.slice();
    if (o.stop) return out;
    const spell = [], loose = [], expl = [];
    const cell = h => fieldText(o.doc, h.f).slice(h.s, h.e);
    const exact = new Set();                                  // cell words another query word matched exactly: no "similar spelling" for them
    for (const u of o.Q.units) { const e = u.map && u.map.get(o.r); if (e && e.c && KIND_CLASS[e.c.k] === 3) exact.add(e.c.f + ':' + e.c.s); }
    for (const u of o.Q.units) {
      const e = u.map && u.map.get(o.r), h = e && (e.c || e.m);
      if (!h) continue;
      if (h.why === 'fz' && exact.has(h.f + ':' + h.s)) continue;
      if (h.why === 'fz' && (o.tier !== 'possible' || o.demoted)) spell.push(`similar spelling: ${cell(h)}`);
      else if (h.why === 'c2' && o.tier !== 'possible') spell.push(`written as two words: ${cell(h)}`);
      else if (h.why === 'c1' && o.tier !== 'possible') spell.push(`written as one word: ${cell(h)}`);
      else if (h.k === K_LOOSE && h.why === 'lo') loose.push(`other number: ${cell(h)}`);
      else if ((h.why === 'eq' || h.why === 'pair') && bare(h.q) !== bare(cell(h))) expl.push(`${h.q} = ${cell(h)}`);
      else if (h.why === 'eq2') expl.push(`${h.q} = ${e.hits.filter(x => x.why === 'eq2' && x.f === h.f).sort((a, b) => a.s - b.s).map(cell).join(' ')}`);
    }
    const lead = out.filter(x => /^(?:via alias|searched without|same title|covers a whole|the whole listed title)/.test(x));
    const list = lead.concat(spell, out.filter(x => !lead.includes(x)), loose, o.givenNamesDiffer ? ['given names differ'] : [], expl.slice(0, 3));
    // a Close whose only similar spelling was a cell word also matched exactly ("…Chicken Soup for the Soul"): the reverse check explains it
    if (!list.length && o.tier === 'close' && o.titleInside) list.push('the whole listed title is in your search');
    return [...new Set(list)].slice(0, 6);
  }
  // (g4) highlights: [start, end) ranges on display.title, row.author, row.memo, row.isbn
  function highlightsFor(o) {
    if (o.stop) return { title: o.doc.display ? [[0, o.doc.display.length]] : [], author: [], memo: [], isbn: [] };   // "The The"
    const byField = [[], [], [], []], small = [];
    for (const u of o.Q.units.concat(o.Q.isbn)) {
      const e = u.map && u.map.get(o.r);
      if (!e || !e.c) continue;
      const cls = KIND_CLASS[e.c.k];                                                       // only the unit's best kind of hit
      for (const h of e.hits) {                            // an ordinal<->cardinal crossing only when nothing better matched
        if (h.f <= F_I && KIND_CLASS[h.k] === cls && !(h.k === K_ALTX && e.c.k !== K_ALTX)) (u.small ? small : byField[h.f]).push(h);
      }
    }
    for (const h of small) if (byField[h.f].some(x => Math.abs(x.wi - h.wi) === 1 || Math.abs(x.wj - h.wi) === 1)) byField[h.f].push(h);
    const out = {};
    ['title', 'author', 'memo', 'isbn'].forEach((name, f) => {
      let st = null;
      const ranges = byField[f].map(h => {
        if (!h.n) return [h.s, h.e];
        st = st || foldWithMap(fieldText(o.doc, f));                                     // a prefix: only the typed length
        let i = st.a.indexOf(h.s), n = 0;
        if (i < 0) return [h.s, h.e];
        for (; i < st.s.length && n < h.n; i++) if (st.s[i] !== "'") n++;
        return [h.s, Math.min(h.e, st.b[i - 1])];
      }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const merged = [], txt = ranges.length ? fieldText(o.doc, f) : '';
      for (const r of ranges) {
        while (r[1] < txt.length && /\p{M}/u.test(txt[r[1]])) r[1]++;                  // a trailing combining accent (NFD text) is part of the word
        const last = merged[merged.length - 1];
        if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice());
      }
      out[name] = merged;
    });
    return out;
  }
  function fieldsFor(o) {                                  // the fields of each unit's best kind of hit (as highlighted), and Type/Banned By
    const seen = new Set(o.stop ? [F_T] : []);
    for (const u of o.Q.units.concat(o.Q.isbn)) {
      const e = !u.small && u.map && u.map.get(o.r);
      if (e) for (const h of e.hits) if (h.f >= F_Y || (e.c && KIND_CLASS[h.k] === KIND_CLASS[e.c.k])) seen.add(h.f);
    }
    return FIELD_ORDER.filter(f => seen.has(f)).map(f => FIELD_NAMES[f]);
  }
  // (f2) sort key, larger first; ties by row id. In main, Match hits come before Close hits (PRD: ranked in tiers, then within a tier).
  const rankKey = (o, main) => [main && o.pinned ? 1 : 0, main ? TIER_RANK[o.tier] : 0, o.isbnExact ? 1 : 0, o.via ? 0 : 1, o.titleEq ? 1 : 0, o.author1 ? 1 : 0,
    o.year ? 1 : 0, main ? 0 : o.anchors || 0, o.inOrder || 0, o.authorUnits || 0, o.optMatched || 0, o.quality || 0];
  function ranked(list, main) {
    const keyed = list.map(o => ({ o, k: rankKey(o, main) }));
    keyed.sort((a, b) => { for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return b.k[i] - a.k[i]; return a.o.doc.id - b.o.doc.id; });
    // (f3) same normalized title and author: gathered at the best member's place, the Ministry row first
    const groups = new Map();
    keyed.forEach((x, i) => { const g = x.o.doc.groupKey; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); });
    const out = [];
    for (const idx of groups.values()) {
      const members = idx.map(i => keyed[i].o);
      const min = (o) => (o.doc.row.status && o.doc.row.status.level === 'ministry' ? 0 : 1);
      members.sort((a, b) => min(a) - min(b));                                            // stable: rank order otherwise
      out.push(...members.map(o => ({ o, size: members.length })));
    }
    return out;
  }
  function toHit(o, size) {
    const doc = o.doc;
    return { row: doc.row, tier: o.tier, score: Math.round(((o.quality || 0) + (o.titleEq ? 50 : 0) + 10 * (o.inOrder || 0) + (o.isbnExact ? 60 : 0) + (o.pinned ? 100 : 0)) * 100) / 100,
      reasons: reasonsFor(o), fields: fieldsFor(o), display: { title: doc.display, titleAsWritten: String(doc.row.title ?? '') },
      highlights: highlightsFor(o), notes: doc.notes.slice(), groupKey: doc.groupKey, groupSize: size };
  }

  function search(query, ix, opts) {
    const enter = !!(opts && opts.enter);
    let text = String(query ?? ''), truncated = false;
    if (text.trim().length > 300) ({ text, truncated } = truncateLong(text));
    const res = { state: 'ok', query: text, truncated, isbnQuery: false, main: [], possible: [], isbnPrefix: [], hints: [] };
    const chars = (fold(text).match(/[\p{L}\p{N}]/gu) || []).length;                     // (d4) empty / tooShort
    if (!chars) { res.state = 'empty'; return res; }
    if (chars === 1 && !enter) { res.state = 'tooShort'; return res; }
    if (!ix || !ix.docs) return res;
    // (d2) a trailing space finishes the word; so does opts.finished (a line of a pasted list is complete text)
    const unfinished = !truncated && !(opts && opts.finished) && !/\s$/.test(text);
    const base = evaluate(ix, text, unfinished), Q = base.Q, rows = base.rows;
    res.isbnQuery = Q.isbnQuery;
    if (base.state !== 'ok') { res.state = base.state; return res; }
    if (Q.foreign) {                                                                      // (d12) run 2 without the foreign article
      for (const [r, o] of evaluate(ix, Q.foreign.text, unfinished).rows) {
        // a row found only by a similar spelling of the words after the article is Possible ("le carre" is not Carrie)
        const t = o.tier === 'possible' || (o.tier === 'close' && o.spelled) ? 'possible' : 'close', b = rows.get(r);
        if (!b || TIER_RANK[t] > TIER_RANK[b.tier]) rows.set(r, Object.assign({}, o, { tier: t, via: 'foreign', pinned: false, why: [`searched without "${Q.foreign.word}"`].concat(o.why), demoted: o.demoted || t !== o.tier }));
      }
    }
    for (const a of Q.W.length ? aliasQueries(ix, Q, unfinished) : []) {                               // (d13) alias widening
      for (const [r, o] of evaluate(ix, a.text, unfinished && !a.atEnd).rows) {
        const b = rows.get(r);
        if (!b || TIER_RANK[o.tier] > TIER_RANK[b.tier]) rows.set(r, Object.assign({}, o, { via: 'alias', why: [`via alias: ${a.typed} \u2192 ${a.name}`].concat(o.why) }));
      }
    }
    const groups = new Map();                                                             // (e7) Must remove is never buried under Check
    for (const o of rows.values()) { if (!groups.has(o.doc.groupKey)) groups.set(o.doc.groupKey, []); groups.get(o.doc.groupKey).push(o); }
    for (const g of groups.values()) {
      if (g.length > 1 && g.some(o => o.tier !== 'possible')) for (const o of g) if (o.tier === 'possible') {
        rows.set(o.r, Object.assign({}, o, { tier: 'close', why: ['same title and author as another result'].concat(o.why), demoted: false }));
      }
    }
    // (e7) the rest of a main hit's group joins it: an ISBN or memo search reaches one row of a work, and the Ministry row of the
    // same title and author must show beside it
    const sibling = r => ({ r, doc: ix.docs[r], tier: 'close', why: ['same title and author as another result'], Q, pinned: false, quality: 0 });
    for (const o of [...rows.values()]) if (o.tier !== 'possible') for (const r of ix.groupRows.get(o.doc.groupKey) || []) if (!rows.has(r)) rows.set(r, sibling(r));
    const all = [...rows.values()];
    const main = ranked(all.filter(o => o.tier !== 'possible'), true), possible = ranked(all.filter(o => o.tier === 'possible'), false);
    res.main = main.map(x => toHit(x.o, x.size));
    res.possible = possible.map(x => toHit(x.o, x.size));
    const isbnMatched = all.some(o => o.isbnExact);
    if (Q.isbnQuery && Q.digits.length >= 6 && Q.digits.length <= 13 && !isbnMatched) {     // (e8) "ISBN starts with…"
      const F = ix.isbnForms, d = Q.digits, inMain = new Set(main.map(x => x.o.r)), seen = new Set(), found = [];
      let lo = 0, hi = F.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (F[mid].f < d) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < F.length && F[i].f.startsWith(d); i++) if (!inMain.has(F[i].r) && !seen.has(F[i].r)) { seen.add(F[i].r); found.push({ r: F[i].r, doc: ix.docs[F[i].r], x: F[i] }); }
      for (const o of found.slice()) for (const r of ix.groupRows.get(o.doc.groupKey) || []) {   // with the rest of each group (e7)
        if (!inMain.has(r) && !seen.has(r)) { seen.add(r); found.push({ r, doc: ix.docs[r], x: null }); }
      }
      res.isbnPrefix = ranked(found, false).map(({ o, size }) => {
        const doc = o.doc, x = o.x;
        return { row: doc.row, tier: 'possible', score: 0, reasons: [x ? `ISBN starts with ${d}` : 'same title and author as another result'], fields: x ? ['isbn'] : [],
          display: { title: doc.display, titleAsWritten: String(doc.row.title ?? '') }, highlights: { title: [], author: [], memo: [], isbn: x ? [[x.s, x.e]] : [] },
          notes: doc.notes.slice(), groupKey: doc.groupKey, groupSize: size };
      });
    }
    res.hints = hintsFor(ix, Q, res, enter, unfinished, isbnMatched);
    return res;
  }

  // ---------- (g3) hints: only when state is ok; never claim an item is permitted ----------
  function hintsFor(ix, Q, res, enter, unfinished, isbnMatched) {
    const empty = !res.main.length && !res.possible.length && !res.isbnPrefix.length, W = Q.W, last = W[W.length - 1];
    // not after initials ("Hansen, M. V."), a letter with a period, or a label's number ("grade 9"): those are complete
    if (!enter && empty && unfinished && last && last.w.length <= 2 && !last.initials && !last.dot && !last.pair && !Q.isbnQuery) {
      return [{ code: 'keepTyping', text: 'Keep typing: word endings are matched from the third letter.' }];
    }
    const hints = [];
    if ((Q.isbnQuery || Q.hasCompleteIsbn) && !isbnMatched && !res.isbnPrefix.length && !res.main.length) {
      hints.push({ code: 'isbnNoMatch', text: ix.isbnRowCount >= ix.rowCount ? 'No ISBN match. Search the title and author too.'
        : `No ISBN match. ${ix.isbnRowCount * 2 >= ix.rowCount ? 'Some' : 'Most'} rows have no ISBN, so search the title and author.` });
    }
    if (res.main.length) return hints;
    const seen = new Set();
    for (const u of Q.req) {                                                             // authorHasOthers: the query names a listed surname
      if (u.kind !== 'word' || u.short || u.soft || u.w.length < 3 || !HAS_L.test(u.w)) continue;
      for (const [t] of u.forms) for (const s of ix.surnames.get(bare(t)) || []) {
        if (seen.has(s.authorKey) || seen.size >= 3) continue;
        seen.add(s.authorKey);
        hints.push({ code: 'authorHasOthers', text: `${s.author} has other listed items; search '${s.surname}'` });
      }
    }
    if (ix.hasEtAl && W.some(x => HAS_L.test(x.w))) hints.push({ code: 'etAl', text: 'Co-authors after "Et Al" aren\'t listed in the sheet; search the first-named author or the title.' });
    const acr = acronymFor(ix, Q);
    if (acr) hints.push({ code: 'acronym', text: `The list may use an acronym: try "${acr}".` });
    if (!Q.isbnQuery) hints.push({ code: 'seriesTip', text: 'Also search the series name and author.' });
    return hints;
  }
  function acronymFor(ix, Q) {
    const words = new Set(Q.W.map(x => x.w));
    const seq = [];
    let best = null;
    const flush = () => {
      for (let n = Math.min(6, seq.filter(u => u.req).length); n >= 2 && !best; n--) {
        for (let i = 0; i < seq.length && !best; i++) {
          if (!seq[i].req) continue;
          const win = [];
          for (let j = i; j < seq.length && win.filter(u => u.req).length < n; j++) win.push(seq[j]);
          if (win.filter(u => u.req).length !== n) continue;
          for (const s of [win.map(u => u.w[0]).join(''), win.filter(u => u.req).map(u => u.w[0]).join('')]) {
            if (!best && s.length >= 3 && s.length <= 6 && ix.spell.has(s) && !words.has(s)) best = ix.spell.get(s);
          }
        }
      }
      seq.length = 0;
    };
    for (const u of Q.ordered || []) {
      if (u.kind === 'word' && ONLY_L.test(u.w) && (u.req || u.small)) seq.push(u); else flush();
    }
    flush();
    return best;
  }

  return { fold, foldWithMap, buildIndex, search, splitLines, normalizeTitleForDisplay, _internal: { analyze, isbnRuns, osa } };
});
