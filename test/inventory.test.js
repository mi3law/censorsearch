// Tests for the inventory check: src/inventory.js (reading a classroom tab, checking items, the report, CSV and the
// results tab) and inventory.html driven through the fake browser against a mocked Google (sign-in, the Sheets API
// reads and the optional write-back). Synthetic data only; tokens are made-up strings.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const S = require('../src/sheet.js');
const I = require('../src/inventory.js');
const { toRow } = require('./helpers/sample.js');
const L = require('./fixtures/realistic-list.js');
const G = require('./helpers/google.js');
const { makeBrowser } = require('./helpers/fake-dom.js');

const LIST = L.scaleRows().map((r, i) => toRow(Object.assign({}, r, { status: S.parseBannedBy(r.bannedBy, { schoolCode: 'UAS' }) }), i));
const IX = E.buildIndex(LIST, { aliases: require('../aliases.json') });
const check = (title, author, isbn) => I.checkItem(IX, { row: 4, title, author: author || '', isbn: isbn || '' });
const titlesOf = r => r.hits.map(h => h.row.title);

// The layout of a real classroom tab: room and "checked by" lines above a header row on row 3.
const MAKER_SPACE = [
  ['Ms. Bidour  : Rm. G 44 Maker Space'],
  ['Checked and updated by / Date:'],
  ['Book Title', 'Author/Creator'],
  ['...Not Afraid to Dream', 'Balmages'],
  ['La belle excentrique-- FLEX BAND', 'Satie/Kurokawa'],
  ['Slippery Slide Rag', 'Huckeby'],
  ['Themes from Thus Spak Zarathustra', 'Strauss/Thomas'],
  ['Hightlights from the Star Wars Saga', 'Williams/Cook'],
  ['Emblazon', "O'Loughlin"],
  ['First Sounds for Concert Band', 'Bullock'],
  ['March from Aida (photocopies)', 'Verdi/Lauder'],
  ['Little Suite', 'Kushida'],
  ['Swahili Folk Hymn', 'Mixon'],
  ['Mission:Impossible Theme', 'Schifrin/Lavender'],
  ['Dark Adventure', 'Ford'],
];

// ------------------------------------------------------------------------------------------------
// Reading a tab

test('parseTab reads a classroom tab: room, the blank "checked by" line, the header on row 3 and Author/Creator', () => {
  const p = I.parseTab(MAKER_SPACE.concat([[], ['', 'Someone'], ['Holes', 'Louis Sachar']]), { tab: 'G44', gid: '7', sheetId: 'X' });
  assert.equal(p.room, 'Ms. Bidour  : Rm. G 44 Maker Space');
  assert.deepEqual(p.checked, { label: 'Checked and updated by / Date:', value: '' });
  assert.equal(p.headerRow, 3);
  assert.equal(p.items.length, 13);
  assert.deepEqual(p.items[0], { row: 4, title: '...Not Afraid to Dream', author: 'Balmages', isbn: '' });
  assert.deepEqual(p.items[12], { row: 18, title: 'Holes', author: 'Louis Sachar', isbn: '' });
  assert.equal(p.noTitle, 1, 'a row with only an author is counted, not checked');
  assert.deepEqual(p.notes, []);
});

test('parseTab: the "checked by" value beside the label or after its colon; no Title column is an error', () => {
  const beside = I.parseTab([['Room 12'], ['Checked and updated by / Date:', 'R. Haddad, 1 Oct 2026'], ['Title', 'Author'], ['Holes', 'Sachar']]);
  assert.deepEqual(beside.checked, { label: 'Checked and updated by / Date:', value: 'R. Haddad, 1 Oct 2026' });
  const after = I.parseTab([['Checked and updated by / Date: Ali 2026-09-30'], ['Titles'], ['Holes']]);
  assert.deepEqual(after.checked, { label: 'Checked and updated by / Date:', value: 'Ali 2026-09-30' });
  assert.equal(after.room, '');
  assert.deepEqual(after.notes, ['No Author column found, so titles were checked on their own.']);
  assert.match(I.parseTab([['Notes'], ['Bring books back by June']]).error, /No Title column/);
  assert.match(I.parseTab(undefined).error, /No Title column/);
});

// ------------------------------------------------------------------------------------------------
// Checking items

test('band titles from the real layout match nothing on the list', () => {
  const p = I.parseTab(MAKER_SPACE);
  for (const it of p.items) assert.equal(I.checkItem(IX, it).verdict, 'clear', it.title);
});

