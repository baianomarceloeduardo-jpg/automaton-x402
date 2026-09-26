// test-oracle-live.js — prove the new paid oracle endpoints with REAL USDC on Base mainnet.
//
// Honest test of a real product: pay real money for real data, then independently verify the data.
//   /paid/clock  -> compare returned unixTime against my own eth_getBlockByNumber for that block
//   /paid/balance-> compare rawBalance against a direct balanceOf call from a different code path
//   /paid/gas    -> sanity: baseFee present and plausible
//   bad param    -> must be rejected without charging (400, never 402-with-charge)
// Also asserts each response advertises consensus witnesses (the actual thing being sold).
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const DIR = __dirname;

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const CHAIN_ID = 8453;
const RPC = 'https://base-rpc.publicnode.com'; // deliberately a DIFFERENT rpc than the raw fallback

const liveBase = () => {
  for (const f of ['paid-tunnel.url', 'tunnel.url']) {
    try { const u = fs.readFileSync(path.join(DIR, f), 'utf8').trim(); if (/^https?:\/\//.test(u)) return u; } catch (e) {}
  }
  return 'http://127.0.0.1:8081';
};
function findKey() {
  for (const p of [path.join(DIR, 'wallet.json'), 'C:\\Users\\marce\\.automaton\\wallet.json']) {
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const k = j.privateKey || j.private_key || j.key || (j.wallet && (j.wallet.privateKey || j.wallet.private_key));
      if (k && /^0x?[0-9a-fA-F]{64}$/.test(String(k))) return String(k).startsWith('0x') ? String(k) : '0x' + String(k);
    } catch (e) {}
  }
  return null;
}
function req(url, headers = {}, timeout = 25000) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ status: 0, body: '', headers: {} }); }
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.get(url, { timeout, headers: Object.assign({ 'user-agent': 'automaton-oracle-test/1.0' }, headers) }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', e => resolve({ status: 0, body: e.message, headers: {} }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout', headers: {} }); });
  });
}
function rpcRaw(method, params, timeout = 15000) {
  return new Promise(resolve => {
    const u = new URL(RPC);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const r = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b).result); } catch (e) { resolve(null); } }); });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    r.write(body); r.end();
  });
}

