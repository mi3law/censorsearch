// CensorSignIn: Google sign-in for the signed-in read path (config.googleClientId). It loads Google Identity Services
// only when asked, and gets the visitor a short-lived access token that can only read Google Sheets, so the page reads
// the sheet with their own access and Google decides who can. Works in the browser (window.CensorSignIn) and Node.
//
// The token lives only in this object, in memory: it is never stored, logged, shown or put in an address, and it is
// gone when the tab closes (Google makes it run out after about an hour anyway).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CensorSignIn = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GIS_URL = 'https://accounts.google.com/gsi/client';
  const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  // Only the inventory check's optional "write the results into the sheet" asks for this, and only when a teacher ticks it.
  const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
  const CLIENT_ID_RE = /^\d{6,30}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/;
  const EARLY = 60 * 1000;         // a token this close to running out counts as run out
  const LOAD_TIMEOUT = 20000;

  const MSG = {
    load: "Google sign-in didn't load: a network filter or browser extension may block accounts.google.com.",
    popupBlocked: "The browser blocked Google's sign-in window. Allow pop-ups for this page, then try again.",
    popupClosed: 'The sign-in window closed before signing in finished.',
    denied: "Google sign-in was cancelled, or the school's Google settings don't allow this page.",
    admin: "The school's Google settings don't let this page read Google Sheets. Ask the school's IT to allow CensorSearch.",
    internal: "Only the school's Google accounts can sign in here. Sign in with your school account.",
    scope: "Your Google sign-in didn't give this page permission to see the sheet. Sign in again and allow it.",
    writeScope: "Your Google sign-in didn't give this page permission to edit Google Sheets, so it can't write the results into the sheet.",
    failed: "Google sign-in didn't work. Try again.",
  };

  const isClientId = s => CLIENT_ID_RE.test(String(s == null ? '' : s).trim());

  // Google's error codes (from the token callback, or the type of a popup error) -> a plain sentence.
  function messageFor(code) {
    switch (String(code || '')) {
      case 'popup_failed_to_open': return MSG.popupBlocked;
      case 'popup_closed': return MSG.popupClosed;
      case 'access_denied': return MSG.denied;
      case 'admin_policy_enforced': return MSG.admin;
      case 'org_internal': return MSG.internal;
      case 'scope': return MSG.scope;
      case 'writeScope': return MSG.writeScope;
      case 'load': return MSG.load;
      default: return MSG.failed;
    }
  }

  function signInError(code) {
    const e = new Error(messageFor(code));
    e.code = String(code || 'failed');
    return e;
  }

  const gisOf = win => {
    const g = win.google;
    return g && g.accounts && g.accounts.oauth2 && typeof g.accounts.oauth2.initTokenClient === 'function' ? g.accounts.oauth2 : null;
  };

  // Loads Google's script once per window (however many sign-in clients ask); resolves when sign-in can start.
  const loading = new WeakMap();
  function loadGis(win) {
    if (gisOf(win)) return Promise.resolve();
    if (loading.has(win)) return loading.get(win);
    const p = new Promise((resolve, reject) => {
      const doc = win.document;
      const s = doc.createElement('script');
      let timer = 0;
      const done = ok => {
        win.clearTimeout(timer);
        if (ok && gisOf(win)) { resolve(); return; }
        s.remove();
        loading.delete(win);
        reject(signInError('load'));
      };
      timer = win.setTimeout(() => done(false), LOAD_TIMEOUT);
      s.addEventListener('load', () => done(true));
      s.addEventListener('error', () => done(false));
      s.async = true;
      s.setAttribute('src', GIS_URL);
      (doc.head || doc.body).append(s);
    });
    loading.set(win, p);
    return p;
  }

  // win: the page's window. clientId: the OAuth client ID (public; it names the app to Google). opts.scope: WRITE_SCOPE for
  // a client that may change sheets (the default reads only).
  function create(win, clientId, opts) {
    const scope = opts && opts.scope === WRITE_SCOPE ? WRITE_SCOPE : SCOPE;
    let client = null, pending = null, token = null, expiresAt = 0;
    const gis = () => gisOf(win);

    function settle(resp) {
      const p = pending;
      pending = null;
      if (!p) return;
      if (!resp || resp.error || !resp.access_token) { p.reject(signInError(resp && resp.error)); return; }
      const o = gis();
      if (o && typeof o.hasGrantedAllScopes === 'function' && !o.hasGrantedAllScopes(resp, scope)) { p.reject(signInError(scope === SCOPE ? 'scope' : 'writeScope')); return; }
      token = String(resp.access_token);
      const seconds = Number(resp.expires_in);
      expiresAt = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
      p.resolve();
    }

    // Opens Google's sign-in window. Call it straight from a click (before any await), so the browser allows the window.
    // opts.chooseAccount: let the visitor pick another account.
    function signIn(opts) {
      const o = gis();
      if (!o) return Promise.reject(signInError('load'));
      if (pending) { const p = pending; pending = null; p.reject(signInError('popup_closed')); }
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        try {
          if (!client) {
            client = o.initTokenClient({
              client_id: String(clientId).trim(),
              scope,
              callback: settle,
              error_callback: err => settle({ error: (err && err.type) || 'failed' }),
            });
          }
          client.requestAccessToken({ prompt: opts && opts.chooseAccount ? 'select_account' : '' });
        } catch (e) {
          pending = null;
          reject(signInError('failed'));
        }
      });
    }

    return {
      load: () => loadGis(win),
      signIn,
      ready: () => !!gis(),
      // The token while it has more than a minute left, else null.
      token: () => (token && Date.now() < expiresAt - EARLY ? token : null),
      forget() { token = null; expiresAt = 0; },
    };
  }

  return { create, loadGis, isReady: win => !!gisOf(win), isClientId, messageFor, SCOPE, WRITE_SCOPE, GIS_URL, messages: MSG };
});