test('likely banned: title and author, the same title without an author, a whole-series listing, a spelling slip', () => {
  assert.equal(check('Holes', 'Sachar').verdict, 'likely');
  assert.deepEqual(check('The Giver', 'Lois Lowry').hits[0].why, ['title and author match']);
  const matilda = check('Matilda');
  assert.equal(matilda.verdict, 'likely');
  assert.deepEqual(matilda.hits[0].why, ['same title']);
  const series = check('Captain Underpants');
  assert.equal(series.verdict, 'likely');
  assert.equal(series.hits[0].row.title, 'Captain Underpants - all titles');
  assert.equal(series.hits.length, I.MAX_HITS);
  assert.ok(series.more > 0);
  const hp = check('Harry Potter and the Chamber of Secrets', 'Rowling');
  assert.equal(hp.verdict, 'likely');
  assert.ok(hp.hits[0].why.includes('similar spelling: Poter'));
  assert.equal(check('March from Aida (photocopies)', 'Verdi').verdict, 'clear', 'bracketed notes are not searched');
});

test('worth a look: similar titles; a surname alone never matches', () => {
  const wonder = check('Wonder', 'Palacio');
  assert.equal(wonder.verdict, 'look');
  assert.ok(wonder.hits.every(h => h.strength === 'look'));
  assert.equal(check('Romeo and Juliet', 'Shakespeare').verdict, 'look');
  const dog = check('Dog Man', 'Pilkey');
  assert.equal(dog.verdict, 'likely');
  assert.ok(!titlesOf(dog).some(t => /Captain Underpants/.test(t)), 'Dav Pilkey alone is not a match');
  assert.equal(check('Dark Adventure', 'Ford').verdict, 'clear', 'a near title by an author the listing lacks is dropped');
  assert.equal(check('The').verdict, 'skipped');
  assert.equal(check('').verdict, 'skipped');
});

test('compact and expand carry hits by row id', () => {
  const r = check('Holes', 'Sachar');
  const c = I.compact(r);
  assert.equal(typeof c.hits[0].id, 'number');
  assert.equal(JSON.stringify(c).includes('Sachar'), false);
  assert.deepEqual(I.expand(c, LIST).hits.map(h => h.row), r.hits.map(h => h.row));
});

// ------------------------------------------------------------------------------------------------
// Report, CSV and the results tab

function sampleReport() {
  const room = I.parseTab([['Rm 1'], ['Checked and updated by / Date:', 'Ali'], ['Title', 'Author'], ['Holes', 'Sachar'], ['Wonder', 'Palacio'], ['Emblazon', 'Ford'], ['=HYPERLINK("x")', '']]);
  const tabs = [
    { gid: '1', title: 'Room 1', parsed: room, results: room.items.map(it => I.checkItem(IX, it)) },
    { gid: '2', title: 'Notes', parsed: { error: 'No Title column.' } },
  ];
  return I.report(tabs);
}

test('report totals each tab and keeps only the matches', () => {
  const rep = sampleReport();
  assert.deepEqual(rep.totals, { tabs: 2, read: 1, items: 4, likely: 1, look: 1, tabsWithLikely: 1, tabsWithLook: 1, failed: 1 });
  const [t, bad] = rep.tabs;
  assert.equal(t.room, 'Rm 1');
  assert.equal(t.checked.value, 'Ali');
  assert.deepEqual(t.findings.map(f => [f.item.title, f.verdict]), [['Holes', 'likely'], ['Wonder', 'look']]);
  assert.equal(bad.error, 'No Title column.');
});

test('CSV: a header, one line per listing, formulas defused, quotes doubled, BOM for Excel', () => {
  const rep = sampleReport();
  const grid = I.resultGrid(rep, { inventory: (t, row) => 'https://inv/' + t.gid + '/' + row, list: r => 'https://list/' + r.row });
  assert.equal(grid[0][0], 'Tab');
  assert.ok(grid.slice(1).every(r => r.length === grid[0].length));
  assert.deepEqual(grid[1].slice(0, 7), ['Room 1', 'Rm 1', '4', 'Holes', 'Sachar', 'Likely banned', 'Holes']);
  assert.equal(grid[1][11], 'https://inv/1/4');
  const csv = I.toCsv([['=SUM(A1)', 'say "hi", ok', '-1', 'plain'], ['a\nb', '@x', '', '+1']]);
  assert.equal(csv, '﻿\'=SUM(A1),"say ""hi"", ok",\'-1,plain\r\n"a\nb",\'@x,,\'+1\r\n');
  const sum = I.summaryGrid(rep);
  assert.deepEqual(sum[1], ['Room 1', 'Rm 1', '4', '1', '1', '0', 'Ali', '']);
  assert.deepEqual(sum[2], ['Notes', '', '', '', '', '', '', 'No Title column.']);
});

