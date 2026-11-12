// Runs the page flow's function nodes over simulated time and checks energy, history, alerts, save/restore.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const req = createRequire(import.meta.url);
const KEEP = readFileSync(new URL('./fn/keep.js', import.meta.url), 'utf8');
const SMALL = req('./fn/small.js');
const BASE = JSON.parse(readFileSync(new URL('./sample-reading.json', import.meta.url), 'utf8'));

let fakeNow = new Date('2026-11-12T22:00:00').getTime(); // local time
const realNow = Date.now;
Date.now = () => fakeNow;

const G = new Map();
const glob = { get: (k) => G.get(k), set: (k, v) => G.set(k, v) };
const ctxs = new Map();
const ctx = (name) => { if (!ctxs.has(name)) ctxs.set(name, new Map()); const m = ctxs.get(name); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
const node = { status() {}, warn() {} };
const run = (code, name, msg) => new Function('msg', 'global', 'context', 'node', code)(msg, glob, ctx(name), node);

function reading(t, { current = 0, voltage = 50.4, cellPatch = null, chargeFet = true } = {}) {
  const r = JSON.parse(JSON.stringify(BASE));
  r.timestamp = new Date(t).toISOString();
  r.system.current = current; r.system.voltage = voltage; r.system.chargeFet = chargeFet;
  if (cellPatch) { const [p, c, v] = cellPatch; r.packs[p - 1].cells[c - 1] = v; }
  return r;
}
const keep = (r) => run(KEEP, 'keep', { payload: r });
const sysIn = (topic, v) => run(SMALL.sys, 'sys', { topic, payload: v });

const results = [];
const test = (name, fn) => { try { fn(); results.push('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ': ' + e.message); process.exitCode = 1; } };

// ---- 26 h of readings every 15 s: 22:00 day 1 -> 00:00 day 3 (two midnights) ----
let expectIn = 0, expectOut = 0, expectPv = 0;
const dayOf = (t) => new Date(t).toDateString();
const perDay = new Map();
const start = fakeNow;
let prevT = null;
for (let t = start; t <= start + 26 * 3600000; t += 15000) {
  fakeNow = t;
  const hour = new Date(t).getHours();
  const current = hour >= 10 && hour < 15 ? 20 : -8;        // charge by day, discharge otherwise
  const pv = hour >= 10 && hour < 15 ? 1500 : 0;
  sysIn('pv', pv); sysIn('grid', 100); sysIn('load', 400);
  keep(reading(t, { current }));
  if (prevT !== null) {
    const wh = Math.abs(Math.round(50.4 * current)) * 15 / 3600;
    const k = dayOf(t);
    const d = perDay.get(k) || { in: 0, out: 0, pv: 0 };
    if (current > 0) d.in += wh; else d.out += wh;
    d.pv += pv * 15 / 3600;
    perDay.set(k, d);
  }
  prevT = t;
}

test('energy: per-day battery in/out and solar match a direct sum; days roll over at local midnight', () => {
  const e = G.get('seplos_energy');
  const days = [...perDay.keys()];
  assert.equal(e.days.length, 2, 'two finished days');
  const d2 = perDay.get(days[1]); // the full middle day
  const got = e.days[1];
  assert.ok(Math.abs(got.battIn - d2.in) < 2, `battIn ${got.battIn} vs ${d2.in}`);
  assert.ok(Math.abs(got.battOut - d2.out) < 2, `battOut ${got.battOut} vs ${d2.out}`);
  assert.ok(Math.abs(got.pv - d2.pv) < 2, `pv ${got.pv} vs ${d2.pv}`);
  assert.ok(Math.abs(got.load - 400 * 24) < 2, `load ${got.load}`);
  assert.ok(Math.abs(got.gridIn - 100 * 24) < 2, `grid ${got.gridIn}`);
});

test('history: 24 h of one-minute points with cells; 7-day 10-minute buckets', () => {
  const h1 = G.get('seplos_h1');
  assert.ok(h1.length >= 1438 && h1.length <= 1442, 'h1 ' + h1.length);
  assert.ok(h1[h1.length - 1].t - h1[0].t <= 24 * 3600000);
  assert.deepEqual(h1[0].cells.map((c) => c.length), [16, 16]);
  assert.equal(h1[0].cells[0][7], 3161, 'mV integers');
  const h7 = G.get('seplos_h7');
  assert.ok(h7.length >= 156 && h7.length <= 158, 'h7 ' + h7.length);
  assert.equal(h7[5].cells[0][7], 3161);
});

test('time to full / empty from the ~5 min average current', () => {
  const tt = G.get('seplos_timeto');
  assert.equal(tt.capacityAh, 620, 'pack capacities summed');
  assert.ok(Math.abs(tt.iAvg + 8) < 0.2, 'iAvg ' + tt.iAvg);
  assert.ok(Math.abs(tt.hoursToEmpty - 118.2 / 8) < 0.2, 'hoursToEmpty ' + tt.hoursToEmpty);
  assert.equal(tt.hoursToFull, null);
});

// ---- alerts ----
const outs = [];
const keepA = (r) => { const res = keep(r); if (res && res[1]) outs.push(...res[1]); };
let t0 = fakeNow + 15000;
const step = (n, opts) => { for (let k = 0; k < n; k++) { fakeNow = t0; keepA(reading(t0, opts)); t0 += 15000; } };

test('alerts: a 20 s high cell stays quiet; a lasting one alerts once; it clears after 2 min of normal', () => {
  step(2, { cellPatch: [1, 8, 3.561] });               // 15 s apart: held 15 s
  step(1, {});
  assert.equal(outs.length, 0, 'no alert for a short blip');
  step(4, { cellPatch: [1, 8, 3.561] });               // held 45 s
  assert.equal(outs.length, 1);
  assert.deepEqual([outs[0].payload, outs[0].priority], ['Cell P1C8 high: 3.561 V (alert at 3.55 V)', 0]);
  assert.equal(G.get('seplos_alerts').active.length, 1);
  step(6, {});                                          // 90 s normal: still active
  assert.equal(outs.length, 1);
  step(4, {});                                          // past 2 min
  assert.equal(outs.length, 2);
  assert.deepEqual([outs[1].payload, outs[1].priority], ['OK again: Cell P1C8 high: 3.561 V (alert at 3.55 V)', -1]);
  assert.equal(G.get('seplos_alerts').active.length, 0);
});

test('alerts: charging blocked by the BMS is critical (priority 1)', () => {
  outs.length = 0;
  step(4, { chargeFet: false });
  assert.deepEqual(outs.map((o) => [o.payload, o.priority]), [['The BMS has blocked charging', 1]]);
  step(10, {});
});

test('alerts: no reading for 5 min -> stale alert from the tick; a reading clears it after 2 min', () => {
  outs.length = 0;
  const tick = () => { const res = run(KEEP, 'keep', { topic: 'seplos/tick', payload: Date.now() }); if (res && res[1]) outs.push(...res[1]); };
  const lastGood = t0 - 15000;
  fakeNow = lastGood + 5 * 60000; tick();               // condition starts
  assert.equal(outs.length, 0);
  fakeNow = lastGood + 6 * 60000; tick();               // held 60 s
  assert.equal(outs.length, 1);
  assert.match(outs[0].payload, /^No battery reading for 6 min$/);
  assert.equal(outs[0].priority, 1);
  t0 = fakeNow + 1000;
  step(10, {});                                         // 150 s of readings
  assert.match(outs[1].payload, /^OK again: No battery reading/);
});

// ---- save / restore ----
test('save -> restore: an empty start gets the history back; a running start keeps its newer points', () => {
  const saved = run(SMALL.save, 'save', {}).payload;
  // what a restore at this moment should give back: only points still inside 24 h / 7 days
  const before = {
    h1: G.get('seplos_h1').filter((p) => p.t > fakeNow - 24 * 3600000).length,
    h7: G.get('seplos_h7').filter((p) => p.t > fakeNow - 7 * 24 * 3600000).length,
    e: JSON.stringify(G.get('seplos_energy'))
  };
  // restart with nothing
  G.clear();
  run(SMALL.restore, 'restore', { payload: saved });
  assert.equal(G.get('seplos_h1').length, before.h1);
  assert.equal(G.get('seplos_h7').length, before.h7);
  assert.equal(JSON.stringify(G.get('seplos_energy')), before.e);
  // restart where 2 new readings came before the file was read
  G.clear(); ctxs.clear();
  fakeNow = t0 + 60000; keep(reading(fakeNow, { current: -8 }));
  fakeNow += 60000; keep(reading(fakeNow, { current: -8 }));
  const fresh = G.get('seplos_h1').map((p) => p.t);
  run(SMALL.restore, 'restore', { payload: saved });
  const h1 = G.get('seplos_h1');
  assert.deepEqual(h1.slice(-2).map((p) => p.t), fresh, 'new points kept at the end');
  assert.ok(h1.length > 1000, 'old points put back in front');
  assert.ok(h1.every((p, k) => k === 0 || p.t > h1[k - 1].t), 'in time order');
  assert.equal(run(SMALL.save, 'save2', {}) === null, false);
  G.set('seplos_h1', []);
  assert.equal(run(SMALL.save, 'save3', {}), null, 'never saves an empty history');
});

test('page endpoints: data has everything; history strips cells unless asked', () => {
  const d = run(SMALL.data, 'data', {}).payload;
  for (const k of ['now', 'energy', 'timeTo', 'alerts', 'sys']) assert.ok(k in d, k);
  G.set('seplos_h1', [{ t: 1, cells: [[1]], bal: [[]], v: 50 }]);
  const light = run(SMALL.history, 'h', { req: { query: { range: '24h' } } }).payload;
  assert.deepEqual(Object.keys(light.points[0]).sort(), ['t', 'v']);
  const full = run(SMALL.history, 'h', { req: { query: { range: '24h', cells: '1' } } }).payload;
  assert.ok('cells' in full.points[0]);
});

Date.now = realNow;
console.log(results.join('\n'));
console.log(process.exitCode ? 'SOME FAILED' : `ALL ${results.length} PASS`);
