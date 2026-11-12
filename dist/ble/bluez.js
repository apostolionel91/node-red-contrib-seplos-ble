// BlueZ (D-Bus) backend, adapted from node-red-contrib-sok 1.0.4 (MIT, Copyright (c) 2025 node-red-contrib).
// Changes for Seplos V3: Seplos constants and matching, targeting by MAC address, sharing a discovery that is
// already running (InProgress) instead of failing, disconnecting the device when set-up fails after Connect(),
// and a write queue that a failed write no longer poisons.
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { SEPLOS } from '../constants.js';
import { errorMessage, formatCanonicalUuid, matchesSeplosDevice, normalizeAddress, normalizeUuid, nullableNumber, nullableString, unboxBluezValue, uniqueDevices } from './utils.js';

const requireOptional = createRequire(import.meta.url);
const DISCOVERY_POLL_MS = 500;
let activeSessions = new Set();

export const bluezBackend = {
    name: 'bluez',
    isAvailable: isBluezAvailable,
    discover: discoverBluezDevices,
    connect: connectBluezDevice,
    shutdown: shutdownBluez
};

async function isBluezAvailable(logger = () => { }) {
    if (process.platform !== 'linux')
        return false;
    try {
        const { systemBus } = loadDbusNext();
        const bus = systemBus();
        try {
            const object = await bus.getProxyObject('org.bluez', '/');
            const objectManager = object.getInterface('org.freedesktop.DBus.ObjectManager');
            const objects = await objectManager.GetManagedObjects();
            return findBluezAdapterPath(objects) !== null;
        }
        finally {
            bus.disconnect();
        }
    }
    catch (error) {
        logger(`BlueZ backend is not available: ${errorMessage(error)}.`);
        return false;
    }
}

// options: { address, deviceName, includeService, forceScan, timeoutMs, scanServiceUuid, logger }
async function discoverBluezDevices(options) {
    if (process.platform !== 'linux')
        throw new Error('BlueZ backend is only available on Linux.');
    const logger = options.logger || (() => { });
    const targeted = !!(normalizeAddress(options.address) || options.deviceName);
    const { systemBus, Variant } = loadDbusNext();
    const bus = systemBus();
    try {
        const { objectManager, adapter } = await openBluezAdapter(bus);
        if (targeted && !options.forceScan) {
            const cachedMatches = uniqueDevices(findBluezDevices(await objectManager.GetManagedObjects(), options));
            if (cachedMatches.length > 0) {
                logger(`BlueZ already knows ${cachedMatches[0].address || cachedMatches[0].name}.`);
                return cachedMatches;
            }
        }
        const canonicalScanServiceUuid = options.scanServiceUuid ? formatCanonicalUuid(options.scanServiceUuid) : null;
        await setBluezDiscoveryFilter(adapter, Variant, canonicalScanServiceUuid, logger);
        let weStarted = false;
        try {
            await adapter.StartDiscovery();
            weStarted = true;
            logger(`BlueZ discovery started. Waiting up to ${options.timeoutMs}ms.`);
        }
        catch (error) {
            // another client (e.g. the GX itself) is already scanning: share its scan, and leave it running
            if (!/inprogress|in progress/i.test(errorMessage(error)))
                throw error;
            logger('BlueZ discovery already running; sharing it.');
        }
        const devices = [];
        const startedAt = Date.now();
        try {
            while (Date.now() - startedAt < options.timeoutMs) {
                const objects = await objectManager.GetManagedObjects();
                devices.push(...findBluezDevices(objects, options).filter((d) => d.rssi !== null));
                if (targeted && devices.length > 0)
                    break;
                await delay(DISCOVERY_POLL_MS);
            }
        }
        finally {
            if (weStarted)
                await adapter.StopDiscovery().catch((error) => logger(`Warning: could not stop BlueZ discovery: ${errorMessage(error)}.`));
        }
        return uniqueDevices(devices);
    }
    finally {
        bus.disconnect();
    }
}

