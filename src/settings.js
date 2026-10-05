// CensorSettings: the settings page (settings.html). It edits config.js through the GitHub REST API with a fine-grained
// personal access token that the maintainer pastes for each save. Pure helpers (the config.js text, validation, the
// line diff, base64, the GitHub save) are exported for tests: module.exports in Node, window.CensorSettings in the
// browser, where the page wiring also starts.
//
// Safety rules kept throughout: text reaches the page only as text nodes (textContent / append(string)); links are made
// only from https URLs; no storage APIs, no eval, and no data in page addresses. The token lives only in its password
// field and in the call that saves: it never goes into a URL, the console, page text or a message, and the field is
// cleared once the save succeeds.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./sheet.js'), require('./signin.js'));
  } else {
    root.CensorSettings = factory(root.CensorSheet, root.CensorSignIn);
    if (root.document) root.CensorSettings.start(root);
  }
})(typeof self !== 'undefined' ? self : this, function (Sheet, SignIn) {
  'use strict';

  const str = v => (v == null ? '' : String(v));
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const own = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
  const hex4 = c => c.toString(16).toUpperCase().padStart(4, '0');

  // ---------------------------------------------------------------------------------------------
  // config.js text. buildConfigJs writes the file in exactly the repository's layout and comments, so a config that
  // came from it (or from the repository's own config.js) comes back byte for byte.

  const KNOWN_KEYS = ['sheetUrl', 'tabs', 'googleClientId', 'scriptUrl', 'trustedScripts', 'schoolCode', 'aliasesUrl', 'repoUrl'];
  const DEFAULTS = { sheetUrl: '', tabs: [], googleClientId: '', scriptUrl: '', trustedScripts: [], schoolCode: 'UAS', aliasesUrl: 'aliases.json', repoUrl: '' };
  const TABS_COMMENT_COLUMN = 48;
  // Written after the tabs only while they are still v1's (the test sheet's main tab), which the comment is about.
  const TABS_COMMENT = "// v1: main tab only; add { gid: '1111920478', name: 'Other Materials' } to search it too";
  const V1_SHEET_ID = '1fnfj7W8ZZvBSFNTfkyqPKupGUrvw79etZYF_ZHWVhzo';
  const COMMENTS = {
    header: [
      '// CensorSearch settings. This is the only file to edit when pointing the page at another sheet.',
      '// Anyone can also try another sheet without editing it: add ?sheet=<Google Sheets link> or ?script=<Apps Script /exec link>',
      '// to the page address. The search text itself never goes into the address.',
    ],
    sheetUrl: [
      '  // The Google Sheet. Read by link (the default path), it must be shared "Anyone with the link can view"; signed in (see',
      '  // googleClientId), each visitor reads it with their own Google account instead.',
    ],
    tabs: ["  // Tabs to search, by tab id (the number after gid= in the tab's link), which survives renames; `name` is how results cite the tab."],
    googleClientId: [
      '  // Google sign-in: the OAuth client ID (…apps.googleusercontent.com; public, not a secret). When set, each visitor signs in',
      "  // with Google and the page reads sheetUrl's tabs with their own access, so only people who can view the sheet can search it.",
      '  // It takes precedence over scriptUrl. Setting it up: README.md, "Signing in".',
    ],
    scriptUrl: [
      '  // Apps Script web app URL (https://script.google.com/macros/s/<id>/exec). When set, the page reads through it instead of the CSV',
      "  // link above, and the script's own tab list decides which tabs are searched (see apps-script/README.md). sheetUrl should",
      '  // then still name the same sheet: it is the "Open the sheet" link when the script can\'t be reached.',
    ],
    trustedScripts: [
      "  // The school's own Apps Script, when it is shared as a ?script= link instead of scriptUrl (keeping its address out of this",
      '  // public file): list the code the page shows under "Notes for the list\'s maintainers" when opened with that link. Any other',
      '  // ?script= link is marked on the page as not its usual list, with no links to the sheet it claims to read.',
    ],
    // The code goes into the comment only when it is plain letters, digits, spaces, dots, dashes or underscores.
    schoolCode: code => [/^[\p{L}\p{N} ._-]{1,20}$/u.test(str(code))
      ? '  // This school\'s own code in the Banned By column; rows with it show "Banned by ' + code + '".'
      : '  // This school\'s own code in the Banned By column; rows with it show "Banned by" and the code.'],
    aliasesUrl: ['  // The alias list (pen names, acronyms, alternate titles), fetched from the same site as the page.'],
    repoUrl: ["  // Where the page's source code lives; linked in the footer."],
  };

  // Written as escapes: control characters, line and paragraph separators (they end a line in JavaScript), and
  // invisible or direction-changing characters that would make the file read differently from what it does.
  const ESCAPED = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;
  const ESCAPED_ALL = new RegExp(ESCAPED.source, 'g');

  // A single-quoted JavaScript string literal that evaluates back to exactly `value`, whatever it holds.
  function jsString(value) {
    const s = str(value);
    let out = "'";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i], c = s.charCodeAt(i);
      if (ch === '\\') out += '\\\\';
      else if (ch === "'") out += "\\'";
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch === '<' && (s[i + 1] === '/' || s.startsWith('<!--', i))) out += '\\x3C';
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
        out += ch + s[i + 1];
        i++;
      } else if ((c >= 0xd800 && c <= 0xdfff) || ESCAPED.test(ch)) out += '\\u' + hex4(c);   // lone surrogates too
      else out += ch;
    }
    return out + "'";
  }

  // JSON for a setting this page doesn't know (kept as it is). JSON already escapes control characters and lone
  // surrogates; the rest of ESCAPED and "</" can only occur inside its strings, where an escape means the same.
  function jsonValue(value) {
    let j;
    try { j = JSON.stringify(value); } catch (e) { return null; }
    if (typeof j !== 'string') return null;
    return j.replace(ESCAPED_ALL, c => '\\u' + hex4(c.charCodeAt(0))).replace(/<(?=\/|!--)/g, '\\u003C');
  }

  const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const keyText = k => (IDENT.test(k) ? k : jsonValue(k));

  const tabsText = tabs => '[' + (Array.isArray(tabs) ? tabs : [])
    .filter(t => t && typeof t === 'object')
    .map(t => '{ gid: ' + jsString(t.gid) + (t.name != null ? ', name: ' + jsString(t.name) : '') + ' }')
    .join(', ') + ']';

  const listText = list => '[' + (Array.isArray(list) ? list : list ? [list] : []).map(jsString).join(', ') + ']';

  // The alias list the search page uses: aliases.json when the setting is missing, none when it is set but empty
  // (null, '', false), as app.js reads it.
  const aliasesOf = c => (!own(c, 'aliasesUrl') ? DEFAULTS.aliasesUrl : c.aliasesUrl ? c.aliasesUrl : '');

  function buildConfigJs(cfg) {
    const c = isObj(cfg) ? cfg : {};
    const get = k => (k === 'aliasesUrl' ? aliasesOf(c) : own(c, k) && c[k] != null ? c[k] : DEFAULTS[k]);
    const out = COMMENTS.header.slice();
    out.push('window.CENSORSEARCH_CONFIG = {');
    out.push(...COMMENTS.sheetUrl, '  sheetUrl: ' + jsString(get('sheetUrl')) + ',');
    out.push(...COMMENTS.tabs);
    const tabs = tabsText(get('tabs'));
    const sheet = Sheet.parseSheetUrl(str(get('sheetUrl')));
    const tabsLine = '  tabs: ' + tabs + ',';
    out.push(tabs === "[{ gid: '0', name: 'Sheet1' }]" && sheet && sheet.id === V1_SHEET_ID
      ? tabsLine + ' '.repeat(Math.max(2, TABS_COMMENT_COLUMN - tabsLine.length)) + TABS_COMMENT
      : tabsLine);
    out.push(...COMMENTS.googleClientId, '  googleClientId: ' + jsString(get('googleClientId')) + ',');
    out.push(...COMMENTS.scriptUrl, '  scriptUrl: ' + jsString(get('scriptUrl')) + ',');
    out.push(...COMMENTS.trustedScripts, '  trustedScripts: ' + listText(get('trustedScripts')) + ',');
    out.push(...COMMENTS.schoolCode(get('schoolCode')), '  schoolCode: ' + jsString(get('schoolCode')) + ',');
    out.push(...COMMENTS.aliasesUrl, '  aliasesUrl: ' + jsString(get('aliasesUrl')) + ',');
    out.push(...COMMENTS.repoUrl, '  repoUrl: ' + jsString(get('repoUrl')) + ',');
    for (const k of Object.keys(c)) {
      if (KNOWN_KEYS.includes(k) || k === '__proto__') continue;
      const v = jsonValue(c[k]);
      if (v != null) out.push('  ' + keyText(k) + ': ' + v + ',');
    }
    out.push('};', '');
    return out.join('\n');
  }

  // Settings in a config object that this page doesn't edit; they are kept as they are.
  const extraKeys = cfg => (isObj(cfg) ? Object.keys(cfg).filter(k => !KNOWN_KEYS.includes(k) && k !== '__proto__') : []);

  // Whether a value comes back the same from the JSON buildConfigJs writes for it. Functions, undefined, NaN, regular
  // expressions, dates and the like don't (they are dropped or changed), and neither does a nested "__proto__" key.
  function roundTrips(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0);
    if (Array.isArray(v)) return Array.from(v).every(roundTrips);
    if (typeof v !== 'object') return false;
    const proto = Object.getPrototypeOf(v);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) return false;   // plain objects only (from any realm)
    if (typeof v.toJSON === 'function') return false;
    return Object.keys(v).every(k => k !== '__proto__' && roundTrips(v[k]));
  }

  // ---------------------------------------------------------------------------------------------
  // Validation: form values -> { cfg, errors }. Errors are { field, message } with field one of mode, sheetUrl, tabs,
  // tabs.<i>.gid, tabs.<i>.name, googleClientId, scriptUrl, schoolCode, trustedScripts, aliasesUrl, repoUrl (in the form's order).

  const GID_RE = /^\d{1,12}$/;
  const HEX64_RE = /^[0-9a-f]{64}$/i;
  const CODE_RE = /^[\p{L}\p{N} ._-]{1,20}$/u;
  const PATH_RE = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)*$/;
  const NAME_MAX = 100;

  const MSG = {
    mode: 'Choose how the page reads the list.',
    sheetMissing: "Paste the sheet's link. It starts with https://docs.google.com/spreadsheets/d/.",
    sheetBad: "This isn't a Google Sheets link. Open the sheet and copy the address from the browser's address bar: it starts with https://docs.google.com/spreadsheets/d/.",
    sheetPublished: 'This is a "Publish to the web" link. Use the sheet\'s own link instead: open the sheet and copy the address from the address bar.',
    tabsMissing: 'Add at least one tab to search.',
    gidMissing: "Enter the tab id: the number after gid= in the tab's link.",
    gidBad: "A tab id is digits only, such as 0 or 1111920478: the number after gid= in the tab's link.",
    nameMissing: 'Give the tab a name: results say which tab they come from by this name.',
    nameControl: "The name can't contain line breaks or other control characters.",
    nameTaken: 'Another tab already has this name. Results say which tab they come from by its name, so give each tab its own.',
    clientMissing: "Paste the sign-in client ID from the Google Cloud console (Clients). It ends in .apps.googleusercontent.com.",
    clientBad: "This isn't a Google sign-in client ID. It looks like 123456789012-abc….apps.googleusercontent.com: copy the Client ID from the Google Cloud console, under Clients.",
    clientSecret: "This is the client secret, which must stay private: don't save it here or share it. Paste the Client ID instead, which ends in .apps.googleusercontent.com.",
    scriptMissing: "Paste the script's Web app URL. It ends in /exec.",
    scriptBad: "This isn't an Apps Script web app address. It looks like https://script.google.com/macros/s/…/exec: copy the Web app URL from Deploy, Manage deployments.",
    scriptDev: "This is the script's test address (it ends in /dev), which works only for the script's editors. Use the Web app URL that ends in /exec.",
    scriptEditor: "This is the script editor's address. Use the Web app URL from Deploy, Manage deployments: it ends in /exec.",
    codeMissing: "Enter the school's code as written in the Banned By column, such as UAS.",
    codeBad: 'Use 1 to 20 letters, digits, spaces, dots, dashes or underscores, as written in the Banned By column.',
    aliasesBad: 'Give a file on this site, such as aliases.json: a path without https:// or a leading slash.',
    repoMissing: "Give the repository's address, such as https://github.com/owner/repo. Saving needs it.",
    repoBad: "This isn't a GitHub repository address. It looks like https://github.com/owner/repo.",
  };

  function sheetLinkProblem(s) {
    return /\/spreadsheets\/(?:u\/\d+\/)?d\/e\//.test(s) ? MSG.sheetPublished : MSG.sheetBad;
  }

  function scriptProblem(s) {
    if (/script\.google\.com\/.*\/dev\/?(?:[?#].*)?$/.test(s)) return MSG.scriptDev;
    if (/script\.google\.com\/(?:home|d)\//.test(s)) return MSG.scriptEditor;
    return MSG.scriptBad;
  }

  // https://github.com/<owner>/<repo> (a trailing slash or .git is fine) -> { owner, repo, url }, else null.
  function parseRepoUrl(u) {
    if (typeof u !== 'string') return null;
    let url;
    try { url = new URL(u.trim()); } catch (e) { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) return null;
    const m = url.pathname.replace(/\/$/, '').match(/^\/([^/]+)\/([^/]+)$/);
    if (!m) return null;
    const owner = m[1], repo = m[2].replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return null;
    return { owner, repo, url: 'https://github.com/' + owner + '/' + repo };
  }

  const sameAs = (orig, input) => typeof orig === 'string' && orig.trim() === input;
  const listWords = items => (items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);

  function copyTabs(tabs) {
    return (Array.isArray(tabs) ? tabs : []).filter(t => t && typeof t === 'object')
      .map(t => (t.name != null ? { gid: str(t.gid), name: str(t.name) } : { gid: str(t.gid) }));
  }

  // form: { mode: 'link'|'signin'|'script', sheetUrl, tabs: [{ gid, name }], googleClientId, scriptUrl, schoolCode,
  // trustedScripts (text, one per line, or a list), aliasesUrl, repoUrl, extra (settings kept as they are), original (the
  // config being edited) }.
  // A value typed exactly as it is in the original is kept as written there; a new one is written in its plain form.
  function validate(form) {
    const f = form || {};
    const orig = isObj(f.original) ? f.original : {};
    const errors = [];
    const err = (field, message) => errors.push({ field, message });
    const mode = f.mode === 'script' || f.mode === 'link' || f.mode === 'signin' ? f.mode : null;
    if (!mode) err('mode', MSG.mode);

    // Sheet link: needed to read by link or signed in; through the script it is the "Open the sheet" link.
    const sheetIn = str(f.sheetUrl).trim();
    let sheetUrl = '';
    if (sheetIn) {
      const p = Sheet.parseSheetUrl(sheetIn);
      if (!p) err('sheetUrl', sheetLinkProblem(sheetIn));
      else sheetUrl = sameAs(orig.sheetUrl, sheetIn) ? orig.sheetUrl : Sheet.sheetUrl(p.id, p.gid);
    } else if (mode !== 'script') err('sheetUrl', MSG.sheetMissing);

    // Tabs: through the script, its own tab list decides, so the configured tabs are kept as they are.
    let tabs;
    if (mode === 'script') tabs = copyTabs(orig.tabs);
    else {
      tabs = [];
      const rows = Array.isArray(f.tabs) ? f.tabs : [];
      const seen = new Set(), names = new Set();
      rows.forEach((t, i) => {
        const gid = str(t && t.gid).trim(), name = str(t && t.name).trim();
        const at = 'tabs.' + i + '.';
        if (!gid) err(at + 'gid', MSG.gidMissing);
        else if (!GID_RE.test(gid)) err(at + 'gid', MSG.gidBad);
        else if (seen.has(gid)) err(at + 'gid', 'Tab id ' + gid + ' is already in the list.');
        seen.add(gid);
        const len = Array.from(name).length;
        const folded = name.normalize('NFC').toLowerCase();
        if (!name) err(at + 'name', MSG.nameMissing);
        else if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(name)) err(at + 'name', MSG.nameControl);
        else if (len > NAME_MAX) err(at + 'name', 'Keep the name to ' + NAME_MAX + ' characters or fewer (it has ' + len + ').');
        else if (names.has(folded)) err(at + 'name', MSG.nameTaken);
        if (name) names.add(folded);
        tabs.push({ gid, name });
      });
      if (!rows.length) err('tabs', MSG.tabsMissing);
    }

    // Sign-in client ID: only in the signed-in mode (each mode leaves the others' settings empty).
    let googleClientId = '';
    if (mode === 'signin') {
      const cIn = str(f.googleClientId).trim();
      if (!cIn) err('googleClientId', MSG.clientMissing);
      else if (/^GOCSPX-/i.test(cIn)) err('googleClientId', MSG.clientSecret);
      else if (!SignIn.isClientId(cIn)) err('googleClientId', MSG.clientBad);
      else googleClientId = cIn;
    }

    let scriptUrl = '';
    if (mode === 'script') {
      const sIn = str(f.scriptUrl).trim();
      if (!sIn) err('scriptUrl', MSG.scriptMissing);
      else {
        const u = Sheet.parseScriptUrl(sIn);
        if (!u) err('scriptUrl', scriptProblem(sIn));
        else scriptUrl = sameAs(orig.scriptUrl, sIn) ? orig.scriptUrl : u;
      }
    }

    const schoolCode = str(f.schoolCode).trim();
    if (!schoolCode) err('schoolCode', MSG.codeMissing);
    else if (!CODE_RE.test(schoolCode) || !/[\p{L}\p{N}]/u.test(schoolCode)) err('schoolCode', MSG.codeBad);

    // Trusted scripts: the SHA-256 code of a script address (as the search page shows it), or the address itself.
    const lines = Array.isArray(f.trustedScripts) ? f.trustedScripts.map(str) : str(f.trustedScripts).split(/\r\n|\r|\n/);
    const origTrusted = Array.isArray(orig.trustedScripts) ? orig.trustedScripts.map(str) : [];
    const trustedScripts = [], keys = new Set(), bad = [];
    lines.forEach((line, i) => {
      const v = line.trim();
      if (!v) return;
      let out = null, key = null;
      if (HEX64_RE.test(v)) { out = origTrusted.includes(v) ? v : v.toLowerCase(); key = v.toLowerCase(); }
      else {
        const u = Sheet.parseScriptUrl(v);
        if (u) { out = origTrusted.includes(v) ? v : u; key = u; }
      }
      if (out == null) bad.push(String(i + 1));
      else if (!keys.has(key)) { keys.add(key); trustedScripts.push(out); }
    });
    if (bad.length) {
      err('trustedScripts', (bad.length === 1 ? 'Line ' + bad[0] + " isn't" : 'Lines ' + listWords(bad) + " aren't") +
        ' a trusted script code (64 letters and digits, from the maintainers\' notes) or an Apps Script address ending in /exec.');
    }

    const aliasesUrl = str(f.aliasesUrl).trim();
    if (aliasesUrl && (aliasesUrl.length > 200 || !PATH_RE.test(aliasesUrl) || aliasesUrl.split('/').some(p => p === '.' || p === '..'))) {
      err('aliasesUrl', MSG.aliasesBad);
    }

    const repoIn = str(f.repoUrl).trim();
    let repoUrl = '';
    if (!repoIn) err('repoUrl', MSG.repoMissing);
    else {
      const r = parseRepoUrl(repoIn);
      if (!r) err('repoUrl', MSG.repoBad);
      else repoUrl = sameAs(orig.repoUrl, repoIn) ? orig.repoUrl : r.url;
    }

    const cfg = { sheetUrl, tabs, googleClientId, scriptUrl, trustedScripts, schoolCode, aliasesUrl, repoUrl };
    const extra = isObj(f.extra) ? f.extra : {};
    for (const k of extraKeys(extra)) cfg[k] = extra[k];
    return { cfg, errors };
  }

  // What CensorSheet.load reads for these settings: the same choice as the search page's chooseSource for config values.
  function sourceFor(cfg) {
    const c = cfg || {};
    const p = Sheet.parseSheetUrl(str(c.sheetUrl));
    const tabsOf = () => {
      const tabs = (Array.isArray(c.tabs) ? c.tabs : []).filter(t => t && t.gid != null)
        .map(t => ({ gid: String(t.gid), name: t.name ? String(t.name) : null }));
      return tabs.length ? tabs : [{ gid: p.gid, name: null }];
    };
    if (str(c.googleClientId).trim()) {
      if (!SignIn.isClientId(c.googleClientId) || !p) return null;
      return { kind: 'api', sheetId: p.id, tabs: tabsOf() };
    }
    if (c.scriptUrl) {
      const url = Sheet.parseScriptUrl(str(c.scriptUrl));
      if (!url) return null;
      return Object.assign({ kind: 'script', url, tabs: null }, p ? { sheetId: p.id, sheetGid: p.gid } : {});
    }
    if (!p) return null;
    return { kind: 'csv', sheetId: p.id, tabs: tabsOf() };
  }

  // ---------------------------------------------------------------------------------------------
  // Line diff (longest common subsequence). Ops: { type: 'same'|'del'|'add', text, a, b } with 1-based line numbers
  // (a in the old text, b in the new one; null where the line isn't in that text). Removals come before additions.

  function splitLines(t) {
    const s = str(t);
    if (!s) return [];
    const lines = s.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  function diffLines(a, b) {
    const A = splitLines(a), B = splitLines(b);
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
    const n = a2.length, m = b2.length;
    const ops = [];
    for (let i = 0; i < pre; i++) ops.push({ type: 'same', text: A[i], a: i + 1, b: i + 1 });
    const del = i => ops.push({ type: 'del', text: a2[i], a: pre + i + 1, b: null });
    const add = j => ops.push({ type: 'add', text: b2[j], a: null, b: pre + j + 1 });
    if (n * m > 4000000) {
      for (let i = 0; i < n; i++) del(i);
      for (let j = 0; j < m; j++) add(j);
    } else {
      const dp = [];
      for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
      let i = 0, j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && a2[i] === b2[j]) { ops.push({ type: 'same', text: a2[i], a: pre + i + 1, b: pre + j + 1 }); i++; j++; }
        else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) { del(i); i++; }
        else { add(j); j++; }
      }
    }
    for (let k = suf; k > 0; k--) ops.push({ type: 'same', text: A[A.length - k], a: A.length - k + 1, b: B.length - k + 1 });
    return ops;
  }

  // The changed lines with `context` unchanged lines around them, as groups of ops ([] when nothing changed).
  function diffHunks(ops, context) {
    const ctx = context == null ? 2 : context;
    const spans = [];
    ops.forEach((o, i) => {
      if (o.type === 'same') return;
      const start = Math.max(0, i - ctx), end = Math.min(ops.length - 1, i + ctx);
      const last = spans[spans.length - 1];
      if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
      else spans.push({ start, end });
    });
    return spans.map(s => ops.slice(s.start, s.end + 1));
  }

  // ---------------------------------------------------------------------------------------------
  // Base64 of UTF-8 text (GitHub's contents API). Decoding ignores the line breaks GitHub puts in, and throws on
  // anything that isn't valid base64 of valid UTF-8.

  function b64EncodeUtf8(text) {
    const bytes = new TextEncoder().encode(str(text));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function b64DecodeUtf8(b64) {
    const bin = atob(str(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  // ---------------------------------------------------------------------------------------------
  // Saving to GitHub. Resolves { ok: true, branch, branchFrom: 'pages'|'default', path, where, commitUrl, sha } or
  // { ok: false, kind, message, status? }. It never throws, and the token goes only into the Authorization header.
  // Redirects aren't followed (so the token goes nowhere else): GitHub sends one for a renamed or transferred repository.

  const GH_API = 'https://api.github.com';
  const GH_TIMEOUT = 30000;
  const SAVE_MESSAGE = 'Update CensorSearch settings';
  const BRANCH_RE = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*[/.]$)[A-Za-z0-9._/-]{1,255}$/;
  const TOKEN_RE = /^[\x21-\x7e]{1,1000}$/;

  const GH = {
    network: "Couldn't reach GitHub, so nothing was saved. Check the internet connection: a network filter may block api.github.com.",
    timeout: 'GitHub took too long to answer, so nothing was saved. Try again.',
    putLost: "The connection to GitHub broke while saving, so this page can't tell whether config.js was saved. Reload this page in a minute: if the change isn't there, make it again.",
    auth: "GitHub didn't accept the token: it may be mistyped, expired or revoked. Make a new one (see \"How to make a token\") and paste it again.",
    changed: 'config.js changed on GitHub since this page loaded, or a change is still being published. Nothing was saved. Reload this page in a minute and make the change again.',
    conflict: 'config.js changed on GitHub while saving, so nothing was saved. Reload this page and make the change again.',
    moved: 'GitHub says the repository has moved (it was renamed or transferred), so nothing was saved. Put its new address under Advanced, Source code address, then check the list and save again.',
    noPages: "The token can't read the repository's GitHub Pages settings, so this page can't tell which branch the site is published from, and nothing was saved. When making the token, give it Repository permissions, Pages: Read-only as well as Contents: Read and write.",
    noToken: 'Paste a GitHub token to save (see "How to make a token").',
    badToken: 'The token has spaces or unusual characters in it. Copy it again from where you keep it.',
    noRepo: "The source code address under Advanced isn't a GitHub repository address (https://github.com/owner/repo), so there is nowhere to save.",
    noCurrent: "This page couldn't read config.js when it opened, so it can't make sure nothing else changed. Reload the page.",
  };

  function resolveNowMs(now) {
    if (typeof now === 'function') { const v = now(); return v instanceof Date ? v.getTime() : Number(v); }
    if (now instanceof Date) return now.getTime();
    if (typeof now === 'number') return now;
    return Date.now();
  }

  function waitText(seconds) {
    if (!(seconds > 0)) return 'later';
    if (seconds <= 90) return 'in a minute';
    return 'in about ' + Math.ceil(seconds / 60) + ' minutes';
  }

  async function githubSave(o) {
    const opt = o || {};
    const fetchFn = typeof opt.fetch === 'function' ? opt.fetch
      : typeof fetch === 'function' ? fetch : null;
    const progress = typeof opt.onProgress === 'function' ? opt.onProgress : () => {};
    const owner = str(opt.owner), repo = str(opt.repo);
    let token = str(opt.token).trim();
    // Messages are built from fixed words, the repository and branch names and GitHub's own message; never the token.
    const scrub = s => (token ? str(s).split(token).join('…') : str(s));
    const fail = (kind, message, extra) => Object.assign({ ok: false, kind, message: scrub(message) }, extra || {});

    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return fail('config', GH.noRepo);
    if (!token) return fail('token', GH.noToken);
    if (!TOKEN_RE.test(token)) { token = ''; return fail('token', GH.badToken); }
    if (typeof opt.content !== 'string' || !opt.content) return fail('config', 'There is nothing to save.');
    if (typeof opt.expectedCurrent !== 'string') return fail('config', GH.noCurrent);
    if (!fetchFn) return fail('network', GH.network);

    const full = owner + '/' + repo;
    const base = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
    const call = async (method, path, body) => {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      let timedOut = false;
      const timer = ctrl ? setTimeout(() => { timedOut = true; ctrl.abort(); }, GH_TIMEOUT) : null;
      const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + token };
      if (body != null) headers['Content-Type'] = 'application/json';
      const init = { method, headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual' };
      if (body != null) init.body = JSON.stringify(body);
      if (ctrl) init.signal = ctrl.signal;
      try {
        const res = await fetchFn(GH_API + path, init);
        if (!res || typeof res.status !== 'number') return { error: 'network' };
        // A browser gives an opaque redirect (status 0); other fetch implementations the 3xx answer itself.
        if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return { error: 'moved' };
        let json = null;
        try { json = await res.json(); } catch (e) { json = null; }
        return { res, json };
      } catch (e) {
        return { error: timedOut ? 'timeout' : 'network' };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const header = (r, name) => (r.res.headers && typeof r.res.headers.get === 'function' ? r.res.headers.get(name) : null);
    const rateLimited = r => (r.res.status === 403 || r.res.status === 429) &&
      (header(r, 'x-ratelimit-remaining') === '0' || header(r, 'retry-after') != null || r.res.status === 429);
    const said = r => {
      const m = r.json && typeof r.json.message === 'string' ? r.json.message.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      return m ? ' GitHub said: "' + m + '".' : '';
    };
    let branch = null, file = 'config.js';
    const httpFail = (step, r) => {
      const status = r.res.status;
      if (status === 401) return fail('auth', GH.auth, { status });
      if (rateLimited(r)) {
        const after = Number(header(r, 'retry-after'));
        const reset = Number(header(r, 'x-ratelimit-reset')) * 1000 - resolveNowMs(opt.now);
        const secs = Number.isFinite(after) && header(r, 'retry-after') != null ? after : Number.isFinite(reset) ? reset / 1000 : NaN;
        return fail('rateLimit', "GitHub's limit on requests for this token is used up for now, so nothing was saved. Try again " + waitText(secs) + '.', { status });
      }
      if (status === 403) {
        return fail('permission', 'The token has no permission to change files in ' + full + '. When making it, give it Repository permissions, Contents: Read and write.' + said(r), { status });
      }
      if (status === 404) {
        if (step === 'contents') {
          return fail('notFound', "GitHub can't find " + file + ' on branch ' + branch + ' of ' + full + ", or the token can't see it. When making the token, choose " + full + ' under Repository access.' + said(r), { status });
        }
        if (step === 'put') {
          return fail('notFound', "GitHub didn't let the token change " + file + ' in ' + full + '. When making the token, choose ' + full + ' under Repository access and give it Contents: Read and write.' + said(r), { status });
        }
        return fail('notFound', "The token can't see " + full + '. When making it, choose that repository under Repository access (Only select repositories), and check the source code address under Advanced.' + said(r), { status });
      }
      if (step === 'put' && (status === 409 || status === 422)) {
        // Only a stale sha means the file changed in between; anything else (branch protection, a ruleset) happens again.
        if (r.json && /does not match/i.test(str(r.json.message))) return fail('conflict', GH.conflict + said(r), { status });
        return fail('refused', 'GitHub refused the change (HTTP ' + status + '), so nothing was saved, and saving again won\'t help.' + said(r) +
          ' Branch protection or a ruleset on branch ' + branch + ' may require changes to go through a pull request: then change ' + file +
          " through one, or ask the repository's owner.", { status });
      }
      if (status >= 500) return fail('server', 'GitHub had a problem (HTTP ' + status + '), so nothing was saved. Try again in a minute.', { status });
      return fail('http', 'GitHub answered with an error (HTTP ' + status + '), so nothing was saved.' + said(r), { status });
    };
    const netFail = r => fail(r.error, r.error === 'timeout' ? GH.timeout : r.error === 'moved' ? GH.moved : GH.network);

    try {
      // 1. The branch (and folder) GitHub Pages publishes, which needs Pages: Read. A token without it can't tell, so
      // it saves nothing. Without a Pages site, or with one published by a workflow, the repository's default branch.
      progress('Finding the branch GitHub Pages publishes…');
      let branchFrom = 'pages', why = '', folder = '';
      let r = await call('GET', base + '/pages');
      if (r.error) return netFail(r);
      const pages = r.res.status === 200 && isObj(r.json) ? r.json : null;
      if (pages && pages.build_type !== 'workflow' && isObj(pages.source) && typeof pages.source.branch === 'string') {
        branch = pages.source.branch;
        const path = pages.source.path == null ? '/' : pages.source.path;
        if (path === '/docs') folder = 'docs';
        else if (path !== '/') return fail('format', 'GitHub Pages publishes this site from a folder (' + str(path).slice(0, 80) + ") this page can't save to, so nothing was saved. Edit config.js there by hand.");
      } else if (r.res.status === 403 && !rateLimited(r)) {
        return fail('permission', GH.noPages + said(r), { status: 403 });
      } else if (pages || r.res.status === 404) {
        why = pages ? 'GitHub Pages publishes this site with a workflow' : 'it has no GitHub Pages site';
        r = await call('GET', base);
        if (r.error) return netFail(r);
        if (r.res.status !== 200) return httpFail('repo', r);
        if (!isObj(r.json) || typeof r.json.default_branch !== 'string') return fail('format', "GitHub's answer about " + full + " couldn't be read, so nothing was saved.");
        branch = r.json.default_branch;
        branchFrom = 'default';
      } else return httpFail('pages', r);
      if (!BRANCH_RE.test(branch)) return fail('format', 'The branch name GitHub gave (' + branch.slice(0, 80) + ") isn't one this page can save to, so nothing was saved.");
      file = folder ? folder + '/config.js' : 'config.js';
      const where = branchFrom === 'pages'
        ? (folder ? 'the ' + folder + ' folder of ' : '') + 'branch ' + branch + ' of ' + full + ', which GitHub Pages publishes'
        : 'the default branch of ' + full + ', ' + branch + ', because ' + why;

      // 2. The file as it is on that branch, which must still be the one this page was served.
      progress('Reading config.js from ' + where + '…');
      r = await call('GET', base + '/contents/' + file + '?ref=' + encodeURIComponent(branch));
      if (r.error) return netFail(r);
      if (r.res.status !== 200) return httpFail('contents', r);
      const got = r.json;
      if (!isObj(got) || got.type !== 'file' || typeof got.sha !== 'string' || got.encoding !== 'base64' || typeof got.content !== 'string') {
        return fail('format', "GitHub's copy of config.js couldn't be read, so nothing was saved.");
      }
      let remote;
      try { remote = b64DecodeUtf8(got.content); } catch (e) { return fail('format', "GitHub's copy of config.js couldn't be read, so nothing was saved."); }
      if (remote !== opt.expectedCurrent) return fail('changed', GH.changed, { branch, branchFrom });

      // 3. Save. The sha makes GitHub refuse if the file changed in between.
      progress('Saving config.js to ' + where + '…');
      r = await call('PUT', base + '/contents/' + file, {
        message: str(opt.message) || SAVE_MESSAGE, content: b64EncodeUtf8(opt.content), sha: got.sha, branch,
      });
      if (r.error) return r.error === 'moved' ? netFail(r) : fail(r.error, GH.putLost);
      if (r.res.status !== 200 && r.res.status !== 201) return httpFail('put', r);
      const commit = isObj(r.json) && isObj(r.json.commit) ? r.json.commit : {};
      const content = isObj(r.json) && isObj(r.json.content) ? r.json.content : {};
      return { ok: true, branch, branchFrom, path: file, where, commitUrl: httpsUrl(commit.html_url), sha: typeof content.sha === 'string' ? content.sha : null };
    } finally {
      token = '';
    }
  }

  function httpsUrl(u) {
    if (typeof u !== 'string' || !/^https:\/\//i.test(u.trim())) return null;
    try {
      const url = new URL(u.trim());
      return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : null;
    } catch (e) { return null; }
  }

  // GitHub's new fine-grained token page with the name, owner and permissions filled in (documented URL parameters;
  // the repository itself can't be chosen this way).
  function tokenPageUrl(repo) {
    const base = 'https://github.com/settings/personal-access-tokens/new';
    if (!repo) return base;
    const q = new URLSearchParams();
    q.set('name', 'CensorSearch settings');
    q.set('description', 'Saves the CensorSearch settings (config.js) in ' + repo.owner + '/' + repo.repo + '.');
    q.set('target_name', repo.owner);
    q.set('contents', 'write');
    q.set('pages', 'read');
    return base + '?' + q.toString();
  }

  // ---------------------------------------------------------------------------------------------
  // The page

  const POLL_EVERY = 10 * 1000;
  const POLL_FOR = 5 * 60 * 1000;
  const LIVE_TEXT = 'Live. In this browser the search page shows the new settings (reload it if it is open). ' +
    'Other browsers that opened the search page in the last 10 minutes may show the old ones for up to 10 more minutes, ' +
    'even after a normal reload; a hard reload (Ctrl+Shift+R, or Cmd+Shift+R on a Mac) shows the new ones.';
  const ALIASES_TIMEOUT = 10000;

  function start(win) {
    const doc = win.document;
    const $ = id => doc.getElementById(id);
    const appBox = $('settings-app');
    if (!appBox) return;
    // GitHub Pages can't send frame-ancestors, so the page refuses to show its form inside another page.
    let framed;
    try { framed = win.top !== win.self; } catch (e) { framed = true; }
    if (framed) {
      appBox.remove();
      const box = $('framed');
      if (box) box.hidden = false;
      return;
    }

    const ui = {
      pageStatus: $('page-status'), currentNote: $('current-note'), currentList: $('current-list'),
      form: $('settings-form'), modeFieldset: $('mode-fieldset'), modeLink: $('mode-link'), modeSignin: $('mode-signin'), modeScript: $('mode-script'),
      clientField: $('client-field'), clientId: $('client-id'),
      sheetUrl: $('sheet-url'), sheetHelp: $('sheet-url-help'), sheetOptional: $('sheet-url-optional'), sheetHint: $('sheet-url-hint'),
      tabsFieldset: $('tabs-fieldset'), tabList: $('tab-list'), tabAdd: $('tab-add'),
      tabLink: $('tab-link'), tabLinkAdd: $('tab-link-add'), tabLinkError: $('tab-link-error'), tabLinkNote: $('tab-link-note'),
      scriptField: $('script-field'), scriptUrl: $('script-url'), schoolCode: $('school-code'),
      advanced: $('advanced'), trusted: $('trusted-scripts'), trustedNote: $('trusted-scripts-note'),
      aliasesUrl: $('aliases-url'), repoUrl: $('repo-url'),
      checkSection: $('check'), checkButton: $('check-button'), checkStatus: $('check-status'), checkResults: $('check-results'),
      saveSection: $('save'), diffSummary: $('diff-summary'), diff: $('diff'), saveForm: $('save-form'), saveTarget: $('save-target'),
      token: $('token'), tokenError: $('token-error'), tokenLink: $('token-new-link'), howtoOwner: $('howto-owner'), howtoRepo: $('howto-repo'),
      saveButton: $('save-button'), saveStatus: $('save-status'), saveLinks: $('save-links'), publishStatus: $('publish-status'),
    };
    appBox.hidden = false;

    const state = {
      base: null,          // the settings in config.js (the form starts from them; saving replaces them)
      servedText: null,    // config.js as this site served it when the page loaded (null if it couldn't be read)
      extra: {},           // settings this page doesn't edit, kept as they are
      attempted: false,    // after the first check or save, every problem is shown; before it, only for fields left
      touched: new Set(),  // ids of fields the maintainer has left after changing them
      current: null,       // the latest validate() result
      checked: null,       // { text, at, tabs, items, warnings, saved } of the last successful check; dropped once the settings differ from it
      lastCheck: null,     // the config.js text of the last check whatever its outcome, while its results are current
      checkRun: 0, checking: false, saving: false,
      poll: null,          // { timer, run } while waiting for GitHub Pages to publish
      rowSeq: 0,
      hintKey: '',
      picked: null,        // { row, gid }: the row pickUpGid filled in from the sheet link, while its tab id is unchanged
      note: null,          // { gid, fromSheet }: the tab id the note under "Add a tab from its link" is about
      signIn: null,        // { clientId, client, chooseAccount } for the signed-in check: the maintainer's own sign-in, in memory
      gisLoading: null,    // while Google's sign-in script loads
      gisError: null,      // why it didn't load, until the next try
    };
    const rows = [];       // tab rows: { li, gid, name, gidError, nameError, remove, numbers }

    // -------------------------------------------------------------------------------------------
    // Small helpers

    function el(tag, attrs) {
      const node = doc.createElement(tag);
      if (attrs) {
        for (const k of Object.keys(attrs)) {
          const v = attrs[k];
          if (v == null || v === false) continue;
          if (k === 'class') node.className = v;
          else node.setAttribute(k, v === true ? '' : String(v));
        }
      }
      for (let i = 2; i < arguments.length; i++) {
        const c = arguments[i];
        if (c == null || c === false) continue;
        for (const x of Array.isArray(c) ? c : [c]) {
          if (x != null && x !== false) node.append(typeof x === 'object' ? x : String(x));   // strings become text nodes
        }
      }
      return node;
    }
    const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
    const extLink = (url, text) => {
      const href = httpsUrl(url);
      return href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : null;
    };
    const fmtInt = n => Number(n || 0).toLocaleString('en-US');
    const plural = (n, one, many) => fmtInt(n) + ' ' + (n === 1 ? one : many);
    const pad2 = n => String(n).padStart(2, '0');
    const hhmm = d => pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    const sentence = s => { const t = str(s).trim(); return !t || /[.!?…]["”’)]*$/.test(t) ? t : t + '.'; };
    const shortId = id => (str(id).length > 14 ? str(id).slice(0, 6) + '…' + str(id).slice(-4) : str(id));
    const mode = () => (ui.modeScript.checked ? 'script' : ui.modeSignin.checked ? 'signin' : ui.modeLink.checked ? 'link' : '');
    const tabsMode = () => mode() === 'link' || mode() === 'signin';
    const button = (label, onClick) => { const b = el('button', { type: 'button' }, label); b.addEventListener('click', onClick); return b; };

    // -------------------------------------------------------------------------------------------
    // Loading config.js. The page's own <script src="config.js"> may come from the browser's cache (GitHub Pages lets
    // browsers keep it for 10 minutes), while saving must start from the file as the site serves it now. So the file is
    // read again past the cache, and when the settings from the cached copy don't match it, config.js is run again
    // from a fresh address. Reading with cache: 'reload' also puts the copy it gets into the browser's cache, where the
    // search page's own <script src="config.js"> finds it (cache: 'no-store' would leave the old copy there).

    const configUrl = () => new URL('config.js', win.location.href).href;

    async function readServedText() {
      try {
        const res = await win.fetch(configUrl(), { cache: 'reload', credentials: 'same-origin' });
        return res && res.ok ? await res.text() : null;
      } catch (e) {
        return null;
      }
    }

    function loadFreshConfig() {
      return new Promise(resolve => {
        const s = doc.createElement('script');
        let done = false;
        const finish = ok => {
          if (done) return;
          done = true;
          win.clearTimeout(timer);
          s.remove();
          const c = win.CENSORSEARCH_CONFIG;
          resolve(ok && isObj(c) ? c : null);
        };
        const timer = win.setTimeout(() => finish(false), 10000);
        s.addEventListener('load', () => finish(true));
        s.addEventListener('error', () => finish(false));
        s.setAttribute('src', 'config.js?fresh=' + Date.now());
        (doc.head || doc.body).append(s);
      });
    }

    async function loadCurrent() {
      const text = await readServedText();
      let cfg = isObj(win.CENSORSEARCH_CONFIG) ? win.CENSORSEARCH_CONFIG : null;
      if (text != null && (!cfg || buildConfigJs(cfg) !== text)) {
        const fresh = await loadFreshConfig();
        if (fresh) cfg = fresh;
      }
      return { cfg, text };
    }

    // -------------------------------------------------------------------------------------------
    // Current settings

    function renderCurrent() {
      const c = state.base;
      const list = ui.currentList;
      list.replaceChildren();
      const item = (term, ...desc) => list.append(el('dt', null, term), el('dd', null, ...desc));
      const sheet = Sheet.parseSheetUrl(str(c.sheetUrl));
      const sheetLink = sheet ? extLink(Sheet.sheetUrl(sheet.id, sheet.gid), 'this Google Sheet') : null;
      const tabsItem = () => {
        const tabs = copyTabs(c.tabs);
        item('Tabs searched', tabs.length
          ? listWords(tabs.map(t => (t.name ? t.name : 'unnamed') + ' (tab id ' + t.gid + ')')) + '.'
          : "The sheet's first tab.");
      };
      if (str(c.googleClientId).trim()) {
        const ok = SignIn.isClientId(c.googleClientId);
        item('How the page reads the list', ok && sheet
          ? ['With Google sign-in: each visitor signs in and reads ', sheetLink, ' (sheet ' + shortId(sheet.id) + ') with their own Google account, so only people who can view it can search it.']
          : ok ? "With Google sign-in, but the sheet link isn't a Google Sheets link, so the search page can't load the list."
            : "With Google sign-in, but the client ID isn't valid, so the search page can't load the list.");
        item('Sign-in client ID', str(c.googleClientId) + '.');
        tabsItem();
      } else if (c.scriptUrl) {
        const u = Sheet.parseScriptUrl(str(c.scriptUrl));
        const id = u ? (u.match(/\/s\/([^/]+)\/exec$/) || [])[1] : '';
        item('How the page reads the list', u
          ? 'Through the Apps Script web app (deployment ' + shortId(id) + '), whose own tab list decides which tabs are searched.'
          : "Through an Apps Script address that isn't valid, so the search page can't load the list.");
        item('Sheet link', sheet ? [sheetLink, ' (sheet ' + shortId(sheet.id) + '), shown as "Open the sheet" when the script can\'t be reached.'] : 'None.');
      } else {
        item('How the page reads the list', sheet
          ? ['By link, from ', sheetLink, ' (sheet ' + shortId(sheet.id) + '), shared "Anyone with the link can view".']
          : "By link, but the sheet link isn't a Google Sheets link, so the search page can't load the list.");
        tabsItem();
      }
      item("School's Banned By code", str(c.schoolCode || DEFAULTS.schoolCode) + '.');
      const trusted = Array.isArray(c.trustedScripts) ? c.trustedScripts.length : 0;
      item('Trusted script codes', trusted ? plural(trusted, 'code', 'codes') + '.' : 'None.');
      item('Alias list', aliasesOf(c) ? str(aliasesOf(c)) + '.' : 'None.');
      const repo = parseRepoUrl(str(c.repoUrl));
      item('Source code', repo ? [extLink(repo.url, repo.owner + '/' + repo.repo), ' on GitHub.'] : str(c.repoUrl) ? str(c.repoUrl) : 'None.');
      const extra = extraKeys(c);
      const kept = extra.filter(k => roundTrips(c[k])), changed = extra.filter(k => !roundTrips(c[k]));
      if (kept.length) item('Other settings, kept as they are', listWords(kept) + '.');
      if (changed.length) {
        item('Other settings that saving changes', listWords(changed) + (changed.length === 1
          ? ": this page can't write its value as it is, so saving drops or changes it. To keep it, edit config.js by hand instead."
          : ": this page can't write their values as they are, so saving drops or changes them. To keep them, edit config.js by hand instead."));
      }
    }

    // -------------------------------------------------------------------------------------------
    // Tab rows

    function addRow(gid, name) {
      const k = ++state.rowSeq;
      const ids = { gid: 'tab-' + k + '-gid', name: 'tab-' + k + '-name' };
      const numbers = [el('span', { class: 'visually-hidden' }), el('span', { class: 'visually-hidden' }), el('span', { class: 'visually-hidden' })];
      const gidInput = el('input', { id: ids.gid, type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', class: 'gid-input', 'aria-describedby': 'tabs-help' });
      const nameInput = el('input', { id: ids.name, type: 'text', autocomplete: 'off', maxlength: '200', class: 'name-input' });
      gidInput.value = str(gid);
      nameInput.value = str(name);
      const gidError = el('p', { id: ids.gid + '-error', class: 'field-error', hidden: true });
      const nameError = el('p', { id: ids.name + '-error', class: 'field-error', hidden: true });
      const remove = el('button', { type: 'button', class: 'tab-remove' }, 'Remove', numbers[2]);
      const li = el('li', { class: 'tab-row' },
        el('div', { class: 'tab-field' }, el('label', { for: ids.gid }, 'Tab id', numbers[0]), gidInput, gidError),
        el('div', { class: 'tab-field tab-name' }, el('label', { for: ids.name }, 'Name', numbers[1]), nameInput, nameError),
        el('div', { class: 'tab-actions' }, remove));
      const row = { li, gid: gidInput, name: nameInput, gidError, nameError, remove, numbers };
      remove.addEventListener('click', () => removeRow(row));
      rows.push(row);
      ui.tabList.append(li);
      renumber();
      return row;
    }

    function removeRow(row) {
      const i = rows.indexOf(row);
      if (i < 0) return;
      rows.splice(i, 1);
      row.li.remove();
      state.touched.add('tabs');
      renumber();
      const next = rows[i] || rows[i - 1];
      (next ? next.remove : ui.tabAdd).focus();
      update();
    }

    function renumber() {
      rows.forEach((r, i) => {
        setText(r.numbers[0], ' of tab ' + (i + 1));
        setText(r.numbers[1], ' of tab ' + (i + 1));
        setText(r.numbers[2], ' tab ' + (i + 1));
      });
    }

    // -------------------------------------------------------------------------------------------
    // The form

    function fillForm(c) {
      const signin = !!str(c.googleClientId).trim();
      const script = !signin && !!str(c.scriptUrl).trim();
      ui.modeSignin.checked = signin;
      ui.modeScript.checked = script;
      ui.modeLink.checked = !signin && !script;
      ui.clientId.value = str(c.googleClientId);
      ui.sheetUrl.value = str(c.sheetUrl);
      rows.splice(0).forEach(r => r.li.remove());
      copyTabs(c.tabs).forEach(t => addRow(t.gid, t.name));
      ui.scriptUrl.value = str(c.scriptUrl);
      ui.schoolCode.value = str(c.schoolCode == null ? DEFAULTS.schoolCode : c.schoolCode);
      ui.trusted.value = (Array.isArray(c.trustedScripts) ? c.trustedScripts : []).map(str).join('\n');
      ui.aliasesUrl.value = str(aliasesOf(c));
      ui.repoUrl.value = str(c.repoUrl);
    }

    function readForm() {
      return {
        mode: mode(),
        sheetUrl: ui.sheetUrl.value,
        tabs: rows.map(r => ({ gid: r.gid.value, name: r.name.value })),
        googleClientId: ui.clientId.value,
        scriptUrl: ui.scriptUrl.value,
        schoolCode: ui.schoolCode.value,
        trustedScripts: ui.trusted.value,
        aliasesUrl: ui.aliasesUrl.value,
        repoUrl: ui.repoUrl.value,
        extra: state.extra,
        original: state.base,
      };
    }

    // Where each problem is shown: { input (focus target), describe (gets aria-describedby), error, help, advanced }.
    function fieldFor(key) {
      const simple = (input, errorId, helpId, advanced) => ({ input, describe: input, error: $(errorId), help: helpId, advanced: !!advanced });
      switch (key) {
        case 'mode': return { input: ui.modeLink, describe: ui.modeFieldset, error: $('mode-error'), help: null };
        case 'sheetUrl': return simple(ui.sheetUrl, 'sheet-url-error', 'sheet-url-help');
        case 'tabs': return { input: ui.tabAdd, describe: ui.tabsFieldset, error: $('tabs-error'), help: 'tabs-help' };
        case 'googleClientId': return simple(ui.clientId, 'client-id-error', 'client-id-help');
        case 'scriptUrl': return simple(ui.scriptUrl, 'script-url-error', 'script-url-help');
        case 'schoolCode': return simple(ui.schoolCode, 'school-code-error', 'school-code-help');
        case 'trustedScripts': return simple(ui.trusted, 'trusted-scripts-error', 'trusted-scripts-help', true);
        case 'aliasesUrl': return simple(ui.aliasesUrl, 'aliases-url-error', 'aliases-url-help', true);
        case 'repoUrl': return simple(ui.repoUrl, 'repo-url-error', 'repo-url-help', true);
        default: {
          const m = /^tabs\.(\d+)\.(gid|name)$/.exec(key);
          const r = m && rows[Number(m[1])];
          if (!r) return null;
          return m[2] === 'gid'
            ? { input: r.gid, describe: r.gid, error: r.gidError, help: 'tabs-help' }
            : { input: r.name, describe: r.name, error: r.nameError, help: null };
        }
      }
    }

    const FIELD_KEYS = ['mode', 'sheetUrl', 'tabs', 'googleClientId', 'scriptUrl', 'schoolCode', 'trustedScripts', 'aliasesUrl', 'repoUrl'];

    function shownErrors(errors) {
      return errors.filter(e => {
        if (state.attempted) return true;
        const f = fieldFor(e.field);
        return !!f && (state.touched.has(f.input.id) || (e.field === 'tabs' && state.touched.has('tabs')));
      });
    }

    function showErrors(errors) {
      const shown = shownErrors(errors);
      const keys = FIELD_KEYS.concat(...rows.map((r, i) => ['tabs.' + i + '.gid', 'tabs.' + i + '.name']));
      for (const key of keys) {
        const f = fieldFor(key);
        if (!f) continue;
        const e = shown.find(x => x.field === key);
        setText(f.error, e ? e.message : '');
        f.error.hidden = !e;
        const ids = [f.help, e ? f.error.id : null].filter(Boolean).join(' ');
        if (ids) f.describe.setAttribute('aria-describedby', ids); else f.describe.removeAttribute('aria-describedby');
        if (f.describe.tagName === 'FIELDSET') continue;
        if (e) f.describe.setAttribute('aria-invalid', 'true'); else f.describe.removeAttribute('aria-invalid');
      }
      if (shown.some(e => { const f = fieldFor(e.field); return f && f.advanced; })) ui.advanced.open = true;
      return shown;
    }

    function focusFirstError(errors) {
      const f = errors.length ? fieldFor(errors[0].field) : null;
      if (!f) return;
      if (f.advanced) ui.advanced.open = true;
      f.input.focus();
    }

    function applyMode() {
      const m = mode();
      ui.tabsFieldset.hidden = !tabsMode();
      ui.clientField.hidden = m !== 'signin';
      ui.scriptField.hidden = m !== 'script';
      ui.sheetOptional.hidden = m !== 'script';
      setText(ui.sheetHelp, m === 'script'
        ? 'The sheet the script reads. The search page links to it as "Open the sheet", including when the script can\'t be reached.'
        : m === 'signin'
          ? 'The Google Sheet\'s address, copied from the browser\'s address bar while the sheet is open. It doesn\'t need to be shared by link: each visitor reads it with their own Google account.'
          : 'The Google Sheet\'s address, copied from the browser\'s address bar while the sheet is open. It must be shared "Anyone with the link can view".');
      if (m === 'signin') prepareSignIn();
    }

    // The note under "Add a tab from its link", and the tab id it is about (update() clears it once that is gone).
    function linkNote(text, gid, fromSheet) {
      setText(ui.tabLinkNote, text);
      state.note = text ? { gid, fromSheet: !!fromSheet } : null;
    }

    // A sheet link that opens a tab, typed or pasted while no tab is listed: that tab goes in the list. When tabs are
    // listed already, renderSheetHint offers to add it instead. Typing a link fires this on every key, so the row filled
    // in follows the link (gid=1, gid=11, …) until the maintainer changes its tab id.
    function pickUpGid() {
      if (!tabsMode()) return;
      const pk = state.picked;
      const picked = pk && rows.includes(pk.row) && pk.row.gid.value === pk.gid ? pk.row : null;
      if (!picked && rows.some(r => r.gid.value.trim())) return;
      const p = Sheet.parseSheetUrl(ui.sheetUrl.value);
      if (!p || !p.gid) return;
      const row = picked || rows[0] || addRow('', '');
      row.gid.value = p.gid;
      state.picked = { row, gid: p.gid };
      linkNote('Tab id ' + p.gid + ' from the sheet link is now in the tab list. Give it a name.', p.gid, true);
    }

    function renderSheetHint() {
      const p = tabsMode() ? Sheet.parseSheetUrl(ui.sheetUrl.value) : null;
      const show = !!(p && p.gid && !rows.some(r => r.gid.value.trim() === p.gid));
      const key = show ? p.gid : '';
      if (key === state.hintKey) return;
      state.hintKey = key;
      ui.sheetHint.replaceChildren();
      ui.sheetHint.hidden = !show;
      if (!show) return;
      ui.sheetHint.append('This link opens the tab with id ' + p.gid + ", which isn't in the tab list. ",
        button('Add tab ' + p.gid + ' to the list', () => {
          const row = addRow(p.gid, '');
          update();
          row.name.focus();
        }));
    }

    function addFromLink() {
      const raw = ui.tabLink.value.trim();
      const problem = msg => {
        // The error is an alert: written afresh each time, so pressing Enter again announces it again even though
        // focus stays in the field.
        ui.tabLinkError.replaceChildren(...(msg ? [msg] : []));
        ui.tabLinkError.hidden = !msg;
        if (msg) {
          ui.tabLink.setAttribute('aria-invalid', 'true');
          ui.tabLink.setAttribute('aria-describedby', 'tab-link-help tab-link-error');
          ui.tabLink.focus();
        } else {
          ui.tabLink.removeAttribute('aria-invalid');
          ui.tabLink.setAttribute('aria-describedby', 'tab-link-help');
        }
      };
      linkNote('');
      if (!raw) return problem("Paste a tab's link first.");
      const p = Sheet.parseSheetUrl(raw);
      if (!p) return problem(sheetLinkProblem(raw));
      if (!p.gid) return problem("This link doesn't say which tab it opens. Open the tab in the sheet and copy the address again: it ends in gid= and a number.");
      const sheetNow = ui.sheetUrl.value.trim();
      const own = Sheet.parseSheetUrl(sheetNow);
      if (!sheetNow) ui.sheetUrl.value = Sheet.sheetUrl(p.id, p.gid);
      else if (!own) return problem('Fix the sheet link above first.');
      else if (own.id !== p.id) return problem("This tab is in another spreadsheet from the sheet link above. Every tab must be in the sheet link's spreadsheet.");
      problem('');
      ui.tabLink.value = '';
      const existing = rows.find(r => r.gid.value.trim() === p.gid);
      if (existing) {
        linkNote('Tab id ' + p.gid + ' is already in the list.', p.gid);
        existing.name.focus();
        update();
        return;
      }
      const blank = rows.find(r => !r.gid.value.trim() && !r.name.value.trim());
      const row = blank || addRow('', '');
      row.gid.value = p.gid;
      linkNote('Added tab id ' + p.gid + '. Give it a name.', p.gid);
      update();
      row.name.focus();
    }

    // Trusted scripts: an address in this public file shows it to anyone; its code doesn't. Offer to swap them.
    async function digest(text) {
      const buf = await win.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    }

    function renderTrustedNote() {
      const lines = ui.trusted.value.split(/\r\n|\r|\n/);
      const urls = lines.map((l, i) => (Sheet.parseScriptUrl(l.trim()) ? i + 1 : 0)).filter(Boolean);
      const key = urls.join(',');
      if (key === ui.trustedNote.getAttribute('data-key')) return;
      ui.trustedNote.setAttribute('data-key', key);
      ui.trustedNote.replaceChildren();
      ui.trustedNote.hidden = !urls.length;
      if (!urls.length) return;
      ui.trustedNote.append((urls.length === 1 ? 'Line ' + urls[0] + ' is a script address' : 'Lines ' + listWords(urls.map(String)) + ' are script addresses') +
        ', which config.js would show to anyone. A code stands for the address without revealing it. ');
      if (win.crypto && win.crypto.subtle) {
        ui.trustedNote.append(button('Replace with codes', async () => {
          const out = [];
          for (const l of ui.trusted.value.split(/\r\n|\r|\n/)) {
            const u = Sheet.parseScriptUrl(l.trim());
            try { out.push(u ? await digest(u) : l); } catch (e) { out.push(l); }
          }
          ui.trusted.value = out.join('\n');
          update();
          ui.trusted.focus();
        }));
      }
    }

    // -------------------------------------------------------------------------------------------
    // Review: the diff, the save target and the token page link

    function renderDiff(v) {
      ui.diff.replaceChildren();
      ui.diff.hidden = true;
      if (state.servedText == null) return setText(ui.diffSummary, "config.js couldn't be read when the page loaded, so the changes can't be shown. Reload the page.");
      if (v.errors.length) {
        // Problems in fields not filled in yet aren't marked until the maintainer leaves them, checks or saves.
        return setText(ui.diffSummary, shownErrors(v.errors).length
          ? 'Fix the problems marked above to see the changes to config.js.'
          : 'Finish the settings above to see the changes to config.js.');
      }
      const ops = diffLines(state.servedText, buildConfigJs(v.cfg));
      const hunks = diffHunks(ops, 2);
      if (!hunks.length) return setText(ui.diffSummary, 'No changes yet: these are the settings in config.js.');
      const removed = ops.filter(o => o.type === 'del').length, added = ops.filter(o => o.type === 'add').length;
      setText(ui.diffSummary, 'Changes to config.js: ' + plural(removed, 'line', 'lines') + ' removed, ' + plural(added, 'line', 'lines') + ' added.');
      const gap = () => ui.diff.append(el('span', { class: 'diff-line diff-gap' }, '…'));
      hunks.forEach((h, i) => {
        if (i > 0 || h[0] !== ops[0]) gap();
        for (const o of h) {
          const tag = o.type === 'del' ? 'del' : o.type === 'add' ? 'ins' : 'span';
          const mark = o.type === 'del' ? '-' : o.type === 'add' ? '+' : ' ';
          ui.diff.append(el(tag, { class: 'diff-line diff-' + o.type },
            el('span', { class: 'diff-mark', 'aria-hidden': 'true' }, mark + ' '),
            o.type === 'same' ? null : el('span', { class: 'visually-hidden' }, o.type === 'del' ? 'Removed: ' : 'Added: '),
            o.text));
        }
      });
      const lastHunk = hunks[hunks.length - 1];
      if (lastHunk[lastHunk.length - 1] !== ops[ops.length - 1]) gap();
      ui.diff.hidden = false;
    }

    function renderTarget(v) {
      const repo = parseRepoUrl(str(v.cfg.repoUrl)) || parseRepoUrl(str(state.base && state.base.repoUrl));
      ui.tokenLink.href = tokenPageUrl(repo);
      setText(ui.howtoOwner, repo ? repo.owner + " (the repository's owner)" : "the repository's owner");
      setText(ui.howtoRepo, repo ? repo.owner + '/' + repo.repo : 'this repository');
      setText(ui.saveTarget, repo
        ? 'Saving changes config.js in ' + repo.owner + '/' + repo.repo + ' on GitHub, on the branch GitHub Pages publishes.'
        : 'Saving needs the source code address under Advanced.');
    }

    // -------------------------------------------------------------------------------------------
    // Updating after every change

    function update() {
      applyMode();
      const v = validate(readForm());
      state.current = v;
      showErrors(v.errors);
      renderSheetHint();
      renderTrustedNote();
      renderDiff(v);
      renderTarget(v);
      if (state.lastCheck != null && (v.errors.length || buildConfigJs(v.cfg) !== state.lastCheck)) {
        state.lastCheck = null;
        state.checked = null;
        setText(ui.checkStatus, 'The settings changed after the check. Check the list again before saving.');
        ui.checkResults.classList.add('stale');
      }
      if (state.note) {
        const p = state.note.fromSheet ? Sheet.parseSheetUrl(ui.sheetUrl.value) : null;
        const gone = !rows.some(r => r.gid.value.trim() === state.note.gid) || (state.note.fromSheet && !(p && p.gid === state.note.gid));
        if (gone) linkNote('');
      }
      return v;
    }

    // -------------------------------------------------------------------------------------------
    // Check the list

    // The alias list, read the way the search page reads it: a file on this site with an "aliases" list. Resolves
    // { path, count } or { path, problem }, or null when there is none.
    async function readAliases(path) {
      if (!path) return null;
      const ctrl = typeof win.AbortController === 'function' ? new win.AbortController() : null;
      const timer = ctrl ? win.setTimeout(() => ctrl.abort(), ALIASES_TIMEOUT) : 0;
      const bad = why => ({ path, problem: 'The alias list ' + path + ' ' + why + ', so the search page would search without aliases. Check Alias list under Advanced.' });
      try {
        const url = new URL(path, win.location.href);
        if (url.origin !== win.location.origin) return bad("isn't on this site");
        const res = await win.fetch(url.href, Object.assign({ cache: 'no-store', credentials: 'same-origin' }, ctrl ? { signal: ctrl.signal } : {}));
        if (!res || !res.ok) return bad(res && res.status === 404 ? "isn't on this site (HTTP 404)" : "couldn't be read (HTTP " + (res ? res.status : '?') + ')');
        let json = null;
        try { json = await res.json(); } catch (e) { json = null; }
        if (!isObj(json) || !Array.isArray(json.aliases)) return bad("isn't an alias file (it has no \"aliases\" list)");
        return { path, count: json.aliases.length };
      } catch (e) {
        return bad("couldn't be read");
      } finally {
        if (timer) win.clearTimeout(timer);
      }
    }

    // The signed-in check reads the sheet with the maintainer's own Google sign-in (kept in memory for this page only).
    // Google's script loads as soon as that mode is chosen, so the check's click can open the sign-in window at once.
    function signInFor(clientId) {
      if (!state.signIn || state.signIn.clientId !== clientId) state.signIn = { clientId, client: SignIn.create(win, clientId), chooseAccount: false };
      return state.signIn;
    }

    // A script that didn't load is tried again only when asked (retry), so its error stays on screen until then.
    function prepareSignIn(retry) {
      if (state.gisLoading || SignIn.isReady(win) || (state.gisError && !retry)) return;
      state.gisError = null;
      state.gisLoading = SignIn.loadGis(win).then(() => { state.gisLoading = null; }, e => { state.gisLoading = null; state.gisError = e.message; });
    }

    // Whether the sheet can also be read by link, without signing in (then sign-in doesn't keep anyone out).
    async function readableByLink(source) {
      try {
        const r = await Sheet.load({ kind: 'csv', sheetId: source.sheetId, tabs: source.tabs }, { fetch: win.fetch.bind(win), schoolCode: 'UAS' });
        return r.rows.length > 0;
      } catch (e) {
        return false;
      }
    }

    function checkedStatus() {
      const c = state.checked;
      return 'Checked at ' + hhmm(c.at) + ': ' + plural(c.tabs, 'tab', 'tabs') + ', ' + plural(c.items, 'item', 'items') + ', no problems' +
        (c.warnings ? ', ' + plural(c.warnings, 'warning', 'warnings') + ' (see below)' : '') + '. ' +
        (c.saved ? 'These are the settings now in config.js.'
          : c.text === state.servedText ? 'These are the settings already in config.js.' : 'You can save these settings.');
    }

    async function runCheck() {
      if (state.checking) return;
      state.attempted = true;
      const v = update();
      const shown = shownErrors(v.errors);
      if (v.errors.length) {
        setText(ui.checkStatus, 'Fix the ' + (shown.length === 1 ? 'problem' : plural(shown.length, 'problem', 'problems')) + ' marked above, then check again.');
        focusFirstError(v.errors);
        return;
      }
      const text = buildConfigJs(v.cfg);
      const source = sourceFor(v.cfg);
      // Signed in: sign in now, straight from the click (before any await), so the browser allows Google's window.
      const auth = source.kind === 'api' ? signInFor(v.cfg.googleClientId) : null;
      let signingIn = null;
      if (auth && !auth.client.token()) {
        if (!auth.client.ready()) {
          const error = state.gisError;
          prepareSignIn(true);
          setText(ui.checkStatus, error ? error + ' Check the list again to try once more.' : 'Google sign-in is still loading. Check the list again in a moment.');
          return;
        }
        signingIn = auth.client.signIn({ chooseAccount: auth.chooseAccount });
      }
      const run = ++state.checkRun;
      state.checking = true;
      state.checked = null;
      state.lastCheck = null;
      ui.checkButton.setAttribute('aria-disabled', 'true');
      ui.checkResults.replaceChildren();
      ui.checkResults.classList.remove('stale');
      if (signingIn) {
        setText(ui.checkStatus, 'Signing in with Google…');
        try {
          await signingIn;
        } catch (e) {
          state.checking = false;
          ui.checkButton.removeAttribute('aria-disabled');
          if (run === state.checkRun) setText(ui.checkStatus, "Couldn't check the list: " + e.message);
          return;
        }
      }
      setText(ui.checkStatus, 'Checking the list…');
      const [result, aliases, byLink] = await Promise.all([
        Promise.resolve().then(() => Sheet.load(source, { fetch: win.fetch.bind(win), schoolCode: v.cfg.schoolCode, accessToken: auth ? auth.client.token() || '' : undefined })).catch(() => (
          { rows: [], tabs: [], issues: [], errors: [{ tab: null, message: "The check couldn't finish. Try again.", kind: 'network' }], sheetId: null })),
        readAliases(v.cfg.aliasesUrl),
        auth ? readableByLink(source) : false,
      ]);
      state.checking = false;
      ui.checkButton.removeAttribute('aria-disabled');
      if (auth) {
        // A sign-in that has run out, or an account that can't view the sheet: the next check signs in again (choosing
        // the account the second time).
        const errs = Array.isArray(result.errors) ? result.errors : [];
        if (errs.some(e => e.kind === 'auth' || e.kind === 'access')) auth.client.forget();
        auth.chooseAccount = errs.some(e => e.kind === 'access');
      }
      if (run !== state.checkRun) return;
      const { problems, warnings } = renderCheck(result, source, v.cfg, aliases, byLink);
      const now = buildConfigJs(validate(readForm()).cfg);
      if (now !== text) {
        setText(ui.checkStatus, 'The settings changed during the check. Check the list again before saving.');
        ui.checkResults.classList.add('stale');
        return;
      }
      state.lastCheck = text;
      if (problems.length) {
        setText(ui.checkStatus, 'The check found ' + (problems.length === 1 ? 'a problem' : plural(problems.length, 'problem', 'problems')) + ", so these settings can't be saved yet.");
      } else {
        state.checked = { text, at: new Date(), tabs: result.tabs.length, items: result.rows.length, warnings: warnings.length, saved: false };
        setText(ui.checkStatus, checkedStatus());
      }
    }

    // Shows what the check read, tab by tab. Returns the problems that block saving and the warnings that don't
    // (plain sentences).
    function renderCheck(result, source, cfg, aliases, byLink) {
      const out = ui.checkResults;
      const problems = [], warnings = [];
      const errors = Array.isArray(result.errors) ? result.errors : [];
      for (const e of errors) {
        problems.push(sentence((e.tab ? e.tab + ': ' : '') + str(e.message)) +
          (e.kind === 'access' ? ' Check the list again to sign in with an account that can view it.' : e.kind === 'auth' ? ' Check the list again to sign in.' : ''));
      }
      const tabs = Array.isArray(result.tabs) ? result.tabs : [];
      if (!tabs.length && !errors.length) problems.push('No tab with a list was found.');
      if (source.kind === 'script' && result.sheetId && source.sheetId && result.sheetId !== source.sheetId) {
        problems.push('The script reads a different spreadsheet (' + shortId(result.sheetId) + ') from the one in the sheet link (' + shortId(source.sheetId) + '). Make the sheet link point at the sheet the script reads.');
      }
      out.append(el('p', { class: 'check-source' }, source.kind === 'script'
        ? 'Read through the Apps Script web app' + (result.sheetId ? ', from spreadsheet ' + shortId(result.sheetId) : '') + '.'
        : source.kind === 'api'
          ? 'Read with your Google sign-in from spreadsheet ' + shortId(source.sheetId) + ', as each visitor will read it with theirs.'
          : 'Read by link from spreadsheet ' + shortId(source.sheetId) + '.'));
      if (byLink) {
        warnings.push('This sheet is also shared "Anyone with the link can view", so anyone with its link can read it without signing in. ' +
          'For sign-in to keep out people without access, turn off link sharing in the sheet (Share, General access).');
      }
      // The Apps Script reader answers anyone who has its address, whatever these settings say, until it is archived.
      const oldScript = state.base && Sheet.parseScriptUrl(str(state.base.scriptUrl));
      if (oldScript && !cfg.scriptUrl) {
        warnings.push('The current settings read through an Apps Script reader, which keeps answering anyone who has its address after this change. ' +
          "Once the new settings work, archive its deployment (in the script: Deploy, Manage deployments, Archive). See apps-script/README.md.");
      }
      // The school's code, as the search page matches it: rows with it show "Banned by <code>".
      const code = str(cfg.schoolCode);
      const ours = result.rows.filter(r => r && r.status && r.status.level === 'uas').length;
      if (result.rows.length) {
        out.append(el('p', { class: 'check-source' }, "The school's code, " + code + ', is in the Banned By column of ' + plural(ours, 'item', 'items') + '.'));
        if (!ours) warnings.push("No item has the school's code, " + code + ', in its Banned By column, so no result would show "Banned by ' + code + '". Check the school\'s Banned By code.');
      }
      if (aliases && aliases.problem) warnings.push(aliases.problem);
      else if (aliases) out.append(el('p', { class: 'check-source' }, 'Alias list ' + aliases.path + ': ' + plural(aliases.count, 'entry', 'entries') + '.'));
      let at = 0;
      for (const t of tabs) {
        const n = Number(t.rowCount) || 0;
        const tabRows = result.rows.slice(at, at + n);
        at += n;
        if (!n) problems.push(sentence(str(t.tab) + ': no items below the header row'));
        // The tab's own name in the sheet (Google sends it with the export; it is cut at its last " - "). A different
        // name may be on purpose, or a mix-up of tab ids.
        const own = str(t.sheetTabName);
        const renamed = own && str(t.tab) !== own && !str(t.tab).endsWith(' - ' + own);
        if (renamed) {
          warnings.push('Tab id ' + t.gid + ' is named "' + own + '" in the sheet, but these settings call it "' + str(t.tab) + '". Check the tab id, and the name results cite it by.');
        }
        const issues = (Array.isArray(result.issues) ? result.issues : []).filter(i => i.tab === t.tab).length;
        const headers = (Array.isArray(t.headers) ? t.headers : []).filter(h => str(h).trim());
        const box = el('section', { class: 'check-tab' + (n ? '' : ' check-bad') },
          el('h3', null, str(t.tab), t.gid !== '' && t.gid != null
            ? el('span', { class: 'muted' }, ' (tab id ' + t.gid + (renamed ? ', named "' + own + '" in the sheet' : '') + ')') : null),
          el('ul', null,
            el('li', null, plural(n, 'item', 'items')),
            el('li', null, 'Header row ' + t.headerRow + ': ' + headers.join(', ')),
            el('li', null, t.updatedAsOf ? '"' + str(t.updatedAsOf).trim() + '" (from the sheet)' : 'No "updated as of" line above the header row.'),
            tabRows.length ? el('li', null, 'First ' + (tabRows.length === 1 ? 'item' : plural(Math.min(3, tabRows.length), 'item', 'items')) + ':',
              el('ol', { class: 'first-titles' }, ...tabRows.slice(0, 3).map(r => el('li', null, str(r.title) || '(no title)')))) : null,
            el('li', null, issues ? plural(issues, 'data-quality note', 'data-quality notes') + ' (the search page lists them under "Notes for the list\'s maintainers")' : 'No data-quality notes.')));
        out.append(box);
      }
      if (problems.length) {
        out.append(el('div', { class: 'check-problems' }, el('h3', null, 'Problems'), el('ul', null, ...problems.map(p => el('li', null, p)))));
      }
      if (warnings.length) {
        out.append(el('div', { class: 'check-warnings' }, el('h3', null, 'Warnings'),
          el('p', null, "These don't stop saving, but look at them first."), el('ul', null, ...warnings.map(w => el('li', null, w)))));
      }
      return { problems, warnings };
    }

    // -------------------------------------------------------------------------------------------
    // Save

    function tokenProblem(msg) {
      setText(ui.tokenError, msg);
      ui.tokenError.hidden = !msg;
      ui.token.setAttribute('aria-describedby', msg ? 'token-help token-error' : 'token-help');
      if (msg) ui.token.setAttribute('aria-invalid', 'true'); else ui.token.removeAttribute('aria-invalid');
    }

    function saveStatus(text) { setText(ui.saveStatus, text); }

    async function runSave() {
      if (state.saving) return;
      state.attempted = true;
      const v = update();
      tokenProblem('');
      ui.saveLinks.hidden = true;
      ui.saveLinks.replaceChildren();
      if (v.errors.length) {
        saveStatus('Fix the problems marked above first.');
        focusFirstError(v.errors);
        return;
      }
      const text = buildConfigJs(v.cfg);
      if (state.servedText == null) { saveStatus(GH.noCurrent); return; }
      if (text === state.servedText) { saveStatus('Nothing to save: these settings are already in config.js.'); return; }
      if (!state.checked || state.checked.text !== text) {
        saveStatus('Check the list first: saving needs a successful check of exactly these settings.');
        ui.checkButton.focus();
        return;
      }
      const repo = parseRepoUrl(str(v.cfg.repoUrl));
      if (!repo) { saveStatus(GH.noRepo); return; }
      if (!ui.token.value.trim()) {
        tokenProblem(GH.noToken);
        saveStatus('Paste a GitHub token first.');
        ui.token.focus();
        return;
      }
      state.saving = true;
      stopPoll();
      setText(ui.publishStatus, '');
      ui.saveButton.setAttribute('aria-disabled', 'true');
      saveStatus('Saving…');
      let result;
      try {
        result = await githubSave({
          token: ui.token.value, owner: repo.owner, repo: repo.repo, content: text, message: SAVE_MESSAGE,
          expectedCurrent: state.servedText, fetch: win.fetch.bind(win), now: () => Date.now(), onProgress: saveStatus,
        });
      } catch (e) {
        result = { ok: false, kind: 'unexpected', message: 'Saving stopped unexpectedly, so this page can\'t tell whether config.js was saved. Reload the page in a minute to see.' };
      }
      state.saving = false;
      ui.saveButton.removeAttribute('aria-disabled');
      if (!result.ok) {
        saveStatus(result.message);
        if (result.kind === 'auth' || result.kind === 'token') { tokenProblem(result.message); ui.token.focus(); }
        return;
      }
      ui.token.value = '';
      tokenProblem('');
      state.servedText = text;
      state.base = Object.assign({}, v.cfg);
      renderCurrent();
      update();
      if (state.checked) { state.checked.saved = true; setText(ui.checkStatus, checkedStatus()); }
      saveStatus('Saved to ' + result.where + '.');
      const link = extLink(result.commitUrl, 'See the change on GitHub');
      if (link) { ui.saveLinks.append(link); ui.saveLinks.hidden = false; }
      startPoll(text, repo, result);
    }

    // After a save: wait until the site serves the new config.js (GitHub Pages usually takes a minute or two). Each
    // read uses cache: 'reload', so once the new file is live it is also the copy in this browser's cache.
    function stopPoll() {
      if (state.poll) { win.clearTimeout(state.poll.timer); state.poll = null; }
    }

    function startPoll(text, repo, saved) {
      stopPoll();
      const poll = { timer: 0, started: Date.now() };
      state.poll = poll;
      setText(ui.publishStatus, 'Publishing… GitHub Pages usually takes a minute or two.');
      const tick = async () => {
        let live = false;
        try {
          const res = await win.fetch(configUrl(), { cache: 'reload', credentials: 'same-origin' });
          live = !!res && res.ok && (await res.text()) === text;
        } catch (e) { live = false; }
        if (state.poll !== poll) return;
        if (live) {
          state.poll = null;
          setText(ui.publishStatus, LIVE_TEXT);
          return;
        }
        if (Date.now() - poll.started >= POLL_FOR) {
          state.poll = null;
          const parts = ["It's taking longer than usual: it may take a few more minutes. ",
            extLink('https://github.com/' + repo.owner + '/' + repo.repo + '/actions', "See GitHub's publishing progress"), '.'];
          // Saved to the default branch: GitHub didn't say that this is the branch the site is published from.
          if (saved && saved.branchFrom === 'default') {
            parts.push(' This page saved to the default branch, ' + saved.branch + ": if the site is published from another branch, the change won't go live until config.js is changed there too.");
          }
          ui.publishStatus.replaceChildren(...parts);
          return;
        }
        poll.timer = win.setTimeout(tick, POLL_EVERY);
      };
      poll.timer = win.setTimeout(tick, POLL_EVERY);
    }

    // -------------------------------------------------------------------------------------------
    // Start

    function bind() {
      ui.form.addEventListener('submit', e => e.preventDefault());
      ui.saveForm.addEventListener('submit', e => { e.preventDefault(); runSave(); });
      ui.form.addEventListener('input', e => {
        if (e.target === ui.tabLink) return;
        if (e.target === ui.sheetUrl) pickUpGid();
        update();
      });
      ui.form.addEventListener('change', e => {
        if (e.target === ui.tabLink) return;
        if (e.target && e.target.id) state.touched.add(e.target.id);
        update();
      });
      ui.tabAdd.addEventListener('click', () => { const row = addRow('', ''); update(); row.gid.focus(); });
      ui.tabLinkAdd.addEventListener('click', addFromLink);
      ui.tabLink.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFromLink(); } });
      ui.checkButton.addEventListener('click', runCheck);
      ui.saveButton.addEventListener('click', runSave);
      ui.token.addEventListener('input', () => { if (!ui.tokenError.hidden) tokenProblem(''); });
    }

    if (!Sheet || !SignIn) {
      setText(ui.pageStatus, "The page's scripts didn't load, so the settings can't be changed here. Reload the page to try again.");
      return;
    }
    loadCurrent().then(({ cfg, text }) => {
      if (!cfg) {
        setText(ui.pageStatus, "config.js didn't load as settings, so this page can't show or change them. Reload the page; if that doesn't help, fix config.js on GitHub by hand.");
        return;
      }
      state.base = cfg;
      state.servedText = text;
      state.extra = {};
      for (const k of extraKeys(cfg)) state.extra[k] = cfg[k];
      renderCurrent();
      fillForm(cfg);
      bind();
      if (text == null) {
        setText(ui.pageStatus, "Couldn't read config.js from this site just now, so saving is off. You can still check settings. Reload the page to try again.");
      } else {
        setText(ui.pageStatus, '');
        ui.pageStatus.hidden = true;
        if (buildConfigJs(cfg) !== text) {
          setText(ui.currentNote, "config.js has been edited by hand in a layout this page doesn't write. Saving rewrites the whole file in the usual layout: the changes under \"Review and save\" show every line that would change.");
          ui.currentNote.hidden = false;
        }
      }
      ui.form.hidden = false;
      ui.checkSection.hidden = false;
      ui.saveSection.hidden = false;
      update();
    });
  }

  return {
    buildConfigJs, jsString, validate, sourceFor, diffLines, diffHunks, b64EncodeUtf8, b64DecodeUtf8, parseRepoUrl,
    githubSave, tokenPageUrl, extraKeys, start,
    KNOWN_KEYS, LIVE_TEXT, messages: MSG, githubMessages: GH,
  };
});
