# Tether — pre-ship review

Reviewed `index.html` in full, then verified the consequential findings by
driving the real build in headless Chromium. The harness is in `tests/` and is
re-runnable:

```sh
npm i playwright          # Chromium already present; skip the browser download
node tests/instrument.mjs
node tests/smoke.mjs
```

**Status: all five ship blockers are fixed, plus the art pass, a Settings menu
and practice mode. 17 of 18 checks pass.**

```
PASS  boots and opens every panel with no runtime error
PASS  same seed + same width reproduces an identical world
PASS  daily seed is identical worldwide at the same instant
PASS  daily world layout is identical across screen widths
PASS  onelife always starts with exactly 1 life
PASS  daily always starts with exactly 3 lives
PASS  pause -> restart cannot exceed the 3-attempt daily cap
FAIL  a ring-earned skin stays equipped after a reload      <- High 7, not yet fixed
PASS  the "High-contrast hazards" setting reaches every hazard draw
PASS  Zen shows a compact life counter, not one pip per life
PASS  Settings opens from the title and the pause menu, with all five controls
PASS  every settings toggle survives a reload
PASS  a guided run earns no coins, rings, or record
PASS  an unguided run still earns coins and sets records (control)
PASS  the Daily Challenge refuses to start while the aim guide is on
PASS  settings can be changed from the pause menu during a run
PASS  closing Settings returns to the pause menu, still operable
PASS  the results screen does not render the world you died in
```

