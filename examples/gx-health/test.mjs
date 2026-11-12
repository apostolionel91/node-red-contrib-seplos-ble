// Runs the "GX health" function on made-up exec output and checks processor use, busiest programs and alerts.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const CODE = readFileSync(new URL('./parse.js', import.meta.url), 'utf8');
const G = new Map(), C = new Map();
let fakeNow = Date.parse('2026-11-12T20:00:00Z'); const realNow = Date.now; Date.now = () => fakeNow;
let lastStatus = null;
const node = { status: (s) => { lastStatus = s; } };
const run = (payload) => new Function('msg', 'global', 'context', 'node', CODE)(
  { payload }, { get: (k) => G.get(k), set: (k, v) => G.set(k, v) }, { get: (k) => C.get(k), set: (k, v) => C.set(k, v) }, node);

// one exec output: cpu = [user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice]; progs = [pid, name, ticks]
const stat = (pid, name, ticks) => `${pid} (${name}) S 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 ${Math.round(ticks * 0.7)} ${ticks - Math.round(ticks * 0.7)} 0 0 20 0 1 0 500 1000 100`; // user and system time both move
const out = (cpu, progs) => [
  'memTotalKB=1031000', 'memAvailKB=607000', 'load=2.60 2.70 2.80', 'cores=4', 'nodeRssKB=118784',
  'temps=43100 42000 ', 'data=4000000 240000 3560000', 'root=1100000 990000 110000', 'uptime=864000.5',
  'cpu=cpu  ' + cpu.join(' '), '--procs', ...progs.map((p) => stat(...p)), ''
].join('\n');

const results = [];
const test = (name, fn) => { try { fn(); results.push('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ': ' + e.message); process.exitCode = 1; } };

// 4 cores x 100 ticks/s x 60 s = 24000 ticks between the two readings
const cpuA = [100000, 0, 50000, 800000, 9000, 0, 1000, 0, 0, 0];
const cpuB = [100000 + 5000, 0, 50000 + 2800, 800000 + 15000, 9000 + 1200, 0, 1000, 0, 0, 0]; // idle 15000 + iowait 1200 of 24000
const progsA = [[1, 'init', 50], [812, 'node-red', 90000], [400, 'vrmlogger.py', 30000], [300, 'python3', 1000], [301, 'python3', 2000],
  [520, 'my (odd) prog', 10], [600, 'dbus-ble-sensor', 5000], [700, 'gone-soon', 10], [701, 'reused', 100]];
const progsB = [[1, 'init', 50], [812, 'node-red', 90000 + 2880], [400, 'vrmlogger.py', 30000 + 1440], [300, 'python3', 1000 + 600], [301, 'python3', 2000 + 600],
  [520, 'my (odd) prog', 10 + 3600], [600, 'dbus-ble-sensor', 5000 + 720], [701, 'other', 900000], [900, 'just-started', 5000]];

test('first reading: processor says "measuring", nothing else breaks', () => {
  const [m] = run(out(cpuA, progsA));
  assert.equal(m.payload.cpuUsePct, null);
  assert.match(m.payload.summary.join('\n'), /Processor: measuring/);
  assert.match(lastStatus.text, /^All good · CPU measuring… · 593 MB memory free/);
});

test('second reading: processor use from /proc/stat, busiest programs by name, odd names parsed', () => {
  fakeNow += 60000;
  const [m] = run(out(cpuB, progsB));
  const h = m.payload;
  assert.equal(h.cpuUsePct, 33, 'used = 1 - (15000 + 1200) / 24000 = 32.5 %');
  assert.equal(h.ioWaitPct, 5);
  assert.deepEqual(h.busiest, [{ name: 'my (odd) prog', pct: 15 }, { name: 'node-red', pct: 12 }, { name: 'vrmlogger.py', pct: 6 }]);
  assert.equal(h.summary[1], 'Processor: 33 % used over the last minute, all cores together (normal), plus 5 % of the time waiting for storage');
  assert.equal(h.summary[2], 'Busiest programs: my (odd) prog 15 %, node-red (your Node-RED flows) 12 %, vrmlogger.py (sends data to VRM) 6 %');
  assert.equal(lastStatus.text, 'All good · CPU 33 % used · 593 MB memory free · 43 °C · storage 6 % full');
  assert.equal(lastStatus.fill, 'green');
});

test('two programs with one name add up; a reused pid or a new program is not counted', () => {
  fakeNow += 60000;
  const cpuC = cpuB.map((v, i) => v + [6000, 0, 0, 18000, 0, 0, 0, 0, 0, 0][i]);
  const progsC = progsB.map(([pid, name, t]) => [pid, name, t + (name === 'python3' ? 1200 : 0)]);
  const [m] = run(out(cpuC, progsC));
  assert.equal(m.payload.cpuUsePct, 25);
  assert.deepEqual(m.payload.busiest, [{ name: 'python3', pct: 10 }]);
});

let cpuNow = cpuB.map((v, i) => v + [6000, 0, 0, 18000, 0, 0, 0, 0, 0, 0][i]);
const minute = (usedShare) => { // one more reading, the processor used this share of the minute
  fakeNow += 60000;
  const used = Math.round(24000 * usedShare);
  cpuNow = cpuNow.map((v, i) => v + (i === 0 ? used : i === 3 ? 24000 - used : 0));
  return run(out(cpuNow, progsB));
};
test('97 % for 5 minutes alerts once (yellow before that is "busy" only at 80-95 %); clears after 5 normal minutes', () => {
  const alerts = [];
  let r = minute(0.9);
  assert.equal(lastStatus.fill, 'yellow');
  assert.match(lastStatus.text, /^Keep an eye on it: the processor is busy · CPU 90 % used/);
  for (let k = 0; k < 7; k++) { r = minute(0.97); if (r[1]) alerts.push(...r[1]); }
  assert.equal(lastStatus.fill, 'red');
  assert.deepEqual(alerts.map((a) => [a.payload, a.priority]), [['The GX is overloaded: processor 97 % used (for 5 minutes)', 0]]);
  for (let k = 0; k < 6; k++) { r = minute(0.3); if (r[1]) alerts.push(...r[1]); }
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].payload, 'Back to normal: overloaded: processor 97 % used');
  assert.equal(alerts[1].priority, -1);
});

test('the exec command avoids option forms the GX\'s BusyBox rejects', () => {
  const cmd = JSON.parse(readFileSync(new URL('./gx-health-flow.json', import.meta.url), 'utf8')).find((n) => n.type === 'exec').command;
  assert.doesNotMatch(cmd, /\b(head|tail) -\d/, 'BusyBox wants "head -n 1", not "head -1"');
  assert.match(cmd, /head -n 1 \/proc\/stat/);
});

Date.now = realNow;
console.log(results.join('\n'));
console.log(process.exitCode ? 'SOME FAILED' : `ALL ${results.length} PASS`);
