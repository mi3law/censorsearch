// Loads the data rows of every tab straight from a Google Sheets .xlsx export.
// Emulates what the live app gets: header row found by text, columns mapped by header,
// columns right of the table (the Sheet1 H5 notes box) ignored, empty rows skipped, sheet row number kept.
// Numeric cells are passed through as JS numbers (so the engine must String() them itself).
//
// The sample list is not committed (see .gitignore). By default this reads the first .xlsx in the
// repo root; pass another path with SAMPLE_XLSX=/path/to/file.xlsx. Requires the `unzip` CLI.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function samplePath() {
  if (process.env.SAMPLE_XLSX) return process.env.SAMPLE_XLSX;
  const root = path.join(__dirname, '..');
  const f = fs.readdirSync(root).find(n => n.toLowerCase().endsWith('.xlsx'));
  if (!f) throw new Error('No .xlsx found in the repo root; set SAMPLE_XLSX=/path/to/export.xlsx');
  return path.join(root, f);
}
const XLSX = samplePath();
const part = name => execFileSync('unzip', ['-p', XLSX, 'xl/' + name], { encoding: 'utf8', maxBuffer: 64 << 20 });

const dec = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
function sharedStrings() {
  const x = part('sharedStrings.xml');
  return [...x.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => dec(t[1])).join(''));
}
function sheets() {
  const wb = part('workbook.xml');
  const rels = part('_rels/workbook.xml.rels');
  const rm = Object.fromEntries([...rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map(m => [m[1], m[2]]));
  return [...wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"/g)].map(m => ({ name: dec(m[1]), file: rm[m[2]] }));
}
const colIdx = ref => ref.match(/^[A-Z]+/)[0].split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

const HEADERS = { title: /^(title|material|name)$/, author: /^(authors?|writer)$/, isbn: /^isbn/, bannedBy: /^banned ?by$/, type: /^(type|format)$/, year: /^(year of banning|year)$/, memo: /^(memo|notes?|link)$/ };

function load() {
  const ss = sharedStrings();
  const out = [], meta = {};
  for (const sh of sheets()) {
    const x = part(sh.file);
    const grid = new Map();                                   // sheetRow -> [cells]
    for (const r of x.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[2].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const v = (c[3] || '').match(/<v>([\s\S]*?)<\/v>/); if (!v) continue;
        const t = (c[2].match(/t="(\w+)"/) || [])[1];
        cells[colIdx(c[1])] = t === 's' ? ss[+v[1]] : t === 'str' || t === 'inlineStr' ? dec(v[1]) : Number(v[1]);
      }
      grid.set(+r[1], cells);
    }
    // header row: first row within the first 10 whose some cell folds to "title"
    let hdrRow = null, map = {};
    for (let r = 1; r <= 10 && hdrRow == null; r++) {
      const cells = grid.get(r) || [];
      if (cells.some(v => typeof v === 'string' && v.trim().toLowerCase() === 'title')) {
        hdrRow = r;
        cells.forEach((v, i) => { const h = String(v ?? '').trim().toLowerCase(); for (const [k, re] of Object.entries(HEADERS)) if (re.test(h) && !(k in map)) map[k] = i; });
      }
    }
    if (hdrRow == null) { console.warn('no header in', sh.name); continue; }
    meta[sh.name] = { updated: (grid.get(2) || []).find(v => /updated/i.test(String(v))) || null, header: hdrRow };
    const maxRow = Math.max(...grid.keys());
    for (let r = hdrRow + 1; r <= maxRow; r++) {
      const cells = grid.get(r) || [];
      const rec = { tab: sh.name, row: r };
      for (const k of Object.keys(HEADERS)) rec[k] = k in map && cells[map[k]] != null ? cells[map[k]] : '';
      if ([rec.title, rec.author, rec.isbn].every(v => String(v).trim() === '')) continue;
      out.push(rec);
    }
  }
  return { rows: out, meta };
}
module.exports = { load };
if (require.main === module) { const { rows, meta } = load(); console.log(meta); for (const r of rows) console.log(`${r.tab}!${r.row}`, JSON.stringify(r.title), typeof r.title, JSON.stringify(r.author), r.isbn, typeof r.isbn, r.memo); console.log(rows.length, 'rows'); }
