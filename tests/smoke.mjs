// Pre-ship smoke + fairness suite for Tether.
//
//   node tests/instrument.mjs && node tests/smoke.mjs
//
// Each check asserts a property the game CLAIMS to have. A failing check is a
// claim the shipped build does not honour. Re-run after fixing.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';

const HTML = fs.readFileSync(new URL('./instrumented.html', import.meta.url), 'utf8');
const server = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});
await new Promise(r => server.listen(0, r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});

async function open({ viewport = { width: 390, height: 844 }, tz = 'UTC' } = {}) {
  const ctx = await browser.newContext({ viewport, timezoneId: tz, deviceScaleFactor: 2, hasTouch: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL_);
  await page.waitForFunction(() => window.__dbg);
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

// Click through the DOM rather than Playwright actionability: several buttons
// are legitimately hidden in the states we drive the game into.
const click = (page, id) => page.evaluate(i => document.getElementById(i)?.click(), id);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};

/* 1. it boots and every panel opens */
{
  const { ctx, page, errors } = await open();
  await click(page, 'playBtn');
  await page.waitForTimeout(200);
  for (let i = 0; i < 5; i++) { await page.evaluate(() => window.__dbg.tap()); await page.waitForTimeout(200); }
  for (const [open_, close] of [['pauseBtn','resumeBtn'], ['storeBtn','closeStore'],
                                ['missionBtn','closeMissions'], ['modeBtn','closeModes']]) {
    await click(page, open_); await page.waitForTimeout(120);
    await click(page, close); await page.waitForTimeout(100);
  }
  check('boots and opens every panel with no runtime error',
        errors.length === 0, errors.length ? errors.join(' | ') : 'no console or page errors');
  await ctx.close();
}

/* 2. the PRNG itself — same seed, same width, same world */
{
  const a = await open(), b = await open();
  for (const p of [a, b]) await p.page.evaluate(() => window.__dbg.newRun('daily'));
  const pa = await a.page.evaluate(() => window.__dbg.planets());
  const pb = await b.page.evaluate(() => window.__dbg.planets());
  check('same seed + same width reproduces an identical world',
        JSON.stringify(pa) === JSON.stringify(pb), `${pa.length} planets compared, byte-identical`);
  await a.ctx.close(); await b.ctx.close();
}

/* 3. daily seed must not depend on the device timezone */
{
  const a = await open({ tz: 'Pacific/Kiritimati' });  // UTC+14
  const b = await open({ tz: 'Pacific/Niue' });        // UTC-11
  const da = await a.page.evaluate(() => window.__dbg.today());
  const db = await b.page.evaluate(() => window.__dbg.today());
  await a.page.evaluate(() => window.__dbg.newRun('daily'));
  await b.page.evaluate(() => window.__dbg.newRun('daily'));
  const sa = await a.page.evaluate(() => window.__dbg.seed());
  const sb = await b.page.evaluate(() => window.__dbg.seed());
  check('daily seed is identical worldwide at the same instant',
        sa === sb, `UTC+14 day=${da} seed=${sa}  |  UTC-11 day=${db} seed=${sb}`);
  await a.ctx.close(); await b.ctx.close();
}

/* 4. daily layout must not depend on screen width */
{
  const a = await open({ viewport: { width: 390, height: 844 } });
  const b = await open({ viewport: { width: 800, height: 1000 } });
  for (const p of [a, b]) await p.page.evaluate(() => window.__dbg.newRun('daily'));
  const pa = await a.page.evaluate(() => window.__dbg.planets());
  const pb = await b.page.evaluate(() => window.__dbg.planets());
  const wa = await a.page.evaluate(() => window.__dbg.state().W);
  const wb = await b.page.evaluate(() => window.__dbg.state().W);
  const diffs = pa.filter((p, i) => Math.abs(p.x - (pb[i]?.x ?? 0)) > 0.01).length;
  check('daily world layout is identical across screen widths',
        diffs === 0, `stage width ${wa} vs ${wb}; ${diffs}/${pa.length} planets differ in x`);
  await a.ctx.close(); await b.ctx.close();
}

/* 5-6. banked spare lives must not leak into fixed-life modes */
for (const [mode, want] of [['onelife', 1], ['daily', 3]]) {
  const { ctx, page } = await open();
  await page.evaluate(() => window.__dbg.set('spareLives', 5));
  await page.evaluate(m => window.__dbg.newRun(m), mode);
  const st = await page.evaluate(() => window.__dbg.state());
  check(`${mode} always starts with exactly ${want} ${want === 1 ? 'life' : 'lives'}`,
        st.lives === want, `started with ${st.lives} (5 spare lives were banked)`);
  await ctx.close();
}

/* 7. the daily attempt cap must hold */
{
  const { ctx, page } = await open();
  await page.evaluate(() => window.__dbg.newRun('daily'));
  for (let i = 0; i < 6; i++) {
    await click(page, 'pauseBtn'); await page.waitForTimeout(60);
    await click(page, 'restartBtn'); await page.waitForTimeout(100);
  }
  const st = await page.evaluate(() => window.__dbg.state());
  check('pause -> restart cannot exceed the 3-attempt daily cap',
        (st.chal?.att ?? 0) <= 3, `attempts consumed: ${st.chal?.att} of 3 allowed`);
  await ctx.close();
}

/* 8. a skin earned by lifetime rings must stay equipped */
{
  const { ctx, page } = await open();
  await page.evaluate(() => { window.__dbg.set('totalRings', 500); });
  await click(page, 'storeBtn');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#skinList .skin')]
      .find(r => r.querySelector('.t')?.textContent === 'Comet');
    row?.querySelector('button')?.click();
  });
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => window.__dbg.state().skin);
  await page.reload();
  await page.waitForFunction(() => window.__dbg);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__dbg.state().skin);
  check('a ring-earned skin stays equipped after a reload',
        before === 'comet' && after === 'comet', `equipped "${before}" -> after reload "${after}"`);
  await ctx.close();
}

