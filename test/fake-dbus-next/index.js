'use strict';
// Fake dbus-next that emulates BlueZ with one Seplos V3 dongle (and decoys) for the package tests.
// State and mode live in globalThis.__fakeBluez (set by the test before each case).
class Variant { constructor(signature, value) { this.signature = signature; this.value = value; } }
const V = (s, v) => new Variant(s, v);

const ADAPTER = '/org/bluez/hci0';
const MAC = 'AA:BB:CC:00:00:01';
const DEV = ADAPTER + '/dev_40_80_E1_E6_29_3C';
const SVC = DEV + '/service0010';
const NOTIFY = SVC + '/char0011';
const WRITE = SVC + '/char0014';
const FFF0 = '0000fff0-0000-1000-8000-00805f9b34fb';
const DECOYS = [
    { path: ADAPTER + '/dev_AA_00_00_00_00_03', mac: 'AA:00:00:00:00:03', name: 'BT-UART', rssi: -75, uuids: [FFF0] },
    { path: ADAPTER + '/dev_AA_00_00_00_00_04', mac: 'AA:00:00:00:00:04', name: 'SK12V314000001', rssi: -80, uuids: [FFF0] },
    { path: ADAPTER + '/dev_D0_00_00_00_00_01', mac: 'D0:00:00:00:00:01', name: 'SmartSolar HQ2111', rssi: -60, uuids: [] }
];

const w = () => globalThis.__fakeBluez;
const log = (s) => w().log.push(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function crc16(buf, len) {
    let crc = 0xffff;
    for (let i = 0; i < len; i++) {
        crc ^= buf[i];
        for (let b = 0; b < 8; b++) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc;
}

function managed() {
    const s = w().state;
    const o = { [ADAPTER]: { 'org.bluez.Adapter1': { Address: V('s', '00:11:22:33:44:55'), Discovering: V('b', s.discovering) } } };
    for (const d of DECOYS) {
        if (!s.decoys) break;
        o[d.path] = { 'org.bluez.Device1': { Address: V('s', d.mac), Name: V('s', d.name), RSSI: V('n', d.rssi), UUIDs: V('as', d.uuids), Connected: V('b', false) } };
    }
    if (s.devicePresent) {
        const dev = { Address: V('s', MAC), Name: V('s', 'SP05B2312120003       '), Alias: V('s', 'SP05B2312120003'),
            UUIDs: V('as', [FFF0]), Connected: V('b', s.connected), ServicesResolved: V('b', s.servicesResolved) };
        if (s.rssi !== null) dev.RSSI = V('n', s.rssi);
        o[DEV] = { 'org.bluez.Device1': dev };
        if (s.servicesResolved && w().mode !== 'nochars') {
            o[SVC] = { 'org.bluez.GattService1': { UUID: V('s', FFF0) } };
            o[NOTIFY] = { 'org.bluez.GattCharacteristic1': { UUID: V('s', '0000fff1-0000-1000-8000-00805f9b34fb'), Flags: V('as', ['read', 'notify']) } };
            o[WRITE] = { 'org.bluez.GattCharacteristic1': { UUID: V('s', '0000fff2-0000-1000-8000-00805f9b34fb'), Flags: V('as', ['read', 'write-without-response', 'write']) } };
        }
    }
    return o;
}

function reply(req) {
    const frames = w().frames;
    const mode = w().mode;
    if (req.length !== 8) throw new Error('fake: bad request length ' + req.length);
    const c = crc16(req, 6);
    if (req[6] !== (c & 0xff) || req[7] !== (c >> 8)) throw new Error('fake: bad request CRC ' + req.toString('hex'));
    if (req[1] !== 0x01 && req[1] !== 0x04) throw new Error('fake: NOT A READ ' + req.toString('hex'));
    const dev = req[0];
    const start = req.readUInt16BE(2);
    const count = req.readUInt16BE(4);
    const expectLen = count * (req[1] === 0x04 ? 2 : 0.125) + 5;
    const resign = (hex) => { // a recorded frame re-addressed to this device, CRC recomputed
        const b = Buffer.from(hex, 'hex'); b[0] = dev; const k = crc16(b, b.length - 2); b[b.length - 2] = k & 0xff; b[b.length - 1] = k >> 8; return b;
    };
    if (start === 0x1300 || start === 0x1335) {
        if (mode === 'nopackspa' && dev > 0) return null;
        return resign(frames['SPA' + start.toString(16).toUpperCase()]);
    }
    if (start === 0x1200 && dev > 0 && req[1] === 0x01) { // pack status coils: pack 1 balances cells 8 and 13
        if (mode === 'nopic') return null;
        const body = Buffer.alloc(18);
        if (dev === 1) { body[5] |= 1 << 7; body[6] |= 1 << 4; } // coils 0x2f (cell 8) and 0x34 (cell 13)
        const b = Buffer.concat([Buffer.from([dev, 0x01, 18]), body, Buffer.alloc(2)]);
        const k = crc16(b, b.length - 2); b[b.length - 2] = k & 0xff; b[b.length - 1] = k >> 8;
        return b;
    }
    if (start === 0x1700 && dev > 0) {
        const txt = (s, n) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(n)]).subarray(0, n);
        const body = Buffer.concat([txt('XZH-ElecTech Co.,Ltd', 20), txt('SP112B-200A', 20), Buffer.from('16', 'latin1'), txt('SN-PACK-' + dev, 30)]);
        const b = Buffer.concat([Buffer.from([dev, 0x04, body.length]), body, Buffer.alloc(2)]);
        const k = crc16(b, b.length - 2); b[b.length - 2] = k & 0xff; b[b.length - 1] = k >> 8;
        return b;
    }
    let key = null;
    if (dev === 0) key = { 0x2000: 'EIA', 0x2100: 'EIB', 0x2200: 'EIC' }[start];
    else if (start === 0x1000) key = 'PIA' + dev;
    else if (start === 0x1100) key = 'PIB' + dev;
    if (!key || !frames[key]) return null;
    let f = Buffer.from(frames[key], 'hex');
    if (f.length !== expectLen) throw new Error(`fake: ${key} asked ${expectLen} bytes, frame has ${f.length}`);
    if (mode === 'badcrc') { f = Buffer.from(f); f[f.length - 1] ^= 0xff; }
    if (mode === 'garbage') f = Buffer.concat([f, Buffer.from([0xc0, 0xff, 0xee])]);
    if (mode === 'refuse2' && dev === 2) { const e = [dev, req[1] | 0x80, 0x02]; const k = crc16(e, 3); f = Buffer.from([...e, k & 0xff, k >> 8]); }
    if (mode === 'silent2' && dev === 2) return null;
    return f;
}

