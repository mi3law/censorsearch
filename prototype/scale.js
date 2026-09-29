// Recall and rank of the teacher queries when the real sample rows are hidden among 20,000 synthetic rows.
// Run gen_synthetic.js first. Usage: node scale.js [engine.js ...]
'use strict';
const path = require('path');
const { Q } = require('./queries.js');
const rows = require('./data/rows20k.json');
const id = r => (r.tab === 'Sheet1' && r.row <= 23 ? 'S' : r.tab === 'Sheet1' ? 'X' : 'O') + r.row;
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ['engine.js'];
for (const f of engines) {
  const E = require(path.resolve(__dirname, f)); const ix = E.buildIndex(rows);
  let exp = 0, found = 0, strong = 0, top10 = 0, top25 = 0; const miss = [], deep = [];
  for (const t of Q) { if (t.uns) continue;
    const r = E.search(t.q, ix, { enter: !!t.enter });
    const S = r.strong.map(x => id(x.doc.r)), all = [...S, ...r.possible.map(x => id(x.doc.r))];
    for (const e of t.exp) { exp++; const k = all.indexOf(e); if (k < 0) { miss.push(t.q); continue; } found++; if (S.includes(e)) strong++;
      // rank within its own tier (the UI draws the first 50 strong and 25 possible)
      const tierRank = S.includes(e) ? S.indexOf(e) + 1 : r.possible.map(x => id(x.doc.r)).indexOf(e) + 1;
      if (tierRank <= 10) top10++; if (tierRank <= 25) top25++; else deep.push(`${t.q} (${S.includes(e) ? 'strong' : 'possible'} #${tierRank})`); } }
  console.log(`${f}: found ${found}/${exp}, strong ${strong}/${exp}, within top-10 of its tier ${top10}, within top-25 ${top25}`);
  if (miss.length) console.log('   missed:', [...new Set(miss)].join(' | '));
  if (deep.length) console.log('   below 25th in tier:', deep.join(' | '));
}
