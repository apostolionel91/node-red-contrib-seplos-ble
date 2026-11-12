// Builds seplos-battery-page-flow.json (reader, history, energy, alerts, system values, persistence, the /seplos page)
// and preview.html (the page with made-up sample data, for checking the layout only).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const page = readFileSync(join(here, 'seplos-page.html'), 'utf8');
const KEEP = readFileSync(join(here, 'fn', 'keep.js'), 'utf8');
const SMALL = req('./fn/small.js');
const MAC = ''; // empty: the first Seplos found; or type yours in the battery node
const HISTORY_FILE = '/data/home/nodered/seplos/history.json';

const info = [
  'Seplos battery page: open /seplos on this Node-RED address, e.g. https://venus.local:1881/seplos',
  '',
  'Reads every 15 s with the connection kept open. Phone app: click "release for the phone app" first (10 min).',
  'Settings: read 40 s after deploy, every 6 h, or with "read settings now" (read-only; change them in the Seplos app).',
  'History: 24 h at one point a minute (every cell) and 7 days of 10-minute averages, saved to',
  '  ' + HISTORY_FILE + ' every 30 min and put back after a restart.',
  'Energy per day: battery, solar, loads, grid (the four Victron "System" nodes feed solar, grid, loads, battery).',
  'Alerts: thresholds at the top of "keep + history + alerts". They show on the page and leave through the',
  '  "Seplos alerts" link: wire a link-in from it to your Pushover node (msg.topic title, msg.payload text, msg.priority).',
  'Nothing here changes a BMS setting.'
].join('\n');

const id = (n) => 'f6a0b1e5c0de' + String(n).padStart(4, '0');
const fn = (n, name, func, outputs, x, y, wires) => ({ id: id(n), type: 'function', name, func, outputs, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x, y, wires });
const inject = (n, name, payload, payloadType, topic, repeat, once, onceDelay, x, y, to) => ({ id: id(n), type: 'inject', name, props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }], repeat, crontab: '', once, onceDelay, topic, payload, payloadType, x, y, wires: [[to]] });
const debug = (n, name, active, complete, x, y) => ({ id: id(n), type: 'debug', name, active, tosidebar: true, console: false, tostatus: false, complete, targetType: 'msg', statusVal: '', statusType: 'auto', x, y, wires: [] });
const victron = (n, name, path, label, x, y) => ({
  id: id(n), type: 'victron-input-system', client: 'victron-client-id', service: 'com.victronenergy.system', path,
  serviceObj: { service: 'com.victronenergy.system', name: 'Venus system' }, pathObj: { path, type: 'float', name: label },
  name, onlyChanges: false, roundValues: 'no', rateLimit: 0, outputs: 1, x, y, wires: [[id(40)]]
});

