// Seplos V3 protocol: build read requests, join replies, decode the system and every pack.
// Read-only by construction: command() refuses anything but Modbus 0x01 and 0x04 (reads).
// Register map and scaling after aiobmsble seplos_bms.py (Apache-2.0, https://github.com/patman15/aiobmsble);
// checked against the two-pack frames recorded in its tests.
import { appendCrc, verifyCrc } from './crc.js';
import { BLOCKS } from './constants.js';

export const DEFAULT_REPLY_WAITS_MS = [1500, 3000, 4500]; // three tries per request

// [device, function, start hi, start lo, count hi, count lo, crc lo, crc hi]
export function command(device, fct, start, count) {
    if (fct !== 0x01 && fct !== 0x04) throw new Error('Seplos: read requests only (Modbus 0x01 or 0x04).');
    if (!Number.isInteger(device) || device < 0 || device > 0x10) throw new Error(`Seplos: bad device ${device}.`);
    const n = fct === 0x01 ? count * 16 : count; // 0x01 counts coils (bits), 0x04 counts registers
    return appendCrc(Buffer.from([device, fct, start >> 8, start & 0xff, n >> 8, n & 0xff]));
}

// Reads one block over a session { notify: { onData, removeDataListener }, write: { write(data, withoutResponse) } }.
export function createRequester(session, { replyWaitsMs = DEFAULT_REPLY_WAITS_MS, logger = () => {} } = {}) {
    let rx = null;
    let withoutResponse = false;

    const onData = (chunk) => {
        const r = rx;
        if (!r) return;
        const b = Buffer.from(chunk);
        if (b.length >= 3 && b[0] === r.dev && b[1] === r.fct && b[2] === r.bytes) {
            r.buf = b; // start of our reply
        } else if (!r.buf && b.length >= 5 && b[0] === r.dev && b[1] === (r.fct | 0x80)) {
            if (verifyCrc(b.subarray(0, 5))) { // Modbus exception: [dev, fct | 0x80, code, crc, crc]
                rx = null;
                r.reject(new Error(`the BMS refused the request (Modbus error ${b[2]})`));
            }
            return;
        } else if (r.buf) {
            r.buf = Buffer.concat([r.buf, b]);
        } else {
            return; // noise before our reply
        }
        if (r.buf.length < r.total) return;
        const frame = r.buf.subarray(0, r.total);
        if (!verifyCrc(frame)) { r.buf = null; r.badCrc++; return; }
        rx = null;
        r.resolve(Buffer.from(frame.subarray(3, r.total - 2)));
    };
    session.notify.onData(onData);

    async function write(frame) {
        try {
            await session.write.write(frame, withoutResponse);
        } catch (error) {
            if (withoutResponse) throw error;
            withoutResponse = true; // the dongle may only take write-without-response
            logger(`Write with response failed (${error.message}); using write without response.`);
            await session.write.write(frame, true);
        }
    }

    async function request(device, fct, start, count) {
        const frame = command(device, fct, start, count);
        const bytes = count * 2; // registers x 2 bytes, or count x 16 coils / 8
        let badCrc = 0;
        for (const wait of replyWaitsMs) {
            const reply = new Promise((resolve, reject) => {
                rx = { dev: device, fct, bytes, total: bytes + 5, buf: null, badCrc: 0, resolve, reject };
            });
            const current = rx;
            let timer;
            const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), wait); });
            try {
                await write(frame);
                const got = await Promise.race([reply, timeout]);
                badCrc += current.badCrc;
                if (got) return got;
            } finally {
                clearTimeout(timer);
            }
        }
        rx = null;
        const who = device === 0 ? 'the system' : `pack ${device}`;
        throw new Error(`no valid reply from ${who} to 0x${start.toString(16)}` + (badCrc ? ` (${badCrc} with a bad checksum)` : ''));
    }

    return { request, close: () => { rx = null; session.notify.removeDataListener(onData); } };
}

// ---- decoding (offsets within the reply data, after the 3-byte header) ----

const u32w = (d, o) => d.readUInt16BE(o + 2) * 65536 + d.readUInt16BE(o); // low 16-bit word first
const s32w = (d, o) => { const v = u32w(d, o); return v >= 0x80000000 ? v - 0x100000000 : v; };
const kelvin = (raw) => (raw === 0 ? null : (raw - 2731) / 10); // 0.1 K; 0 = no sensor

export function decodeSystem(eia, eic) {
    const problemBits = BigInt('0x' + eic.subarray(1, 10).toString('hex')) & 0xFFFF00FF00FF0000FFn;
    return {
        voltage: u32w(eia, 0) / 100,
        current: s32w(eia, 4) / 10,
        remainingAh: u32w(eia, 8) / 100,
        capacityAh: Math.floor(u32w(eia, 20) / 100),
        packCount: eia.readUInt16BE(44),
        cycles: eia.readUInt16BE(46),
        soc: eia.readUInt16BE(48) / 10,
        soh: eia.readUInt16BE(50) / 10,
        dischargeFet: !!(eic[7] & 1),
        chargeFet: !!(eic[7] & 2),
        limitFet: !!(eic[7] & 4),
        heater: !!(eic[7] & 8),
        problem: problemBits !== 0n,
        problemCode: problemBits.toString(16),
        statusHex: eic.toString('hex')
    };
}

