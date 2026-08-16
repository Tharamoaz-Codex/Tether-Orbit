// Builds an instrumented copy of index.html that exposes a few internals on
// window.__dbg so the smoke suite can inspect state. The game itself ships
// untouched — this only ever writes to tests/instrumented.html.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'index.html');
const out = path.join(here, 'instrumented.html');

const HOOK = `
window.__dbg={
  seed:()=>worldSeed,
  today:()=>today(),
  setMode:m=>{gameMode=m},
  newRun:m=>newRun(m),
  planets:()=>planets.map(p=>({i:p.idx,x:Math.round(p.x0*1000)/1000,y:Math.round(p.y*1000)/1000,
    oR:Math.round(p.orbitR*1000)/1000,boss:!!p.boss,moons:p.moons.length,bar:!!p.bar,decay:!!p.decay,sp:p.special})),
  state:()=>({gameMode,mode,lives,rings,score,coins,spareLives,cbMode,skin,
    ownedSkins:ownedSkins.slice(),totalRings,bestBoss,bestRings,W,H,
    daily:daily?JSON.parse(JSON.stringify(daily)):null}),
  set:(k,v)=>{ if(k==='spareLives')spareLives=v; if(k==='coins')coins=v;
    if(k==='totalRings')totalRings=v; if(k==='bestRings')bestRings=v; if(k==='skin')skin=v; },
  tap:()=>tap()
};
`;

let s = fs.readFileSync(src, 'utf8');
const i = s.lastIndexOf('})();');
if (i < 0) throw new Error('could not find the IIFE close in index.html');
fs.writeFileSync(out, s.slice(0, i) + HOOK + '\n' + s.slice(i));
console.log('wrote', path.relative(process.cwd(), out));
