// Test harness for mcp-server.js: drives the JSON-RPC stdio protocol end to end.
// Notifications (no id) get NO reply -> advance immediately after writing them.
const { spawn } = require('child_process');
const path = require('path');

const child = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js')], {
  env: Object.assign({}, process.env, { VALUE_API_BASE: process.env.VALUE_API_BASE || 'http://127.0.0.1:8080' }),
  stdio: ['pipe', 'pipe', 'inherit']
});

let out = '';
child.stdout.on('data', (c) => {
  out += c.toString('utf8');
  let nl;
  while ((nl = out.indexOf('\n')) >= 0) {
    const line = out.slice(0, nl); out = out.slice(nl + 1);
    if (line.trim()) { try { onReply(JSON.parse(line)); } catch (e) { console.log('bad line: ' + line.slice(0, 80)); } }
  }
});

const seq = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pricing', arguments: {} } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'health', arguments: {} } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'attestation_pubkey', arguments: {} } },
  { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'verify_attestation', arguments: { index: 0 } } },
  { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'uuid', arguments: {} } }
];

let done = false;
function sendNext() {
  if (i >= seq.length) { if (!done) { done = true; setTimeout(() => { child.kill(); process.exit(0); }, 400); } return; }
  const m = seq[i++];
  child.stdin.write(JSON.stringify(m) + '\n');
  if (m.id === undefined) sendNext(); // notification: no reply expected, advance now
}
let i = 0;

function onReply(m) {
  const label = 'id=' + m.id;
  if (m.error) { console.log(label + ' ERROR ' + JSON.stringify(m.error)); }
  else if (m.result && m.result.tools) { console.log(label + ' tools=' + m.result.tools.length + ' -> ' + m.result.tools.map(t => t.name).join(',')); }
  else if (m.result && m.result.content) {
    const t = m.result.content[0].text.replace(/\s+/g, ' ');
    console.log(label + ' isError=' + !!m.result.isError + ' | ' + (t.length > 170 ? t.slice(0, 170) + '...' : t));
  } else if (m.result && m.result.serverInfo) { console.log(label + ' init ok: ' + JSON.stringify(m.result.serverInfo)); }
  else { console.log(label + ' ' + JSON.stringify(m.result).slice(0, 120)); }
  sendNext();
}

sendNext();
setTimeout(() => { console.log('timeout — replies received up to id=' + (i - 1)); child.kill(); process.exit(1); }, 25000);
