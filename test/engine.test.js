// Tests for src/engine.js (CensorEngine).
//   1. unit tests: fold, tokenizer alternates, ISBNs, display titles, splitLines, highlights (synthetic rows only);
//   2. regression: the 180 prototype/queries.js queries on the sample rows, with the PRD overrides of test/prd-cases.js;
//   3. PRD acceptance: every case of test/prd-cases.js, one test per case;
//   4. review fixes (invented rows only);
//   5. review round 2 fixes (invented rows only). test/realistic.test.js adds the realistic generalization list.
// Suite 2 needs the gitignored sample .xlsx in the repo root and skips with a message when it is absent. Without it (as in CI),
// suite 3 still runs every case that names only synthetic rows, on the synthetic rows alone (COV-5).
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

// The row ids a case names; a case naming no sample row (S…/O…) and not marked needsSample also holds on the synthetic rows alone.
const caseIds = x => ['match', 'close', 'main', 'possible', 'isbnPrefix', 'any', 'absent', 'notMain'].flatMap(k => x[k] || [])
  .concat(x.first ? [x.first] : [], (x.before || []).flat(), ['reasons', 'notes', 'displayTitle'].flatMap(k => (x[k] || []).map(e => e.row)));
const offline = c => !c.needsSample && caseIds(c.expect).every(id => !/^[SO]\d/.test(id));
for (const c of cases) {
  const name = `${c.rule}: ${JSON.stringify(c.q.length > 70 ? c.q.slice(0, 67) + '…' : c.q)}${c.enter ? ' (Enter)' : ''}`;
  test(name, { skip: SKIP_SAMPLE && !offline(c) ? SKIP_SAMPLE : false }, () => {
    const res = E.search(c.q, SKIP_SAMPLE ? synth() : sample().ix, { enter: !!c.enter });
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

// ---------------------------------------------------------------------------------------------------------------
// 4. Review fixes: invented rows only (never copies of the sample list), so these run in CI too
// ---------------------------------------------------------------------------------------------------------------
const mini = (rows, opts) => E.buildIndex(rows.map((r, i) => toRow(Object.assign({ bannedBy: 'KES', type: 'Book' }, r), i)), opts);
const tierIn = (res, id) => { const h = find(res, id); return h ? (res.main.includes(h) ? h.tier : res.possible.includes(h) ? 'possible' : 'isbnPrefix') : 'absent'; };

test('lookup tables have no prototype keys: "constructor" is an ordinary word (E3-02, SEC-05)', () => {
  const ix = mini([{ id: 'C1', title: 'LEGO Constructor Ideas' }, { id: 'C2', title: 'Fun with Phonics' }, { id: 'C3', title: 'The Constructer Kit' }]);
  for (const q of ['fun', 'func', 'function']) assert.doesNotThrow(() => E.search(q, ix), q);
  assert.deepEqual(ids(E.search('fun', ix).main), ['C2']);
  assert.ok(ids(E.search('constructer ', ix).possible).includes('C1'));                 // one edit, fuzzy again
  assert.deepEqual(terms('constructor'), [['constructor']]);
  assert.deepEqual(words('lego constructor 3').pairs, []);
});
test('initials with the letter a: A.I., S.W.A.T., U.S.A., A. A. Milford (E1-01)', () => {
  for (const [q, w] of [['A.I.', 'ai'], ['S.W.A.T.', 'swat'], ['U.S.A.', 'usa'], ['a.i.', 'ai']]) assert.deepEqual(words(q).map(x => x.w), [w], q);
  assert.deepEqual(words('A. A. Milford').map(x => x.w), ['aa', 'milford']);
  assert.deepEqual(words('Plan A. Twelve Years a Slave').map(x => x.w), ['plan', 'a', 'twelve', 'years', 'a', 'slave']);
  const ix = mini([{ id: 'A1', title: 'S.W.A.T. Team Handbook' }, { id: 'A2', title: 'A.I. Artificial Intelligence' }, { id: 'A3', title: 'I Am Here', author: 'Nadia Yousef' },
    { id: 'A4', title: 'Winnie Walks', author: 'A. A. Milford' }, { id: 'A5', title: 'Made in the U.S.A.' }, { id: 'A6', title: 'Sea Glass', author: 'Tui T. Sherwood' }]);
  assert.equal(tierIn(E.search('swat', ix), 'A1'), 'match');
  assert.equal(tierIn(E.search('AI', ix, { enter: true }), 'A2'), 'match');
  assert.equal(tierIn(E.search('ai artificial intelligence', ix), 'A2'), 'match');
  assert.equal(tierIn(E.search('aa milford', ix), 'A4'), 'match');
  assert.equal(tierIn(E.search('made in usa', ix), 'A5'), 'match');
  assert.deepEqual(ids(E.search('a.i.', ix).main), ['A2']);                             // not every title with the word "I"
  assert.deepEqual(ids(E.search('s.w.a.t.', ix).main), ['A1']);
});
test('the word being typed reaches the numbers and abbreviations it starts (E1-02, E2-11, E3-08, E4-03)', () => {
  const ix = mini([{ id: 'N1', title: '7th Lantern, The' }, { id: 'N2', title: '13 Quiet Harbors' }, { id: 'N3', title: '20,000 Fathoms Below' },
    { id: 'N4', title: '451 Ember Street' }, { id: 'N5', title: '211 Brass Keys' }, { id: 'N6', title: '60 Seconds of Rain Volume 2' },
    { id: 'N7', title: "Mr. Pemberly's Kites" }, { id: 'N8', title: 'St. Aldric Tales' }, { id: 'N9', title: 'Dr. Hollis Remedies' },
    { id: 'N10', title: '1984 Almanac', author: 'Ada Mercer' }, { id: 'N11', title: '2nd Helping of Porridge, A' }]);
  const cases = { 'the sev': 'N1', 'the sevent': 'N1', thirt: 'N2', thirtee: 'N2', 'twenty thousan': 'N3', 'twenty tho': 'N3', 'ember four fif': 'N4',
    'two ele': 'N5', 'two eleve': 'N5', 'sixty second': 'N6', mis: 'N7', miste: 'N7', sain: 'N8', doc: 'N9', docto: 'N9', 'mercer nineteen eig': 'N10',
    'nineteen eighty': 'N10', 'nineteen eighty-fou': 'N10', 'a secon': 'N11' };
  for (const [q, id] of Object.entries(cases)) assert.equal(tierIn(E.search(q, ix), id), 'match', q);
  assert.equal(tierIn(E.search('the seventh', ix), 'N1'), 'match');                   // the finished words still work
  assert.equal(tierIn(E.search('twenty one', ix), 'N3'), 'absent');                     // a finished number word is not a prefix
});
test('a split compound whose second half is being typed reaches the joined word (E1-03)', () => {
  const ix = synth();
  for (const q of ['sand cas', 'sand cast', 'sand castl']) assert.equal(tierIn(E.search(q, ix), 'XS18'), 'close', q);
});
test('a query in the sheet\'s inverted form keeps prefix matching on the word being typed (E1-04)', () => {
  const ix = synth();
  assert.equal(tierIn(E.search('Alchemist, The: A Fab', ix), 'XA1'), 'match');
  assert.equal(tierIn(E.search('Glass Owl, The – A Win', ix), 'XA26'), 'match');
  assert.equal(tierIn(E.search('Velvet Quarry, The', ix), 'XT7'), 'match');
});
test('"n" between two words is the optional "and" of rock \'n\' roll (E1-05)', () => {
  const ix = mini([{ id: 'K1', title: "Rock 'n' Roll High School" }, { id: 'K2', title: "Guns N' Roses: The Photos" }, { id: 'K3', title: 'Rock and Roll Hall of Fame' }]);
  assert.deepEqual(E.search('rock n roll', ix).main.map(h => rowId(h.row) + ':' + h.tier), ['K1:match', 'K3:match']);
  assert.equal(tierIn(E.search('guns n roses', ix), 'K2'), 'match');
  assert.equal(tierIn(E.search('rock n', ix), 'K1'), 'possible');                       // at the end it is still a required letter
});
test('opts.finished: a line of a pasted list is complete text, with no prefix matching (E1-06)', () => {
  const ix = mini([{ id: 'W1', title: 'War Horse' }, { id: 'W2', title: 'Warden Tales' }]);
  assert.deepEqual(ids(E.search('War', ix, { enter: true }).main), ['W1', 'W2']);
  assert.deepEqual(ids(E.search('War', ix, { enter: true, finished: true }).main), ['W1']);
});
test('splitLines: list markers in a list of 2+ lines, and PowerPoint line breaks (E1-07, E1-10)', () => {
  assert.deepEqual(E.splitLines('1. Fahrenheit 451\n2. 1984\n3) The 7th Knot\n(4) Holes\n- Wonder\n• Matilda'), ['Fahrenheit 451', '1984', 'The 7th Knot', 'Holes', 'Wonder', 'Matilda']);
  assert.deepEqual(E.splitLines('Fahrenheit 451\u000B1984\u000CThe 7th Knot'), ['Fahrenheit 451', '1984', 'The 7th Knot']);
  assert.deepEqual(E.splitLines('1. Fahrenheit 451'), ['1. Fahrenheit 451']);           // one line is left as typed
  const ix = mini([{ id: 'L1', title: '1984 Almanac' }, { id: 'L2', title: 'Harbor Stories Volume 2' }]);
  assert.deepEqual(ids(E.search(E.splitLines('1. Harbor Stories\n2. 1984')[1], ix, { enter: true }).main), ['L1']);
});
test('display title: invisible characters, "/", "!", "?", symbols and a doubled comma before the article (E1-09, E4-11)', () => {
  const cases = { 'Hobbit, The\u200B': 'The Hobbit', 'Hobbit, The\u200E': 'The Hobbit', 'Alchemist, The / Paulo Coelho': 'The Alchemist / Paulo Coelho',
    'Hobbit,, The': 'The Hobbit', 'Grinch, The!': 'The Grinch!', 'Crucible, The\u00AE: A Play': 'The Crucible\u00AE: A Play', 'Hello, A-Team': 'Hello, A-Team' };
  for (const [a, b] of Object.entries(cases)) assert.equal(E.normalizeTitleForDisplay(a), b, a);
});
test('explanations name the cell text that matched: two number groups, and no ordinal crossing beside a prefix (E1-12)', () => {
  const ix = mini([{ id: 'Q1', title: '20 10-Minute Skits' }, { id: 'Q2', title: '60 Seconds of Rain Volume 2' }]);
  assert.ok(find(E.search('twenty ten minute skits', ix), 'Q1').reasons.includes('twenty ten = 20 10'));
  const h = find(E.search('60 second', ix), 'Q2');
  assert.deepEqual([h.tier, h.reasons, h.highlights.title], ['match', [], [[0, 2], [3, 9]]]);
});
test('"book", "#" and "year" never pair with a number of 100 or more (E2-01, E1-08, E2-09)', () => {
  assert.deepEqual(words('book 1984 #451 year 2023 Book 3 #3 Year 7').pairs.map(p => p.terms[0]), ['#book3', '#book3', '#year7']);
  const ix = mini([{ id: 'B1', title: '1984 Almanac', author: 'Ada Mercer', year: '2023-2024' }, { id: 'B2', title: 'Harbor Stories Book 3' },
    { id: 'B3', title: '101 Creepy Riddles' }, { id: 'B4', title: '451 Farenheit Notes' }]);
  for (const q of ['book 1984', 'the book 1984', 'is the book 1984 banned?', '#1984', 'mercer 1984 year 2023-2024', 'mercer banned year 2023/24']) {
    assert.equal(tierIn(E.search(q, ix), 'B1'), 'match', q);
  }
  assert.equal(tierIn(E.search('book 101 creepy riddles', ix), 'B3'), 'match');
  assert.equal(tierIn(E.search('farenheit #451', ix), 'B4'), 'match');
  assert.equal(tierIn(E.search('#3', ix, { enter: true }), 'B2'), 'match');
});
test('label lists and Roman ranges name every volume; no single-volume note for them (E2-02, E4-01, E4-12)', () => {
  const pairs = q => words(q).pairs.flatMap(p => p.terms);
  assert.deepEqual(pairs('Books 1 & 2'), ['#book1', '#book2']);
  assert.deepEqual(pairs('Volumes 1, 2 and 3'), ['#book1', '#book2', '#book3']);
  assert.deepEqual(pairs('Volumes I–III'), ['#book1', '#book2', '#book3']);
  assert.deepEqual(pairs('Parts One and Two'), ['#part1', '#part2']);
  assert.deepEqual(pairs('Book 1 and the Chamber, Grade 5 and Up'), ['#book1', '#grade5']);
  const ix = mini([{ id: 'V1', title: 'Hunger Trials Books 1 & 2', author: 'Suri Collins' }, { id: 'V2', title: 'Quiz Bowl Volumes 1, 2 and 3' },
    { id: 'V3', title: 'Encyclopedia of Space Volumes I–III' }, { id: 'V4', title: 'Maths Parts 1 & 2' }, { id: 'V5', title: 'Beethoven Symphony No. 9' }]);
  for (const [q, id] of [['hunger trials book 2', 'V1'], ['quiz bowl volume 3', 'V2'], ['encyclopedia of space volume 2', 'V3'], ['maths part 2', 'V4']]) {
    const h = find(E.search(q, ix), id);
    assert.equal(h.tier, 'match', q);
    assert.ok(!h.notes.some(n => /only\.$/.test(n)), q);
  }
  assert.equal(tierIn(E.search('hunger trials book 3', ix), 'V1'), 'possible');
  assert.deepEqual(find(E.search('beethoven symphony', ix), 'V5').notes, ['This listing names No. 9 only.']);
});
test('the rest of a work\'s group joins an ISBN or memo hit, Ministry row first, in the prefix group too (E2-03, E2-12)', () => {
  const ix = mini([{ id: 'G1', title: 'The Kite Racer', author: 'Karim Hosseyni', isbn: '9781594631931' }, { id: 'G2', title: 'Kite Racer, The', author: 'Karim Hosseyni', bannedBy: 'Ministry' },
    { id: 'G3', title: 'Looking for Alaska Bay', author: 'Jon Greer', memo: '88213' }, { id: 'G4', title: 'Looking for Alaska Bay', author: 'Jon Greer', bannedBy: 'Ministry' },
    { id: 'G5', title: 'Crank Valley', author: 'Ellen Hopp', isbn: '9781481443203' }, { id: 'G6', title: 'Crank Valley', author: 'Ellen Hopp', isbn: '9781481443203', bannedBy: 'Ministry' }]);
  for (const q of ['9781594631931', '1594631930']) {
    const r = E.search(q, ix);
    assert.deepEqual(r.main.map(h => rowId(h.row) + ':' + h.tier + ':' + h.groupSize), ['G2:close:2', 'G1:match:2'], q);
    assert.deepEqual(r.main[0].reasons, ['same title and author as another result']);
  }
  assert.deepEqual(ids(E.search('88213', ix).main), ['G4', 'G3']);
  assert.deepEqual(E.search('978159463', ix).isbnPrefix.map(h => rowId(h.row) + ':' + h.groupSize), ['G2:2', 'G1:2']);
  assert.deepEqual(E.search('978-1-4814-4', ix).isbnPrefix.map(h => rowId(h.row) + ':' + h.groupSize), ['G6:2', 'G5:2']);
});
test('ISBN cells: pbk tags, two ISBNs with a space, labels, Unicode dashes, digit-group commas (E2-04)', () => {
  const runs = v => E._internal.isbnRuns(v).map(x => x.d);
  assert.deepEqual(runs('978-0-374-37152-4 (pbk.)'), ['9780374371524']);
  assert.deepEqual(runs('9780062498533 9780062498540'), ['9780062498533', '9780062498540']);
  assert.deepEqual(runs('ISBN 9780142402511 ISBN 9780525475064'), ['9780142402511', '9780525475064']);
  assert.deepEqual(runs('978-1-250-01257-9 (hbk) / 978-1-250-06747-0 (pbk)'), ['9781250012579', '9781250067470']);
  assert.deepEqual(runs('978\u20130\u2013525\u201347881\u20132'), ['9780525478812']);
  assert.deepEqual(runs('978\u20111\u201159448\u2011000\u20113'), ['9781594480003']);
  assert.deepEqual(runs('9,781,400,033,416'), ['9781400033416']);
  assert.deepEqual(runs('0306406152 9780306406157'), ['0306406152', '9780306406157']);
  const [x] = E._internal.isbnRuns('978-0-374-37152-4 (pbk.)');
  assert.deepEqual([x.s, x.e], [0, 17]);
});
test('ISBN queries: Unicode dashes, 978- in a longer query, two ISBNs on a line, a lost leading zero (E2-06, E2-07, E2-08, E2-14, E4-09)', () => {
  const ix = synth();
  for (const q of ['0\u2013306\u201340615\u20132', '0\u2011306\u201140615\u20112', 'ISBN\u201010: 0-306-40615-2', 'lighthouse keeper 978-0306406157',
    'ISBN-10: 0306406152 ISBN-13: 978-0306406157', '0306406152 9780306406157', 'ISBN 0-306-40615-2 0-9752298-0-X', '9780306406157 2023-2024', '306406152']) {
    assert.ok(ids(E.search(q, ix).main).includes('XT9'), q);
  }
  assert.deepEqual(ids(E.search('ISBN 0-306-40615-2 0-9752298-0-X', ix).main).sort(), ['XT10', 'XT9']);
  const r = E.search('ISBN\u201013: 979-8-89180-854-6', ix);
  assert.equal(r.isbnQuery, true);
  assert.ok(!ids(r.main).length && r.hints.some(h => h.code === 'isbnNoMatch'));        // '13' is part of the label, not a title word
  const t = E.search('101 451', mini([{ id: 'D1', title: '101 Dalmatians' }]));
  assert.deepEqual([t.isbnQuery, ids(t.possible)], [false, ['D1']]);                     // two title numbers, not an ISBN
});
test('a year range being typed never blocks a match (E2-10)', () => {
  const ix = mini([{ id: 'Y1', title: 'Harbor Nights', author: 'Ada Mercer', year: '2023-2024' }]);
  for (const q of ['mercer 2023-', 'mercer 2023-2', 'mercer 2023-20', 'mercer 2023-202', 'mercer 2023/2', 'mercer 2023-2024']) assert.equal(tierIn(E.search(q, ix), 'Y1'), 'match', q);
  assert.equal(tierIn(E.search('mercer 2023', ix), 'Y1'), 'possible');                  // a lone year stays a title word
  assert.equal(E.search('2023-202', ix).isbnQuery, false);
});
test('aliases.json: WWII and World War II find each other (E2-13)', () => {
  const ix = mini([{ id: 'W1', title: 'World War II: A Visual History' }, { id: 'W2', title: 'WWI Trench Letters' }], { aliases: require('../aliases.json') });
  for (const q of ['wwii', 'ww2', 'world war 2', 'second world war']) assert.equal(tierIn(E.search(q, ix), 'W1'), 'match', q);
  for (const q of ['world war one', 'world war i', 'wwi']) assert.equal(tierIn(E.search(q, ix), 'W2'), 'match', q);
});
test('no Roman numerals in names; misspelt run-together numbers (E2-15, E2-16)', () => {
  const ix = mini([{ id: 'X1', title: 'The Governance of Rivers', author: 'Xi Jinping' }]);
  assert.equal(tierIn(E.search('11', ix), 'X1'), 'absent');
  assert.deepEqual(terms('ninteeneightyfour fourtyfive'), [['ninteeneightyfour', '1984'], ['fourtyfive', '45']]);
});
test('authorless rows stay Possible for "title by First Last", a misspelt surname, or a whole one-word title (E3-01)', () => {
  const ix = mini([{ id: 'H1', title: 'Holes', type: 'DVD' }, { id: 'H2', title: 'Wonder' }, { id: 'H3', title: 'Matilda', author: 'N/A' },
    { id: 'H4', title: 'Quartz Almanac', author: 'Ada Mercer' }, { id: 'H5', title: 'Quartz Almanac Study Guide' }]);
  for (const [q, id] of [['holes by louis sachar', 'H1'], ['holes louis sachar', 'H1'], ['wonder by r.j. palacio', 'H2'], ['matilda by roald dahl', 'H3'], ['ada mercr quartz', 'H5']]) {
    const h = find(E.search(q, ix), id);
    assert.ok(h && !E.search(q, ix).main.includes(h) && h.reasons.includes('author not listed'), q);
  }
});
test('two-author queries: semicolons, full names split by a comma, initials inside a name (E3-03, E3-04)', () => {
  const ix = mini([{ id: 'T1', title: 'Soup for Sailors', author: 'Jonas Pell Et Al' }]);
  for (const q of ['Pell, J., & Hart, M. V.', 'Pell, Jonas; Hart, Mara Vey', 'Jonas Pell (Author), Mara Vey Hart (Author)', 'jonas pell, mara vey hart']) {
    const r = E.search(q, ix);
    assert.ok(ids(r.possible).includes('T1') && find(r, 'T1').reasons.includes('matched 1 of 2 authors'), q);
  }
  const codes = E.search('Hart, M. V.', ix).hints.map(h => h.code);
  assert.ok(!codes.includes('keepTyping') && codes.includes('etAl'), codes.join());
});
test('"given names differ" only when they do: the matched person\'s given names, prefixes, merged initials (E3-05)', () => {
  const ix = mini([{ id: 'M1', title: 'Game of Crowns', author: 'Gideon R. R. Marsh' }, { id: 'M2', title: 'Speak Softly', author: 'Laurie Halse Andrews' },
    { id: 'M3', title: 'Monsoon Fair', author: 'Priya Nand (Author), Lotte Brand (Illustrator)' }, { id: 'M4', title: 'Chowder Days', author: 'Jonas Pell, Mara Vey Hart' },
    { id: 'M5', title: 'Say Cheese', author: 'Jovial Bob Stone' }]);
  for (const [q, id] of [['g.r.r. marsh', 'M1'], ['g. marsh', 'M1'], ['l. andrews', 'M2'], ['p nand', 'M3'], ['l. brand', 'M3'], ['m. v. hart', 'M4'], ['j. pell', 'M4']]) {
    const h = find(E.search(q, ix), id);
    assert.deepEqual([h.tier, h.reasons.includes('given names differ')], ['match', false], q);
  }
  assert.ok(find(E.search('r.l. stone', ix), 'M5').reasons.includes('given names differ'));
});
test('short words: not waived beside a fuzzy author hit, never a listed surname, nor when the author is fully named (E3-06, E4-06)', () => {
  const ix = mini([{ id: 'S1', title: 'Little Fires', author: 'Odile Ng' }, { id: 'S2', title: 'Celestial Maps', author: 'Odile Harrow' },
    { id: 'S3', title: 'Pasta at Home', author: 'Guido Ferri' }, { id: 'S4', title: 'TV Guide Crosswords' }, { id: 'S5', title: 'Matilda Rises', author: 'Dahl, Roald', bannedBy: 'Ministry' }]);
  assert.deepEqual(ids(E.search('odile ng', ix).main), ['S1']);
  assert.ok(!ids(E.search('tv guide', ix).main).includes('S3'));
  assert.equal(tierIn(E.search('the bfg roald dahl', ix), 'S5'), 'possible');
});
test('aliases while the last alias word is typed, and in "Last, First" order (E3-07)', () => {
  const ix = mini([{ id: 'P1', title: 'Grim Lanterns', author: 'Quill Sparrow' }], { aliases: { aliases: [{ kind: 'pen name', names: ['Pip Arden', 'Quill Sparrow'] }] } });
  for (const q of ['pip ard', 'pip arde', 'Arden, Pip']) assert.ok(find(E.search(q, ix), 'P1').reasons.some(x => x.startsWith('via alias')), q);
});
test('plural alternates for -o / -oes (E3-09)', () => {
  const ix = mini([{ id: 'O1', title: 'Heroes of Olympus' }, { id: 'O2', title: 'Hero' }, { id: 'O3', title: 'Tomatoes in the Garden' }]);
  assert.equal(tierIn(E.search('hero of olympus ', ix), 'O1'), 'match');
  assert.equal(tierIn(E.search('heroes ', ix), 'O2'), 'match');
  assert.equal(tierIn(E.search('tomato garden ', ix), 'O3'), 'match');
});
test('placeholder authors with role words or "Various Artists" are blank (E3-10)', () => {
  const ix = mini([{ id: 'U9', title: 'Quartz Almanac', author: 'Ada Mercer' }].concat(['Various Artists', 'Author Unknown', 'Anonymous Author', 'No Author',
    'Multiple Authors'].map((author, i) => ({ id: 'U' + i, title: ['Folk', 'Sea', 'Road', 'Camp', 'Rain'][i] + ' Songs', author }))));
  assert.equal(E.search('various', ix).main.length + E.search('unknown', ix).main.length, 0);
  const hits = E.search('ada mercer songs', ix).possible.filter(h => rowId(h.row) !== 'U9');
  assert.deepEqual(ids(hits).sort(), ['U0', 'U1', 'U2', 'U3', 'U4']);
  assert.ok(hits.every(h => h.reasons.includes('author not listed') && h.groupKey.endsWith('|')));   // blank for matching and grouping
});
test('role and publisher words are required where a listed title has them, unless beside an author word (E3-11)', () => {
  const ix = synth();
  assert.equal(tierIn(E.search('mr. men', ix), 'XN10'), 'possible');                    // "Mr. Quimby's Lanterns" makes "mr" a title word
  assert.equal(tierIn(E.search('mr fairbrass', ix), 'XS14'), 'match');
  assert.equal(tierIn(E.search('nandakumar editor', ix), 'XS15'), 'match');
});
test('one-word author typo: the author\'s row leads; fields follow the highlighted hits (E3-12, E3-13)', () => {
  const ix = mini([{ id: 'F1', title: 'Munchet Garden' }, { id: 'F2', title: 'Sunshine Munch Bars' }, { id: 'F3', title: 'Paper Bag Tales', author: 'Robert Munsch' },
    { id: 'F4', title: 'Sing Down the Moon', author: 'Scott King' }]);
  assert.equal(ids(E.search('munsh', ix).main)[0], 'F3');
  assert.deepEqual(find(E.search('king ', ix), 'F4').fields, ['author']);
});
test('a foreign-article run never puts a similar spelling in the main list (E3-14)', () => {
  const ix = mini([{ id: 'L1', title: 'Carrie', author: 'Stephen King' }, { id: 'L2', title: 'Petit Prince, Le' }]);
  const r = E.search('le carre', ix);
  assert.deepEqual(ids(r.main), []);
  assert.ok(find(r, 'L1').reasons.includes('similar spelling: Carrie'));
  assert.equal(tierIn(E.search('le petit prince', ix), 'L2'), 'match');
});
test('spelled-out given names that match the cell\'s initials; pasted author credits (E3-15, E3-16)', () => {
  const ix = mini([{ id: 'I1', title: 'Say Cheese and Die!', author: 'R.L. Stone' }, { id: 'I2', title: 'Neverwhere Lane', author: 'Neil Gaimon' },
    { id: 'I3', title: 'Hound of the Moors, The', author: 'Arthur Conan Dale' }]);
  const h = find(E.search('robert lawrence stone', ix), 'I1');
  assert.deepEqual([h.tier, h.reasons], ['close', ['robert lawrence = R.L.']]);
  assert.equal(tierIn(E.search('Neil Gaimon (Goodreads Author)', ix), 'I2'), 'match');
  assert.equal(tierIn(E.search('sir arthur conan dale', ix), 'I3'), 'match');
  assert.equal(tierIn(E.search('Stone, R. L., 1943-', ix), 'I1'), 'match');
});
test('whole-series rows: lifted by the series name as the reverse check reads it, or the surname; not "Series 3" (E4-02, E4-08)', () => {
  const ix = mini([{ id: 'Z1', title: 'Magic Tree House Series', author: 'Mary Pope Osborne' }, { id: 'Z2', title: 'Mary Poppins', author: 'P. L. Travers' },
    { id: 'Z3', title: 'Shine Series', author: 'Lauren Myracle' }, { id: 'Z4', title: 'Stine Stories', author: 'Jovial Bob Stine' },
    { id: 'Z5', title: 'Complete Works of Shakespeare, The', author: 'William Shakespeare' }, { id: 'Z6', title: 'Doctor Who Series 3', type: 'DVD' }]);
  assert.equal(ids(E.search('mary poppins', ix).main)[0], 'Z2');
  assert.ok(!ids(E.search('stine', ix).main).includes('Z3'));
  assert.ok(!ids(E.search('william golding lord of the flies', ix).main).includes('Z5'));
  assert.equal(ids(E.search('osborne', ix).main)[0], 'Z1');
  assert.deepEqual(find(E.search('doctor who', ix), 'Z6').notes, []);
});
test('main lists Match hits before Close hits (E4-04, COV-12)', () => {
  const ix = mini([{ id: 'R1', title: 'Moon Garden Secrets' }, { id: 'R2', title: 'Garden Moone, The' }]);
  assert.deepEqual(E.search('garden moon ', ix).main.map(h => rowId(h.row) + ':' + h.tier), ['R1:match', 'R2:close']);
});
test('group keys read number words as digits (E4-05)', () => {
  const ix = mini([{ id: 'E1', title: 'Seven Habits of Happy Teens', author: 'Sean Cove', bannedBy: 'Ministry' }, { id: 'E2', title: '7 Habits of Happy Teens, The', author: 'Sean Cove' }]);
  const r = E.search('7 habits of happy teens', ix);
  assert.deepEqual(r.main.map(h => rowId(h.row) + ':' + h.groupSize), ['E1:2', 'E2:2']);
});
test('authorHasOthers names the surname of "Last, Given" cells (E4-07)', () => {
  const ix = mini([{ id: 'H1', title: 'Casual Vacancy, The', author: 'Rowling, J. K.' }, { id: 'H2', title: 'Strength to Love', author: 'King, Martin Luther' }]);
  assert.ok(E.search('harry potter rowling', ix).hints.some(h => h.text === "Rowling, J. K. has other listed items; search 'Rowling'"));
  assert.ok(E.search('i have a dream king', ix).hints.some(h => h.text === "King, Martin Luther has other listed items; search 'King'"));
});
test('questions around a title: question words are optional, and a label\'s number is not "keep typing" (E4-10)', () => {
  const ix = mini([{ id: 'Q1', title: 'Speak', author: 'Laurie Halse Andrews' }, { id: 'Q2', title: 'World War I Letters' }, { id: 'Q3', title: 'World War II Letters' }]);
  const r = E.search('can we read speak in grade 9', ix);
  assert.ok(ids(r.possible).includes('Q1') && !r.hints.some(h => h.code === 'keepTyping'));
  assert.equal(tierIn(E.search('can I use speak in class?', ix), 'Q1'), 'match');
  assert.deepEqual(ids(E.search('world war i', ix).main), ['Q2']);                     // "i" is optional only in a question
});
test('reason wording: "#3 = Book 3", no "similar spelling" for a word also matched exactly, no initials from a URL (E4-12)', () => {
  const ix = mini([{ id: 'J1', title: 'Harbor Series of Tales - The Low Tide -Book 3' }, { id: 'J2', title: '2nd Helping of Chicken Soup, A' },
    { id: 'J3', title: '451 Farenheit', author: 'Ray Bradbury' }]);
  assert.ok(find(E.search('low tide #3', ix), 'J1').reasons.includes('#3 = Book 3'));
  assert.deepEqual(find(E.search('A 2nd Helping of Chicken Soup for the Soul', ix), 'J2').reasons, ['the whole listed title is in your search']);
  assert.ok(!find(E.search('https://www.amazon.com/Fahrenheit-451-Ray-Bradbury/dp/1451673310/ref=sr_1_1', ix), 'J3').reasons.includes('given names differ'));
});
test('highlights cover a trailing combining accent (E4-13)', () => {
  const ix = mini([{ id: 'HL', title: 'Poke\u0301mon Journeys', author: 'Charlotte Bronte\u0308' }]);
  assert.deepEqual(find(E.search('bronte', ix), 'HL').highlights.author, [[10, 17]]);
  assert.deepEqual(find(E.search('poke', ix), 'HL').highlights.title, [[0, 5]]);
});
test('ISBN no-match hint when every row has an ISBN (BROWSER-5)', () => {
  const ix = mini([{ id: 'I1', title: 'Harbor Nights', isbn: '9780306406157' }, { id: 'I2', title: 'Quiet Bay', isbn: '9781451673319' }]);
  assert.deepEqual(E.search('9780141036144', ix).hints.map(h => h.text), ['No ISBN match. Search the title and author too.']);
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Review round 2 fixes: invented rows only
// ---------------------------------------------------------------------------------------------------------------
test('"ok", "okay", "suitable" and "appropriate" are title words outside a question (ER-01)', () => {
  const ix = mini([{ id: 'Q1', title: 'Suitable Boy, A', author: 'Vikram Seth' }, { id: 'Q2', title: 'The Boy in the Striped Pyjamas', author: 'John Boyne' },
    { id: 'Q3', title: 'The Boy Next Door', author: 'Meg Cabot' }, { id: 'Q4', title: 'Okay for Now', author: 'Gary D. Schmidt' }, { id: 'Q5', title: 'Now Is the Time for Running' }]);
  let r = E.search('a suitable boy', ix);
  assert.deepEqual([ids(r.main), ids(r.possible).sort()], [['Q1'], ['Q2', 'Q3']]);
  r = E.search('okay for now', ix);
  assert.deepEqual([ids(r.main), ids(r.possible)], [['Q4'], ['Q5']]);
  assert.deepEqual(ids(E.search('is a suitable boy banned', ix).main), ['Q1']);         // optional in a question, but still the title's word
  assert.equal(tierIn(E.search('is the boy next door okay to read', ix), 'Q3'), 'match');
});
test('aliases.json: the WW2 forms add no rows that share only a number, and "wwi" is not the start of "wwii" (ER-02)', () => {
  const ix = mini([{ id: 'W1', title: 'World War II: A Visual History' }, { id: 'W2', title: '60 Seconds of Rain Volume 2' }, { id: 'W3', title: 'Phonics Grade 1' },
    { id: 'W4', title: '2nd Helping of Porridge, A' }, { id: 'W5', title: 'WWI Trench Letters' }], { aliases: require('../aliases.json') });
  for (const q of ['wwii', 'world war 2', 'world war two', 'wwi', 'world war one', 'first world war']) for (const enter of [false, true]) {
    const r = E.search(q, ix, { enter });
    assert.deepEqual(ids(r.main.concat(r.possible)).filter(id => id !== 'W1' && id !== 'W5'), [], q);
  }
  for (const enter of [false, true]) assert.deepEqual(ids(E.search('wwi', ix, { enter }).main), ['W5']);
  assert.deepEqual(ids(E.search('wwii', ix).main), ['W1']);
});
test('a similar spelling of an author counts as an author word only beside another word of the same author (ER-03)', () => {
  const ix = mini([{ id: 'A1', title: 'Maths Workbook Volume 2' }, { id: 'A2', title: 'Science Reader: Book 2' }, { id: 'A3', title: 'Warriors', author: 'Erin Hunter' },
    { id: 'A4', title: 'Holes', author: 'Tim James' }, { id: 'A5', title: 'The Hunger Games', author: 'Suzanne Collins' }, { id: 'A6', title: '1984: A Study Guide' },
    { id: 'A7', title: '1984', author: 'George Orwell' }]);
  const r = E.search('hunger games book 2', ix);
  assert.deepEqual([ids(r.main), ids(r.possible)], [['A5'], []]);
  assert.ok(find(E.search('george orwel 1984', ix), 'A6').reasons.includes('author not listed'));   // "orwel" beside "george", one cell
});
test('given names spelled out must spell the initials: another title beside the surname is not a given name (ER-04)', () => {
  const ix = mini([{ id: 'T1', title: 'Hobbit, The', author: 'J.R.R. Tolkien' }, { id: 'T2', title: 'Anne of Green Gables', author: 'L. M. Montgomery' },
    { id: 'T3', title: 'Goosebumps: Say Cheese and Die!', author: 'R.L. Stine' }]);
  for (const [q, id, surname] of [['roverandom tolkien', 'T1', 'Tolkien'], ['marigold montgomery', 'T2', 'Montgomery'], ['ransom stine', 'T3', 'Stine']]) {
    const r = E.search(q, ix);
    assert.deepEqual([ids(r.main), tierIn(r, id)], [[], 'possible'], q);
    assert.ok(r.hints.some(h => h.code === 'authorHasOthers' && h.text.endsWith(`search '${surname}'`)), q);
  }
  for (const [q, id, why] of [['john ronald reuel tolkien', 'T1', 'john ronald reuel = J.R.R.'], ['john ronald tolkien', 'T1', 'john ronald = J.R.R.'],
    ['lucy maud montgomery', 'T2', 'lucy maud = L. M.'], ['robert lawrence stine', 'T3', 'robert lawrence = R.L.']]) {
    const h = find(E.search(q, ix), id);
    assert.deepEqual([h.tier, h.reasons], ['close', [why]], q);
  }
});
test('"A" after a letter\'s period is the article, not an initial: "Vitamin C. A Guide", "Smith, B. A tree…" (ER-05)', () => {
  assert.deepEqual(words('Vitamin C. A Guide').map(x => x.w), ['vitamin', 'c', 'a', 'guide']);
  assert.deepEqual(words('U.S.A Today, J.A Smith').map(x => x.w), ['usa', 'today', 'ja', 'smith']);
  const ix = mini([{ id: 'C1', title: 'Vitamin C. A Guide for Parents' }, { id: 'C2', title: 'Malcolm X. A Life' }, { id: 'C3', title: 'Tree Grows in Brooklyn, A', author: 'Betty Smith' },
    { id: 'C4', title: 'Plan B: A Novel', author: 'Jonathan Tropper' }]);
  for (const [q, id] of [['vitamin c', 'C1'], ['malcolm x', 'C2'], ['Plan B. A Novel', 'C4']]) assert.equal(tierIn(E.search(q, ix), id), 'match', q);
  const h = find(E.search('Smith, B. A tree grows in Brooklyn', ix), 'C3');
  assert.deepEqual([h.tier, h.reasons], ['match', []]);
});
test('completions of the word being typed are explained, rank below literal prefixes and are not highlighted beside them (ER-06)', () => {
  const ix = mini([{ id: 'P1', title: '60 Seconds To Shine Volume 2: 221 One-Minute Monologues For Women', author: 'John Capecci Et Al' },
    { id: 'P2', title: 'The 7 Habits of Highly Effective Teens', author: 'Sean Covey' }, { id: 'P3', title: 'Harbor Stories Volume 2' }, { id: 'P4', title: 'Secret Garden' }]);
  assert.deepEqual(find(E.search('60 seco', ix), 'P1').highlights.title, [[0, 2], [3, 7]]);   // "Seco" of Seconds, not the 2 of Volume 2
  assert.deepEqual(find(E.search('the sec', ix), 'P1').highlights.title, [[3, 6]]);
  const r = E.search('the sec', ix), M = ids(r.main);
  assert.ok(M.indexOf('P3') > M.indexOf('P1') && M.indexOf('P3') > M.indexOf('P4'), M.join());
  assert.deepEqual(find(r, 'P3').reasons, ['sec… = 2']);
  assert.deepEqual(find(E.search('the sevent', ix), 'P2').reasons, ['sevent… = 7']);
  assert.deepEqual(find(E.search('harbor stories nineteen eig', mini([{ id: 'P5', title: '1984 Harbor Stories' }])), 'P5').reasons, ['nineteen eig… = 1984']);
});
test('an ISBN with a digit too many is still an ISBN search with no hit (ER-07)', () => {
  const ix = synth();
  for (const q of ['97803064061571', 'ISBN 97803064061571', '978-0-306-40615-71', '978 0 306 40615 71']) for (const enter of [false, true]) {
    const r = E.search(q, ix, { enter });
    assert.deepEqual([r.state, r.isbnQuery, r.hints.map(h => h.code)], ['ok', true, ['isbnNoMatch']], q);
  }
});
test('a probable author name that no cell has lets an authorless row be Possible: "george orwell 1984" (ER-08)', () => {
  const ix = mini([{ id: 'D1', title: '1984: A DVD Study Guide', type: 'DVD' }, { id: 'D2', title: 'Holes' }, { id: 'D3', title: 'Fahrenheit 451', author: 'Ray Bradbury' },
    { id: 'D4', title: 'Maths Workbook Volume 2' }]);
  for (const q of ['george orwell 1984', '1984 george orwell', 'is george orwell 1984 banned']) {
    assert.deepEqual(E.search(q, ix).possible.map(h => [rowId(h.row), h.reasons]), [['D1', ['author not listed']]], q);
  }
  assert.deepEqual(E.search('hunger games book 2', ix).possible, []);                   // a volume number alone never carries the guess
});
test('a lone year followed by a dash is the title word, not a year range being typed (ER-09)', () => {
  const ix = mini([{ id: 'Y1', title: '1984', author: 'George Orwell' }, { id: 'Y2', title: '2001-2002 School Almanac' }, { id: 'Y3', title: 'Harbor Nights', author: 'Ada Mercer', year: '2023-2024' }]);
  for (const [q, id] of [['1984-', 'Y1'], ['1984 -', 'Y1'], ['2001-', 'Y2'], ['2001-2', 'Y2'], ['2001-200', 'Y2']]) for (const enter of [false, true]) {
    const r = E.search(q, ix, { enter });
    assert.deepEqual([r.state, ids(r.main)], ['ok', [id]], q);
  }
  assert.equal(tierIn(E.search('mercer 2023-', ix), 'Y3'), 'match');                    // beside another word it is a range being typed
  assert.equal(E.search('2008-2009', ix).state, 'stopwordsOnly');
});
test('ISBN cells: a 9-digit ISBN (lost leading 0) followed by text (ER-10)', () => {
  const runs = v => E._internal.isbnRuns(v).map(x => x.d);
  for (const v of ['306406152 (pbk)', 'ISBN 306406152 (pbk)', 'see 306406152 inside']) assert.deepEqual(runs(v), ['0306406152'], v);
  assert.deepEqual(runs('306406152 9780306406157'), ['0306406152', '9780306406157']);
  assert.deepEqual(ids(E.search('0306406152', mini([{ id: 'I1', title: 'Almanac', isbn: '306406152 (pbk)' }])).main), ['I1']);
});
test('no Roman numeral for a word that names a listed author: "xi jinping" (ER-11)', () => {
  const ix = mini([{ id: 'X1', title: 'The Governance of Rivers', author: 'Xi Jinping' }, { id: 'X2', title: 'Quokka Math Practice, Grades 9–11' },
    { id: 'X3', title: 'The 9/11 Commission Report' }, { id: 'X4', title: 'Frozen 2' }]);
  const r = E.search('xi jinping', ix);
  assert.deepEqual([ids(r.main), ids(r.possible)], [['X1'], []]);
  assert.deepEqual(ids(E.search('xi', ix).main), ['X1']);
  assert.equal(tierIn(E.search('frozen ii', ix), 'X4'), 'match');                         // elsewhere Roman numerals still read as digits
});
test('display title: ", A" before "/" and one letter is a letter pair, not an article (ER-12)', () => {
  for (const t of ['Animals, A/Z', 'Whole World, A/V Edition', 'Vitamins, A/B/C', 'Animals, A - Z']) assert.equal(E.normalizeTitleForDisplay(t), t);
  assert.equal(E.normalizeTitleForDisplay('Tale of Two Cities, A - 2'), 'A Tale of Two Cities - 2');
  assert.equal(E.normalizeTitleForDisplay('Alchemist, The / Paulo Coelho'), 'The Alchemist / Paulo Coelho');
});
test('whole-series rows: a one-word series name typed as written lifts the row; descriptors are not part of the name (GEN-1)', () => {
  const ix = mini([{ id: 'G1', title: 'Goosebumps series', author: 'R.L. Stine' }, { id: 'G2', title: 'Warriors series', author: 'Erin Hunter' },
    { id: 'G3', title: 'Nancy Drew Mystery Stories - all titles', author: 'Carolyn Keene' }, { id: 'G4', title: 'Twilight Saga collection', author: 'Stephenie Meyer' },
    { id: 'G5', title: 'New Moon', author: 'Stephenie Meyer' }, { id: 'G6', title: 'The Lovely Bones' }, { id: 'G7', title: 'Bone series' },
    { id: 'G8', title: 'Chronicles of Narnia box set, The' }, { id: 'G9', title: 'Shine Series', author: 'Lauren Myracle' }, { id: 'G10', title: '60 Seconds to Shine' },
    { id: 'G11', title: 'Goosebumps #1-10 Box Set' }]);
  const SERIES = 'covers a whole series: its series name is in your search';
  for (const [q, id] of [['goosebumps say cheese and die', 'G1'], ['warriors into the wild', 'G2'], ['nancy drew the secret of the old clock', 'G3'],
    ['twilight new moon', 'G4'], ['narnia prince caspian', 'G8'], ['goosebumps book 12', 'G1']]) {
    const r = E.search(q, ix), h = find(r, id);
    assert.deepEqual([tierIn(r, id), h.reasons[0]], ['close', SERIES], q);
  }
  assert.equal(ids(E.search('nancy drew the secret of the old clock', ix).main)[0], 'G3');   // a two-word name pins the row first
  assert.equal(tierIn(E.search('goosebumps book 12', ix), 'G11'), 'possible');            // another volume than the set's: not lifted
  assert.deepEqual(ids(E.search('the lovely bones', ix).main), ['G6']);                   // "bones" reaches "Bone" only as a plural
  assert.deepEqual(E.search('60 seconds to shine', ix).main.map(h => rowId(h.row) + ':' + h.tier), ['G10:match', 'G9:close']);
});
test('"#1-4" and "#1 - #3" are volume ranges: every volume, a "Covers" note, box sets flagged (GEN-2)', () => {
  const pairs = q => words(q).pairs.flatMap(p => p.terms);
  assert.deepEqual(pairs('#1-4'), ['#book1', '#book2', '#book3', '#book4']);
  assert.deepEqual(pairs('#1 - #3'), ['#book1', '#book2', '#book3']);
  assert.deepEqual(pairs('#1-#10').length, 10);
  assert.deepEqual(pairs('#1, #2 and #3'), ['#book1', '#book2', '#book3']);
  const ix = mini([{ id: 'H1', title: 'Baby-Sitters Club Graphic Novels #1-4' }, { id: 'H2', title: 'Diary of a Wimpy Kid #1-5 Box Set' },
    { id: 'H3', title: 'Harry Potter #1-7', author: 'J.K. Rowling' }]);
  for (const [q, id, note] of [['baby-sitters club #2', 'H1', 'Covers Books 1–4'], ['diary of a wimpy kid book 4', 'H2', 'Covers Books 1–5'],
    ['harry potter book 4', 'H3', 'Covers Books 1–7']]) {
    const r = E.search(q, ix), h = find(r, id);
    assert.equal(tierIn(r, id), 'match', q);
    assert.ok(h.notes.includes(note) && !h.notes.some(n => /only\.$/.test(n)), q);
  }
  assert.ok(find(E.search('wimpy kid box set', ix), 'H2').notes.includes('Covers a whole series'));
  assert.deepEqual(find(E.search('baby-sitters club #2', ix), 'H1').reasons, ['#2 = #1-4']);
});
test('a format or question word beside the only required word, as a listed title has it, is a title word (GEN-3)', () => {
  const ix = mini([{ id: 'F1', title: 'Illustrated Man, The', author: 'Ray Bradbury' }, { id: 'F2', title: 'Invisible Man', author: 'Ralph Ellison' },
    { id: 'F3', title: 'The Old Man and the Sea' }, { id: 'F4', title: 'Ban This Book', author: 'Alan Gratz' }, { id: 'F5', title: 'This One Summer' },
    { id: 'F6', title: 'The Banned Book Club' }, { id: 'F7', title: 'The Joy Luck Club' }, { id: 'F8', title: 'Guinness Book of World Records 2009' },
    { id: 'F9', title: 'Guinness World Records 2015' }, { id: 'F10', title: '1984', author: 'George Orwell' }, { id: 'F11', title: '1984: A DVD Study Guide' }]);
  for (const [q, id, others] of [['the illustrated man', 'F1', ['F2', 'F3']], ['ban this book', 'F4', ['F5']], ['is ban this book banned', 'F4', ['F5']],
    ['the banned book club', 'F6', ['F7']]]) {
    const r = E.search(q, ix);
    assert.deepEqual(ids(r.main), [id], q);
    for (const o of others) assert.ok(!ids(r.main).includes(o), `${q}: ${o}`);
  }
  assert.equal(tierIn(E.search('the illustrated man', ix), 'F2'), 'possible');
  // the query's trailing descriptor and two or more required words keep format words optional
  assert.deepEqual(ids(E.search('1984 paperback', ix).main), ['F10', 'F11']);
  assert.deepEqual(ids(E.search('1984 dvd', ix).main).sort(), ['F10', 'F11']);
  assert.ok(ids(E.search('guinness book of world records', ix).main).includes('F9'));
});
test('Possible rows anchored by a real word rank above rows that share only a small number (GEN-4)', () => {
  const ix = mini([{ id: 'N1', title: 'Attack on Titan vol 2' }, { id: 'N2', title: 'Baby-Sitters Club #2' }, { id: 'N3', title: 'Death Note Volume 2' },
    { id: 'N4', title: 'Hardy Boys #2' }, { id: 'N5', title: "Maus I: A Survivor's Tale", author: 'Art Spiegelman' }, { id: 'N6', title: 'Frozen II' }]);
  for (const q of ['maus 2', 'maus ii', 'maus two', 'maus volume 2']) assert.equal(ids(E.search(q, ix).possible)[0], 'N5', q);
});
test('the reverse check needs the listed volume itself: a number word in the name is not the volume (GEN-5)', () => {
  const ix = mini([{ id: 'V1', title: 'One-Punch Man Vol. 1' }, { id: 'V2', title: 'One-Punch Man Vol. 5' }, { id: 'V3', title: '39 Clues, The - Book 1', author: 'Rick Riordan' },
    { id: 'V4', title: 'Seven Deadly Sins Vol. 7' }]);
  for (const [q, id] of [['one punch man vol 4', 'V1'], ['The 39 Clues Book 2: One False Note', 'V3'], ['seven deadly sins volume 2', 'V4']]) {
    const r = E.search(q, ix);
    assert.deepEqual([tierIn(r, id), find(r, id).notes], ['possible', [`This listing names ${id === 'V3' ? 'Book' : 'Volume'} ${id === 'V4' ? 7 : 1} only.`]], q);
  }
  assert.equal(tierIn(E.search('one punch man vol 1', ix), 'V1'), 'match');
  assert.equal(tierIn(E.search('one punch man 1 viz media edition', ix), 'V1'), 'close');   // the volume typed as digits in a longer query
});