/* 9. the accessibility toggle must reach the renderer.
      Static check: the render path never reads cbMode, so no pixel can depend
      on it. Proving this by source is more reliable than diffing an animated
      canvas, where every frame differs for unrelated reasons. */
{
  const src = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function ring(x,y,r,col,w,dash)'),
                         src.indexOf('/* ================= store'));
  // Red literals belong in haz() — that IS the non-colourblind palette. What
  // must not exist is a hazard drawn from a literal somewhere else, because
  // that is a draw the toggle cannot reach.
  const hazFn = body.slice(body.indexOf('function haz(){'), body.indexOf('function drawMoon('));
  const strays = ((body.split(hazFn).join('')).match(/'#DD5B4C'|'rgba\(221,91,76/g) || []).length;
  const reads = (body.match(/cbMode/g) || []).length;
  check('the "High-contrast hazards" setting reaches every hazard draw',
        reads > 0 && strays === 0,
        `render path reads cbMode ${reads} times; ${strays} hazard draws bypass the palette`);
}

/* 10. Zen's life counter must not render as a picket fence */
{
  const { ctx, page } = await open();
  await page.evaluate(() => window.__dbg.newRun('zen'));
  await page.waitForTimeout(200);
  const pips = await page.evaluate(() => ({
    kids: document.getElementById('lives').children.length,
    text: document.getElementById('lives').textContent.trim(),
    lives: window.__dbg.state().lives,
  }));
  check('Zen shows a compact life counter, not one pip per life',
        pips.kids <= 2 && pips.text.includes('∞'),
        `${pips.lives} lives rendered as ${pips.kids} element(s), reading "${pips.text}"`);
  await ctx.close();
}

/* 11. Settings reachable from both the title and the pause menu */
{
  const { ctx, page, errors } = await open();
  await click(page, 'settingsBtn'); await page.waitForTimeout(150);
  const fromTitle = await page.evaluate(() => !document.getElementById('settingsPanel').hidden);
  await click(page, 'closeSettings'); await page.waitForTimeout(100);
  await click(page, 'playBtn'); await page.waitForTimeout(200);
  await click(page, 'pauseBtn'); await page.waitForTimeout(150);
  await click(page, 'pauseSettingsBtn'); await page.waitForTimeout(150);
  const fromPause = await page.evaluate(() => !document.getElementById('settingsPanel').hidden);
  const rows = await page.evaluate(() =>
    ['setSfx','setMusic','setHaptics','setCb','setGuide'].filter(i => document.getElementById(i)).length);
  check('Settings opens from the title and the pause menu, with all five controls',
        fromTitle && fromPause && rows === 5 && errors.length === 0,
        `title=${fromTitle} pause=${fromPause} controls=${rows}/5` + (errors.length ? ` errors: ${errors.join('|')}` : ''));
  await ctx.close();
}

/* 12. every settings toggle survives a reload */
{
  const { ctx, page } = await open();
  await click(page, 'settingsBtn'); await page.waitForTimeout(150);
  for (const id of ['setSfx','setMusic','setHaptics','setCb','setGuide']) {
    await click(page, id); await page.waitForTimeout(80);
  }
  const before = await page.evaluate(() => window.__dbg.state());
  await page.reload();
  await page.waitForFunction(() => window.__dbg);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__dbg.state());
  const keys = ['sfx','haptics','music','cbMode','guideAlways'];
  const kept = keys.filter(k => before[k] === after[k]);
  check('every settings toggle survives a reload',
        kept.length === keys.length,
        `persisted ${kept.length}/${keys.length}: ` +
        keys.map(k => `${k} ${before[k]}->${after[k]}`).join(', '));
  await ctx.close();
}

/* 13. a guided run must earn nothing */
{
  const { ctx, page } = await open();
  await page.evaluate(() => { window.__dbg.set('coins', 0); });
  await click(page, 'settingsBtn'); await page.waitForTimeout(120);
  await click(page, 'setGuide');    await page.waitForTimeout(120);
  await click(page, 'closeSettings'); await page.waitForTimeout(100);
  await click(page, 'playBtn');     await page.waitForTimeout(250);
  await page.evaluate(() => window.__dbg.warp(25));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__dbg.end());
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => window.__dbg.state());
  check('a guided run earns no coins, rings, or record',
        st.coins === 0 && st.totalRings === 0 && st.bestRings === 0 && st.best === 0,
        `after 25 guided rings: coins=${st.coins} totalRings=${st.totalRings} ` +
        `bestRings=${st.bestRings} best=${st.best} (practice=${st.runPractice})`);
  await ctx.close();
}

