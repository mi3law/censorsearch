// Tests for src/sheet.js (CensorSheet). Synthetic data only; the parity test against the gitignored
// sample exports (test/data/live-*.csv and the .xlsx in the repo root) skips when they are absent.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../src/sheet.js');
const { hasSample, loadSampleRows } = require('./helpers/sample.js');

const SID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';
const csv = lines => lines.join('\r\n');                   // Google: CRLF, no trailing newline
const rowsOf = (text, opts = {}) => S.extractRows(S.tableFromCsv(S.parseCsv(text), { tab: 'T', gid: '0', sheetId: SID }), opts);

// A synthetic tab shaped like the real Sheet1: banner rows, header on row 3 with an empty trailing header cell,
// a multi-line notes box in column H on the row-5 line, an empty row, paste residue and a scientific ISBN.
const SYN = csv([
  'Synthetic Banned List 2004-2026,,,,,,,',
  'updated as of 1 January 2026,,,,,,,',
  'Title,Author,ISBN,Banned By,Type,Year of Banning,Memo,',
  'Alpha Jokes,Pat Writer,,RS,Book,2010-2011,,',
  'Beta Stories,Sample Press,,KES,Book,2006-2007,,"Notes: \n\nRed means one thing.\n\nBlue means another.\n\n\nAll other listings are checked."',
  'Gamma Science,Lee Author,,HUBS,Book,2009-2010,,',
  '"Delta Soup, A",Kim Doe Et Al,,Ministry,Book,2008-2009,,',
  'Epsilon Guide+2:10B11:120:140,,,Ministry,DVD,2008-2009,,',
  ',,,,,,,',
  '"Zeta ""Quoted"" Title",Ann Other,9.79889E+12,UAS,Book,2020-2021,Memo 12,',
  '1985,Num Author,9780000000002,Minstry,Book,2023-2024,,',
]);