async function connectBluezDevice({ device, timeoutMs, connectTimeoutMs, logger = () => { } }) {
    if (process.platform !== 'linux')
        throw new Error('BlueZ backend is only available on Linux.');
    const { systemBus } = loadDbusNext();
    const bus = systemBus();
    let bluezDevice = null;
    let connectedByUs = false;
    try {
        const objectManagerObject = await bus.getProxyObject('org.bluez', '/');
        const objectManager = objectManagerObject.getInterface('org.freedesktop.DBus.ObjectManager');
        let objects = await objectManager.GetManagedObjects();
        let target = findBluezDeviceByDiscovered(objects, device);
        if (!target) {
            const matches = await discoverBluezDevices({
                address: device.address,
                deviceName: device.address ? null : device.name,
                forceScan: true,
                timeoutMs,
                logger
            });
            if (!matches.length)
                throw new Error(`Could not rediscover ${device.address || device.name || device.id}.`);
            objects = await objectManager.GetManagedObjects();
            target = findBluezDeviceByDiscovered(objects, matches[0]);
        }
        if (!target)
            throw new Error(`Could not find ${device.address || device.name || device.id} in BlueZ managed objects.`);
        logger(`BlueZ connecting to ${target.address || '<unknown address>'} at ${target.path}.`);
        const deviceObject = await bus.getProxyObject('org.bluez', target.path);
        bluezDevice = deviceObject.getInterface('org.bluez.Device1');
        const deviceProperties = deviceObject.getInterface('org.freedesktop.DBus.Properties');
        if (!(await getBluezBoolean(deviceProperties, 'org.bluez.Device1', 'Connected'))) {
            connectedByUs = true;
            await withTimeout(bluezDevice.Connect(), connectTimeoutMs, 'BlueZ Device1.Connect()');
        }
        await waitForBluezBooleanProperty(deviceProperties, 'org.bluez.Device1', 'ServicesResolved', true, timeoutMs);
        logger('BlueZ connected and services resolved.');
        const refreshedObjects = await objectManager.GetManagedObjects();
        const characteristics = await buildBluezCharacteristics({ bus, objects: refreshedObjects, devicePath: target.path, logger });
        await characteristics.notify.subscribe();
        logger('Subscribed to Seplos notification characteristic fff1.');
        const session = {
            device: toDiscoveredDevice(target.path, refreshedObjects[target.path]?.['org.bluez.Device1'] || {}, 'bluez'),
            notify: characteristics.notify,
            write: characteristics.write,
            isConnected: async () => (await getBluezBoolean(deviceProperties, 'org.bluez.Device1', 'Connected')) === true,
            disconnect: async () => {
                activeSessions.delete(session);
                await bluezDevice.Disconnect().catch(() => { });
                bus.disconnect();
            }
        };
        activeSessions.add(session);
        return session;
    }
    catch (error) {
        // a connection we opened must not stay open: the dongle takes one connection at a time
        if (bluezDevice && connectedByUs)
            await bluezDevice.Disconnect().catch(() => { });
        bus.disconnect();
        throw error;
    }
}

async function openBluezAdapter(bus) {
    const objectManagerObject = await bus.getProxyObject('org.bluez', '/');
    const objectManager = objectManagerObject.getInterface('org.freedesktop.DBus.ObjectManager');
    const objects = await objectManager.GetManagedObjects();
    const adapterPath = findBluezAdapterPath(objects);
    if (!adapterPath)
        throw new Error('Could not find a BlueZ adapter via org.bluez ObjectManager.');
    const adapterObject = await bus.getProxyObject('org.bluez', adapterPath);
    const adapter = adapterObject.getInterface('org.bluez.Adapter1');
    return { objectManager, adapter, adapterPath };
}

async function buildBluezCharacteristics({ bus, objects, devicePath, logger }) {
    const byUuid = new Map();
    for (const [path, interfaces] of Object.entries(objects)) {
        if (!path.startsWith(`${devicePath}/`))
            continue;
        const characteristic = interfaces['org.bluez.GattCharacteristic1'];
        if (!characteristic)
            continue;
        const uuid = nullableString(unboxBluezValue(characteristic.UUID));
        if (!uuid)
            continue;
        byUuid.set(normalizeUuid(uuid), { path, properties: characteristic });
    }
    logger(`BlueZ discovered ${byUuid.size} GATT characteristic(s): ${[...byUuid.keys()].sort().join(', ')}.`);
    const notify = byUuid.get(SEPLOS.notifyUuid);
    const write = byUuid.get(SEPLOS.writeUuid);
    if (!notify || !write) {
        throw new Error(`This device has no Seplos V3 service (fff1/fff2). Found: ${[...byUuid.keys()].sort().join(', ') || 'none'}`);
    }
    return {
        notify: await wrapBluezCharacteristic(bus, notify.path, notify.properties),
        write: await wrapBluezCharacteristic(bus, write.path, write.properties)
    };
}

