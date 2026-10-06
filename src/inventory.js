// CensorInventory: checks a classroom inventory sheet (one tab per classroom, a Title column and usually an Author
// column) against the banned list, for the inventory page (inventory.html). Reads a tab's cells into items, checks
// each item with the search engine, and turns the outcome into the report's summary, CSV files and the optional
// results tab. No DOM; works in the browser (window.CensorInventory), in a Web Worker and in Node.
//
// Matching is stricter than the search box: an inventory has hundreds of ordinary titles ("Little Suite", "Dark
// Adventure"), so only the main tier counts (never "possible"), and a hit must match the item's title, not just a
// surname. "Likely banned": the title and author both match, the same title (the author not given on either side),
// a listing of the whole series the title belongs to, or the same ISBN. "Worth a look": any other main-tier title match, such as the same title by another author.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sheet.js'), require('./engine.js'));
  else root.CensorInventory = factory(root.CensorSheet, root.CensorEngine);
})(typeof self !== 'undefined' ? self : this, function (Sheet, Engine) {
  'use strict';

  const RESULTS_TAB = 'CensorSearch results';
  const MAX_HITS = 5;                  // banned entries kept per item; the rest are counted
  const SEARCH = { enter: true, finished: true };

  const str = v => (v == null ? '' : typeof v === 'string' ? v : String(v));
  const blank = v => (Sheet && Sheet.isBlank ? Sheet.isBlank(v) : !str(v).trim());
  const hasText = s => /[\p{L}\p{N}]/u.test(str(s));

  // ---------------------------------------------------------------------------------------------
  // Reading one tab

  // values: the tab's cells as Google's values API gives them (rows of displayed strings, from row 1).
  // Returns { items: [{ row, title, author, isbn }], room, checked, headerRow, lastCol, noTitle, notes } or { error }.
  function parseTab(values, opts) {
    const o = opts || {};
    const grid = Array.isArray(values) ? values : [];
    const records = grid.map((cells, i) => ({ row: i + 1, cells: (Array.isArray(cells) ? cells : []).map(str) }));
    let part;
    try {
      part = Sheet.extractRows({ tab: str(o.tab) || 'Sheet', gid: str(o.gid), sheetId: str(o.sheetId), records }, { schoolCode: '' });
    } catch (e) {
      return { error: e && e.kind ? e.message : Sheet.messages.noHeader };
    }
    const headerRow = part.meta.headerRow;
    const items = [];
    let noTitle = 0;
    for (const r of part.rows) {
      if (!hasText(r.title) && !hasText(r.isbn)) { noTitle++; continue; }
      items.push({ row: r.row, title: r.title.trim(), author: r.author.trim(), isbn: r.isbn.trim() });
    }
    const notes = [];
    if (part.meta.mapping.author < 0) notes.push('No Author column found, so titles were checked on their own.');
    return Object.assign({ items, headerRow, lastCol: part.meta.lastCol, noTitle, notes }, banner(records.filter(r => r.row < headerRow)));
  }

  // The rows above the header: the room ("Ms. Bidour : Rm. G 44 Maker Space") and the "Checked and updated by / Date:"
  // line with whatever is written beside it (or after its colon). checked.value is '' when nobody filled it in.
  function banner(records) {
    let room = '', checked = null;
    for (const r of records) {
      const cells = r.cells.map(c => c.trim()).filter(c => !blank(c));
      if (!cells.length) continue;
      const i = cells.findIndex(c => /\b(?:checked|updated|reviewed)\b/i.test(c));
      if (i >= 0 && !checked) {
        const label = cells[i];
        const after = /:\s*(\S[\s\S]*)$/.exec(label);
        const rest = cells.filter((c, j) => j !== i);
        checked = { label: (after ? label.slice(0, after.index + 1) : label).trim(), value: (after ? [after[1]].concat(rest) : rest).join(' ').trim() };
      } else if (i < 0 && !room) room = cells[0];
    }
    return { room, checked };
  }

  // ---------------------------------------------------------------------------------------------
  // Checking one item

  // Notes in brackets after a title ("March from Aida (photocopies)") are left out of the search; "(Un)Wanted" stays.
  const cleanTitle = t => str(t).replace(/\s+[([][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const isbnOf = s => { const d = str(s).replace(/[\s‐-―-]+/g, '').replace(/^ISBN(?:1[03])?:?/i, ''); return /^(?:\d{9}[\dXx]|\d{13})$/.test(d) ? d : ''; };
  // Title compared without articles, case, punctuation or bracketed notes: "Giver, The" = "The Giver".
  function titleKey(t) {
    const shown = Engine.normalizeTitleForDisplay(cleanTitle(t));
    return Engine.fold(shown).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^(?:the|a|an) /, '');
  }
  const has = (hit, field) => Array.isArray(hit.fields) && hit.fields.includes(field);
  const series = hit => (Array.isArray(hit.reasons) ? hit.reasons : []).some(r => /^covers a whole series: its series name/.test(r));
  const spelling = hit => (Array.isArray(hit.reasons) ? hit.reasons : []).filter(r => /^(?:similar spelling|written as|via alias)/.test(r));

  // ix: Engine.buildIndex of the banned list. Returns { verdict: 'likely'|'look'|'clear'|'skipped', hits: [{ row,
  // strength: 'likely'|'look', why: [..] }], more: n }. hits keep the engine's row objects.
  function checkItem(ix, item) {
    const title = cleanTitle(item && item.title), author = str(item && item.author).trim(), isbn = isbnOf(item && item.isbn);
    const found = new Map();
    let n = 0;
    const add = (hit, strength, why) => {
      const id = hit.row.id != null ? hit.row.id : hit.row;
      const cur = found.get(id);
      if (cur && (cur.strength === 'likely' || strength === 'look')) return;
      found.set(id, { row: hit.row, strength, why: why.concat(spelling(hit)), order: cur ? cur.order : n++ });
    };

    let skipped = !hasText(title) && !isbn;
    if (isbn) for (const h of Engine.search(isbn, ix, SEARCH).main) if (has(h, 'isbn')) add(h, 'likely', ['same ISBN']);
    if (hasText(title)) {
      const t = Engine.search(title, ix, SEARCH);
      const a = author && hasText(author) ? Engine.search(title + ' by ' + author, ix, SEARCH) : null;
      if (t.state === 'stopwordsOnly' && !t.main.length) skipped = !isbn;
      const both = a ? a.main.filter(h => has(h, 'title')) : [];
      for (const h of both) add(h, 'likely', ['title and author match']);
      const inBoth = new Set(both.map(h => h.row));
      const key = titleKey(title);
      for (const h of t.main) {
        if (!has(h, 'title') || inBoth.has(h.row)) continue;
        const same = titleKey(h.row.title) === key;
        const listedAuthor = hasText(h.row.author);
        if (series(h)) add(h, 'likely', ['the listing covers the whole series']);
        else if (same && (!author || !listedAuthor)) add(h, 'likely', ['same title']);
        else if (same) add(h, 'look', ['same title, different author']);
        else if (h.tier === 'match' || !a || both.length) add(h, 'look', ['similar title']);
        // A title that only nearly matches, by an author the list doesn't give for it, is left out ("Dark Adventure" by
        // Ford is not "Adventures of Tom Sawyer").
      }
    }
    const all = [...found.values()].sort((x, y) => (x.strength === y.strength ? x.order - y.order : x.strength === 'likely' ? -1 : 1));
    const hits = all.slice(0, MAX_HITS).map(x => ({ row: x.row, strength: x.strength, why: [...new Set(x.why)] }));
    const verdict = hits.length ? hits[0].strength : skipped ? 'skipped' : 'clear';
    return { verdict, hits, more: all.length - hits.length };
  }

  // For a worker's answer: banned rows by their id (their place in the loaded list), so they needn't be copied.
  const compact = r => ({ verdict: r.verdict, more: r.more, hits: r.hits.map(h => ({ id: h.row.id, strength: h.strength, why: h.why })) });
  const expand = (r, rows) => ({ verdict: r.verdict, more: r.more, hits: r.hits.map(h => ({ row: rows[h.id], strength: h.strength, why: h.why })).filter(h => h.row) });

  // ---------------------------------------------------------------------------------------------
  // The report

  // tabs: [{ gid, title, parsed (parseTab's answer), results: [checkItem answers, one per parsed.items] }]
  // Returns { tabs: [{ gid, title, room, checked, items, likely, look, skipped, noTitle, notes, error, findings }], totals }.
  function report(tabs) {
    const totals = { tabs: 0, read: 0, items: 0, likely: 0, look: 0, tabsWithLikely: 0, tabsWithLook: 0, failed: 0 };
    const out = (Array.isArray(tabs) ? tabs : []).map(t => {
      const p = t.parsed || {};
      const base = { gid: str(t.gid), title: str(t.title), room: str(p.room), checked: p.checked || null, headerRow: p.headerRow || null,
        lastCol: p.lastCol || 'B', items: 0, likely: 0, look: 0, skipped: 0, noTitle: p.noTitle || 0, notes: p.notes || [], error: p.error || '', findings: [] };
      totals.tabs++;
      if (p.error) { totals.failed++; return base; }
      totals.read++;
      const items = p.items || [], results = t.results || [];
      items.forEach((item, i) => {
        const r = results[i] || { verdict: 'skipped', hits: [], more: 0 };
        base.items++;
        if (r.verdict === 'likely') base.likely++;
        else if (r.verdict === 'look') base.look++;
        else if (r.verdict === 'skipped') base.skipped++;
        if (r.verdict === 'likely' || r.verdict === 'look') base.findings.push({ item, verdict: r.verdict, hits: r.hits, more: r.more });
      });
      totals.items += base.items; totals.likely += base.likely; totals.look += base.look;
      if (base.likely) totals.tabsWithLikely++;
      if (base.look) totals.tabsWithLook++;
      return base;
    });
    return { tabs: out, totals };
  }

  const VERDICT = { likely: 'Likely banned', look: 'Worth a look' };
  const statusOf = row => (row && row.status && row.status.label) || 'Status not stated';

  // One line per banned entry an item matched. links: { inventory(sheet tab, row), list(banned row) } -> url or ''.
  function resultGrid(rep, links) {
    const L = links || {};
    const head = ['Tab', 'Classroom', 'Row', 'Title', 'Author', 'Result', 'On the banned list as', 'Listed author', 'Banned by',
      'Status', 'Why', 'Inventory row', 'Banned list row'];
    const lines = [head];
    for (const t of rep.tabs) {
      for (const f of t.findings) {
        for (const h of f.hits) {
          lines.push([t.title, t.room, String(f.item.row), f.item.title, f.item.author, VERDICT[h.strength], str(h.row.title), str(h.row.author),
            str(h.row.bannedBy), statusOf(h.row), h.why.join('; '), L.inventory ? L.inventory(t, f.item.row) : '', L.list ? L.list(h.row) : '']);
        }
        if (f.more) lines.push([t.title, t.room, String(f.item.row), f.item.title, f.item.author, VERDICT[f.verdict], '…and ' + f.more + ' more', '', '', '', '', '', '']);
      }
    }
    return lines;
  }

  function summaryGrid(rep) {
    const lines = [['Tab', 'Classroom', 'Titles checked', 'Likely banned', 'Worth a look', 'Rows without a title', 'Checked and updated by', 'Problem']];
    for (const t of rep.tabs) {
      lines.push([t.title, t.room, t.error ? '' : String(t.items), t.error ? '' : String(t.likely), t.error ? '' : String(t.look),
        t.error ? '' : String(t.noTitle), t.checked ? t.checked.value : '', t.error || t.notes.join(' ')]);
    }
    return lines;
  }

  // CSV that spreadsheet programs open safely: a cell starting with = + - @ (or a tab or return) gets a leading
  // apostrophe, so a title can't run as a formula.
  function toCsv(grid) {
    const cell = v => {
      let s = str(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + grid.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  // The results tab written into the inventory sheet: a heading line, the results, then the summary.
  function sheetGrid(rep, links, when) {
    const head = 'CensorSearch results, checked ' + str(when) + '. Checking again replaces this tab; the classroom tabs are not changed.';
    const res = resultGrid(rep, links);
    const width = res[0].length;
    const pad = r => r.concat(new Array(Math.max(0, width - r.length)).fill(''));
    const rows = [pad([head]), pad([])].concat(res.length > 1 ? res : [res[0], pad(['Nothing on the banned list matched these tabs.'])]);
    rows.push(pad([]), pad(['Summary']));
    for (const r of summaryGrid(rep)) rows.push(pad(r));
    return rows;
  }

  // Splits items into jobs of about `size` for the workers, keeping each job inside one tab.
  function jobs(tabs, size) {
    const out = [];
    tabs.forEach((t, ti) => {
      const items = (t.parsed && t.parsed.items) || [];
      for (let i = 0; i < items.length; i += size) out.push({ tab: ti, start: i, items: items.slice(i, i + size) });
    });
    return out;
  }

  return { RESULTS_TAB, MAX_HITS, parseTab, banner, checkItem, titleKey, cleanTitle, compact, expand, report, resultGrid, summaryGrid, sheetGrid, toCsv, jobs, VERDICT };
});