// ------------------------------------------------------------------------------------------------
test('parseCsv: quotes, doubled quotes, embedded line breaks, empty lines, BOM, line ends', () => {
  assert.deepEqual(S.parseCsv(''), []);
  assert.deepEqual(S.parseCsv('a,b'), [['a', 'b']]);
  assert.deepEqual(S.parseCsv('a,b\r\n'), [['a', 'b']], 'a trailing CRLF adds no record');
  assert.deepEqual(S.parseCsv('a,b\n'), [['a', 'b']]);
  assert.deepEqual(S.parseCsv('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(S.parseCsv('a\nb\r\nc'), [['a'], ['b'], ['c']], 'mixed LF and CRLF');
  assert.deepEqual(S.parseCsv('a\rb'), [['a'], ['b']], 'a lone CR ends a record');
  assert.deepEqual(S.parseCsv('"x\ry",z'), [['x\ry', 'z']], 'a lone CR inside quotes is data');
  assert.deepEqual(S.parseCsv('"a,b",c'), [['a,b', 'c']]);
  assert.deepEqual(S.parseCsv('"say ""hi""",x'), [['say "hi"', 'x']]);
  assert.deepEqual(S.parseCsv('"",""'), [['', '']]);
  assert.deepEqual(S.parseCsv('"line1\r\nline2\nline3",b\r\nc,d'), [['line1\r\nline2\nline3', 'b'], ['c', 'd']]);
  assert.deepEqual(S.parseCsv('a\r\n\r\n\r\nb'), [['a'], [''], [''], ['b']], 'empty lines are kept as rows');
  assert.deepEqual(S.parseCsv('a\r\n\r\n'), [['a'], ['']], 'an empty last line before the final break is kept');
  assert.deepEqual(S.parseCsv('﻿Title,Author\r\nx,y'), [['Title', 'Author'], ['x', 'y']], 'BOM stripped');
  assert.deepEqual(S.parseCsv(',,'), [['', '', '']]);
  assert.deepEqual(S.parseCsv('a,"b"'), [['a', 'b']], 'quoted field at end of input');
  assert.deepEqual(S.parseCsv('a,"open\nstill'), [['a', 'open\nstill']], 'unterminated quote runs to the end');
  assert.deepEqual(S.parseCsv('ab"c,d'), [['ab"c', 'd']], 'a stray quote inside an unquoted field is literal');
});

test('row numbers equal sheet rows; notes box and empty rows do not shift them', () => {
  const grid = S.parseCsv(SYN);
  assert.equal(grid.length, 11);
  const { rows, meta, issues } = rowsOf(SYN);
  assert.deepEqual(rows.map(r => [r.row, r.title]), [
    [4, 'Alpha Jokes'], [5, 'Beta Stories'], [6, 'Gamma Science'], [7, 'Delta Soup, A'],
    [8, 'Epsilon Guide+2:10B11:120:140'], [10, 'Zeta "Quoted" Title'], [11, '1985'],
  ]);
  assert.equal(meta.headerRow, 3);
  assert.equal(meta.updatedAsOf, 'updated as of 1 January 2026');
  assert.equal(meta.bannerTitle, 'Synthetic Banned List 2004-2026');
  assert.equal(meta.lastCol, 'G', 'the empty-header column H (notes box) is not part of the table');
  assert.equal(meta.rowCount, 7);
  assert.equal(meta.hiddenKnown, false);
  assert.deepEqual(meta.mapping, { title: 0, author: 1, isbn: 2, bannedBy: 3, type: 4, year: 5, memo: 6 });
  assert.equal(meta.headers[7], '');
  const beta = rows[1];
  assert.deepEqual(beta.extra, [], 'notes box text is ignored');
  for (const r of rows) for (const v of Object.values(r)) if (typeof v === 'string') assert.ok(!/Red means/.test(v));
  assert.ok(issues.every(i => i.tab === 'T'));
});

test('row shape: strings as written, status, fingerprint, CSV-path defaults', () => {
  const { rows } = rowsOf(SYN);
  const r = rows[6];
  assert.equal(r.title, '1985', 'a numeric title stays the displayed string');
  assert.equal(r.isbn, '9780000000002');
  assert.equal(r.id, null);
  assert.deepEqual(
    { tab: r.tab, gid: r.gid, sheetId: r.sheetId, isbnRaw: r.isbnRaw, memoUrl: r.memoUrl, titleUrl: r.titleUrl, hidden: r.hidden, section: r.section, lastCol: r.lastCol },
    { tab: 'T', gid: '0', sheetId: SID, isbnRaw: '', memoUrl: null, titleUrl: null, hidden: null, section: null, lastCol: 'G' });
  assert.equal(r.status.level, 'ministry', '"Minstry" is within one edit of Ministry');
  assert.equal(rows[5].status.label, 'Banned by UAS');
  assert.equal(rows[0].status.label, 'Check case by case (RS)');
  assert.equal(r.fingerprint, S.fingerprint(r));
  assert.equal(S.fingerprint({ title: ' 1985 ', author: 'NUM  Author', bannedBy: 'Minstry', year: '2023-2024' }), r.fingerprint,
    'fingerprint ignores case and spacing');
  assert.notEqual(S.fingerprint({ ...r, year: '2024-2025' }), r.fingerprint);
  // values are never trimmed for display
  const { rows: t } = rowsOf(csv(['Title,Author,Banned By', 'Trailing space ,  Two Spaces,Ministry']));
  assert.equal(t[0].title, 'Trailing space ');
  assert.equal(t[0].author, '  Two Spaces');
});

test('header detection: row under banners, "No." column, header not in column A, synonyms, priority', () => {
  // "No." column before Title
  let out = rowsOf(csv(['No.,Title,Author,Banned By', '1,Foo Book,Bar Writer,Ministry']));
  assert.equal(out.meta.mapping.title, 1);
  assert.equal(out.meta.lastCol, 'D');
  assert.deepEqual(out.rows[0].extra, [{ header: 'No.', value: '1' }]);
  assert.equal(out.rows[0].row, 2);

  // header not in column A and on row 5
  out = rowsOf(csv(['Big banner,,,', ',,,', 'updated as of today,,,', ',,,', ',,Title,Writer', ',,Foo,Bar', 'stray,,,']));
  assert.equal(out.meta.headerRow, 5);
  assert.equal(out.meta.mapping.title, 2);
  assert.equal(out.meta.mapping.author, 3);
  assert.equal(out.meta.lastCol, 'D');
  assert.equal(out.meta.updatedAsOf, 'updated as of today');
  assert.equal(out.meta.bannerTitle, 'Big banner');
  assert.deepEqual(out.rows.map(r => [r.row, r.title, r.author]), [[6, 'Foo', 'Bar']], 'column A text outside the table is ignored');

  // synonyms
  out = rowsOf(csv(['Material,Author(s),ISBN-13,BannedBy,Format,Year Banned,Notes', 'Foo,Bar,123,MOE,DVD,2020,memo']));
  assert.deepEqual(out.meta.mapping, { title: 0, author: 1, isbn: 2, bannedBy: 3, type: 4, year: 5, memo: 6 });
  out = rowsOf(csv(['TITLE:,Author Name,ISBN No.,Banned,Material Type,Year,Memo Link', 'Foo,Bar,123,MOE,DVD,2020,memo']));
  assert.deepEqual(out.meta.mapping, { title: 0, author: 1, isbn: 2, bannedBy: 3, type: 4, year: 5, memo: 6 });
  out = rowsOf(csv(['name,writer,link', 'Foo,Bar,https://x']));
  assert.deepEqual([out.meta.mapping.title, out.meta.mapping.author, out.meta.mapping.memo], [0, 1, 2]);

  // "Title" wins over "Name" wherever the columns sit; the loser becomes an extra column
  out = rowsOf(csv(['Name,Title,Author', 'Shelf 3,Foo,Bar']));
  assert.equal(out.meta.mapping.title, 1);
  assert.deepEqual(out.rows[0].extra, [{ header: 'Name', value: 'Shelf 3' }]);

  // header on row 10 is found; on row 11 it is not
  const pad = n => Array.from({ length: n }, (_, i) => 'banner ' + (i + 1));
  assert.equal(rowsOf(csv([...pad(9), 'Title,Author', 'Foo,Bar'])).meta.headerRow, 10);
  assert.throws(() => rowsOf(csv([...pad(10), 'Title,Author', 'Foo,Bar'])), e => e.kind === 'format' && /Title/.test(e.message));
  assert.throws(() => rowsOf(csv(['Author,ISBN', 'Bar,123'])), e => e.kind === 'format');
  assert.throws(() => rowsOf(''), e => e.kind === 'format');

  // missing Author column is allowed, with a maintainer note
  out = rowsOf(csv(['Title,Banned By', 'Foo,Ministry']));
  assert.equal(out.meta.mapping.author, -1);
  assert.equal(out.rows[0].author, '');
  assert.ok(out.issues.some(i => i.kind === 'missingColumn'));
});

test('unmapped headed columns become extra; empty-header columns are ignored', () => {
  const { rows, meta } = rowsOf(csv([
    'Title,Author,Banned By,Status,Reason,,Type',
    'Foo,Bar,Ministry,Lifted 2025,,ignored,Book',
    'Baz,Qux,UAS,,  ,,DVD',
  ]));
  assert.deepEqual(rows[0].extra, [{ header: 'Status', value: 'Lifted 2025' }]);
  assert.deepEqual(rows[1].extra, [], 'blank extra cells are left out');
  assert.equal(rows[0].type, 'Book');
  assert.equal(meta.lastCol, 'G');
  assert.ok(!JSON.stringify(rows).includes('ignored'));
});

test('empty rows are skipped: Title, Author and ISBN all empty', () => {
  const { rows } = rowsOf(csv([
    'Title,Author,ISBN,Banned By,Type',
    ',,,Ministry,Book',            // formatted/partly filled but no title/author/isbn
    ' ,   ,​,,',
    ',Only Author,,KES,',
    ',,9780000000002,,',
    ',,,,',
    'Last,,,RS,',
  ]));
  assert.deepEqual(rows.map(r => r.row), [4, 5, 7]);
});

test('repeated header rows are skipped with an issue', () => {
  const { rows, issues } = rowsOf(csv([
    'Title,Author,Banned By,Type',
    'Foo,Bar,Ministry,Book',
    'Title,Author,Banned By,Type',
    'TITLE,Writer,,',
    'Baz,Qux,UAS,Book',
    'Name,Real Author,Ministry,Book',
  ]));
  assert.deepEqual(rows.map(r => [r.row, r.title]), [[2, 'Foo'], [5, 'Baz'], [6, 'Name']]);
  assert.deepEqual(issues.filter(i => i.kind === 'repeatedHeader').map(i => i.row), [3, 4]);
});

test('section-heading rows become context and an issue, only when most rows have Banned By', () => {
  const { rows, issues } = rowsOf(csv([
    'Title,Author,Banned By,Type,Year',
    'Early item,Someone,KES,Book,2019',
    '2024-2025 additions,,,,',
    'Foo,Bar,Ministry,Book,2024',
    'Baz,,KES,DVD,2025',
    'Older items,,,,',
    'Qux,Q,UAS,Book,2020',
  ]));
  assert.deepEqual(rows.map(r => [r.row, r.title, r.section]), [
    [2, 'Early item', null], [4, 'Foo', '2024-2025 additions'], [5, 'Baz', '2024-2025 additions'], [7, 'Qux', 'Older items'],
  ]);
  assert.deepEqual(issues.filter(i => i.kind === 'sectionHeading').map(i => i.row), [3, 6]);

  // Title-only rows stay items when most rows lack Banned By (never drop a possible listing)
  const few = rowsOf(csv(['Title,Author,Banned By', 'Foo,,', 'Bar,,', 'Baz,X,Ministry']));
  assert.deepEqual(few.rows.map(r => r.title), ['Foo', 'Bar', 'Baz']);
  assert.equal(few.issues.filter(i => i.kind === 'sectionHeading').length, 0);

  // A title-only row that doesn't read like a heading stays an item (merged Banned By on the CSV path, or a new row
  // with only its title so far) and never labels the rows below it (COV-1)
  const merged = rowsOf(csv([
    'Title,Author,ISBN,Banned By,Type,Year of Banning,Memo',
    'Alpha Book,A Writer,,Ministry,Book,2020-2021,',
    'Merged Ban Twin,,,,,,',
    'Gamma Book,C Writer,,KES,Book,2020-2021,',
    'Delta Book,D Writer,,KES,Book,2020-2021,',
  ]));
  assert.deepEqual(merged.rows.map(r => [r.row, r.title, r.section, r.status.label]), [
    [2, 'Alpha Book', null, 'Must remove (Ministry)'], [3, 'Merged Ban Twin', null, 'Status not stated, open the row'],
    [4, 'Gamma Book', null, 'Check case by case (KES)'], [5, 'Delta Book', null, 'Check case by case (KES)'],
  ]);
  assert.equal(merged.issues.filter(i => i.kind === 'sectionHeading').length, 0);
  const headingLike = ['2024/25 additions', 'Section B', 'Newer titles', 'Continued from above', 'Added this year:'];
  for (const h of headingLike) {
    const out = rowsOf(csv(['Title,Author,Banned By', 'A,B,Ministry', h + ',,', 'C,D,KES', 'E,F,KES']));
    assert.deepEqual(out.rows.map(r => [r.title, r.section]), [['A', null], ['C', h], ['E', h]], h);
  }
  // Apps Script path: a heading merged across the row repeats its text in every cell
  const across = rowsOf(csv(['Title,Author,Banned By', 'A,B,Ministry', 'Plain Words,Plain Words,Plain Words', 'C,D,KES', 'E,F,KES']));
  assert.deepEqual(across.rows.map(r => [r.title, r.section]), [['A', null], ['C', 'Plain Words'], ['E', 'Plain Words']]);

  // A row with any other cell filled is an item, not a heading
  const item = rowsOf(csv(['Title,Author,Banned By,Status', 'A,B,Ministry,', 'C,D,KES,', 'Lonely,,,Lifted']));
  assert.deepEqual(item.rows.map(r => r.title), ['A', 'C', 'Lonely']);
});

test('paste residue and scientific ISBN are kept as written and logged', () => {
  const { rows, issues } = rowsOf(SYN);
  const eps = rows.find(r => r.row === 8);
  assert.equal(eps.title, 'Epsilon Guide+2:10B11:120:140');
  const zeta = rows.find(r => r.row === 10);
  assert.equal(zeta.isbn, '9.79889E+12');
  assert.deepEqual(issues.map(i => [i.row, i.kind]), [[8, 'pasteResidue'], [10, 'isbnScientific']]);
  assert.ok(issues.every(i => typeof i.message === 'string' && i.message.length > 10));
  // a plain "+" in a title is not residue
  assert.equal(rowsOf(csv(['Title', 'A+ Spelling', 'C++ for Teens'])).issues.filter(i => i.kind === 'pasteResidue').length, 0);
});

// ------------------------------------------------------------------------------------------------
test('parseBannedBy', () => {
  const cases = [
    ['Ministry', 'ministry', 'Must remove (Ministry)', ['Ministry']],
    ['Minstry', 'ministry', 'Must remove (Ministry)', ['Ministry']],
    ['ministery', 'ministry', 'Must remove (Ministry)', ['Ministry']],
    ['Minsitry', 'ministry', 'Must remove (Ministry)', ['Ministry']],
    ['MOE', 'ministry', 'Must remove (Ministry)', ['Ministry']],
    ['M.O.E.', 'ministry', 'Must remove (Ministry)', ['Ministry']],
    ['Ministry of Education', 'ministry', 'Must remove (Ministry)', ['Ministry']],
    ['KES / Ministry', 'ministry', 'Must remove (Ministry)', ['KES', 'Ministry']],
    ['Ministry, UAS', 'ministry', 'Must remove (Ministry)', ['Ministry', 'UAS']],
    ['UAS', 'uas', 'Banned by UAS', ['UAS']],
    ['uas', 'uas', 'Banned by UAS', ['UAS']],
    ['UAS; KES', 'uas', 'Banned by UAS', ['UAS', 'KES']],
    ['', 'blank', 'Status not stated, open the row', []],
    ['  ', 'blank', 'Status not stated, open the row', []],
    ['-', 'blank', 'Status not stated, open the row', []],
    ['N/A', 'blank', 'Status not stated, open the row', []],
    ['RS', 'other', 'Check case by case (RS)', ['RS']],
    ['rs', 'other', 'Check case by case (RS)', ['RS']],
    ['KES, RS', 'other', 'Check case by case (KES, RS)', ['KES', 'RS']],
    ['KES and RS', 'other', 'Check case by case (KES, RS)', ['KES', 'RS']],
    ['KES & RS + HUBS', 'other', 'Check case by case (KES, RS, HUBS)', ['KES', 'RS', 'HUBS']],
    ['KES, kes', 'other', 'Check case by case (KES)', ['KES']],
    ['MIN', 'other', 'Check case by case (MIN)', ['MIN']],
    // COV-7: variants two edits away, other forms and abbreviations still mean Ministry ("when in doubt, the more severe")
    ['Minstery', 'ministry', 'Must remove (Ministry)', ['Ministry']],
    ['Ministries', 'ministry', 'Must remove (Ministry)', ['Ministry']],
    ['Minister', 'ministry', 'Must remove (Ministry)', ['Ministry']],
    ['Min.', 'ministry', 'Must remove (Ministry)', ['Ministry']],
    ['M O E', 'ministry', 'Must remove (Ministry)', ['Ministry']],
    ['KES / Minstery', 'ministry', 'Must remove (Ministry)', ['KES', 'Ministry']],
    ['Minstrel', 'other', 'Check case by case (Minstrel)', ['Minstrel']],
    ['Industry', 'other', 'Check case by case (Industry)', ['Industry']],
    ['Registry', 'other', 'Check case by case (Registry)', ['Registry']],
    ['M O', 'other', 'Check case by case (M O)', ['M O']],
    ['Library Committee', 'other', 'Check case by case (Library Committee)', ['Library Committee']],
    ['Brandon', 'other', 'Check case by case (Brandon)', ['Brandon']],
  ];
  for (const [text, level, label, codes] of cases) {
    assert.deepEqual(S.parseBannedBy(text), { level, label, codes }, JSON.stringify(text));
  }
  assert.deepEqual(S.parseBannedBy(null), { level: 'blank', label: 'Status not stated, open the row', codes: [] });
  assert.deepEqual(S.parseBannedBy('abc', { schoolCode: 'ABC' }), { level: 'uas', label: 'Banned by ABC', codes: ['ABC'] });
  assert.deepEqual(S.parseBannedBy('UAS', { schoolCode: 'XYZ' }), { level: 'other', label: 'Check case by case (UAS)', codes: ['UAS'] });
});

// ------------------------------------------------------------------------------------------------
test('parseSheetUrl', () => {
  const b = 'https://docs.google.com/spreadsheets/d/' + SID;
  assert.deepEqual(S.parseSheetUrl(b + '/edit?usp=sharing'), { id: SID, gid: null });
  assert.deepEqual(S.parseSheetUrl(b + '/edit#gid=123'), { id: SID, gid: '123' });
  assert.deepEqual(S.parseSheetUrl(b + '/edit?gid=5#gid=5'), { id: SID, gid: '5' });
  assert.deepEqual(S.parseSheetUrl(b + '/edit?gid=5#gid=6&range=A1'), { id: SID, gid: '6' }, 'the hash is the tab on screen');
  assert.deepEqual(S.parseSheetUrl(b + '/htmlview'), { id: SID, gid: null });
  assert.deepEqual(S.parseSheetUrl(b + '/pubhtml?gid=77&single=true'), { id: SID, gid: '77' });
  assert.deepEqual(S.parseSheetUrl(b), { id: SID, gid: null });
  assert.deepEqual(S.parseSheetUrl('  ' + b + '/export?format=csv&gid=0 '), { id: SID, gid: '0' });
  assert.deepEqual(S.parseSheetUrl('https://docs.google.com/spreadsheets/u/1/d/' + SID + '/edit#gid=9'), { id: SID, gid: '9' });
  assert.deepEqual(S.parseSheetUrl('docs.google.com/spreadsheets/d/' + SID + '/edit'), { id: SID, gid: null });
  assert.deepEqual(S.parseSheetUrl(SID), { id: SID, gid: null }, 'bare id');
  assert.deepEqual(S.parseSheetUrl(b + '/edit#gid=abc'), { id: SID, gid: null }, 'non-numeric gid ignored');
  for (const bad of [
    '', '   ', 'hello world', 'not-a-link', null, undefined, 42, 'javascript:alert(1)',
    'https://example.com/spreadsheets/d/' + SID + '/edit',
    'https://docs.google.com.evil.example/spreadsheets/d/' + SID + '/edit',
    'https://evil.example/?u=https://docs.google.com/spreadsheets/d/' + SID,
    'https://docs.google.com/document/d/' + SID + '/edit',
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz0123456789/pubhtml',
    'ftp://docs.google.com/spreadsheets/d/' + SID,
    'https://docs.google.com/spreadsheets/d/short/edit',
  ]) assert.equal(S.parseSheetUrl(bad), null, String(bad));
});

test('parseScriptUrl', () => {
  const id = 'AKfycbx_Example-Deployment_0123456789abcdef';
  const norm = 'https://script.google.com/macros/s/' + id + '/exec';
  assert.equal(S.parseScriptUrl(norm), norm);
  assert.equal(S.parseScriptUrl(' ' + norm + '?gid=0 '), norm);
  assert.equal(S.parseScriptUrl('https://script.google.com/a/macros/school.example.edu/s/' + id + '/exec'), norm);
  for (const bad of [
    'https://script.google.com/macros/s/' + id + '/dev',
    'http://script.google.com/macros/s/' + id + '/exec',
    'https://script.google.com.evil.example/macros/s/' + id + '/exec',
    'https://evil.example/macros/s/' + id + '/exec',
    'https://script.googleusercontent.com/macros/echo?user_content_key=abc',
    'https://user:pw@script.google.com/macros/s/' + id + '/exec',
    'https://script.google.com/macros/s/' + id + '/exec/extra',
    'javascript:alert(1)', '', 'garbage', null,
  ]) assert.equal(S.parseScriptUrl(bad), null, String(bad));
});

test('tabNameFromDisposition', () => {
  const real = "attachment; filename=\"CopyofBannedMaterialsbyMinistryandOthers2004-2025asof28September26-Sheet1.csv\"; filename*=UTF-8''Copy%20of%20Banned%20Materials%20by%20Ministry%20and%20Others%202004-2025%20as%20of%2028%20September%2026%20-%20Sheet1.csv";
  assert.equal(S.tabNameFromDisposition(real), 'Sheet1');
  const other = "attachment; filename=\"CopyofBannedMaterialsbyMinistryandOthers2004-2025asof28September26-OtherMaterials.csv\"; filename*=UTF-8''Copy%20of%20Banned%20Materials%20by%20Ministry%20and%20Others%202004-2025%20as%20of%2028%20September%2026%20-%20Other%20Materials.csv";
  assert.equal(S.tabNameFromDisposition(other), 'Other Materials');
  assert.equal(S.tabNameFromDisposition("attachment; filename*=UTF-8''Doc%20-%20Caf%C3%A9%20list.csv"), 'Café list');
  assert.equal(S.tabNameFromDisposition("attachment; filename*=UTF-8''JustAName.csv"), 'JustAName');
  assert.equal(S.tabNameFromDisposition('attachment; filename="Doc - Tab Two.csv"'), 'Tab Two');
  assert.equal(S.tabNameFromDisposition('attachment; filename="Doc-TabTwo.csv"'), null, 'the ASCII name drops spaces: not trusted');
  assert.equal(S.tabNameFromDisposition("attachment; filename*=UTF-8''bad%E0%A4%A.csv"), null);
  assert.equal(S.tabNameFromDisposition(''), null);
  assert.equal(S.tabNameFromDisposition(null), null);
});

test('csvUrl, rowUrl, sheetUrl', () => {
  const b = 'https://docs.google.com/spreadsheets/d/' + SID;
  assert.equal(S.csvUrl(SID, '1111920478'), b + '/export?format=csv&gid=1111920478');
  assert.equal(S.csvUrl(SID, '0'), b + '/export?format=csv&gid=0');
  assert.equal(S.csvUrl(SID), b + '/export?format=csv', 'no gid: Google exports the first tab');
  assert.equal(S.csvUrl(SID, null), b + '/export?format=csv');
  assert.equal(S.csvUrl(SID, ''), b + '/export?format=csv');
  assert.equal(S.rowUrl(SID, '0', 16), b + '/edit?gid=0#gid=0&range=A16:G16');
  assert.equal(S.rowUrl(SID, '123', 4, 'D'), b + '/edit?gid=123#gid=123&range=A4:D4');
  assert.equal(S.rowUrl(SID, '123', 4, 'bad'), b + '/edit?gid=123#gid=123&range=A4:G4');
  assert.equal(S.rowUrl(SID, '', 4), b + '/edit', 'tab id unknown: Google ignores a range without a gid, so link the sheet');
  assert.equal(S.sheetUrl(SID, '0'), b + '/edit?gid=0#gid=0');
  assert.equal(S.sheetUrl(SID, '1111920478'), b + '/edit?gid=1111920478#gid=1111920478');
  assert.equal(S.sheetUrl(SID, null), b + '/edit');
  assert.equal(S.sheetUrl(SID, ''), b + '/edit');
  assert.equal(S.colLetter(0), 'A');
  assert.equal(S.colLetter(25), 'Z');
  assert.equal(S.colLetter(26), 'AA');
  assert.equal(S.colLetter(701), 'ZZ');
});

// ------------------------------------------------------------------------------------------------
const SCRIPT_ID = 'AKfycbx_Example-Deployment_0123456789abcdef';
const SCRIPT_URL = 'https://script.google.com/macros/s/' + SCRIPT_ID + '/exec';
const scriptJson = () => ({
  format: 'censorsearch-v1',
  spreadsheetId: SID,
  fetchedAt: '2026-09-29T20:05:00.000Z',
  tabs: [
    {
      name: 'Main', gid: '0', hiddenTab: false, headerRow: 3,
      above: [['Synthetic list'], ['updated as of 2 February 2026']],
      headers: ['Title', 'Author', 'ISBN', 'Banned By', 'Type', 'Year of Banning', 'Memo'],
      columns: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], lastColumn: 'G',
      rows: [
        { row: 4, values: ['Alpha', 'A. Writer', '', 'RS', 'Book', '2010-2011', ''], raw: {}, links: {}, hidden: false },
        { row: 6, values: ['Beta', '', '979-8-00000-000-1', 'Ministry', 'Book', '2020-2021', 'Memo 7'],
          raw: { 2: '9798000000001' }, links: { 6: 'https://drive.google.com/file/d/abc/view', 0: 'javascript:alert(1)' }, hidden: true },
        { row: 7, values: ['Gamma', '', '12-34', 'UAS', 'DVD', '2021-2022', 'Memo 8'],
          raw: { 2: '12 34 <b>' }, links: { 6: 'http://example.com/memo', 0: 'https://example.com/title' } },
        { row: 8, values: ['Delta', '', '', 'Ministry'] },
        { row: 2, values: ['Above header', '', '', ''] },
        { row: 'x', values: ['Bad row number'] },
      ],
    },
    {
      name: 'Second', gid: '123', headerRow: 1, above: [], hiddenTab: true,
      headers: ['Title', 'Banned By'], columns: ['B', 'D'], lastColumn: 'D',
      rows: [{ row: 2, values: ['Epsilon', 'Ministry'], raw: { 0: 9780000000002 } }],
    },
  ],
  errors: [{ tab: 'Archive', message: 'This tab is not in the allow-list.' }],
});

test('tablesFromScript: hidden rows, https-only links, raw ISBN digits, error entries', () => {
  const { tables, errors, sheetId } = S.tablesFromScript(scriptJson());
  assert.equal(sheetId, SID);
  assert.deepEqual(errors, [{ tab: 'Archive', message: 'This tab is not in the allow-list.', kind: 'script' }]);
  assert.equal(tables.length, 2);
  const { rows, meta } = S.extractRows(tables[0], {});
  assert.deepEqual(rows.map(r => r.row), [4, 6, 7, 8]);
  assert.deepEqual(rows.map(r => r.hidden), [false, true, null, null]);
  const [a, b, c, d] = rows;
  assert.equal(b.memoUrl, 'https://drive.google.com/file/d/abc/view');
  assert.equal(b.titleUrl, null, 'javascript: link dropped');
  assert.equal(b.isbn, '979-8-00000-000-1');
  assert.equal(b.isbnRaw, '9798000000001');
  assert.equal(c.memoUrl, null, 'http: link dropped');
  assert.equal(c.titleUrl, 'https://example.com/title');
  assert.equal(c.isbnRaw, '', 'raw value that is not digits/X dropped');
  assert.equal(a.isbnRaw, '');
  assert.equal(d.memo, '', 'short values array padded');
  assert.equal(b.status.level, 'ministry');
  assert.equal(c.status.level, 'uas');
  assert.deepEqual([a.tab, a.gid, a.sheetId, a.lastCol], ['Main', '0', SID, 'G']);
  assert.equal(meta.headerRow, 3);
  assert.equal(meta.updatedAsOf, 'updated as of 2 February 2026');
  assert.equal(meta.bannerTitle, 'Synthetic list');
  assert.equal(meta.hiddenKnown, true);
  assert.equal(meta.hiddenTab, false);

  const second = S.extractRows(tables[1], {});
  assert.equal(second.meta.lastCol, 'D');
  assert.equal(second.meta.hiddenTab, true);
  assert.deepEqual(second.rows.map(r => [r.row, r.title, r.lastCol]), [[2, 'Epsilon', 'D']]);

  assert.deepEqual(S.tablesFromScript({ format: 'censorsearch-v1', error: 'Sheet not found' }),
    { tables: [], errors: [{ tab: null, message: 'Sheet not found', kind: 'script' }], sheetId: null });
  for (const bad of [null, 'text', [], { foo: 1 }, { format: 'other-v2', tabs: [] }]) {
    const out = S.tablesFromScript(bad);
    assert.equal(out.tables.length, 0);
    assert.equal(out.errors[0].kind, 'format');
  }
});

// ------------------------------------------------------------------------------------------------
// load() with a mocked fetch
const NOW = new Date('2026-09-29T14:05:00Z');
const disp = name => "attachment; filename=\"x.csv\"; filename*=UTF-8''My%20Doc%20-%20" + encodeURIComponent(name) + '.csv';
const csvResponse = (body, name) => new Response(body, { status: 200, headers: { 'content-type': 'text/csv', ...(name ? { 'content-disposition': disp(name) } : {}) } });
const OTHER = csv(['Other title,,,,', 'Title,Author,ISBN,Banned By,Type', 'Omega Unit 4,,9790000000001,Ministry,Activity Book']);

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const gid = (String(url).match(/[?&]gid=([^&#]*)/) || [])[1];
    const handler = routes[gid] || routes['*'];
    if (!handler) throw new TypeError('Failed to fetch');
    return handler(url, opts);
  };
  fn.calls = calls;
  return fn;
}

test('load (CSV): success across tabs, ids, names, fetch options', async () => {
  const fetch = mockFetch({ 0: () => csvResponse(SYN, 'Main List'), 123: () => csvResponse(OTHER, 'Ignored name') });
  const res = await S.load({ kind: 'csv', sheetId: SID, tabs: [{ gid: '0', name: null }, { gid: '123', name: 'Other' }] },
    { fetch, now: NOW });
  assert.deepEqual(res.errors, []);
  assert.equal(res.source, 'csv');
  assert.equal(res.sheetId, SID);
  assert.equal(res.fetchedAt.getTime(), NOW.getTime());
  assert.deepEqual(res.tabs.map(t => t.tab), ['Main List', 'Other']);
  assert.deepEqual(res.rows.map(r => r.id), res.rows.map((_, i) => i));
  assert.equal(res.rows.length, 8);
  const last = res.rows[7];
  assert.deepEqual([last.tab, last.gid, last.row, last.title, last.lastCol], ['Other', '123', 3, 'Omega Unit 4', 'E']);
  assert.deepEqual(res.issues.map(i => [i.tab, i.row, i.kind]), [['Main List', 8, 'pasteResidue'], ['Main List', 10, 'isbnScientific']]);
  assert.deepEqual(fetch.calls.map(c => c.url).sort(), [S.csvUrl(SID, '0'), S.csvUrl(SID, '123')].sort());
  for (const { opts } of fetch.calls) {
    assert.equal(opts.cache, 'no-store');
    assert.equal(opts.credentials, 'omit');
    assert.equal(opts.redirect, 'follow');
    assert.equal(opts.referrerPolicy, 'no-referrer');
  }
  // no name anywhere -> 'Sheet'; now as a function
  const res2 = await S.load({ kind: 'csv', sheetId: SID, tabs: [{ gid: '0', name: null }] },
    { fetch: mockFetch({ 0: () => csvResponse(SYN) }), now: () => NOW });
  assert.equal(res2.tabs[0].tab, 'Sheet');
  assert.equal(res2.fetchedAt.getTime(), NOW.getTime());
});

test('load (CSV): partial result when one tab fails', async () => {
  const fetch = mockFetch({ 0: () => csvResponse(SYN, 'Main'), 123: () => new Response('oops', { status: 500 }) });
  const res = await S.load({ kind: 'csv', sheetId: SID, tabs: [{ gid: '0', name: null }, { gid: '123', name: 'Other' }] }, { fetch, now: NOW });
  assert.equal(res.rows.length, 7);
  assert.deepEqual(res.tabs.map(t => t.tab), ['Main']);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].tab, 'Other');
  assert.equal(res.errors[0].kind, 'http');
  assert.match(res.errors[0].message, /HTTP 500/);
});

test('load (CSV): network error, HTML login page, HTTP 404, no header, timeout', async () => {
  const src = { kind: 'csv', sheetId: SID, tabs: [{ gid: '0', name: 'Sheet1' }] };
  let res = await S.load(src, { fetch: async () => { throw new TypeError('Failed to fetch'); }, now: NOW });
  assert.deepEqual(res.errors, [{ tab: 'Sheet1', kind: 'network', message: "Can't read this sheet: it may not be shared by link, or a network filter may block Google" }]);
  assert.equal(res.rows.length, 0);
  assert.deepEqual(res.tabs, []);

  const login = '<!doctype html><html><head><title>Sign in</title></head><body>Sign in to continue</body></html>';
  res = await S.load(src, { fetch: async () => new Response(login, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) });
  assert.deepEqual(res.errors, [{ tab: 'Sheet1', kind: 'format', message: 'Got a web page instead of the list: the sheet may not be shared by link.' }]);
  res = await S.load(src, { fetch: async () => new Response('\n' + login, { status: 200 }) });
  assert.equal(res.errors[0].kind, 'format', 'HTML body without a content type');
  res = await S.load(src, { fetch: async () => new Response('<b>Draft</b> list,,\nTitle,Author\nFoo,Bar', { status: 200, headers: { 'content-type': 'text/csv' } }) });
  assert.deepEqual(res.errors, [], 'a CSV whose first cell starts with "<" is still CSV');
  assert.equal(res.rows[0].title, 'Foo');

  res = await S.load(src, { fetch: async () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } }) });
  assert.equal(res.errors[0].kind, 'http');
  assert.match(res.errors[0].message, /HTTP 404/);

  res = await S.load(src, { fetch: async () => csvResponse(csv(['Author,ISBN', 'x,1'])) });
  assert.deepEqual(res.errors, [{ tab: 'Sheet1', kind: 'format', message: S.messages.noHeader }]);

  const hang = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  res = await S.load(src, { fetch: hang, timeoutMs: 20 });
  assert.equal(res.errors[0].kind, 'network');
  assert.equal(res.errors[0].message, S.messages.timeout);

  res = await S.load({ kind: 'csv', sheetId: 'bad id!', tabs: [] }, { fetch: async () => { throw new Error('should not fetch'); } });
  assert.equal(res.errors[0].kind, 'format');
});