test('the results tab: a heading, the results, then the summary, every row as wide as the header', () => {
  const rows = I.sheetGrid(sampleReport(), {}, '6 Oct 2026, 10:00');
  assert.match(rows[0][0], /^CensorSearch results, checked 6 Oct 2026, 10:00\./);
  assert.equal(rows[2][0], 'Tab');
  assert.ok(rows.every(r => r.length === rows[2].length));
  assert.ok(rows.some(r => r[0] === 'Summary'));
  const empty = I.sheetGrid(I.report([]), {}, 'now');
  assert.equal(empty[3][0], 'Nothing on the banned list matched these tabs.');
});

test('jobs split items by tab and size', () => {
  const tabs = [{ parsed: { items: [1, 2, 3, 4, 5] } }, { parsed: { error: 'x' } }, { parsed: { items: [6] } }];
  assert.deepEqual(I.jobs(tabs, 2).map(j => [j.tab, j.start, j.items]), [[0, 0, [1, 2]], [0, 2, [3, 4]], [0, 4, [5]], [2, 0, [6]]]);
});

// ------------------------------------------------------------------------------------------------
// The page

const LIST_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';
const INV_ID = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-wxyz';
const WRITE_TOKEN = 'ya29.fake-write-token-not-real';
const CONFIG = 'window.CENSORSEARCH_CONFIG = ' + JSON.stringify({
  sheetUrl: 'https://docs.google.com/spreadsheets/d/' + LIST_ID + '/edit#gid=0', tabs: [{ gid: '0', name: 'Sheet1' }],
  googleClientId: G.CLIENT_ID, schoolCode: 'UAS', aliasesUrl: 'aliases.json',
}) + ';';
const LIST_TAB = { title: 'Sheet1', gid: '0', rows: [['Title', 'Author', 'Banned By'], ['Holes', 'Louis Sachar', 'Ministry'], ['Wonder Woman', '', 'UAS']] };
const INV_TABS = {
  '0': { title: 'Rm G44', rows: MAKER_SPACE.concat([['Holes', 'Sachar']]) },
  '11': { title: 'Rm 12', rows: [['Mr. Haddad : Rm 12'], ['Checked and updated by / Date:', 'Haddad 1 Oct'], ['Title', 'Author'], ['Wonder', 'Palacio'], ['Matilda', 'Dahl']] },
  '22': { title: 'Instructions', rows: [['Fill in one tab per room.']] },
};

