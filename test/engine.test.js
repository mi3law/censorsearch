// Tests for src/engine.js (CensorEngine).
//   1. unit tests: fold, tokenizer alternates, ISBNs, display titles, splitLines, highlights (synthetic rows only);
//   2. regression: the 180 prototype/queries.js queries on the sample rows, with the PRD overrides of test/prd-cases.js;
//   3. PRD acceptance: every case of test/prd-cases.js, one test per case.
// Suites 2 and 3 need the gitignored sample .xlsx in the repo root and skip with a message when it is absent.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const { hasSample, loadSampleRows, toRow, rowId } = require('./helpers/sample.js');
const { syntheticRows, cases, queryOverrides, aliases } = require('./prd-cases.js');

const SKIP_SAMPLE = hasSample() ? false : 'sample .xlsx not found in the repo root (it is gitignored); sample-based tests skipped';
const synthRows = (offset = 0) => syntheticRows.map((r, i) => toRow(r, offset + i));
let synthIx = null;
const synth = () => synthIx || (synthIx = E.buildIndex(synthRows(), { aliases }));
let sampleCache = null;
function sample() {                                            // sample rows followed by the synthetic rows, as in prd-cases.js
  if (!sampleCache) {
    const s = loadSampleRows();
    const rows = s.concat(synthRows(s.length));
    sampleCache = { rows, ix: E.buildIndex(rows, { aliases }) };
  }
  return sampleCache;
}
const ids = hits => hits.map(h => rowId(h.row));
const find = (res, id) => [...res.main, ...res.possible, ...res.isbnPrefix].find(h => rowId(h.row) === id);
const words = text => E._internal.analyze(E.fold(text));
const terms = text => { const W = words(text); return W.map(x => [x.w, ...x.alts.map(a => a[0])]); };

// ---------------------------------------------------------------------------------------------------------------
// 1. Unit tests
// ---------------------------------------------------------------------------------------------------------------
test('fold: case, accents, special letters, full-width, ligatures and Arabic-Indic digits', () => {
  assert.equal(E.fold('AMPLIFY  CKLA'), 'amplify ckla');
  assert.equal(E.fold('Brontë Pokémon Dąbrowski'), 'bronte pokemon dabrowski');
  assert.equal(E.fold('Straße Æsop Øre Łódź'), 'strasse aesop ore lodz');
  assert.equal(E.fold('ＡＭＰＬＩＦＹ ４'), 'amplify 4');
  assert.equal(E.fold('ﬁsh №5'), 'fish no5');
  assert.equal(E.fold('١٩٨٤ ۱۹۸۴'), '1984 1984');
  assert.equal(E.fold(1984), '1984');
  assert.equal(E.fold(null), '');
});
test('fold: apostrophes are unified before NFKD, marks become spaces, invisible characters join words', () => {
  assert.equal(E.fold('Aaron’s Aaron´s Aaron`s'), "aaron's aaron's aaron's");
  assert.equal(E.fold('Pokémon™ Adventures'), 'pokemon adventures');
  assert.equal(E.fold('Fah\u200Brenheit Fahr\u00ADen\u00ADheit'), 'fahrenheit fahrenheit');
  assert.equal(E.fold(' where\u00A0the\ncrawdads\u3000sing '), 'where the crawdads sing');
});
test('fold: &, a spaced +, rock \'n\' roll, digit-group commas and the symbol table', () => {
  assert.equal(E.fold('Jekyll & Hyde'), 'jekyll and hyde');
  assert.equal(E.fold('AT&T'), 'at and t');
  assert.equal(E.fold('360 + more'), '360 and more');
  assert.equal(E.fold('2+2'), '2+2');
  assert.equal(E.fold("rock 'n' roll"), 'rock and roll');
  assert.equal(E.fold('20,000 Leagues; 1,000,000; 2012,2013; 1,2,3'), '20000 leagues; 1000000; 2012,2013; 1,2,3');
  assert.equal(E.fold('C++ for Teens, A+ Spelling, C# and F#'), 'cplusplus for teens, aplus spelling, csharp and fsharp');
});
test('foldWithMap maps every folded character back to its source range', () => {
  const st = E.foldWithMap('Straße 20,000');
  assert.equal(st.s, 'strasse 20000');
  assert.deepEqual([st.a[4], st.b[4], st.a[5], st.b[5]], [4, 5, 4, 5]);           // ß -> ss: both from source [4, 5)
  assert.deepEqual([st.a[8], st.b[12]], [7, 13]);                                    // 20000 spans "20,000"
});

