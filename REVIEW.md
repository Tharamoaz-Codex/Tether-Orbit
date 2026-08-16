# Tether — pre-ship review

Reviewed `index.html` in full, then verified the consequential findings by
driving the real build in headless Chromium. The harness is in `tests/` and is
re-runnable:

```sh
npm i playwright          # Chromium already present; skip the browser download
node tests/instrument.mjs
node tests/smoke.mjs
```

**Status: all five ship blockers are fixed. 8 of 9 checks pass.**

```
PASS  boots and opens every panel with no runtime error
PASS  same seed + same width reproduces an identical world
PASS  daily seed is identical worldwide at the same instant
PASS  daily world layout is identical across screen widths
PASS  onelife always starts with exactly 1 life
PASS  daily always starts with exactly 3 lives
PASS  pause -> restart cannot exceed the 3-attempt daily cap
FAIL  a ring-earned skin stays equipped after a reload      <- High 8, not yet fixed
PASS  the "High-contrast hazards" setting reaches every hazard draw
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
importantly, hazards are now **spiked in both palettes** — hue is the one channel
red-green colourblind players cannot rely on, so "will this kill me?" has to be
answerable with colour discarded. Planets are smooth discs; hazards have eight
spikes stroked *outside* the fill. The solid core still marks the exact collision
radius, so the silhouette never overstates the hitbox.

The colourblind palette is a strong orange (`#FF8C1A`) rather than a soft amber,
to stay clear of the brass used by rings and the HUD. The coaching line changed
from "Red means it kills" to "Spiked means it kills", which is true in both
modes and teaches the more reliable cue.

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

**7. Lifetime rings and boss progress can be lost.** `endRun` calls `save()`
before incrementing `totalRings`, and `bestBoss` is never saved at the point it
changes. Both gate skin unlocks, so closing the app right after a run discards
that run's progress toward Comet, Lantern and Eclipse. Move `save()` to the end
of `endRun`.

**8. An earned skin will not stay equipped.** *(the one failing check)*
`paintSkins` computes `earned` but only pushes into `ownedSkins` on a purchase,
while `load()` re-equips only if `ownedSkins.includes(d.skin)`. Equip Comet at
500 lifetime rings, reload, and it reverts to Pearl. Push earned skins into
`ownedSkins` when the threshold is crossed.

**9. Only layout is deterministic — hazard phase is not.** Moon and blade angles
integrate from whenever `ensurePlanets()` created the planet (five ahead of the
player), so they depend on how fast the player got there, and `restoreRun` winds
forward only the planets that exist at restore time. Two players on the same
daily seed meet the same layout with different hazard phases. Make phase a pure
function of the clock — `angle = base + rate * clock` evaluated on read — which
also fixes resume drift and makes the ghost meaningful.

**10. No safe-area insets.** `viewport-fit=cover` deliberately extends the page
under the notch and gesture bar, but there is no `env(safe-area-inset-*)`
anywhere. `#hud` sits at `top:0` and `#pauseBtn` / `#muteBtn` at `bottom:14px`,
so on a notched phone the score runs under the status bar and the buttons under
the home indicator.

### Medium

**11. Per-frame cost grows without bound.** `step()` iterates *every* planet and
*every* belt each frame, and both arrays only ever grow. At ring 300 that is 300
planets' moons updated per frame to render about six. Iterate a window around
`cur` and prune belts behind the camera.

**12. Nebula sprites are rebuilt far too often.** `buildNebulae()` allocates five
canvases up to ~760×760 (~11 MB) and runs twice in `newRun`, again in
`restoreRun`, and on every level-up — every ten rings. Build once and tint at
draw time.

**13. The pause button disappears after a continue.** `endRun` hides it;
`playBtn`, `againBtn` and `continueBtn` restore it, but `continueRun()` does not.
After buying a life or watching a revive ad there is no pause button for the rest
of the run, and no Escape key on a phone. One line.

**14. Mode choice is not persisted.** `gameMode` is absent from `save()`, so it
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
3. Take High 6–8 if you can; 6 in particular affects what the leaderboard means.