test('load (CSV): a link without a gid reads the first tab, and uses gid 0 only when Google names the same tab', async () => {
  const first = /\/export\?format=csv$/;
  const route = (firstName, gid0) => {
    const fn = async url => {
      fn.urls.push(url);
      if (first.test(url)) return csvResponse(SYN, firstName);
      return gid0 ? gid0() : new Response('', { status: 400 });
    };
    fn.urls = [];
    return fn;
  };
  // gid 0 is the first tab
  let fetch = route('Main', () => csvResponse(SYN, 'Main'));
  let res = await S.load({ kind: 'csv', sheetId: SID, tabs: [{ gid: null, name: null }] }, { fetch });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.tabs.map(t => [t.tab, t.gid]), [['Main', '0']]);
  assert.equal(res.rows[0].gid, '0');
  assert.ok(fetch.urls.includes(S.csvUrl(SID, null)) && fetch.urls.includes(S.csvUrl(SID, '0')));

  // gid 0 no longer exists (400): the first tab still loads; its id stays unknown
  fetch = route('Main');
  res = await S.load({ kind: 'csv', sheetId: SID, tabs: [] }, { fetch });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.tabs.map(t => [t.tab, t.gid]), [['Main', '']]);
  assert.equal(S.rowUrl(res.rows[0].sheetId, res.rows[0].gid, res.rows[0].row), 'https://docs.google.com/spreadsheets/d/' + SID + '/edit');

  // gid 0 is another tab, or the probe fails: the first tab is read, id unknown
  fetch = route('Main', () => csvResponse(OTHER, 'Archive'));
  res = await S.load({ kind: 'csv', sheetId: SID, tabs: [{ gid: null, name: null }] }, { fetch });
  assert.deepEqual(res.tabs.map(t => [t.tab, t.gid]), [['Main', '']]);
  assert.equal(res.rows.length, 7);
  fetch = route('Main', () => { throw new TypeError('Failed to fetch'); });
  res = await S.load({ kind: 'csv', sheetId: SID, tabs: [{ gid: null, name: null }] }, { fetch });
  assert.deepEqual(res.tabs.map(t => [t.tab, t.gid]), [['Main', '']]);

  // the first tab itself fails
  res = await S.load({ kind: 'csv', sheetId: SID, tabs: [{ gid: null, name: null }] }, { fetch: async () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual(res.errors.map(e => [e.tab, e.kind]), [['the first tab', 'network']]);
});

