'use strict';
// Reads a Seplos V3 BMS once per input message: msg.payload = { ok, timestamp, device, system, packs[], summary }.
// Read-only: it sends only Modbus read requests. A failed read sends nothing and raises a node error (Catch node).
// msg.payload "release" (or { release: minutes }) disconnects and pauses reads (default 10 min) so the phone app
// can connect; "resume" ends the pause.

module.exports = function registerSeplosBatteryGetNode(RED) {
  function SeplosBatteryGetNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.device = RED.nodes.getNode(config.device);

    node.on('input', async (msg, send, done) => {
      const emit = send || ((m) => node.send(m));
      const finish = done || ((err) => { if (err) node.error(err, msg); });
      const dev = node.device;
      if (!dev) {
        finish(new Error('No Seplos battery configured on this node.'));
        return;
      }
      const p = msg.payload;
      const releaseMin = p === 'release' ? 10 : (p && typeof p === 'object' && p.release !== undefined ? Number(p.release) || 10 : 0);
      if (releaseMin > 0) {
        dev.pausedUntil = Date.now() + releaseMin * 60000;
        try { await dev.release(); } catch (e) { /* best effort */ }
        node.status({ fill: 'grey', shape: 'ring', text: 'released for the phone app until ' + hhmm(dev.pausedUntil) });
        finish();
        return;
      }
      if (p === 'resume' || (p && typeof p === 'object' && p.resume)) {
        dev.pausedUntil = 0;
        node.status({ fill: 'grey', shape: 'dot', text: 'resumed: reads again' });
        finish();
        return;
      }
      if (Date.now() < dev.pausedUntil) {
        node.status({ fill: 'grey', shape: 'ring', text: 'paused for the phone app until ' + hhmm(dev.pausedUntil) });
        finish();
        return;
      }
      if (dev.pending > 0) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'busy: last read still running, skipped' });
        finish();
        return;
      }
      const override = p && typeof p === 'object' ? p : {};
      const address = String(override.address || dev.address || '').trim() || undefined;
      const deviceName = address ? undefined : (override.deviceName || dev.deviceName || undefined);
      const kind = p === 'settings' || override.settings ? 'settings' : 'reading';
      node.status({ fill: 'blue', shape: 'dot', text: (kind === 'settings' ? 'reading settings of ' : 'reading ') + (address || deviceName || 'first Seplos') });
      try {
        const reading = await dev.read({ address, deviceName, logger: (line) => node.debug(line) }, kind);
        msg.payload = reading;
        msg.topic = kind === 'settings' ? 'seplos/settings' : (msg.topic || 'seplos');
        node.status({ fill: 'green', shape: 'dot', text: kind === 'settings' ? settingsText(reading) : statusText(reading) });
        emit(msg);
        finish();
      } catch (error) {
        const stage = error && error.stage ? error.stage : 'error';
        const message = error instanceof Error ? error.message : String(error);
        node.status({ fill: 'red', shape: 'ring', text: (stage + ': ' + message).slice(0, 60) });
        finish(new Error(stage + ': ' + message + (error && error.hint ? ' (' + error.hint + ')' : '')));
      }
    });
  }

  RED.nodes.registerType('seplos-battery-get', SeplosBatteryGetNode);
};

function hhmm(t) {
  const d = new Date(t);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function settingsText(r) {
  const parts = [r.system && !r.system.error ? 'system' : null]
    .concat((r.packs || []).map((p) => (p.settings && !p.settings.error ? 'pack ' + p.pack : null))).filter(Boolean);
  return 'settings read: ' + (parts.join(', ') || 'none answered') + ' · ' + hhmm(Date.parse(r.timestamp));
}

function statusText(r) {
  const s = r.summary || {};
  const failed = (r.packs || []).filter((p) => p.error).map((p) => p.pack);
  return r.system.voltage + ' V ' + r.system.current + ' A ' + r.system.soc + ' % · Δ ' + s.deltaMv + ' mV · '
    + s.minCellTemp + ' °C' + (failed.length ? ' · pack ' + failed.join(',') + ' failed' : '') + (r.kept ? ' · kept' : '');
}
