// Seplos keep: readings, settings and the alert tick all come here.
// Output 1: the message through. Output 2: alerts (msg.topic, msg.payload text, msg.priority) for Pushover.
// ---- alert thresholds: change here ----
const CELL_HIGH_V = 3.55;   // any cell at or above (same as Battery Watch's cell band)
const CELL_LOW_V = 3.00;    // any cell at or below
const GAP_MV = 50;          // cell gap inside one pack
const COLD_C = 5;           // lowest cell temperature below
const STALE_MIN = 5;        // no good reading for this long
const RAISE_MS = 30000;     // a condition must hold this long before it alerts
const CLEAR_MS = 120000;    // and be gone this long before it clears

const r = msg.payload;
const now = Date.now();
const day = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

// ---------------- settings ----------------
if (msg.topic === 'seplos/settings') {
    const before = global.get('seplos_settings');
    const regs = (s) => {
        const m = new Map();
        if (s && !s.error) {
            for (const n of s.named || []) m.set(n.register, { raw: n.raw, label: n.label, value: n.value, unit: n.unit });
            for (const o of s.other || []) m.set(o.register, { raw: o.raw, label: 'register ' + o.register, value: o.raw, unit: '' });
        }
        return m;
    };
    const changes = global.get('seplos_settings_changes') || [];
    const compare = (where, a, b) => {
        const ma = regs(a);
        for (const [reg, nb] of regs(b)) {
            const na = ma.get(reg);
            if (na && na.raw !== nb.raw) changes.push({ ts: r.timestamp, where, register: reg, label: nb.label, from: na.value, to: nb.value, unit: nb.unit });
        }
    };
    if (before) {
        compare('system', before.system, r.system);
        for (const pb of r.packs || []) {
            const pa = (before.packs || []).find((p) => p.pack === pb.pack);
            if (pa) compare('pack ' + pb.pack, pa.settings, pb.settings);
        }
    }
    while (changes.length > 50) changes.shift();
    global.set('seplos_settings_changes', changes);
    global.set('seplos_settings', r);
    return [msg, null];
}

// ---------------- alerts ----------------
function alerts(evaluated, conds, t) {
    const st = context.get('alerts') || {};
    const box = global.get('seplos_alerts') || { active: [], log: [] };
    const out = [];
    for (const key of evaluated) {
        const c = conds[key];
        const a = st[key] || (st[key] = { active: false, trueSince: null, falseSince: null });
        if (c) {
            a.falseSince = null;
            a.text = c.text; a.level = c.level;
            if (a.trueSince === null) a.trueSince = t;
            if (!a.active && t - a.trueSince >= RAISE_MS) {
                a.active = true; a.since = t;
                box.log.push({ t, key, level: c.level, text: c.text, state: 'raised' });
                out.push({ topic: 'Seplos battery', payload: c.text, priority: c.level === 'crit' ? 1 : 0 });
            }
        } else {
            a.trueSince = null;
            if (a.active) {
                if (a.falseSince === null) a.falseSince = t;
                if (t - a.falseSince >= CLEAR_MS) {
                    a.active = false;
                    box.log.push({ t, key, level: a.level, text: a.text, state: 'cleared' });
                    out.push({ topic: 'Seplos battery', payload: 'OK again: ' + a.text, priority: -1 });
                }
            }
        }
    }
    context.set('alerts', st);
    box.active = Object.entries(st).filter(([, a]) => a.active).map(([key, a]) => ({ key, level: a.level, text: a.text, since: a.since }));
    while (box.log.length > 30) box.log.shift();
    global.set('seplos_alerts', box);
    return out.length ? out : null;
}

const STALE_KEYS = ['stale'];
const READ_KEYS = ['cellHigh', 'cellLow', 'gap', 'cold', 'bms', 'chargeBlocked', 'dischargeBlocked', 'packMissing'];

if (msg.topic === 'seplos/tick') {
    const last = global.get('seplos');
    const age = last ? now - Date.parse(last.timestamp) : Infinity;
    const conds = {};
    if (age >= STALE_MIN * 60000) conds.stale = { level: 'crit', text: last ? `No battery reading for ${Math.round(age / 60000)} min` : 'No battery reading yet' };
    return [null, alerts(STALE_KEYS, conds, now)];
}

// ---------------- a reading ----------------
const t = Date.parse(r.timestamp) || now;
const prev = global.get('seplos');
global.set('seplos', r);
const s = r.system;
const packs = (r.packs || []).slice().sort((a, b) => a.pack - b.pack);
const good = packs.filter((p) => !p.error);
const sysv = global.get('seplos_sys');
const sys = sysv && t - sysv.t < 60000 ? sysv : null;
const power = Math.round(s.voltage * s.current);

// energy today (Wh), per day for 7 days
const e = global.get('seplos_energy') || { day: day(t), lastT: null, today: {}, days: [] };
if (e.day !== day(t)) {
    e.days.push({ day: e.day, ...e.today });
    while (e.days.length > 7) e.days.shift();
    e.day = day(t); e.today = {};
}
const add = (k, wh) => { e.today[k] = (e.today[k] || 0) + wh; }; // exact sums; round only for display
const dtH = e.lastT ? (t - e.lastT) / 3600000 : 0;
if (dtH > 0 && dtH <= 120 / 3600) {
    add(power >= 0 ? 'battIn' : 'battOut', Math.abs(power) * dtH);
    if (sys) {
        if (typeof sys.pv === 'number') add('pv', Math.max(0, sys.pv) * dtH);
        if (typeof sys.load === 'number') add('load', Math.max(0, sys.load) * dtH);
        if (typeof sys.grid === 'number') add(sys.grid >= 0 ? 'gridIn' : 'gridOut', Math.abs(sys.grid) * dtH);
    }
}
e.lastT = t;
global.set('seplos_energy', e);

