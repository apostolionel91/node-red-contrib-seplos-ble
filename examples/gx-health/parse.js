// GX health in plain words. Reads the exec output (key=value lines, then "--procs" and one /proc/<pid>/stat
// line per program), shows a verdict and the main numbers under this node, puts a plain summary first in
// msg.payload, keeps the latest in global "gx_health", and raises/clears alerts.
// Processor use is measured between two readings (the first one after a deploy says "measuring").
// Output 1: the reading. Output 2: alerts for Pushover (msg.topic, msg.payload, msg.priority).
// ---- limits: change here ----
const MEM_LOW_MB = 300;       // free memory below this: "getting low"
const MEM_ALERT_MB = 100;     // below this: alert
const STORAGE_WATCH_PCT = 70; // storage fuller than this: "filling up"
const STORAGE_ALERT_PCT = 90; // fuller than this: alert
const TEMP_WARM_C = 60;       // CPU warmer than this: "warm"
const TEMP_ALERT_C = 80;      // hotter than this: alert
const CPU_WATCH_PCT = 80;     // processor used more than this (all cores together): "busy"
const CPU_ALERT_PCT = 95;     // more than this: alert
const HOLD_MS = 5 * 60000;    // a problem must last this long to alert, and be gone this long to clear
// friendly names for programs often seen on a GX (the program's own name is always shown too)
const KNOWN = [
    [/^node-red$/, 'your Node-RED flows'],
    [/^vrmlogger/, 'sends data to VRM'],
    [/^dbus-ble-sens/, 'Bluetooth sensors'],
    [/^bluetoothd$/, 'Bluetooth'],
    [/^dbus-daemon$/, 'internal message bus'],
    [/^(gui|venus-gui)/, 'screen and Remote Console']
];

const text = String(msg.payload || '');
const cut = text.indexOf('\n--procs');
const head = cut < 0 ? text : text.slice(0, cut), procText = cut < 0 ? '' : text.slice(cut + 9);
const kv = {};
for (const line of head.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : null; };
const nums = (s) => String(s || '').split(/\s+/).map(num).filter((v) => v !== null);
const [load1, load5, load15] = nums(kv.load);
const temps = nums(kv.temps).map((t) => (t > 1000 ? t / 1000 : t)); // milli-degrees on most kernels
const df = (s) => { const [size, used, avail] = nums(s); return size ? { sizeMB: Math.round(size / 1024), usedMB: Math.round(used / 1024), freeMB: Math.round(avail / 1024), usedPct: Math.round(used / size * 100) } : null; };
const memTotal = num(kv.memTotalKB), memAvail = num(kv.memAvailKB), nodeRss = num(kv.nodeRssKB);
const cores = num(kv.cores);

// ---- processor: share of all cores used since the last reading, and which programs used it ----
// /proc/stat "cpu" line: user nice system idle iowait irq softirq steal (guest is already inside user)
const cpuF = nums(String(kv.cpu || '').replace(/^cpu\s*/, ''));
const now = cpuF.length >= 4 ? { total: cpuF.slice(0, 8).reduce((a, b) => a + b, 0), idle: cpuF[3], iowait: cpuF[4] || 0, procs: {} } : null;
for (const line of procText.split('\n')) {
    const a = line.indexOf('('), b = line.lastIndexOf(')');
    if (a < 1 || b < a) continue;
    const f = line.slice(b + 2).split(' '); // after the name: state ppid ... utime (12th) stime (13th)
    const used = Number(f[11]) + Number(f[12]);
    if (now && Number.isFinite(used)) now.procs[line.slice(0, a).trim()] = { name: line.slice(a + 1, b), used };
}
const prev = context.get('cpu');
let cpuUsePct = null, ioWaitPct = null, busiest = [];
if (now && prev && now.total > prev.total) {
    const dT = now.total - prev.total;
    cpuUsePct = Math.max(0, Math.min(100, Math.round((dT - (now.idle + now.iowait - prev.idle - prev.iowait)) * 100 / dT)));
    ioWaitPct = Math.max(0, Math.round((now.iowait - prev.iowait) / dT * 100));
    const byName = {};
    for (const [pid, p] of Object.entries(now.procs)) {
        const q = prev.procs[pid];
        if (q && q.name === p.name && p.used >= q.used) byName[p.name] = (byName[p.name] || 0) + (p.used - q.used);
    }
    busiest = Object.entries(byName).map(([name, d]) => ({ name, pct: Math.round(d / dT * 1000) / 10 }))
        .filter((p) => p.pct >= 0.5).sort((x, y) => y.pct - x.pct).slice(0, 3);
}
if (now) context.set('cpu', now);

