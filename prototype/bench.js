// Per-keystroke timing and flood counts on the 20,000-row synthetic set. Run gen_synthetic.js first.
// Usage: node bench.js [engine.js ...]
'use strict';
const path = require('path');
const rows = require('./data/rows20k.json');
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ['engine.js'];
for (const f of engines) {
  const E = require(path.resolve(__dirname, f)); const t0 = performance.now(); const ix = E.buildIndex(rows); const build = performance.now() - t0;
  const Q = ['orwell 1984','fahrenheit 451','farenheit','the seven habits of highly effective teens','one minute monologues for women','morgan spurlock','melvin berger','lemony snicket wide window','grandmother','aarons hair','don quixote activity book','supplementary english class 8','R. L. Stine','9798891808546','ckla unit 7','world book','the jungle book'];
  const ts = []; for (const q of Q) for (let i = 2; i <= q.length; i++) { const s = performance.now(); E.search(q.slice(0, i), ix); ts.push(performance.now() - s); }
  ts.sort((a, b) => a - b);
  const cnt = q => { const r = E.search(q, ix); return `${q}: S${r.strong.length}/P${r.possible.length}`; };
  console.log(f, `build ${build.toFixed(0)}ms  keystroke median ${ts[ts.length>>1].toFixed(2)}ms p95 ${ts[Math.floor(ts.length*.95)].toFixed(2)}ms max ${ts[ts.length-1].toFixed(1)}ms`);
  console.log('   ', ['stine','shine','the','20','book 3','world book','the jungle book','ministry of truth','harry potter','grade 5'].map(cnt).join(' | '));
}
