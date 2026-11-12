# node-red-contrib-seplos-ble

Node-RED nodes that read a **Seplos V3 BMS over Bluetooth**: the whole system and every pack (16 cell
voltages, 4 cell temperatures, MOSFET and ambient temperature, SoC, SoH, current, cycles, switches and
alarm bits). Made for a Victron GX (Venus OS Large) but works on any Linux with BlueZ.

Adapted from [node-red-contrib-sok](https://github.com/node-red-contrib/node-red-contrib-sok) 1.0.4 (MIT):
its BlueZ D-Bus layer and node structure are kept, the SOK protocol is replaced by the Seplos V3 one, and
the noble backend and CLI are removed, so the install has no native code.

- **Read-only.** It sends only Modbus read requests (functions 0x01 and 0x04) and never writes a register.
- **Connects, reads, disconnects** on each input by default, so the Seplos phone app can still connect between reads.
  Or tick **Keep connected** on the battery: the connection stays open (faster reads, reconnects by itself when it
  drops or stops answering); send `release` to a read node to free the dongle for the phone app for 10 minutes.
- **Runs as the `nodered` user** through BlueZ over D-Bus: no exec node, no raw HCI.

Tested on a Cerbo GX (Venus OS 3.85) with two Seplos V3 packs on one Bluetooth dongle: both packs read in
about 2.4 s, cell voltages add up to the pack voltages and the packs' Ah add up to the system figure.
Not affiliated with Seplos or Victron Energy.

## Install

Not on the npm registry. Over SSH on the GX:

```sh
cd /data/home/nodered/.node-red
npm install https://github.com/apostolionel91/node-red-contrib-seplos-ble/archive/refs/heads/main.tar.gz
```

then restart Node-RED. Or build a package file with `npm pack` in a copy of this repo and upload it in
Node-RED: Menu → Manage palette → Install → the upload button.

## Use

1. Drop a **Seplos read** node (category *Seplos*), add a battery: type the dongle's MAC, or press **Search**
   and pick it (close the Seplos phone app first).
2. Feed it from an inject node (e.g. every 60 s).
3. `msg.payload` = `{ ok, timestamp, device, system, packs[], summary }`. A failed read sends nothing and raises
   a node error naming the step (`find`, `connect`, `read`) and what to check.

On a multi-pack system, use the dongle on the master pack: device 0 answers for the system, devices 1..N
for each pack.

**Settings (read-only):** send `msg.payload = "settings"` to read the parameter block (input registers
0x1300–0x1369) of the system and each pack, plus each pack's model, firmware and serial (0x1700–0x1723).
Each named setting carries how sure its name is: `tested` (aiobmsble's limit table, checked against its recorded
frames), `driver` (dbus-serialbattery), `pattern` (the alarm / recovery / protection layout). The rest are listed
by register. Writing settings is not supported: Seplos says the alarm and protection values depend on each
other and should be changed with its own tools.

**Balancing:** each read also asks every pack for its status coils (0x1200, 144 bits); `packs[].balancing.cells` lists the cells whose bit is set, using the bit map of dbus-serialbattery's seplosv3.py (cells 1-8 at coils 0x28.., 9-16 at 0x30..). Not yet confirmed on a real pack. A pack that does not answer is not asked again.

## Protocol

Modbus RTU over the BLE service `fff0` (write `fff2`, notify `fff1`), CRC-16/Modbus little-endian.
System: input registers 0x2000 ×26 (totals) and coils 0x2200 ×80 (status). Each pack: 0x1000 ×17 (totals)
and 0x1100 ×26 (cells and temperatures). Register map and scaling after aiobmsble's `seplos_bms.py`
(https://github.com/patman15/aiobmsble, Apache-2.0), checked against the two-pack frames recorded in its tests.

## Examples

Import any of these in Node-RED (Menu → Import), then Deploy. Each battery node starts with an empty address,
which reads the first Seplos it finds; type yours or press **Search** to pick one.

- **[`examples/seplos-ble-example-flow.json`](examples/seplos-ble-example-flow.json)**: reads every 60 s and shows
  the reading in the debug sidebar.
- **[`examples/battery-page/`](examples/battery-page)**: a battery page served by Node-RED at `/seplos`
  (e.g. `https://venus.local:1881/seplos`). Import `seplos-battery-page-flow.json`. It shows:
  - every pack and cell, with balancing marks;
  - cell trends over 24 hours or 7 days;
  - state of charge, cell gap, power and voltage over time;
  - energy per day and time to full or empty;
  - the BMS settings (read-only) and a log of their changes;
  - alerts for high or low cells, cell gap, cold, BMS blocks and stale readings.

  The alerts leave through the link node "Seplos alerts", ready for a Pushover node (`msg.topic`,
  `msg.payload`, `msg.priority`). Solar, grid and load figures come from the Victron nodes
  (`node-red-contrib-victron`, part of Venus OS Large). History is kept for 7 days and saved to
  `/data/home/nodered/seplos/history.json` every 30 minutes.

  The page source is `seplos-page.html` and the function nodes are in `fn/`; rebuild the flow with
  `node examples/battery-page/build-page-flow.mjs`, which also writes `preview.html` with made-up data.
- **[`examples/gx-health/`](examples/gx-health)**: not about Seplos. A small flow that checks a Victron GX once a
  minute. It reports, in plain words under the node:
  - processor use and the three busiest programs;
  - free memory and Node-RED's share of it;
  - CPU temperature;
  - storage use.

  Alerts go to the link node "GX alerts".

## Tests

```sh
npm test
```

This runs the package against a fake BlueZ that answers with the Seplos V3 replies recorded in aiobmsble's tests
(`test/frames.json`), then the page's function nodes over 26 simulated hours, then the GX health function.
No Bluetooth or GX is needed.

## Credits and licence

MIT, see [LICENSE](LICENSE). Built on node-red-contrib-sok (MIT). The Seplos V3 register map follows
[aiobmsble](https://github.com/patman15/aiobmsble) (Apache-2.0), whose recorded replies are in `test/frames.json`;
no aiobmsble code is included. The balancing bit map comes from dbus-serialbattery's `seplosv3.py`.
