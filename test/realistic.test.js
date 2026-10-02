// Generalization tests for src/engine.js on a realistic synthetic ban list (test/fixtures/realistic-list.js: ~370 invented rows of
// real published titles, typed the way a school maintainer would, and ~570 teacher queries, each citing its PRD row).
// Every query must hold except the few listed in EXCEPTIONS, each justified by the PRD. The suite reports recall (any tier and main
// list), floods and false positives, and runs the scale checks on ~1,180 rows kept alphabetical, as the real list is.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const S = require('../src/sheet.js');
const { toRow, rowId } = require('./helpers/sample.js');
const L = require('./fixtures/realistic-list.js');

// Queries that stay as they are, with the PRD reason. A query listed here must still fail (so a fix removes it from the list).
const EXCEPTIONS = {
  'the book thief': 'Titles, "Format and edition words" (v1 must): "book" is optional, so "thief" is the only required word. No listed ' +
    'title has "book thief", so the unlisted title shows the "thief" rows (The Thief Lord, Percy Jackson … Lightning Thief) as Matches.',
};

// Status as the page derives it (sheet.js), so "Minstry" and "KES / Ministry" group like the real list.
const build = rows => {
  const R = rows.map((r, i) => toRow(Object.assign({}, r, { status: S.parseBannedBy(r.bannedBy, { schoolCode: 'UAS' }) }), i));
  return { R, ix: E.buildIndex(R, { aliases: require('../aliases.json') }), byId: new Set(R.map(rowId)) };
};

// The issues of one query (empty when it holds) and its counts, as the fixture header defines them.
function check(q, res, byId, tally) {
  const ids = hits => hits.map(h => rowId(h.row));
  const M = ids(res.main), all = new Set(M.concat(ids(res.possible), ids(res.isbnPrefix)));
  const issues = [];
  for (const id of q.main || []) {
    tally.main++; tally.any++;
    if (!byId.has(id)) issues.push(`bad id ${id}`);
    if (M.includes(id)) tally.gotMain++; else issues.push(`${id} not in main${all.has(id) ? ' (possible)' : ' (absent)'}`);
    if (all.has(id)) tally.gotAny++;
  }
  for (const id of q.any || []) {
    if ((q.main || []).includes(id)) continue;
    tally.any++;
    if (!byId.has(id)) issues.push(`bad id ${id}`);
    if (all.has(id)) tally.gotAny++; else issues.push(`${id} absent`);
  }
  for (const id of q.notMain || []) if (M.includes(id)) { tally.fp++; issues.push(`${id} should not be in main`); }
  const allowed = new Set([...(q.main || []), ...(q.any || []), ...(q.ok || [])]), extra = M.filter(id => !allowed.has(id));
  if (extra.length >= 2) { tally.floods++; issues.push(`flood: ${extra.join(' ')}`); }
  else if (extra.length === 1 && q.main && !q.main.length) { tally.fp++; issues.push(`unlisted title matched ${extra[0]}`); }
  if (q.first && M[0] !== q.first) issues.push(`first should be ${q.first}, got ${M[0]}`);
  for (const [a, b] of q.before || []) if (!(M.includes(a) && M.includes(b) && M.indexOf(a) < M.indexOf(b))) issues.push(`${a} should come before ${b}`);
  const hitOf = id => res.main.concat(res.possible, res.isbnPrefix).find(h => rowId(h.row) === id);
  for (const n of q.note || []) { const h = hitOf(n.row); if (!h || !h.notes.some(t => t.includes(n.text))) issues.push(`${n.row} notes lack "${n.text}"`); }
  for (const n of q.noteNot || []) { const h = hitOf(n.row); if (h && h.notes.some(t => t.includes(n.text))) issues.push(`${n.row} notes: ${h.notes.join('; ')}`); }
  const P = ids(res.possible);
  if (q.firstPossible && P[0] !== q.firstPossible) issues.push(`first Possible should be ${q.firstPossible}, got ${P[0]} (${q.firstPossible} at #${P.indexOf(q.firstPossible) + 1})`);
  for (const [id, n] of q.possibleWithin || []) { const i = P.indexOf(id); if (i < 0 || i >= n) issues.push(`${id} at Possible #${i + 1}, not in the first ${n}`); }
  if (q.state && res.state !== q.state) issues.push(`state ${res.state}`);
  if (q.hint && !res.hints.some(h => h.code === q.hint)) issues.push(`hint ${q.hint} missing`);
  return issues;
}
function runAll(rows, queries) {
  const { ix, byId } = build(rows), tally = { main: 0, gotMain: 0, any: 0, gotAny: 0, floods: 0, fp: 0 }, failing = {};
  for (const q of queries) {
    const issues = check(q, E.search(q.q, ix, { enter: !!q.enter }), byId, tally);
    if (issues.length) failing[q.q] = `${issues.join('; ')}${q.prd ? '  [PRD ' + q.prd + ']' : ''}`;
  }
  return { tally, failing };
}

test('realistic list: recall, floods and false positives over every query; only the documented PRD exceptions fail', () => {
  const { tally, failing } = runAll(L.rows, L.queries);
  const summary = `main recall ${tally.gotMain}/${tally.main}, any-tier recall ${tally.gotAny}/${tally.any}, floods ${tally.floods}, ` +
    `false positives ${tally.fp} (${L.queries.length} queries on ${L.rows.length} rows)`;
  console.log('    ' + summary);
  const unexpected = Object.entries(failing).filter(([q]) => !EXCEPTIONS[q]).map(([q, why]) => `${JSON.stringify(q)}: ${why}`);
  assert.deepEqual(unexpected, [], summary);
  assert.deepEqual(Object.keys(EXCEPTIONS).filter(q => !failing[q]), [], 'an exception that now holds should leave EXCEPTIONS');
  assert.equal(tally.gotAny, tally.any, summary);                                        // missing an item is worse than an extra one
  assert.equal(tally.gotMain, tally.main, summary);
});

test('realistic list at ~1,180 rows: volumes, grades and yearly editions stay findable and ranked', () => {
  const rows = L.scaleRows(), { tally, failing } = runAll(rows, L.scaleQueries);
  assert.ok(rows.length > 1100);
  assert.deepEqual(failing, {}, `main recall ${tally.gotMain}/${tally.main}, any-tier recall ${tally.gotAny}/${tally.any}`);
});

test('realistic list: every query a review-2 finding reproduced now holds (GEN-1 to GEN-5)', () => {
  const tagged = L.queries.concat(L.scaleQueries).filter(q => q.finding);
  assert.ok(tagged.length >= 25);
  const small = runAll(L.rows, L.queries.filter(q => q.finding)).failing, big = runAll(L.scaleRows(), L.scaleQueries.filter(q => q.finding)).failing;
  const left = Object.keys(Object.assign({}, small, big)).filter(q => !EXCEPTIONS[q]);
  assert.deepEqual(left, []);
});
