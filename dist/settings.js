// Seplos V3 settings (parameter block SPA, input registers 0x1300-0x1369) and device info (0x1700-0x1723).
// READ-ONLY. Names carry how sure they are:
//   tested  - aiobmsble seplos_bms.py limit table, checked against its recorded frames and expected values
//   driver  - dbus-serialbattery seplosv3.py (register use in a working driver)
//   pattern - inferred: each limit is a group of four (alarm recovery, alarm, protection recovery, protection)
//             whose tested members anchor the order; ambient-temperature names are a guess
// Everything else is listed by register with its raw value.
import { createRequester } from './seplos.js';

const V = (s) => ({ kind: 'u', scale: s });
const VS = (s) => ({ kind: 's', scale: s });
const K = { kind: 'k' }; // 0.1 K -> degrees C (offset 2731, as aiobmsble)
const N = { kind: 'u', scale: 1 };

function group4(start, name, unit, fmt, sources) {
    const parts = ['alarm recovery', 'alarm', 'protection recovery', 'protection'];
    return parts.map((p, i) => [start + i, `${name} ${p}`, unit, fmt, sources[i]]);
}

// [register offset from 0x1300, label, unit, format, source]
export const SETTINGS = [
    [0x00, 'Temperature sensors', '', N, 'driver'],
    [0x01, 'Cells in series', '', N, 'driver'],
    ...group4(0x02, 'Pack over-voltage', 'V', V(0.01), ['pattern', 'pattern', 'tested', 'tested']),
    ...group4(0x06, 'Pack under-voltage', 'V', V(0.01), ['pattern', 'pattern', 'tested', 'tested']),
    ...group4(0x0a, 'Cell over-voltage', 'V', V(0.001), ['pattern', 'pattern', 'tested', 'tested']),
    ...group4(0x0e, 'Cell under-voltage', 'V', V(0.001), ['pattern', 'pattern', 'tested', 'tested']),
    [0x15, 'Charge over-current recovery', 'A', N, 'tested'],
    [0x16, 'Charge over-current alarm', 'A', N, 'pattern'],
    [0x17, 'Charge over-current protection', 'A', N, 'tested'],
    [0x18, 'Charge over-current protection delay', 's', V(0.1), 'tested'],
    [0x1b, 'Discharge over-current recovery', 'A', VS(-1), 'pattern'],
    [0x1c, 'Discharge over-current alarm', 'A', VS(-1), 'pattern'],
    [0x1d, 'Discharge over-current protection', 'A', VS(-1), 'tested'],
    [0x1e, 'Discharge over-current protection delay', 's', V(0.1), 'tested'],
    ...group4(0x2f, 'Charge high temperature', '°C', K, ['pattern', 'pattern', 'tested', 'tested']),
    ...group4(0x33, 'Charge low temperature', '°C', K, ['pattern', 'pattern', 'tested', 'tested']),
    ...group4(0x37, 'Discharge high temperature', '°C', K, ['pattern', 'pattern', 'tested', 'tested']),
    ...group4(0x3b, 'Discharge low temperature', '°C', K, ['pattern', 'pattern', 'tested', 'tested']),
    ...group4(0x3f, 'Ambient high temperature (name guessed)', '°C', K, ['pattern', 'pattern', 'pattern', 'pattern']),
    ...group4(0x43, 'Ambient low temperature (name guessed)', '°C', K, ['pattern', 'pattern', 'pattern', 'pattern']),
    ...group4(0x47, 'MOSFET high temperature', '°C', K, ['pattern', 'pattern', 'tested', 'tested']),
    [0x58, 'Capacity (second copy; meaning unsure)', 'Ah', V(0.01), 'pattern'],
    [0x59, 'Capacity', 'Ah', V(0.01), 'driver'],
    [0x5a, 'Remaining capacity', 'Ah', V(0.01), 'driver'],
    [0x65, 'Charge voltage sent to the inverter', 'V', V(0.01), 'driver'],
    [0x66, 'Charge current limit sent to the inverter', 'A', N, 'driver'],
    [0x67, 'Discharge current limit sent to the inverter', 'A', VS(-1), 'driver']
];
export const SETTINGS_COUNT = 0x6a; // 106 registers, read as two blocks of 53

