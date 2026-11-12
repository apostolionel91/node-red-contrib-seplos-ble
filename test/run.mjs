// Runs node-red-contrib-seplos-ble end to end against a fake BlueZ (test/fake-dbus-next) that answers with
// aiobmsble's recorded two-pack Seplos V3 frames. Usage: node test/run.mjs [package dir]
import { cpSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const pkgSrc = resolve(process.argv[2] || join(here, '..'));
// Recorded two-pack Seplos V3 replies from aiobmsble's tests (https://github.com/patman15/aiobmsble, Apache-2.0).
const FRAMES = JSON.parse(readFileSync(join(here, 'frames.json'), 'utf8'));
const MAC = 'AA:BB:CC:00:00:01';

// a throw-away copy of the package with the fake dbus-next as its dependency
const tmp = mkdtempSync(join(tmpdir(), 'seplos-pkg-'));
const pkg = join(tmp, 'pkg');
cpSync(pkgSrc, pkg, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules|examples|test)$/.test(src) });
mkdirSync(join(pkg, 'node_modules', 'dbus-next'), { recursive: true });
copyFileSync(join(here, 'fake-dbus-next', 'index.js'), join(pkg, 'node_modules', 'dbus-next', 'index.js'));
writeFileSync(join(pkg, 'node_modules', 'dbus-next', 'package.json'), '{"name":"dbus-next","main":"index.js"}');
Object.defineProperty(process, 'platform', { value: 'linux' });

