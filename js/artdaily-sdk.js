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
     page → game  {type:'artdaily:logged', slug, version:1, score}
                  (receipt for a standalone hand-off; see below)
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

  /* ============================================================
     INPUT PROFILE (protocol v1, additive — a drill that ignores all of
     this behaves exactly as before).

     The same stroke means different things per hardware. A 15px wobble
     over a 300px line is sloppy from a pen and excellent from a mouse,
     which pivots at the wrist and cannot creep. Scoring every mode
     against the pen's standard silently tells beginners on the laptop
     they came with that they are bad at drawing — and they leave.

     Scores are only ever compared against the player's own history, so
     easing per mode is fair. The mode is shown in the drill's HUD so
     the record stays honest, and it is detected silently from the first
     pointer event — a beginner should never face a setup question
     before their first drill.
     ============================================================ */

  var mode = null;                /* 'pen' | 'mouse' | 'touch' */
  var modeListeners = [];

  /* ease: multiplies the error value at which a drill's score hits zero.
     pen = the reference. Mouse/trackpad need roughly double before an
     honest attempt reads as an honest attempt; a finger sits between.
     startRadius: pen needs the BIGGEST start zones despite being the
     most precise instrument — on a screenless tablet the hand is out of
     sight, so acquiring a small target is the hardest thing it does. */
  var PROFILE = {
    pen:   { ease: 1.0, start: 1.7, label: 'pen' },
    mouse: { ease: 2.0, start: 1.0, label: 'mouse or trackpad' },
    touch: { ease: 1.5, start: 1.6, label: 'finger' },
  };

  function profile() { return PROFILE[mode] || PROFILE.mouse; }

  /* Any drill with an #inputMode element gets the label kept current for
     free — the score is eased, so the page says what it eased for. */
  function paintModeChip() {
    var el = document.getElementById('inputMode');
    if (!el) return;
    el.textContent = 'scoring for ' + profile().label;
    el.hidden = false;
  }

  function setMode(m) {
    if (!m || m === mode) return;
    var was = profile();
    mode = m;
    try { localStorage.setItem('artdaily-input', m); } catch (e) {}
    paintModeChip();
    /* Only notify when the numbers a drill can actually SEE have moved.
       The very first press of a session takes mode null → 'mouse', but
       profile() already answered PROFILE.mouse before it, so nothing about
       the scoring changed. Drills rebuild their geometry in this callback
       — steady-tunnel regenerates the corridor — and this listener runs in
       the capture phase, i.e. BEFORE the canvas sees that same press. A
       no-op transition must never move the target under the player's hand
       on the first stroke they draw. */
    if (profile() === was) return;
    modeListeners.forEach(function (fn) { try { fn(m); } catch (e) {} });
  }

  /* A pen outranks a finger, exactly as every drill's own palm guard
     does (PEN_LOCKOUT_MS). Artists rest the palm on the glass mid-
     stroke; the drill refuses to draw with that contact, so it must not
     re-tune the scoring either — a stray palm used to flip the profile
     to 'touch' (ease 1.5) and score the pen's stroke, and every later
     one, against the finger's tolerance. */
  var PEN_LOCKOUT_MS = 700;   /* the drills' own palm guard uses this */
  var lastPenAt = -1e9;

  function notePen(ev) {
    /* pointermove keeps this fresh for the whole stroke (and while the
       nib hovers), so a palm landing mid-stroke is always inside the
       lockout — no pointerup needed, nothing to leak if one is lost. */
    if (ev.pointerType === 'pen') lastPenAt = ev.timeStamp || 0;
  }

  /* Capture phase so a drill's own handler cannot stop us seeing it. */
  window.addEventListener('pointerdown', function (ev) {
    notePen(ev);
    if (ev.pointerType === 'touch' && (ev.timeStamp || 0) - lastPenAt < PEN_LOCKOUT_MS) return;
    setMode(ev.pointerType === 'pen' ? 'pen' : ev.pointerType === 'touch' ? 'touch' : 'mouse');
  }, true);
  window.addEventListener('pointermove', notePen, true);

  (function bootMode() {
    var saved = null;
    try { saved = localStorage.getItem('artdaily-input'); } catch (e) {}
    if (saved === 'pen' || saved === 'mouse' || saved === 'touch') { mode = saved; return; }
    /* Before the first stroke, guess from the device rather than assume
       a pen: a coarse pointer without hover is a finger. */
    try {
      if (window.matchMedia && matchMedia('(any-pointer: coarse)').matches &&
          !matchMedia('(any-hover: hover)').matches) mode = 'touch';
    } catch (e) {}
  })();

  /* ============================================================
     STANDALONE HAND-OFF

     Progress lives in localStorage, which is per-origin: the page is
     artdaily.sadeali.com but a drill played on its own runs on its own
     host, so a score earned there can never reach the record on its
     own. (A hidden cross-origin iframe used to bridge this; browsers
     now partition that storage, so it silently would not work.)

     Two honest routes instead:
       1. If this tab was opened FROM the page, its window.opener is the
          page — post the result straight to it and it lands live. It
          replies {type:'artdaily:logged'}: posting is NOT delivering,
          because a postMessage whose targetOrigin no longer matches
          (the opener tab navigated away from HOME) is dropped silently,
          with no throw to catch. Claiming "sent ✓" off a bare
          window.opener check loses the score for good.
       2. Until that receipt arrives — and forever, if there is no opener
          at all — offer a link carrying the score back. One tap, and the
          page records it. Injected here so all drills get it without
          each one needing its own button.
     ============================================================ */

  var HOME = 'https://artdaily.sadeali.com';

  function logUrl(score) {
    return HOME + '/#log=' + encodeURIComponent(slug) + ',' + score;
  }

  /* The best of THIS sitting. The bar is rewritten by every round, so
     handing over the round just played meant a player who did 41, 92,
     then a tired 38 could only ever log the 38. (Not the all-time best
     from readBest(): that may have been earned on another day, and the
     page would file it under today.) */
  var sessionBest = null;
  var lastRound = 0;
  var ackHooked = false;

  function handOffStandalone(round) {
    lastRound = round;
    if (sessionBest === null || round > sessionBest) sessionBest = round;
    /* Hook the receipt first and paint the link second, so neither can
       be clobbered by an acknowledgement that arrives in between. */
    if (!ackHooked) {
      ackHooked = true;
      window.addEventListener('message', function (ev) {
        if (ev.origin !== HOME) return;
        var d = ev.data;
        if (!d || d.type !== 'artdaily:logged' || d.slug !== slug) return;
        showHandOff(lastRound, sessionBest, true);
      });
    }
    showHandOff(round, sessionBest, false);
    /* The post carries THIS round, not the session best: over an opener
       every round is posted as it happens and the page keeps the best of
       the day already. Only the link needs the best, because it is one
       click that has to stand for the whole sitting. */
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(
          { type: 'artdaily:result', slug: slug, version: VERSION, score: round }, HOME);
      }
    } catch (e) {}
  }

  function showHandOff(round, best, delivered) {
    var bar = document.getElementById('artdailyHandoff');
    if (!bar) {
      bar = document.createElement('p');
      bar.id = 'artdailyHandoff';
      bar.className = 'handoff';
      var host = document.querySelector('.game-controls') || document.querySelector('.game-body');
      if (!host) return;
      host.parentNode.insertBefore(bar, host.nextSibling);
    }
    bar.textContent = '';
    if (delivered) {
      bar.appendChild(document.createTextNode('sent to your Art Daily record ✓'));
      return;
    }
    bar.appendChild(document.createTextNode(best > round
      ? 'scored ' + round + ' · best this session ' + best + ' — '
      : 'scored ' + round + ' — '));
    var a = document.createElement('a');
    a.className = 'handoff-link';
    a.href = logUrl(best);
    a.textContent = 'add it to my Art Daily record →';
    bar.appendChild(a);
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

      paintModeChip();

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
      if (!embedded) handOffStandalone(s);
      return { score: s, best: isNewBest ? s : prev, isNewBest: isNewBest };
    },

    best: readBest,

    theme: currentTheme,

    onTheme: function (fn) { if (typeof fn === 'function') themeListeners.push(fn); },

    /* ---- input profile (see the block above) ---- */

    /* 'pen' | 'mouse' | 'touch' — null only before the very first
       pointer event on a device we could not guess. */
    inputMode: function () { return mode; },

    /* Human label for the HUD: "scoring for: mouse or trackpad". */
    inputLabel: function () { return profile().label; },

    /* Multiply the error at which YOUR score reaches zero:
         var zero = ArtDaily.ease(0.055);
       Pen keeps the strict standard; mouse and finger get room. */
    ease: function (base) { return (typeof base === 'number' ? base : 1) * profile().ease; },

    /* Enlarge a start/hit zone the same way:
         var r = ArtDaily.startRadius(28);   // 48 on a pen tablet */
    startRadius: function (base) {
      var b = typeof base === 'number' ? base : 28;
      return Math.round(b * profile().start);
    },

    /* Fires when the hardware changes mid-session (a laptop user plugs
       in a tablet, an iPad user picks up the pencil). */
    onInput: function (fn) { if (typeof fn === 'function') modeListeners.push(fn); },
  };
})();
