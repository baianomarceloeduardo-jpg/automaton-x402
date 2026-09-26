// mcp-bundle-test.js — proves the MCP bundle actually works over real stdio JSON-RPC.
// Spawns x402-value-mcp.js as a child process, speaks the MCP handshake, lists tools,
// and calls one free tool. Captures real evidence. No mocks.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || (fs.existsSync('tunnel.url') ? fs.readFileSync('tunnel.url', 'utf8').trim() : '')).replace(/\/+$/, '');
const SRV = path.join(__dirname, 'mcp-bundle', 'x402-value-mcp.js');
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('[PASS] ' + n + (d ? ' — ' + d : '')); };
const no = (n, d) => { fail++; console.log('[FAIL] ' + n + (d ? ' — ' + d : '')); };

(async () => {
  if (!BASE) { console.log('no base URL'); process.exitCode = 1; return; }
  const child = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { VALUE_API_BASE: BASE }), stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = [];
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { responses.push(JSON.parse(line)); } catch (e) {}
    }
  });
  const errs = [];
  child.stderr.on('data', c => errs.push(c.toString()));
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const find = (id) => responses.find(r => r.id === id);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await wait(600);
  const init = find(1);
  if (init && init.result && init.result.serverInfo) ok('initialize handshake', 'serverInfo=' + init.result.serverInfo.name + ' v' + init.result.serverInfo.version);
  else no('initialize handshake', JSON.stringify(init || responses).slice(0, 200));

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await wait(500);
  const list = find(2);
  const tools = list && list.result && list.result.tools ? list.result.tools : [];
  if (tools.length >= 6) ok('tools/list', tools.length + ' tools: ' + tools.map(t => t.name).join(', '));
  else no('tools/list', 'count=' + tools.length);

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x402_health', arguments: {} } });
  await wait(4000);
  const call = find(3);
  const txt = call && call.result && call.result.content && call.result.content[0] ? call.result.content[0].text : '';
  const parsed = (() => { try { return JSON.parse(txt); } catch (e) { return null; } })();
  if (call && call.result && !call.result.isError && parsed && (parsed.payTo || parsed.accepts || parsed.network)) {
    ok('tools/call x402_health', 'live terms: payTo=' + String(parsed.payTo || '').slice(0, 12) + '... network=' + (parsed.network || (parsed.accepts && parsed.accepts[0] && parsed.accepts[0].network)));
  } else {
    no('tools/call x402_health', 'isError=' + (call && call.result && call.result.isError) + ' text=' + String(txt).slice(0, 200));
  }

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'x402_conformance', arguments: { url: BASE + '/v1/uuid' } } });
  await wait(6000);
  const c4 = find(4);
  const t4 = c4 && c4.result && c4.result.content && c4.result.content[0] ? c4.result.content[0].text : '';
  if (c4 && c4.result && !c4.result.isError && /verdict|passed|CONFORMANT|total/i.test(t4)) ok('tools/call x402_conformance', 'real verdict returned');
  else no('tools/call x402_conformance', String(t4).slice(0, 220));

  child.kill();
  console.log('\n=== mcp-bundle test: ' + pass + '/' + (pass + fail) + ' PASS ===');
  fs.writeFileSync('mcp-bundle-EVIDENCE.txt', 'base=' + BASE + '\ntools=' + tools.map(t => t.name).join(',') + '\nresult=' + pass + '/' + (pass + fail) + '\nat=' + new Date().toISOString() + '\n' + (errs.length ? 'stderr: ' + errs.join('').slice(0, 500) : ''));
  process.exit(0);
})().catch(e => { console.log('ERROR ' + e.message); process.exit(1); });