// time to full / empty from the current averaged over ~5 min
const dtS = prev ? Math.max(0, (t - Date.parse(prev.timestamp)) / 1000) : 0;
let iAvg = context.get('iAvg');
iAvg = iAvg === undefined || dtS > 600 ? s.current : iAvg + (1 - Math.exp(-dtS / 300)) * (s.current - iAvg);
context.set('iAvg', iAvg);
const cap = good.length === s.packCount && good.length ? good.reduce((a, p) => a + p.capacityAh, 0) : s.capacityAh;
const remaining = good.length === s.packCount && good.length ? good.reduce((a, p) => a + p.remainingAh, 0) : s.remainingAh;
global.set('seplos_timeto', {
    iAvg: Math.round(iAvg * 10) / 10,
    capacityAh: cap,
    hoursToEmpty: iAvg < -0.5 ? Math.round(remaining / -iAvg * 10) / 10 : null,
    hoursToFull: iAvg > 0.5 ? Math.round(Math.max(0, cap - remaining) / iAvg * 10) / 10 : null
});

// history: one point a minute for 24 h; 10-minute averages for 7 days
const h1 = global.get('seplos_h1') || [];
if (!h1.length || t - h1[h1.length - 1].t >= 55000) {
    const pt = {
        t, v: s.voltage, i: s.current, p: power, soc: s.soc,
        ps: packs.map((p) => (p.error ? null : p.soc)),
        pd: packs.map((p) => (p.error ? null : p.deltaMv)),
        tmin: r.summary ? r.summary.minCellTemp : null,
        cells: packs.map((p) => (p.error ? null : p.cells.map((c) => (c === null ? null : Math.round(c * 1000))))),
        bal: packs.map((p) => (p.balancing ? p.balancing.cells : null)),
        pv: sys ? sys.pv : null, grid: sys ? sys.grid : null, load: sys ? sys.load : null
    };
    h1.push(pt);
    while (h1.length && (h1[0].t < t - 24 * 3600000 || h1.length > 1500)) h1.shift();
    global.set('seplos_h1', h1);

    const h7 = global.get('seplos_h7') || [];
    const bucket = Math.floor(t / 600000) * 600000;
    let b = h7.length && h7[h7.length - 1].t === bucket ? h7[h7.length - 1] : null;
    const avg = (old, x, n) => (x === null || x === undefined ? old : old === null || old === undefined ? x : Math.round((old + (x - old) / n) * 100) / 100);
    if (!b) {
        b = { t: bucket, _n: 0, v: null, i: null, p: null, soc: null, ps: [], pd: [], tmin: null, cells: [], pv: null, grid: null, load: null };
        h7.push(b);
    }
    b._n += 1;
    for (const k of ['v', 'i', 'p', 'soc', 'pv', 'grid', 'load']) b[k] = avg(b[k], pt[k], b._n);
    pt.ps.forEach((x, k) => { b.ps[k] = avg(b.ps[k] ?? null, x, b._n); });
    pt.pd.forEach((x, k) => { if (x !== null) b.pd[k] = Math.max(b.pd[k] ?? x, x); });
    if (pt.tmin !== null) b.tmin = b.tmin === null ? pt.tmin : Math.min(b.tmin, pt.tmin);
    pt.cells.forEach((cs, k) => {
        if (!cs) return;
        b.cells[k] = b.cells[k] || cs.slice();
        cs.forEach((x, j) => { b.cells[k][j] = Math.round(avg(b.cells[k][j], x, b._n)); });
    });
    while (h7.length && h7[0].t < t - 7 * 24 * 3600000) h7.shift();
    global.set('seplos_h7', h7);
}

// alerts from this reading
const conds = {};
let hi = null; let lo = null;
for (const p of good) p.cells.forEach((c, j) => {
    if (c === null) return;
    if (!hi || c > hi.v) hi = { v: c, at: `P${p.pack}C${j + 1}` };
    if (!lo || c < lo.v) lo = { v: c, at: `P${p.pack}C${j + 1}` };
});
if (hi && hi.v >= CELL_HIGH_V) conds.cellHigh = { level: 'warn', text: `Cell ${hi.at} high: ${hi.v.toFixed(3)} V (alert at ${CELL_HIGH_V} V)` };
if (lo && lo.v <= CELL_LOW_V) conds.cellLow = { level: 'warn', text: `Cell ${lo.at} low: ${lo.v.toFixed(3)} V (alert at ${CELL_LOW_V} V)` };
const worst = good.reduce((w, p) => (p.deltaMv !== null && (!w || p.deltaMv > w.deltaMv) ? p : w), null);
if (worst && worst.deltaMv >= GAP_MV) conds.gap = { level: 'warn', text: `Cell gap ${worst.deltaMv} mV in pack ${worst.pack} (alert at ${GAP_MV} mV)` };
const tmin = r.summary ? r.summary.minCellTemp : null;
if (tmin !== null && tmin < COLD_C) conds.cold = { level: 'warn', text: `Cells cold: ${tmin} °C (alert below ${COLD_C} °C)` };
if (s.problem) conds.bms = { level: 'crit', text: `BMS alarm bits set (code ${s.problemCode})` };
if (!s.chargeFet) conds.chargeBlocked = { level: 'crit', text: 'The BMS has blocked charging' };
if (!s.dischargeFet) conds.dischargeBlocked = { level: 'crit', text: 'The BMS has blocked discharging' };
const missing = packs.filter((p) => p.error).map((p) => p.pack);
if (missing.length) conds.packMissing = { level: 'warn', text: `Pack ${missing.join(', ')} not read` };
const out2 = alerts(READ_KEYS.concat(STALE_KEYS), conds, t); // a good reading also clears "stale"
return [msg, out2];
