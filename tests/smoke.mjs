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
        (st.daily?.att ?? 0) <= 3, `attempts consumed: ${st.daily?.att} of 3 allowed`);
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
  const body = src.slice(src.indexOf('function draw(){'), src.indexOf('/* ================= store'));
  const reads = (body.match(/cbMode/g) || []).length;
  const reds = (body.match(/DD5B4C|221,91,76/g) || []).length;
  check('the "High-contrast hazards" setting reaches the renderer',
        reads > 0, `draw() reads cbMode ${reads} times and hardcodes the hazard red ${reds} times`);
}

await browser.close();
server.close();
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
