// node run.js [engine.js] [--all] [--json out.json]
'use strict';
const path = require('path');
const { load } = require('./load.js');
const { Q } = require('./queries.js');
const engFile = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'engine.js';
const E = require(path.resolve(__dirname, engFile));
const showAll = process.argv.includes('--all');
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

const { rows } = load();
const ix = E.buildIndex(rows);
const id = r => (r.tab === 'Sheet1' ? 'S' : 'O') + r.row;
const nice = x => x.replace(/^S(\d+)/, 'Sheet1!$1').replace(/^O(\d+)/, 'Other!$1');

let rowsExp = 0, rowsFound = 0, rowsStrong = 0, qFull = 0, qScored = 0, floods = 0, fps = 0, noiseAboveN = 0;
const out = [];
for (const t of Q) {
  const r = E.search(t.q, ix, { enter: !!t.enter });
  const S = (r.strong || []).map(x => id(x.doc.r)), P = (r.possible || []).map(x => id(x.doc.r));
  const all = [...S, ...P];
  const okSet = new Set([...t.exp, ...(t.ok || [])]);
  const noiseS = S.filter(x => !okSet.has(x)), noiseP = P.filter(x => !okSet.has(x));
  const ranks = t.exp.map(e => all.indexOf(e) + 1);
  const found = t.exp.filter(e => all.includes(e));
  const strongFound = t.exp.filter(e => S.includes(e));
  const firstExp = Math.min(...ranks.filter(x => x > 0), Infinity);
  const noiseAbove = all.slice(0, firstExp === Infinity ? 0 : firstExp - 1).filter(x => !okSet.has(x));
  const flood = noiseS.length >= 2 || noiseS.length + noiseP.length >= 4;
  const fp = t.exp.length === 0 && noiseS.length >= 1;
  if (!t.uns) {
    rowsExp += t.exp.length; rowsFound += found.length; rowsStrong += strongFound.length;
    if (t.exp.length) { qScored++; if (found.length === t.exp.length) qFull++; }
    if (flood) floods++; if (fp) fps++; if (noiseAbove.length) noiseAboveN++;
  }
  const status = t.exp.length === 0 ? (flood ? 'FLOOD' : fp ? 'FALSE+' : r.tooShort ? 'hint' : 'ok-none')
    : found.length < t.exp.length ? (t.uns ? 'UNSOLV' : 'MISS') : strongFound.length < t.exp.length ? 'possible' : 'STRONG';
  const rec = { q: t.q, cat: t.cat, exp: t.exp, status, strong: S, possible: P, nS: S.length, nP: P.length, ranks, noiseS, noiseP, noiseAbove, flood, fp, tooShort: !!r.tooShort, uns: !!t.uns };
  out.push(rec);
  const flag = (flood ? ' FLOOD' : '') + (noiseAbove.length ? ' NOISE-ABOVE' : '') + (fp && !flood ? ' FALSE+' : '');
  if (showAll || status === 'MISS' || flag || status === 'UNSOLV' || status === 'possible')
    console.log(`${status.padEnd(8)} ${JSON.stringify(t.q).slice(0, 62).padEnd(62)} exp=[${t.exp.join(',')}] rank=[${ranks.join(',')}] S${S.length}/P${P.length} strong=[${S.slice(0, 6).join(',')}${S.length > 6 ? '…' : ''}] poss=[${P.slice(0, 6).join(',')}${P.length > 6 ? '…' : ''}]${flag}${r.tooShort ? ' (tooShort)' : ''}`);
}
const pct = (a, b) => `${a}/${b} (${(100 * a / b).toFixed(1)}%)`;
console.log('\n==== ' + engFile + ` — ${Q.length} queries (${Q.filter(t => t.uns).length} unsolvable excluded from recall)`);
console.log('row recall (any tier):   ', pct(rowsFound, rowsExp));
console.log('row recall (strong tier):', pct(rowsStrong, rowsExp));
console.log('queries fully recalled:  ', pct(qFull, qScored));
console.log('floods (>=2 noise strong or >=4 noise total):', floods, ' | false-positive strong on no-answer queries:', fps, ' | noise ranked above expected:', noiseAboveN);
const medRes = out.map(o => o.nS + o.nP).sort((a, b) => a - b); console.log('results per query: median', medRes[medRes.length >> 1], 'max', medRes[medRes.length - 1]);
if (jsonOut) require('fs').writeFileSync(path.resolve(__dirname, jsonOut), JSON.stringify(out, null, 1));
