// Screenshot driver for the design prototypes, used by shot.sh with headless Chrome.
// shot.html?slug=<folder>&w=<px>&scheme=light|dark&q=<search text, \n for line breaks>&open=<css selector of <details> to open>&y=<scroll px>&focus=<css selector>&blur=1&fail=1
// fail=1 points the page at a sheet that doesn't exist, which shows the load-failure state and the "another sheet" note.
// Loads the prototype in a same-origin frame of the asked width, waits for the list, types the query the way a
// person would (value + input event), then writes a small JSON report into #report (read with --dump-dom).
(function () {
  'use strict';
  const p = new URLSearchParams(location.search);
  const slug = p.get('slug') || 'current';
  const width = parseInt(p.get('w') || '375', 10);
  const scheme = p.get('scheme') === 'dark' ? 'dark' : 'light';
  const query = (p.get('q') || '').replace(/\\n/g, '\n');
  const frame = document.getElementById('f');
  const report = { slug, width, scheme, query, errors: [], csp: [], overflow: [], status: '', done: false };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const SCHEME = /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/g;

  function forceScheme(doc) {
    const walk = rules => {
      for (const rule of Array.from(rules)) {
        if (rule.media && rule.cssRules) {
          const original = rule.media.mediaText;
          if (SCHEME.test(original)) rule.media.mediaText = original.replace(SCHEME, (m, s) => (s === scheme ? 'all' : 'not all'));
          SCHEME.lastIndex = 0;
        }
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    for (const sheet of Array.from(doc.styleSheets)) walk(sheet.cssRules);
    doc.documentElement.style.colorScheme = scheme;
  }

  frame.style.width = width + 'px';
  frame.addEventListener('load', async () => {
    const win = frame.contentWindow, doc = frame.contentDocument;
    win.addEventListener('error', e => report.errors.push(String(e.message)));
    doc.addEventListener('securitypolicyviolation', e => report.csp.push(e.violatedDirective + ' ' + e.blockedURI));
    try { forceScheme(doc); } catch (e) { report.errors.push('scheme: ' + e.message); }
    const status = doc.getElementById('status');
    for (let i = 0; i < 100 && status && /^Loading/.test(status.textContent); i++) await sleep(100);
    report.status = status ? status.textContent : '(no #status)';
    const q = doc.getElementById('q');
    if (q && query) {
      q.focus();
      q.value = query;
      q.dispatchEvent(new win.Event('input', { bubbles: true }));
      await sleep(700);
    }
    if (p.get('open')) for (const d of doc.querySelectorAll(p.get('open'))) d.open = true;
    if (p.get('focus')) { const t = doc.querySelector(p.get('focus')); if (t) t.focus(); }
    if (p.get('blur') && doc.activeElement) doc.activeElement.blur();
    await sleep(100);
    if (p.get('y')) win.scrollTo(0, parseInt(p.get('y'), 10));
    // Anything wider than the frame makes the page scroll sideways on a phone.
    const vw = doc.documentElement.clientWidth;
    report.pageScrollWidth = doc.documentElement.scrollWidth;
    report.pageHeight = doc.documentElement.scrollHeight;
    for (const node of doc.querySelectorAll('body *')) {
      const r = node.getBoundingClientRect();
      if (r.width && (r.right > vw + 1 || r.left < -1) && !node.closest('.visually-hidden')) {
        report.overflow.push(node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (node.className && typeof node.className === 'string' ? '.' + node.className.trim().replace(/\s+/g, '.') : '') + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + vw + ']');
        if (report.overflow.length >= 12) break;
      }
    }
    report.text = doc.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 6000);
    report.done = true;
    document.getElementById('report').textContent = JSON.stringify(report, null, 1);
    document.title = 'ready';
  });
  const BOGUS = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd/edit#gid=0';
  frame.src = slug + '/' + (p.get('fail') ? '?sheet=' + encodeURIComponent(BOGUS) : '');
})();