test('load (CSV): gid 0 is the first tab only when the whole export file name matches, not just the part after " - " (WEB2-4)', async () => {
  const first = /\/export\?format=csv$/;
  const named = (body, file) => new Response(body, { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file) + '.csv' } });
  // "Ministry - 2024" is the first tab; gid 0 is another tab, "School - 2024": both end in "2024"
  let fetch = async url => (first.test(url) ? named(SYN, 'Banned List - Ministry - 2024') : named(OTHER, 'Banned List - School - 2024'));
  let res = await S.load({ kind: 'csv', sheetId: SID, tabs: [{ gid: null, name: null }] }, { fetch });
  assert.deepEqual(res.tabs.map(t => t.gid), ['']);
  assert.equal(res.rows.length, 7, 'the first tab is the one read');
  assert.equal(S.rowUrl(res.rows[0].sheetId, res.rows[0].gid, res.rows[0].row), 'https://docs.google.com/spreadsheets/d/' + SID + '/edit');
  // the same whole name is the same tab
  fetch = async () => named(SYN, 'Banned List - Ministry - 2024');
  res = await S.load({ kind: 'csv', sheetId: SID, tabs: [{ gid: null, name: null }] }, { fetch });
  assert.deepEqual(res.tabs.map(t => t.gid), ['0']);
});

