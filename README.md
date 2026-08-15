# Gesture Capture — an Art Daily drill

Catch the line of action before the pose fades. A procedural mannequin
is built FROM a C/S action-line spline (head ball, ribcage egg, pelvis
box, tapered-capsule limbs — one leading limb continues the line), so
the drill always knows the exact ground truth. Two poses per round
(30s, then 20s); when the ring runs out the pose fades to 12% and you
get five last seconds. Sweep 1–3 flowing strokes, press done ✓.

Scoring is soft and says so: 60% chamfer fit of your longest stroke
against the true sweep, 40% your own star rating of the energy. Your
last 12 gestures are kept as thumbnails in a strip — the real reward.

Plays standalone (`python3 -m http.server 8080`) or embedded in
[artdaily.sadeali.com](https://artdaily.sadeali.com/) via `js/artdaily-sdk.js` (vendored, never edited).
