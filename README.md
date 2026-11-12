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

## What you need

- A Victron GX device with Bluetooth, for example a Cerbo GX, running **Venus OS Large** with **Node-RED switched
  on**. In the GX menu: Settings → Venus OS Large → Node-RED (newer firmware: Settings → Integrations → Venus OS
  Large). Switching it on needs the installer access level.
- The Seplos **Bluetooth dongle** plugged into the master pack, within Bluetooth range of the GX.
- **Internet on the GX** while you install: Node-RED downloads one small library (`dbus-next`).
- The Node-RED editor open in a browser on the same network: **https://venus.local:1881**, or `https://` + the GX's
  IP address + `:1881`. The first time, the browser warns about the certificate: choose Advanced, then Continue.

## Install: choose one way

### Way 1: upload it in Node-RED (easiest, no command line)

1. Download the package file **[node-red-contrib-seplos-ble-1.3.0.tgz](https://github.com/apostolionel91/node-red-contrib-seplos-ble/raw/main/packages/node-red-contrib-seplos-ble-1.3.0.tgz)**.
   Keep it as it is: don't unpack it.
2. In Node-RED, open the menu (☰, top right) → **Manage palette** → the **Install** tab.
3. Press the **upload** button (an arrow pointing up, at the top right of the Install tab), choose the `.tgz` file
   you downloaded, then press **Upload**.
4. Wait for the message that the nodes were added. A new group, **Seplos**, appears in the node list on the left.

No upload button? Your Node-RED has uploads turned off: use Way 2.

### Way 2: the command line (SSH)

1. Turn on SSH on the GX (once). In the GX menu or the Remote Console:
   - Settings → General → **Access level**: set it to *Superuser*. Highlight the line without opening it and hold
     the right arrow (or the right key on your keyboard in the Remote Console) until it changes. On the new
     interface, drag the Access & Security list down and hold it for 5 seconds.
   - Settings → General → **Set root password**.
   - Settings → General → **SSH on LAN**: on.

   Victron's guide with pictures: [Root access](https://www.victronenergy.com/live/ccgx:root_access).
2. On your computer, open a terminal (Windows: PowerShell; Mac: Terminal) and log in to the GX, using its IP
   address. Type `yes` if it asks about the key, then the root password (nothing shows while you type it).

   ```sh
   ssh root@192.168.1.23
   ```
3. Paste these three lines. Warnings such as `npm WARN deprecated` are normal.

   ```sh
   cd /data/home/nodered/.node-red
   npm install https://github.com/apostolionel91/node-red-contrib-seplos-ble/raw/main/packages/node-red-contrib-seplos-ble-1.3.0.tgz
   svc -t /service/node-red-venus
   ```

   The last line restarts Node-RED; reload the editor in your browser after a minute.

## Get your first reading

1. Open the example flow **[seplos-ble-example-flow.json](examples/seplos-ble-example-flow.json)** here on GitHub
   and press the **Copy raw file** button (top right of the file).
2. In Node-RED: menu (☰) → **Import** → paste → **Import**.
3. Double-click the **Seplos read** node, then the pencil next to **Battery**. Close the Seplos app on your phone
   first (the dongle takes one connection at a time), press **Search** and pick your battery in the **Found**
   list: its name starts with `SP`. Press **Update**, then **Done**. (Left empty, the node reads the first Seplos
   it finds.)
4. Press **Deploy** (top right).
5. Open the **Debug** tab (the bug icon on the right). A reading appears every 60 seconds: open it to see every
   pack and cell.

## The battery page

A page with every pack and cell, cell trends, history charts, energy per day, the BMS settings and alerts,
served by Node-RED at **https://venus.local:1881/seplos**.

1. Import **[seplos-battery-page-flow.json](examples/battery-page/seplos-battery-page-flow.json)** the same way
   (Copy raw file → Import → paste). If you imported the first example, delete that flow first: two flows reading
   one dongle get in each other's way.
2. Pick your battery in the **Seplos** configuration node as above, then **Deploy**.
3. Open https://venus.local:1881/seplos (or your GX's IP address with `:1881/seplos`).

More about the page under [Examples](#examples).

## Update or remove

- **Update**: install the new version the same way (Way 1 or Way 2), then restart Node-RED: in the GX menu
  switch Node-RED off and on again, or run `svc -t /service/node-red-venus` over SSH.
- **Remove**: delete the flows that use the Seplos nodes and Deploy, then menu (☰) → Manage palette →
  the **Nodes** tab → node-red-contrib-seplos-ble → **remove**.

## If it doesn't work

A failed read sends nothing and shows an error under the node (and in the Debug tab), naming the step that failed:

- **find, "dongle not heard"**: close the Seplos phone app (a connected dongle stops advertising), check that the
  dongle is plugged in and close enough to the GX, and that Bluetooth is on in the GX menu.
- **connect**: something else holds the dongle, usually the phone app or a second flow reading the same battery.
- **"no Seplos V3 service"**: the address belongs to another Bluetooth device; press Search and pick the one
  starting with `SP`.
- **read, "did not answer like a Seplos V3"**: connected, but the BMS did not reply as a Seplos V3 does. Check that
  the dongle sits on the master pack.

## How it works

1. A **Seplos read** node reads the battery each time a message arrives (feed it from an inject node).
2. `msg.payload` = `{ ok, timestamp, device, system, packs[], summary }`.

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

- **[`examples/seplos-ble-example-flow.json`](examples/seplos-ble-example-flow.json)**: reads every 60 s and shows
  the reading in the debug sidebar.
- **[`examples/battery-page/`](examples/battery-page)**: the battery page at `/seplos`. It shows:
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

  Alerts go to the link node "GX alerts". Import [gx-health-flow.json](examples/gx-health/gx-health-flow.json) the
  same way; it needs no extra nodes.

## Tests

```sh
npm test
```

This runs the package against a fake BlueZ that answers with the Seplos V3 replies recorded in aiobmsble's tests
(`test/frames.json`), then the page's function nodes over 26 simulated hours, then the GX health function.
No Bluetooth or GX is needed. `npm run pack` rebuilds the package file in `packages/`.

## Credits and licence

MIT, see [LICENSE](LICENSE). Built on node-red-contrib-sok (MIT). The Seplos V3 register map follows
[aiobmsble](https://github.com/patman15/aiobmsble) (Apache-2.0), whose recorded replies are in `test/frames.json`;
no aiobmsble code is included. The balancing bit map comes from dbus-serialbattery's `seplosv3.py`.
