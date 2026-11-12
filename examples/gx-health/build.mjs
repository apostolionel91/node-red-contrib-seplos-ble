// Builds gx-health-flow.json: every minute (and on a button) read CPU, memory, Node-RED memory, temperature
// and disk from the GX, show them in the node status, and send alerts to a link for Pushover.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const parse = readFileSync(join(here, 'parse.js'), 'utf8');

// One shell line for the exec node (busybox-safe). $PPID = the Node-RED process that started the shell.
export const command = [
  'echo "memTotalKB=$(awk \'/^MemTotal:/{print $2}\' /proc/meminfo)"',
  'echo "memAvailKB=$(awk \'/^MemAvailable:/{print $2}\' /proc/meminfo)"',
  'echo "load=$(cut -d\' \' -f1-3 /proc/loadavg)"',
  'echo "cores=$(grep -c ^processor /proc/cpuinfo)"',
  'echo "nodeRssKB=$(awk \'/^VmRSS:/{print $2}\' /proc/$PPID/status)"',
  'echo "temps=$(cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | tr \'\\n\' \' \')"',
  'echo "data=$(df -kP /data 2>/dev/null | awk \'NR==2{print $2, $3, $4}\')"',
  'echo "root=$(df -kP / | awk \'NR==2{print $2, $3, $4}\')"',
  'echo "uptime=$(cut -d\' \' -f1 /proc/uptime)"',
  'echo "cpu=$(head -n 1 /proc/stat)"', // BusyBox head on the GX has no "head -1"
  'echo "--procs"',
  'cat /proc/[0-9]*/stat 2>/dev/null' // one line per program: its name and the processor time it has used
].join('; ');

const info = [
  'Every minute (and with "check now"): processor use and the three busiest programs, memory, Node-RED\'s own memory,',
  'CPU temperature, /data and system disk. Processor use is measured between two readings, so the first one says "measuring".',
  'The summary shows under the "GX health" node. Click the button on the "GX health details" debug node to see everything.',
  'The latest reading is also in global "gx_health" for other flows.',
  'Alerts (thresholds at the top of the function; must hold 5 min): memory below 100 MB, /data above 90 %,',
  'CPU above 80 °C, processor above 95 % used. They leave through the "GX alerts" link: wire a link-in from it',
  'to your Pushover node (msg.topic title, msg.payload text, msg.priority).'
].join('\n');

const id = (n) => 'a7b0c1d2e3f4' + String(n).padStart(4, '0');
const flow = [
  { id: id(1), type: 'comment', name: 'GX health (read me)', info, x: 130, y: 40, wires: [] },
  { id: id(2), type: 'inject', name: 'every minute', props: [{ p: 'payload' }], repeat: '60', crontab: '', once: true, onceDelay: '5', topic: '', payload: '', payloadType: 'date', x: 140, y: 100, wires: [[id(4)]] },
  { id: id(3), type: 'inject', name: 'check now', props: [{ p: 'payload' }], repeat: '', crontab: '', once: false, onceDelay: 0.1, topic: '', payload: '', payloadType: 'date', x: 130, y: 140, wires: [[id(4)]] },
  { id: id(4), type: 'exec', name: 'read /proc and df', command, addpay: '', append: '', useSpawn: 'false', timer: '20', winHide: false, oldrc: false, x: 330, y: 120, wires: [[id(5)], [id(8)], []] },
  { id: id(5), type: 'function', name: 'GX health', func: parse, outputs: 2, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 520, y: 120, wires: [[id(6)], [id(7), id(9)]] },
  { id: id(6), type: 'debug', name: 'GX health details', active: false, tosidebar: true, console: false, tostatus: false, complete: 'payload', targetType: 'msg', statusVal: '', statusType: 'auto', x: 730, y: 100, wires: [] },
  { id: id(7), type: 'link out', name: 'GX alerts', mode: 'link', links: [], x: 695, y: 140, wires: [] },
  { id: id(9), type: 'debug', name: 'GX alert', active: true, tosidebar: true, console: false, tostatus: false, complete: 'payload', targetType: 'msg', statusVal: '', statusType: 'auto', x: 710, y: 180, wires: [] },
  { id: id(8), type: 'debug', name: 'exec errors', active: true, tosidebar: true, console: false, tostatus: false, complete: 'payload', targetType: 'msg', statusVal: '', statusType: 'auto', x: 520, y: 180, wires: [] }
];
const ids = new Set(flow.map((n) => n.id));
for (const n of flow) for (const o of n.wires || []) for (const t of o) if (!ids.has(t)) throw new Error('missing wire ' + t);
writeFileSync(join(here, 'gx-health-flow.json'), JSON.stringify(flow, null, 2) + '\n');
console.log('flow', flow.length, 'nodes');