function reset(mode = 'ok', { cached = true, rssi = -70, decoys = true } = {}) {
    globalThis.__fakeBluez = {
        mode, frames: FRAMES, log: [], buses: [],
        state: { devicePresent: cached, rssi, decoys, discovering: false, connected: false, servicesResolved: false, notifying: false, connects: 0, mute: 0, listeners: new Set() }
    };
    return globalThis.__fakeBluez;
}
const lib = await import(pathToFileURL(join(pkg, 'dist', 'index.js')).href);
const FAST = { replyWaitsMs: [60, 120, 180], scanMs: 1200, connectTimeoutMs: 600 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CELLS1 = [3.272, 3.272, 3.272, 3.271, 3.271, 3.271, 3.271, 3.27, 3.27, 3.271, 3.271, 3.271, 3.271, 3.272, 3.272, 3.272];
const CELLS2 = [3.528, 3.528, 3.528, 3.527, 3.527, 3.527, 3.527, 3.526, 3.526, 3.527, 3.527, 3.527, 3.527, 3.528, 3.528, 3.529];

function checkClean(f, label) {
    assert.equal(f.state.connected, false, `${label}: dongle left connected`);
    assert.ok(f.buses.every((b) => !b.open), `${label}: a D-Bus connection left open`);
}
function checkGood(r, f, label) {
    const s = r.system;
    assert.equal(r.ok, true);
    assert.deepEqual([s.voltage, s.current, s.remainingAh, s.capacityAh, s.packCount, s.cycles, s.soc, s.soh],
        [52.34, -6.7, 134.12, 280, 2, 9, 47.9, 99.9], `${label}: system`);
    assert.deepEqual([s.dischargeFet, s.chargeFet, s.heater, s.limitFet, s.problem], [true, true, false, false, false], `${label}: switches`);
    assert.equal(r.device.address, MAC);
    assert.equal(r.device.name, 'SP05B2312120003', `${label}: padded name trimmed`);
    checkClean(f, label);
}
async function expectError(promise, stage, hintRe, label) {
    try { await promise; } catch (e) {
        assert.equal(e.stage, stage, `${label}: stage (${e.message})`);
        if (hintRe) assert.match(e.hint, hintRe, `${label}: hint`);
        return e;
    }
    assert.fail(`${label}: no error`);
}
const reqs = (f) => f.log.filter((l) => l.startsWith('REQ'));

const results = [];
async function test(name, fn) {
    try { await fn(); results.push(`PASS ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

await test('cached dongle: both packs decode to aiobmsble values, no scan, disconnects', async () => {
    const f = reset('ok');
    const r = await lib.readBattery({ address: MAC, ...FAST });
    checkGood(r, f, 'ok');
    const [p1, p2] = r.packs;
    assert.deepEqual([p1.voltage, p1.current, p1.soc, p1.cycles, p1.deltaMv, p1.cellMinNo], [52.34, -7.2, 47.9, 9, 2, 8]);
    assert.deepEqual([p2.voltage, p2.current, p2.soc, p2.cycles, p2.deltaMv, p2.cellMaxNo], [52.35, -7.19, 48, 10, 3, 16]);
    assert.deepEqual(p1.cells, CELLS1);
    assert.deepEqual(p2.cells, CELLS2);
    assert.deepEqual([p1.cellTemps, p1.ambient, p1.mosfet], [[25, 23.8, 23.9, 24.9], 28.1, 26.6]);
    assert.deepEqual([p1.balancing.cells, p2.balancing.cells], [[8, 13], []], 'balancing bits');
    assert.deepEqual(r.summary, { packsRead: 2, packCount: 2, cellMin: 3.27, cellMinAt: 'P1C8', cellMax: 3.529, cellMaxAt: 'P2C16',
        deltaMv: 259, worstPackDeltaMv: 3, minCellTemp: 23.8, maxCellTemp: 25 });
    assert.deepEqual(reqs(f).map((l) => l.split(' ')[2].slice(0, 12)),
        ['00042000001a', '000122000050', '010410000011', '01041100001a', '010112000090', '020410000011', '02041100001a', '020112000090']);
    assert.ok(reqs(f).every((l) => l.startsWith('REQ request')), 'write with response first');
    assert.ok(!f.log.some((l) => l.startsWith('START-DISCOVERY')), 'no scan when BlueZ knows the MAC');
    assert.deepEqual(f.log.filter((l) => !l.startsWith('REQ')), ['CONNECT', 'START-NOTIFY', 'DISCONNECT']);
});

await test('unknown to BlueZ: scans (LE filter), stops its own scan, reads', async () => {
    const f = reset('ok', { cached: false });
    checkGood(await lib.readBattery({ address: MAC, ...FAST }), f, 'needscan');
    assert.deepEqual(f.log.slice(0, 2), ['FILTER le', 'START-DISCOVERY']);
    assert.ok(f.log.includes('STOP-DISCOVERY'));
});

await test('scan already running (InProgress): shares it, does not stop it', async () => {
    const f = reset('inprogress', { cached: false });
    checkGood(await lib.readBattery({ address: MAC, ...FAST }), f, 'inprogress');
    assert.ok(f.log.includes('START-DISCOVERY InProgress'));
    assert.ok(!f.log.includes('STOP-DISCOVERY'), "someone else's scan left running");
});

await test('stale cache entry: first connect fails, one forced scan, second connect reads', async () => {
    const f = reset('stale', { rssi: null });
    checkGood(await lib.readBattery({ address: MAC, ...FAST }), f, 'stale');
    // the failed attempt is cancelled (DISCONNECT) before the fresh scan
    assert.deepEqual(f.log.filter((l) => /^(DIS)?CONNECT$|DISCOVERY/.test(l)).slice(0, 5),
        ['CONNECT', 'DISCONNECT', 'START-DISCOVERY', 'STOP-DISCOVERY', 'CONNECT']);
});

await test('not heard: stage find, hint names the phone app and Bluetooth sensors', async () => {
    const f = reset('notheard', { cached: false });
    await expectError(lib.readBattery({ address: MAC, ...FAST }), 'find', /phone app.*Bluetooth sensors/s, 'notheard');
    assert.ok(!f.log.includes('CONNECT'));
    checkClean(f, 'notheard');
});

await test('phone holds the dongle: stage connect, connect hint, nothing left open', async () => {
    const f = reset('busy');
    await expectError(lib.readBattery({ address: MAC, ...FAST }), 'connect', /one connection at a time/, 'busy');
    assert.equal(f.state.connects, 2, 'one retry after a fresh scan');
    checkClean(f, 'busy');
});

await test('device without the Seplos service: says so and disconnects (the SOK code left it connected)', async () => {
    const f = reset('nochars');
    await expectError(lib.readBattery({ address: MAC, ...FAST }), 'connect', /no Seplos V3 service/, 'nochars');
    assert.ok(f.log.includes('DISCONNECT'));
    checkClean(f, 'nochars');
});

await test('write with response refused: falls back to write without response', async () => {
    const f = reset('cmdonly');
    checkGood(await lib.readBattery({ address: MAC, ...FAST }), f, 'cmdonly');
    assert.ok(reqs(f).every((l) => l.startsWith('REQ command')));
});

await test('every reply corrupt: stage read, 3 tries, disconnects', async () => {
    const f = reset('badcrc');
    const e = await expectError(lib.readBattery({ address: MAC, ...FAST }), 'read', /did not answer like a Seplos/, 'badcrc');
    assert.match(e.message, /no valid reply from the system to 0x2000 \(3 with a bad checksum\)/);
    assert.equal(reqs(f).length, 3);
    checkClean(f, 'badcrc');
});

await test('trailing garbage after each reply is ignored', async () => {
    const f = reset('garbage');
    checkGood(await lib.readBattery({ address: MAC, ...FAST }), f, 'garbage');
});

await test('pack 2 refuses / never answers: reported on that pack, the rest still reads', async () => {
    let f = reset('refuse2');
    let r = await lib.readBattery({ address: MAC, ...FAST });
    checkGood(r, f, 'refuse2');
    assert.equal(r.packs[1].error, 'the BMS refused the request (Modbus error 2)');
    assert.equal(r.summary.packsRead, 1);
    f = reset('silent2');
    r = await lib.readBattery({ address: MAC, ...FAST });
    checkGood(r, f, 'silent2');
    assert.match(r.packs[1].error, /no valid reply from pack 2 to 0x1000/);
});

await test('Connect that never answers: times out, retries once, nothing left open', async () => {
    const f = reset('hang');
    await expectError(lib.readBattery({ address: MAC, ...FAST }), 'connect', /one connection at a time/, 'hang');
    assert.equal(f.state.connects, 2);
    checkClean(f, 'hang');
});

await test('watchdog: a read that outlives readTimeoutMs gives up, and cleans up after', async () => {
    const f = reset('hang');
    const t = Date.now();
    const e = await expectError(lib.readBattery({ address: MAC, ...FAST, connectTimeoutMs: 700, readTimeoutMs: 300 }), 'connect', null, 'watchdog');
    assert.match(e.message, /gave up after 0.3 s/);
    assert.ok(Date.now() - t < 1000, 'answered at the watchdog');
    await sleep(2200); // let the hanging connect time out and retry inside
    checkClean(f, 'watchdog after');
});

await test('no MAC: reads the first Seplos-named device, not the FFF0 decoys', async () => {
    const f = reset('ok');
    checkGood(await lib.readBattery({ ...FAST }), f, 'untargeted');
});

await test('editor search: Seplos and FFF0 devices strongest first, no others', async () => {
    reset('ok');
    const list = await lib.discoverBatteries({ includeService: true, timeoutMs: 600 });
    assert.deepEqual(list.map((d) => d.address), [MAC, 'AA:00:00:00:00:03', 'AA:00:00:00:00:04']);
});

await test('read-only guard: write functions are refused', async () => {
    assert.throws(() => lib.command(0, 0x06, 0x1300, 1), /read requests only/);
    assert.throws(() => lib.command(0, 0x10, 0x1300, 1), /read requests only/);
    assert.throws(() => lib.command(0, 0x03, 0x0080, 1), /read requests only/);
    assert.equal(lib.command(0, 0x04, 0x2000, 0x1a).toString('hex').slice(0, 12), '00042000001a');
});

// ---- kept connection ----
const connects = (f) => f.log.filter((l) => l === 'CONNECT').length;
const disconnects = (f) => f.log.filter((l) => l === 'DISCONNECT').length;

await test('keeper: three reads on one connection, close() disconnects', async () => {
    const f = reset('ok');
    const k = lib.createKeeper({ address: MAC, ...FAST });
    const r1 = await k.read();
    const r2 = await k.read();
    const r3 = await k.read();
    assert.deepEqual([r1.kept, r1.reused, r2.reused, r3.reused], [true, false, true, true]);
    assert.deepEqual(r3.packs.map((p) => p.cells.length), [16, 16]);
    assert.deepEqual([connects(f), disconnects(f), f.state.connected], [1, 0, true], 'held open between reads');
    assert.equal(reqs(f).length, 24, '8 requests per read');
    await k.close();
    checkClean(f, 'keeper closed');
});

await test('keeper: a dropped link is noticed and reconnected before reading', async () => {
    const f = reset('ok');
    const k = lib.createKeeper({ address: MAC, ...FAST });
    await k.read();
    f.state.connected = false; f.state.servicesResolved = false; f.state.notifying = false; // the dongle went away
    const r = await k.read();
    assert.equal(r.reused, false);
    assert.equal(connects(f), 2);
    assert.equal(reqs(f).length, 16, 'no requests wasted on the dead link');
    assert.equal(r.system.voltage, 52.34);
    await k.close();
    checkClean(f, 'drop');
});

await test('keeper: a link that stays up but goes silent is reconnected once and the read succeeds', async () => {
    const f = reset('ok');
    const k = lib.createKeeper({ address: MAC, ...FAST });
    await k.read();
    f.state.mute = 3; // three requests vanish: the whole first try at the system block
    const r = await k.read();
    assert.equal(r.reused, false, 'answered over the new connection');
    assert.equal(r.system.soc, 47.9);
    assert.deepEqual([connects(f), disconnects(f)], [2, 1], 'old link closed, new one opened');
    await k.close();
    checkClean(f, 'silent');
});

await test('keeper: dongle gone for good -> clear error, nothing left open', async () => {
    const f = reset('ok');
    const k = lib.createKeeper({ address: MAC, ...FAST });
    await k.read();
    f.mode = 'badcrc';
    await expectError(k.read(), 'read', /did not answer like a Seplos/, 'gone');
    assert.equal(k.connected, false);
    checkClean(f, 'gone');
});

// ---- the Node-RED nodes in a fake Node-RED ----
function fakeRED() {
    const types = {};
    const routes = {};
    const nodes = {};
    const RED = {
        nodes: {
            createNode(node, config) {
                Object.assign(node, { id: config.id, _events: {}, _sent: [], _status: null });
                node.on = (ev, fn) => { node._events[ev] = fn; };
                node.status = (s) => { node._status = s; };
                node.debug = () => {};
                node.error = () => {};
                node.send = (m) => node._sent.push(m);
                nodes[config.id] = node;
            },
            registerType(name, ctor) { types[name] = ctor; },
            getNode(id) { return nodes[id]; }
        },
        auth: { needsPermission: () => (_q, _s, next) => next() },
        httpAdmin: { get(route, _perm, handler) { routes[route] = handler; } }
    };
    return { RED, types, routes };
}
const req = createRequire(import.meta.url);
function input(node, msg) {
    return new Promise((res) => {
        const out = [];
        node._events.input(msg, (m) => out.push(m), (err) => res({ out, err }));
    });
}

await test('Node-RED: read node outputs the reading, green status; busy input skipped; errors carry stage and hint', async () => {
    const { RED, types, routes } = fakeRED();
    req(join(pkg, 'nodes', 'seplos-battery-device.js'))(RED);
    req(join(pkg, 'nodes', 'seplos-battery-get.js'))(RED);
    const cfg = new types['seplos-battery-device']({ id: 'cfg', address: MAC.toLowerCase() });
    const get = new types['seplos-battery-get']({ id: 'get', device: 'cfg' });
    assert.equal(cfg.address, MAC, 'MAC upper-cased');

    let f = reset('ok');
    const first = input(get, { payload: 1 });
    const second = await input(get, { payload: 2 }); // arrives while the first is reading
    assert.deepEqual([second.out.length, second.err, get._status.text], [0, undefined, 'busy: last read still running, skipped']);
    const r1 = await first;
    assert.equal(r1.err, undefined);
    assert.equal(r1.out.length, 1);
    assert.equal(r1.out[0].topic, 'seplos');
    assert.deepEqual(r1.out[0].payload.packs.map((p) => p.cells.length), [16, 16]);
    assert.equal(get._status.fill, 'green');
    assert.equal(get._status.text, '52.34 V -6.7 A 47.9 % · Δ 259 mV · 23.8 °C');
    checkClean(f, 'node ok');

    f = reset('notheard', { cached: false });
    const r2 = await input(get, { payload: 3 });
    assert.equal(r2.out.length, 0);
    assert.match(r2.err.message, /^find: dongle not heard \(.*phone app/);
    assert.equal(get._status.fill, 'red');

    reset('ok');
    let body = null;
    await routes['/seplos-battery/devices']({}, { json: (x) => { body = x; }, status() { return this; } });
    assert.deepEqual(body.map((d) => [d.address, d.seplosName]), [[MAC, true], ['AA:00:00:00:00:03', false], ['AA:00:00:00:00:04', false]]);

    const orphan = new types['seplos-battery-get']({ id: 'orphan', device: 'missing' });
    const r3 = await input(orphan, { payload: 1 });
    assert.match(r3.err.message, /No Seplos battery configured/);
});

await test('Node-RED keep connected: one connection for many reads; release frees it and pauses; resume; redeploy closes', async () => {
    const { RED, types } = fakeRED();
    req(join(pkg, 'nodes', 'seplos-battery-device.js'))(RED);
    req(join(pkg, 'nodes', 'seplos-battery-get.js'))(RED);
    const cfg = new types['seplos-battery-device']({ id: 'kcfg', address: MAC, keepConnected: true });
    const get = new types['seplos-battery-get']({ id: 'kget', device: 'kcfg' });
    const f = reset('ok');
    for (let i = 0; i < 3; i++) {
        const r = await input(get, { payload: i });
        assert.equal(r.err, undefined, String(r.err && r.err.message));
        assert.equal(r.out[0].payload.kept, true);
    }
    assert.match(get._status.text, / · kept$/);
    assert.deepEqual([connects(f), disconnects(f), f.state.connected], [1, 0, true]);

    const rel = await input(get, { payload: 'release' });
    assert.deepEqual([rel.out.length, rel.err], [0, undefined]);
    assert.match(get._status.text, /^released for the phone app until \d\d:\d\d$/);
    assert.equal(f.state.connected, false, 'dongle freed');
    const paused = await input(get, { payload: 9 });
    assert.equal(paused.out.length, 0, 'no read while paused');
    assert.match(get._status.text, /^paused for the phone app/);
    assert.equal(connects(f), 1);

    await input(get, { payload: 'resume' });
    const again = await input(get, { payload: 10 });
    assert.equal(again.out.length, 1);
    assert.equal(connects(f), 2, 'connects again after resume');

    await new Promise((res) => cfg._events.close(false, res)); // redeploy
    checkClean(f, 'redeploy');
});

// ---- settings (read-only) ----
const named = (s) => Object.fromEntries(s.named.map((n) => [n.label, n.value]));

await test('settings: protection limits equal aiobmsble\'s expected values; driver and pattern names; info; raw rest', async () => {
    const f = reset('ok');
    const r = await lib.readSettings({ address: MAC, ...FAST });
    assert.equal(r.kind, 'settings');
    const n = named(r.system);
    // aiobmsble test_limits expected values
    assert.deepEqual([n['Pack over-voltage protection'], n['Pack over-voltage protection recovery']], [57.6, 55]);
    assert.deepEqual([n['Pack under-voltage protection'], n['Pack under-voltage protection recovery']], [43.2, 48]);
    assert.deepEqual([n['Cell over-voltage protection'], n['Cell over-voltage protection recovery']], [3.6, 3.4]);
    assert.deepEqual([n['Cell under-voltage protection'], n['Cell under-voltage protection recovery']], [2.7, 3.1]);
    assert.deepEqual([n['Charge over-current protection'], n['Charge over-current recovery'], n['Charge over-current protection delay']], [210, 203, 10]);
    assert.deepEqual([n['Discharge over-current protection'], n['Discharge over-current protection delay']], [210, 10]);
    assert.deepEqual([n['Charge high temperature protection'], n['Charge high temperature protection recovery']], [55, 50]);
    assert.deepEqual([n['Charge low temperature protection'], n['Charge low temperature protection recovery']], [-10, 0]);
    assert.deepEqual([n['Discharge high temperature protection'], n['Discharge high temperature protection recovery']], [60, 55]);
    assert.deepEqual([n['Discharge low temperature protection'], n['Discharge low temperature protection recovery']], [-15, 0]);
    assert.deepEqual([n['MOSFET high temperature protection'], n['MOSFET high temperature protection recovery']], [110, 85]);
    // dbus-serialbattery fields, and the inferred alarm levels
    assert.deepEqual([n['Cells in series'], n['Capacity'], n['Remaining capacity']], [16, 280, 134.12]);
    assert.deepEqual([n['Charge voltage sent to the inverter'], n['Charge current limit sent to the inverter'], n['Discharge current limit sent to the inverter']], [57.6, 180, 180]);
    assert.deepEqual([n['Pack over-voltage alarm'], n['Pack over-voltage alarm recovery'], n['Cell over-voltage alarm']], [56, 54.8, 3.5]);
    assert.equal(r.system.named.length + r.system.other.length, 106, 'every register shown once');
    assert.ok(r.system.other.some((o) => o.register === '0x1312' && o.raw === 2000));
    assert.equal(r.system.named.find((x) => x.label === 'Pack over-voltage protection').source, 'tested');
    assert.equal(r.packs.length, 2);
    assert.deepEqual(r.packs[1].info, { maker: 'XZH-ElecTech Co.,Ltd', model: 'SP112B-200A', firmware: '1.6', serial: 'SN-PACK-2' });
    assert.equal(named(r.packs[0].settings)['Cell over-voltage protection'], 3.6);
    assert.ok(reqs(f).every((l) => /^REQ \w+ ..04|^REQ \w+ ..01/.test(l)), 'reads only');
    checkClean(f, 'settings');
});

await test('settings: packs that do not answer are reported, the system still reads', async () => {
    const f = reset('nopackspa');
    const r = await lib.readSettings({ address: MAC, ...FAST });
    assert.equal(named(r.system)['Cell over-voltage protection'], 3.6);
    assert.match(r.packs[0].settings.error, /no valid reply from pack 1 to 0x1300/);
    assert.equal(r.packs[0].info.maker, 'XZH-ElecTech Co.,Ltd');
    checkClean(f, 'nopackspa');
});

await test('settings: diff names the changed register with old and new values', async () => {
    reset('ok');
    const a = await lib.readSettings({ address: MAC, ...FAST });
    const b = JSON.parse(JSON.stringify(a));
    const cell = b.system.named.find((x) => x.label === 'Cell over-voltage protection');
    cell.raw = 3650; cell.value = 3.65;
    b.packs[1].settings.other[0].raw += 1;
    const d = lib.diffSettings(a, b);
    assert.deepEqual(d.map((c) => [c.where, c.label, c.from, c.to]), [
        ['system', 'Cell over-voltage protection', 3.6, 3.65],
        ['pack 2', 'register ' + a.packs[1].settings.other[0].register, a.packs[1].settings.other[0].raw, a.packs[1].settings.other[0].raw + 1]
    ]);
    assert.deepEqual(lib.diffSettings(a, a), []);
});

await test('Node-RED: "settings" input reads settings over the kept connection (no new connect)', async () => {
    const { RED, types } = fakeRED();
    req(join(pkg, 'nodes', 'seplos-battery-device.js'))(RED);
    req(join(pkg, 'nodes', 'seplos-battery-get.js'))(RED);
    const cfg = new types['seplos-battery-device']({ id: 'scfg', address: MAC, keepConnected: true });
    const get = new types['seplos-battery-get']({ id: 'sget', device: 'scfg' });
    const f = reset('ok');
    await input(get, { payload: 1 });
    const s = await input(get, { payload: 'settings' });
    assert.equal(s.err, undefined, String(s.err && s.err.message));
    assert.equal(s.out[0].topic, 'seplos/settings');
    assert.equal(s.out[0].payload.kind, 'settings');
    assert.match(get._status.text, /^settings read: system, pack 1, pack 2 · \d\d:\d\d$/);
    assert.equal(connects(f), 1, 'same connection');
    await new Promise((res) => cfg._events.close(false, res));
    checkClean(f, 'settings node');
});

// last: it switches the coil request off for the rest of this process
await test('balancing: a pack that never answers the coil request is read without it, and not asked again', async () => {
    const f = reset('nopic');
    const r1 = await lib.readBattery({ address: MAC, ...FAST });
    assert.deepEqual(r1.packs.map((p) => p.balancing), [null, null]);
    assert.equal(r1.summary.packsRead, 2);
    const asked = reqs(f).filter((l) => l.includes(' 0101120000') || l.includes(' 0201120000')).length;
    await lib.readBattery({ address: MAC, ...FAST });
    assert.equal(reqs(f).filter((l) => l.includes(' 0101120000') || l.includes(' 0201120000')).length, asked, 'not asked again');
    checkClean(f, 'nopic');
});

rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
console.log(process.exitCode ? 'SOME FAILED' : `ALL ${results.length} PASS`);
process.exit(process.exitCode || 0);
