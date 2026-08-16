# Tether — pre-ship review

Reviewed `index.html` (1,985 lines) in full, then verified the consequential
findings by driving the real build in headless Chromium. The harness is in
`tests/` and is re-runnable:

```sh
npm i playwright          # browsers already present; skip the download
node tests/instrument.mjs
node tests/smoke.mjs
```

Current result: **2 of 9 checks pass.** Every failure below is reproduced by
that suite, not inferred from reading.

```
PASS  boots and opens every panel with no runtime error
PASS  same seed + same width reproduces an identical world
FAIL  daily seed is identical worldwide at the same instant
FAIL  daily world layout is identical across screen widths
FAIL  onelife always starts with exactly 1 life
FAIL  daily always starts with exactly 3 lives
FAIL  pause -> restart cannot exceed the 3-attempt daily cap
FAIL  a ring-earned skin stays equipped after a reload
FAIL  the "High-contrast hazards" setting reaches the renderer
```

The game is in good shape structurally — see [What's already right](#whats-already-right).
The problems are concentrated in the systems that were added last: Daily,
the alternate modes, and the accessibility toggle.

---

## Ship blockers

### 1. The Daily Challenge is not the same challenge for everyone

Three independent causes, any one of which breaks the premise.

**a. The seed comes from the local calendar date.** `today()` (line 989) builds
its key from `getFullYear/getMonth/getDate`, so the day boundary is the
device's, not the world's.

```
UTC+14  day=2026-08-17  seed=3630752024
UTC-11  day=2026-08-16  seed=3647529643
```

Two players opening the app at the same instant get different worlds. The
leaderboard is then comparing unrelated runs. It also hands out a free reset:
move the device clock forward and you get a new day, a new seed, and three
fresh attempts.

**b. World layout depends on screen width.** `makePlanet` places every planet
with `x = clamp(prev.x0 + rr(...), margin, W - margin)` (line 681), where `W` is
the live stage width. Same seed, different device:

```
stage width 390 vs 520 — 5/5 planets differ in x
x: 195.0, 157.0, 169.3, 228.4   (390px)
x: 260.0, 222.0, 234.3, 293.4   (520px)
```

A phone and a tablet play different layouts from the same seed. This also
invalidates the ghost, whose path is recorded in these width-dependent
coordinates.

**Fix.** Derive the day in UTC (`new Date().toISOString().slice(0,10)`), and
generate planet x in a normalised `0..1` space scaled to a fixed virtual width,
mapping to the real `W` only at draw and collision time.

### 2. Banked spare lives leak into the modes defined by their life count

`newRun` line 759:

```js
lives = GAME_MODES[gameMode].lives + spareLives; spareLives = 0;
```

`spareLives` is added unconditionally. Measured, with 5 spare lives banked:

- **One Life** started with **6 lives**
- **Daily** started with **8 lives**

One Life's whole premise is gone, and Daily stops being comparable between
players the moment anyone buys a life. Add spare lives only where continues are
allowed — i.e. gate on `!M.noContinue`.

### 3. The three-attempt daily cap does not hold

`playBtn` and `againBtn` check attempts remaining; `restartBtn` (line 1866) does
not, and `newRun` increments `daily.att` unconditionally. Pausing and hitting
"Restart run" repeatedly:

```
attempts consumed: 7 of 3 allowed
```

Play continues normally past the cap. Move the check into `newRun` itself so
every entry point is covered.

### 4. The accessibility setting does nothing

The store sells **"High-contrast hazards — Amber instead of red, heavier
outline"**. `cbMode` is toggled, saved, and restored correctly — and then never
read. Across the 318-line render path:

```
draw() reads cbMode 0 times and hardcodes the hazard red 7 times
```

All six hazard draws use literal `#DD5B4C` / `rgba(221,91,76,…)` (lines 1462,
1465, 1513, 1518, 1590–1591, 1674). A settings toggle that silently does nothing
is worse than no toggle, and this is the exact case that fails for red-green
colourblind players — roughly 8% of men.

**Fix.** Read `cbMode` in `draw()`, and don't rely on hue alone: give hazards a
**shape** difference (a spiked outline on moons, hatching on blades) so they
read without any colour discrimination at all. That also helps in sunlight.

### 5. The store and ads are stubs that grant real currency

The `.iap` handler (line 1831) credits coins and spare lives with no payment
path, and `playAd` is a five-second placeholder. The code says so honestly, but
as shipped this gives the economy away and would fail Play review for
advertising prices ($0.99 / $2.49 / $6.99) that never charge. Wire to Play
Billing and a real ad SDK, or remove the sections before upload.

---

## High

### 6. Zen contaminates every record, unlock and mission

`endRun` sets `best` and `bestRings` with no mode check (lines 901–902). Zen has
no hazards, no bosses and 99 lives, so it:

- sets the **global high score** and **ring record**;
- makes the in-world `BEST · n` altitude line an unreachable Zen number;
- **unlocks Boss Rush**, which is gated on `bestRings < 40` (line 1779);
- farms `runRings`, `chain`, `runScore` and `flawlessLevel` missions risk-free
  for coin rewards.

Scope records per mode, gate Boss Rush on `bestBoss >= 4` as intended, and
exclude Zen from mission progress.

### 7. Lifetime rings and boss progress can be lost

`endRun` calls `save()` at line 903 but increments `totalRings` at line 928 —
after. `bestBoss` (line 951) is never saved at the moment it changes. Both gate
skin unlocks, so closing the app right after a run silently discards that run's
progress toward Comet, Lantern and Eclipse. Move `save()` to the end of
`endRun`.

### 8. An earned skin will not stay equipped

`paintSkins` computes `earned` but only pushes into `ownedSkins` on a *purchase*
(line 1749), while `load()` re-equips only if `ownedSkins.includes(d.skin)`
(line 1078). Measured: equipped Comet at 500 lifetime rings, reloaded, and it
reverted to **Pearl**. The player has to re-equip on every launch. Push earned
skins into `ownedSkins` when the threshold is crossed.

### 9. Ghost replay is tied to refresh rate

Sampling is per-frame — `if(++ghFrame % 3 === 0)` at line 1303 — inside a
variable-`dt` loop, and playback advances per frame too. A ghost recorded at
60 Hz replays at roughly double speed on a 120 Hz phone, so the comparison is
wrong on most current Android hardware. Sample on accumulated time (every
~50 ms) and index playback by elapsed time.

### 10. Only the layout is deterministic — hazard phase is not

Moon and blade angles integrate from whenever `ensurePlanets()` happened to
create the planet (line 747, five ahead of the player), so they depend on how
fast the player got there. `restoreRun` winds forward only the planets that
exist at restore time (lines 1138–1141), so pausing and resuming shifts them
again. Two players on the same daily seed meet the same layout with different
hazard phases.

Make phase a pure function of the clock — `angle = base + rate * clock`
evaluated on read rather than accumulated per frame. That fixes resume drift and
makes the ghost meaningful at the same time.

### 11. No safe-area insets

`viewport-fit=cover` (line 5) deliberately extends the page under the notch and
the gesture bar, but there is no `env(safe-area-inset-*)` anywhere in the file.
`#hud` sits at `top:0`, and `#pauseBtn` / `#muteBtn` at `bottom:14px`. On any
notched phone the score and level run under the status bar and the buttons under
the home indicator. Add safe-area padding to `#hud`, `#coach`, `#pauseBtn` and
`#muteBtn`.

---

## Medium

**12. Per-frame cost grows without bound.** `step()` iterates *every* planet and
*every* belt each frame (lines 1315–1324), and both arrays only ever grow. At
ring 300 that is 300 planets' moons updated per frame to render about six. Long
runs are exactly the runs players care about, and low-end Android will feel this.
Iterate a window around `cur` and prune belts behind the camera.

**13. Nebula sprites are rebuilt far too often.** `buildNebulae()` allocates five
canvases up to ~760×760 (~11 MB) and is called twice in `newRun` (lines 764 and
779), again in `restoreRun`, and on every level-up via `setTimeout` (line 959) —
every ten rings. Build once and tint at draw time; drop the duplicate call.

**14. The pause button disappears after a continue.** `endRun` hides it (line
900); `playBtn`, `againBtn` and `continueBtn` restore it, but `continueRun()`
(lines 933–937) does not. After buying a life or watching a revive ad there is no
pause button for the rest of the run, and there is no Escape key on a phone.
One-line fix.

**15. Ghost data is unbounded in storage.** ~20 samples/sec × 2 integers,
JSON-encoded into localStorage — a five-minute daily is ~12,000 numbers (~80 KB).
Cap the length and quantise to `Int16`.

**16. Mode choice is not persisted.** `gameMode` is absent from `save()`, so it
resets to Classic on every launch.

**17. The daily seed has no build salt.** `seedFromString('tether-' + today())`
means retuning difficulty silently rewrites historical dailies. Add a version
component.

---

## Low / polish

- Screen shake and the death flash aren't gated on `prefers-reduced-motion`; the
  CSS rule at line 158 only covers CSS animations, not the canvas.
- Panels aren't `role="dialog"`, most buttons have no accessible label, and the
  canvas has no accessible name.
- `user-scalable=no` blocks pinch zoom.
- Stars and nebulae keep coordinates generated against the old `W` after a
  rotation or resize.
- `paintTitle` throws if a saved run references a mode key removed in a later
  build (`GAME_MODES[savedRun.m].name`, line 1805).
- Progress is device-local only — an uninstall or a new phone loses everything.
  Play Games Saved Games would fix this and costs nothing.

---

## What's already right

Worth stating plainly, because it is the reason the fixes above are small:

- **The seeded-world design is correct.** `planetRng(seed, i)` gives every
  planet its own generator keyed on `(seed, index)`, so generation never depends
  on call order or player actions. Verified byte-identical across two fresh
  browser contexts. The determinism problems are all *inputs* to this system —
  the local date, the screen width — not the generator itself.
- **`safeSpawn` / `clearTime`** score every respawn position against every
  hazard's future path, including the "already touching" case that most
  implementations miss. Combined with `spawnProtect`, the die-revive-die loop is
  properly closed.
- **Near-miss detection measures the swept segment**, not the end point, which is
  the difference between it firing and not at 575 px/s.
- **The storage adapter** degrades native → localStorage → memory instead of
  silently losing saves in a Capacitor WebView.
- **Backgrounding is treated as a pause**, via both `visibilitychange` and
  `blur`.
- The comments explain *why* rather than *what*, and several document real bugs
  already fixed. That is rare and worth keeping up.

---

## Suggested order

1. Blockers 1–4 — they are what make Daily, One Life and the accessibility claim
   real. All are small, local changes.
2. Blocker 5 before upload — billing and ads, or delete the sections.
3. High 6–8 — cheap, and they protect the records and unlocks players earn.
4. High 9–11 and Medium 12–14 before a wider launch.