export function decodePack(pack, pia, pib) {
    const mv = [];
    for (let i = 0; i < 16; i++) mv.push(pib.readUInt16BE(i * 2));
    const present = mv.map((v, i) => [v, i + 1]).filter(([v]) => v > 0);
    let min = present[0] || [0, 0];
    let max = present[0] || [0, 0];
    for (const c of present) {
        if (c[0] < min[0]) min = c;
        if (c[0] > max[0]) max = c;
    }
    return {
        pack,
        voltage: pia.readUInt16BE(0) / 100,
        current: pia.readInt16BE(2) / 100,
        remainingAh: pia.readUInt16BE(4) / 100,
        capacityAh: Math.floor(pia.readUInt16BE(6) / 100),
        soc: pia.readUInt16BE(10) / 10,
        soh: pia.readUInt16BE(12) / 10,
        cycles: pia.readUInt16BE(14),
        cells: mv.map((v) => (v > 0 ? v / 1000 : null)),
        cellMin: present.length ? min[0] / 1000 : null,
        cellMinNo: present.length ? min[1] : null,
        cellMax: present.length ? max[0] / 1000 : null,
        cellMaxNo: present.length ? max[1] : null,
        deltaMv: present.length ? max[0] - min[0] : null,
        cellTemps: [0, 1, 2, 3].map((i) => kelvin(pib.readUInt16BE(32 + i * 2))),
        ambient: kelvin(pib.readUInt16BE(48)),
        mosfet: kelvin(pib.readUInt16BE(50))
    };
}

export function summarise(packs, packCount) {
    const good = packs.filter((p) => !p.error && p.cellMin !== null);
    const s = { packsRead: good.length, packCount };
    if (!good.length) return s;
    let lo = null;
    let hi = null;
    for (const p of good) {
        p.cells.forEach((v, i) => {
            if (v === null) return;
            if (!lo || v < lo.v) lo = { v, at: `P${p.pack}C${i + 1}` };
            if (!hi || v > hi.v) hi = { v, at: `P${p.pack}C${i + 1}` };
        });
    }
    const temps = good.flatMap((p) => p.cellTemps).filter((t) => t !== null);
    s.cellMin = lo.v;
    s.cellMinAt = lo.at;
    s.cellMax = hi.v;
    s.cellMaxAt = hi.at;
    s.deltaMv = Math.round((hi.v - lo.v) * 1000);
    s.worstPackDeltaMv = Math.max(...good.map((p) => p.deltaMv));
    s.minCellTemp = temps.length ? Math.min(...temps) : null;
    s.maxCellTemp = temps.length ? Math.max(...temps) : null;
    return s;
}

// Balancing bits: pack status coils 0x1200 (144 bits). Cell c (1..16) balances when coil 0x28 + c - 1 is set:
// the bit map dbus-serialbattery's seplosv3.py uses (cells 1-8 at 0x28.., 9-16 at 0x30..). UNVERIFIED on a real
// pack: no recorded frame exists. A pack that does not answer is not asked again in this process.
const noBalancingAnswer = new Set();
export function decodeBalancing(coils) {
    const bit = (k) => !!(coils[k >> 3] & (1 << (k & 7)));
    const cells = [];
    for (let c = 1; c <= 16; c++) if (bit(0x28 + c - 1)) cells.push(c);
    return { cells, raw: coils.toString('hex'), source: 'GX driver bit map, unverified' };
}

// One full read over an open session: the system, then every pack. A pack that fails is reported, not fatal.
export async function readSeplosSession(session, options = {}) {
    const requester = createRequester(session, options);
    try {
        const [, sf, ss, sc] = BLOCKS.system;
        const [, tf, ts, tc] = BLOCKS.status;
        const eia = await requester.request(0, sf, ss, sc);
        const eic = await requester.request(0, tf, ts, tc);
        const system = decodeSystem(eia, eic);
        const packs = [];
        const n = Math.min(system.packCount || 1, 16);
        for (let p = 1; p <= n; p++) {
            try {
                const pia = await requester.request(p, BLOCKS.packTotals[1], BLOCKS.packTotals[2], BLOCKS.packTotals[3]);
                const pib = await requester.request(p, BLOCKS.packCells[1], BLOCKS.packCells[2], BLOCKS.packCells[3]);
                const pack = decodePack(p, pia, pib);
                pack.balancing = null;
                if (!noBalancingAnswer.has(p)) {
                    try {
                        pack.balancing = decodeBalancing(await requester.request(p, 0x01, 0x1200, 9));
                    } catch (error) {
                        noBalancingAnswer.add(p);
                    }
                }
                packs.push(pack);
            } catch (error) {
                packs.push({ pack: p, error: error.message });
            }
        }
        return { system, packs, summary: summarise(packs, system.packCount) };
    } finally {
        requester.close();
    }
}
