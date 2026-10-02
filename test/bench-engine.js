// Benchmark for src/engine.js at 20,000 rows (a script, not a test): node test/bench-engine.js
// Uses prototype/data/rows20k.json (the sample rows hidden among 20,000 synthetic rows; gitignored). Generate it first with
//   node prototype/gen_synthetic.js
// Reports index build time, per-keystroke search time (every prefix of the prototype's bench queries, from 2 characters),
// result counts for flood-prone queries, and the prototype's recall-at-scale check (prototype/scale.js) on the teacher queries.
// Targets: build < 1.5 s, keystroke median < 2 ms and p95 < 10 ms, every expected row still found. Exit code 1 when missed.
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../src/engine.js');
const { toRow } = require('./helpers/sample.js');
const { queryOverrides, aliases } = require('./prd-cases.js');

const DATA = path.join(__dirname, '..', 'prototype', 'data', 'rows20k.json');
if (!fs.existsSync(DATA)) {
  console.log(`Missing ${path.relative(process.cwd(), DATA)}: run "node prototype/gen_synthetic.js" first (needs the sample .xlsx).`);
  process.exit(2);
}
const { Q } = require('../prototype/queries.js');
const rows = JSON.parse(fs.readFileSync(DATA, 'utf8')).map((r, i) => toRow(r, i));
// scale.js ids: S = sample Sheet1 rows (4-23), X = synthetic rows, O = Other Materials
const id = r => (r.tab === 'Sheet1' && r.row <= 23 ? 'S' : r.tab === 'Sheet1' ? 'X' : 'O') + r.row;
const present = new Set(rows.map(id));

const builds = [];
let ix;
for (let i = 0; i < 3; i++) { const t0 = performance.now(); ix = E.buildIndex(rows, { aliases }); builds.push(performance.now() - t0); }
const build = builds[0];

const BENCH = ['orwell 1984', 'fahrenheit 451', 'farenheit', 'the seven habits of highly effective teens', 'one minute monologues for women',
  'morgan spurlock', 'melvin berger', 'lemony snicket wide window', 'grandmother', 'aarons hair', 'don quixote activity book',
  'supplementary english class 8', 'R. L. Stine', '9798891808546', 'ckla unit 7', 'world book', 'the jungle book'];
for (const q of BENCH) E.search(q, ix);                                                  // warm up
const ts = [];
for (let round = 0; round < 3; round++) for (const q of BENCH) for (let i = 2; i <= q.length; i++) {
  const s = performance.now(); E.search(q.slice(0, i), ix); ts.push(performance.now() - s);
}
ts.sort((a, b) => a - b);
const pick = f => ts[Math.min(ts.length - 1, Math.floor(ts.length * f))];
const median = pick(0.5), p95 = pick(0.95), max = ts[ts.length - 1];
console.log(`rows ${rows.length} | index build ${build.toFixed(0)} ms (rebuilds ${builds.slice(1).map(b => b.toFixed(0)).join(', ')} ms)`);
console.log(`keystrokes ${ts.length} | median ${median.toFixed(2)} ms | p95 ${p95.toFixed(2)} ms | max ${max.toFixed(1)} ms`);
const cnt = q => { const r = E.search(q, ix); return `${q}: M${r.main.length}/P${r.possible.length}${r.isbnPrefix.length ? '/I' + r.isbnPrefix.length : ''}`; };
console.log('counts:', ['stine', 'shine', 'the', '20', 'book 3', 'world book', 'the jungle book', 'ministry of truth', 'harry potter', 'grade 5'].map(cnt).join(' | '));

// Recall at scale (prototype/scale.js): each expected row must still be found; report its rank within its tier.
let exp = 0, found = 0, inMain = 0, top10 = 0, top25 = 0;
const miss = [], deep = [];
for (const t0 of Q) {
  const o = queryOverrides[t0.q] || {};
  const t = Object.assign({}, t0, o.exp ? { exp: o.exp, uns: false } : {});
  if (t.uns || o.drop) continue;
  const r = E.search(t.q, ix, { enter: !!t.enter });
  const M = r.main.map(h => id(h.row)), P = r.possible.map(h => id(h.row)), X = r.isbnPrefix.map(h => id(h.row));
  for (const e of t.exp.filter(x => present.has(x))) {                                   // synthetic PRD rows (XA1…) are not in this set
    exp++;
    const list = M.includes(e) ? M : P.includes(e) ? P : X.includes(e) ? X : null;
    if (!list) { miss.push(`${t.q} -> ${e}`); continue; }
    found++;
    if (list === M || (list === X && r.isbnQuery)) inMain++;
    const rank = list.indexOf(e) + 1;
    if (rank <= 10) top10++;
    if (rank <= 25) top25++; else deep.push(`${t.q} (${list === M ? 'main' : list === P ? 'possible' : 'isbnPrefix'} #${rank})`);
  }
}
console.log(`recall at scale: found ${found}/${exp}, in main ${inMain}/${exp}, within top-10 of its list ${top10}, within top-25 ${top25}`);
if (miss.length) console.log('   missed:', miss.join(' | '));
if (deep.length) console.log('   below 25th:', deep.join(' | '));

const failed = [];
if (build >= 1500) failed.push(`index build ${build.toFixed(0)} ms >= 1500 ms`);
if (median >= 2) failed.push(`median ${median.toFixed(2)} ms >= 2 ms`);
if (p95 >= 10) failed.push(`p95 ${p95.toFixed(2)} ms >= 10 ms`);
if (miss.length) failed.push(`${miss.length} expected rows not found`);
console.log(failed.length ? 'TARGETS MISSED: ' + failed.join('; ') : 'all targets met');
process.exit(failed.length ? 1 : 0);