/* 14. an unguided run still earns, i.e. 13 is not passing vacuously */
{
  const { ctx, page } = await open();
  await page.evaluate(() => { window.__dbg.set('coins', 0); });
  await click(page, 'playBtn'); await page.waitForTimeout(250);
  await page.evaluate(() => window.__dbg.warp(25));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__dbg.end());
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => window.__dbg.state());
  check('an unguided run still earns coins and sets records (control)',
        st.coins > 0 && st.totalRings > 0 && st.bestRings > 0,
        `after 25 normal rings: coins=${st.coins} totalRings=${st.totalRings} bestRings=${st.bestRings}`);
  await ctx.close();
}

/* 15. the Daily cannot be played with the guide on */
{
  const { ctx, page } = await open();
  await click(page, 'settingsBtn'); await page.waitForTimeout(120);
  await click(page, 'setGuide');    await page.waitForTimeout(120);
  await click(page, 'closeSettings'); await page.waitForTimeout(100);
  await page.evaluate(() => window.__dbg.newRun('daily'));
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => window.__dbg.state());
  check('the Daily Challenge refuses to start while the aim guide is on',
        st.gameMode !== 'daily' && (st.chal?.att ?? 0) === 0,
        `mode after attempt: ${st.gameMode}; attempts consumed: ${st.chal?.att ?? 0}`);
  await ctx.close();
}

/* 16. Settings must be usable from the pause menu mid-run.
      This uses real pointer clicks, not element.click(): the bug it guards
      against was Settings rendering BEHIND the pause panel, and a DOM click
      fires straight through an overlay without noticing it. */
{
  const { ctx, page, errors } = await open();
  await page.click('#playBtn');
  await page.waitForTimeout(250);
  await page.click('#pauseBtn');
  await page.waitForTimeout(200);
  await page.click('#pauseSettingsBtn');
  await page.waitForTimeout(250);

  // what is actually on top where the toggle sits?
  const onTop = await page.evaluate(() => {
    const b = document.getElementById('setCb');
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
    return hit === b || b.contains(hit) ? 'setCb' : (hit?.closest('.panel')?.id || hit?.tagName || 'unknown');
  });

  const before = await page.evaluate(() => window.__dbg.state().cbMode);
  let clicked = true;
  try { await page.click('#setCb', { timeout: 4000 }); }
  catch { clicked = false; }
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => window.__dbg.state().cbMode);

  check('settings can be changed from the pause menu during a run',
        clicked && before !== after && errors.length === 0,
        `topmost element at the toggle: ${onTop}; click ${clicked ? 'landed' : 'was intercepted'}; ` +
        `cbMode ${before} -> ${after}`);
  await ctx.close();
}

/* 17. and the pause menu is still there behind it when Settings closes */
{
  const { ctx, page } = await open();
  await page.click('#playBtn');      await page.waitForTimeout(250);
  await page.click('#pauseBtn');     await page.waitForTimeout(150);
  await page.click('#pauseSettingsBtn'); await page.waitForTimeout(200);
  await page.click('#closeSettings');    await page.waitForTimeout(200);
  const st = await page.evaluate(() => ({
    settings: document.getElementById('settingsPanel').hidden,
    pause: document.getElementById('pausePanel').hidden,
  }));
  let resumed = true;
  try { await page.click('#resumeBtn', { timeout: 4000 }); } catch { resumed = false; }
  check('closing Settings returns to the pause menu, still operable',
        st.settings === true && st.pause === false && resumed,
        `settings hidden=${st.settings}, pause hidden=${st.pause}, resume ${resumed ? 'clickable' : 'intercepted'}`);
  await ctx.close();
}

/* 18. The results screen must not be a frozen photo of where you died.
      Invariant: at mode 'over' the canvas cannot depend on the world, so
      deleting every planet must not change a single pixel. The clock is frozen
      in this state, which is what makes a byte comparison meaningful — check
      that first, or the test proves nothing. */
{
  const { ctx, page } = await open();
  await click(page, 'playBtn');
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__dbg.warp(24));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__dbg.end());
  await page.waitForTimeout(400);

  const shot = async () => (await page.locator('#game').screenshot()).toString('base64');
  const a1 = await shot();
  await page.waitForTimeout(250);
  const a2 = await shot();                       // control: is the frame static?
  const worlds = await page.evaluate(() => window.__dbg.planets().length);
  await page.evaluate(() => window.__dbg.clearWorld());
  await page.waitForTimeout(250);
  const b = await shot();

  check('the results screen does not render the world you died in',
        a1 === a2 && a2 === b,
        a1 !== a2 ? 'frame is not static at game over — comparison inconclusive'
                  : `${worlds} planets present; deleting them ${a2===b?'changed nothing':'changed the canvas'}`);
  await ctx.close();
}

await browser.close();
server.close();
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