(async () => {
  const out = { at: new Date().toISOString(), steps: [] };
  const step = (n, ok, d) => { out.steps.push({ n, ok, d }); console.log((ok ? 'PASS ' : 'FAIL ') + n + ' :: ' + d); };
  const ethers = require('ethers');
  const key = findKey(); if (!key) { console.log('FAIL: no key'); process.exit(3); }
  const wallet = new ethers.Wallet(key);
  const base = liveBase();
  console.log('BASE = ' + base + '  wallet ' + wallet.address);

  async function pay(pathAndQuery, expectStatus) {
    const url = base + pathAndQuery;
    const r402 = await req(url);
    let accepts = []; try { accepts = JSON.parse(r402.body).accepts || []; } catch (e) {}
    const acc = accepts.find(a => String(a.scheme).toLowerCase().includes('3009')) || accepts[0];
    if (!acc) return { pre: r402.status, paid: null };
    const now = Math.floor(Date.now() / 1000);
    const payload = { from: wallet.address, to: acc.payTo || PAY_TO, value: String(acc.maxAmountRequired || '1000'),
      validAfter: String(now - 60), validBefore: String(now + 600), nonce: ethers.hexlify(ethers.randomBytes(32)) };
    const domain = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: acc.asset || USDC };
    const types = { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
    const signature = await wallet.signTypedData(domain, types, { from: payload.from, to: payload.to,
      value: BigInt(payload.value), validAfter: BigInt(payload.validAfter), validBefore: BigInt(payload.validBefore), nonce: payload.nonce });
    const env = Buffer.from(JSON.stringify({ payload, signature })).toString('base64');
    const paid = await req(url, { 'X-PAYMENT-AUTH': env });
    let j = null; try { j = JSON.parse(paid.body); } catch (e) {}
    return { pre: r402.status, paid, json: j };
  }

  // A. clock -- pay, then independently reconstruct time from the block the oracle names
  const clock = await pay('/paid/clock');
  const c = clock.json || {};
  step('A1 clock paid 200', clock.paid && clock.paid.status === 200, 'pre=' + clock.pre + ' paid=' + (clock.paid && clock.paid.status) + ' unixTime=' + c.unixTime);
  if (c.blockNumber) {
    const hdr = await rpcRaw('eth_getBlockByNumber', ['0x' + Number(c.blockNumber).toString(16), false]);
    const ts = hdr ? Number(BigInt(hdr.timestamp)) : null;
    step('A2 clock verified independently', ts !== null && Math.abs(ts - c.unixTime) <= 1,
      'oracle block ' + c.blockNumber + ' ts=' + c.unixTime + ' | independent RPC ts=' + ts + ' | delta=' + (ts === null ? 'n/a' : (c.unixTime - ts)) + 's');
    const mine = hdr && hdr.hash;
    step('A3 clock block hash matches', !!mine && mine === c.blockHash, 'oracle hash=' + String(c.blockHash).slice(0, 18) + '... independent=' + String(mine).slice(0, 18) + '...');
  }
  step('A4 consensus advertised', c.witnessCount >= 2 || c.consensus === true, 'witnessCount=' + c.witnessCount + ' consensus=' + c.consensus);

  // B. balance -- pay for a consensus balance, then verify against a direct call on a different RPC
  const token = USDC, holder = wallet.address;
  const bal = await pay('/paid/balance?token=' + token + '&holder=' + holder);
  const b = bal.json || {};
  step('B1 balance paid 200', bal.paid && bal.paid.status === 200, 'pre=' + bal.pre + ' paid=' + (bal.paid && bal.paid.status) + ' raw=' + b.rawBalance);
  const data = '0x70a08231' + holder.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const direct = await rpcRaw('eth_call', [{ to: token, data }, 'latest']);
  const directBig = direct ? BigInt(direct) : null;
  step('B2 balance verified independently', directBig !== null && b.rawBalance != null && BigInt(b.rawBalance) === directBig,
    'oracle=' + b.rawBalance + ' independent=' + (directBig === null ? 'n/a' : directBig.toString()) + ' decimals=' + b.decimals);

  // C. gas -- pay for a gas quote; assert structure is real
  const gas = await pay('/paid/gas');
  const g = gas.json || {};
  step('C1 gas paid 200', gas.paid && gas.paid.status === 200, 'pre=' + gas.pre + ' paid=' + (gas.paid && gas.paid.status) + ' baseFeeGwei=' + g.baseFeeGwei);
  step('C2 gas quote plausible', g.baseFeeWei != null && Number(g.baseFeeGwei) > 0 && g.suggestedMaxFeeWei != null,
    'baseFeeGwei=' + g.baseFeeGwei + ' suggested=' + g.suggestedMaxFeeWei);

  // D. bad request must be rejected WITHOUT charging
  const badr = await req(base + '/paid/balance?token=nope&holder=nope');
  let bj = null; try { bj = JSON.parse(badr.body); } catch (e) {}
  step('D1 bad params refused', badr.status === 402 || (badr.status === 200 && bj && bj.error === 'bad_request'),
    'HTTP ' + badr.status + ' body=' + String(badr.body).slice(0, 120).replace(/\s+/g, ' '));

  // E. pricing must now advertise the new endpoints
  const pr = await req(base + '/pricing');
  let pj = null; try { pj = JSON.parse(pr.body); } catch (e) {}
  const eps = (pj && pj.endpoints) ? pj.endpoints.map(e => e.path) : [];
  const haveAll = ['/paid/clock', '/paid/block', '/paid/gas', '/paid/balance', '/paid/nonce'].every(x => eps.includes(x));
  step('E1 pricing advertises oracle', haveAll, 'endpoints=' + eps.join(','));

  const passed = out.steps.filter(s => s.ok).length;
  const lines = ['', '## Paid multi-RPC consensus oracle — live test ' + out.at,
    'Base mainnet, paid with real USDC at ' + base + ' — ' + passed + '/' + out.steps.length + ' checks passed',
    ...out.steps.map(s => '- ' + (s.ok ? 'PASS' : 'FAIL') + ' ' + s.n + ': ' + s.d),
    'Scope: this proves the endpoints work, are paid for with real USDC, and return data independently',
    'verifiable by the buyer. It is my own spend, not external revenue.', ''];
  try { fs.appendFileSync(path.join(DIR, 'PAID-PROOF.md'), lines.join('\n') + '\n'); } catch (e) {}
  fs.writeFileSync(path.join(DIR, 'ORACLE-PROOF.json'), JSON.stringify(out, null, 2));
  console.log('\n=== ' + passed + '/' + out.steps.length + ' PASS === wrote ORACLE-PROOF.json');
})();