const h = {
    summary: null, // filled below, first so it shows first in the debug sidebar
    ts: new Date().toISOString(),
    cores,
    cpuUsePct,   // % of the whole processor (all cores) used since the last reading
    ioWaitPct,   // % of the time spent waiting for storage
    busiest,     // the three programs that used the most, % of the whole processor
    load1, load5, load15, // load averages: also count programs waiting for storage
    memTotalMB: memTotal === null ? null : Math.round(memTotal / 1024),
    memAvailMB: memAvail === null ? null : Math.round(memAvail / 1024),
    nodeRedMB: nodeRss === null ? null : Math.round(nodeRss / 1024),
    cpuTempC: temps.length ? Math.round(Math.max(...temps) * 10) / 10 : null,
    data: df(kv.data),
    root: df(kv.root),
    uptimeDays: num(kv.uptime) === null ? null : Math.round(num(kv.uptime) / 86400 * 10) / 10
};
if (h.memTotalMB === null && load1 === undefined) {
    node.status({ fill: 'red', shape: 'ring', text: 'Could not read the GX (see "exec errors")' });
    return [null, null];
}

// ---- plain words: level 0 = fine, 1 = keep an eye on it, 2 = problem ----
const gb = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB');
const friendly = (name) => { const k = KNOWN.find(([re]) => re.test(name)); return k ? `${name} (${k[1]})` : name; };
const checks = [];
if (h.cpuUsePct !== null) {
    const lvl = h.cpuUsePct > CPU_ALERT_PCT ? 2 : h.cpuUsePct > CPU_WATCH_PCT ? 1 : 0;
    checks.push({ lvl, short: `CPU ${h.cpuUsePct} % used`, line: `Processor: ${h.cpuUsePct} % used over the last minute, all cores together (${['normal', 'busy', 'overloaded'][lvl]})`
        + (h.ioWaitPct >= 5 ? `, plus ${h.ioWaitPct} % of the time waiting for storage` : ''), what: ['', 'the processor is busy', 'the processor is overloaded'][lvl] });
    if (h.busiest.length) checks.push({ lvl: 0, line: 'Busiest programs: ' + h.busiest.map((p) => `${friendly(p.name)} ${p.pct} %`).join(', ') });
} else checks.push({ lvl: 0, short: 'CPU measuring…', line: 'Processor: measuring, ready at the next reading (one minute)' });
if (h.memAvailMB !== null) {
    const lvl = h.memAvailMB < MEM_ALERT_MB ? 2 : h.memAvailMB < MEM_LOW_MB ? 1 : 0;
    checks.push({ lvl, short: `${h.memAvailMB} MB memory free`, line: `Memory: ${h.memAvailMB} MB free of ${h.memTotalMB} MB (${['plenty', 'getting low', 'low'][lvl]})`, what: ['', 'memory is getting low', 'memory is low'][lvl] });
}
if (h.nodeRedMB !== null) checks.push({ lvl: 0, line: `Node-RED is using ${h.nodeRedMB} MB of that memory` });
if (h.cpuTempC !== null) {
    const lvl = h.cpuTempC > TEMP_ALERT_C ? 2 : h.cpuTempC > TEMP_WARM_C ? 1 : 0;
    checks.push({ lvl, short: `${Math.round(h.cpuTempC)} °C`, line: `Temperature: ${h.cpuTempC} °C (${['normal', 'warm', 'hot'][lvl]})`, what: ['', 'it is running warm', 'it is hot'][lvl] });
}
if (h.data) {
    const lvl = h.data.usedPct > STORAGE_ALERT_PCT ? 2 : h.data.usedPct > STORAGE_WATCH_PCT ? 1 : 0;
    checks.push({ lvl, short: `storage ${h.data.usedPct} % full`, line: `Storage for Node-RED and add-ons: ${h.data.usedPct} % full, ${gb(h.data.freeMB)} free (${['plenty of room', 'filling up', 'almost full'][lvl]})`, what: ['', 'storage is filling up', 'storage is almost full'][lvl] });
}
if (h.root) checks.push({ lvl: 0, line: `System disk: ${h.root.usedPct} % full (holds the Victron firmware; a high figure here is normal)` });
if (h.uptimeDays !== null) checks.push({ lvl: 0, line: `Running for ${h.uptimeDays} days since the last restart` });

