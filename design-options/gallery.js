// The compare page: one frame per prototype (see options.js), all driven by the one search box above them.
// The frames are same-origin copies of the real page, so typing here sets each page's own search box and fires
// the same input event a person's typing would.
(function () {
  'use strict';

  const OPTIONS = window.DESIGN_OPTIONS || [];
  const PRESETS = [
    { label: 'Before typing', value: '' },
    { label: 'One clear match', value: 'orwell' },
    { label: 'Match + possible', value: 'orwell 1984' },
    { label: 'Similar spelling', value: 'fahrenheit 451' },
    { label: 'Case by case', value: 'jokes' },
    { label: 'Not found', value: 'harry potter' },
    { label: 'Reading list', value: "the alchemist\nfahrenheit 451\ncharlotte's web\norwell\n7 habits" },
  ];

  const frames = document.getElementById('frames');
  const box = document.getElementById('all-q');
  const iframes = [];

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const k of Object.keys(attrs || {})) node.setAttribute(k, attrs[k]);
    node.append(...children);
    return node;
  }

  for (const o of OPTIONS) {
    const href = o.slug + '/';
    const frame = el('iframe', { src: href, title: o.name, loading: 'eager' });
    frame.addEventListener('load', () => { applyScheme(frame); send(frame); });
    iframes.push(frame);
    frames.append(el('section', { class: 'option' },
      el('div', { class: 'option-head' },
        el('h2', null, el('span', { class: 'option-kind' }, o.kind), o.name),
        el('a', { href, target: '_blank', rel: 'noopener' }, 'Open full page')),
      el('p', null, o.oneLiner),
      frame));
  }

  function send(frame) {
    try {
      const q = frame.contentDocument && frame.contentDocument.getElementById('q');
      if (!q || q.value === box.value) return;
      q.value = box.value;
      q.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true }));
    } catch (e) { /* a frame that is still loading picks the value up on its load event */ }
  }
  const sendAll = () => iframes.forEach(send);

  function grow() {
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight + 2, 128) + 'px';
  }

  box.addEventListener('input', () => { grow(); sendAll(); });

  const presets = document.getElementById('presets');
  for (const p of PRESETS) {
    const b = el('button', { type: 'button' }, p.label);
    b.addEventListener('click', () => { box.value = p.value; grow(); sendAll(); });
    presets.append(b);
  }

  // Light / Dark: the prototypes follow prefers-color-scheme, which a page can't set for its frames. So each frame's
  // own "@media (prefers-color-scheme: …)" rules are switched on or off through the CSSOM (same origin), which shows
  // exactly what a person with that setting would see.
  const SCHEME = /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/g;
  const originalMedia = new WeakMap();

  function applyScheme(frame) {
    const scheme = frames.getAttribute('data-scheme');
    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      const walk = rules => {
        for (const rule of Array.from(rules)) {
          if (rule.media && rule.cssRules) {
            if (!originalMedia.has(rule)) originalMedia.set(rule, rule.media.mediaText);
            const original = originalMedia.get(rule);
            if (SCHEME.test(original)) rule.media.mediaText = original.replace(SCHEME, (m, s) => (s === scheme ? 'all' : 'not all'));
            SCHEME.lastIndex = 0;
          }
          if (rule.cssRules) walk(rule.cssRules);
        }
      };
      for (const sheet of Array.from(doc.styleSheets)) walk(sheet.cssRules);
      doc.documentElement.style.colorScheme = scheme;
    } catch (e) { /* a frame that is still loading is handled on its load event */ }
  }

  function segmented(attr, onChange) {
    const buttons = Array.from(document.querySelectorAll('button[data-' + attr + ']'));
    const set = value => {
      frames.setAttribute('data-' + attr, value);
      buttons.forEach(x => x.setAttribute('aria-pressed', String(x.getAttribute('data-' + attr) === value)));
      if (onChange) onChange();
    };
    for (const b of buttons) b.addEventListener('click', () => set(b.getAttribute('data-' + attr)));
    return set;
  }
  segmented('width')('phone');
  segmented('scheme', () => iframes.forEach(applyScheme))(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
})();