async function openInventory(o = {}) {
  const calls = [];
  const resultsTab = { exists: !!o.resultsTab };
  const listApi = G.sheetsApi(LIST_ID, [LIST_TAB]);
  const b = makeBrowser({
    page: 'inventory.html', href: 'https://school.example/censorsearch/inventory.html',
    scripts: { 'config.js': CONFIG },
    fetch: async (url, init) => {
      const u = new URL(url);
      if (u.origin === 'https://school.example') return new Response('{"aliases": []}', { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.hostname !== 'sheets.googleapis.com') return new Response('no', { status: 404 });
      if (u.pathname.includes(LIST_ID)) return listApi(url, init);
      const auth = (init.headers || {}).Authorization;
      calls.push({ method: init.method || 'GET', path: decodeURIComponent(u.pathname), search: u.searchParams, auth, body: init.body ? JSON.parse(init.body) : null });
      if (o.answer) { const r = o.answer(u, init); if (r) return r; }
      if (auth !== 'Bearer ' + G.TOKEN && auth !== 'Bearer ' + WRITE_TOKEN) return G.apiError(401, 'UNAUTHENTICATED', 'no');
      const path = decodeURIComponent(u.pathname);
      if (path.endsWith('/values:batchGet')) {
        const titles = u.searchParams.getAll('ranges').map(r => r.replace(/^'([\s\S]*)'$/, '$1'));
        return G.json(200, { valueRanges: titles.map(t => { const tab = Object.values(INV_TABS).find(x => x.title === t); return tab.rows.length ? { values: tab.rows } : {}; }) });
      }
      if (init.method === 'POST' || init.method === 'PUT') {
        if (auth !== 'Bearer ' + WRITE_TOKEN) return G.apiError(403, 'PERMISSION_DENIED', 'Request had insufficient authentication scopes.');
        if (path.endsWith(':batchUpdate')) {
          const req = JSON.parse(init.body).requests[0];
          if (req.addSheet) { resultsTab.exists = true; return G.json(200, { replies: [{ addSheet: { properties: { sheetId: 99, title: req.addSheet.properties.title } } }] }); }
          return G.json(200, { replies: [{}] });
        }
        return G.json(200, {});
      }
      const sheets = Object.entries(INV_TABS).map(([gid, t]) => ({ properties: Object.assign({ title: t.title }, gid === '0' ? {} : { sheetId: Number(gid) }) }));
      if (resultsTab.exists) sheets.push({ properties: { sheetId: 99, title: 'CensorSearch results' } });
      return G.json(200, { properties: { title: 'Classroom Inventory 2026' }, sheets });
    },
  });
  const gis = G.fakeGis(o.gis || [{ access_token: G.TOKEN, expires_in: 3599, scope: G.SCOPE }, { access_token: WRITE_TOKEN, expires_in: 3599, scope: 'https://www.googleapis.com/auth/spreadsheets' }]);
  b.win.google = gis;
  b.start();
  await b.flush();
  return Object.assign(b, { calls, gis, listApi });
}

async function signInAndFind(b, link) {
  b.click(b.$('inv-signin-button'));
  await b.flush();
  assert.equal(b.$('inv-form').hidden, false);
  assert.match(b.text('inv-list'), /^Banned list: 2 items, read at /);
  b.type(b.$('inv-url'), link || 'https://docs.google.com/spreadsheets/d/' + INV_ID + '/edit?gid=11#gid=11');
  b.submit(b.$('inv-form'));
  await b.flush();
}

test('page: sign in, find the tabs, check them, and read the summary and each tab', async () => {
  const b = await openInventory();
  assert.match(b.text('inv-status'), /^Sign in with Google to check an inventory\./);
  await signInAndFind(b);
  assert.equal(b.$('inv-tabs-box').hidden, false);
  assert.match(b.text('inv-sheet-name'), /“Classroom Inventory 2026”/);
  assert.equal(b.text('inv-count'), 'Tabs (3 of 3 selected)');
  assert.equal(b.text('inv-only'), 'Only “Rm 12”');
  assert.equal(b.$('inv-only').hidden, false);

  b.click(b.$('inv-check'));
  await b.flush();
  await b.advance(10);
  await b.flush();
  assert.equal(b.$('inv-report').hidden, false);
  assert.match(b.text('inv-status'), /^Done: checked 15 titles in 2 tabs\./);
  assert.match(b.text('inv-summary'), /^Checked 15 titles in 2 tabs of “Classroom Inventory 2026”: 1 likely banned \(in 1 tab\), 1 worth a look\. 1 tab couldn't be read\./);
  const rows = b.$('inv-table-body').querySelectorAll('tr').map(tr => tr.textContent);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^Ms\. Bidour {2}: Rm\. G 44 Maker SpaceRm G4413/);
  assert.match(rows[0], /not filled in$/);
  assert.match(rows[1], /Haddad 1 Oct$/);
  assert.match(rows[2], /^Instructions.*Couldn't be read$/);
  assert.match(b.text('inv-problems'), /Instructions: No Title column/);
  const cards = b.$('inv-tabs-results').querySelectorAll('article');
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent, /^HolesSachar.*Likely banned: Must remove \(Ministry\)/);
  assert.ok(cards[0].querySelector('a.row-link').getAttribute('href').startsWith('https://docs.google.com/spreadsheets/d/' + LIST_ID));
  assert.equal(cards[0].querySelector('.where a').getAttribute('href'), S.rowUrl(INV_ID, '0', 16, 'B'));
  assert.match(cards[1].className, /tier-possible/);
  assert.equal(b.$('inv-write-status').hidden, true);
  assert.ok(b.calls.every(c => c.method === 'GET'), 'nothing written without the option');
  assert.equal(b.gis.requests.length, 1);
  assert.ok(!b.everything().includes(G.TOKEN));
});

test('page: "Only" picks the linked tab; a bad link says so', async () => {
  const b = await openInventory();
  await signInAndFind(b, 'not a link');
  assert.match(b.text('inv-url-error'), /isn't a Google Sheets link/);
  assert.equal(b.$('inv-tabs-box').hidden, true);
  b.type(b.$('inv-url'), 'https://docs.google.com/spreadsheets/d/' + INV_ID + '/edit#gid=11');
  b.submit(b.$('inv-form'));
  await b.flush();
  b.click(b.$('inv-only'));
  assert.equal(b.text('inv-count'), 'Tabs (1 of 3 selected)');
  assert.equal(b.text('inv-check'), 'Check the selected tab');
  b.click(b.$('inv-check'));
  await b.flush();
  await b.advance(10);
  await b.flush();
  const batch = b.calls.find(c => c.path.endsWith('/values:batchGet'));
  assert.deepEqual(batch.search.getAll('ranges'), ["'Rm 12'"]);
  assert.match(b.text('inv-summary'), /^Checked 2 titles in 1 tab/);
});

test('page: writing back asks for edit access from the click, then adds the results tab, or replaces it', async () => {
  const b = await openInventory();
  await signInAndFind(b);
  b.$('inv-write').checked = true;
  b.click(b.$('inv-check'));
  await b.flush();
  await b.advance(10);
  await b.flush();
  assert.deepEqual(b.gis.requests.map(r => r.scope), [G.SCOPE, 'https://www.googleapis.com/auth/spreadsheets']);
  const writes = b.calls.filter(c => c.method !== 'GET');
  assert.deepEqual(writes.map(c => c.method + ' ' + c.path.replace(/^.*\/spreadsheets\/[^/:]+/, '')), [
    'POST :batchUpdate', "PUT /values/'CensorSearch results'!A1",
  ]);
  assert.ok(writes.every(c => c.auth === 'Bearer ' + WRITE_TOKEN));
  assert.equal(writes[0].body.requests[0].addSheet.properties.title, 'CensorSearch results');
  const values = writes[1].body.values;
  assert.match(values[0][0], /^CensorSearch results, checked /);
  assert.ok(values.some(r => r[3] === 'Holes' && r[5] === 'Likely banned'));
  assert.equal(writes[1].search.get('valueInputOption'), 'RAW');
  assert.match(b.text('inv-write-status'), /^Written into the “CensorSearch results” tab of the inventory\. Open it/);

  // Again: the tab is there now, so it is resized, cleared and rewritten; the edit sign-in is reused.
  b.calls.length = 0;
  b.click(b.$('inv-find'));
  b.submit(b.$('inv-form'));
  await b.flush();
  assert.match(b.$('inv-tab-list').textContent, /CensorSearch results \(this page's own results; not checked\)/);
  assert.equal(b.text('inv-count'), 'Tabs (3 of 3 selected)');
  b.click(b.$('inv-check'));
  await b.flush();
  await b.advance(10);
  await b.flush();
  assert.equal(b.gis.requests.length, 2);
  assert.deepEqual(b.calls.filter(c => c.method !== 'GET').map(c => c.method + ' ' + c.path.replace(/^.*\/spreadsheets\/[^/:]+/, '')), [
    'POST :batchUpdate', "POST /values/'CensorSearch results':clear", "PUT /values/'CensorSearch results'!A1",
  ]);
  assert.ok(!b.everything().includes(WRITE_TOKEN));
});

test('page: an account that can only view the inventory gets the results on the page and a plain note', async () => {
  const b = await openInventory({ answer: (u, init) => (init.method === 'POST' ? G.apiError(403, 'PERMISSION_DENIED', 'The caller does not have permission') : null) });
  await signInAndFind(b);
  b.$('inv-write').checked = true;
  b.click(b.$('inv-check'));
  await b.flush();
  await b.advance(10);
  await b.flush();
  assert.equal(b.$('inv-report').hidden, false);
  assert.equal(b.text('inv-write-status'), "Your Google account can view the inventory but not edit it, so the results weren't written into it. Download them instead.");
});

test('page: without sign-in set up, it says so and asks for nothing', async () => {
  const b = makeBrowser({ page: 'inventory.html', scripts: { 'config.js': CONFIG.replace(G.CLIENT_ID, '') } });
  b.start();
  await b.flush();
  assert.match(b.text('inv-status'), /isn't set up for this page/);
  assert.equal(b.$('inv-form').hidden, true);
  assert.equal(b.fetchCalls.length, 0);
});
