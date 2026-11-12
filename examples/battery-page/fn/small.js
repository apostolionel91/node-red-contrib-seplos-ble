// The small function nodes of the Seplos page flow, one per export (the build script reads them by name).
module.exports = {
  // Victron system values: the four input nodes are named pv, grid, load, batt (their name is msg.topic)
  sys: `const s = global.get('seplos_sys') || {};
s[msg.topic] = typeof msg.payload === 'number' ? msg.payload : null;
s.t = Date.now();
global.set('seplos_sys', s);
return null;
`,
  keepError: `global.set('seplos_error', { ts: new Date().toISOString(), message: (msg.error && msg.error.message) || 'read failed' });
return msg;
`,
  data: `const sys = global.get('seplos_sys');
msg.payload = {
    now: global.get('seplos') || null,
    error: global.get('seplos_error') || null,
    settings: global.get('seplos_settings') || null,
    settingsChanges: global.get('seplos_settings_changes') || [],
    sys: sys && Date.now() - sys.t < 120000 ? sys : null,
    energy: global.get('seplos_energy') || null,
    timeTo: global.get('seplos_timeto') || null,
    alerts: global.get('seplos_alerts') || { active: [], log: [] },
    serverTime: Date.now()
};
msg.headers = { 'Cache-Control': 'no-store' };
return msg;
`,
  history: `// GET /seplos/history?range=24h|7d&cells=1
const q = (msg.req && msg.req.query) || {};
const week = q.range === '7d';
const src = global.get(week ? 'seplos_h7' : 'seplos_h1') || [];
const withCells = q.cells === '1';
msg.payload = {
    range: week ? '7d' : '24h',
    points: src.map((p) => {
        const o = Object.assign({}, p);
        delete o._n;
        if (!withCells) { delete o.cells; delete o.bal; }
        return o;
    }),
    serverTime: Date.now()
};
msg.headers = { 'Cache-Control': 'no-store' };
return msg;
`,
  save: `// Every 30 min: the history and energy to /data/home/nodered/seplos/history.json (survives restarts)
const h1 = global.get('seplos_h1') || [];
if (!h1.length) return null; // never overwrite a saved file with nothing
msg.payload = JSON.stringify({ v: 1, savedAt: Date.now(), h1, h7: global.get('seplos_h7') || [], energy: global.get('seplos_energy') || null });
node.status({ text: 'saved ' + new Date().toLocaleTimeString() + ', ' + Math.round(msg.payload.length / 1024) + ' kB' });
return msg;
`,
  restore: `// On deploy: put the saved history back (older points only; anything read since start is kept)
let d;
try { d = JSON.parse(msg.payload); } catch (e) { node.warn('history file unreadable: ' + e.message); return null; }
if (!d || d.v !== 1) return null;
const now = Date.now();
const merge = (key, keepMs) => {
    const cur = global.get(key) || [];
    const first = cur.length ? cur[0].t : Infinity;
    const old = (d[key.replace('seplos_', '')] || []).filter((p) => p.t < first && p.t > now - keepMs);
    global.set(key, old.concat(cur));
    return old.length;
};
const n1 = merge('seplos_h1', 24 * 3600000);
merge('seplos_h7', 7 * 24 * 3600000);
const saved = d.energy;
if (saved) {
    const e = global.get('seplos_energy');
    if (!e) global.set('seplos_energy', saved);
    else {
        if (saved.day === e.day) for (const [k, v] of Object.entries(saved.today || {})) e.today[k] = (e.today[k] || 0) + v;
        else if (!e.days.some((x) => x.day === saved.day)) e.days.push({ day: saved.day, ...saved.today });
        const known = new Set(e.days.map((x) => x.day));
        e.days = (saved.days || []).filter((x) => !known.has(x.day) && x.day !== e.day).concat(e.days).sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-7);
        global.set('seplos_energy', e);
    }
}
node.status({ text: 'restored ' + n1 + ' points from ' + new Date(d.savedAt).toLocaleString() });
return null;
`
};
