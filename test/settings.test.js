// Tests for the settings page: src/settings.js (config.js text, validation, diff, base64, the GitHub save) and
// settings.html driven through a fake DOM that parses the real page. Synthetic data only; the GitHub token is a
// made-up string and every GitHub call goes to a mocked fetch.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');
const S = require('../src/settings.js');
const Sheet = require('../src/sheet.js');
const { makeBrowser, ROOT } = require('./helpers/fake-dom.js');

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CONFIG_JS = read('config.js');
const ch = c => String.fromCharCode(c);
const LS = ch(0x2028), PS = ch(0x2029), RLO = ch(0x202e), BOM = ch(0xfeff), ZWSP = ch(0x200b), NBSP = ch(0xa0);
const ARABIC = String.fromCharCode(0x0643, 0x062a, 0x0627, 0x0628);
const EMOJI = String.fromCodePoint(0x1f4da);
const SID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';
const SID2 = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-wxyz';
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/' + SID + '/edit?gid=0#gid=0';
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx_Example-Deployment_0123456789abcdef/exec';
const TOKEN = 'github_pat_FAKE0TEST0TOKEN0not0real0' + 'x'.repeat(24);
const plain = v => JSON.parse(JSON.stringify(v));
function hasLoneSurrogate(t) {
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const d = t.charCodeAt(i + 1); if (d >= 0xdc00 && d <= 0xdfff) { i++; continue; } return true; }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

// Runs config.js text the way the page does (a script assigning window.CENSORSEARCH_CONFIG), with traps that record
// any code a value might have injected.
function readConfigObject(jsText) {
  const calls = [];
  const sandbox = { window: {}, alert: (...a) => calls.push(a), fetch: (...a) => calls.push(a) };
  vm.runInNewContext(jsText, sandbox, { filename: 'config.js' });
  return { cfg: sandbox.window.CENSORSEARCH_CONFIG, calls, sandbox };
}

const repoCfg = () => plain(readConfigObject(CONFIG_JS).cfg);

// ------------------------------------------------------------------------------------------------
// config.js text

test('buildConfigJs reproduces the repository config.js byte for byte', () => {
  const { cfg } = readConfigObject(CONFIG_JS);
  assert.equal(S.buildConfigJs(cfg), CONFIG_JS);
  assert.equal(S.buildConfigJs(repoCfg()), CONFIG_JS);
});