const flow = [
  { id: id(1), type: 'comment', name: 'Seplos battery page: /seplos on this Node-RED address (read me)', info, x: 260, y: 40, wires: [] },
  // reading and settings
  inject(2, 'every 15 s', '', 'date', '', '15', true, '10', 150, 100, id(10)),
  inject(3, 'release for the phone app (10 min)', 'release', 'str', '', '', false, 0.1, 210, 140, id(10)),
  inject(4, 'resume reading', 'resume', 'str', '', '', false, 0.1, 170, 180, id(10)),
  inject(5, 'settings: on deploy, then every 6 h', 'settings', 'str', '', '21600', true, '40', 200, 220, id(10)),
  inject(6, 'read settings now', 'settings', 'str', '', '', false, 0.1, 170, 260, id(10)),
  inject(7, 'alert tick (1 min)', '', 'date', 'seplos/tick', '60', false, 0.1, 170, 300, id(11)),
  { id: id(10), type: 'seplos-battery-get', name: 'Seplos read', device: id(90), x: 450, y: 180, wires: [[id(11)]] },
  fn(11, 'keep + history + alerts', KEEP, 2, 680, 180, [[id(12)], [id(16)]]),
  debug(12, 'seplos reading', false, 'payload', 900, 160),
  { id: id(16), type: 'link out', name: 'Seplos alerts', mode: 'link', links: [], x: 865, y: 200, wires: [] },
  debug(17, 'Seplos alert', true, 'payload', 900, 240),
  { id: id(13), type: 'catch', name: 'read errors', scope: [id(10)], uncaught: false, x: 450, y: 340, wires: [[id(14)]] },
  fn(14, 'keep last error', SMALL.keepError, 1, 640, 340, [[id(15)]]),
  debug(15, 'Seplos error', true, 'error.message', 850, 340),
  // Victron system values (solar, grid, loads, battery power)
  victron(30, 'pv', '/Dc/Pv/Power', 'MPPTs - power (W)', 150, 420),
  victron(31, 'grid', '/Ac/Grid/L1/Power', 'Grid L1 (W)', 150, 460),
  victron(32, 'load', '/Ac/Consumption/L1/Power', 'AC Consumption L1 (W)', 150, 500),
  victron(33, 'batt', '/Dc/Battery/Power', 'Battery Power (W)', 150, 540),
  fn(40, 'keep system values', SMALL.sys, 1, 400, 480, [[]]),
  // persistence
  { id: id(50), type: 'inject', name: 'load saved history (on deploy)', props: [{ p: 'payload' }], repeat: '', crontab: '', once: true, onceDelay: '3', topic: '', payload: '', payloadType: 'date', x: 200, y: 600, wires: [[id(51)]] },
  { id: id(51), type: 'file in', name: 'read history.json', filename: HISTORY_FILE, filenameType: 'str', format: 'utf8', chunk: false, sendError: false, encoding: 'none', allProps: false, x: 430, y: 600, wires: [[id(52)]] },
  fn(52, 'restore history', SMALL.restore, 1, 630, 600, [[]]),
  { id: id(53), type: 'catch', name: 'no saved file yet', scope: [id(51)], uncaught: false, x: 430, y: 640, wires: [[id(54)]] },
  debug(54, 'history file (missing on first deploy is normal)', false, 'error.message', 700, 640),
  { id: id(55), type: 'inject', name: 'save every 30 min', props: [{ p: 'payload' }], repeat: '1800', crontab: '', once: false, onceDelay: 0.1, topic: '', payload: '', payloadType: 'date', x: 180, y: 700, wires: [[id(56)]] },
  fn(56, 'build history snapshot', SMALL.save, 1, 410, 700, [[id(57)]]),
  { id: id(57), type: 'file', name: 'write history.json', filename: HISTORY_FILE, filenameType: 'str', appendNewline: false, createDir: true, overwriteFile: 'true', encoding: 'utf8', x: 640, y: 700, wires: [[]] },
  // the page
  { id: id(60), type: 'http in', name: 'GET /seplos', url: '/seplos', method: 'get', upload: false, swaggerDoc: '', x: 160, y: 780, wires: [[id(61)]] },
  { id: id(61), type: 'template', name: 'battery page', field: 'payload', fieldType: 'msg', format: 'html', syntax: 'plain', template: page, output: 'str', x: 360, y: 780, wires: [[id(62)]] },
  { id: id(62), type: 'http response', name: '', statusCode: '', headers: { 'content-type': 'text/html; charset=utf-8' }, x: 550, y: 780, wires: [] },
  { id: id(63), type: 'http in', name: 'GET /seplos/data', url: '/seplos/data', method: 'get', upload: false, swaggerDoc: '', x: 170, y: 830, wires: [[id(64)]] },
  fn(64, 'page data', SMALL.data, 1, 370, 830, [[id(65)]]),
  { id: id(65), type: 'http response', name: '', statusCode: '', headers: {}, x: 550, y: 830, wires: [] },
  { id: id(66), type: 'http in', name: 'GET /seplos/history', url: '/seplos/history', method: 'get', upload: false, swaggerDoc: '', x: 180, y: 880, wires: [[id(67)]] },
  fn(67, 'page history', SMALL.history, 1, 380, 880, [[id(68)]]),
  { id: id(68), type: 'http response', name: '', statusCode: '', headers: {}, x: 550, y: 880, wires: [] },
  { id: id(90), type: 'seplos-battery-device', name: 'Seplos', address: MAC, deviceName: '', keepConnected: true }
];
const ids = new Set(flow.map((n) => n.id));
for (const n of flow) for (const o of n.wires || []) for (const t of o) if (!ids.has(t)) throw new Error('missing wire ' + t);
writeFileSync(join(here, 'seplos-battery-page-flow.json'), JSON.stringify(flow, null, 2) + '\n');

