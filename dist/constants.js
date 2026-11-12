// Seplos V3 BLE dongle: Modbus RTU over a BLE UART service.
// Names and UUIDs after aiobmsble seplos_bms.py (Apache-2.0, https://github.com/patman15/aiobmsble).
export const SEPLOS = {
    serviceUuid: 'fff0',
    notifyUuid: 'fff1',
    writeUuid: 'fff2',
    // advertised names seen on Seplos V3 dongles (aiobmsble matcher: SP??B*, SP1??B*, XZHX*, CSY*)
    namePatterns: [/^SP..B/, /^SP1..B/, /^XZHX/, /^CSY/]
};

// Register blocks: [device, Modbus function, first register, count].
// Device 0 = the whole system (all packs together), 1..16 = one pack.
export const BLOCKS = {
    system: [0x00, 0x04, 0x2000, 0x1a], // EIA: totals, SoC, SoH, pack count
    status: [0x00, 0x01, 0x2200, 0x05], // EIC: 80 status bits (switches, alarms)
    packTotals: [null, 0x04, 0x1000, 0x11], // PIA: one pack's totals
    packCells: [null, 0x04, 0x1100, 0x1a] // PIB: 16 cells, 4 cell temperatures, ambient, MOSFET
};