test('buildConfigJs: other tabs, a script and trusted codes round-trip, keeping the comments', () => {
  const cfg = Object.assign(repoCfg(), {
    tabs: [{ gid: '0', name: 'Sheet1' }, { gid: '1111920478', name: 'Other Materials' }],
    scriptUrl: SCRIPT_URL,
    trustedScripts: ['a'.repeat(64), SCRIPT_URL],
    schoolCode: 'KES',
  });
  const text = S.buildConfigJs(cfg);
  assert.deepEqual(plain(readConfigObject(text).cfg), cfg);
  assert.equal(S.buildConfigJs(readConfigObject(text).cfg), text);
  assert.match(text, /\n {2}tabs: \[\{ gid: '0', name: 'Sheet1' \}, \{ gid: '1111920478', name: 'Other Materials' \}\],\n/, 'no v1 comment on other tabs');
  assert.match(text, /\n {2}trustedScripts: \['a{64}', 'https:\/\/script\.google\.com\/macros\/s\/[^']+\/exec'\],\n/);
  // Every comment line of the repository file is still there, in order, the school's code comment naming the new code.
  const comments = CONFIG_JS.split('\n').filter(l => /^\s*\/\//.test(l)).map(l => l.replace('"Banned by UAS"', '"Banned by KES"'));
  assert.deepEqual(text.split('\n').filter(l => /^\s*\/\//.test(l)), comments);
  assert.equal(text.split('\n').length, CONFIG_JS.split('\n').length);
});

test('buildConfigJs: missing settings get the search page defaults; a tab without a name stays without one', () => {
  const text = S.buildConfigJs({ sheetUrl: SHEET_URL, tabs: [{ gid: 7 }] });
  const cfg = plain(readConfigObject(text).cfg);
  assert.deepEqual(cfg, { sheetUrl: SHEET_URL, tabs: [{ gid: '7' }], scriptUrl: '', trustedScripts: [], schoolCode: 'UAS', aliasesUrl: 'aliases.json', repoUrl: '' });
});

test("hostile values round-trip exactly and can't inject code or end the file early", () => {
  const hostile = [
    "'; alert(1); '", "*/ alert(2); /*", '</script><script>alert(3)</script>', '<!-- alert(4) -->', '\\', "back\\slash\\'",
    'line\nbreak; alert(5)', 'cr\ralert(6)', 'ls' + LS + 'alert(7)', 'ps' + PS + 'alert(8)', 'rlo' + RLO + 'x', 'bom' + BOM, 'zw' + ZWSP + 'sp',
    'lone ' + ch(0xd800) + ' surrogate', 'low ' + ch(0xdc00), ARABIC + ' ' + EMOJI + NBSP, '${alert(9)}', '`alert(10)`', '"; alert(11); "', 'tab\there', 'nul' + ch(0) + 'x',
  ];
  hostile.forEach((h, i) => {
    const cfg = {
      sheetUrl: h, tabs: [{ gid: h, name: h }, { gid: '0', name: h + h }], scriptUrl: h, trustedScripts: [h, 'x' + h],
      schoolCode: h, aliasesUrl: h, repoUrl: h,
    };
    cfg['extra' + i] = { value: h, list: [h, 1, true, null] };
    cfg[h] = h;
    const text = S.buildConfigJs(cfg);
    assert.doesNotThrow(() => new vm.Script(text), 'parses: ' + JSON.stringify(h));
    const out = readConfigObject(text);
    assert.deepEqual(out.calls, [], 'no code ran for ' + JSON.stringify(h));
    assert.deepEqual(plain(out.cfg), plain(cfg), 'round trip for ' + JSON.stringify(h));
    assert.deepEqual(Object.keys(out.sandbox).sort(), ['alert', 'fetch', 'window'], 'no new globals');
    // One value per line: nothing breaks a line, and nothing invisible or direction-changing is written raw.
    assert.equal(text.split('\n').length, CONFIG_JS.split('\n').length + 2, JSON.stringify(h));
    for (const bad of ['\r', LS, PS, RLO, BOM, ZWSP, ch(0), '</script', '<!--']) assert.ok(!text.includes(bad), JSON.stringify(bad) + ' in ' + JSON.stringify(h));
    assert.ok(!hasLoneSurrogate(text), 'no lone surrogates written raw: ' + JSON.stringify(h));
  });
  assert.equal(S.jsString("it's"), "'it\\'s'");
  assert.equal(S.jsString('a\\b'), "'a\\\\b'");
  assert.equal(S.jsString('</script>'), "'\\x3C/script>'");
  assert.equal(S.jsString('x' + LS), "'x\\u2028'");
  assert.equal(S.jsString(ARABIC + EMOJI), "'" + ARABIC + EMOJI + "'", 'readable text stays as written');
});

test('settings this page does not edit are kept, before the closing brace, as JSON', () => {
  const cfg = Object.assign(repoCfg(), { analytics: false, 'odd-key': { a: [1, 'x'] } });
  const text = S.buildConfigJs(cfg);
  assert.ok(text.endsWith("  repoUrl: 'https://github.com/mi3law/censorsearch',\n  analytics: false,\n  \"odd-key\": {\"a\":[1,\"x\"]},\n};\n"), text.slice(-160));
  assert.deepEqual(plain(readConfigObject(text).cfg), plain(cfg));
  assert.deepEqual(S.extraKeys(cfg), ['analytics', 'odd-key']);
  // A function or undefined can't be written as JSON and is left out; __proto__ is never written.
  const odd = JSON.parse('{"__proto__": {"polluted": true}}');
  const text2 = S.buildConfigJs(Object.assign(repoCfg(), odd, { fn: () => 1, nothing: undefined }));
  assert.equal(text2, CONFIG_JS);
});

test('buildConfigJs: the comments match the values below them (BRW-5)', () => {
  assert.equal(S.buildConfigJs(repoCfg()), CONFIG_JS, "v1's own tab keeps the v1 comment");
  const two = S.buildConfigJs(Object.assign(repoCfg(), { tabs: [{ gid: '0', name: 'Sheet1' }, { gid: '1111920478', name: 'Other Materials' }] }));
  assert.ok(!two.includes('v1: main tab only'), 'no "add Other Materials" comment once it is added');
  const other = S.buildConfigJs(Object.assign(repoCfg(), { sheetUrl: SHEET_URL }));
  assert.ok(!other.includes('v1: main tab only'), 'nor for another sheet, whose tabs it is not about');
  assert.match(other, /\n {2}tabs: \[\{ gid: '0', name: 'Sheet1' \}\],\n/);
  const kes = S.buildConfigJs(Object.assign(repoCfg(), { schoolCode: 'KES' }));
  assert.match(kes, /\n {2}\/\/ This school's own code in the Banned By column; rows with it show "Banned by KES"\.\n {2}schoolCode: 'KES',\n/);
  assert.ok(!kes.includes('UAS'));
  assert.match(S.buildConfigJs(Object.assign(repoCfg(), { schoolCode: ARABIC })), new RegExp('"Banned by ' + ARABIC + '"\\.\\n'));
  // A code that isn't plain letters and digits never goes into the comment.
  for (const code of ["U'S; alert(1)", 'a\nb', 'x' + LS + 'y', 'x' + RLO, '']) {
    assert.match(S.buildConfigJs(Object.assign(repoCfg(), { schoolCode: code })), /rows with it show "Banned by" and the code\.\n {2}schoolCode: /, JSON.stringify(code));
  }
});

test('buildConfigJs keeps an alias list that is switched off switched off, as the search page reads it (GH6)', () => {
  for (const off of [null, '', false, undefined]) {
    assert.match(S.buildConfigJs(Object.assign(repoCfg(), { aliasesUrl: off })), /\n {2}aliasesUrl: '',\n/, String(off));
  }
  const missing = repoCfg();
  delete missing.aliasesUrl;
  assert.match(S.buildConfigJs(missing), /\n {2}aliasesUrl: 'aliases\.json',\n/, 'a missing setting is the default, aliases.json');
});

// ------------------------------------------------------------------------------------------------
// Validation

function formFrom(cfg, over) {
  const c = cfg || repoCfg();
  return Object.assign({
    mode: c.scriptUrl ? 'script' : 'link', sheetUrl: c.sheetUrl, tabs: (c.tabs || []).map(t => ({ gid: t.gid, name: t.name })),
    scriptUrl: c.scriptUrl, schoolCode: c.schoolCode, trustedScripts: (c.trustedScripts || []).join('\n'),
    aliasesUrl: c.aliasesUrl, repoUrl: c.repoUrl, extra: {}, original: c,
  }, over || {});
}
const fieldsOf = v => v.errors.map(e => e.field);

test('validate: the current settings are valid and give back the same config.js', () => {
  const v = S.validate(formFrom());
  assert.deepEqual(v.errors, []);
  assert.equal(S.buildConfigJs(v.cfg), CONFIG_JS);
});

test('validate: sheet links', () => {
  const good = [
    ['docs.google.com/spreadsheets/d/' + SID + '/edit#gid=5', 'https://docs.google.com/spreadsheets/d/' + SID + '/edit?gid=5#gid=5'],
    ['https://docs.google.com/spreadsheets/u/1/d/' + SID + '/edit?usp=sharing', 'https://docs.google.com/spreadsheets/d/' + SID + '/edit'],
    ['  ' + SID + '  ', 'https://docs.google.com/spreadsheets/d/' + SID + '/edit'],
  ];
  for (const [input, out] of good) {
    const v = S.validate(formFrom(null, { sheetUrl: input }));
    assert.deepEqual(v.errors, [], input);
    assert.equal(v.cfg.sheetUrl, out, input);
  }
  // Typed exactly as it already is in config.js: kept as written there, even when not in the plain form.
  const hand = 'https://docs.google.com/spreadsheets/d/' + SID + '/edit#gid=0';
  assert.equal(S.validate(formFrom(Object.assign(repoCfg(), { sheetUrl: hand }))).cfg.sheetUrl, hand);
  const bad = [
    ['', S.messages.sheetMissing],
    ['https://docs.google.com/spreadsheets/d/e/2PACX-1vSomePublishedId0123456789/pubhtml', S.messages.sheetPublished],
    ['https://drive.google.com/file/d/' + SID + '/view', S.messages.sheetBad],
    ['https://docs.google.com.evil.example/spreadsheets/d/' + SID + '/edit', S.messages.sheetBad],
    ['javascript:alert(1)', S.messages.sheetBad],
    ['not a link', S.messages.sheetBad],
  ];
  for (const [input, msg] of bad) {
    const v = S.validate(formFrom(null, { sheetUrl: input }));
    assert.deepEqual(v.errors, [{ field: 'sheetUrl', message: msg }], input);
  }
});

test('validate: Apps Script mode needs a /exec address, keeps the tabs as they are, and makes the sheet link optional', () => {
  const v = S.validate(formFrom(null, { mode: 'script', scriptUrl: 'https://script.google.com/a/macros/school.example/s/AKfycbx_Example-Deployment_0123456789abcdef/exec', sheetUrl: '', tabs: [] }));
  assert.deepEqual(v.errors, []);
  assert.equal(v.cfg.scriptUrl, SCRIPT_URL, 'written in its plain form');
  assert.equal(v.cfg.sheetUrl, '');
  assert.deepEqual(v.cfg.tabs, [{ gid: '0', name: 'Sheet1' }], 'tabs from config.js, not the (hidden) tab editor');
  const bad = [
    ['', S.messages.scriptMissing],
    ['https://script.google.com/macros/s/AKfycbx_Example-Deployment_0123456789abcdef/dev', S.messages.scriptDev],
    ['https://script.google.com/home/projects/1abcdefghijklmnop/edit', S.messages.scriptEditor],
    ['https://script.google.com.evil.example/macros/s/AKfycbx_Example-Deployment_0123456789abcdef/exec', S.messages.scriptBad],
    ['http://script.google.com/macros/s/AKfycbx_Example-Deployment_0123456789abcdef/exec', S.messages.scriptBad],
  ];
  for (const [input, msg] of bad) {
    assert.deepEqual(S.validate(formFrom(null, { mode: 'script', scriptUrl: input })).errors, [{ field: 'scriptUrl', message: msg }], input);
  }
  // Back to link mode: the script address is dropped.
  assert.equal(S.validate(formFrom(null, { mode: 'link', scriptUrl: SCRIPT_URL })).cfg.scriptUrl, '');
  assert.deepEqual(fieldsOf(S.validate(formFrom(null, { mode: 'other' }))), ['mode']);
});

test('validate: tab ids and names', () => {
  const tabs = rows => S.validate(formFrom(null, { tabs: rows }));
  assert.deepEqual(tabs([{ gid: '0', name: 'Sheet1' }, { gid: ' 1111920478 ', name: ' Other Materials ' }]).cfg.tabs,
    [{ gid: '0', name: 'Sheet1' }, { gid: '1111920478', name: 'Other Materials' }]);
  assert.deepEqual(fieldsOf(tabs([])), ['tabs']);
  for (const gid of ['', 'abc', '12a', '-1', '1.5', '1234567890123', '0x10']) {
    const v = tabs([{ gid, name: 'A' }]);
    assert.deepEqual(fieldsOf(v), ['tabs.0.gid'], JSON.stringify(gid));
    assert.equal(v.errors[0].message, gid ? S.messages.gidBad : S.messages.gidMissing);
  }
  assert.deepEqual(tabs([{ gid: '5', name: 'A' }, { gid: '5', name: 'B' }]).errors, [{ field: 'tabs.1.gid', message: 'Tab id 5 is already in the list.' }]);
  assert.deepEqual(fieldsOf(tabs([{ gid: '5', name: '  ' }])), ['tabs.0.name']);
  assert.deepEqual(fieldsOf(tabs([{ gid: '5', name: 'a'.repeat(100) }])), []);
  assert.match(tabs([{ gid: '5', name: 'a'.repeat(101) }]).errors[0].message, /100 characters or fewer \(it has 101\)/);
  assert.deepEqual(fieldsOf(tabs([{ gid: '5', name: EMOJI.repeat(100) }])), [], 'counted in characters, not UTF-16 units');
  for (const name of ['a\tb', 'a' + ch(1), 'a' + LS + 'b']) assert.deepEqual(fieldsOf(tabs([{ gid: '5', name }])), ['tabs.0.name'], JSON.stringify(name));
  assert.deepEqual(fieldsOf(tabs([{ gid: '5', name: ARABIC + ' ' + EMOJI }])), []);
});

test('validate: two tabs with the same name (after trimming, in any case) are a problem (BRW-3)', () => {
  const v = S.validate(formFrom(null, { tabs: [{ gid: '0', name: 'Sheet1' }, { gid: '1111920478', name: ' sheet1 ' }] }));
  assert.deepEqual(v.errors, [{ field: 'tabs.1.name', message: S.messages.nameTaken }]);
  assert.deepEqual(fieldsOf(S.validate(formFrom(null, { tabs: [{ gid: '0', name: 'Sheet1' }, { gid: '5', name: 'Sheet 1' }] }))), []);
  const nfd = 'Cafe' + ch(0x301), nfc = 'Caf' + ch(0xe9);
  assert.deepEqual(fieldsOf(S.validate(formFrom(null, { tabs: [{ gid: '0', name: nfc }, { gid: '5', name: nfd }] }))), ['tabs.1.name']);
});

test("validate: the school's code", () => {
  for (const code of ['UAS', 'A.B-C_D 1', ARABIC, 'x'.repeat(20)]) assert.deepEqual(fieldsOf(S.validate(formFrom(null, { schoolCode: code }))), [], code);
  for (const code of ['', '   ', '.', '-_', 'x'.repeat(21), 'U<S', 'UAS;', "U'S", 'UAS\n']) {
    assert.deepEqual(fieldsOf(S.validate(formFrom(null, { schoolCode: code }))), code.trim() === 'UAS' ? [] : ['schoolCode'], JSON.stringify(code));
  }
  assert.equal(S.validate(formFrom(null, { schoolCode: '  KES ' })).cfg.schoolCode, 'KES');
});

test('validate: trusted script codes accept SHA-256 codes and /exec addresses, as the search page does', () => {
  const hex = 'AB'.repeat(32);
  const v = S.validate(formFrom(null, { trustedScripts: '\n' + hex + '\r\n' + hex.toLowerCase() + '\n\n  ' + SCRIPT_URL + '  \n' }));
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.cfg.trustedScripts, [hex.toLowerCase(), SCRIPT_URL], 'lowercased, deduplicated, blank lines dropped');
  assert.deepEqual(S.validate(formFrom(null, { trustedScripts: [hex] })).cfg.trustedScripts, [hex.toLowerCase()]);
  const bad = S.validate(formFrom(null, { trustedScripts: hex + '\nnot a code\n' + 'a'.repeat(63) + '\nhttps://example.com/x/exec' }));
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0].field, 'trustedScripts');
  assert.match(bad.errors[0].message, /^Lines 2, 3 and 4 aren't a trusted script code/);
  assert.match(S.validate(formFrom(null, { trustedScripts: 'zz' })).errors[0].message, /^Line 1 isn't/);
  // An entry already in config.js stays as written there.
  const orig = Object.assign(repoCfg(), { trustedScripts: [hex] });
  assert.deepEqual(S.validate(formFrom(orig)).cfg.trustedScripts, [hex]);
});

test('validate: the alias list path and the repository address', () => {
  for (const a of ['', 'aliases.json', 'data/aliases.json', 'my-aliases_v2.json']) assert.deepEqual(fieldsOf(S.validate(formFrom(null, { aliasesUrl: a }))), [], a);
  for (const a of ['https://evil.example/a.json', '//evil.example/a.json', '/aliases.json', '../a.json', 'data/../a.json', 'a\\b.json', 'javascript:alert(1)', 'a.json?x=1', 'a b.json', 'x'.repeat(201)]) {
    assert.deepEqual(fieldsOf(S.validate(formFrom(null, { aliasesUrl: a }))), ['aliasesUrl'], a);
  }
  const ok = [
    ['https://github.com/mi3law/censorsearch', 'https://github.com/mi3law/censorsearch'],
    ['https://github.com/Some-Org/my.repo_v2/', 'https://github.com/Some-Org/my.repo_v2'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['  https://GitHub.com/owner/repo  ', 'https://github.com/owner/repo'],
  ];
  for (const [input, out] of ok) {
    const v = S.validate(formFrom(null, { repoUrl: input }));
    assert.deepEqual(v.errors, [], input);
    assert.equal(v.cfg.repoUrl, out, input);
  }
  for (const r of ['', 'http://github.com/a/b', 'https://github.com/a', 'https://github.com/a/b/c', 'https://gitlab.com/a/b',
    'https://github.com.evil.example/a/b', 'https://user@github.com/a/b', 'https://github.com/a/b?x=1', 'https://github.com/-a/b', 'https://github.com/a/..', 'github.com/a/b']) {
    assert.deepEqual(fieldsOf(S.validate(formFrom(null, { repoUrl: r }))), ['repoUrl'], r);
  }
  assert.deepEqual(S.parseRepoUrl('https://github.com/mi3law/censorsearch'), { owner: 'mi3law', repo: 'censorsearch', url: 'https://github.com/mi3law/censorsearch' });
  assert.equal(S.parseRepoUrl(null), null);
});

test('validate: errors come in the order of the form, and other settings pass through', () => {
  const v = S.validate(formFrom(null, {
    sheetUrl: 'x', tabs: [{ gid: 'a', name: '' }], schoolCode: '', trustedScripts: 'x', aliasesUrl: '/x', repoUrl: 'x', extra: { analytics: false },
  }));
  assert.deepEqual(fieldsOf(v), ['sheetUrl', 'tabs.0.gid', 'tabs.0.name', 'schoolCode', 'trustedScripts', 'aliasesUrl', 'repoUrl']);
  assert.equal(v.cfg.analytics, false);
});

test('sourceFor reads what the search page reads for the same config values', () => {
  assert.deepEqual(S.sourceFor(repoCfg()), { kind: 'csv', sheetId: '1fnfj7W8ZZvBSFNTfkyqPKupGUrvw79etZYF_ZHWVhzo', tabs: [{ gid: '0', name: 'Sheet1' }] });
  assert.deepEqual(S.sourceFor({ sheetUrl: 'https://docs.google.com/spreadsheets/d/' + SID + '/edit#gid=9', tabs: [] }), { kind: 'csv', sheetId: SID, tabs: [{ gid: '9', name: null }] });
  assert.deepEqual(S.sourceFor({ sheetUrl: SHEET_URL, scriptUrl: SCRIPT_URL, tabs: [{ gid: '0', name: 'A' }] }),
    { kind: 'script', url: SCRIPT_URL, tabs: null, sheetId: SID, sheetGid: '0' });
  assert.deepEqual(S.sourceFor({ sheetUrl: '', scriptUrl: SCRIPT_URL }), { kind: 'script', url: SCRIPT_URL, tabs: null });
  assert.equal(S.sourceFor({ sheetUrl: 'nope' }), null);
});

// ------------------------------------------------------------------------------------------------
// Diff and base64

test('diffLines: unchanged, changed, added and removed lines', () => {
  const ops = S.diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.deepEqual(ops, [
    { type: 'same', text: 'a', a: 1, b: 1 },
    { type: 'del', text: 'b', a: 2, b: null },
    { type: 'add', text: 'B', a: null, b: 2 },
    { type: 'same', text: 'c', a: 3, b: 3 },
    { type: 'add', text: 'd', a: null, b: 4 },
  ]);
  assert.deepEqual(S.diffLines('x\n', 'x\n'), [{ type: 'same', text: 'x', a: 1, b: 1 }]);
  assert.deepEqual(S.diffLines('', 'x'), [{ type: 'add', text: 'x', a: null, b: 1 }]);
  assert.deepEqual(S.diffLines('x\ny', ''), [{ type: 'del', text: 'x', a: 1, b: null }, { type: 'del', text: 'y', a: 2, b: null }]);
  // A moved block: the longest common subsequence keeps the most lines.
  const moved = S.diffLines('1\n2\n3\n4\n5', '1\n3\n4\n2\n5');
  assert.equal(moved.filter(o => o.type === 'same').length, 4);
  assert.deepEqual(S.diffHunks(S.diffLines('x', 'x')), []);
});

test('diffHunks: changed lines with two lines of context; far-apart changes in separate groups', () => {
  const a = Array.from({ length: 20 }, (_, i) => 'line ' + (i + 1)).join('\n');
  const b = a.replace('line 3', 'LINE 3').replace('line 17', 'LINE 17');
  const hunks = S.diffHunks(S.diffLines(a, b), 2);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].map(o => o.type + ':' + o.text), ['same:line 1', 'same:line 2', 'del:line 3', 'add:LINE 3', 'same:line 4', 'same:line 5']);
  assert.deepEqual(hunks[1].map(o => o.text), ['line 15', 'line 16', 'line 17', 'LINE 17', 'line 18', 'line 19']);
  assert.equal(S.diffHunks(S.diffLines(a, a.replace('line 3', 'X').replace('line 7', 'Y')), 2).length, 1, 'close changes share a group');
  // The settings case: one tab added changes exactly one line of config.js.
  const next = S.buildConfigJs(Object.assign(repoCfg(), { tabs: [{ gid: '0', name: 'Sheet1' }, { gid: '1111920478', name: 'Other Materials' }] }));
  const ops = S.diffLines(CONFIG_JS, next);
  assert.equal(ops.filter(o => o.type === 'del').length, 1);
  assert.equal(ops.filter(o => o.type === 'add').length, 1);
});

test('base64 of UTF-8 round-trips, matches Buffer, and reads GitHub content with line breaks', () => {
  for (const s of ['', 'a', CONFIG_JS, ARABIC + ' ' + EMOJI + ' ' + NBSP + " '\"\\", 'x'.repeat(100000) + EMOJI]) {
    const b64 = S.b64EncodeUtf8(s);
    assert.equal(b64, Buffer.from(s, 'utf8').toString('base64'));
    assert.equal(S.b64DecodeUtf8(b64), s);
  }
  const github = Buffer.from(CONFIG_JS, 'utf8').toString('base64').replace(/.{60}/g, '$&\n') + '\n';
  assert.equal(S.b64DecodeUtf8(github), CONFIG_JS);
  assert.throws(() => S.b64DecodeUtf8(Buffer.from([0xff, 0xfe, 0x41]).toString('base64')), 'invalid UTF-8');
  assert.throws(() => S.b64DecodeUtf8('not base64!'));
});

test('tokenPageUrl fills in only the documented fields', () => {
  const url = new URL(S.tokenPageUrl({ owner: 'mi3law', repo: 'censorsearch' }));
  assert.equal(url.origin + url.pathname, 'https://github.com/settings/personal-access-tokens/new');
  assert.deepEqual([...url.searchParams.keys()], ['name', 'description', 'target_name', 'contents', 'pages']);
  assert.equal(url.searchParams.get('target_name'), 'mi3law');
  assert.equal(url.searchParams.get('contents'), 'write');
  assert.equal(url.searchParams.get('pages'), 'read');
  assert.ok(url.searchParams.get('name').length <= 40);
  assert.equal(S.tokenPageUrl(null), 'https://github.com/settings/personal-access-tokens/new');
});

// ------------------------------------------------------------------------------------------------
// githubSave against a mocked GitHub

const NEW_TEXT = S.buildConfigJs(Object.assign(repoCfg(), { schoolCode: 'KES' }));
const b64Lines = s => Buffer.from(s, 'utf8').toString('base64').replace(/.{60}/g, '$&\n') + '\n';
const json = (status, body, headers) => new Response(body == null ? '' : JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
const API = 'https://api.github.com/repos/o-wner/r.epo';

// routes: { 'GET /pages': Response | fn | Error }. Unlisted calls fail the test.
function gh(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const key = init.method + ' ' + url.replace(API, '');
    if (!(key in routes)) throw new Error('unexpected call ' + key);
    const r = typeof routes[key] === 'function' ? routes[key](init) : routes[key];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

const PAGES = () => json(200, { url: API + '/pages', status: 'built', build_type: 'legacy', source: { branch: 'main', path: '/' }, html_url: 'https://o-wner.github.io/r.epo/' });
const CONTENTS = (text = CONFIG_JS) => json(200, { name: 'config.js', path: 'config.js', sha: 'd23c5bbc61831ba40c0cd77008a28732bc2cf2dc', type: 'file', encoding: 'base64', content: b64Lines(text) });
const PUT_OK = () => json(200, { content: { sha: 'newsha0000000000000000000000000000000000' }, commit: { sha: 'c0ffee', html_url: 'https://github.com/o-wner/r.epo/commit/c0ffee' } });

const save = (fetch, over) => S.githubSave(Object.assign({
  token: TOKEN, owner: 'o-wner', repo: 'r.epo', content: NEW_TEXT, message: 'Update CensorSearch settings', expectedCurrent: CONFIG_JS, fetch, now: () => Date.UTC(2026, 9, 2, 12, 0, 0),
}, over || {}));

function assertTokenOnlyInAuthHeader(calls, result) {
  for (const c of calls) {
    assert.ok(!c.url.includes(TOKEN), 'token in a URL');
    const { headers, ...rest } = c.init;
    assert.ok(!JSON.stringify(rest).includes(TOKEN), 'token outside the headers');
    const others = Object.entries(headers).filter(([k]) => k !== 'Authorization');
    assert.ok(!JSON.stringify(others).includes(TOKEN), 'token in another header');
    assert.equal(headers.Authorization, 'Bearer ' + TOKEN);
  }
  if (result) assert.ok(!JSON.stringify(result).includes(TOKEN), 'token in the result');
}

test('githubSave: the branch GitHub Pages publishes, exact requests, token only in the Authorization header', async () => {
  const f = gh({ 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': CONTENTS(), 'PUT /contents/config.js': PUT_OK() });
  const progress = [];
  const r = await save(f, { onProgress: t => progress.push(t) });
  assert.deepEqual(r, {
    ok: true, branch: 'main', branchFrom: 'pages', path: 'config.js', where: 'branch main of o-wner/r.epo, which GitHub Pages publishes',
    commitUrl: 'https://github.com/o-wner/r.epo/commit/c0ffee', sha: 'newsha0000000000000000000000000000000000',
  });
  assert.deepEqual(f.calls.map(c => c.init.method + ' ' + c.url), [
    'GET ' + API + '/pages', 'GET ' + API + '/contents/config.js?ref=main', 'PUT ' + API + '/contents/config.js',
  ]);
  const base = { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual' };
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + TOKEN };
  for (const c of f.calls.slice(0, 2)) {
    const { signal, ...init } = c.init;
    assert.ok(signal, 'a timeout signal');
    assert.deepEqual(init, Object.assign({ method: 'GET', headers }, base));
  }
  const { signal, body, ...put } = f.calls[2].init;
  assert.deepEqual(put, Object.assign({ method: 'PUT', headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) }, base));
  assert.equal(body, JSON.stringify({ message: 'Update CensorSearch settings', content: Buffer.from(NEW_TEXT, 'utf8').toString('base64'), sha: 'd23c5bbc61831ba40c0cd77008a28732bc2cf2dc', branch: 'main' }));
  assertTokenOnlyInAuthHeader(f.calls, r);
  assert.ok(!progress.join(' ').includes(TOKEN));
  assert.match(progress.join(' | '), /Finding the branch GitHub Pages publishes.*Reading config\.js from branch main.*Saving config\.js to branch main/);
});

test("githubSave: a token without Pages: Read saves nothing, since the branch the site comes from can't be known (GH2)", async () => {
  // The default branch may not be the one GitHub Pages publishes (this repository once published v1): saving there
  // would never go live, even when config.js happens to be the same on both branches.
  const f403 = gh({ 'GET /pages': json(403, { message: 'Resource not accessible by personal access token' }, { 'x-ratelimit-remaining': '4999' }) });
  const denied = await save(f403);
  assert.deepEqual(denied, { ok: false, kind: 'permission', status: 403, message: S.githubMessages.noPages + ' GitHub said: "Resource not accessible by personal access token".' });
  assert.match(denied.message, /Pages: Read-only as well as Contents: Read and write/);
  assert.equal(f403.calls.length, 1, 'no further calls, no PUT');
});

test('githubSave: without a GitHub Pages site, or with one published by a workflow, it saves to the default branch and says so', async () => {
  const f = gh({ 'GET /pages': json(404, { message: 'Not Found' }), 'GET ': json(200, { full_name: 'o-wner/r.epo', default_branch: 'trunk' }), 'GET /contents/config.js?ref=trunk': CONTENTS(), 'PUT /contents/config.js': PUT_OK() });
  const r = await save(f);
  assert.equal(r.ok, true);
  assert.equal(r.branch, 'trunk');
  assert.equal(r.branchFrom, 'default');
  assert.equal(r.where, 'the default branch of o-wner/r.epo, trunk, because it has no GitHub Pages site');
  assert.equal(JSON.parse(f.calls[3].init.body).branch, 'trunk');
  assertTokenOnlyInAuthHeader(f.calls, r);
  // Published by a workflow: the Pages source branch isn't what publishes, so the default branch is used.
  const w = gh({ 'GET /pages': json(200, { build_type: 'workflow', source: { branch: 'gh-pages', path: '/' } }), 'GET ': json(200, { default_branch: 'main' }), 'GET /contents/config.js?ref=main': CONTENTS(), 'PUT /contents/config.js': PUT_OK() });
  const rw = await save(w);
  assert.equal(rw.branch, 'main');
  assert.match(rw.where, /with a workflow/);
});

test('githubSave: stops before saving when config.js changed on GitHub since the page loaded', async () => {
  const f = gh({ 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': CONTENTS(CONFIG_JS.replace("'UAS'", "'XYZ'")) });
  const r = await save(f);
  assert.deepEqual(r, { ok: false, kind: 'changed', message: S.githubMessages.changed, branch: 'main', branchFrom: 'pages' });
  assert.equal(f.calls.length, 2, 'no PUT');
});

test('githubSave: errors in plain words, never with the token', async () => {
  const cases = [
    ['401 bad token', { 'GET /pages': json(401, { message: 'Bad credentials' }) }, 'auth', /didn't accept the token: it may be mistyped, expired or revoked/, 1],
    ['403 rate limit', { 'GET /pages': json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.UTC(2026, 9, 2, 12, 30, 0) / 1000) }) }, 'rateLimit', /limit on requests for this token is used up for now, so nothing was saved\. Try again in about 30 minutes\./, 1],
    ['403 secondary limit', { 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': CONTENTS(), 'PUT /contents/config.js': json(403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '60' }) }, 'rateLimit', /Try again in a minute\./, 3],
    ['403 no write permission', { 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': CONTENTS(), 'PUT /contents/config.js': json(403, { message: 'Resource not accessible by personal access token' }) }, 'permission', /no permission to change files in o-wner\/r\.epo\. When making it, give it Repository permissions, Contents: Read and write\. GitHub said: "Resource not accessible by personal access token"\./, 3],
    ['404 repository', { 'GET /pages': json(404, {}), 'GET ': json(404, { message: 'Not Found' }) }, 'notFound', /The token can't see o-wner\/r\.epo\. When making it, choose that repository under Repository access/, 2],
    ['404 config.js', { 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': json(404, { message: 'Not Found' }) }, 'notFound', /can't find config\.js on branch main of o-wner\/r\.epo/, 2],
    ['404 on save', { 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': CONTENTS(), 'PUT /contents/config.js': json(404, { message: 'Not Found' }) }, 'notFound', /didn't let the token change config\.js in o-wner\/r\.epo/, 3],
    ['409', { 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': CONTENTS(), 'PUT /contents/config.js': json(409, { message: 'config.js does not match d23c5bb' }) }, 'conflict', /^config\.js changed on GitHub while saving, so nothing was saved\. Reload this page and make the change again\. GitHub said: "config\.js does not match d23c5bb"\.$/, 3],
    ['422', { 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': CONTENTS(), 'PUT /contents/config.js': json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }) }, 'refused', /^GitHub refused the change \(HTTP 422\), so nothing was saved, and saving again won't help\. GitHub said: "Invalid request\. "sha" wasn't supplied\."\./, 3],
    ['409 ruleset', { 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': CONTENTS(), 'PUT /contents/config.js': json(409, { message: 'Repository rule violations found\n\nChanges must be made through a pull request.' }) }, 'refused', /^GitHub refused the change \(HTTP 409\), so nothing was saved, and saving again won't help\. GitHub said: "Repository rule violations found Changes must be made through a pull request\."\. Branch protection or a ruleset on branch main may require changes to go through a pull request/, 3],
    ['500', { 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': json(502, null) }, 'server', /GitHub had a problem \(HTTP 502\)/, 2],
    ['network', { 'GET /pages': new TypeError('Failed to fetch') }, 'network', /Couldn't reach GitHub, so nothing was saved/, 1],
    ['network on save', { 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': CONTENTS(), 'PUT /contents/config.js': new TypeError('Failed to fetch') }, 'network', /can't tell whether config\.js was saved/, 3],
    ['not a file', { 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': json(200, [{ name: 'x' }]) }, 'format', /couldn't be read/, 2],
  ];
  for (const [name, routes, kind, re, n] of cases) {
    const f = gh(routes);
    const r = await save(f);
    assert.equal(r.ok, false, name);
    assert.equal(r.kind, kind, name);
    assert.match(r.message, re, name);
    assert.equal(f.calls.length, n, name + ': calls');
    assertTokenOnlyInAuthHeader(f.calls, r);
  }
});

test('githubSave: refuses before any request without a repository, a token, or the served config.js', async () => {
  const f = gh({});
  const cases = [
    [{ owner: '', repo: 'x' }, 'config'], [{ owner: 'a/b', repo: 'x' }, 'config'], [{ repo: '..' }, 'config'],
    [{ token: '' }, 'token'], [{ token: '   ' }, 'token'], [{ token: 'abc def' }, 'token'], [{ token: 'abc\ndef' }, 'token'], [{ token: 'tok' + ARABIC }, 'token'],
    [{ expectedCurrent: null }, 'config'], [{ content: '' }, 'config'],
  ];
  for (const [over, kind] of cases) {
    const r = await save(f, over);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.kind, kind, JSON.stringify(over));
    if (over.token && over.token.trim()) assert.ok(!r.message.includes(over.token.trim()));
  }
  assert.equal(f.calls.length, 0);
});

test('githubSave: only an https commit link is passed on', async () => {
  const f = gh({ 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': CONTENTS(), 'PUT /contents/config.js': json(201, { content: {}, commit: { html_url: 'javascript:alert(1)' } }) });
  const r = await save(f);
  assert.equal(r.ok, true);
  assert.equal(r.commitUrl, null);
});

test('githubSave: a site GitHub Pages publishes from the docs folder saves docs/config.js (sec-1, GH5)', async () => {
  const pagesDocs = () => json(200, { build_type: 'legacy', source: { branch: 'main', path: '/docs' } });
  const f = gh({ 'GET /pages': pagesDocs(), 'GET /contents/docs/config.js?ref=main': CONTENTS(), 'PUT /contents/docs/config.js': PUT_OK() });
  const progress = [];
  const r = await save(f, { onProgress: t => progress.push(t) });
  assert.equal(r.ok, true);
  assert.equal(r.path, 'docs/config.js');
  assert.equal(r.where, 'the docs folder of branch main of o-wner/r.epo, which GitHub Pages publishes');
  assert.deepEqual(f.calls.map(c => c.init.method + ' ' + c.url.replace(API, '')), ['GET /pages', 'GET /contents/docs/config.js?ref=main', 'PUT /contents/docs/config.js']);
  assert.match(progress.join(' | '), /Reading config\.js from the docs folder of branch main/);
  // Not there: the message names the file it looked for.
  const missing = await save(gh({ 'GET /pages': pagesDocs(), 'GET /contents/docs/config.js?ref=main': json(404, { message: 'Not Found' }) }));
  assert.match(missing.message, /^GitHub can't find docs\/config\.js on branch main of o-wner\/r\.epo/);
  // Any other folder (the API allows only "/" and "/docs" today): refused before reading or saving anything.
  const odd = gh({ 'GET /pages': json(200, { build_type: 'legacy', source: { branch: 'main', path: '/site' } }) });
  const r2 = await save(odd);
  assert.equal(r2.ok, false);
  assert.match(r2.message, /from a folder \(\/site\) this page can't save to, so nothing was saved/);
  assert.equal(odd.calls.length, 1);
});

test('githubSave: a renamed or transferred repository (GitHub redirects) says so, without following the redirect (sec-2, GH4)', async () => {
  // In a browser, redirect: 'manual' gives an opaque redirect with status 0; elsewhere fetch gives the 301 itself.
  const opaque = () => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), json: async () => { throw new TypeError('opaque'); } });
  for (const moved of [opaque, () => new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/1/pages' } })]) {
    const f = gh({ 'GET /pages': moved() });
    const r = await save(f);
    assert.deepEqual(r, { ok: false, kind: 'moved', message: S.githubMessages.moved });
    assert.match(r.message, /has moved \(it was renamed or transferred\), so nothing was saved\. Put its new address under Advanced, Source code address/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.redirect, 'manual', 'the token is never sent to the new address');
  }
  const put = gh({ 'GET /pages': PAGES(), 'GET /contents/config.js?ref=main': CONTENTS(), 'PUT /contents/config.js': opaque() });
  assert.equal((await save(put)).kind, 'moved');
});

// ------------------------------------------------------------------------------------------------
// The page (settings.html + src/settings.js) in a fake DOM

const HEAD = ['Synthetic Banned List 2004-2026,,,,,,', 'updated as of 1 January 2026,,,,,,', 'Title,Author,ISBN,Banned By,Type,Year of Banning,Memo'];
const ROWS0 = ['Zebra Tales,Zed Author,,Ministry,Book,2020-2021,', 'Harbor Lights,Ann Other,,UAS,DVD,2022-2023,', '<b>Bold</b> & Co,Kim Doe,,KES,Book,2021-2022,', 'Orchard Mysteries,Lee Author,,RS,Book,2019-2020,'];
const ROWS1 = ['Other Thing,Some Author,,UAS,Kit,2023-2024,'];
// Google names the export "<document> - <tab>.csv".
const csv = (rows, tab = 'Sheet1') => new Response(HEAD.concat(rows).join('\r\n'), { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent('Synthetic - ' + tab + '.csv') } });
const jsonFile = (status, text) => new Response(text, { status, headers: { 'content-type': 'application/json' } });
const GH_REPO = 'https://api.github.com/repos/school-org/censorsearch';
const PAGE_CFG = { sheetUrl: SHEET_URL, tabs: [{ gid: '0', name: 'Sheet1' }], scriptUrl: '', trustedScripts: [], schoolCode: 'UAS', aliasesUrl: 'aliases.json', repoUrl: 'https://github.com/school-org/censorsearch' };
const PAGE_TEXT = S.buildConfigJs(PAGE_CFG);

// Opens settings.html. served: config.js as the site serves it now (the read past the cache); tag: the copy the page's
// own <script src="config.js"> ran (the browser cache may hold an older one). The fetch stub answers config.js, the
// alias list, the Google export, the script and GitHub; `live` is what later reads of config.js (the publish polls)
// return, as a function of the poll number.
async function openSettings(o = {}) {
  const served = o.served != null ? o.served : PAGE_TEXT;
  const tag = o.tag != null ? o.tag : served;
  const state = {
    live: o.live || (() => served), github: o.github || {}, sheet: o.sheet || null, configReads: 0,
    aliases: o.aliases || (u => (u.pathname === '/censorsearch/aliases.json' ? jsonFile(200, read('aliases.json')) : new Response('Not found', { status: 404 }))),
  };
  const b = makeBrowser({
    page: 'settings.html', framed: o.framed, crypto: o.crypto,
    scripts: src => (src === 'config.js' ? tag : /^config\.js\?fresh=\d+$/.test(src) ? served : undefined),
    fetch: async (url, init) => {
      const u = new URL(url);
      if (u.origin === 'https://school.example') {
        if (u.pathname !== '/censorsearch/config.js') return state.aliases(u, init);
        // Read at the address the search page's <script src="config.js"> uses, past the browser's cache and refreshing
        // it (cache: 'no-store' or another address would leave the search page on the old copy for 10 minutes).
        assert.equal(url, 'https://school.example/censorsearch/config.js');
        assert.equal(init.cache, 'reload');
        const n = state.configReads++;   // 0: when the page opens; then the publish polls 1, 2, …
        return new Response(n ? state.live(n) : served, { status: 200, headers: { 'content-type': 'application/javascript' } });
      }
      if (u.hostname === 'docs.google.com') {
        if (state.sheet) return state.sheet(u);
        const gid = u.searchParams.get('gid');
        if (gid === '0') return csv(ROWS0);
        if (gid === '1111920478') return csv(ROWS1, 'Other Materials');
        return new Response('nope', { status: 400 });
      }
      if (u.hostname === 'script.google.com') return state.script(u);
      if (u.hostname === 'api.github.com') {
        const key = init.method + ' ' + url.replace(GH_REPO, '');
        const r = state.github[key];
        if (!r) throw new TypeError('unexpected GitHub call ' + key);
        return typeof r === 'function' ? r(init) : r;
      }
      throw new TypeError('unexpected ' + url);
    },
  });
  b.state = state;
  b.start();
  await b.flush();
  b.ghCalls = () => b.fetchCalls.filter(c => c.url.startsWith('https://api.github.com'));
  b.polls = () => b.fetchCalls.filter(c => c.url === 'https://school.example/censorsearch/config.js').length - 1;
  b.googleCalls = () => b.fetchCalls.filter(c => /google\.com/.test(new URL(c.url).hostname));
  b.rows = () => b.$('tab-list').querySelectorAll('li.tab-row');
  b.check = async () => { b.click(b.$('check-button')); await b.flush(); };
  b.save = async () => { b.click(b.$('save-button')); await b.flush(); };
  return b;
}

const githubOk = (onPut) => ({
  'GET /pages': () => json(200, { build_type: 'legacy', source: { branch: 'main', path: '/' } }),
  'GET /contents/config.js?ref=main': () => CONTENTS(PAGE_TEXT),
  'PUT /contents/config.js': init => { if (onPut) onPut(init); return json(200, { content: { sha: 'new' }, commit: { html_url: 'https://github.com/school-org/censorsearch/commit/abc123' } }); },
});

test('settings.html: CSP, noindex, title, deferred scripts in order, nothing inline, labels and descriptions point at real ids', () => {
  const html = read('settings.html');
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:\/\/docs\.google\.com https:\/\/\*\.googleusercontent\.com https:\/\/script\.google\.com https:\/\/api\.github\.com; base-uri 'none'; form-action 'none'">/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<title>CensorSearch settings<\/title>/);
  assert.deepEqual([...html.matchAll(/<script ([^>]*)><\/script>/g)].map(m => m[1]), ['defer src="config.js"', 'defer src="src/sheet.js"', 'defer src="src/settings.js"']);
  assert.equal((html.match(/<script/g) || []).length, 3, 'no other scripts');
  assert.doesNotMatch(html, /\sstyle=|<style|\son[a-z]+=|javascript:/i, 'no inline styles or handlers');
  assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
  assert.match(html, /<a href="\.\/">Back to the search page<\/a>/);
  const b = makeBrowser({ page: 'settings.html' });
  const ids = new Set(b.doc.querySelectorAll('[id]').map(e => e.id));
  assert.equal(ids.size, b.doc.querySelectorAll('[id]').length, 'ids are unique');
  for (const l of b.doc.querySelectorAll('label')) assert.ok(ids.has(l.getAttribute('for')), 'label for ' + l.getAttribute('for'));
  for (const e of b.doc.querySelectorAll('[aria-describedby]')) for (const id of e.getAttribute('aria-describedby').split(' ')) assert.ok(ids.has(id), id);
  for (const e of b.doc.querySelectorAll('input, textarea')) assert.ok(b.doc.querySelector('label[for="' + e.id + '"]'), 'a label for #' + e.id);
  const token = b.$('token');
  assert.deepEqual(['type', 'autocomplete', 'autocapitalize', 'spellcheck'].map(k => token.getAttribute(k)), ['password', 'off', 'off', 'false']);
  assert.equal(b.$('settings-app').hidden, true, 'nothing shows before the frame check');
  for (const id of ['mode-fieldset', 'tabs-fieldset']) assert.equal(b.$(id).tagName, 'FIELDSET');
  assert.equal(b.$('mode-fieldset').querySelector('legend').textContent, 'How the page reads the list');
});

test('index.html links to the settings page; settings.js uses no HTML strings, eval or storage', () => {
  assert.match(read('index.html'), /<a href="settings\.html">Settings for the list's maintainers<\/a>/);
  const src = read('src/settings.js');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'console.']) {
    assert.ok(!src.includes(bad), bad);
  }
});

test('framed: the page shows only a link to open it on its own, never the form or the token field', async () => {
  const b = await openSettings({ framed: true });
  assert.equal(b.$('settings-app'), null);
  assert.equal(b.$('token'), null);
  assert.equal(b.$('settings-form'), null);
  assert.equal(b.$('framed').hidden, false);
  assert.equal(b.$('framed-link').getAttribute('href'), 'settings.html');
  assert.equal(b.$('framed-link').rel, 'noopener noreferrer');
  assert.equal(b.fetchCalls.length, 0);
});

test('current settings in plain words, and the form filled in from them', async () => {
  const b = await openSettings();
  assert.equal(b.$('page-status').hidden, true);
  const cur = b.text('current-list');
  assert.match(cur, /How the page reads the listBy link, from this Google Sheet \(sheet 1AbCdE…abcd\), shared "Anyone with the link can view"\./);
  assert.match(cur, /Tabs searchedSheet1 \(tab id 0\)\./);
  assert.match(cur, /School's Banned By codeUAS\./);
  assert.match(cur, /Source codeschool-org\/censorsearch on GitHub\./);
  const link = b.$('current-list').querySelector('a');
  assert.equal(link.href, 'https://docs.google.com/spreadsheets/d/' + SID + '/edit?gid=0#gid=0');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(b.$('mode-link').checked, true);
  assert.equal(b.$('sheet-url').value, SHEET_URL);
  assert.equal(b.rows().length, 1);
  assert.equal(b.$('school-code').value, 'UAS');
  assert.equal(b.$('script-field').hidden, true);
  assert.equal(b.text('diff-summary'), 'No changes yet: these are the settings in config.js.');
  assert.equal(b.$('current-note').hidden, true);
  assert.match(b.$('token-new-link').href, /target_name=school-org&contents=write&pages=read$/);
  assert.equal(b.text('howto-repo'), 'school-org/censorsearch');
  assert.deepEqual(b.scriptLoads, [], 'config.js matched: no fresh copy needed');
});

test('script mode: current settings and the form', async () => {
  const cfg = Object.assign({}, PAGE_CFG, { scriptUrl: SCRIPT_URL, trustedScripts: ['ab'.repeat(32)], analytics: false });
  const b = await openSettings({ served: S.buildConfigJs(cfg) });
  const cur = b.text('current-list');
  assert.match(cur, /Through the Apps Script web app \(deployment AKfycb…cdef\), whose own tab list decides which tabs are searched\./);
  assert.match(cur, /Sheet linkthis Google Sheet \(sheet 1AbCdE…abcd\), shown as "Open the sheet"/);
  assert.match(cur, /Trusted script codes1 code\./);
  assert.match(cur, /Other settings, kept as they areanalytics\./);
  assert.equal(b.$('mode-script').checked, true);
  assert.equal(b.$('tabs-fieldset').hidden, true);
  assert.equal(b.$('script-field').hidden, false);
  assert.equal(b.$('sheet-url-optional').hidden, false);
});

test('check, then save: per-tab results, the diff, a save that sends only config.js, token cleared, then live', async () => {
  let putBody = null;
  let livePoll = 3;
  const b = await openSettings({ github: githubOk(init => { putBody = JSON.parse(init.body); }) });
  b.state.live = n => (n >= livePoll ? putBody && Buffer.from(putBody.content, 'base64').toString('utf8') : PAGE_TEXT);

  // Add the Other Materials tab from its link.
  b.type(b.$('tab-link'), 'https://docs.google.com/spreadsheets/d/' + SID + '/edit#gid=1111920478', { change: false });
  b.click(b.$('tab-link-add'));
  await b.flush();
  assert.equal(b.rows().length, 2);
  const nameInput = b.rows()[1].querySelector('.name-input');
  assert.equal(b.rows()[1].querySelector('.gid-input').value, '1111920478');
  assert.equal(b.focused(), nameInput, 'focus moves to the new tab name');
  assert.equal(b.text('tab-link-note'), 'Added tab id 1111920478. Give it a name.');
  b.type(nameInput, 'Other Materials');

  // The diff shows the one changed line.
  assert.equal(b.text('diff-summary'), 'Changes to config.js: 1 line removed, 1 line added.');
  assert.equal(b.$('diff').hidden, false);
  assert.match(b.$('diff').querySelector('del').textContent, /tabs: \[\{ gid: '0', name: 'Sheet1' \}\],/);
  assert.match(b.$('diff').querySelector('ins').textContent, /Added: {3}tabs: \[\{ gid: '0', name: 'Sheet1' \}, \{ gid: '1111920478', name: 'Other Materials' \}\],/);

  // Saving needs a check first.
  b.type(b.$('token'), TOKEN, { change: false });
  await b.save();
  assert.equal(b.text('save-status'), 'Check the list first: saving needs a successful check of exactly these settings.');
  assert.equal(b.focused(), b.$('check-button'));
  assert.equal(b.ghCalls().length, 0);

  await b.check();
  assert.match(b.text('check-status'), /^Checked at \d\d:\d\d: 2 tabs, 5 items, no problems\. You can save these settings\.$/);
  const tabs = b.$('check-results').querySelectorAll('section.check-tab');
  assert.equal(tabs.length, 2);
  assert.match(tabs[0].textContent, /^Sheet1 \(tab id 0\)4 itemsHeader row 3: Title, Author, ISBN, Banned By, Type, Year of Banning, Memo"updated as of 1 January 2026" \(from the sheet\)First 3 items:Zebra TalesHarbor Lights<b>Bold<\/b> & Co/);
  assert.equal(tabs[0].querySelectorAll('ol.first-titles li').length, 3);
  assert.equal(tabs[0].querySelector('b'), null, 'titles are text, never markup');
  assert.match(tabs[1].textContent, /^Other Materials \(tab id 1111920478\)1 item/);
  assert.match(b.text('check-results'), /Read by link from spreadsheet 1AbCdE…abcd\./);
  const exports = b.googleCalls().map(c => new URL(c.url).searchParams.get('gid'));
  assert.deepEqual(exports.sort(), ['0', '1111920478']);

  await b.save();
  assert.equal(b.text('save-status'), 'Saved to branch main of school-org/censorsearch, which GitHub Pages publishes.');
  const link = b.$('save-links').querySelector('a');
  assert.equal(link.href, 'https://github.com/school-org/censorsearch/commit/abc123');
  assert.equal(link.textContent, 'See the change on GitHub');
  assert.equal(b.$('token').value, '', 'token field cleared');
  assert.deepEqual(b.ghCalls().map(c => c.init.method + ' ' + c.url.replace(GH_REPO, '')), ['GET /pages', 'GET /contents/config.js?ref=main', 'PUT /contents/config.js']);
  const saved = Buffer.from(putBody.content, 'base64').toString('utf8');
  assert.equal(saved, S.buildConfigJs(Object.assign({}, PAGE_CFG, { tabs: [{ gid: '0', name: 'Sheet1' }, { gid: '1111920478', name: 'Other Materials' }] })));
  assert.equal(putBody.branch, 'main');
  assert.equal(putBody.message, 'Update CensorSearch settings');

  // Current settings and the diff now show the saved settings.
  assert.match(b.text('current-list'), /Tabs searchedSheet1 \(tab id 0\) and Other Materials \(tab id 1111920478\)\./);
  assert.equal(b.text('diff-summary'), 'No changes yet: these are the settings in config.js.');

  // Publishing: the site serves the old file for two polls, then the new one.
  assert.equal(b.text('publish-status'), 'Publishing… GitHub Pages usually takes a minute or two.');
  await b.advance(10000);
  await b.advance(10000);
  assert.equal(b.text('publish-status'), 'Publishing… GitHub Pages usually takes a minute or two.');
  await b.advance(10000);
  assert.equal(b.text('publish-status'), S.LIVE_TEXT);
  assert.equal(b.polls(), 3);
  await b.advance(60000);
  assert.equal(b.polls(), 3, 'polling stops once live');

  // The token went only into the Authorization header of the GitHub calls.
  assert.ok(!b.everything().includes(TOKEN), 'token in the page');
  assert.ok(!JSON.stringify(b.logs).includes(TOKEN), 'token in the console');
  for (const c of b.fetchCalls) {
    assert.ok(!c.url.includes(TOKEN));
    if (c.init.body) assert.ok(!String(c.init.body).includes(TOKEN));
    const auth = c.init.headers && c.init.headers.Authorization;
    if (c.url.startsWith('https://api.github.com/')) assert.equal(auth, 'Bearer ' + TOKEN);
    else assert.equal(auth, undefined, 'no token to ' + c.url);
  }
});

test('publishing that takes over 5 minutes points at GitHub\'s progress', async () => {
  const b = await openSettings({ github: githubOk(), live: () => PAGE_TEXT });
  b.type(b.$('school-code'), 'KES');
  await b.check();
  b.type(b.$('token'), TOKEN, { change: false });
  await b.save();
  assert.equal(b.text('publish-status'), 'Publishing… GitHub Pages usually takes a minute or two.');
  // Each poll is armed 10 s after the previous one finishes, so the 30th lands a few real milliseconds after 5 minutes.
  await b.advance(5 * 60000 + 5000);
  assert.equal(b.text('publish-status'), "It's taking longer than usual: it may take a few more minutes. See GitHub's publishing progress.");
  assert.equal(b.$('publish-status').querySelector('a').href, 'https://github.com/school-org/censorsearch/actions');
  assert.equal(b.polls(), 30);
});

test('invalid settings block the check and the save, with the error tied to its field', async () => {
  const b = await openSettings({ github: githubOk() });
  b.type(b.$('sheet-url'), 'not a link');
  const input = b.$('sheet-url');
  assert.equal(b.$('sheet-url-error').hidden, false, 'shown once the field is left');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-describedby'), 'sheet-url-help sheet-url-error');
  assert.equal(b.text('diff-summary'), 'Fix the problems marked above to see the changes to config.js.');
  b.$('save-button').focus();
  await b.check();
  assert.equal(b.text('check-status'), 'Fix the problem marked above, then check again.');
  assert.equal(b.focused(), input);
  assert.equal(b.googleCalls().length, 0);
  b.type(b.$('token'), TOKEN, { change: false });
  await b.save();
  assert.equal(b.text('save-status'), 'Fix the problems marked above first.');
  assert.equal(b.ghCalls().length, 0);
  assert.equal(b.$('token').value, TOKEN, 'token kept for when the problem is fixed');

  // A problem in Advanced opens it and focuses the field.
  b.type(b.$('sheet-url'), SHEET_URL);
  b.$('advanced').open = false;
  b.type(b.$('repo-url'), 'https://gitlab.com/a/b', { change: false });
  await b.check();
  assert.equal(b.$('advanced').open, true);
  assert.equal(b.focused(), b.$('repo-url'));
  assert.equal(b.text('repo-url-error'), S.messages.repoBad);

  // Fixed: the error goes away and the field is no longer marked.
  b.type(b.$('repo-url'), 'https://github.com/school-org/censorsearch');
  assert.equal(b.$('repo-url-error').hidden, true);
  assert.equal(b.$('repo-url').getAttribute('aria-invalid'), null);
  assert.equal(b.$('repo-url').getAttribute('aria-describedby'), 'repo-url-help');
});

test('tab rows: errors on the row, no tabs at all, removing moves focus', async () => {
  const b = await openSettings();
  b.click(b.$('tab-add'));
  await b.flush();
  const row = b.rows()[1];
  assert.equal(b.focused(), row.querySelector('.gid-input'));
  b.type(row.querySelector('.gid-input'), '12x');
  assert.equal(row.querySelector('.field-error').textContent, S.messages.gidBad);
  assert.match(row.querySelector('label').textContent, /^Tab id of tab 2$/);
  b.click(row.querySelector('.tab-remove'));
  await b.flush();
  assert.equal(b.rows().length, 1);
  assert.equal(b.focused(), b.rows()[0].querySelector('.tab-remove'));
  b.click(b.rows()[0].querySelector('.tab-remove'));
  await b.flush();
  assert.equal(b.rows().length, 0);
  assert.equal(b.focused(), b.$('tab-add'));
  assert.equal(b.text('tabs-error'), S.messages.tabsMissing);
  assert.equal(b.$('tabs-fieldset').getAttribute('aria-describedby'), 'tabs-help tabs-error');
});

test('a sheet link that opens a tab: picked up into an empty tab list, else offered', async () => {
  const b = await openSettings();
  b.type(b.$('sheet-url'), 'https://docs.google.com/spreadsheets/d/' + SID + '/edit#gid=1111920478', { change: false });
  const hint = b.$('sheet-url-hint');
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /opens the tab with id 1111920478, which isn't in the tab list/);
  b.click(hint.querySelector('button'));
  await b.flush();
  assert.deepEqual(b.rows().map(r => r.querySelector('.gid-input').value), ['0', '1111920478']);
  assert.equal(b.focused(), b.rows()[1].querySelector('.name-input'));
  assert.equal(hint.hidden, true);

  const c = await openSettings();
  c.click(c.rows()[0].querySelector('.tab-remove'));
  await c.flush();
  c.type(c.$('sheet-url'), 'https://docs.google.com/spreadsheets/d/' + SID2 + '/edit#gid=77', { change: false });
  assert.deepEqual(c.rows().map(r => r.querySelector('.gid-input').value), ['77']);
  assert.match(c.text('tab-link-note'), /Tab id 77 from the sheet link is now in the tab list/);
});

test('add a tab from its link: wrong spreadsheet, no tab id, already listed', async () => {
  const b = await openSettings();
  const add = async link => { b.type(b.$('tab-link'), link, { change: false }); b.click(b.$('tab-link-add')); await b.flush(); };
  await add('https://docs.google.com/spreadsheets/d/' + SID2 + '/edit#gid=5');
  assert.match(b.text('tab-link-error'), /another spreadsheet/);
  assert.equal(b.$('tab-link').getAttribute('aria-invalid'), 'true');
  assert.equal(b.$('tab-link').getAttribute('aria-describedby'), 'tab-link-help tab-link-error');
  await add('https://docs.google.com/spreadsheets/d/' + SID + '/edit');
  assert.match(b.text('tab-link-error'), /doesn't say which tab/);
  await add('https://docs.google.com/spreadsheets/d/' + SID + '/edit#gid=0');
  assert.equal(b.$('tab-link-error').hidden, true);
  assert.equal(b.text('tab-link-note'), 'Tab id 0 is already in the list.');
  assert.equal(b.rows().length, 1);
  // Enter in the box adds too.
  b.type(b.$('tab-link'), 'https://docs.google.com/spreadsheets/d/' + SID + '/edit?gid=42#gid=42', { change: false });
  b.key(b.$('tab-link'), 'Enter');
  await b.flush();
  assert.equal(b.rows().length, 2);
});

test('any change after a successful check needs a new check before saving', async () => {
  const b = await openSettings({ github: githubOk() });
  b.type(b.$('school-code'), 'KES');
  await b.check();
  assert.match(b.text('check-status'), /no problems\. You can save these settings\./);
  b.type(b.$('aliases-url'), 'other.json');
  assert.equal(b.text('check-status'), 'The settings changed after the check. Check the list again before saving.');
  assert.ok(b.$('check-results').classList.contains('stale'));
  b.type(b.$('aliases-url'), 'aliases.json');
  b.type(b.$('token'), TOKEN, { change: false });
  await b.save();
  assert.equal(b.text('save-status'), 'Check the list first: saving needs a successful check of exactly these settings.');
  assert.equal(b.ghCalls().length, 0);
  await b.check();
  await b.save();
  assert.match(b.text('save-status'), /^Saved to branch main/);
});

test('a failed check lists the problems and blocks saving', async () => {
  const b = await openSettings({ github: githubOk() });
  b.state.sheet = () => new Response('<!doctype html><html><body>Sign in</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  b.type(b.$('school-code'), 'KES');
  await b.check();
  assert.equal(b.text('check-status'), "The check found a problem, so these settings can't be saved yet.");
  assert.match(b.$('check-results').querySelector('.check-problems').textContent, /Sheet1: Got a web page instead of the list: the sheet may not be shared by link\./);
  b.type(b.$('token'), TOKEN, { change: false });
  await b.save();
  assert.match(b.text('save-status'), /^Check the list first/);
  assert.equal(b.ghCalls().length, 0);

  // A tab with a header but no items is a problem too.
  b.state.sheet = () => csv([]);
  await b.check();
  assert.match(b.text('check-results'), /Sheet1: no items below the header row\./);
  assert.equal(b.text('check-status'), "The check found a problem, so these settings can't be saved yet.");
});

test('the Apps Script check, including a script that reads a different spreadsheet from the sheet link', async () => {
  const fixture = JSON.parse(read('test/fixtures/script-response.json'));
  const b = await openSettings({ github: githubOk() });
  b.state.script = u => new Response(JSON.stringify(Object.assign({}, fixture, { spreadsheetId: SID })), { status: 200, headers: { 'content-type': 'application/json' } });
  b.click(b.$('mode-script'));
  await b.flush();
  assert.equal(b.$('tabs-fieldset').hidden, true);
  b.type(b.$('script-url'), 'https://script.google.com/macros/s/AKfycbx_Example-Deployment_0123456789abcdef/exec');
  await b.check();
  assert.match(b.text('check-status'), /^Checked at \d\d:\d\d: 1 tab, 8 items, no problems\./);
  assert.match(b.text('check-results'), /Read through the Apps Script web app, from spreadsheet 1AbCdE…abcd\./);
  const scriptCall = b.fetchCalls.find(c => c.url.startsWith('https://script.google.com/'));
  assert.equal(scriptCall.url, SCRIPT_URL, 'no ?gid=: the script decides the tabs');
  assert.match(b.text('diff-summary'), /1 line removed, 1 line added/);

  b.state.script = () => new Response(JSON.stringify(Object.assign({}, fixture, { spreadsheetId: SID2 })), { status: 200, headers: { 'content-type': 'application/json' } });
  await b.check();
  assert.match(b.text('check-results'), /The script reads a different spreadsheet \(1ZyXwV…wxyz\) from the one in the sheet link \(1AbCdE…abcd\)\. Make the sheet link point/);
});

test('saving: config.js changed on GitHub stops the save and keeps the token; a refused token is marked on its field', async () => {
  const b = await openSettings({ github: Object.assign(githubOk(), { 'GET /contents/config.js?ref=main': () => CONTENTS(PAGE_TEXT.replace("'UAS'", "'ABC'")) }) });
  b.type(b.$('school-code'), 'KES');
  await b.check();
  b.type(b.$('token'), TOKEN, { change: false });
  await b.save();
  assert.equal(b.text('save-status'), S.githubMessages.changed);
  assert.equal(b.$('token').value, TOKEN);
  assert.equal(b.ghCalls().filter(c => c.init.method === 'PUT').length, 0);

  b.state.github['GET /pages'] = () => json(401, { message: 'Bad credentials' });
  b.submit(b.$('save-form'));   // Enter in the token field
  await b.flush();
  assert.equal(b.text('save-status'), S.githubMessages.auth);
  assert.equal(b.text('token-error'), S.githubMessages.auth);
  assert.equal(b.$('token').getAttribute('aria-invalid'), 'true');
  assert.equal(b.$('token').getAttribute('aria-describedby'), 'token-help token-error');
  assert.equal(b.focused(), b.$('token'));
  assert.ok(!b.everything().includes(TOKEN));
});

test('saving with no token, or with nothing changed, says so and calls nobody', async () => {
  const b = await openSettings({ github: githubOk() });
  await b.check();
  await b.save();
  assert.equal(b.text('save-status'), 'Nothing to save: these settings are already in config.js.');
  b.type(b.$('school-code'), 'KES');
  await b.check();
  await b.save();
  assert.equal(b.text('save-status'), 'Paste a GitHub token first.');
  assert.equal(b.text('token-error'), S.githubMessages.noToken);
  assert.equal(b.focused(), b.$('token'));
  assert.equal(b.ghCalls().length, 0);
});

test('a stale cached config.js: the page reads the served file again and starts from it', async () => {
  const newer = S.buildConfigJs(Object.assign({}, PAGE_CFG, { schoolCode: 'NEW' }));
  const b = await openSettings({ tag: PAGE_TEXT, served: newer });
  assert.equal(b.scriptLoads.length, 1);
  assert.match(b.scriptLoads[0], /^config\.js\?fresh=\d+$/);
  assert.equal(b.$('school-code').value, 'NEW');
  assert.match(b.text('current-list'), /School's Banned By codeNEW\./);
  assert.equal(b.text('diff-summary'), 'No changes yet: these are the settings in config.js.');
  assert.equal(b.$('current-note').hidden, true);
  assert.equal(b.doc.querySelectorAll('script').length, 3, 'the extra script element is removed again');
});

test('a hand-edited config.js: a note, and the diff shows the layout change', async () => {
  const hand = PAGE_TEXT.replace('window.CENSORSEARCH_CONFIG = {', '// edited by hand\nwindow.CENSORSEARCH_CONFIG = {');
  const b = await openSettings({ served: hand });
  assert.equal(b.$('current-note').hidden, false);
  assert.match(b.text('current-note'), /edited by hand/);
  assert.equal(b.text('diff-summary'), 'Changes to config.js: 1 line removed, 0 lines added.');
});

test("config.js that can't be read: saving is off, with a plain message", async () => {
  const b = makeBrowser({ page: 'settings.html', scripts: { 'config.js': PAGE_TEXT }, fetch: async () => new Response('', { status: 500 }) });
  b.start();
  await b.flush();
  assert.match(b.text('page-status'), /Couldn't read config\.js from this site just now, so saving is off/);
  assert.equal(b.$('settings-form').hidden, false);
  assert.match(b.text('diff-summary'), /couldn't be read when the page loaded/);
});

test('trusted script addresses can be swapped for their codes', async () => {
  const b = await openSettings();
  b.$('advanced').open = true;
  b.type(b.$('trusted-scripts'), 'ab'.repeat(32) + '\n' + SCRIPT_URL);
  const note = b.$('trusted-scripts-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /Line 2 is a script address, which config\.js would show to anyone/);
  b.click(note.querySelector('button'));
  await b.flush();
  const code = nodeCrypto.createHash('sha256').update(SCRIPT_URL).digest('hex');
  assert.equal(b.$('trusted-scripts').value, 'ab'.repeat(32) + '\n' + code);
  assert.equal(note.hidden, true);
  // Without crypto.subtle (plain http) the note stays, without the button.
  const c = await openSettings({ crypto: null });
  c.type(c.$('trusted-scripts'), SCRIPT_URL);
  assert.equal(c.$('trusted-scripts-note').querySelector('button'), null);
});

// ------------------------------------------------------------------------------------------------
// Review findings on the page

const CONFIG_URL = 'https://school.example/censorsearch/config.js';

test('the publish check reads config.js where and how the search page loads it, so this browser gets the new copy (GH1)', async () => {
  let putBody = null;
  const b = await openSettings({ github: githubOk(init => { putBody = JSON.parse(init.body); }) });
  b.state.live = n => (n >= 2 ? Buffer.from(putBody.content, 'base64').toString('utf8') : PAGE_TEXT);
  b.type(b.$('school-code'), 'KES');
  await b.check();
  b.type(b.$('token'), TOKEN, { change: false });
  await b.save();
  await b.advance(20000);
  assert.equal(b.text('publish-status'), S.LIVE_TEXT);
  // The page's own read and both polls: the plain address, past the cache and refreshing it (not no-store, which
  // would leave the copy the search page's <script src="config.js"> uses as it was).
  const reads = b.fetchCalls.filter(c => c.url.startsWith('https://school.example/censorsearch/config.js'));
  assert.deepEqual(reads.map(c => [c.url, c.init.cache, c.init.credentials]), [[CONFIG_URL, 'reload', 'same-origin'], [CONFIG_URL, 'reload', 'same-origin'], [CONFIG_URL, 'reload', 'same-origin']]);
  // What "Live" promises: this browser now, others after up to 10 minutes or a hard reload; not "until they reload".
  assert.doesNotMatch(S.LIVE_TEXT, /until they reload/);
  assert.match(S.LIVE_TEXT, /In this browser the search page shows the new settings/);
  assert.match(S.LIVE_TEXT, /up to 10 more minutes, even after a normal reload; a hard reload \(Ctrl\+Shift\+R/);
  assert.match(read('README.md'), /even after a normal reload, because GitHub Pages lets browsers keep config\.js for 10 minutes; a hard reload/);
});

test('saving without Pages: Read stops with a plain message; a save to the default branch that never goes live says why it may not (GH2)', async () => {
  const denied = await openSettings({ github: Object.assign(githubOk(), { 'GET /pages': () => json(403, { message: 'Resource not accessible by personal access token' }) }) });
  denied.type(denied.$('school-code'), 'KES');
  await denied.check();
  denied.type(denied.$('token'), TOKEN, { change: false });
  await denied.save();
  assert.match(denied.text('save-status'), /^The token can't read the repository's GitHub Pages settings/);
  assert.equal(denied.ghCalls().length, 1, 'no PUT');
  assert.equal(denied.$('token').value, TOKEN, 'token kept for another try');
  assert.match(read('settings.html'), /Contents: Read and write, and Pages: Read-only, so this page can find the branch GitHub Pages publishes\./);
  assert.match(read('README.md'), /Contents: \*\*Read and write\*\*, and Pages: \*\*Read-only\*\*/);

  const github = Object.assign(githubOk(), { 'GET /pages': () => json(404, { message: 'Not Found' }), 'GET ': () => json(200, { default_branch: 'main' }) });
  const b = await openSettings({ github, live: () => PAGE_TEXT });
  b.type(b.$('school-code'), 'KES');
  await b.check();
  b.type(b.$('token'), TOKEN, { change: false });
  await b.save();
  assert.equal(b.text('save-status'), 'Saved to the default branch of school-org/censorsearch, main, because it has no GitHub Pages site.');
  await b.advance(5 * 60000 + 5000);
  assert.equal(b.text('publish-status'), "It's taking longer than usual: it may take a few more minutes. See GitHub's publishing progress. " +
    "This page saved to the default branch, main: if the site is published from another branch, the change won't go live until config.js is changed there too.");
});

test('typing a sheet link key by key into an empty tab list ends with the whole tab id (BRW-1)', async () => {
  const b = await openSettings();
  b.click(b.rows()[0].querySelector('.tab-remove'));
  await b.flush();
  const sheet = b.$('sheet-url');
  const link = 'https://docs.google.com/spreadsheets/d/' + SID + '/edit#gid=1111920478';
  for (let i = 1; i <= link.length; i++) b.type(sheet, link.slice(0, i), { change: false });   // one input event per key
  sheet.dispatchEvent({ type: 'change', bubbles: true });
  assert.deepEqual(b.rows().map(r => r.querySelector('.gid-input').value), ['1111920478']);
  assert.equal(b.text('tab-link-note'), 'Tab id 1111920478 from the sheet link is now in the tab list. Give it a name.');
  assert.equal(b.$('sheet-url-hint').hidden, true, 'no offer to add the tab that is already there');
  // Once the maintainer changes that tab id, the sheet link no longer overwrites it; it offers the other tab instead.
  const gid = b.rows()[0].querySelector('.gid-input');
  b.type(gid, '5');
  b.type(sheet, link.replace('1111920478', '42'), { change: false });
  assert.equal(gid.value, '5');
  assert.equal(b.rows().length, 1);
  assert.match(b.text('sheet-url-hint'), /opens the tab with id 42, which isn't in the tab list/);
});

test('styles.css: a field marked invalid gets the warning border, whatever its type (BRW-2)', () => {
  // The rules that set a border colour, in order, with their specificity: the one that wins for an invalid field
  // must give it var(--warn-border).
  const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(m => ({ sels: m[1].split(',').map(x => x.trim()), body: m[2] }));
  const spec = sel => {
    const noAttr = sel.replace(/\[[^\]]*\]/g, '[]');
    return [(noAttr.match(/#/g) || []).length, (noAttr.match(/\.|\[\]|:(?!:)/g) || []).length, (noAttr.replace(/:[\w-]+/g, '').match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length];
  };
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const b = makeBrowser({ page: 'settings.html' });
  for (const id of ['school-code', 'sheet-url', 'aliases-url', 'trusted-scripts', 'token']) {
    const field = b.$(id);
    field.setAttribute('aria-invalid', 'true');
    let win = null;
    rules.forEach((r, order) => {
      const color = (r.body.match(/(?:^|;)\s*border(?:-color)?\s*:\s*([^;]+)/) || [])[1];
      if (!color) return;
      for (const sel of r.sels) {
        let hit = false;
        try { hit = field.matches(sel); } catch (e) { hit = false; }   // :focus and the like: not in this state
        if (!hit) continue;
        const s = spec(sel);
        if (!win || cmp(s, win.s) > 0 || (cmp(s, win.s) === 0 && order >= win.order)) win = { s, order, color, sel };
      }
    });
    assert.ok(win, id);
    assert.match(win.color, /var\(--warn-border\)/, '#' + id + ' is styled by ' + win.sel);
  }
});

test('the page refuses a second tab with the same name (BRW-3)', async () => {
  const b = await openSettings();
  b.click(b.$('tab-add'));
  await b.flush();
  const row = b.rows()[1];
  b.type(row.querySelector('.gid-input'), '1111920478');
  b.type(row.querySelector('.name-input'), 'Sheet1');
  assert.equal(row.querySelectorAll('.field-error')[1].textContent, S.messages.nameTaken);
  await b.check();
  assert.equal(b.text('check-status'), 'Fix the problem marked above, then check again.');
  assert.equal(b.googleCalls().length, 0);
});

test('the check reads the alias list and counts the school code; a list it can\'t read or an unused code is a warning, not a problem (BRW-4)', async () => {
  const entries = JSON.parse(read('aliases.json')).aliases.length;
  const b = await openSettings({ github: githubOk() });
  await b.check();
  assert.match(b.text('check-results'), new RegExp('Alias list aliases\\.json: ' + entries + ' entries\\.'));
  assert.match(b.text('check-results'), /The school's code, UAS, is in the Banned By column of 1 item\./);
  assert.equal(b.$('check-results').querySelector('.check-warnings'), null);
  const aliasCall = b.fetchCalls.find(c => c.url === 'https://school.example/censorsearch/aliases.json');
  assert.deepEqual([aliasCall.init.cache, aliasCall.init.credentials], ['no-store', 'same-origin']);

  b.$('advanced').open = true;
  b.type(b.$('aliases-url'), 'aliasez.json');
  await b.check();
  assert.match(b.text('check-status'), /^Checked at \d\d:\d\d: 1 tab, 4 items, no problems, 1 warning \(see below\)\. You can save these settings\.$/);
  const warnings = () => b.$('check-results').querySelector('.check-warnings').textContent;
  assert.match(warnings(), /The alias list aliasez\.json isn't on this site \(HTTP 404\), so the search page would search without aliases\. Check Alias list under Advanced\./);

  b.state.aliases = () => jsonFile(200, '{"names": []}');
  await b.check();
  assert.match(warnings(), /The alias list aliasez\.json isn't an alias file \(it has no "aliases" list\)/);

  b.state.aliases = () => { throw new TypeError('Failed to fetch'); };
  b.type(b.$('aliases-url'), 'aliases.json');
  b.type(b.$('school-code'), 'UAS4');
  await b.check();
  assert.match(b.text('check-status'), /no problems, 2 warnings \(see below\)/);
  assert.match(warnings(), /No item has the school's code, UAS4, in its Banned By column, so no result would show "Banned by UAS4"\./);
  assert.match(warnings(), /The alias list aliases\.json couldn't be read/);
  // Warnings don't stop saving.
  b.type(b.$('token'), TOKEN, { change: false });
  await b.save();
  assert.match(b.text('save-status'), /^Saved to branch main/);
});

test('the check shows the tab name Google gives when the settings call the tab something else (sec-3)', async () => {
  const b = await openSettings();
  const gid = b.rows()[0].querySelector('.gid-input');
  b.type(gid, '1111920478');   // the Other Materials tab, still named Sheet1
  await b.check();
  const box = b.$('check-results').querySelector('section.check-tab');
  assert.equal(box.querySelector('h3').textContent, 'Sheet1 (tab id 1111920478, named "Other Materials" in the sheet)');
  assert.match(b.text('check-status'), /no problems, 1 warning \(see below\)/);
  assert.match(b.$('check-results').querySelector('.check-warnings').textContent,
    /Tab id 1111920478 is named "Other Materials" in the sheet, but these settings call it "Sheet1"\. Check the tab id, and the name results cite it by\./);
  b.type(b.rows()[0].querySelector('.name-input'), 'Other Materials');
  await b.check();
  assert.equal(b.$('check-results').querySelector('section.check-tab h3').textContent, 'Other Materials (tab id 1111920478)');
  assert.equal(b.$('check-results').querySelector('.check-warnings'), null);
  // CensorSheet.load keeps Google's name beside a configured one (cut at its last " - ", so a name ending the
  // configured one matches).
  const load = (name, file) => Sheet.load({ kind: 'csv', sheetId: SID, tabs: [{ gid: '5', name }] }, { fetch: async () => csv(ROWS1, file) });
  const res = await load('Configured', 'Other Materials');
  assert.deepEqual([res.tabs[0].tab, res.tabs[0].sheetTabName], ['Configured', 'Other Materials']);
  const cut = await openSettings({ sheet: () => csv(ROWS0, 'Ministry - 2024') });
  cut.type(cut.rows()[0].querySelector('.name-input'), 'Ministry - 2024');
  await cut.check();
  assert.equal(cut.$('check-results').querySelector('.check-warnings'), null);
});

test('buildConfigJs and the page keep a switched-off alias list off, and flag other settings saving would change (GH6)', async () => {
  const hand = PAGE_TEXT.replace("aliasesUrl: 'aliases.json',", 'aliasesUrl: null,') +
    'window.CENSORSEARCH_CONFIG.pattern = /x/;\nwindow.CENSORSEARCH_CONFIG.count = NaN;\nwindow.CENSORSEARCH_CONFIG.label = "kept";\n';
  const b = await openSettings({ served: hand });
  assert.equal(b.$('aliases-url').value, '', 'no alias list, as on the search page');
  const cur = b.text('current-list');
  assert.match(cur, /Alias listNone\./);
  assert.match(cur, /Other settings, kept as they arelabel\./);
  assert.match(cur, /Other settings that saving changespattern and count: this page can't write their values as they are, so saving drops or changes them\. To keep them, edit config\.js by hand instead\./);
  b.type(b.$('school-code'), 'KES');
  const added = b.$('diff').querySelectorAll('ins').map(e => e.textContent).join('\n');
  assert.match(added, /aliasesUrl: '',/);
  assert.doesNotMatch(added, /aliases\.json/);
  assert.equal(S.buildConfigJs(Object.assign(repoCfg(), { list: [1, 'a', null, { b: true }] })).includes('  list: [1,"a",null,{"b":true}],'), true);
});

test('the changes summary asks to finish the settings when nothing is marked yet (BRW-6)', async () => {
  const b = await openSettings();
  b.click(b.$('tab-add'));
  await b.flush();
  assert.equal(b.text('diff-summary'), 'Finish the settings above to see the changes to config.js.');
  b.type(b.rows()[1].querySelector('.gid-input'), 'x');
  assert.equal(b.text('diff-summary'), 'Fix the problems marked above to see the changes to config.js.');
  const c = await openSettings();
  c.click(c.$('mode-script'));
  await c.flush();
  assert.equal(c.text('diff-summary'), 'Finish the settings above to see the changes to config.js.');
});

test('an "Add a tab from its link" error is announced again when Enter is pressed again (BRW-7)', async () => {
  const b = await openSettings();
  const error = b.$('tab-link-error');
  assert.equal(error.getAttribute('role'), 'alert');
  b.type(b.$('tab-link'), 'https://example.com/foo', { change: false });
  b.$('tab-link').focus();
  b.key(b.$('tab-link'), 'Enter');
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, S.messages.sheetBad);
  const first = error.firstChild;
  b.key(b.$('tab-link'), 'Enter');
  assert.equal(error.textContent, S.messages.sheetBad);
  assert.notEqual(error.firstChild, first, 'written afresh');
  assert.equal(b.focused(), b.$('tab-link'));
});

test('after a save the check status no longer invites saving (BRW-9)', async () => {
  const b = await openSettings({ github: githubOk() });
  b.type(b.$('school-code'), 'KES');
  await b.check();
  assert.match(b.text('check-status'), /You can save these settings\.$/);
  b.type(b.$('token'), TOKEN, { change: false });
  await b.save();
  assert.match(b.text('save-status'), /^Saved to branch main/);
  assert.match(b.text('check-status'), /^Checked at \d\d:\d\d: 1 tab, 4 items, no problems\. These are the settings now in config\.js\.$/);
});

test('a failed check is marked out of date once the settings change (BRW-10)', async () => {
  const b = await openSettings();
  const gid = b.rows()[0].querySelector('.gid-input');
  b.type(gid, '555');
  await b.check();
  assert.equal(b.text('check-status'), "The check found a problem, so these settings can't be saved yet.");
  assert.equal(b.$('check-results').classList.contains('stale'), false);
  b.type(gid, '0');
  assert.equal(b.text('check-status'), 'The settings changed after the check. Check the list again before saving.');
  assert.equal(b.$('check-results').classList.contains('stale'), true);
});

test('the note under "Add a tab from its link" goes once the tab it names is gone (BRW-11)', async () => {
  const b = await openSettings();
  b.type(b.$('tab-link'), 'https://docs.google.com/spreadsheets/d/' + SID + '/edit#gid=777', { change: false });
  b.key(b.$('tab-link'), 'Enter');
  await b.flush();
  assert.equal(b.text('tab-link-note'), 'Added tab id 777. Give it a name.');
  b.type(b.rows()[1].querySelector('.name-input'), 'Seven');
  assert.equal(b.text('tab-link-note'), 'Added tab id 777. Give it a name.', 'kept while the tab is there');
  b.click(b.rows()[1].querySelector('.tab-remove'));
  await b.flush();
  assert.equal(b.text('tab-link-note'), '');
  // The note about a tab from the sheet link goes when the sheet link stops opening that tab.
  b.click(b.rows()[0].querySelector('.tab-remove'));
  await b.flush();
  b.type(b.$('sheet-url'), 'https://docs.google.com/spreadsheets/d/' + SID + '/edit#gid=77', { change: false });
  assert.match(b.text('tab-link-note'), /^Tab id 77 from the sheet link/);
  b.type(b.$('sheet-url'), 'https://docs.google.com/spreadsheets/d/' + SID + '/edit', { change: false });
  assert.equal(b.text('tab-link-note'), '');
  assert.deepEqual(b.rows().map(r => r.querySelector('.gid-input').value), ['77'], 'the tab itself stays');
});