function proxy(p) {
    const s = w().state;
    return {
        getInterface(iface) {
            if (iface === 'org.freedesktop.DBus.ObjectManager') return { GetManagedObjects: async () => managed() };
            if (iface === 'org.bluez.Adapter1') {
                return {
                    SetDiscoveryFilter: async (f) => { log('FILTER ' + (f.Transport && f.Transport.value)); },
                    StartDiscovery: async () => {
                        if (w().mode === 'inprogress') {
                            log('START-DISCOVERY InProgress');
                            setTimeout(() => { s.devicePresent = true; s.rssi = -70; }, 30); // someone else's scan
                            throw new Error('org.bluez.Error.InProgress: Operation already in progress');
                        }
                        log('START-DISCOVERY');
                        s.discovering = true;
                        if (w().mode !== 'notheard') setTimeout(() => { if (s.discovering) { s.devicePresent = true; s.rssi = -70; } }, 30);
                    },
                    StopDiscovery: async () => { log('STOP-DISCOVERY'); s.discovering = false; }
                };
            }
            if (iface === 'org.bluez.Device1') {
                return {
                    Connect: async () => {
                        s.connects += 1;
                        log('CONNECT');
                        if (w().mode === 'hang') return new Promise(() => {});
                        if (w().mode === 'busy') { await sleep(10); throw new Error('org.bluez.Error.Failed: le-connection-abort-by-local'); }
                        if (w().mode === 'stale' && s.connects === 1) { await sleep(10); throw new Error('org.bluez.Error.Failed: Software caused connection abort'); }
                        s.connected = true;
                        setTimeout(() => { if (s.connected) s.servicesResolved = true; }, 20);
                    },
                    Disconnect: async () => { log('DISCONNECT'); s.connected = false; s.servicesResolved = false; s.notifying = false; s.listeners.clear(); }
                };
            }
            if (iface === 'org.freedesktop.DBus.Properties') {
                return {
                    Get: async (i, prop) => {
                        const obj = managed()[p];
                        if (!obj || !obj[i] || !(prop in obj[i])) throw new Error('org.freedesktop.DBus.Error.UnknownObject');
                        return obj[i][prop];
                    },
                    on: (event, cb) => { if (p === NOTIFY && event === 'PropertiesChanged') s.listeners.add(cb); }
                };
            }
            if (iface === 'org.bluez.GattCharacteristic1') {
                if (p === NOTIFY) return { StartNotify: async () => { log('START-NOTIFY'); s.notifying = true; } };
                return {
                    WriteValue: async (bytes, options) => {
                        const type = options && options.type ? options.type.value : 'request';
                        if (w().mode === 'cmdonly' && type === 'request') throw new Error('org.bluez.Error.NotSupported: Operation is not supported');
                        const req = Buffer.from(bytes);
                        log(`REQ ${type} ${req.toString('hex')}`);
                        if (s.mute > 0) { s.mute -= 1; return; } // link up, dongle silent
                        const f = reply(req);
                        if (!f) return;
                        for (let i = 0; i < f.length; i += 20) {
                            const part = [...f.subarray(i, i + 20)];
                            setTimeout(() => {
                                if (!s.notifying) return;
                                for (const cb of s.listeners) cb('org.bluez.GattCharacteristic1', { Value: V('ay', part) });
                            }, 2 + i / 20);
                        }
                    }
                };
            }
            throw new Error('fake: no interface ' + iface + ' on ' + p);
        }
    };
}

function systemBus() {
    const bus = { open: true, disconnect() { this.open = false; }, getProxyObject: async (_name, p) => proxy(p) };
    w().buses.push(bus);
    return bus;
}

module.exports = { systemBus, Variant, MAC };
