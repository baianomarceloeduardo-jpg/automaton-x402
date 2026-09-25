// mcp-test2.js - drive the MCP server over real stdio JSON-RPC.
const { spawn } = require('child_process');
const child = spawn('node', ['x402-mcp-server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
const snd = (o) => child.stdin.write(JSON.stringify(o) + '\n');
child.stdout.on('data', d => { out += d.toString(); });

function step(msgs, waitMs) {
  return new Promise(res => { msgs.forEach(snd); setTimeout(res, waitMs); });
}

(async () => {
  await step([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-test2', version: '1' } } }], 600);
  await step([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }], 600);
  await step([{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x402_probe', arguments: { url: 'https://hardly-animals-cyber-theatre.trycloudflare.com/v1/hash' } } }], 4000);
  await step([{ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'x402_conformance', arguments: { url: 'https://hardly-animals-cyber-theatre.trycloudflare.com/v1/hash' } } }], 6000);
  child.kill();

  const lines = out.trim().split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
  let pass = 0, fail = 0;
  const chk = (cond, label) => { if (cond) { pass++; console.log('PASS ', label); } else { fail++; console.log('FAIL ', label); } };

  const r1 = lines.find(l => l.id === 1);
  chk(r1 && r1.result && r1.result.serverInfo && r1.result.serverInfo.name === 'x402-toolkit', 'initialize -> serverInfo x402-toolkit');
  const r2 = lines.find(l => l.id === 2);
  chk(r2 && r2.result && r2.result.tools && r2.result.tools.length === 3, 'tools/list -> 3 tools');
  const r3 = lines.find(l => l.id === 3);
  chk(r3 && r3.result && r3.result.content && /x402|probe|score|isX402/i.test(r3.result.content[0].text), 'tools/call x402_probe -> real content');
  const r4 = lines.find(l => l.id === 4);
  chk(r4 && r4.result && r4.result.content && /PASS|CONFORMANT|FAIL/i.test(r4.result.content[0].text), 'tools/call x402_conformance -> verdict');

  console.log('\nMCP SERVER: ' + pass + ' passed, ' + fail + ' failed');
  if (r2 && r2.result) console.log('tools: ' + r2.result.tools.map(t => t.name).join(', '));
  process.exit(fail ? 1 : 0);
})();