test('normalizeTitleForDisplay moves a trailing article to the front and nothing else', () => {
  const cases = {
    '7th Knot, The': 'The 7th Knot', '2nd Helping of Chicken Soup, A': 'A 2nd Helping of Chicken Soup',
    'Alchemist, The: A Fable About Following Your Dream': 'The Alchemist: A Fable About Following Your Dream',
    'Tin Compass, The (Revised)': 'The Tin Compass (Revised)', 'Glass Owl, The – A Winter Riddle': 'The Glass Owl – A Winter Riddle',
    'Hobbit, The.': 'The Hobbit.', 'Petit Prince, Le': 'Le Petit Prince', 'Alquimista, El': 'El Alquimista',
    'Forty Rules of Love,\u00A0The ': 'The Forty Rules of Love', 'Where the\nCrawdads Sing ': 'Where the Crawdads Sing',
    'Lion, the Witch and the Wardrobe, The': 'The Lion, the Witch and the Wardrobe',
    'Anthem, An Epic': 'Anthem, An Epic', 'Buffalo, A Novel': 'Buffalo, A Novel', 'Seashells, A-Z': 'Seashells, A-Z',
    'Seashells, A – Z': 'Seashells, A – Z', 'Hello, A-Team': 'Hello, A-Team', '451 Farenheit': '451 Farenheit',
    '1984: A DVD Study Guide+3:15A13:153:173:193:401': '1984: A DVD Study Guide+3:15A13:153:173:193:401', '': '',
  };
  for (const [a, b] of Object.entries(cases)) assert.equal(E.normalizeTitleForDisplay(a), b, a);
  assert.equal(E.normalizeTitleForDisplay(1984), '1984');
});

