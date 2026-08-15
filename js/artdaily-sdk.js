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

  /* Every number that crosses this boundary is checked for finiteness.
     A drill's tolerance is often computed (a fraction of a reference
     length, a fitted radius), and a degenerate round — zero-length
     reference, collinear points, an empty stroke — hands over NaN or
     Infinity. Passing that through silently poisons the drill's whole
     score: NaN loses every comparison so the score becomes NaN, and
     report() then files it as 0 with nothing logged anywhere. */
  function finite(v, fallback) {
    v = Number(v);
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  /* Any drill with an #inputMode element gets the label kept current for
     free — the score is eased, so the page says what it eased for. */
  function paintModeChip() {
    var el = document.getElementById('inputMode');
    if (!el) return;
    el.textContent = 'scoring for ' + profile().label;
    el.hidden = false;
  }

  function applyMode(m) {
    if (!m || m === mode) return;
    var was = profile();
    mode = m;
    try { localStorage.setItem('artdaily-input', m); } catch (e) {}
    paintModeChip();
    /* Only notify when the numbers a drill can actually SEE have moved.
       The very first press of a session takes mode null → 'mouse', but
       profile() already answered PROFILE.mouse before it, so nothing about
       the scoring changed. */
    if (profile() === was) return;
    modeListeners.forEach(function (fn) { try { fn(m); } catch (e) {} });
  }

  /* A profile change may not land in the middle of a press.
     Mode is detected on pointerdown, from a CAPTURE-phase listener — it
     runs BEFORE the canvas sees that same press. Applying the change there
     rebuilds the drill's geometry under the player's hand (steady-tunnel
     regenerates its corridor in onInput), and swings startRadius between
     the zone that was drawn and the zone that judges the hit: a saved
     'mouse' profile meeting a newly plugged-in pen jumped a 28px start dot
     to 48px mid-press. So a change that moves the numbers is queued and
     applied at the release that ends the press — and after that release
     has been dispatched, so the stroke is scored under the same ease it
     was drawn under. A no-op transition costs nothing and applies at once. */
  var pendingMode = null;
  var pointersDown = 0;

  function setMode(m) {
    if (!m || m === mode) return;
    if (PROFILE[m] === profile()) { applyMode(m); return; }
    pendingMode = m;
  }

  function flushMode(force) {
    if (!pendingMode) return;
    if (!force && pointersDown > 0) return;
    var m = pendingMode;
    pendingMode = null;
    applyMode(m);
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

  /* A release can go missing — a swallowed pointercancel, a tab hidden
     mid-press — and would otherwise pin this counter above zero for the
     rest of the session, freezing the queued switch forever. No real
     gesture sits idle for two seconds, so a gap that long means whatever
     was down is long gone. */
  var GESTURE_IDLE_MS = 2000;
  var lastPointerAt = -1e9;

  /* Capture phase so a drill's own handler cannot stop us seeing it, and
     PASSIVE because none of these handlers ever calls preventDefault. A
     non-passive window-level pointer listener puts every gesture anywhere
     on the page — including a plain scroll past the drill — through a
     blocking hit-test before the compositor may move a pixel, and this
     file is loaded on every drill in the arcade. `passive` is per-listener,
     so a drill's own non-passive canvas handler still cancels what it likes.
     An engine too old to read the options object sees a truthy value and
     reads it as `capture: true`, which is what it used to be told. */
  var SNIFF = { capture: true, passive: true };

  window.addEventListener('pointerdown', function (ev) {
    var t = ev.timeStamp || 0;
    /* First contact of a fresh gesture: anything still queued was queued
       by a gesture that has already ended, so it is safe to apply now.
       A second finger joining a live gesture must NOT trigger this — and
       the counter is read BEFORE the idle reset below repairs it, because
       a repaired counter is a GUESS. A stroke that pauses emits no move
       events (a pen resting on the tablet while the player looks up), so
       it goes idle without ending; forcing the queued switch through on
       the palm that lands next rebuilt the drill's geometry under a live
       hand — the exact mid-press swing this queue exists to prevent.
       Zero here means the previous gesture's releases actually landed.
       When they did not, the switch waits for the next release instead of
       jumping the queue, which is one gesture later and never mid-stroke. */
    if (!pointersDown) flushMode(true);
    if (t - lastPointerAt > GESTURE_IDLE_MS) pointersDown = 0;
    lastPointerAt = t;
    pointersDown += 1;      /* counted before the palm guard can return */
    notePen(ev);
    if (ev.pointerType === 'touch' && t - lastPenAt < PEN_LOCKOUT_MS) return;
    setMode(ev.pointerType === 'pen' ? 'pen' : ev.pointerType === 'touch' ? 'touch' : 'mouse');
  }, SNIFF);

  window.addEventListener('pointermove', function (ev) {
    notePen(ev);
    /* Only a move WITH contact keeps the gesture alive. Bare hover must
       not: a mouse drifting over the page would otherwise hold a leaked
       counter fresh forever and the idle reset would never fire. */
    if (ev.buttons) lastPointerAt = ev.timeStamp || 0;
  }, SNIFF);

  function releasePointer(ev) {
    lastPointerAt = (ev && ev.timeStamp) || lastPointerAt;
    pointersDown = Math.max(0, pointersDown - 1);
    /* Deferred one task so the drill's own release handler — which scores
       the stroke through ease() — has already run under the old profile. */
    if (!pointersDown && pendingMode) setTimeout(function () { flushMode(false); }, 0);
  }
  window.addEventListener('pointerup', releasePointer, SNIFF);
  window.addEventListener('pointercancel', releasePointer, SNIFF);

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

  /* A decorative glyph, hidden from assistive tech. "→" and "✓" are read
     out as "rightwards arrow" and "check mark", so the one sentence a
     standalone screen-reader player hears after a round used to end in a
     noise word — and the link's accessible name, which is what a
     links-list announces out of context, ended "record rightwards arrow". */
  function glyph(ch) {
    var s = document.createElement('span');
    s.setAttribute('aria-hidden', 'true');
    s.textContent = ch;
    return s;
  }

  function showHandOff(round, best, delivered) {
    var bar = document.getElementById('artdailyHandoff');
    if (!bar) {
      /* Find the host BEFORE building the bar: a drill with neither hook
         used to leave a fresh orphan <p> behind on every single round. */
      var host = document.querySelector('.game-controls') || document.querySelector('.game-body');
      if (!host || !host.parentNode) return;
      bar = document.createElement('p');
      bar.id = 'artdailyHandoff';
      bar.className = 'handoff';
      /* A live region, because this bar IS the reveal for a standalone
         player: it carries the score and the only route back to the
         record. Painted silently, a screen-reader player finished a round
         and was told nothing at all. */
      bar.setAttribute('role', 'status');
      host.parentNode.insertBefore(bar, host.nextSibling);
    }
    if (delivered) {
      bar.textContent = '';
      bar.appendChild(document.createTextNode('sent to your Art Daily record '));
      bar.appendChild(glyph('✓'));
      return;
    }
    /* The LINK NODE IS REUSED across rounds. Rebuilding the whole bar every
       round destroyed and recreated the only control on it, and removing a
       focused element drops focus to <body> — a keyboard player who had
       tabbed to "add it to my record" lost their place the moment the next
       round ended. role="status" implies aria-atomic, so the region is
       re-announced in full either way: nothing is lost by keeping the node. */
    var a = bar.querySelector('a.handoff-link');
    /* querySelector reaches any descendant, and the sweep below only skips
       DIRECT children — so a link that something else has nested would be
       swept away and then insertBefore'd against, which throws inside
       report(). Anything but our own direct child is rebuilt from scratch. */
    if (a && a.parentNode !== bar) a = null;
    if (!a) {
      bar.textContent = '';
      a = document.createElement('a');
      a.className = 'handoff-link';
      a.appendChild(document.createTextNode('add it to my Art Daily record '));
      a.appendChild(glyph('→'));
      bar.appendChild(a);
    }
    a.href = logUrl(best);
    /* Replace only what sits in front of the link. */
    while (bar.firstChild && bar.firstChild !== a) bar.removeChild(bar.firstChild);
    bar.insertBefore(document.createTextNode(best > round
      ? 'scored ' + round + ' · best this session ' + best + ' — '
      : 'scored ' + round + ' — '), a);
  }

  function bestKey() { return 'artdaily-best-' + slug; }

  /* Clamped on the way OUT as well as in: a best outside 0–100 can only
     come from a corrupted or hand-edited store, and it is not harmless —
     a stored "200" is a best no round can ever beat, so isNewBest never
     fires again and the HUD prints "200" next to a 0–100 score. Clamping
     is the identity on every value report() has ever written. */
  function readBest() {
    try {
      var v = parseInt(localStorage.getItem(bestKey()), 10);
      if (isNaN(v)) return null;
      return Math.max(0, Math.min(100, v));
    } catch (e) { return null; }
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
       personal best on the game's own origin.

       Returns { score, best, isNewBest, isFirst } so the game can
       celebrate honestly. `isFirst` marks the very first round this drill
       has ever recorded on this device: there is no previous best, so
       `isNewBest` is trivially true and "new best!" becomes the first
       thing a beginner is ever told — a celebration of nothing, fired on
       the one round where they most need to be told what the number
       MEANS. Drills branch on isFirst to say that instead. */
    report: function (score) {
      /* Non-finite means the drill's scoring broke, not that the player was
         perfect. Infinity used to clamp UP to 100 — a single divide-by-zero
         in a round (a zero-length reference stroke, a degenerate fit) handed
         out a fake perfect score, wrote it to the permanent personal best,
         and posted it to the page as a real result. Broken scores 0. */
      var s = Math.max(0, Math.min(100, Math.round(finite(score, 0))));
      var prev = readBest();
      var isFirst = prev === null;
      var isNewBest = isFirst || s > prev;
      if (isNewBest) {
        try { localStorage.setItem(bestKey(), String(s)); } catch (e) {}
      }
      post({ type: 'artdaily:result', slug: slug, version: VERSION, score: s });
      if (!embedded) handOffStandalone(s);
      return { score: s, best: isNewBest ? s : prev, isNewBest: isNewBest, isFirst: isFirst };
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
       Pen keeps the strict standard; mouse and finger get room.
       Always returns a finite number > 0, so it is safe as a divisor. */
    ease: function (base) {
      var b = finite(base, 1);
      if (b <= 0) b = 1;
      /* The PRODUCT is checked, not just the input. A base that is large
         but perfectly finite still overflows once the profile factor lands
         (mouse doubles it), and an infinite zero-point is the worst possible
         failure: 1 - err/Infinity is exactly 1, so every attempt, however
         wild, scores a fake 100 — the same fake perfect report() exists to
         stop, arriving through the front door instead. Falling back to the
         unmultiplied base keeps the promise the line above makes. */
      return finite(b * profile().ease, b);
    },

    /* Enlarge a start/hit zone the same way:
         var r = ArtDaily.startRadius(28);   // 48 on a pen tablet
       Always returns a finite, HITTABLE radius. A base BELOW ONE PIXEL is
       treated as missing rather than as "a zone a fraction of a pixel
       across": a drill that sizes its zone off the canvas —
       startRadius(Math.min(W, H) * 0.05) — is called once at boot, before
       layout, and a 1px target is every bit as dead a round as a NaN one.
       Guarding only the exact 0 was not enough, because a canvas floors its
       own measured width at 1px (Math.max(1, rect.width) is the standard
       shape), so the base arrives as 0.05, not as a clean 0, and slipped
       through. Only the sign is folded away for a negative base. */
    startRadius: function (base) {
      var b = Math.abs(finite(base, 28));
      if (!(b >= 1)) b = 28;
      /* Checked after the multiply for the same reason ease() is. */
      return Math.max(1, finite(Math.round(b * profile().start), b));
    },

    /* Every position a pointermove actually carried, oldest first:
         ArtDaily.samples(ev).forEach(function (e) { pts.push(pos(e)); });
       A browser delivers pointermove at most once per frame, but the
       digitizer samples far faster than that — 120–1000Hz on a pen tablet
       — and hands the frame's whole run of positions over on the ONE event
       it dispatches. Reading only that event throws the rest away, so a
       fast stroke is sampled at 60Hz whatever the hardware cost: the corner
       of a quick flick vanishes, and a drill that scores the geometry then
       scores a straight line the player did not draw. Judging the hand by
       the samples the browser felt like delivering is not honest scoring.

       Always an array, never a throw, never empty for a real event, and
       [ev] wherever coalescing is unavailable — so the caller needs no
       branch of its own. (Half the drills that need this hand-rolled it
       three different ways; this is that pattern, once.) */
    samples: function (ev) {
      if (!ev) return [];
      try {
        if (typeof ev.getCoalescedEvents === 'function') {
          var list = ev.getCoalescedEvents();
          if (list && list.length) return list;
        }
      } catch (e) {}
      return [ev];
    },

    /* Fires when the hardware changes mid-session (a laptop user plugs
       in a tablet, an iPad user picks up the pencil). */
    onInput: function (fn) { if (typeof fn === 'function') modeListeners.push(fn); },
  };
})();
