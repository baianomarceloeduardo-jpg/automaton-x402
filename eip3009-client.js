// eip3009-client.js - buyer client for CALLER-BOUND x402 payments (EIP-3009).
//
// Usage:
//   node eip3009-client.js <baseUrl> <path> [--pay]
// Examples:
//   node eip3009-client.js http://localhost:8081 /v1/paid/uuid
//   BUYER_KEY=0x... node eip3009-client.js http://localhost:8081 /v1/paid/uuid --pay
//
// Without --pay it discovers the 402 challenge and prints the exact envelope+curl.
// With --pay it signs the EIP-712 TransferWithAuthorization and retries the request.
// NOTE: caller-bound payments need NO gas from the buyer (a facilitator settles on-chain),
//       so this works even with 0 ETH in the buyer wallet -- only USDC is required.
'use strict';
const http = require('http');
const https = require('https');
const { makeEip3009 } = require('./eip3009.js');

const BASE = (process.argv[2] || 'http://localhost:8081').replace(/\/+$/, '');
const P = process.argv[3] || '/v1/paid/uuid';
const PAY = process.argv.includes('--pay');

function call(url, headers, method) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(url, { method: method || 'GET', timeout: 20000, headers: headers || {} },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); r.end();
  });
}

(async () => {
  const url = BASE + P;
  let r = await call(url, { accept: 'application/json' });
  if (r.status !== 402) { console.log('HTTP ' + r.status); console.log(r.body.slice(0, 3000)); return; }

  let ch; try { ch = JSON.parse(r.body); } catch (e) { console.log('402 unparseable: ' + r.body.slice(0, 400)); return; }
  const acc = (ch.accepts && ch.accepts[0]) || ch;
  console.log('PAYMENT REQUIRED (caller-bound)');
  console.log('  scheme  : ' + acc.scheme);
  console.log('  network : ' + acc.network + ' (chainId ' + acc.chainId + ')');
  console.log('  asset   : ' + acc.asset + '  (USD Coin)');
  console.log('  payTo   : ' + acc.payTo);
  console.log('  amount  : ' + (Number(acc.maxAmountRequired) / 1e6).toFixed(6) + ' USDC');

  const key = process.env.BUYER_KEY;
  if (!PAY || !key) {
    console.log('\nNo --pay / BUYER_KEY. Here is exactly what to send:\n');
    console.log('  1) Sign EIP-712 TransferWithAuthorization');
    console.log('     domain  = { name:"USD Coin", version:"2", chainId:8453,');
    console.log('                 verifyingContract:"' + acc.asset + '" }');
    console.log('     message = { from:<your addr>, to:"' + acc.payTo + '", value:"' + acc.maxAmountRequired + '",');
    console.log('                 validAfter:0, validBefore:<now+600>, nonce:<random 0x..32 bytes> }');
    console.log('  2) Envelope = base64(JSON.stringify({ payload, signature }))');
    console.log('  3) curl -s -H "X-PAYMENT-AUTH: <envelope>" ' + url);
    return;
  }

  const { ethers } = require('ethers');
  const wallet = new ethers.Wallet(key);
  const e = makeEip3009(null, wallet);
  const env = await e.signAuthorization({ from: wallet.address, to: acc.payTo, value: String(acc.maxAmountRequired) }, wallet);
  const b64 = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
  console.log('\nSigned authorization from ' + wallet.address + ' (no gas needed)');
  const r2 = await call(url, { accept: 'application/json', 'X-PAYMENT-AUTH': b64 });
  console.log('HTTP ' + r2.status + (r2.headers['x-payment-caller-bound'] ? '  callerBound=' + r2.headers['x-payment-caller-bound'] : '') + (r2.headers['x-payment-payer'] ? '  payer=' + r2.headers['x-payment-payer'] : ''));
  console.log(r2.body.slice(0, 3000));
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
