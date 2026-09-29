// Writes data/rows20k.json: the real sample rows hidden among 20,000 synthetic rows, for scale.js and bench.js.
// Titles use dictionary words (Zipf-like), 10% inverted ", The", 10% ": Volume N", 5% leading numbers.
// Needs /usr/share/dict/words and /usr/share/dict/propernames (present on macOS). Output is gitignored.
'use strict';
const fs = require('fs');
const path = require('path');
const { load } = require('./load.js');

let seed = 42; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const all = fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n').filter(w => /^[a-z]{3,10}$/.test(w));
const common = []; for (let i = 0; i < 40000; i++) common.push(pick(all));
const names = fs.readFileSync('/usr/share/dict/propernames', 'utf8').split('\n').filter(Boolean);
const stop = ['the', 'of', 'and', 'a', 'to', 'in', 'for', 'with'];
const word = () => rnd() < 0.25 ? pick(stop) : common[Math.floor(Math.pow(rnd(), 1.2) * common.length)];
const cap = w => w[0].toUpperCase() + w.slice(1);

const rows = load().rows.slice();
for (let i = 0; i < 20000; i++) {
  const n = 2 + Math.floor(rnd() * 8);
  let t = Array.from({ length: n }, word).map(cap).join(' ');
  if (rnd() < 0.1) t = t + ', The'; if (rnd() < 0.1) t += ': Volume ' + (1 + Math.floor(rnd() * 5)); if (rnd() < 0.05) t = (1 + Math.floor(rnd() * 500)) + ' ' + t;
  rows.push({ tab: 'Sheet1', row: 24 + i, title: t, author: rnd() < 0.3 ? '' : pick(names) + ' ' + pick(names), isbn: rnd() < 0.2 ? 9780000000000 + Math.floor(rnd() * 1e9) : '', bannedBy: pick(['Ministry', 'RS', 'KES', 'HUBS', 'UAS', 'NES']), type: pick(['Book', 'DVD', 'CD', 'Video', 'Play']), year: '2010-2011', memo: '' });
}
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'data', 'rows20k.json'), JSON.stringify(rows));
console.log(rows.length, 'rows written to data/rows20k.json');