test('load (script): success, configured names, {error}, bad URL, HTML page', async () => {
  const json = scriptJson();
  let seen = null;
  const fetch = async (url, opts) => {
    seen = { url, opts };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  };
  let res = await S.load({ kind: 'script', url: SCRIPT_URL, tabs: [{ gid: '0', name: 'Configured' }, { gid: '123', name: null }] },
    { fetch, now: NOW });
  assert.equal(seen.url, SCRIPT_URL + '?gid=0,123');
  assert.equal(seen.opts.credentials, 'omit');
  assert.equal(res.source, 'script');
  assert.equal(res.sheetId, SID);
  assert.equal(res.fetchedAt.getTime(), NOW.getTime());
  assert.deepEqual(res.tabs.map(t => t.tab), ['Configured', 'Second']);
  assert.deepEqual(res.rows.map(r => [r.id, r.tab, r.row]), [[0, 'Configured', 4], [1, 'Configured', 6], [2, 'Configured', 7], [3, 'Configured', 8], [4, 'Second', 2]]);
  assert.equal(res.rows[1].memoUrl, 'https://drive.google.com/file/d/abc/view');
  assert.equal(res.rows[1].hidden, true);
  assert.deepEqual(res.errors, [{ tab: 'Archive', message: 'This tab is not in the allow-list.', kind: 'script' }]);

  // all tabs (no gid param) keep script order and names
  res = await S.load({ kind: 'script', url: SCRIPT_URL, tabs: null }, { fetch, now: NOW });
  assert.equal(seen.url, SCRIPT_URL);
  assert.deepEqual(res.tabs.map(t => t.tab), ['Main', 'Second']);

  // a requested tab the script did not return
  res = await S.load({ kind: 'script', url: SCRIPT_URL, tabs: [{ gid: '999', name: 'Ghost' }] }, { fetch });
  assert.deepEqual(res.errors.map(e => [e.tab, e.kind]), [['Archive', 'script'], ['Ghost', 'script']]);
  assert.equal(res.rows.length, 0);

  res = await S.load({ kind: 'script', url: SCRIPT_URL, tabs: null },
    { fetch: async () => new Response(JSON.stringify({ format: 'censorsearch-v1', error: 'The sheet could not be opened.' }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.deepEqual(res.errors, [{ tab: null, message: 'The sheet could not be opened.', kind: 'script' }]);
  assert.equal(res.rows.length, 0);

  res = await S.load({ kind: 'script', url: 'https://evil.example/macros/s/x/exec', tabs: null }, { fetch: async () => { throw new Error('should not fetch'); } });
  assert.equal(res.errors[0].kind, 'script');

  res = await S.load({ kind: 'script', url: SCRIPT_URL, tabs: null },
    { fetch: async () => new Response('<!DOCTYPE html><html><body>Sign in</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  assert.equal(res.errors[0].kind, 'format');

  res = await S.load({ kind: 'script', url: SCRIPT_URL, tabs: null }, { fetch: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(res.errors[0].kind, 'network');

  res = await S.load({ kind: 'script', url: SCRIPT_URL, tabs: null }, { fetch: async () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal(res.errors[0].kind, 'format');
});

// ------------------------------------------------------------------------------------------------
// Parity with the sample: the live CSV exports must yield the same rows as the xlsx sample.
const DATA = path.join(__dirname, 'data');
const LIVE = [['Sheet1', 'live-sheet1.csv', '0'], ['Other Materials', 'live-other.csv', '1111920478']];
const haveLive = LIVE.every(([, f]) => fs.existsSync(path.join(DATA, f)));
const parityReady = haveLive && hasSample();

// ------------------------------------------------------------------------------------------------
// Signed in: the Google Sheets API with the visitor's own token

const G = require('./helpers/google.js');
const API_TABS = [
  {
    title: 'Main List', gid: '0',
    rows: [
      ['Synthetic Banned List 2004-2026', '', '', '', '', '', '', 'Notes beside the list'],
      ['updated as of 1 January 2026'],
      ['Title', 'Author', 'ISBN', 'Banned By', 'Type', 'Year of Banning', 'Memo', 'Status'],
      ['Alpha Jokes', 'Pat Writer', '', 'RS', 'Book', '2010-2011', { text: 'Memo 4', link: 'https://drive.google.com/file/d/memo4/view' }, 'Active'],
      ['Beta Stories', 'Sam Press', { text: '9.79889E+12', number: 9798891234567 }, 'KES', 'Book', '2006-2007', { text: 'see memo', runLink: 'https://example.com/m5' }],
      [{ text: 'Gamma Science', formula: '=HYPERLINK("https://example.com/g", "Gamma Science")' }, 'Lee Author', '', 'Ministry', 'Book', '2009-2010', { text: 'bad', link: 'javascript:alert(1)' }],
      ['Delta Unit 1', 'Kim Doe', '', 'UAS', 'Kit', '2020-2021'],
      ['Delta Unit 2', '', '', '', 'Kit', '2020-2021'],
      [],
      ["Zeta's Tale", 'Ann Other', '978-0-00-000000-2', 'Ministry', 'Book', '2023-2024'],
    ],
    hiddenRows: [5],
    merges: [[7, 2, 1], [7, 2, 3], [1, 2, 0]],   // Author and Banned By merged down over rows 7–8; a banner merge above the header
  },
  { title: "Teacher's Other", gid: '1111920478', rows: [['Title', 'Author'], ['Other Thing', 'Some Author']] },
  { title: 'Archive', gid: '42', hidden: true, rows: [['Title'], ['Old Thing']] },
];

test('load (signed in): reads the tabs through the Sheets API with the token, as the other paths read them', async () => {
  const api = G.sheetsApi(SID, API_TABS);
  const fetch = async (url, init) => api(url, init);
  const res = await S.load({ kind: 'api', sheetId: SID, tabs: [{ gid: '0', name: 'Sheet1' }, { gid: '1111920478', name: null }] },
    { fetch, accessToken: G.TOKEN, now: NOW });
  assert.equal(res.source, 'api');
  assert.deepEqual(res.errors, []);
  assert.equal(res.sheetId, SID);
  assert.deepEqual(res.tabs.map(t => [t.tab, t.gid, t.sheetTabName, t.headerRow, t.hiddenKnown]),
    [['Sheet1', '0', 'Main List', 3, true], ["Teacher's Other", '1111920478', "Teacher's Other", 1, true]]);
  assert.equal(res.tabs[0].updatedAsOf, 'updated as of 1 January 2026');
  assert.equal(res.tabs[0].bannerTitle, 'Synthetic Banned List 2004-2026');
  assert.equal(res.tabs[0].lastCol, 'H', 'the Status header is part of the table');

  // Two calls: the tabs' titles, then their cells by title. The token is only ever in the Authorization header.
  assert.equal(api.calls.length, 2);
  for (const c of api.calls) {
    assert.equal(c.init.headers.Authorization, 'Bearer ' + G.TOKEN);
    assert.ok(!c.url.includes(G.TOKEN), 'no token in the address');
    assert.equal(c.init.credentials, 'omit');
    assert.equal(c.init.cache, 'no-store');
  }
  const grid = new URL(api.calls[1].url);
  assert.deepEqual(grid.searchParams.getAll('ranges'), ["'Main List'", "'Teacher''s Other'"]);
  assert.match(grid.searchParams.get('fields'), /hiddenByFilter/);

  const by = Object.fromEntries(res.rows.map(r => [r.title, r]));
  assert.deepEqual(res.rows.map(r => [r.tab, r.row]), [['Sheet1', 4], ['Sheet1', 5], ['Sheet1', 6], ['Sheet1', 7], ['Sheet1', 8], ['Sheet1', 10], ["Teacher's Other", 2]]);
  assert.equal(by['Alpha Jokes'].memoUrl, 'https://drive.google.com/file/d/memo4/view');
  assert.deepEqual(by['Alpha Jokes'].extra, [{ header: 'Status', value: 'Active' }]);
  assert.equal(by['Alpha Jokes'].hidden, false);
  assert.equal(by['Beta Stories'].hidden, true, 'row 5 is hidden');
  assert.equal(by['Beta Stories'].isbn, '9.79889E+12');
  assert.equal(by['Beta Stories'].isbnRaw, '9798891234567', 'all 13 digits from the value behind the display');
  assert.equal(by['Beta Stories'].memoUrl, 'https://example.com/m5', 'a link on part of the text');
  assert.equal(by['Gamma Science'].titleUrl, 'https://example.com/g', 'from =HYPERLINK');
  assert.equal(by['Gamma Science'].memoUrl, null, 'only https links');
  assert.equal(by['Delta Unit 2'].author, 'Kim Doe', 'a merged cell is copied down');
  assert.equal(by['Delta Unit 2'].status.level, 'uas');
  assert.equal(by["Zeta's Tale"].isbnRaw, '9780000000002');
  assert.equal(res.issues.filter(i => i.kind === 'isbnScientific').length, 1);
  assert.equal(by['Other Thing'].tab, "Teacher's Other", 'no configured name: the sheet names the tab');
});

test('load (signed in): no tab id reads the first tab that is not hidden; an unknown tab id is a tab error', async () => {
  const tabs = [Object.assign({}, API_TABS[2], { gid: '0' }), API_TABS[1]];   // the first tab is hidden
  const api = G.sheetsApi(SID, tabs);
  let res = await S.load({ kind: 'api', sheetId: SID, tabs: [{ gid: null, name: null }] }, { fetch: async (u, i) => api(u, i), accessToken: G.TOKEN });
  assert.deepEqual(res.tabs.map(t => [t.tab, t.gid]), [["Teacher's Other", '1111920478']]);
  res = await S.load({ kind: 'api', sheetId: SID, tabs: [{ gid: '1111920478', name: 'Other' }, { gid: '999', name: 'Ghost' }] }, { fetch: async (u, i) => api(u, i), accessToken: G.TOKEN });
  assert.deepEqual(res.tabs.map(t => t.tab), ['Other']);
  assert.deepEqual(res.errors, [{ tab: 'Ghost', message: S.messages.apiNoTab, kind: 'format' }]);
});

test('load (signed in): no sign-in, a sign-in that ran out, no access, the API off, and other failures each say what to do', async () => {
  const fetchFrom = handler => async (u, i) => handler(u, i);
  const src = { kind: 'api', sheetId: SID, tabs: [{ gid: '0', name: 'Sheet1' }] };
  const one = async (opts) => {
    const res = await S.load(src, opts);
    assert.equal(res.rows.length, 0);
    assert.equal(res.errors.length, 1);
    return res.errors[0];
  };
  let calls = 0;
  assert.deepEqual(await one({ fetch: async () => { calls++; }, accessToken: '' }), { tab: null, message: S.messages.apiSignIn, kind: 'auth' });
  assert.equal(calls, 0, 'nothing is fetched without a token');
  assert.deepEqual(await one({ fetch: fetchFrom(G.sheetsApi(SID, API_TABS)), accessToken: 'ya29.expired' }),
    { tab: null, message: S.messages.apiAccess, kind: 'access' }, 'the account can view nothing');
  const answering = r => fetchFrom(G.sheetsApi(SID, API_TABS, { answer: () => r() }));
  assert.equal((await one({ fetch: answering(() => G.apiError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.')), accessToken: G.TOKEN })).kind, 'auth');
  const scope = await one({ fetch: answering(() => G.apiError(403, 'PERMISSION_DENIED', 'Request had insufficient authentication scopes.', [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }])), accessToken: G.TOKEN });
  assert.deepEqual([scope.kind, scope.message], ['auth', S.messages.apiScope]);
  const off = await one({ fetch: answering(() => G.apiError(403, 'PERMISSION_DENIED', 'Google Sheets API has not been used in project 123 before or it is disabled.', [{ reason: 'SERVICE_DISABLED' }])), accessToken: G.TOKEN });
  assert.deepEqual([off.kind, off.message], ['setup', S.messages.apiDisabled]);
  assert.ok(!off.message.includes('123'), "Google's own words (and project number) aren't shown");
  assert.deepEqual(await one({ fetch: fetchFrom(G.sheetsApi('1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-wxyz', API_TABS)), accessToken: G.TOKEN }),
    { tab: null, message: S.messages.apiNotFound, kind: 'http' });
  assert.match((await one({ fetch: answering(() => G.apiError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded')), accessToken: G.TOKEN })).message, /too many requests/);
  assert.match((await one({ fetch: answering(() => G.apiError(503, 'UNAVAILABLE', 'x')), accessToken: G.TOKEN })).message, /try again in a moment/);
  assert.deepEqual(await one({ fetch: async () => { throw new TypeError('Failed to fetch'); }, accessToken: G.TOKEN }),
    { tab: null, message: S.messages.apiNetwork, kind: 'network' });
  assert.equal((await one({ fetch: answering(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })), accessToken: G.TOKEN })).kind, 'format');
  // The grid call failing after the tabs call still names the problem.
  const second = await one({ fetch: fetchFrom(G.sheetsApi(SID, API_TABS, { answer: (u, n) => (n === 2 ? G.apiError(403, 'PERMISSION_DENIED', 'The caller does not have permission') : null) })), accessToken: G.TOKEN });
  assert.equal(second.kind, 'access');
});

test('tableFromGrid: merges above the header are left alone; rows without metadata are "can\'t tell"', () => {
  const sheet = G.gridSheet({ title: 'T', gid: '0', rows: [['Banner'], [], ['Title', 'Author'], ['A', 'B'], ['C', '']], merges: [[1, 3, 0], [4, 2, 1]] });
  const t = S.tableFromGrid(sheet, { tab: 'T', gid: '0', sheetId: SID });
  assert.deepEqual(t.records.map(r => r.cells), [['Banner'], [], ['Title', 'Author'], ['A', 'B'], ['C', 'B']]);
  delete sheet.data[0].rowMetadata;
  const t2 = S.tableFromGrid(sheet, { tab: 'T', gid: '0', sheetId: SID });
  assert.equal(t2.hiddenKnown, false);
  assert.ok(t2.records.every(r => r.hidden === null));
  assert.deepEqual(S.tableFromGrid(null, { tab: 'T' }).records, []);
});

test('parity: live CSV exports match the xlsx sample rows', { skip: parityReady ? false : 'sample .xlsx or test/data/live-*.csv absent' }, t => {
  const sample = loadSampleRows();
  const strict = ['tab', 'row', 'title', 'author', 'isbn', 'bannedBy', 'type', 'memo'];
  const diffs = [];
  for (const [tab, file, gid] of LIVE) {
    const text = fs.readFileSync(path.join(DATA, file), 'utf8');
    const { rows } = S.extractRows(S.tableFromCsv(S.parseCsv(text), { tab, gid, sheetId: SID }), {});
    const expected = sample.filter(r => r.tab === tab);
    assert.deepEqual(rows.map(r => r.row), expected.map(r => r.row), tab + ' row numbers');
    rows.forEach((r, i) => {
      const e = expected[i];
      for (const f of strict) assert.equal(r[f], e[f], `${tab} r${r.row} ${f}`);
      if (r.year !== e.year) diffs.push(`${tab} r${r.row} year: live ${JSON.stringify(r.year)} vs xlsx ${JSON.stringify(e.year)}`);
    });
  }
  // Known edits in the live copy (e.g. Year of Banning) are reported, not failed.
  t.diagnostic(diffs.length ? 'year differences: ' + diffs.join('; ') : 'no year differences');
});
