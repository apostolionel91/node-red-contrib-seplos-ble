import { SEPLOS } from '../constants.js';

export function normalizeUuid(uuid) {
    const compact = String(uuid || '').toLowerCase().replaceAll('-', '');
    if (compact.length === 32 && compact.startsWith('0000') && compact.endsWith('00001000800000805f9b34fb'))
        return compact.slice(4, 8);
    return compact;
}
export function formatCanonicalUuid(uuid) {
    const compact = normalizeUuid(uuid);
    if (compact.length === 4)
        return `0000${compact}-0000-1000-8000-00805f9b34fb`;
    if (compact.length !== 32)
        return uuid.toLowerCase();
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}
export function normalizeAddress(address) {
    const a = String(address || '').trim().toUpperCase().replaceAll('-', ':');
    return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(a) ? a : null;
}
export function hasSeplosName(name) {
    const n = String(name || '').trim(); // some dongles pad the name with spaces
    return SEPLOS.namePatterns.some((re) => re.test(n));
}
export function hasSeplosService(serviceUuids) {
    return (serviceUuids || []).some((uuid) => normalizeUuid(uuid) === SEPLOS.serviceUuid);
}
// A fixed MAC wins; then a fixed name; else any device with a Seplos name
// (or, for the editor's search list, any device advertising the FFF0 service).
export function matchesSeplosDevice(candidate, { address = null, deviceName = null, includeService = false } = {}) {
    const wanted = normalizeAddress(address);
    if (wanted)
        return normalizeAddress(candidate.address) === wanted;
    const name = String(candidate.name || '').trim();
    if (deviceName)
        return name === String(deviceName).trim();
    if (hasSeplosName(name))
        return true;
    return includeService && hasSeplosService(candidate.serviceUuids);
}
export function uniqueDevices(devices) {
    const byKey = new Map();
    for (const device of devices) {
        const key = device.address || device.name || `${device.backend}:${device.id}`;
        const existing = byKey.get(key);
        if (!existing || (device.rssi ?? -999) > (existing.rssi ?? -999))
            byKey.set(key, device);
    }
    return [...byKey.values()].sort((left, right) => (right.rssi ?? -999) - (left.rssi ?? -999));
}
export function displayDevice(device) {
    return [device.name, device.address].filter(Boolean).join(' ') || device.id;
}
export function nullableString(value) {
    return typeof value === 'string' && value ? value : null;
}
export function nullableNumber(value) {
    return typeof value === 'number' ? value : null;
}
export function unboxBluezValue(value) {
    if (value && typeof value === 'object' && 'value' in value)
        return value.value;
    return value;
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
