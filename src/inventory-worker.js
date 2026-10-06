// A Web Worker for the inventory check (inventory.html): builds the search index of the banned list once, then checks
// jobs of inventory items off the page's main thread, so the page stays usable while tens of thousands of titles are
// checked. Answers name banned rows by id (their place in the list the page sent) rather than copying them back.
/* global importScripts, CensorEngine, CensorInventory */
'use strict';
importScripts('sheet.js', 'engine.js', 'inventory.js');

let ix = null;
self.onmessage = e => {
  const m = e.data || {};
  try {
    if (m.type === 'index') {
      ix = CensorEngine.buildIndex(m.rows || [], m.aliases ? { aliases: m.aliases } : {});
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'check') {
      if (!ix) throw new Error('no index');
      self.postMessage({ type: 'done', job: m.job, results: (m.items || []).map(it => CensorInventory.compact(CensorInventory.checkItem(ix, it))) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', job: m.job, message: err && err.message ? err.message : String(err) });
  }
};
