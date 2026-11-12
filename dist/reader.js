// Find the dongle, connect, read the system and every pack.
// readBattery(): connect, read, disconnect (the phone app can connect between reads).
// createKeeper(): keep the connection open between reads; reconnect when it drops or stops answering.
import { bluezBackend } from './ble/bluez.js';
import { readSeplosSession } from './seplos.js';
import { readSeplosSettings } from './settings.js';
import { errorMessage, normalizeAddress } from './ble/utils.js';

const DEFAULT_SCAN_MS = 10000;
const DEFAULT_CONNECT_TIMEOUT_MS = 12000;
const DEFAULT_READ_TIMEOUT_MS = 45000;

export const HINTS = {
    notHeard: 'The dongle was not heard. Close the Seplos phone app (a connected dongle stops advertising) and check '
        + 'the GX is in range. If "Bluetooth sensors" is on in the GX menu, try once with it off.',
    connect: 'Could not connect. Close the Seplos phone app: the dongle takes one connection at a time.',
    notSeplos: 'This device has no Seplos V3 service (FFF1/FFF2). Is the MAC right?',
    noReply: 'Connected, but the BMS did not answer like a Seplos V3.'
};

function hinted(message, hint, stage) {
    const error = new Error(message);
    error.hint = hint;
    error.stage = stage;
    return error;
}

function settings(options) {
    return {
        logger: options.logger || (() => { }),
        readTimeoutMs: options.readTimeoutMs || DEFAULT_READ_TIMEOUT_MS,
        scanMs: options.scanMs || DEFAULT_SCAN_MS,
        connectTimeoutMs: options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS,
        replyWaitsMs: options.replyWaitsMs,
        target: { address: options.address || null, deviceName: options.deviceName || null }
    };
}

// Lists devices: by MAC or name if given, else Seplos-named ones (and, with includeService, any FFF0 device).
export async function discoverBatteries(options = {}) {
    return bluezBackend.discover({
        address: options.address || null,
        deviceName: options.deviceName || null,
        includeService: !!options.includeService,
        forceScan: !!options.forceScan,
        timeoutMs: options.timeoutMs || DEFAULT_SCAN_MS,
        logger: options.logger || (() => { })
    });
}

// Find and connect; one fresh scan and a second try when the first connect fails. Returns { session, found }.
async function connectFresh(s, progress) {
    const connect = (device) => bluezBackend.connect({ device, timeoutMs: s.scanMs, connectTimeoutMs: s.connectTimeoutMs, logger: s.logger });
    progress.stage = 'find';
    let devices = await discoverBatteries({ ...s.target, timeoutMs: s.scanMs, logger: s.logger });
    if (!devices.length) throw hinted('dongle not heard', HINTS.notHeard, 'find');
    progress.stage = 'connect';
    try {
        return { session: await connect(devices[0]), found: devices[0] };
    } catch (error) {
        if (/no Seplos V3 service/.test(errorMessage(error))) throw hinted(errorMessage(error), HINTS.notSeplos, 'connect');
        if (progress.timedOut) throw error;
        s.logger(`Connect failed (${errorMessage(error)}); scanning once and trying again.`);
        progress.stage = 'find';
        devices = await discoverBatteries({ ...s.target, forceScan: true, timeoutMs: s.scanMs, logger: s.logger });
        if (!devices.length) throw hinted('dongle not heard', HINTS.notHeard, 'find');
        progress.stage = 'connect';
        try {
            return { session: await connect(devices[0]), found: devices[0] };
        } catch (error2) {
            const msg = errorMessage(error2);
            throw hinted(msg, /no Seplos V3 service/.test(msg) ? HINTS.notSeplos : HINTS.connect, 'connect');
        }
    }
}

function reading(session, found, data, t0, extra) {
    const device = session.device || found;
    return {
        ok: true,
        timestamp: new Date().toISOString(),
        device: { address: device.address || found.address, name: device.name || found.name, rssi: found.rssi },
        ...data,
        ...extra,
        ms: Date.now() - t0
    };
}

