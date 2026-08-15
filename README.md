# Gesture Capture — an Art Daily drill

Catch the line of action before the pose fades. A procedural mannequin
is built FROM a C/S action-line spline (head ball, ribcage egg, pelvis
box, tapered-capsule limbs — one leading limb continues the line), so
the drill always knows the exact ground truth. Two poses per round
(30s, then 20s); when the ring runs out the pose fades to 12% and you
get five last seconds. Sweep up to 5 flowing strokes, press done ✓.
The very first pose of your first round paints the true line for 1.6s
before the clock starts — the term is taught by the canvas, not
charged for.

Scoring is soft and says so: 60% chamfer fit of ALL your strokes
against the true sweep (they are read as one line, so lifting to
reposition — which a trackpad has to do — costs nothing; scoring only
the longest stroke used to delete half a split sweep and then charge
for the miss), 40% your own read of how the stroke felt. The free zone
and the ramp both have pixel floors run through `ArtDaily.ease()`, so
a ~158px pose on a phone is not judged against a 23px-wide ramp. Your
last 12 gestures are kept as thumbnails in a strip — the real reward,
and the round-end line now says how many are in it.

Plays standalone (`python3 -m http.server 8080`) or embedded in
[artdaily.sadeali.com](https://artdaily.sadeali.com/) via `js/artdaily-sdk.js` (vendored, never edited).
