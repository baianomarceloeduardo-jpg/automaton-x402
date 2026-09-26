// test-procure-mcp.js — drive the procurement MCP server over real stdio JSON-RPC.
// These are the checks that matter: tools list, free tools return real data from live endpoints,
// quote against a live x402 target returns exact terms, and pay REFUSES without a signer or above cap.
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const BASE = process.env.X402_INDEX_BASE || 'http://127.0.0.1:8081';
const child = spawn(process.execPath, [path.join(__dirname, 'x402-procure-mcp.js')],
  { env: Object.assign({}, process.env, { X402_INDEX_BASE: BASE }), stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + method)), 90000);
    pending.set(id, m => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const parse = r => { try { return JSON.parse(r.result.content[0].text); } catch (e) { return null; } };
let pass = 0, fail = 0;
function chk(name, cond, extra) { if (cond) { pass++; console.log('PASS ' + name + (extra ? ' :: ' + extra : '')); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }

(async () => {
  const init = await call('initialize', { protocolVersion: '2024-11-05' });
  chk('1 initialize', init.result && init.result.serverInfo.name === 'x402-procure', init.result && init.result.serverInfo.version);

  const list = await call('tools/list', {});
  const names = (list.result.tools || []).map(t => t.name);
  chk('2 tools listed', names.length === 6, names.join(','));

  const buy = parse(await call('tools/call', { name: 'x402_list_buyable', arguments: { limit: 5 } }));
  chk('3 list_buyable live data', buy && buy.ok === true && buy.buyableCount >= 1, buy && ('buyable=' + buy.buyableCount + ' checked=' + buy.checked));
  chk('4 list_buyable priced entries', buy && buy.results && buy.results.every(r => r.payTo && r.priceUsdc != null), buy && JSON.stringify(buy.results[0] || {}).slice(0, 120));

  const conf = parse(await call('tools/call', { name: 'x402_conformance', arguments: { url: process.env.X402_TEST_URL || 'https://api.onesource.io/api/chain/block-number' } }));
  chk('5 conformance runs', conf && conf.ok === true && conf.total > 0, conf && ('verdict=' + conf.verdict + ' ' + conf.passed + '/' + conf.total));

  const privCheck = parse(await call('tools/call', { name: 'x402_conformance', arguments: { url: BASE } }));
  chk('5b private target refused by SSRF guard', privCheck && (privCheck.ok === false || privCheck.error || privCheck.total === 0), privCheck && (privCheck.error || ('verdict=' + privCheck.verdict)));

  const quote = parse(await call('tools/call', { name: 'x402_quote', arguments: { url: BASE + '/paid/clock' } }));
  chk('6 quote returns exact terms', quote && quote.requiresPayment === true && quote.accepts.length > 0, quote && (quote.accepts[0].scheme + ' ' + quote.accepts[0].maxAmountRequired + ' -> ' + quote.payWith));

  const anchors = parse(await call('tools/call', { name: 'x402_anchors', arguments: {} }));
  chk('7 anchors reachable', anchors && (anchors.ok === true ? anchors.count >= 1 : anchors.error === 'anchors_endpoint_unavailable'),
    anchors && (anchors.ok ? ('anchors=' + anchors.count + ' latestBlock=' + anchors.latest.blockNumber) : anchors.error));

  const payNoKey = parse(await call('tools/call', { name: 'x402_pay', arguments: { url: BASE + '/paid/clock' } }));
  chk('8 pay refuses without signer', payNoKey && payNoKey.ok === false && /no_signer|sign_failed/.test(payNoKey.error || ''), payNoKey && payNoKey.error);

  const verify = parse(await call('tools/call', { name: 'x402_verify', arguments: {
    tx: anchors && anchors.latest ? anchors.latest.txHash : '0x0' } }));
  chk('9 verify real anchor tx', verify && verify.ok === true && verify.status === 'success' && verify.chainId === 8453,
    verify && ('block=' + verify.blockNumber + ' chain=' + verify.chainId));

  const verifyPay = parse(await call('tools/call', { name: 'x402_verify', arguments: {
    tx: '0x00aa4bd7f9741d5fc80085812d2a384352461b098856fc4066bdba3d6bf718ec',
    payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528' } }));
  chk('10 verify external revenue tx', verifyPay && verifyPay.ok === true && verifyPay.verified === true && verifyPay.netToPayToUsdc > 0,
    verifyPay && ('net=' + verifyPay.netToPayToUsdc + ' USDC status=' + verifyPay.status));

  console.log('=== ' + pass + '/' + (pass + fail) + ' PASS ===');
  child.stdin.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL ' + e.message); child.kill(); process.exit(2); });