The single remaining failure is a known bug documented under
[Remaining work](#remaining-work). It is deliberately still red so the suite
keeps reporting it.

---

## Fixed

### 1. The Daily Challenge is now the same challenge for everyone

Three independent causes, all closed.

**The seed came from the local calendar date.** `today()` used
`getFullYear/getMonth/getDate`, so the day boundary was the device's. Two
players opening the app at the same instant got different worlds and were then
put on the same leaderboard; winding the device clock forward minted a fresh set
of attempts.

The challenge now keys off `utcDay()`. Missions still roll over at *local*
midnight — they are personal, and a 4pm reset would be strange — so the two
concepts are now separate state (`chal` vs `daily`) with separate storage keys.
`checkChallenge()` only resets when the UTC day *advances*, so winding the clock
backwards no longer grants attempts. Winding it forwards still can; only a
server clock closes that, and the leaderboard submit is the place to check it.

```
before   UTC+14 day=2026-08-17 seed=3630752024 | UTC-11 day=2026-08-16 seed=3647529643
after    UTC+14 day=2026-08-17 seed=3833784079 | UTC-11 day=2026-08-16 seed=3833784079
```

**World layout depended on screen width.** `makePlanet` placed planets with
`clamp(..., margin, W - margin)` where `W` was the live stage width, so a phone
and a tablet played different layouts from the same seed — 5 of 5 planets at
different x.

The world is now authored in a fixed 520-unit-wide virtual space (`VW`) and
drawn through one uniform scale set in `resize()`. Generation never sees the
device width. The first planet also sits at a fixed world `y` (`START_Y`) rather
than `H * .64`, so absolute world coordinates — and any ghost recorded in them —
match across devices.

```
before   stage width 390 vs 520 — 5/5 planets differ in x
after    stage width 390 vs 520 — 0/5 planets differ in x
```

> **Worth knowing:** because the scale is uniform, a 390px-wide phone now draws
> the 520-wide world at 0.75×. Everything is about a quarter smaller than
> before, and roughly a third more of the world is visible vertically. That is
> the cost of identical difficulty everywhere, and it errs toward more
> lookahead, but it is a visible art change — check it on a real device.

**Ghost replay was tied to refresh rate.** Sampling was per-frame
(`ghFrame % 3`) inside a variable-`dt` loop, so a 60 Hz recording replayed at
double speed on a 120 Hz phone. It is now sampled and played back on accumulated
time (`GHOST_DT`, 20 Hz), and capped at `GHOST_MAX` so it cannot grow unbounded
in localStorage.

### 2. Bought lives no longer leak into fixed-life modes

`newRun` did `lives = M.lives + spareLives` unconditionally. Measured with 5
spare lives banked: **One Life started with 6**, **Daily with 8** — the whole
premise of one mode and the comparability of the other.

Modes now carry `noSpares`, set on Daily, One Life and Zen. Those modes ignore
spare lives and, importantly, no longer *consume* them either.

### 3. The three-attempt daily cap holds

`playBtn` and `againBtn` checked attempts; `restartBtn` did not, and `newRun`
incremented unconditionally. Pause → Restart six times consumed **7 of 3** and
play continued.

The check moved into `newRun` itself, so all three entry points are covered by
construction. Out of attempts now toasts and returns to the title.

### 4. The accessibility setting reaches the renderer

The store advertised "High-contrast hazards — amber instead of red". `cbMode`
was toggled, saved and restored, then never read: **0 occurrences in the render
path**, against 7 hardcoded reds.

Hazard colour now resolves through `haz()`, which every hazard draw reads. More
importantly, hazards are **shaped distinctly in both palettes** — hue is the one
channel red-green colourblind players cannot rely on, so "will this kill me?"
has to be answerable with colour discarded entirely. Worlds are smooth discs;
hazards are spiked, hexagonal or cratered.

The coaching line changed from "Red means it kills" to "Spiked means it kills",
which is true in both palettes and teaches the more reliable cue.

*(Superseded by the art pass below: the high-contrast palette is now the sheet's
amber `#FFD666` with a near-black `#120D14` outline at lw 3, and the moon is an
11-point star rather than the interim eight-spike disc. Amber sits close to the
brass used by rings, so the heavy dark outline is what does the separating —
that plus the silhouette, which is the part that survives colourblindness.)*

### 5. The demo store cannot ship

The `.iap` handler credited coins and lives with no payment, and `playAd` was a
five-second placeholder. As shipped that gave the economy away and would not
survive Play review, which does not allow advertising a price that never charges.

Everything real-money now sits behind `const DEMO_BUILD = false`. In a shipping
build the coin packs and lives block is removed from the page entirely, and the
`.iap` handler refuses to grant anything. The store is left as a clean
coin-only economy (lives, boosters, accessibility, skins) — verified, no layout
gaps.

Rewarded video goes through an `Ads` adapter. The native shell bridges a real
SDK in as:

```js
window.TetherAds = { show(label, done){ /* … */ done(true); } };  // false = no reward
```

Until that exists `Ads.ready()` is false and the two reward buttons are hidden
rather than paying out free. The reward is also now granted *in the callback and
only on success*, so a dismissed or failed ad no longer burns the player's one
revive.

---

## Settings menu, practice mode and the Zen life counter

Added after the blocker pass.

**Panel layering.** Panels were `position:absolute` with no `z-index`, so they
stacked in DOM order — and `#pausePanel` is declared after `#settingsPanel`.
Opening Settings from the pause menu therefore put it *behind* the pause panel:
visible through the translucent backdrop, but every click landed on the panel in
front, so settings could not be changed during a run at all. Panels now carry a
base `z-index` and `openPanel()` raises the newest, so the order they happen to
be declared in stops mattering. Every open/close routes through that pair.

The regression test for it uses a real pointer click rather than
`element.click()`, because a DOM click fires straight through an overlay without
noticing — it would have passed on the broken build. Verified against a
pre-fix build: the click is intercepted by `pausePanel` and the test fails.

**The results screen was a photo of your death.** The canvas kept rendering the
frozen gameplay frame, and the panel backdrop is translucent, so every run ended
staring at the exact spot you lost — bright halos and hazards smudging through
behind the score. Menus now draw the background layers only (sky, dust, stars);
the world is skipped for `title` and `over`. Pause deliberately still shows the
world, because there you are about to resume and seeing what you are suspended
in is the point.

The DOM overlays were bleeding through the same way — the score readout, the
level banner, the coaching line and any live toast all sat behind the panel and
showed through. Those are cleared at `endRun` alongside the canvas change.

Writing the test for this turned up a second, real bug. Its control asserts the
frame is static at game over, and it was not: `shake` is set to 12 on death but
only decays inside `step()`, which stops running in the `over` state — so it
stayed pinned above the threshold and `draw()` re-jittered the whole canvas by
`Math.random()` on every frame, forever. Cleared at `endRun` and `showTitle`.

Hiding the HUD then *forced* the fix for Medium 11 rather than leaving it
optional: `continueRun()` never restored the pause button, and now it had a
hidden HUD to restore too. Buying a life or watching a revive ad would have left
the player with no readout and no way to pause on a phone.

**Settings is its own panel**, reachable from the title screen and the pause
menu. High-contrast hazards moved here out of the Store, where it sat between
things that cost coins — the last place anyone looks for an accessibility
option, and it implied the setting was something you buy.

It holds five controls: sound effects, music, haptics, high-contrast hazards,
and the aim guide. All five persist, verified across a reload.

**Sound and haptics are now separate switches.** They shared one flag, so a
player who wanted silence on a bus also lost the vibration that confirms a
capture. The `♪` button remains a quick sound toggle; haptics and music have
their own rows.

**Music is real, not a stub.** There was no music system at all, and adding a
toggle that set an unread flag would have repeated exactly the bug fixed in
blocker 4. It is procedural — two detuned saws through a slowly opening filter,
plus a sparse minor-pentatonic note every few seconds — so it costs no download
and no asset pipeline. Pentatonic because those notes stay consonant under the
capture tones, which climb chromatically with the chain. It starts only after a
real user gesture, since autoplay policy blocks anything earlier.

**The aim guide turns a run into practice.** With it on the guide is always
drawn, and the run yields nothing: no coins, no lifetime rings, no high score,
no mission progress. A `PRACTICE · NOTHING IS RECORDED` badge sits under the
chain readout, and the game-over panel says so instead of showing a best.

Two details worth knowing:

- The flag is latched per run, not read live. Turning the guide on mid-run
  taints that run immediately; turning it off cannot un-taint it. Monotonic in
  one direction is the only version that can't be gamed by switching it on for a
  hard stretch and off again for the record.
- The Daily Challenge refuses to start while it is on, and shows *Aim guide is
  on* in the mode list. Unlimited guided practice on the shared seed would
  hollow out the three-attempt limit.

**Zen's life counter.** 99 lives rendered as 99 pips — a 55-pixel picket fence.
Past five, the HUD now collapses to one pip and a count; endless modes show a
single pip and `∞`. This also fixes the ordinary case of a Classic player who
has banked a dozen spare lives.

While in `endRun` for the practice gating I also moved `save()` to the end of the
function — it ran *before* `totalRings` was updated, so closing the app right
after a run discarded that run's progress toward the ring-earned skins. That was
High 7.

---

## Art pass

Implemented from `design/Tether Art Reference.dc.html` — the visual spec
exported from Claude Design. The look is an antique brass orrery in deep space:
arcs, gradients and polygons only, no bitmaps, so it stays sharp at any scale.

- **Sky ladder** — seven authored depths, then the sheet's cycle rule: hue +18°
  per lap, lightness × 0.92, floored at `#060710`, dust α × 0.8 per lap. Only
  the sky moves with depth; stars, dust, bodies and every semantic colour are
  fixed, so meaning never drifts.
- **Worlds** — the full six-layer stack: atmospheric halo, gradient body,
  drifting surface bands, terminator, rim light, engraved brass outline. Seed
  picks palette, band count and band offsets, so no two neighbours read alike.
- **Rings** — three states (`current` brass with ticks, `target` cream with a
  pulsing halo, `distant` dashed), sharing one tick language: 24 divisions from
  the 12 o'clock mark, 15° apart, radiating outward, every 6th double length.
- **Hazards** — 11-point star moons, hexagonal blades with tapered tips and a
  hub, 9-gon asteroids with crater arcs.
- **Special rings** — told apart by tick language rather than colour alone: gold
  gets coin discs on the long ticks, slingshot gets one-way chevrons and
  sweeping streaks, reversal gets offset half-arcs with opposed arrowheads.
- **Boss** — pulsing two-pass halo, hot body gradient, and a ring that is a
  *band* rather than a line, with 48 ticks spanning it.
- **Traveller** — glow to r·4.2, stretch in flight and squash on landing, and a
  tapered-polygon trail with a gradient down its length. All nine skins moved to
  the sheet's fill/glow/trail values; the two near-black skins carry a rim and a
  higher glow peak, since those dots are read from edge and halo, not fill.

Three deliberate departures, all in favour of the game over the sheet:

1. **Asteroid profiles are normalised.** The sheet specifies radius jitter
   0.72–1.10, which would draw vertices outside the circle the rock actually
   collides on. The profile is scaled so the widest vertex sits exactly on the
   hitbox — a silhouette wider than its hitbox is what makes a death feel stolen.
   The 11-point moon is safe as drawn, since its points sit *on* r and its
   valleys inside.
2. **Tick and chevron lengths are proportional to r**, not the sheet's absolute
   pixels. Rings shrink from 72 to 34 units as difficulty climbs, and an 11px
   tick that reads as a fine graduation on a large ring reads as a starburst on
   a small one.
3. **The boss band is anchored to the gameplay radius.** The sheet sets the band
   from the body radius; here its inner edge is the ring the player actually
   orbits, so what you see is what you ride.

**Performance.** The layer stack is four gradients per world, which is the
classic way to melt a canvas game. Everything except the drifting bands is baked
once per (palette, radius) into a sprite and blitted, with the cache bounded. The
star field is baked into a wrapping strip with only the ~26 flare stars live.
Dust hues are fixed by the sheet rather than derived from the sky, so the dust
sprites are built once per run instead of being rebuilt on every level change —
which also closes Medium 11 from the original review.

---

## Remaining work

Not blockers, but listed in the order I would take them.

### High

**6. Zen contaminates every record, unlock and mission.** `endRun` sets `best`
and `bestRings` with no mode check. Zen has no hazards, no bosses and 99 lives,
so it sets the global high score and ring record, makes the in-world `BEST · n`
line an unreachable number, **unlocks Boss Rush** (gated on `bestRings < 40`),
and farms `runRings` / `chain` / `runScore` / `flawlessLevel` missions risk-free
for coin rewards. Scope records per mode, gate Boss Rush on `bestBoss >= 4` as
originally intended, and exclude Zen from mission progress.

**7. An earned skin will not stay equipped.** *(the one failing check)*
`paintSkins` computes `earned` but only pushes into `ownedSkins` on a purchase,
while `load()` re-equips only if `ownedSkins.includes(d.skin)`. Equip Comet at
500 lifetime rings, reload, and it reverts to Pearl. Push earned skins into
`ownedSkins` when the threshold is crossed.

**8. Only layout is deterministic — hazard phase is not.** Moon and blade angles
integrate from whenever `ensurePlanets()` created the planet (five ahead of the
player), so they depend on how fast the player got there, and `restoreRun` winds
forward only the planets that exist at restore time. Two players on the same
daily seed meet the same layout with different hazard phases. Make phase a pure
function of the clock — `angle = base + rate * clock` evaluated on read — which
also fixes resume drift and makes the ghost meaningful.

**9. No safe-area insets.** `viewport-fit=cover` deliberately extends the page
under the notch and gesture bar, but there is no `env(safe-area-inset-*)`
anywhere. `#hud` sits at `top:0` and `#pauseBtn` / `#muteBtn` at `bottom:14px`,
so on a notched phone the score runs under the status bar and the buttons under
the home indicator.

### Medium

**10. Per-frame cost grows without bound.** `step()` iterates *every* planet and
*every* belt each frame, and both arrays only ever grow. At ring 300 that is 300
planets' moons updated per frame to render about six. Iterate a window around
`cur` and prune belts behind the camera.

**11. The pause button disappears after a continue.** `endRun` hides it;
`playBtn`, `againBtn` and `continueBtn` restore it, but `continueRun()` does not.
After buying a life or watching a revive ad there is no pause button for the rest
of the run, and no Escape key on a phone. One line.

**11. Mode choice is not persisted.** `gameMode` is absent from `save()`, so it
resets to Classic on every launch.

### Low

- Screen shake and the death flash aren't gated on `prefers-reduced-motion`; the
  CSS rule only covers CSS animations, not the canvas.
- Panels aren't `role="dialog"`, most buttons have no accessible label, the
  canvas has no accessible name, and `user-scalable=no` blocks zoom.
- Stars and nebulae keep coordinates generated against the old width after a
  rotation or resize.
- `paintTitle` throws if a saved run references a mode key removed in a later
  build.
- Progress is device-local only — an uninstall or a new phone loses everything.
  Play Games Saved Games would fix it and costs nothing.

---

## What's already right

Worth stating, because it is why the blockers were small changes rather than a
rewrite:

- **The seeded-world design is correct.** `planetRng(seed, i)` gives every planet
  its own generator keyed on `(seed, index)`, so generation never depends on call
  order or player actions — verified byte-identical across two fresh browser
  contexts. Every determinism bug was an *input* to this system (the local date,
  the screen width), never the generator itself.
- **`safeSpawn` / `clearTime`** score every respawn position against every
  hazard's future path, including the "already touching" case most
  implementations miss. With `spawnProtect`, the die-revive-die loop is properly
  closed.
- **Near-miss detection measures the swept segment**, not the end point — the
  difference between firing and not at 575 units/s.
- **The storage adapter** degrades native → localStorage → memory instead of
  silently losing saves in a Capacitor WebView.
- **Backgrounding is treated as a pause**, via both `visibilitychange` and `blur`.
- The comments explain *why*, and several document real bugs already fixed.

---

## Before you upload

1. Bridge `window.TetherAds` and Play Billing, then re-enable the store items you
   want. `DEMO_BUILD` stays `false`.
2. Check the new 0.75× scale on a real phone — it is the one change here with a
   visible art consequence.
3. Take High 6–7 if you can; 6 in particular affects what the leaderboard means.