// Runs work(progress) with a watchdog; onTimeout cleans up. A late failure after the watchdog stays handled.
async function guarded(s, work, onTimeout) {
    const progress = { stage: 'find', timedOut: false };
    const job = work(progress);
    let timer;
    const watchdog = new Promise((_, reject) => {
        timer = setTimeout(() => {
            progress.timedOut = true;
            reject(hinted(`gave up after ${s.readTimeoutMs / 1000} s`, HINTS.connect, progress.stage));
        }, s.readTimeoutMs);
    });
    try {
        return await Promise.race([job, watchdog]);
    } catch (error) {
        if (progress.timedOut) await onTimeout();
        throw error;
    } finally {
        clearTimeout(timer);
        job.catch(() => { });
    }
}

// Connect, run one read operation, disconnect.
async function runOnce(options, op, extra) {
    const s = settings(options);
    const t0 = Date.now();
    let session = null;
    let closed = false;
    const close = async () => {
        if (closed || !session) return;
        closed = true;
        await session.disconnect().catch(() => { });
    };
    try {
        return await guarded(s, async (progress) => {
            const c = await connectFresh(s, progress);
            session = c.session;
            if (progress.timedOut) { await close(); throw hinted('gave up', HINTS.connect, progress.stage); }
            progress.stage = 'read';
            let data;
            try {
                data = await op(session, { replyWaitsMs: s.replyWaitsMs, logger: s.logger });
            } catch (error) {
                throw hinted(errorMessage(error), HINTS.noReply, 'read');
            }
            return reading(session, c.found, data, t0, { ...extra, kept: false });
        }, close);
    } finally {
        await close();
    }
}

// One reading: { ok, timestamp, device, system, packs[], summary, ms }. Throws an Error with .stage and .hint.
export const readBattery = (options = {}) => runOnce(options, readSeplosSession, {});
// The settings (read-only): { ok, timestamp, device, kind: 'settings', system, packs[{ pack, info, settings }] }.
export const readSettings = (options = {}) => runOnce(options, readSeplosSettings, { kind: 'settings' });

// Keeps one connection open across reads. read() reuses it; when it has dropped or stops answering,
// read() reconnects once and tries again. close() disconnects (call it on redeploy, or to free the
// dongle for the phone app).
export function createKeeper(options = {}) {
    const s = settings(options);
    let current = null; // { session, found }
    const address = normalizeAddress(options.address);

    async function close() {
        const c = current;
        current = null;
        if (c) await c.session.disconnect().catch(() => { });
    }

    async function run(op, extra) {
        const t0 = Date.now();
        return guarded(s, async (progress) => {
            let reused = !!current;
            if (current && !(await current.session.isConnected().catch(() => false))) {
                s.logger('The kept connection has dropped; reconnecting.');
                await close();
                reused = false;
            }
            if (!current) {
                current = await connectFresh(s, progress);
                if (progress.timedOut) { await close(); throw hinted('gave up', HINTS.connect, progress.stage); }
            }
            progress.stage = 'read';
            try {
                const data = await op(current.session, { replyWaitsMs: s.replyWaitsMs, logger: s.logger });
                return reading(current.session, current.found, data, t0, { ...extra, kept: true, reused });
            } catch (error) {
                await close();
                if (!reused || progress.timedOut) throw hinted(errorMessage(error), HINTS.noReply, 'read');
                s.logger(`The kept connection stopped answering (${errorMessage(error)}); reconnecting once.`);
                current = await connectFresh(s, progress);
                if (progress.timedOut) { await close(); throw hinted('gave up', HINTS.connect, progress.stage); }
                progress.stage = 'read';
                try {
                    const data = await op(current.session, { replyWaitsMs: s.replyWaitsMs, logger: s.logger });
                    return reading(current.session, current.found, data, t0, { ...extra, kept: true, reused: false });
                } catch (error2) {
                    await close();
                    throw hinted(errorMessage(error2), HINTS.noReply, 'read');
                }
            }
        }, close);
    }

    return {
        read: () => run(readSeplosSession, {}),
        readSettings: () => run(readSeplosSettings, { kind: 'settings' }),
        close,
        address,
        get connected() { return !!current; }
    };
}

export async function shutdownBluetooth() {
    await bluezBackend.shutdown();
}
