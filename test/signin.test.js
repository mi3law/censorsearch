// Tests for src/signin.js (CensorSignIn): loading Google's script once, the token's life, and Google's errors in plain
// words. Google Identity Services is a fake (test/helpers/google.js); every token is a made-up string.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SignIn = require('../src/signin.js');
const G = require('./helpers/google.js');

const tick = () => new Promise(r => setImmediate(r));

// A window with a document that records the scripts added to it; `onScript(el)` decides what loading one does.
function fakeWin(onScript) {
  const added = [];
  const timers = [];
  const el = () => {
    const listeners = {};
    const node = {
      attrs: {}, removed: false,
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      fire(t) { for (const fn of listeners[t] || []) fn({ type: t }); },
      remove() { this.removed = true; },
    };
    return node;
  };
  const win = {
    document: { createElement: el, head: { append(s) { added.push(s); if (onScript) onScript(s, win); } } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
  };
  win.added = added;
  win.timers = timers;
  return win;
}

test('isClientId accepts a web client ID only', () => {
  assert.equal(SignIn.isClientId(G.CLIENT_ID), true);
  assert.equal(SignIn.isClientId('  ' + G.CLIENT_ID + ' '), true);
  for (const bad of ['', null, G.FAKE_SECRET, 'abc' + '.apps.googleusercontent' + '.com', G.CLIENT_ID + '.evil.example', G.CLIENT_ID.toUpperCase(), 'x' + G.CLIENT_ID]) {
    assert.equal(SignIn.isClientId(bad), false, String(bad));
  }
});

test("load adds Google's script once per window, shared by every client, and reports a script that can't load", async () => {
  const win = fakeWin((s, w) => setImmediate(() => { w.google = G.fakeGis(); s.fire('load'); }));
  const a = SignIn.create(win, G.CLIENT_ID), b = SignIn.create(win, G.CLIENT_ID);
  assert.equal(a.ready(), false);
  await Promise.all([a.load(), b.load(), SignIn.loadGis(win)]);
  assert.equal(win.added.length, 1);
  assert.equal(win.added[0].attrs.src, 'https://accounts.google.com/gsi/client');
  assert.equal(a.ready(), true);
  assert.equal(SignIn.isReady(win), true);
  await a.load();
  assert.equal(win.added.length, 1, 'already loaded');

  const blocked = fakeWin(s => setImmediate(() => s.fire('error')));
  const c = SignIn.create(blocked, G.CLIENT_ID);
  await assert.rejects(c.load(), e => e.code === 'load' && e.message === SignIn.messages.load);
  assert.equal(blocked.added[0].removed, true);
  await assert.rejects(c.load());
  assert.equal(blocked.added.length, 2, 'a later try adds the script again');

  const stalled = fakeWin(() => {});
  const p = SignIn.create(stalled, G.CLIENT_ID).load();
  stalled.timers[0].fn();   // 20 seconds pass
  await assert.rejects(p, e => e.code === 'load');
});

test('signIn: a token for the read-only scope, kept until a minute before it runs out; forget drops it', async () => {
  const win = fakeWin();
  win.google = G.fakeGis([{ access_token: G.TOKEN, expires_in: 3599, scope: G.SCOPE }]);
  const c = SignIn.create(win, G.CLIENT_ID);
  assert.equal(c.token(), null);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await c.signIn();
    assert.deepEqual(win.google.requests, [{ clientId: G.CLIENT_ID, scope: G.SCOPE, prompt: '' }]);
    assert.equal(c.token(), G.TOKEN);
    now += 3599 * 1000 - 61 * 1000;
    assert.equal(c.token(), G.TOKEN);
    now += 2000;
    assert.equal(c.token(), null, 'less than a minute left');
    await c.signIn({ chooseAccount: true });
    assert.equal(win.google.requests[1].prompt, 'select_account');
    assert.equal(c.token(), G.TOKEN);
    c.forget();
    assert.equal(c.token(), null);
  } finally {
    Date.now = realNow;
  }
});

test("signIn: Google's errors, a closed or blocked window, and a permission left unticked become plain sentences", async () => {
  const cases = [
    [{ error: 'access_denied' }, 'access_denied', SignIn.messages.denied],
    [{ error: 'admin_policy_enforced' }, 'admin_policy_enforced', SignIn.messages.admin],
    [{ error: 'org_internal' }, 'org_internal', SignIn.messages.internal],
    [{ error: 'something_new' }, 'something_new', SignIn.messages.failed],
    [{ popup: 'popup_closed' }, 'popup_closed', SignIn.messages.popupClosed],
    [{ popup: 'popup_failed_to_open' }, 'popup_failed_to_open', SignIn.messages.popupBlocked],
    [{ access_token: G.TOKEN, expires_in: 3599, scope: 'openid' }, 'scope', SignIn.messages.scope],
  ];
  for (const [answer, code, message] of cases) {
    const win = fakeWin();
    win.google = G.fakeGis([answer]);
    const c = SignIn.create(win, G.CLIENT_ID);
    await assert.rejects(c.signIn(), e => e.code === code && e.message === message, code);
    assert.equal(c.token(), null, code);
  }
  // Without Google's script there is nothing to open.
  await assert.rejects(SignIn.create(fakeWin(), G.CLIENT_ID).signIn(), e => e.code === 'load');
  // A second click while the first window is still open: the first attempt is dropped, the second counts.
  const win = fakeWin();
  let held = null;
  win.google = { accounts: { oauth2: { initTokenClient: cfg => ({ requestAccessToken() { held = held || cfg; } }), hasGrantedAllScopes: () => true } } };
  const c = SignIn.create(win, G.CLIENT_ID);
  const first = c.signIn();
  const second = c.signIn();
  await assert.rejects(first, e => e.code === 'popup_closed');
  held.callback({ access_token: G.TOKEN, expires_in: 100 });
  await second;
  await tick();
  assert.equal(c.token(), G.TOKEN);
});