const worst = Math.max(0, ...checks.map((c) => c.lvl));
const reasons = checks.filter((c) => c.lvl === worst && c.lvl > 0).map((c) => c.what);
const verdict = worst === 0 ? 'All good' : (worst === 1 ? 'Keep an eye on it: ' : 'Problem: ') + reasons.join(', ');
h.summary = [verdict].concat(checks.map((c) => c.line));
global.set('gx_health', h);

// ---- alerts (only the "problem" level, after it lasts HOLD_MS) ----
const t = Date.now();
const conds = {};
if (h.memAvailMB !== null && h.memAvailMB < MEM_ALERT_MB) conds.mem = `The GX is low on memory: only ${h.memAvailMB} MB free`;
if (h.data && h.data.usedPct > STORAGE_ALERT_PCT) conds.data = `The GX storage is almost full: ${h.data.usedPct} % used, ${gb(h.data.freeMB)} free`;
if (h.cpuTempC !== null && h.cpuTempC > TEMP_ALERT_C) conds.temp = `The GX is hot: ${h.cpuTempC} °C`;
if (h.cpuUsePct !== null && h.cpuUsePct > CPU_ALERT_PCT) conds.cpu = `The GX is overloaded: processor ${h.cpuUsePct} % used` + (h.busiest.length ? ` (busiest: ${h.busiest[0].name})` : '');
const st = context.get('alerts') || {};
const box = global.get('gx_health_alerts') || { active: [], log: [] };
const out = [];
for (const key of ['mem', 'data', 'temp', 'cpu']) {
    const a = st[key] || (st[key] = { active: false, trueSince: null, falseSince: null });
    if (conds[key]) {
        a.falseSince = null; a.text = conds[key];
        if (a.trueSince === null) a.trueSince = t;
        if (!a.active && t - a.trueSince >= HOLD_MS) {
            a.active = true; a.since = t;
            box.log.push({ t, key, text: a.text, state: 'raised' });
            out.push({ topic: 'Cerbo GX', payload: a.text + ' (for 5 minutes)', priority: 0 });
        }
    } else {
        a.trueSince = null;
        if (a.active) {
            if (a.falseSince === null) a.falseSince = t;
            if (t - a.falseSince >= HOLD_MS) {
                a.active = false;
                box.log.push({ t, key, text: a.text, state: 'cleared' });
                out.push({ topic: 'Cerbo GX', payload: 'Back to normal: ' + a.text.replace(/^The GX (storage )?is /, ''), priority: -1 });
            }
        }
    }
}
delete st.load; // the old load-average alert, replaced by "cpu"
context.set('alerts', st);
box.active = Object.entries(st).filter(([, a]) => a.active).map(([key, a]) => ({ key, text: a.text, since: a.since }));
while (box.log.length > 30) box.log.shift();
global.set('gx_health_alerts', box);

node.status({ fill: ['green', 'yellow', 'red'][worst], shape: 'dot', text: [verdict].concat(checks.filter((c) => c.short).map((c) => c.short)).join(' · ') });
msg.payload = h;
return [msg, out.length ? out : null];
