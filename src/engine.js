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
  const SMALL = new Set(list('the a an of and or to in on at for by with from'));          // ignorable (AWO-2)
  const FORMAT = new Set(list('book books disc discs disk dvd dvds cd cds video videos vhs bluray paperback hardcover hardback ' +
    'softcover kindle ebook audiobook audio novel edition editions ed edn anniversary illustrated unabridged abridged deluxe ' +
    'reprint revised expanded'));                                                              // FIX F4: format words are soft
  const QUESTION = new Set(list('is are was can could may banned ban allowed permitted prohibited'));
  const ROLE = new Set(list('jr sr dr mr author authors editor editors ed illustrator illustrators translator translators'));
  const PUBLISHER = new Set(list('company press publisher publishers books inc'));
  const FOREIGN_ART = new Set(list('le la les el los las il der die das'));
  const PLACEHOLDER = new Set(list('unknown unknownauthor anonymous anon various variousauthors na none nil notknown notlisted ' +
    'notavailable tbd tba'));
  const EDITION_WORDS = new Set(list('edition ed edn anniversary'));

  const UNITS = {}, TENS = {}, ORDS = {};
  list('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen ' +
    'eighteen nineteen').forEach((w, i) => { UNITS[w] = i; });
  list('twenty thirty forty fifty sixty seventy eighty ninety').forEach((w, i) => { TENS[w] = 20 + 10 * i; });
  list('first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth ' +
    'sixteenth seventeenth eighteenth nineteenth').forEach((w, i) => { ORDS[w] = i + 1; });
  list('twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth').forEach((w, i) => { ORDS[w] = 20 + 10 * i; });
  ORDS.hundredth = 100; ORDS.thousandth = 1000;
  const NUMW = Object.assign({ hundred: 100, thousand: 1000 }, UNITS, TENS);               // cardinal number words ('oh' is not one)
  const isNumWord = w => NUMW[w] !== undefined || ORDS[w] !== undefined;
  // (b8) common misspellings, read before numbers and before fuzzy matching (the typed word stays literal too)
  const MISSPELL = { ninteen: 'nineteen', ninty: 'ninety', fourty: 'forty', eigth: 'eighth', eigthy: 'eighty', twelth: 'twelfth',
    nineth: 'ninth', fith: 'fifth', fourtieth: 'fortieth', eightteen: 'eighteen' };

  // (b6) label + number pairs: label word -> key. FIX F7: class/grade/standard share the grade key.
  const LABELS = {};
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
  const KIND_W = [1, 0.9, 0.85, 0.8, 0.9, 0.6, 0.4, 0.3];
  const KIND_CLASS = [3, 3, 3, 3, 2, 1, 1, 0];
  const isExactish = k => k <= K_ALTX;                                                      // exact or through an alternate
  const hitValue = h => (h.f >= F_Y ? 30 : KIND_CLASS[h.k] * 10) + KIND_W[h.k] * FIELD_W[h.f];

  // ---------- (a) fold: one normalizer for sheet cells and queries ----------
  const APOS = new Set(['\u0027', '\u2018', '\u2019', '\u201a', '\u201b', '\u2032', '\u02b9', '\u02bb', '\u02bc', '`', '\u00b4', '\uff07']);
  const SYMBOL_MARKS = new Set(['\u2122', '\u2120', '\u00a9', '\u00ae', '\u2117']);
  const SPECIAL = { 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'ł': 'l', 'þ': 'th', 'ı': 'i' };
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
  const SYMBOLS = { 'c++': 'cplusplus', 'c#': 'csharp', 'f#': 'fsharp', 'a+': 'aplus' };      // PUNC-10 (a 4-entry table)
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
  const REST_OK = /^(?:$|\s*[:;.,(\[{\p{Pd}\u2212])/u;
  // Returns the title with the article moved, or null when the title has no movable ", The" (shortest head first).
  function moveArticle(text) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    for (let ci = t.indexOf(','); ci !== -1; ci = t.indexOf(',', ci + 1)) {
      const head = t.slice(0, ci).trimEnd();
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
  function splitLines(text) {
    return String(text ?? '').split(/\r\n|[\r\n\u0085\u2028\u2029]/)
      .map(l => l.replace(/\p{Cf}/gu, '').trim()).filter(l => /[\p{L}\p{N}]/u.test(l));
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
  // Run-together number words: twentyone -> 21, nineteeneightyfour -> 1984 (tenfour reads as nothing).
  const NUM_PARTS = Object.keys(NUMW).concat(Object.keys(ORDS)).sort((a, b) => b.length - a.length);
  const RUN_TOGETHER = new RegExp('^(?:' + NUM_PARTS.join('|') + '){2,}$');
  function runTogether(t) {
    if (t.length < 6 || !RUN_TOGETHER.test(t)) return null;
    const split = (i, out) => {
      if (i === t.length) return out.length >= 2 ? readRun(out) : null;
      for (const p of NUM_PARTS) if (t.startsWith(p, i)) { const r = split(i + p.length, out.concat(p)); if (r) return r; }
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
      if (raw !== w) {                                                                   // (b4) aaron's -> aarons + aaron; l'engle -> engle
        if (/'s$/.test(raw)) addAlt(x, raw.slice(0, -2).replace(/'/g, ''), K_ALT);
        const el = /^[odl]'(.+)$/.exec(raw);
        if (el && el[1].replace(/'/g, '').length >= 2) addAlt(x, el[1].replace(/'/g, ''), K_ALT);
      }
      W.push(x);
    }
    // (b5) FIX F8: 2+ single letters (not "a") separated only by spaces or periods are ONE initials word: R.L. / R. L. / r l -> rl
    const size = {};
    for (const x of W) size[x.ch] = (size[x.ch] || 0) + 1;
    const isInit = x => x.w.length === 1 && x.letters && x.w !== 'a' && size[x.ch] === 1;
    const merged = [];
    for (let i = 0; i < W.length; i++) {
      if (isInit(W[i]) && i + 1 < W.length && isInit(W[i + 1]) && /^[\s.]+$/.test(W[i + 1].brk)) {
        let j = i;
        const letters = [W[i].w];
        while (j + 1 < W.length && isInit(W[j + 1]) && /^[\s.]+$/.test(W[j + 1].brk)) letters.push(W[++j].w);
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
    // (b6) FIX F7 label + number pairs -> '#book3', '#grade8' (pair namespace); (b6r) ranges "Books 4–6" -> #book4..#book6
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
        if (k < W.length && !n.roman) {
          const to = /^(?:to|through|thru)$/.test(W[k].w);
          const mm = DASH_SP.test(W[k].brk) ? pairNumber(W, k, key) : to ? pairNumber(W, k + 1, key) : null;
          if (mm && !mm.roman && mm.v > n.v) { rng = { n: n.v, m: mm.v, k: !!n.k }; end = mm.end; }
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
      if (x.digits && !x.run && /#\s*$/.test(x.brk)) addPair(W, 'book', +x.num, -1, i, i, null, null);   // "#3"
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
  function pairNumber(W, j, key) {
    const y = W[j];
    if (!y || y.pair || y.initials) return null;
    if (y.run) return y.run.i === j ? { v: +y.run.vals[0], end: y.run.j } : null;
    if (y.num !== null && !y.ord) return { v: +y.num, end: j };
    const r = y.letters ? romanValue(y.w) : 0;
    if (r >= 1 && r <= 30) return { v: r, end: j, roman: true };                            // Volume II, Class VIII, Part I
    if (key === 'grade' && (y.w === 'k' || y.w === 'kg')) return { v: 0, end: j, k: true };  // Grade K = grade 0
    return null;
  }
  function addPair(W, key, v, li, a, b, rng, n) {
    const p = { key, v, li, a, b, rng, terms: [] };
    if (!rng) p.terms.push('#' + key + v);
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
  // Every ISBN-shaped run in a cell with its [start, end) in the cell. Scientific notation ("9.79889E+12") has lost its
  // digits and gives nothing; placeholders (N/A, -, none…) give nothing; a bad checksum is never rejected.
  function isbnRuns(value) {
    const cell = String(value ?? '');
    if (!/\d/.test(cell) || /^\s*[\d.]+e[+-]?\d+\s*$/i.test(cell)) return [];
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
      const off = a + piece.indexOf(t);
      if (/^[\d\s-]+[xX]?$/.test(t)) { add(t.replace(/[\s-]/g, ''), off, off + t.length); continue; }
      const re = /\d{9,13}[xX]?/g;
      let r;
      while ((r = re.exec(t))) add(r[0], off + r.index, off + r.index + r[0].length);
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
      for (const [t, k, why, num] of x.alts) if (!(num && (meta || x.run))) post(ix, t, r, f, k, s, e, i, i, paired, why);
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
      if (w(i) === 'series' && w(i + 1) !== 'of') out.add(i);
      if (/^(?:collection|boxset|trilogy|omnibus)$/.test(w(i))) out.add(i);
      if ((w(i) === 'all' && /^(?:titles|books|works)$/.test(w(i + 1))) || (w(i) === 'complete' && /^(?:works|series)$/.test(w(i + 1))) ||
          (/^box(?:ed)?$/.test(w(i)) && w(i + 1) === 'set')) { out.add(i); out.add(i + 1); }
    }
    return out;
  }
  // Surnames for the authorHasOthers hint (c7): split names on ; / & and, commas when every part has 2+ words.
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
      if (parts.length > 1 && parts.every(p => p.split(/\s+/).length >= 2)) parts.forEach(lastWord);
      else if (parts.length === 2 && parts[1].split(/\s+/).length === 1) lastWord(parts[0]);
      else lastWord(parts.join(' '));
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
    const placeholder = PLACEHOLDER.has(bare(author)) || !bare(author);                  // (c4) N/A, Unknown, - … index nothing
    if (!placeholder) indexField(ix, doc, F_A, author, fuzzy);
    if (doc.etAl) ix.hasEtAl = true;
    if (String(row.memo ?? '')) indexField(ix, doc, F_M, String(row.memo), fuzzy);
    if (String(row.type ?? '')) indexField(ix, doc, F_Y, String(row.type), fuzzy);           // FIX F2: Type / Banned By only complete
    if (String(row.bannedBy ?? '')) indexField(ix, doc, F_B, String(row.bannedBy), fuzzy);  //         a match; Year is never indexed
    // ISBNs (c5): separate index, never in the word vocabulary
    const raw = String(row.isbnRaw ?? '');
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
      if (p.rng) {
        const L = label ? label[0].toUpperCase() + label.slice(1) : 'Books';
        doc.notes.push(`Covers ${L} ${p.rng.k ? 'K' : p.rng.n}\u2013${p.rng.m}`);
      }
    }
    if (bookVals.size === 1 && !anyRange && !doc.series) {                                // (g2) single-volume note
      const p = TW.pairs.find(q => q.key === 'book');
      const L = p.li >= 0 && /^vol(?:ume)?s?$/.test(TW[p.li].w) ? 'Volume' : 'Book';
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
    doc.groupKey = (gtk || '\u0000' + r) + '|' + doc.authorKey;
    if (!doc.authorless) {
      const shown = author.trim().replace(/[\s,]*(?:et\.?\s*al\.?|(?:and|&)\s+others)\s*$/i, '').trim();
      for (const sn of surnamesOf(author)) {
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
      isbnForms: [], titleKeyRows: new Map(), pairKeyRows: new Map(), surnames: new Map(), spell: new Map(), hasEtAl: false,
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
  const IRREGULAR = { woman: 'women', man: 'men', child: 'children', mouse: 'mice', person: 'people', foot: 'feet', tooth: 'teeth', goose: 'geese' };
  const BRIT = { pyjamas: 'pajamas', pyjama: 'pajama', grey: 'gray', mum: 'mom', mummy: 'mommy', aeroplane: 'airplane', programme: 'program',
    catalogue: 'catalog', dialogue: 'dialog', jewellery: 'jewelry', defence: 'defense', licence: 'license', plough: 'plow', tyre: 'tire',
    moustache: 'mustache', mould: 'mold', sceptic: 'skeptic', aluminium: 'aluminum', cosy: 'cozy', travelled: 'traveled', traveller: 'traveler' };
  const ABBR = { mr: 'mister', dr: 'doctor', st: 'saint', mt: 'mount' };
  const twoWay = o => { for (const [a, b] of Object.entries(o)) o[b] = a; return o; };
  twoWay(IRREGULAR); twoWay(BRIT); twoWay(ABBR);
  function pluralForms(w) {                                                                // SPV-4 (Title and Memo only), FIX F13
    const out = IRREGULAR[w] ? [IRREGULAR[w]] : [];
    if (w.length < 4) return out;
    if (/ies$/.test(w)) out.push(w.slice(0, -3) + 'y', w.slice(0, -1));
    else if (/ves$/.test(w)) out.push(w.slice(0, -3) + 'f', w.slice(0, -3) + 'fe', w.slice(0, -1));
    else if (/(?:s|x|z|ch|sh)es$/.test(w)) out.push(w.slice(0, -2));
    else if (/s$/.test(w) && !/(?:ss|us|is)$/.test(w)) out.push(w.slice(0, -1));
    if (/[^aeiou]y$/.test(w)) out.push(w.slice(0, -1) + 'ies');
    else if (/fe$/.test(w)) out.push(w.slice(0, -2) + 'ves');
    else if (/f$/.test(w)) out.push(w.slice(0, -1) + 'ves');
    else if (/(?:s|x|z|ch|sh)$/.test(w)) out.push(w + 'es');
    else out.push(w + 's');
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
    /\((?:author|illustrator|editor|translator|narrator|foreword|introduction|contributor)s?\)/g,
  ];
  const ISBN_LABEL = /\bisbn(?:[\s-]*1[03])?\s*[:#]?/g;
  const ALL_F = 63, TAM = 7, TM = 5, CONTENT_F = 15;                                        // field masks (bit = 1 << field)
  const isYearTok = t => /^(?:19|20)\d\d$/.test(t);
  const isYearWord = x => !!x && x.digits && isYearTok(x.w) && !x.pair;
  const isShortWord = x => !SMALL.has(x.w) && !x.pair && (!!x.initials || (/^[a-z]$/.test(x.w) && x.w !== 'a') ||
    (/^[b-df-hj-np-tv-xz]{2,3}$/.test(x.w) && !FORMAT.has(x.w) && !ROLE.has(x.w)));        // SEO-3 (y counts as a vowel)

  // Pulls ISBNs out of the folded query (d7). Returns the text with ISBN spans blanked (\u0001 marks a removed span).
  function extractIsbns(q, Q) {
    const lab = q.replace(ISBN_LABEL, m => '\u0002' + ' '.repeat(m.length - 1));
    const rest = lab.replace(/[\u0001\u0002]/g, ' ').trim();
    const nDigits = (rest.match(/\d/g) || []).length;
    if (/^[\d\s-]+x?$/.test(rest) && nDigits >= 6 && !/^(?:19|20)\d\d\s*(?:-\s*(?:\d\d|(?:19|20)\d\d)|\s(?:19|20)\d\d)$/.test(rest)) {
      const groups = rest.split(/\s+/);
      if (groups.length === 1 || lab.includes('\u0002') || /^97[89]/.test(groups[0]) || !rest.split(/[\s-]+/).some(isYearTok)) {
        Q.isbnQuery = true;                                                                  // the whole query is one ISBN (or its start)
        Q.digits = rest.replace(/[\s-]/g, '');
        if (completeIsbn(Q.digits)) Q.isbn.push({ kind: 'isbn', key: isbnKey(Q.digits), d: Q.digits, text: Q.digits });
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
      } else if (completeIsbn(t)) d = t;                                                    // unbroken 10-char or 978/979 13-digit token
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
    const Q = { folded, units: [], req: [], fmt: [], isbn: [], years: [], etal: null, chunks: [], joins: [], isbnQuery: false,
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
    const lastIdx = unfinishedIn && moved === null && last >= 0 && !t2.slice(W[last].e).includes('\u0001') ? last : -1;
    // (d6) year ranges: 2023-2024, 2023/24, 2023 to 2024, "2008 2009" -> one optional unit (a lone 1984 stays a word)
    for (let i = 0; i < W.length; i++) {
      const a = W[i], b = W[i + 1];
      if (!isYearWord(a) || a.unit || !b) continue;
      let end = -1, j = i + 1;
      if (DASH_SP.test(b.brk) || /^\s*\/\s*$/.test(b.brk)) end = isYearWord(b) ? +b.w : b.digits && b.w.length === 2 ? Math.floor(+a.w / 100) * 100 + +b.w : -1;
      else if (b.w === 'to' && isYearWord(W[i + 2])) { end = +W[i + 2].w; j = i + 2; }
      else if (b.brk === ' ' && isYearWord(b) && +b.w === +a.w + 1) end = +b.w;
      if (end >= +a.w) { Q.years.push(unit('year', i, j, { start: +a.w, end })); i = j; }
    }
    // "et al" and a trailing "and others": one optional unit
    for (let i = 0; i + 1 < W.length; i++) if (W[i].w === 'et' && W[i + 1].w === 'al' && !W[i].unit) Q.etal = unit('etal', i, i + 1);
    if (W.length >= 2 && W[last - 1].w === 'and' && W[last].w === 'others' && !W[last].unit) Q.etal = unit('etal', last - 1, last);
    for (const p of W.pairs) {                                                             // label pairs and ranges: one unit each
      if (W[p.a].unit || W[p.b].unit) continue;
      const terms = [];
      if (p.rng) for (let k = p.rng.n; k <= Math.min(p.rng.m, p.rng.n + 200); k++) terms.push('#' + p.key + k);
      unit('pair', p.a, p.b, { p, key: p.key, v: p.v, terms: p.rng ? terms : p.terms, soft: p.key === 'edition', format: p.key === 'edition' });
    }
    for (const run of W.runs) if (!W[run.i].unit && !W[run.j].unit) unit('run', run.i, run.j, { run, last: run.j === lastIdx });
    W.forEach((x, i) => {                                                                   // edition statements are soft: "25th anniversary"
      if (x.num !== null && !x.unit && W[i + 1] && EDITION_WORDS.has(W[i + 1].w) && !W[i + 1].unit) { x.edition = true; W[i + 1].edition = true; }
    });
    W.forEach((x, i) => {
      if (x.unit) return;
      const u = unit('word', i, i, { w: x.w, x });
      u.small = SMALL.has(x.w);
      u.soft = !u.small && (FORMAT.has(x.w) || QUESTION.has(x.w) || ROLE.has(x.w) || PUBLISHER.has(x.w) || !!x.edition);
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
      mergeInto(map, allOf([group(run.i, sp - 1, run.two.A), group(sp, run.j, run.two.B)], K_ALT));
    }
    mergeInto(map, allOf(range(run.i, run.j).map(k => literal(ix, u, W[k], u.last && k === run.j, only))));
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
  function lookupUnit(ix, Q, u, only, map) {
    map = map || new Map();
    if (u.kind === 'word') {
      lookupForms(ix, u, u.forms, map, only, !u.req);                                       // optional words: exact / alternate only
      if (u.prefix) lookupPrefix(ix, u, u.w, map, only);
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
      for (const E of m.values()) for (const h of E.hits) if (h.f <= F_M) for (const u of [j.u1, j.u2]) addHit(u.map, Object.assign({}, h, { k: K_COMP, why: 'c1', q: j.u1.text + ' ' + j.u2.text }));
    }
    const cand = new Set();
    for (const u of Q.units.concat(Q.isbn)) if (u.req || u.format || u.kind === 'isbn') for (const [r, E] of u.map) if (E.c) cand.add(r);
    for (const u of Q.units) if (!u.req && !u.format && u.kind !== 'isbn' && u.kind !== 'year' && u.kind !== 'etal') lookupUnit(ix, Q, u, cand, u.map);
    // (e4) author words; (e6) one-word demotion; (e5e) two-author segments
    for (const u of Q.req) {
      u.authorWord = (u.a > 0 && Q.W[u.a - 1].w === 'by') || [...u.map.values()].some(E => E.hits.some(h => h.f === F_A && KIND_CLASS[h.k] === 3));
    }
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
        if (Q.W[u.a].brk.includes('/') && segs[segs.length - 1].length) segs.push([]);
        if (u.req) segs[segs.length - 1].push(u);
      }
      const s = segs.filter(x => x.length);
      if (s.length >= 2 && s.every(x => x.length <= 4)) Q.segments = s;
    }
    for (const r of cand) { const res = judge(ix, Q, r); if (res) out.rows.set(r, res); }
    return out;
  }

  // Short words and initials are optional for a row when the nearest non-SMALL query word beside them hit its Author (e3).
  function besideAuthor(Q, u, r) {
    const list = Q.ordered.filter(v => v === u || !v.small), i = list.indexOf(u);
    for (const v of [list[i - 1], list[i + 1]]) {
      const E = v && v.map && v.map.get(r);
      if (E && E.hits.some(h => h.f === F_A)) return v;
    }
    return null;
  }
  const hitSpan = h => (h.wi <= h.wj ? [h.wi, h.wj] : [h.wj, h.wi]);
  function judge(ix, Q, r) {
    const doc = ix.docs[r], E = u => (u.map && u.map.get(r)) || null;
    const req = [], exempt = [];
    for (const u of Q.req) { const nb = u.short ? besideAuthor(Q, u, r) : null; if (nb) exempt.push([u, nb]); else req.push(u); }
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
    let authorWordHit = false, authorWordExact = false;
    for (const u of Q.units) {
      const e = !u.small && E(u);
      if (e) for (const h of e.hits) {
        if (h.k === K_LOOSE) continue;
        const [a, b] = hitSpan(h);
        if (h.f === F_T) for (let k = a; k <= b; k++) tHit.set(k, tHit.get(k) || isExactish(h.k));
        if (h.f === F_A && KIND_CLASS[h.k] === 3 && doc.authorWordIdx.has(a)) { authorWordHit = true; if (isExactish(h.k)) authorWordExact = true; }
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
      const byName = T.length > 0 && T.every(it => it.wis.some(k => tHit.has(k)));
      if (byName || authorWordExact) {
        pinned = true;
        if (tier !== 'match') tier = 'close';
        why.unshift(`covers a whole series: its ${byName ? 'series name' : 'author'} is in your search`);
      }
    }
    if (!tier) {                                                                           // (e5e) Possible
      let k = 0;
      if (Q.segments) for (const seg of Q.segments) if (seg.every(u => { const e = E(u); return e && e.hits.some(h => h.f === F_A && KIND_CLASS[h.k] === 3); })) k++;
      if (anchors >= 1 && doc.authorless && unanchored.length && unanchored.every(u => u.authorWord)) { tier = 'possible'; why.push('author not listed'); }
      else if (k >= 1) { tier = 'possible'; why.push(`matched ${k} of ${Q.segments.length} authors`); }
      else if (anchors >= 1 && anchors * 2 >= R) { tier = 'possible'; why.push(`matched ${anchors} of ${R} words`); }
      else if (demoted) tier = 'possible';
      else if (gate && allHit && loose) { tier = 'possible'; if (R > 1) why.push(`matched ${anchors} of ${R} words`); }
    }
    if (!tier) return null;
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
      if (u.req && e.hits.some(x => x.f === F_A)) { authorUnits++; if (e.hits.some(x => x.f === F_A && KIND_CLASS[x.k] === 3)) author1 = true; }
    }
    const year = Q.years.some(y => doc.year && doc.year.start === y.start && doc.year.end === y.end);
    // "given names differ" (e3): an optional initial that did not match and is not the first letter of the other names
    let givenNamesDiffer = false;
    for (const [u, nb] of exempt) {
      const e = E(u);
      if (e && (e.c || e.m)) continue;
      const used = new Set();
      for (const h of nb.map.get(r).hits) if (h.f === F_A) { const [a, b] = hitSpan(h); for (let x = a; x <= b; x++) used.add(x); }
      const others = doc.fw[F_A].W.filter((x, i) => !x.skip && !used.has(i) && !ROLE.has(x.w) && HAS_L.test(x.w)).map(x => x.w[0]).join('');
      if ((u.x.initials || [u.w]).join('') !== others) givenNamesDiffer = true;
    }
    return { r, doc, tier, why, pinned, Q, isbnExact, titleEq, author1: author1 && Q.req.length === 1, year, anchors, inOrder,
      authorUnits: Q.req.length > 1 ? authorUnits : 0, optMatched, quality, givenNamesDiffer, via: '', demoted };
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
  // (d13) alias widening: a complete alias name in the query is replaced by each other name of its group (8 at most).
  function aliasQueries(ix, Q) {
    const out = [], W = Q.W.filter(x => !SMALL.has(x.w));
    for (const group of ix.aliases) for (const name of group) {
      const k = name.key;
      for (let i = 0; i + k.length <= W.length && out.length < 8; i++) {
        if (!k.every((w, j) => W[i + j].w === w)) continue;
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
    for (const u of o.Q.units) {
      const e = u.map && u.map.get(o.r), h = e && (e.c || e.m);
      if (!h) continue;
      if (h.why === 'fz' && (o.tier !== 'possible' || o.demoted)) spell.push(`similar spelling: ${cell(h)}`);
      else if (h.why === 'c2' && o.tier !== 'possible') spell.push(`written as two words: ${cell(h)}`);
      else if (h.why === 'c1' && o.tier !== 'possible') spell.push(`written as one word: ${cell(h)}`);
      else if (h.k === K_LOOSE && h.why === 'lo') loose.push(`other number: ${cell(h)}`);
      else if ((h.why === 'eq' || h.why === 'pair') && bare(h.q) !== bare(cell(h))) expl.push(`${h.q} = ${cell(h)}`);
    }
    const lead = out.filter(x => /^(?:via alias|searched without|same title|covers a whole|the whole listed title)/.test(x));
    const list = lead.concat(spell, out.filter(x => !lead.includes(x)), loose, o.givenNamesDiffer ? ['given names differ'] : [], expl.slice(0, 3));
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
      for (const h of e.hits) if (h.f <= F_I && KIND_CLASS[h.k] === cls) (u.small ? small : byField[h.f]).push(h);
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
      const merged = [];
      for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice());
      }
      out[name] = merged;
    });
    return out;
  }
  function fieldsFor(o) {
    const seen = new Set(o.stop ? [F_T] : []);
    for (const u of o.Q.units.concat(o.Q.isbn)) {
      const e = !u.small && u.map && u.map.get(o.r);
      if (e) for (const h of e.hits) seen.add(h.f);
    }
    return FIELD_ORDER.filter(f => seen.has(f)).map(f => FIELD_NAMES[f]);
  }
  // (f2) sort key, larger first; ties by row id
  const rankKey = (o, main) => [main && o.pinned ? 1 : 0, o.isbnExact ? 1 : 0, o.via ? 0 : 1, o.titleEq ? 1 : 0, o.author1 ? 1 : 0,
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
    const unfinished = !truncated && !/\s$/.test(text);                                   // (d2) a trailing space finishes the word
    const base = evaluate(ix, text, unfinished), Q = base.Q, rows = base.rows;
    res.isbnQuery = Q.isbnQuery;
    if (base.state !== 'ok') { res.state = base.state; return res; }
    if (Q.foreign) {                                                                      // (d12) run 2 without the foreign article
      for (const [r, o] of evaluate(ix, Q.foreign.text, unfinished).rows) {
        const t = o.tier === 'possible' ? 'possible' : 'close', b = rows.get(r);
        if (!b || TIER_RANK[t] > TIER_RANK[b.tier]) rows.set(r, Object.assign({}, o, { tier: t, via: 'foreign', pinned: false, why: [`searched without "${Q.foreign.word}"`].concat(o.why) }));
      }
    }
    for (const a of Q.W.length ? aliasQueries(ix, Q) : []) {                               // (d13) alias widening
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
    const all = [...rows.values()];
    const main = ranked(all.filter(o => o.tier !== 'possible'), true), possible = ranked(all.filter(o => o.tier === 'possible'), false);
    res.main = main.map(x => toHit(x.o, x.size));
    res.possible = possible.map(x => toHit(x.o, x.size));
    const isbnMatched = all.some(o => o.isbnExact);
    if (Q.isbnQuery && Q.digits.length >= 6 && Q.digits.length <= 13 && !isbnMatched) {     // (e8) "ISBN starts with…"
      const F = ix.isbnForms, d = Q.digits, inMain = new Set(main.map(x => x.o.r)), seen = new Set(), found = [];
      let lo = 0, hi = F.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (F[mid].f < d) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < F.length && F[i].f.startsWith(d); i++) if (!inMain.has(F[i].r) && !seen.has(F[i].r)) { seen.add(F[i].r); found.push(F[i]); }
      found.sort((a, b) => ix.docs[a.r].id - ix.docs[b.r].id);
      res.isbnPrefix = found.map(x => {
        const doc = ix.docs[x.r];
        return { row: doc.row, tier: 'possible', score: 0, reasons: [`ISBN starts with ${d}`], fields: ['isbn'],
          display: { title: doc.display, titleAsWritten: String(doc.row.title ?? '') }, highlights: { title: [], author: [], memo: [], isbn: [[x.s, x.e]] },
          notes: doc.notes.slice(), groupKey: doc.groupKey, groupSize: 1 };
      });
    }
    res.hints = hintsFor(ix, Q, res, enter, unfinished, isbnMatched);
    return res;
  }

  // ---------- (g3) hints: only when state is ok; never claim an item is permitted ----------
  function hintsFor(ix, Q, res, enter, unfinished, isbnMatched) {
    const empty = !res.main.length && !res.possible.length && !res.isbnPrefix.length, W = Q.W, last = W[W.length - 1];
    if (!enter && empty && unfinished && last && last.w.length <= 2 && !Q.isbnQuery) {
      return [{ code: 'keepTyping', text: 'Keep typing: word endings are matched from the third letter.' }];
    }
    const hints = [];
    if ((Q.isbnQuery || Q.hasCompleteIsbn) && !isbnMatched && !res.isbnPrefix.length && !res.main.length) {
      hints.push({ code: 'isbnNoMatch', text: `No ISBN match. ${ix.isbnRowCount * 2 >= ix.rowCount ? 'Some' : 'Most'} rows have no ISBN, so search the title and author.` });
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