test('splitLines: non-empty trimmed lines; one line or blank text stay as they are', () => {
  assert.deepEqual(E.splitLines('Fahrenheit 451\n1984\r\n  The 7th Knot  \n\n   \n'), ['Fahrenheit 451', '1984', 'The 7th Knot']);
  assert.deepEqual(E.splitLines('a\u2028b\u2029c\rd\u0085e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(E.splitLines('one line'), ['one line']);
  assert.deepEqual(E.splitLines('   '), []);
  assert.deepEqual(E.splitLines('!!!\n\u200B'), []);
});

test('tokenizer: apostrophes give the word plus the possessive stem or elision remainder only', () => {
  assert.deepEqual(terms("Aaron's"), [['aarons', 'aaron']]);
  assert.deepEqual(terms('L’Engle O\'Brien'), [['lengle', 'engle'], ['obrien', 'brien']]);
  assert.deepEqual(terms('Don’t can’t'), [['dont'], ['cant']]);
});
test('tokenizer: hyphen and letter-digit chunks join, but two numbers never do', () => {
  const W = words('20 10-Minute Plays, Jack-in-the-Box, covid19, 2012-2013, 9–11, 1/2, 3:15');
  const joins = W.chunks.flatMap(c => c.joins.map(j => j.t));
  assert.ok(joins.includes('10minute') && joins.includes('jackinthebox') && joins.includes('jackin') && joins.includes('covid19'));
  for (const bad of ['201213', '20122013', '911', '12', '315', '2010']) assert.ok(!joins.includes(bad), bad);
  assert.ok(!W.some(x => x.alts.some(a => a[0] === '2010' || a[0] === '12')));
  assert.deepEqual(W.filter(x => x.w === 'minute' || x.w === '10').map(x => x.w), ['10', 'minute']);
});
test('tokenizer: initials merge into one word; a single letter does not', () => {
  for (const q of ['R.L. Stine', 'R. L. Stine', 'r l stine']) assert.deepEqual(words(q).map(x => x.w), ['rl', 'stine'], q);
  assert.deepEqual(words('T.J. Haverstock')[0].initials, ['t', 'j']);
  assert.deepEqual(words('Plan B').map(x => x.w), ['plan', 'b']);
  assert.deepEqual(words('a b').map(x => x.w), ['a', 'b']);
});
test('tokenizer: numbers, ordinals, misspellings, run-together words and Roman numerals get digit alternates', () => {
  assert.deepEqual(terms('seventh 7th 2nd'), [['seventh', '7th', '7'], ['7th', '7'], ['2nd', '2th', '2']]);
  assert.deepEqual(terms('seven thirteen'), [['seven', '7'], ['thirteen', '13']]);
  assert.deepEqual(terms('fourty'), [['fourty', 'forty', '40']]);
  assert.deepEqual(terms('twentyone nineteeneightyfour tenfour'), [['twentyone', '21'], ['nineteeneightyfour', '1984'], ['tenfour']]);
  assert.deepEqual(terms('viii xx mix liv vix i'), [['viii', '8'], ['xx', '20'], ['mix'], ['liv'], ['vix'], ['i']]);
  assert.deepEqual(terms('seconds'), [['seconds']]);                                   // PN-0: never read as an ordinal
  assert.deepEqual(terms('four oh'), [['four', '4'], ['oh']]);
});
test('tokenizer: number-word runs read as one value (years, spoken digit groups, hundreds, thousands)', () => {
  const runs = q => words(q).runs.map(r => r.vals.join('/'));
  assert.deepEqual(runs('nineteen eighty-four'), ['1984']);
  assert.deepEqual(runs('four fifty-one'), ['451']);
  assert.deepEqual(runs('two eleven things'), ['211']);
  assert.deepEqual(runs('one hundred and one'), ['101']);
  assert.deepEqual(runs('nineteen hundred eighty four'), ['1984']);
  assert.deepEqual(runs('two thousand one'), ['2001']);
  assert.deepEqual(runs('20 thousand leagues'), ['20000']);
  assert.deepEqual(runs('twenty ten minute'), ['2010']);
  assert.deepEqual(runs('twenty-one'), ['21']);
  assert.deepEqual(runs('ten four'), []);
  assert.deepEqual(words('nineteen eighty-four').runs[0].two, { v: 1984, A: 19, B: 84, split: 1 });
});
test('tokenizer: label + number pairs, ranges, ordinals, # and kindergarten', () => {
  const pairs = q => words(q).pairs.flatMap(p => p.terms);
  assert.deepEqual(pairs('Volume One'), ['#book1']);
  assert.deepEqual(pairs('Volume II'), ['#book2']);
  assert.deepEqual(pairs('Class - 8'), ['#grade8']);
  assert.deepEqual(pairs('class viii'), ['#grade8']);
  assert.deepEqual(pairs('5th grade, second book'), ['#grade5', '#book2']);
  assert.deepEqual(pairs('(A Series of Unfortunate Events, #3)'), ['#book3']);
  assert.deepEqual(pairs('Grade K'), ['#grade0']);
  assert.deepEqual(pairs('Zebra Phonics – Kindergarten'), ['#grade0']);
  assert.deepEqual(pairs('Wings of Fire, Books 4–6'), ['#book4', '#book5', '#book6']);
  assert.deepEqual(pairs('Grades K to 2'), ['#grade0', '#grade1', '#grade2']);
  assert.deepEqual(pairs('Harry Potter Books 1–30'), ['#book1', '#book30']);
  assert.deepEqual(pairs('Activity Book – Grade 5'), ['#grade5']);
  assert.deepEqual(pairs('Planet X, Malcolm X, A Series of'), []);
  assert.deepEqual(words('9/11 Report').slice(0, 2).map(x => x.alts.map(a => a[0])), [['9', '911'].slice(1), ['11', '911'].slice(1)]);
});

test('ISBN cells: formats, several ISBNs, placeholders, lost leading zero, scientific notation', () => {
  const runs = v => E._internal.isbnRuns(v).map(x => x.d);
  assert.deepEqual(runs('9798891808546'), ['9798891808546']);
  assert.deepEqual(runs('ISBN-13: 979-8-89180-854-6'), ['9798891808546']);
  assert.deepEqual(runs('306406152'), ['0306406152']);
  assert.deepEqual(runs('81-7450-835-X'), ['817450835x']);
  assert.deepEqual(runs('9781234567897 / 0-9752298-0-X'), ['9781234567897', '097522980x']);
  assert.deepEqual(runs('9780141036144 or 9780452284234'), ['9780141036144', '9780452284234']);
  for (const v of ['N/A', '-', '—', 'none', 'Not available', '9.79889E+12', '', '1234']) assert.deepEqual(runs(v), [], v);
  const [x] = E._internal.isbnRuns('see 9781234567897 inside');
  assert.deepEqual([x.s, x.e], [4, 17]);
});
test('ISBN search: check digits ignored, ISBN-10 and -13 meet, prefixes while typing, no-match hint', () => {
  const ix = synth();
  const main = q => ids(E.search(q, ix).main);
  assert.deepEqual(main('0-306-40615-2'), ['XT9']);
  assert.deepEqual(main('ISBN 978 0 306 40615 7'), ['XT9']);
  assert.deepEqual(main('9780306406150'), ['XT9']);                                   // wrong check digit
  assert.deepEqual(main('0-9752298-0-X'), ['XT10']);
  assert.deepEqual(main('9780975229804'), ['XT10']);
  let r = E.search('978-0-306', ix);
  assert.equal(r.isbnQuery, true);
  assert.deepEqual(ids(r.isbnPrefix), ['XT9']);
  assert.deepEqual(r.isbnPrefix[0].reasons, ['ISBN starts with 9780306']);
  r = E.search('97988912', ix);
  assert.deepEqual([r.main.length, r.isbnPrefix.length], [0, 0]);
  assert.ok(r.hints.some(h => h.code === 'isbnNoMatch' && /^No ISBN match\. Most rows have no ISBN/.test(h.text)));
  r = E.search('979', ix);
  assert.equal(r.isbnQuery, false);
  assert.deepEqual(r.isbnPrefix, []);
  r = E.search('little blue 13 2008 2009 1320082009x', ix);
  assert.ok(!ids(r.main).includes('XT13'));
});
test('ISBN in a longer query is optional, and an exact hit is a Match on its own', () => {
  const r = E.search('the wide window 0306406152', synth());
  assert.deepEqual(r.main.map(h => [rowId(h.row), h.tier]), [['XT9', 'match']]);
  assert.deepEqual(r.main[0].fields, ['isbn']);
  assert.deepEqual(r.main[0].highlights.isbn, [[0, 9]]);
});

test('search states: empty, tooShort, stopwordsOnly and the long-text truncation', () => {
  const ix = synth();
  for (const q of ['', '   ', '!!!', '"', '*']) { assert.equal(E.search(q, ix).state, 'empty', q); assert.equal(E.search(q, ix, { enter: true }).state, 'empty'); }
  assert.equal(E.search('x', ix).state, 'tooShort');
  assert.equal(E.search('x', ix, { enter: true }).state, 'ok');
  assert.equal(E.search('the', ix).state, 'stopwordsOnly');
  assert.equal(E.search('2008-2009', ix).state, 'stopwordsOnly');
  const r = E.search('the the', ix);
  assert.deepEqual([r.state, ids(r.main)], ['ok', ['XA19']]);
  const long = 'Copper kettle lagoon ' + 'word '.repeat(80);
  const t = E.search(long, ix);
  assert.equal(t.truncated, true);
  assert.equal(t.query, 'Copper kettle lagoon ' + 'word '.repeat(9).trim());
  assert.equal(E.search('x'.repeat(10) + ' ' + 'a '.repeat(200), ix).truncated, false);
});
test('tiers on synthetic rows: exact, alternate, prefix, compound, fuzzy, possible', () => {
  const ix = synth();
  const tiers = q => E.search(q, ix).main.concat(E.search(q, ix).possible).map(h => rowId(h.row) + ':' + h.tier);
  assert.deepEqual(tiers('twenty one balloons').slice(0, 1), ['XN1:match']);
  assert.deepEqual(tiers('spiderman').slice(0, 1), ['XN10:match']);
  assert.deepEqual(tiers('super man adventures').slice(0, 1), ['XN11:close']);
  assert.deepEqual(tiers('quillmer').slice(0, 1), ['XS1:match']);                   // unfinished last word: prefix
  assert.deepEqual(tiers('quilmere hollow').slice(0, 1), ['XS1:close']);            // one edit
  assert.deepEqual(tiers('color of harbor lights'), ['XS2:match']);
  assert.ok(tiers('marzipan xylophone').includes('XR7:possible'));
  const r = E.search('quilmere hollow', ix);
  assert.ok(r.main[0].reasons.includes('similar spelling: Quillmere'));
});
test('highlights point into display.title and row.author, prefix and compound included', () => {
  const ix = synth();
  let h = find(E.search('the forty rules', ix), 'XN4');
  assert.equal(h.display.title, 'The Forty Rules of Love');
  assert.deepEqual(h.highlights.title, [[0, 3], [4, 9], [10, 15]]);
  h = find(E.search('odalys pemb', ix), 'XR1');
  assert.deepEqual(h.highlights.author, [[0, 6], [7, 11]]);                          // "Pemb" of Pemberton
  assert.deepEqual(find(E.search('zephyrine almanac', ix), 'XR1').highlights.title, [[0, 9], [10, 17]]);
  h = find(E.search('twenty one balloons', ix), 'XN1');
  assert.deepEqual(h.highlights.title, [[4, 14], [15, 23]]);                         // "Twenty-One" literally: no explanation
  assert.deepEqual(h.reasons, []);
  h = find(E.search('21 balloons', ix), 'XN1');
  assert.deepEqual([h.tier, h.reasons, h.highlights.title], ['match', ['21 = Twenty-One'], [[4, 14], [15, 23]]]);
  assert.deepEqual(find(E.search('spider man', ix), 'XN10').highlights.title, [[0, 6], [7, 10], [21, 27]]);
});
test('hints: keepTyping, etAl, authorHasOthers, acronym, seriesTip', () => {
  const ix = synth();
  const codes = (q, o) => E.search(q, ix, o).hints.map(h => h.code);
  assert.deepEqual(codes('zq'), ['keepTyping']);
  assert.deepEqual(codes('zq ', {}), ['seriesTip']);
  assert.ok(codes('nandakumar lighthouse').includes('seriesTip'));
  const r = E.search('kallas moonrise', ix);
  assert.ok(r.hints.some(x => x.code === 'authorHasOthers' && x.text === "Imre Kallas has other listed items; search 'Kallas'"));
  assert.ok(codes('next generation science standards').includes('acronym'));
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Regression: prototype/queries.js with the PRD overrides (prd-cases.js queryOverrides)
// ---------------------------------------------------------------------------------------------------------------
test('regression: prototype/queries.js recall, main-list recall, floods and false positives', { skip: SKIP_SAMPLE }, () => {
  const { ix } = sample();
  const { Q } = require('../prototype/queries.js');
  let rowsExp = 0, found = 0, inMain = 0, floods = [], fps = [], misses = [];
  for (const t0 of Q) {
    const o = queryOverrides[t0.q] || {};
    if (o.drop) continue;
    const t = Object.assign({}, t0, o.exp ? { exp: o.exp, uns: false } : {}, o.ok ? { ok: o.ok } : {});
    if (t.uns) continue;
    const r = E.search(t.q, ix, { enter: !!t.enter });
    const M = ids(r.main), P = ids(r.possible), X = ids(r.isbnPrefix);
    const okSet = new Set([...t.exp, ...(t.ok || [])]);
    const noise = list => list.filter(id => /^[SO]\d/.test(id) && !okSet.has(id));
    rowsExp += t.exp.length;
    for (const e of t.exp) {
      if (M.includes(e) || P.includes(e) || X.includes(e)) found++; else misses.push(`${t.q} -> ${e}`);
      // The PRD moves partial ISBNs (6-13 digits, no exact hit) out of the main list into their own "ISBN starts with…"
      // group; the prototype listed them as strong. That group is the main list for those queries.
      if (M.includes(e) || (r.isbnQuery && X.includes(e))) inMain++;
    }
    const nM = noise(M), nAll = noise([...M, ...P, ...X]);
    if (nM.length >= 2 || nAll.length >= 4) floods.push(`${t.q}: ${nAll.join(',')}`);
    if (!t.exp.length && nM.length) fps.push(`${t.q}: ${nM.join(',')}`);
  }
  const summary = `recall ${found}/${rowsExp}, main ${inMain}/${rowsExp}, floods ${floods.length}, false positives ${fps.length}`;
  console.log('    ' + summary);
  assert.deepEqual(misses, [], summary);
  assert.ok(inMain >= rowsExp - 3, `${summary}: expected rows in the main list must be at least ${rowsExp - 3} (prototype: 159 of 162)`);
  assert.deepEqual(floods, [], summary);
  assert.deepEqual(fps, [], summary);
});

// ---------------------------------------------------------------------------------------------------------------
// 3. PRD acceptance cases (test/prd-cases.js): one test per case, on the sample rows + synthetic rows + aliases
// ---------------------------------------------------------------------------------------------------------------
function checkCase(c, res) {
  const M = ids(res.main), P = ids(res.possible), X = ids(res.isbnPrefix), all = [...M, ...P, ...X];
  const tierOf = id => (res.main.find(h => rowId(h.row) === id) || {}).tier;
  const x = c.expect, fail = [];
  const need = (ok, msg) => { if (!ok) fail.push(msg); };
  for (const id of x.match || []) need(tierOf(id) === 'match', `${id} should be a Match (tier: ${tierOf(id) || (all.includes(id) ? 'possible' : 'absent')})`);
  for (const id of x.close || []) need(tierOf(id) === 'close', `${id} should be Close (tier: ${tierOf(id) || (all.includes(id) ? 'possible' : 'absent')})`);
  for (const id of x.main || []) need(M.includes(id), `${id} should be in main`);
  for (const id of x.possible || []) need(P.includes(id), `${id} should be in possible`);
  for (const id of x.isbnPrefix || []) need(X.includes(id), `${id} should be in isbnPrefix`);
  for (const id of x.any || []) need(all.includes(id), `${id} should be listed`);
  for (const id of x.absent || []) need(!all.includes(id), `${id} should be absent`);
  for (const id of x.notMain || []) need(!M.includes(id), `${id} should not be in main`);
  if (x.first) need(M[0] === x.first, `main[0] should be ${x.first}, got ${M[0]}`);
  for (const [a, b] of x.before || []) {
    const order = [...M, ...P];
    need(order.includes(a) && order.includes(b) && order.indexOf(a) < order.indexOf(b), `${a} should come before ${b}`);
  }
  if (x.state) need(res.state === x.state, `state should be ${x.state}, got ${res.state}`);
  if (x.hint) need(res.hints.some(h => h.code === x.hint), `hint ${x.hint} missing (got ${res.hints.map(h => h.code).join(',') || 'none'})`);
  for (const { row, includes } of x.reasons || []) {
    const h = find(res, row);
    need(!!h && h.reasons.some(r => r.includes(includes)), `${row} reasons should include "${includes}" (got ${h ? JSON.stringify(h.reasons) : 'no hit'})`);
  }
  for (const { row, includes } of x.notes || []) {
    const h = find(res, row);
    need(!!h && h.notes.some(n => n.includes(includes)), `${row} notes should include "${includes}" (got ${h ? JSON.stringify(h.notes) : 'no hit'})`);
  }
  for (const { row, equals } of x.displayTitle || []) {
    const h = find(res, row);
    need(!!h && h.display.title === equals, `${row} display.title should be "${equals}" (got ${h ? JSON.stringify(h.display.title) : 'no hit'})`);
  }
  if (x.maxMain !== undefined) need(M.length <= x.maxMain, `main should have at most ${x.maxMain} rows, got ${M.length}`);
  if (x.maxTotal !== undefined) need(all.length <= x.maxTotal, `at most ${x.maxTotal} rows in total, got ${all.length}`);
  return fail;
}
const summaryOf = res => `main=[${res.main.map(h => rowId(h.row) + ':' + h.tier[0]).join(' ')}] possible=[${ids(res.possible).join(' ')}] ` +
  `isbnPrefix=[${ids(res.isbnPrefix).join(' ')}] state=${res.state} hints=[${res.hints.map(h => h.code).join(',')}]`;

for (const c of cases) {
  const name = `${c.rule}: ${JSON.stringify(c.q.length > 70 ? c.q.slice(0, 67) + '…' : c.q)}${c.enter ? ' (Enter)' : ''}`;
  test(name, { skip: SKIP_SAMPLE }, () => {
    const res = E.search(c.q, sample().ix, { enter: !!c.enter });
    const fail = checkCase(c, res);
    assert.deepEqual(fail, [], `${fail.join('; ')}\n      ${summaryOf(res)}`);
  });
}

test('PRD highlight examples on sample rows', { skip: SKIP_SAMPLE }, () => {
  const { ix } = sample();
  const hl = (q, id) => find(E.search(q, ix), id).highlights.title;
  assert.deepEqual(hl('the seventh knot', 'S20'), [[0, 3], [4, 7], [8, 12]]);
  assert.deepEqual(hl('grandmother stories', 'S5'), [[4, 11], [15, 27]]);
  assert.deepEqual(hl('fahrenheit 451', 'S16'), [[0, 3], [4, 13]]);
  assert.deepEqual(hl('1984 study guide', 'S8'), [[0, 4], [12, 17], [18, 23]]);
  assert.deepEqual(find(E.search('orw', ix), 'S9').highlights.author, [[7, 10]]);
});
test('long pasted text is cut after its 12th main word', { skip: SKIP_SAMPLE }, () => {
  const LONG1 = cases.find(c => c.rule === 'SEO-6').q;
  const r = E.search(LONG1, sample().ix);
  assert.equal(r.truncated, true);
  assert.equal(r.query, 'The 7th Knot by Kathleen Karr. A gripping mystery adventure for young readers set in Paris, where');
});

test('SearchResult and Hit carry every field of the build contract', () => {
  const r = E.search('velvet quarry', synth());
  assert.deepEqual(Object.keys(r).sort(), ['hints', 'isbnPrefix', 'isbnQuery', 'main', 'possible', 'query', 'state', 'truncated']);
  assert.deepEqual(r.main.map(h => rowId(h.row)), ['XT6', 'XT5', 'XT7']);                // one group, the Ministry row first
  for (const h of r.main) {
    assert.deepEqual(Object.keys(h).sort(), ['display', 'fields', 'groupKey', 'groupSize', 'highlights', 'notes', 'reasons', 'row', 'score', 'tier']);
    assert.equal(typeof h.score, 'number');
    assert.deepEqual(Object.keys(h.highlights).sort(), ['author', 'isbn', 'memo', 'title']);
    assert.equal(h.groupSize, 3);
    assert.equal(h.groupKey, r.main[0].groupKey);
    assert.deepEqual(h.fields, ['title']);
  }
  assert.ok(r.main[0].row === synth().rows.find(x => rowId(x) === 'XT6'));              // the same Row object
  assert.deepEqual(r.main[2].display, { title: 'The Velvet Quarry', titleAsWritten: 'Velvet Quarry, The' });
  assert.deepEqual(E.search('kallas', synth()).main[0].fields, ['author']);
});
test('aliases widen a query only through a complete alias name, labelled "via alias"', () => {
  const ix = synth();
  const h = E.search("philosopher's stone of brackenmoor", ix).main[0];
  assert.equal(rowId(h.row), 'XS21');
  assert.equal(h.reasons[0], "via alias: philosopher's stone → Sorcerer's Stone");
  assert.equal(E.buildIndex(synthRows()).aliases.length, 0);                            // no aliases file: no widening
  assert.ok(!ids(E.search("philosopher's stone of brackenmoor", E.buildIndex(synthRows())).main).includes('XS21'));
  const bad = E.buildIndex(synthRows(), { aliases: { aliases: [{ names: ['only one'] }, null, { names: [1, 2] }] } });
  assert.equal(bad.aliases.length, 0);
});