// ---------------- preview with made-up data (layout check only) ----------------
const now = JSON.parse(readFileSync(join(here, 'sample-reading.json'), 'utf8'));
const end = Date.now();
now.timestamp = new Date(end - 20000).toISOString();
now.packs[0].balancing = { cells: [8], raw: '', source: 'GX driver bit map, unverified' };
now.packs[1].balancing = { cells: [], raw: '', source: 'GX driver bit map, unverified' };
const off1 = [2, 1, 0, 0, 1, -3, 1, 15, 0, 2, -2, -4, 5, 6, -6, -5], off2 = [-4, -2, -11, -5, 11, 1, 11, 6, -4, -7, 4, 7, 1, -4, 11, 5];
const pointAt = (t, k) => {
  const hr = new Date(t).getHours() + new Date(t).getMinutes() / 60;
  const sun = Math.max(0, Math.sin((hr - 7) / 12 * Math.PI));
  const soc = 19 + 60 * Math.max(0, Math.sin((hr - 9) / 10 * Math.PI)) * (hr > 9 && hr < 19 ? 1 : 0);
  const base = 3150 + soc * 3.2;
  const top = Math.max(0, base - 3300) / 60;              // spread grows near the top
  const drift = k / 1440 * 8;                            // P2C5 slowly drifts up
  const cells = [off1.map((o) => Math.round(base + o * (1 + top) + Math.sin(k / 17 + o) * 1.5)),
    off2.map((o, j) => Math.round(base + o * (1 + top) + (j === 4 ? drift : 0) + Math.cos(k / 13 + o) * 1.5))];
  const i = sun > 0.15 ? 40 * sun - 8 : -6 - 3 * Math.sin(k / 37);
  const v = +(cells[0].reduce((a, c) => a + c, 0) / 1000).toFixed(2);
  const bal = cells.map((cs) => cs.map((c, j) => (c > 3450 && c >= Math.max(...cs) - 3 ? j + 1 : 0)).filter(Boolean));
  const pv = Math.round(3200 * sun), load = Math.round(420 + 200 * Math.sin(k / 50) ** 2);
  return { t, v, i: +i.toFixed(1), p: Math.round(v * i), soc: +soc.toFixed(1), ps: [+(soc - 2.7).toFixed(1), +(soc + 2.6).toFixed(1)],
    pd: cells.map((cs) => Math.max(...cs) - Math.min(...cs)), tmin: +(16.8 + 1.6 * sun).toFixed(1), cells, bal,
    pv, load, grid: Math.round(load - pv + v * i) };
};
const h24 = [];
for (let k = 1438; k >= 0; k -= 2) { if (k > 300 && k < 312) continue; h24.push(pointAt(end - k * 60000, 1439 - k)); } // every 2 min: keeps the preview small
const h7 = [];
for (let k = 1005; k >= 0; k -= 3) { const p = pointAt(end - k * 600000, 1439); p.t = Math.floor(p.t / 600000) * 600000; h7.push(p); } // every 30 min in the preview
const dayStr = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const days = [];
for (let d = 6; d >= 1; d--) days.push({ day: dayStr(end - d * 86400000), battIn: 9000 + 2500 * Math.sin(d), battOut: 8200 + 1500 * Math.cos(d), pv: 14000 + 5000 * Math.sin(d * 1.3), load: 11000 + 800 * d, gridIn: 1500 + 300 * d, gridOut: 300 * (d % 3) });
const { decodeSettings } = await import('../../dist/settings.js');
const FRAMES = JSON.parse(readFileSync(join(here, '..', '..', 'test', 'frames.json'), 'utf8'));
const spaRegs = [];
for (const k of ['SPA1300', 'SPA1335']) {
  const bytes = Buffer.from(FRAMES[k], 'hex');
  for (let i = 3; i < bytes.length - 2; i += 2) spaRegs.push(bytes.readUInt16BE(i));
}
const pack2Regs = spaRegs.slice(); pack2Regs[0x58] = 30000; pack2Regs[0x59] = 30000;
const sample = {
  data: {
    now, error: null, serverTime: end,
    settings: { ok: true, kind: 'settings', timestamp: new Date(end - 3600e3).toISOString(), system: decodeSettings(spaRegs),
      packs: [{ pack: 1, info: { model: 'SAMPLE', firmware: '1.6', serial: 'SAMPLE-1' }, settings: decodeSettings(spaRegs) },
        { pack: 2, info: { model: 'SAMPLE', firmware: '1.6', serial: 'SAMPLE-2' }, settings: decodeSettings(pack2Regs) }] },
    settingsChanges: [],
    sys: { pv: 0, grid: 412, load: 412, batt: 0, t: end },
    energy: { day: dayStr(end), today: { battIn: 4200, battOut: 6100, pv: 6900, load: 9400, gridIn: 2400, gridOut: 120 }, days },
    timeTo: { iAvg: -6.1, capacityAh: 620, hoursToEmpty: 19.4, hoursToFull: null },
    alerts: { active: [{ key: 'gap', level: 'warn', text: 'Cell gap 52 mV in pack 2 (alert at 50 mV)', since: end - 1800e3 }],
      log: [{ t: end - 86400e3, key: 'cold', level: 'warn', text: 'Cells cold: 4.6 °C (alert below 5 °C)', state: 'raised' },
        { t: end - 80000e3, key: 'cold', level: 'warn', text: 'Cells cold: 4.6 °C (alert below 5 °C)', state: 'cleared' },
        { t: end - 1800e3, key: 'gap', level: 'warn', text: 'Cell gap 52 mV in pack 2 (alert at 50 mV)', state: 'raised' }] }
  },
  '24h': { range: '24h', points: h24 },
  '7d': { range: '7d', points: h7 }
};
writeFileSync(join(here, 'preview.html'), page.replace('<script>', `<script>window.__SEPLOS_SAMPLE = ${JSON.stringify(sample)};</script>\n<script>`));
console.log('flow', flow.length, 'nodes; page', page.length, 'chars; preview', Math.round(readFileSync(join(here, 'preview.html')).length / 1024), 'kB');
