/* ============================================================
   game.js — Gesture Capture: a mannequin strikes a pose built
   FROM a known line of action (a C/S spline through hips, spine
   and head with volumes hung on it), a ring counts down, and the
   player sweeps up to 5 flowing strokes catching that line while
   the pose shows — every one of them is scored, as one line, so a
   short-throw trackpad is not punished for lifting. Scoring is soft
   and says so: 60% geometry (symmetric chamfer between ALL the
   player's strokes and the true sweep, worse direction wins, with
   pixel floors eased per input mode — the pure functions sit at the
   top, unit-testable) and 40% the player's own read of how the
   stroke felt. The first pose of the first round paints the true
   line for a beat before asking for it. Two poses per round; the
   last 12 gestures are kept as thumbnails — the real reward.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'gesture-capture';
  var POSE_MS = [30000, 20000]; /* pose 1 easier + slower, pose 2 earned */
  var LAST_MS = 5000;           /* faded-pose grace before the drill locks */
  var TEACH_MS = 1600;          /* round 1 pose 1: show the line first     */
  /* Five, not three: the cap was invented for pens. A trackpad cannot
     throw a 430px arc in one go and every piece is scored now. */
  var MAX_STROKES = 5;
  var MIN_LEN = 26;             /* px of ink below this = accidental tap  */
  var FREE_FRAC = 0.012;        /* of the pose: error that costs nothing  */
  var SPAN_FRAC = 0.148;        /* …then this much more ramps down to 0   */
  var FREE_FLOOR_PX = 3;        /* …but never tighter than the hardware's */
  var SPAN_FLOOR_PX = 40;       /*    own noise (both eased per mode)     */
  var FADE_MS = 350;            /* the pose eases down to 12%, not snaps  */
  var HANDOFF_MS = 380;         /* beat between rating a pose and the next */
  var EMPTY_HOLD_MS = 1800;     /* …longer when there is a missed line to study */
  var RESAMPLE_N = 56;
  var PER_SEG = 12;             /* spline samples per anchor segment */
  var ARCHIVE_KEY = 'artdaily-gesture-archive';
  var ARCHIVE_MAX = 12;
  var MONO = 'ui-monospace, Menlo, Consolas, monospace';

  /* ============================================================
     Pure scoring — geometry in, 0–100 out. No canvas, no DOM.
     ============================================================ */
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function polyLength(pts) {
    var L = 0, i;
    for (i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
    return L;
  }

  function totalLength(strokes) {
    var L = 0, i;
    for (i = 0; i < strokes.length; i++) L += polyLength(strokes[i]);
    return L;
  }

  /* Arc-length resample to ~n evenly spaced points. */
  function resample(pts, n) {
    var out = [], i;
    if (!pts || !pts.length) return out;
    var total = polyLength(pts);
    if (total === 0 || pts.length < 2 || n < 2) {
      for (i = 0; i < n; i++) out.push({ x: pts[0].x, y: pts[0].y });
      return out;
    }
    var step = total / (n - 1), D = 0, prev = pts[0], d, t, q;
    out.push({ x: prev.x, y: prev.y });
    i = 1;
    while (i < pts.length) {
      d = dist(prev, pts[i]);
      if (D + d >= step && d > 0) {
        t = (step - D) / d;
        q = { x: prev.x + (pts[i].x - prev.x) * t, y: prev.y + (pts[i].y - prev.y) * t };
        out.push(q);
        prev = q;
        D = 0;
        if (out.length === n - 1) break;
      } else {
        D += d;
        prev = pts[i];
        i++;
      }
    }
    out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
    return out;
  }

  function distSqToSegment(p, a, b) {
    var vx = b.x - a.x, vy = b.y - a.y;
    var wx = p.x - a.x, wy = p.y - a.y;
    var len = vx * vx + vy * vy;
    var t = len === 0 ? 0 : clamp01((wx * vx + wy * vy) / len);
    var dx = wx - t * vx, dy = wy - t * vy;
    return dx * dx + dy * dy;
  }

  /* Nearest distance to a polyline's SEGMENTS, not to its samples, so a
     sparsely-sampled fast flick is not charged for its device's event
     rate. */
  function distToPath(p, path) {
    if (!path || !path.length) return Infinity;
    if (path.length === 1) return dist(p, path[0]);
    var best = Infinity, i, d;
    for (i = 0; i + 1 < path.length; i++) {
      d = distSqToSegment(p, path[i], path[i + 1]);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /* Nearest distance to ANY of the player's strokes. The strokes stay
     separate: joining them would invent a segment across a lift. */
  function distToStrokes(p, strokes) {
    var best = Infinity, s, d;
    for (s = 0; s < strokes.length; s++) {
      d = distToPath(p, strokes[s]);
      if (d < best) best = d;
    }
    return best;
  }

  function meanDistToPath(pts, path) {
    if (!pts.length) return Infinity;
    var sum = 0, i;
    for (i = 0; i < pts.length; i++) sum += distToPath(pts[i], path);
    return sum / pts.length;
  }

  /* Every stroke resampled, each getting a share of the budget in
     proportion to its length, so a long sweep outweighs a short dab. */
  function samplePlayer(strokes, n) {
    var total = totalLength(strokes), out = [], i, share, L;
    if (!strokes.length) return out;
    for (i = 0; i < strokes.length; i++) {
      L = polyLength(strokes[i]);
      share = total > 0 ? Math.max(2, Math.round(n * L / total)) : Math.max(2, Math.round(n / strokes.length));
      out = out.concat(resample(strokes[i], share));
    }
    return out;
  }

  /* Symmetric chamfer over ALL the player's strokes: ink→line punishes
     wobble and stray marks, line→ink punishes sweep left uncovered, and
     the WORSE direction is the answer. Averaging them half-forgave the
     classic cheese — scribbling over the pose zeroes the line→ink term
     and used to score ~56 with no line at all — while an honest sweep,
     whose error is symmetric, is unaffected. No centroid alignment: the
     line of action lives where the pose lives.
     Scoring only the LONGEST stroke silently threw away everything a
     short-throw trackpad was forced to split, and charged for the miss
     it had just deleted: a sweep drawn in two halves read as half a
     sweep, with nothing on screen saying so.

     Both directions are RETURNED, not just the max, because they are
     two different mistakes and "you followed it 62%" cannot tell them
     apart: inkToLine high means the stroke wandered off the line,
     lineToInk high means most of the line was never swept at all. The
     score still uses only the worse of them, exactly as before. */
  function chamferParts(strokes, truth, n) {
    var none = { inkToLine: Infinity, lineToInk: Infinity, worst: Infinity };
    if (!strokes || !strokes.length || !truth || truth.length < 2) return none;
    var ink = samplePlayer(strokes, n);
    if (!ink.length) return none;
    var truthPts = resample(truth, n);
    var sumB = 0, i;
    for (i = 0; i < truthPts.length; i++) sumB += distToStrokes(truthPts[i], strokes);
    var a = meanDistToPath(ink, truthPts), b = sumB / truthPts.length;
    return { inkToLine: a, lineToInk: b, worst: Math.max(a, b) };
  }

  function chamferAll(strokes, truth, n) {
    return chamferParts(strokes, truth, n).worst;
  }

  /* WHICH of the six things happened, decided in exactly one place.
     fitVerdict() turns the state into the sentence the player reads and
     roundCoach() counts the states across the round, so the line that
     closes a round can never contradict the two that led up to it. */
  var DIR_RATIO = 1.25;
  var CLEAN_FIT = 85;
  var LOST_FIT = 25;

  function fitKind(parts, fit) {
    if (!parts || !isFinite(parts.worst)) return 'none';
    if (fit >= CLEAN_FIT) return 'clean';
    if (parts.lineToInk > parts.inkToLine * DIR_RATIO) return 'short';
    if (parts.inkToLine > parts.lineToInk * DIR_RATIO) return 'wandered';
    /* Both directions equally bad AND both large is not "the right shape
       slightly misplaced" — a stroke drawn somewhere else entirely lands
       here, and praising its shape contradicts the number beside it. */
    if (fit < LOST_FIT) return 'lost';
    return 'offset';
  }

  var FIT_WORDS = {
    none: 'nothing landed on the line.',
    clean: 'you rode it the whole way.',
    short: 'you caught part of it — the line runs further than your stroke did.',
    wandered: 'your stroke wandered off it — one flowing curve, not the body’s outline.',
    lost: 'that is a different line — start at the head and sweep down through the hips.',
    offset: 'the right shape, sitting off the line — start at the head and commit.'
  };

  /* The delta, in words. The fit percentage is a magnitude with no
     direction — a beginner reading "48%" cannot tell whether they drew
     the wrong curve or simply drew a third of the right one. */
  function fitVerdict(parts, fit) {
    return FIT_WORDS[fitKind(parts, fit)] || FIT_WORDS.none;
  }

  /* Both poses said their own piece and then the round closed on two
     percentages and a count of saved thumbnails — so a player who stops
     short of the far foot on BOTH poses was told so twice and never once
     told it was the same mistake twice. One line, built from the same
     per-pose states the two verdicts were built from. A habit is only
     claimed when every pose in the round showed it; anything else says
     so rather than inventing a pattern out of one occurrence. */
  var ROUND_WORDS = {
    short: 'both times the line ran further than your stroke did — it does not stop until the far foot.',
    wandered: 'both times you drew round the body instead of through it — one curve, not an outline.',
    lost: 'neither line found the pose — start at the head, sweep through the hips, out the far foot.',
    offset: 'both lines were the right shape in the wrong place — start your sweep on the head.',
    none: 'nothing reached the sheet either time — one fast curve is worth more here than a careful one.'
  };

  function roundCoach(kinds) {
    var n = kinds ? kinds.length : 0, i, clean = 0, first = null, allSame = true;
    if (!n) return '';
    for (i = 0; i < n; i++) {
      if (kinds[i] === 'clean') clean += 1;
      if (first === null) first = kinds[i];
      else if (kinds[i] !== first) allSame = false;
    }
    if (clean === n) return 'you rode the line every time — next round, go faster and trust the first curve.';
    if (allSame && ROUND_WORDS[first]) return ROUND_WORDS[first];
    return 'no one habit across the two — the line of action is one curve: head, hips, far foot.';
  }

  /* Tolerance scales with the pose — the first 1.2% is free so a careful
     tracing can reach 100 and the next 14.8% ramps to zero — but both
     terms have a pixel floor, eased per input mode by the caller: on a
     phone the pose is ~158px, which made the free zone 1.9px and the
     whole ramp 23px wide. That is inside a fingertip's own noise. */
  function fitScore(chamferDist, poseSize, freeFloorPx, spanFloorPx) {
    if (!(poseSize > 0) || !isFinite(chamferDist)) return 0;
    var free = Math.max(FREE_FRAC * poseSize, freeFloorPx || 0);
    var span = Math.max(SPAN_FRAC * poseSize, spanFloorPx || 0);
    if (!(span > 0)) return 0;
    return 100 * clamp01(1 - Math.max(0, chamferDist - free) / span);
  }

  /* Math.min(5, NaN) is NaN and Math.max(0, NaN) is NaN, so an unguarded
     rating would carry NaN into poseScore and out through report(). The
     star buttons can only ever hand this 1–5, but a scoring function has
     to be safe on its own terms, not on its caller's. */
  function starScore(stars) {
    var s = Number(stars);
    if (!isFinite(s)) return 0;
    return 20 * Math.max(0, Math.min(5, s));
  }

  function poseScore(fit, starSc) { return 0.6 * fit + 0.4 * starSc; }

  function roundMean(scores) {
    if (!scores.length) return 0;
    var sum = 0, i;
    for (i = 0; i < scores.length; i++) sum += scores[i];
    return sum / scores.length;
  }

  /* ============================================================
     Pose generation — a line of action first, volumes after.
     Unit space: hip at (0,0), y grows downward, figure ≈ 1 tall.
     ============================================================ */
  function catmullRom(anchors, perSeg) {
    var pts = [], n = anchors.length, i, j, t, t2, t3, p0, p1, p2, p3;
    for (i = 0; i < n - 1; i++) {
      p0 = anchors[i > 0 ? i - 1 : 0];
      p1 = anchors[i];
      p2 = anchors[i + 1];
      p3 = anchors[i + 2 < n ? i + 2 : n - 1];
      for (j = 0; j < perSeg; j++) {
        t = j / perSeg; t2 = t * t; t3 = t2 * t;
        pts.push({
          x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
        });
      }
    }
    pts.push({ x: anchors[n - 1].x, y: anchors[n - 1].y });
    return pts;
  }

  function tangentAt(pts, i) {
    var a = pts[Math.max(0, i - 2)];
    var b = pts[Math.min(pts.length - 1, i + 2)];
    var vx = b.x - a.x, vy = b.y - a.y, L = Math.hypot(vx, vy) || 1;
    return { x: vx / L, y: vy / L };
  }

  /* Positive degrees rotate clockwise on screen (y grows down). */
  function rotv(v, deg) {
    var r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
  }

  function J(x, y, a) {
    a = (a === undefined) ? 0.02 : a;
    return { x: x + (Math.random() * 2 - 1) * a, y: y + (Math.random() * 2 - 1) * a };
  }

  /* Each def: sweep anchors (the full action line — the LOA spline
     through the torso plus the one leading limb that continues its
     energy), hip/neck anchor indices, the leading limb's anchor
     range + which end roots at the body, head placement off the
     neck tangent, and the off-sweep limbs as joint triples. */
  var POSE_DEFS = {
    /* pose-1 vocabulary — clear directional sweeps */
    reach: function () {
      return {
        anchors: [J(0, 0, 0.008), J(-0.03, -0.21), J(0.05, -0.40), J(0.30, -0.76, 0.035)],
        hipA: 0, neckA: 2, leadA: [2, 3], leadRoot: 'start',
        headSide: -60, headDist: 0.105, headR: 0.075,
        leadW: [0.048, 0.030],
        limbs: [
          { p: [J(0.03, -0.36, 0.01), J(-0.11, -0.29, 0.03), J(-0.17, -0.17, 0.03)], w: [0.048, 0.034] },
          { p: [J(0, 0, 0.008), J(0.02, 0.33), J(0.00, 0.64, 0.03)], w: [0.062, 0.045] },
          { p: [J(0, 0, 0.008), J(-0.13, 0.28, 0.03), J(-0.25, 0.55, 0.035)], w: [0.062, 0.045] }
        ]
      };
    },
    lunge: function () {
      return {
        anchors: [J(-0.46, 0.40, 0.035), J(0, 0, 0.008), J(0.15, -0.15), J(0.28, -0.27), J(0.35, -0.33, 0.01)],
        hipA: 1, neckA: 3, leadA: [0, 1], leadRoot: 'end',
        headSide: 0, headDist: 0.085, headR: 0.075,
        leadW: [0.060, 0.042],
        limbs: [
          { p: [J(0, 0, 0.008), J(0.27, 0.22, 0.03), J(0.25, 0.52, 0.03)], w: [0.062, 0.045] },
          { p: [J(0.26, -0.24, 0.01), J(0.40, -0.19, 0.03), J(0.52, -0.14, 0.03)], w: [0.048, 0.034] },
          { p: [J(0.26, -0.24, 0.01), J(0.13, -0.13, 0.03), J(0.05, -0.01, 0.03)], w: [0.048, 0.034] }
        ]
      };
    },
    /* pose-2 vocabulary — trickier curves, shorter clock */
    kick: function () {
      return {
        anchors: [J(0.54, -0.36, 0.035), J(0.30, -0.13, 0.025), J(0, 0, 0.008), J(-0.10, -0.21), J(-0.15, -0.40), J(-0.17, -0.50, 0.01)],
        hipA: 2, neckA: 4, leadA: [0, 2], leadRoot: 'end',
        headSide: 0, headDist: 0.085, headR: 0.075,
        leadW: [0.060, 0.042],
        limbs: [
          { p: [J(0, 0, 0.008), J(0.02, 0.32), J(0.00, 0.63, 0.03)], w: [0.062, 0.045] },
          { p: [J(-0.13, -0.37, 0.01), J(0.02, -0.41, 0.03), J(0.15, -0.37, 0.03)], w: [0.048, 0.034] },
          { p: [J(-0.13, -0.37, 0.01), J(-0.27, -0.27, 0.03), J(-0.33, -0.13, 0.03)], w: [0.048, 0.034] }
        ]
      };
    },
    lean: function () { /* lean-back: hips forward, chest open */
      return {
        anchors: [J(0, 0, 0.008), J(0.07, -0.20), J(-0.08, -0.37), J(-0.30, -0.57, 0.035)],
        hipA: 0, neckA: 2, leadA: [2, 3], leadRoot: 'start',
        headSide: 60, headDist: 0.10, headR: 0.075,
        leadW: [0.048, 0.030],
        limbs: [
          { p: [J(-0.06, -0.35, 0.01), J(0.05, -0.44, 0.03), J(0.16, -0.49, 0.03)], w: [0.048, 0.034] },
          { p: [J(0, 0, 0.008), J(0.12, 0.30, 0.025), J(0.18, 0.61, 0.03)], w: [0.062, 0.045] },
          { p: [J(0, 0, 0.008), J(-0.07, 0.31, 0.025), J(-0.14, 0.60, 0.03)], w: [0.062, 0.045] }
        ]
      };
    },
    crouch: function () { /* curled C diving into a ground reach */
      return {
        anchors: [J(0, 0, 0.008), J(0.11, -0.17), J(0.25, -0.12), J(0.31, 0.20, 0.03)],
        hipA: 0, neckA: 2, leadA: [2, 3], leadRoot: 'start',
        headSide: -90, headDist: 0.09, headR: 0.07,
        leadW: [0.046, 0.030],
        limbs: [
          { p: [J(0, 0, 0.008), J(0.17, 0.10, 0.02), J(0.08, 0.31, 0.025)], w: [0.062, 0.046] },
          { p: [J(0.01, 0.02, 0.008), J(0.21, 0.15, 0.02), J(0.12, 0.35, 0.025)], w: [0.058, 0.042] },
          { p: [J(0.22, -0.10, 0.01), J(0.16, 0.05, 0.025), J(0.13, 0.20, 0.025)], w: [0.046, 0.032] }
        ]
      };
    }
  };

  var POSE_KINDS = [['reach', 'lunge'], ['kick', 'lean', 'crouch']];

  function mirrorDef(def) {
    var i, j;
    for (i = 0; i < def.anchors.length; i++) def.anchors[i].x = -def.anchors[i].x;
    for (i = 0; i < def.limbs.length; i++) {
      for (j = 0; j < def.limbs[i].p.length; j++) def.limbs[i].p[j].x = -def.limbs[i].p[j].x;
    }
    def.headSide = -def.headSide;
  }

  function buildPose(poseNo, W, H) {
    var kinds = POSE_KINDS[poseNo];
    var kind = kinds[Math.floor(Math.random() * kinds.length)];
    var def = POSE_DEFS[kind]();
    if (Math.random() < 0.5) mirrorDef(def);

    var sweep = catmullRom(def.anchors, PER_SEG);
    var hipIdx = def.hipA * PER_SEG;
    var neckIdx = def.neckA * PER_SEG;

    var tN = tangentAt(sweep, neckIdx);
    var hv = rotv(tN, def.headSide);
    var headC = {
      x: sweep[neckIdx].x + hv.x * def.headDist,
      y: sweep[neckIdx].y + hv.y * def.headDist
    };

    var ribIdx = Math.round(hipIdx + (neckIdx - hipIdx) * 0.62);
    var tR = tangentAt(sweep, ribIdx);
    /* pelvis aligns with the spine's base direction (toward the neck) */
    var stepDir = neckIdx > hipIdx ? 2 : -2;
    var hp = sweep[hipIdx];
    var hq = sweep[Math.max(0, Math.min(sweep.length - 1, hipIdx + stepDir))];
    var pelvAng = Math.atan2(hq.y - hp.y, hq.x - hp.x);

    /* unit bbox over everything the figure occupies */
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, i, j, p;
    function grow(x, y) {
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    for (i = 0; i < sweep.length; i++) grow(sweep[i].x, sweep[i].y);
    for (i = 0; i < def.limbs.length; i++) {
      for (j = 0; j < def.limbs[i].p.length; j++) { p = def.limbs[i].p[j]; grow(p.x, p.y); }
    }
    grow(headC.x - def.headR, headC.y - def.headR);
    grow(headC.x + def.headR, headC.y + def.headR);
    minx -= 0.05; miny -= 0.05; maxx += 0.05; maxy += 0.05;
    var bw = maxx - minx, bh = maxy - miny;

    var F = Math.min((W - 70) / bw, (H - 52) / bh, 420);
    if (!isFinite(F) || F <= 0) F = 100;
    var tx = (W - bw * F) / 2 - minx * F;
    var ty = (H - bh * F) / 2 - miny * F;
    function T(q) { return { x: q.x * F + tx, y: q.y * F + ty }; }

    var pose = {
      kind: kind,
      sweep: [],
      hipIdx: hipIdx,
      neckIdx: neckIdx,
      lead: def.leadA ? { from: def.leadA[0] * PER_SEG, to: def.leadA[1] * PER_SEG, root: def.leadRoot } : null,
      leadW1: Math.max(3, def.leadW[0] * F),
      leadW2: Math.max(2.5, def.leadW[1] * F),
      head: { c: T(headC), r: def.headR * F },
      ribs: { c: T(sweep[ribIdx]), ang: Math.atan2(tR.y, tR.x), along: 0.16 * F, across: 0.115 * F },
      pelvis: { c: T(hp), ang: pelvAng, along: 0.06 * F, across: 0.10 * F },
      limbs: [],
      size: Math.max(bw, bh) * F,
      top: miny * F + ty,
      cx: ((minx + maxx) / 2) * F + tx
    };
    for (i = 0; i < sweep.length; i++) pose.sweep.push(T(sweep[i]));
    for (i = 0; i < def.limbs.length; i++) {
      pose.limbs.push({
        a: T(def.limbs[i].p[0]), b: T(def.limbs[i].p[1]), c: T(def.limbs[i].p[2]),
        w1: Math.max(3, def.limbs[i].w[0] * F),
        w2: Math.max(2.5, def.limbs[i].w[1] * F)
      });
    }
    return pose;
  }

  /* ============================================================
     Canvas / DOM from here down.
     ============================================================ */
  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');
  var ratePanel = document.getElementById('ratePanel');
  var rateStars = document.getElementById('rateStars');
  var archiveSec = document.getElementById('archiveSec');
  var archiveStrip = document.getElementById('archiveStrip');
  var viewer = document.getElementById('viewer');
  var viewerImg = document.getElementById('viewerImg');
  var viewerCap = document.getElementById('viewerCap');
  var viewerClose = document.getElementById('viewerClose');

  ArtDaily.init({ slug: SLUG });

  /* ---- theme-aware inks (re-read on every repaint) ---- */
  function parseColor(str) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((str || '').trim());
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
    }
    m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec((str || '').trim());
    return m ? [+m[1], +m[2], +m[3]] : null;
  }

  /* wa parts of a over (1-wa) of b — the canvas twin of CSS color-mix */
  function mixColor(a, b, wa) {
    var A = parseColor(a), B = parseColor(b);
    if (!A || !B) return b; /* unparseable? fall back to the safe ink */
    function ch(i) { return Math.round(A[i] * wa + B[i] * (1 - wa)); }
    return 'rgb(' + ch(0) + ',' + ch(1) + ',' + ch(2) + ')';
  }

  function inks() {
    var cs = getComputedStyle(document.documentElement);
    var ink = cs.getPropertyValue('--ink').trim();
    var accent = cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--lilac').trim();
    return {
      ink: ink,
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      accent: accent,
      /* raw lilac is only ~3.5:1 on the paper card — fine for 3px lines,
         short of AA for small text. Ink it toward graphite on light (the
         same 55% mix the CSS uses for .hud-stat dd); pure accent already
         clears AA on the dark sheet. */
      accentText: ArtDaily.theme() === 'dark' ? accent : mixColor(accent, ink, 0.55)
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * 0.7);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---- round state ---- */
  var state = 'done';   /* 'teach' | 'show' | 'last' | 'rate' | 'between' | 'done' */
  var round = 0, poseIdx = 0, poseScores = [], pose = null;
  /* the fit each pose earned, kept so the round can close on the two
     numbers rather than only on a toast (see finishRound) — and the
     fitKind() state behind each of them, which is what the round-end
     coaching is built from (see roundCoach) */
  var poseFits = [], poseKinds = [];
  var strokes = [], cur = null, activePtr = null, activeType = '';
  var deadline = 0, lockAt = 0, fadeAt = 0, rafId = 0, teachUntil = 0;
  var pendingFit = 0, pendingHadStroke = false, pendingKind = 'none';
  var starTimer = null;
  /* the pending hand-off beat {ps, holdMs}, kept apart from its timer
     handle so a hidden tab can park it and hand it back in full — see the
     visibilitychange handler */
  var handoff = null;
  /* the round's reported result, banked the moment the second pose is
     rated — finishRound() is presentation only (see the star handler) */
  var roundResult = null;

  /* Plain English first, the term second — and the term is taught by
     the canvas (round 1 pose 1 shows the line before asking for it),
     not by a word the player is expected to already own. */
  function poseHint() {
    return poseIdx === 0
      ? 'pose 1 of 2 — draw the one line the whole body flows along, head down through the hips to the far foot. up to 5 strokes, then done ✓.'
      : 'pose 2 of 2 — quicker now: catch that flowing line before the pose fades.';
  }

  function startPose() {
    pose = buildPose(poseIdx, W, H);
    strokes = [];
    cur = null;
    activePtr = null;
    activeType = '';
    /* first pose a player ever sees: show the answer for a beat. The
       term used to be charged for 30 seconds before it was explained. */
    var teach = round === 1 && poseIdx === 0;
    teachUntil = teach ? Date.now() + TEACH_MS : 0;
    state = teach ? 'teach' : 'show';
    deadline = Date.now() + (teach ? TEACH_MS : 0) + POSE_MS[poseIdx];
    hint.textContent = teach
      ? 'watch: that coloured curve is the pose’s line of action — the single line the whole body flows along. it goes away in a moment, then you draw it.'
      : poseHint();
    draw();
    startLoop();
  }

  function newRound() {
    clearTimeout(starTimer);
    starTimer = null;
    handoff = null;
    stopLoop();
    /* A round whose second pose is already rated and banked, but whose
       hand-off beat has not run yet, still has its whole closing screen
       pending: the two fits side by side, the round's coaching line and
       the new-best toast. report() had happened, so nothing was
       double-counted — but an impatient press inside that window (380ms
       after a rating, 1.8s after an empty pose) simply deleted the
       player's result screen, which is the one thing every sibling drill
       flushes here. `state !== 'done'` keeps a round that already closed
       normally from replaying its toast. */
    if (roundResult && state !== 'done') finishRound();
    round += 1;
    poseIdx = 0;
    poseScores = [];
    poseFits = [];
    poseKinds = [];
    roundResult = null;
    ratePanel.hidden = true;
    litTo(0);
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    startPose();
  }

  /* ---- countdown loop ---- */
  function loop() {
    rafId = 0;
    if (state !== 'teach' && state !== 'show' && state !== 'last') return;
    var now = Date.now();
    if (state === 'teach') {
      if (now >= teachUntil) {
        state = 'show';
        hint.textContent = poseHint();
      }
      draw();
      rafId = requestAnimationFrame(loop);
      return;
    }
    if (state === 'show' && now >= deadline) {
      state = 'last';
      fadeAt = now;
      lockAt = now + LAST_MS;
      hint.textContent = 'last strokes! the pose faded — finish your line from memory.';
    }
    if (state === 'last' && now >= lockAt) { finishPose(); return; }
    draw();
    rafId = requestAnimationFrame(loop);
  }
  function startLoop() { if (!rafId) rafId = requestAnimationFrame(loop); }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

  /* ---- pose finish → fit + self-rating ---- */
  function finishPose() {
    stopLoop();
    commitCur();
    pendingHadStroke = strokes.length > 0;
    var parts = pendingHadStroke ? chamferParts(strokes, pose.sweep, RESAMPLE_N) : null;
    pendingFit = pendingHadStroke
      ? Math.round(fitScore(parts.worst, pose.size,
          ArtDaily.ease(FREE_FLOOR_PX), ArtDaily.ease(SPAN_FLOOR_PX)))
      : 0;
    /* the state behind the verdict, banked with the pose so the round can
       close on the habit rather than on two bare percentages */
    pendingKind = fitKind(parts, pendingFit);
    if (!pendingHadStroke) {
      /* Nothing was drawn, so there is no gesture to rate. Asking anyway let
         an empty sheet collect the self-rating's whole 40 points: sit out both
         poses, click five stars twice, and the round banked 40/100 for having
         drawn nothing at all. An empty pose is a 0, and the true line stays up
         long enough to be worth looking at. */
      state = 'between';
      ratePanel.hidden = true;
      hint.textContent = 'time — nothing landed on the sheet, so this pose scores 0. ' +
        'the coloured curve is the line that was there to catch.';
      draw();
      advancePose(0, EMPTY_HOLD_MS);
      return;
    }
    state = 'rate';
    saveThumb(pendingFit);
    /* the percentage is the magnitude; the verdict is the direction.
       Without it "48%" leaves the player guessing whether they drew the
       wrong curve or a third of the right one. */
    hint.textContent = 'the coloured line is the pose’s true line of action. you followed it ' +
      pendingFit + '% of the way (all your strokes count) — ' + fitVerdict(parts, pendingFit) +
      ' now say how it felt.';
    ratePanel.hidden = false;
    draw();
    var first = rateStars.querySelector('.star');
    if (first) first.focus();
  }

  /* Bank one pose and hand off to the next (or to the round's end). Shared by
     the star click and the empty-sheet path so there is exactly one place a
     pose score is recorded and exactly one report site. */
  function advancePose(ps, holdMs) {
    poseScores.push(ps);
    poseFits.push(pendingFit);
    poseKinds.push(pendingKind);
    if (poseIdx > 0) {
      /* both poses are in — the round is complete NOW, so it is banked here
         rather than after the hand-off hold: "new round" (which clears the
         timer below) or the embed dialog closing inside that window used to
         throw two drawn poses away. finishRound() is presentation only; this
         is the single report site. */
      roundResult = ArtDaily.report(roundMean(poseScores));
      hudScore.textContent = String(roundResult.score);
      hudBest.textContent = roundResult.best === null ? '–' : String(roundResult.best);
    }
    handoff = { ps: ps, holdMs: holdMs };
    armHandoff();
  }

  function armHandoff() {
    if (!handoff) return;
    clearTimeout(starTimer);
    starTimer = setTimeout(function () {
      starTimer = null;
      var h = handoff;
      handoff = null;
      if (!h) return;
      ratePanel.hidden = true;
      litTo(0);
      if (poseIdx === 0) {
        showToast('pose 1 — ' + Math.round(h.ps), false);
        poseIdx = 1;
        startPose();
      } else {
        finishRound();
      }
    }, handoff.holdMs);
  }

  /* ---- stars ---- */
  var starBtns = [];
  (function () {
    var els = rateStars.querySelectorAll('.star'), i;
    for (i = 0; i < els.length; i++) starBtns.push(els[i]);
  })();

  function litTo(n) {
    var i;
    for (i = 0; i < starBtns.length; i++) {
      starBtns[i].classList.toggle('lit', i < n);
    }
  }

  starBtns.forEach(function (btn, idx) {
    btn.addEventListener('pointerenter', function () { if (state === 'rate') litTo(idx + 1); });
    btn.addEventListener('focus', function () { if (state === 'rate') litTo(idx + 1); });
    btn.addEventListener('click', function () {
      if (state !== 'rate') return;
      state = 'between';
      litTo(idx + 1);
      advancePose(poseScore(pendingFit, starScore(idx + 1)), HANDOFF_MS);
    });
  });
  rateStars.addEventListener('pointerleave', function () { if (state === 'rate') litTo(0); });

  /* "you followed the two lines 71% and 48% of the way — " and nothing at
     all when the numbers are missing, so the sentence after it reads the
     same either way. */
  function fitsPhrase() {
    var a = poseFits[0], b = poseFits[1];
    if (!isFinite(a) || !isFinite(b)) return '';
    return 'you followed the two lines ' + Math.round(a) + '% and ' + Math.round(b) +
      '% of the way. ';
  }

  /* Presentation only: the star click already reported the round the
     instant the second pose was rated, so every completed round reaches
     ArtDaily.report exactly once — even if this never runs. */
  function finishRound() {
    state = 'done';
    var res = roundResult;
    /* The strip is the reason to come back tomorrow, and it used to be a
       silent section below the fold. Name it every time it grows. */
    var kept = loadArchive().length;
    /* Pose 1's fit was said once, 20-odd seconds and a whole pose ago, and
       then only in a toast that had already timed out. Two numbers side by
       side are the only place a player can see whether the harder pose
       actually cost them anything. */
    /* …and the round's lesson, not just its exit: two separate verdicts
       add up to one habit worth naming */
    var coach = roundCoach(poseKinds);
    hint.textContent = 'round done — ' + fitsPhrase() + (coach ? coach + ' ' : '') +
      (kept === 1 ? '1 gesture' : kept + ' gestures') +
      ' saved in your strip below. press "new round" for two more poses.';
    if (res) {
      hudScore.textContent = String(res.score);
      hudBest.textContent = res.best === null ? '–' : String(res.best);
      showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
    }
    draw();
  }

  /* ---- painting (canvas bg stays clear so the CSS dot-grid shows) ---- */
  function paintPolyline(g, pts, from, to) {
    if (to - from < 1) return;
    g.beginPath();
    g.moveTo(pts[from].x, pts[from].y);
    for (var i = from + 1; i <= to; i++) g.lineTo(pts[i].x, pts[i].y);
    g.stroke();
  }

  function paintMannequin(g, c, alpha) {
    if (!pose) return;
    var i, m;
    g.save();
    g.globalAlpha = alpha;
    g.strokeStyle = c.muted;
    g.fillStyle = c.muted;
    g.lineCap = 'round';
    g.lineJoin = 'round';

    /* spine — the torso stretch of the sweep, drawn lightly */
    g.lineWidth = 3;
    paintPolyline(g, pose.sweep, Math.min(pose.hipIdx, pose.neckIdx), Math.max(pose.hipIdx, pose.neckIdx));

    /* pelvis box */
    g.save();
    g.translate(pose.pelvis.c.x, pose.pelvis.c.y);
    g.rotate(pose.pelvis.ang);
    g.beginPath();
    g.rect(-pose.pelvis.along, -pose.pelvis.across, pose.pelvis.along * 2, pose.pelvis.across * 2);
    g.fill();
    g.restore();

    /* ribcage egg */
    g.beginPath();
    g.ellipse(pose.ribs.c.x, pose.ribs.c.y, pose.ribs.along, pose.ribs.across, pose.ribs.ang, 0, Math.PI * 2);
    g.fill();

    /* head ball */
    g.beginPath();
    g.arc(pose.head.c.x, pose.head.c.y, pose.head.r, 0, Math.PI * 2);
    g.fill();

    /* off-sweep limbs — tapered capsules as two round-cap segments */
    for (i = 0; i < pose.limbs.length; i++) {
      m = pose.limbs[i];
      g.lineWidth = m.w1;
      g.beginPath(); g.moveTo(m.a.x, m.a.y); g.lineTo(m.b.x, m.b.y); g.stroke();
      g.lineWidth = m.w2;
      g.beginPath(); g.moveTo(m.b.x, m.b.y); g.lineTo(m.c.x, m.c.y); g.stroke();
    }

    /* the leading limb rides the sweep itself, thick at its root */
    if (pose.lead) {
      var f = pose.lead.from, t = pose.lead.to, mid = Math.round((f + t) / 2);
      var rootFirst = pose.lead.root === 'start';
      g.lineWidth = rootFirst ? pose.leadW1 : pose.leadW2;
      paintPolyline(g, pose.sweep, f, mid);
      g.lineWidth = rootFirst ? pose.leadW2 : pose.leadW1;
      paintPolyline(g, pose.sweep, mid, t);
    }
    g.restore();
  }

  function paintSweep(g, c, alpha) {
    if (!pose) return;
    g.save();
    g.globalAlpha = alpha;
    g.strokeStyle = c.accent;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = 3;
    paintPolyline(g, pose.sweep, 0, pose.sweep.length - 1);
    g.restore();
  }

  function paintStrokes(g, c) {
    var i;
    g.save();
    g.strokeStyle = c.ink;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = 2.5;
    for (i = 0; i < strokes.length; i++) {
      paintPolyline(g, strokes[i], 0, strokes[i].length - 1);
    }
    if (cur) paintPolyline(g, cur, 0, cur.length - 1);
    g.restore();
  }

  function paintRing(g, c) {
    var now = Date.now(), frac, secs, urgent = state === 'last';
    if (urgent) {
      frac = clamp01((lockAt - now) / LAST_MS);
      secs = Math.max(0, Math.ceil((lockAt - now) / 1000));
    } else {
      frac = clamp01((deadline - now) / POSE_MS[poseIdx]);
      secs = Math.max(0, Math.ceil((deadline - now) / 1000));
    }
    var x = W - 34, y = 32, r = 17;
    g.save();
    g.lineCap = 'round';
    g.lineWidth = 4;
    g.globalAlpha = 0.25;
    g.strokeStyle = c.muted;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 1;
    g.strokeStyle = c.accent;
    g.lineWidth = urgent ? 5 : 4;
    if (frac > 0) {
      g.beginPath();
      g.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
      g.stroke();
    }
    g.fillStyle = urgent ? c.accentText : c.muted;
    g.font = '700 11px ' + MONO;
    g.textAlign = 'center';
    g.fillText(String(secs), x, y + 4);
    g.restore();
  }

  function paintFitChip(g, c) {
    if (!pose) return;
    /* "fit 62%" said nothing — fit to what, and is 62 good? */
    var label = 'you followed it ' + pendingFit + '%';
    var x = Math.max(40, Math.min(W - 44, pose.cx));
    var y = Math.max(20, pose.top - 8);
    g.save();
    g.font = '800 13px ' + MONO;
    g.textAlign = 'center';
    var w = g.measureText(label).width + 16;
    g.globalAlpha = 0.92;
    g.fillStyle = c.card;
    g.fillRect(x - w / 2, y - 13, w, 19);
    g.globalAlpha = 1;
    g.fillStyle = c.accentText;
    g.fillText(label, x, y + 1);
    g.restore();
  }

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    if (!pose) return;
    var reveal = state === 'rate' || state === 'between' || state === 'done';
    /* after the countdown the pose FADES to 12% — faint, not gone;
       the rAF loop is live during 'last', so this eases over FADE_MS */
    var mAlpha = 0.12;
    if (state === 'show' || state === 'teach') {
      mAlpha = 0.9;
    } else if (state === 'last') {
      var ft = clamp01((Date.now() - fadeAt) / FADE_MS);
      mAlpha = 0.9 + (0.12 - 0.9) * ft;
    }
    paintMannequin(ctx, c, mAlpha);
    if (reveal) paintSweep(ctx, c, 0.9);
    /* the teaching beat: the line is named on screen before it is asked for */
    else if (state === 'teach') paintSweep(ctx, c, 0.55);
    paintStrokes(ctx, c);
    if (state === 'show' || state === 'last') paintRing(ctx, c);
    if (reveal) paintFitChip(ctx, c);
  }

  /* ---- input: up to three pointer strokes, pointerId-guarded ---- */
  function pointerPos(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  /* This drill is about fast flicks, so it is the one most damaged by
     dispatch-rate decimation — take every coalesced sample. */
  function pushSamples(ev, arr) {
    var list = null;
    try { list = ev.getCoalescedEvents ? ev.getCoalescedEvents() : null; } catch (e) { list = null; }
    if (list && list.length) {
      for (var i = 0; i < list.length; i++) arr.push(pointerPos(list[i]));
      return;
    }
    arr.push(pointerPos(ev));
  }

  /* Palm rejection: a palm landing before the nib used to own the whole
     sweep while the clock ran down. A pen takes it back. */
  var penAt = -Infinity, PEN_GUARD_MS = 900;
  function claimAllowed(ev) {
    if (ev.pointerType === 'pen') { penAt = performance.now(); return true; }
    if (ev.pointerType === 'touch' && performance.now() - penAt < PEN_GUARD_MS) return false;
    return true;
  }

  function commitCur() {
    if (!cur) return;
    /* Length alone separates a tap from a sweep — a sample-count floor
       would silently drop legitimately FAST flicks (the whole drill) on
       devices that deliver few pointermove events. */
    if (cur.length >= 2 && polyLength(cur) >= MIN_LEN) {
      strokes.push(cur);
    } /* else: accidental tap — vanishes, no penalty */
    cur = null;
    activePtr = null;
    activeType = '';
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (state !== 'show' && state !== 'last') return;
    if (!claimAllowed(ev)) return;
    if (cur) {
      /* one pointer draws at a time — unless a pen arrives, in which
         case the palm's drift is discarded and the nib takes over */
      if (ev.pointerType !== 'pen' || activeType === 'pen') return;
      cur = null;
    }
    ev.preventDefault();
    if (strokes.length >= MAX_STROKES) {
      hint.textContent = 'that is ' + MAX_STROKES + ' strokes — press done ✓ (or clear and re-sweep).';
      return;
    }
    activePtr = ev.pointerId;
    activeType = ev.pointerType || '';
    cur = [pointerPos(ev)];
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (!cur || ev.pointerId !== activePtr) return;
    ev.preventDefault();
    pushSamples(ev, cur);
    if (state !== 'show' && state !== 'last') draw();
  });

  function endStroke(ev) {
    if (!cur || ev.pointerId !== activePtr) return;
    ev.preventDefault();
    commitCur();
    /* Say the two things a beginner cannot see: every stroke counts,
       and the clock is a ceiling rather than a target. */
    if (state === 'show' && strokes.length) {
      hint.textContent = strokes.length > 1
        ? 'all ' + strokes.length + ' strokes count as one line — press done ✓ whenever you have it.'
        : 'press done ✓ whenever you have it — the clock is a ceiling, not a target. lifting is free.';
    }
    draw();
  }
  canvas.addEventListener('pointerup', endStroke);
  /* fallback if pointer capture failed and the release lands off-canvas */
  window.addEventListener('pointerup', endStroke);

  function cancelStroke(ev) {
    if (!cur || ev.pointerId !== activePtr) return;
    /* interrupted stroke (system gesture etc.) — dropped, no penalty */
    cur = null;
    activePtr = null;
    activeType = '';
    draw();
  }
  canvas.addEventListener('pointercancel', cancelStroke);
  window.addEventListener('pointercancel', cancelStroke);
  /* iOS can drop the capture with NO pointerup and NO pointercancel. Without
     this the sweep never ends: `cur` stays live, every later press is refused
     by the pen-takeover guard, and the pose's clock runs out on a dead sheet.
     lostpointercapture always fires on the capturing element, and after a
     normal pointerup it is a no-op (`cur` is already null). */
  canvas.addEventListener('lostpointercapture', cancelStroke);

  /* ---- done / clear ---- */
  document.getElementById('btnDone').addEventListener('click', function () {
    if (state !== 'show' && state !== 'last') return;
    commitCur();
    if (!strokes.length) {
      hint.textContent = 'draw the line first — one flowing curve, head down through the hips.';
      return;
    }
    finishPose();
  });

  document.getElementById('btnClear').addEventListener('click', function () {
    if (state !== 'show' && state !== 'last') return;
    strokes = [];
    cur = null;
    activePtr = null;
    activeType = '';
    hint.textContent = 'cleared — same pose, fresh line.';
    draw();
  });

  /* ---- the archive: last 12 gestures, the real reward ---- */
  function loadArchive() {
    try {
      var a = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }

  function saveThumb(fit) {
    try {
      var tw = 240;
      var th = Math.round(tw * H / W);
      var oc = document.createElement('canvas');
      oc.width = tw;
      oc.height = th;
      var g = oc.getContext('2d');
      var c = inks();
      g.fillStyle = c.card;
      g.fillRect(0, 0, tw, th);
      g.scale(tw / W, tw / W);
      paintMannequin(g, c, 0.3);
      paintSweep(g, c, 0.85);
      paintStrokes(g, c);
      var a = loadArchive();
      a.push({ img: oc.toDataURL('image/png'), fit: fit });
      while (a.length > ARCHIVE_MAX) a.shift();
      localStorage.setItem(ARCHIVE_KEY, JSON.stringify(a));
      renderStrip();
    } catch (e) { /* quota or serialization trouble — skip silently */ }
  }

  var lastThumbOpener = null;

  function renderStrip() {
    var a = loadArchive(), i;
    archiveSec.hidden = a.length === 0;
    archiveStrip.innerHTML = '';
    for (i = a.length - 1; i >= 0; i--) {
      (function (item) {
        var btn = document.createElement('button');
        btn.className = 'thumb';
        btn.type = 'button';
        var img = document.createElement('img');
        img.src = item.img;
        img.alt = 'saved gesture, fit ' + item.fit + '%';
        btn.appendChild(img);
        btn.addEventListener('click', function () { openViewer(item, btn); });
        archiveStrip.appendChild(btn);
      })(a[i]);
    }
  }

  function openViewer(item, opener) {
    lastThumbOpener = opener || null;
    viewerImg.src = item.img;
    viewerCap.textContent = 'your line followed the pose’s line of action ' + item.fit +
      '% of the way — the coloured curve is that line';
    viewer.hidden = false;
    viewerClose.focus();
  }

  function closeViewer() {
    viewer.hidden = true;
    if (lastThumbOpener) { try { lastThumbOpener.focus(); } catch (e) {} }
    lastThumbOpener = null;
  }

  viewerClose.addEventListener('click', closeViewer);
  viewer.addEventListener('click', function (ev) { if (ev.target === viewer) closeViewer(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !viewer.hidden) closeViewer();
  });

  /* ---- toast ---- */
  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ---- chrome wiring ---- */
  document.getElementById('btnRound').addEventListener('click', newRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);

  /* Hardware swapped mid-session — the eased floors are read at scoring
     time, so the sheet just needs a repaint. */
  ArtDaily.onInput(function () { draw(); });

  /* setTimeout keeps firing while the page is hidden, so a notification or
     an app switch during the hand-off beat used to run it off-screen. That
     costs more here than a missed animation: after pose 1 the beat STARTS
     POSE 2, whose 20-second clock then ran down on a page nobody was
     looking at, and after an empty pose the beat is holding the 1.8s look
     at the true line of action the player just missed — the only reason
     that path exists. Park it and hand it back in full.

     Nothing can be lost by parking it: advancePose() reports a finished
     round synchronously the moment the second pose is banked, so this beat
     only ever starts a POSE or plays the closing screen. */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (starTimer !== null) { clearTimeout(starTimer); starTimer = null; }
      return;
    }
    if (handoff && starTimer === null) armHandoff();
  });

  /* Height tracks width, so a resize is a uniform rescale — the pose,
     the strokes and the clock all survive it. */
  function scaleAll(f) {
    var i, j, s;
    if (!pose) return;
    for (i = 0; i < pose.sweep.length; i++) { pose.sweep[i].x *= f; pose.sweep[i].y *= f; }
    pose.head.c.x *= f; pose.head.c.y *= f; pose.head.r *= f;
    pose.ribs.c.x *= f; pose.ribs.c.y *= f; pose.ribs.along *= f; pose.ribs.across *= f;
    pose.pelvis.c.x *= f; pose.pelvis.c.y *= f; pose.pelvis.along *= f; pose.pelvis.across *= f;
    for (i = 0; i < pose.limbs.length; i++) {
      s = pose.limbs[i];
      s.a.x *= f; s.a.y *= f; s.b.x *= f; s.b.y *= f; s.c.x *= f; s.c.y *= f;
      s.w1 *= f; s.w2 *= f;
    }
    pose.leadW1 *= f; pose.leadW2 *= f;
    pose.size *= f; pose.top *= f; pose.cx *= f;
    for (i = 0; i < strokes.length; i++) {
      for (j = 0; j < strokes[i].length; j++) { strokes[i][j].x *= f; strokes[i][j].y *= f; }
    }
    if (cur) for (j = 0; j < cur.length; j++) { cur[j].x *= f; cur[j].y *= f; }
  }

  window.addEventListener('resize', function () {
    var oldW = W;
    fitCanvas();
    if (oldW > 0 && W !== oldW) scaleAll(W / oldW);
    draw();
  });

  /* ---- boot ---- */
  fitCanvas();
  renderStrip();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
