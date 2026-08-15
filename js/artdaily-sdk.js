/* ============================================================
   artdaily-sdk.js — protocol v1.
   The single bridge between a game (its own repo, its own URL)
   and the Art Daily page. Each game repo vendors a byte-identical
   copy of this file; the canonical copy lives in the artdaily
   repo under sdk/. Never fork it per-game — bump protocol
   versions here and recopy (see GAME_GUIDE.md).

   A game only ever calls:
     ArtDaily.init({ slug: 'lines' })      once, on load
     ArtDaily.report(score)                0–100, per finished drill
     ArtDaily.onTheme(fn)                  redraw hook (canvas games)
   Everything else — embed detection, theme sync with the parent
   page, personal bests — is handled here.

   Wire format (postMessage, non-sensitive data only, so '*'
   target origins are fine; listeners validate source + shape):
     game → page  {type:'artdaily:ready',  slug, version:1}
     game → page  {type:'artdaily:result', slug, version:1, score}
     page → game  {type:'artdaily:theme',  theme:'dark'|'light'}
   ============================================================ */
window.ArtDaily = (function () {
  'use strict';

  var VERSION = 1;
  var slug = '';
  var themeListeners = [];

  /* Cross-origin access to window.parent throws in some engines —
     any throw still means "we are inside someone's iframe". */
  var embedded = (function () {
    try { return window.parent !== window; } catch (e) { return true; }
  })();

  var params = (function () {
    try { return new URLSearchParams(location.search); } catch (e) { return { get: function () { return null; } }; }
  })();

  function currentTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }

  function applyTheme(t) {
    document.documentElement.dataset.theme = (t === 'light') ? 'light' : 'dark';
  }

  /* One observer serves both theme sources — a parent message and the
     game's own standalone toggle — so onTheme() never misses either. */
  var observed = currentTheme();
  new MutationObserver(function () {
    var t = currentTheme();
    if (t === observed) return;
    observed = t;
    themeListeners.forEach(function (fn) {
      try { fn(t); } catch (e) {}
    });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function post(msg) {
    if (!embedded) return;
    try { window.parent.postMessage(msg, '*'); } catch (e) {}
  }

  function bestKey() { return 'artdaily-best-' + slug; }

  function readBest() {
    try { var v = parseInt(localStorage.getItem(bestKey()), 10); return isNaN(v) ? null : v; } catch (e) { return null; }
  }

  return {
    version: VERSION,
    isEmbedded: embedded,

    init: function (opts) {
      slug = (opts && opts.slug) || '';

      /* The page passes ?theme= on the iframe src so the game paints in
         the right theme on the very first frame; standalone visits fall
         back to the site-wide localStorage key, then paper (light) —
         Art Daily is a sketchbook, paper is the default. */
      var boot = params.get('theme');
      if (boot !== 'light' && boot !== 'dark') {
        try { boot = localStorage.getItem('sadeali-theme'); } catch (e) { boot = null; }
      }
      applyTheme(boot === 'dark' ? 'dark' : 'light');

      if (params.get('embed') === '1') {
        /* game.css hides the standalone chrome (topbar/footer) off this. */
        document.documentElement.classList.add('embed');
      }

      if (embedded) {
        window.addEventListener('message', function (ev) {
          if (ev.source !== window.parent) return;
          var d = ev.data;
          if (!d || d.type !== 'artdaily:theme') return;
          applyTheme(d.theme);
        });
        post({ type: 'artdaily:ready', slug: slug, version: VERSION });
      }
    },

    /* Call once per *finished* drill with a 0–100 score. The page turns
       these into streaks and skill meters; standalone play keeps a
       personal best on the game's own origin. Returns
       { score, best, isNewBest } so the game can celebrate honestly. */
    report: function (score) {
      var s = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
      var prev = readBest();
      var isNewBest = prev === null || s > prev;
      if (isNewBest) {
        try { localStorage.setItem(bestKey(), String(s)); } catch (e) {}
      }
      post({ type: 'artdaily:result', slug: slug, version: VERSION, score: s });
      return { score: s, best: isNewBest ? s : prev, isNewBest: isNewBest };
    },

    best: readBest,

    theme: currentTheme,

    onTheme: function (fn) { if (typeof fn === 'function') themeListeners.push(fn); },
  };
})();