async function wrapBluezCharacteristic(bus, path, initialProperties) {
    const object = await bus.getProxyObject('org.bluez', path);
    const characteristic = object.getInterface('org.bluez.GattCharacteristic1');
    const properties = object.getInterface('org.freedesktop.DBus.Properties');
    const listeners = new Set();
    const flags = Array.isArray(unboxBluezValue(initialProperties.Flags)) ? unboxBluezValue(initialProperties.Flags).map(String) : [];
    let writeQueue = Promise.resolve();
    const onPropertiesChanged = (interfaceName, changed) => {
        if (interfaceName !== 'org.bluez.GattCharacteristic1' || !('Value' in changed))
            return;
        const value = Buffer.from(unboxBluezValue(changed.Value) || []);
        for (const listener of listeners)
            listener(value);
    };
    properties.on('PropertiesChanged', onPropertiesChanged);
    return {
        uuid: normalizeUuid(String(unboxBluezValue(initialProperties.UUID) || '')),
        properties: flags,
        async write(data, withoutResponse = false) {
            const options = withoutResponse ? { type: new (loadDbusNext().Variant)('s', 'command') } : {};
            // a failed write must not poison the queue (in the SOK original every later write re-threw it)
            const run = writeQueue.catch(() => { }).then(() => writeBluezValueWithRetry(characteristic, [...data], options));
            writeQueue = run;
            await run;
        },
        async subscribe() {
            await characteristic.StartNotify();
        },
        onData(listener) {
            listeners.add(listener);
        },
        removeDataListener(listener) {
            listeners.delete(listener);
        }
    };
}

function findBluezAdapterPath(objects) {
    for (const [path, interfaces] of Object.entries(objects)) {
        if (interfaces['org.bluez.Adapter1'])
            return path;
    }
    return null;
}

function findBluezDevices(objects, options) {
    const devices = [];
    for (const [path, interfaces] of Object.entries(objects)) {
        const device = interfaces['org.bluez.Device1'];
        if (!device)
            continue;
        const uuids = readBluezUuids(device);
        const discovered = toDiscoveredDevice(path, device, 'bluez');
        if (matchesSeplosDevice({ name: discovered.name, address: discovered.address, serviceUuids: uuids }, options))
            devices.push({ ...discovered, serviceUuids: uuids.map(normalizeUuid) });
    }
    return devices;
}

function findBluezDeviceByDiscovered(objects, selected) {
    const wanted = normalizeAddress(selected.address);
    for (const [path, interfaces] of Object.entries(objects)) {
        const device = interfaces['org.bluez.Device1'];
        if (!device)
            continue;
        const discovered = toDiscoveredDevice(path, device, 'bluez');
        if (selected.id === path || (wanted && wanted === normalizeAddress(discovered.address)) || (!wanted && !!selected.name && selected.name === discovered.name)) {
            return { path, address: discovered.address };
        }
    }
    return null;
}

function toDiscoveredDevice(path, device, backend) {
    const name = nullableString(unboxBluezValue(device.Name)) || nullableString(unboxBluezValue(device.Alias));
    return {
        id: path,
        address: nullableString(unboxBluezValue(device.Address)),
        name: name ? name.trim() : null,
        rssi: nullableNumber(unboxBluezValue(device.RSSI)),
        backend
    };
}

function readBluezUuids(device) {
    const value = unboxBluezValue(device.UUIDs);
    return Array.isArray(value) ? value.map((uuid) => String(uuid)) : [];
}

export async function setBluezDiscoveryFilter(adapter, Variant, serviceUuid, logger) {
    const filter = {
        Transport: new Variant('s', 'le'),
        DuplicateData: new Variant('b', false)
    };
    if (serviceUuid)
        filter.UUIDs = new Variant('as', [serviceUuid]);
    await adapter.SetDiscoveryFilter(filter)
        .catch((error) => logger(`Warning: could not set BlueZ discovery filter: ${errorMessage(error)}.`));
}

async function getBluezBoolean(properties, interfaceName, propertyName) {
    const value = await properties.Get(interfaceName, propertyName).catch(() => null);
    const unboxed = unboxBluezValue(value);
    return typeof unboxed === 'boolean' ? unboxed : null;
}

async function waitForBluezBooleanProperty(properties, interfaceName, propertyName, expected, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if ((await getBluezBoolean(properties, interfaceName, propertyName)) === expected)
            return;
        await delay(250);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for BlueZ ${propertyName}=${expected}.`);
}

async function writeBluezValueWithRetry(characteristic, value, options) {
    let lastError;
    for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
            await characteristic.WriteValue(value, options);
            return;
        }
        catch (error) {
            lastError = error;
            if (!/inprogress|in progress/i.test(errorMessage(error)))
                throw error;
            await delay(80);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms during ${label}.`)), timeoutMs);
        promise.then((value) => {
            clearTimeout(timeout);
            resolve(value);
        }, (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}

async function shutdownBluez() {
    const sessions = [...activeSessions];
    activeSessions = new Set();
    await Promise.all(sessions.map((session) => session.disconnect().catch(() => { })));
}

function loadDbusNext() {
    try {
        return requireOptional('dbus-next');
    }
    catch (error) {
        throw new Error(`BlueZ backend requires the "dbus-next" dependency. Run npm install. ${errorMessage(error)}`);
    }
}