function value(raw, f) {
    if (f.kind === 'k') return raw === 0 ? null : Math.round(raw - 2731) / 10;
    const v = f.kind === 's' && raw >= 0x8000 ? raw - 0x10000 : raw;
    return Math.round(v * f.scale * 1000) / 1000;
}

// regs: 106 numbers (0x1300..0x1369) -> { named: [...], other: [...] }
export function decodeSettings(regs) {
    const named = [];
    const used = new Set();
    for (const [off, label, unit, f, source] of SETTINGS) {
        if (off >= regs.length) continue;
        used.add(off);
        named.push({ register: '0x' + (0x1300 + off).toString(16), label, value: value(regs[off], f), unit, source, raw: regs[off] });
    }
    const other = [];
    regs.forEach((raw, off) => { if (!used.has(off)) other.push({ register: '0x' + (0x1300 + off).toString(16), raw }); });
    return { named, other };
}

const ascii = (buf) => buf.toString('latin1').replace(/\0/g, '').trim();
// 0x1700 x36: maker (10 regs), model (10), ?, firmware (0x1714, 1 reg), serial (0x1715, 15 regs) - after dbus-serialbattery
export function decodeInfo(d) {
    const fw = d.subarray(40, 42);
    return {
        maker: ascii(d.subarray(0, 20)),
        model: ascii(d.subarray(20, 40)),
        firmware: /^[\x20-\x7e]{2}$/.test(fw.toString('latin1')) ? fw.toString('latin1')[0] + '.' + fw.toString('latin1')[1] : fw.toString('hex'),
        serial: ascii(d.subarray(42, 72))
    };
}

async function readSpa(requester, device) {
    const a = await requester.request(device, 0x04, 0x1300, 0x35);
    const b = await requester.request(device, 0x04, 0x1335, 0x35);
    const regs = [];
    for (const d of [a, b]) for (let i = 0; i + 1 < d.length; i += 2) regs.push(d.readUInt16BE(i));
    return regs;
}

// Settings of the system (device 0) and of each pack; a part that does not answer is reported, not fatal.
export async function readSeplosSettings(session, { packCount = 0, replyWaitsMs, logger } = {}) {
    const requester = createRequester(session, { replyWaitsMs, logger });
    const settled = async (fn) => { try { return await fn(); } catch (error) { return { error: error.message }; } };
    try {
        if (!packCount) packCount = (await requester.request(0, 0x04, 0x2000, 0x1a)).readUInt16BE(44); // EIA pack count
        const system = await settled(async () => decodeSettings(await readSpa(requester, 0)));
        const packs = [];
        for (let p = 1; p <= Math.min(packCount || 1, 16); p++) {
            const info = await settled(async () => decodeInfo(await requester.request(p, 0x04, 0x1700, 0x24)));
            const settings = await settled(async () => decodeSettings(await readSpa(requester, p)));
            packs.push({ pack: p, info, settings });
        }
        return { system, packs };
    } finally {
        requester.close();
    }
}

// Which registers changed between two settings readings (system and packs).
export function diffSettings(before, after) {
    const changes = [];
    const regsOf = (s) => {
        const m = new Map();
        if (s && !s.error) {
            for (const n of s.named || []) m.set(n.register, { raw: n.raw, label: n.label, value: n.value, unit: n.unit });
            for (const o of s.other || []) m.set(o.register, { raw: o.raw, label: 'register ' + o.register, value: o.raw, unit: '' });
        }
        return m;
    };
    const compare = (where, a, b) => {
        const ma = regsOf(a);
        const mb = regsOf(b);
        for (const [reg, nb] of mb) {
            const na = ma.get(reg);
            if (na && na.raw !== nb.raw) changes.push({ where, register: reg, label: nb.label, from: na.value, to: nb.value, unit: nb.unit });
        }
    };
    if (!before || !after) return changes;
    compare('system', before.system, after.system);
    for (const pb of after.packs || []) {
        const pa = (before.packs || []).find((p) => p.pack === pb.pack);
        if (pa) compare('pack ' + pb.pack, pa.settings, pb.settings);
    }
    return changes;
}
