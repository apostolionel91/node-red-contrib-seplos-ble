'use strict';
// Config node: which Seplos V3 dongle to read (by MAC), one read at a time, and whether to keep the
// Bluetooth connection open between reads. Structure after node-red-contrib-sok 1.0.4 (MIT, (c) 2025 node-red-contrib).

module.exports = function registerSeplosBatteryDeviceNode(RED) {
  const loadLibrary = async () => import('../dist/index.js');

  function SeplosBatteryDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.address = String(config.address || '').trim().toUpperCase();
    node.deviceName = String(config.deviceName || '').trim();
    node.keepConnected = config.keepConnected === true || config.keepConnected === 'true';
    node.queue = Promise.resolve();
    node.pending = 0;
    node.pausedUntil = 0; // set by a "release" message: no reads, so the phone app can connect
    node.keeper = null;
    node.loadLibrary = loadLibrary;

    node.enqueue = (operation) => {
      node.pending += 1;
      const run = node.queue.then(async () => operation(await node.loadLibrary()));
      node.queue = run.then(() => {}, () => {}).then(() => { node.pending -= 1; });
      return run;
    };

    // one read (kind 'reading' or 'settings'), through the kept connection or a fresh one
    node.read = (options, kind = 'reading') => node.enqueue(async (lib) => {
      if (!node.keepConnected) return kind === 'settings' ? lib.readSettings(options) : lib.readBattery(options);
      const wanted = lib.normalizeAddress(options.address);
      if (node.keeper && node.keeper.address !== wanted) {
        await node.keeper.close();
        node.keeper = null;
      }
      if (!node.keeper) node.keeper = lib.createKeeper(options);
      return kind === 'settings' ? node.keeper.readSettings() : node.keeper.read();
    });

    // disconnect now (release for the phone app); the next read connects again
    node.release = () => node.enqueue(async () => {
      if (node.keeper) {
        await node.keeper.close();
        node.keeper = null;
      }
    });

    node.on('close', (_removed, done) => {
      const k = node.keeper;
      node.keeper = null;
      Promise.resolve(k && k.close())
        .then(() => node.loadLibrary())
        .then((lib) => lib.shutdownBluetooth())
        .catch(() => {})
        .finally(done);
    });
  }

  RED.nodes.registerType('seplos-battery-device', SeplosBatteryDeviceNode);

  // The editor's Search button: list nearby Seplos-named and FFF0 devices.
  const permission = RED.auth?.needsPermission ? RED.auth.needsPermission('flows.read') : (_req, _res, next) => next();
  RED.httpAdmin.get('/seplos-battery/devices', permission, async (_req, res) => {
    try {
      const lib = await loadLibrary();
      const devices = await lib.discoverBatteries({ includeService: true, timeoutMs: 10000 });
      res.json(devices.map((d) => ({
        address: d.address,
        name: d.name,
        rssi: d.rssi,
        seplosName: lib.hasSeplosName(d.name)
      })));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
};
