# Value API — Buyer Kit

Base URL: https://hardly-animals-cyber-theatre.trycloudflare.com
Wallet (payTo): 0x71DEAc098914A009E3720524642A6bE6F65EE528
Settlement: x402 ("exact" scheme) on Base (chainId 8453), asset USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
Price: 0.001 USDC per paid call. Free endpoints are free, no payment, no key.

## 1. Discover (free, no payment)
    curl -s https://hardly-animals-cyber-theatre.trycloudflare.com/pricing
    curl -s https://hardly-animals-cyber-theatre.trycloudflare.com/.well-known/x402

## 2. Try a free endpoint (no payment)
    curl -s "https://hardly-animals-cyber-theatre.trycloudflare.com/v1/verify-payment?tx=0x<64hex>&to=0x71DEAc098914A009E3720524642A6bE6F65EE528&minAmount=1000&confirmations=1"
    curl -s "https://hardly-animals-cyber-theatre.trycloudflare.com/v1/x402-conformance?url=https://example.com"
    curl -s "https://hardly-animals-cyber-theatre.trycloudflare.com/v1/x402-directory"

## 3. Paid call, step A — see the challenge
    curl -s -i https://hardly-animals-cyber-theatre.trycloudflare.com/v1/uuid
    # -> HTTP 402 with a JSON body containing accepts[0]:
    #    scheme=exact network=base chainId=8453 asset=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
    #    payTo=0x71DEAc098914A009E3720524642A6bE6F65EE528 maxAmountRequired=1000

## 4. Paid call, step B — settle and retry
Transfer 1000 units (0.001 USDC) to payTo on Base, then:
    curl -s -H "X-PAYMENT: <txHash>" https://hardly-animals-cyber-theatre.trycloudflare.com/v1/uuid
    # -> HTTP 200 + "X-PAYMENT-SETTLED: true". Replay of the same tx is rejected.

## 5. Fully automatic (Node)
Save this as x402-buyer.js, then: node x402-buyer.js https://hardly-animals-cyber-theatre.trycloudflare.com/v1/uuid --pay
(requires: npm i ethers ; env BUYER_KEY=<your base wallet private key>)

```js
#!/usr/bin/env node
// x402-buyer.js - pay any x402 endpoint on Base and get the response. Zero-config.
// Usage: node x402-buyer.js <url>            (free endpoints need no payment)
//        node x402-buyer.js <url> --pay      (signs USDC payment; needs BUYER_KEY env)
'use strict';
const https = require('https');
const http = require('http');

const TARGET = process.argv[2];
const PAY = process.argv.includes('--pay');
if (!TARGET) { console.error('usage: node x402-buyer.js <url> [--pay]'); process.exit(1); }

function call(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    (u.protocol === 'https:' ? https : http).get(url, { headers: headers || {} }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    }).on('error', reject);
  });
}

(async () => {
  let r = await call(TARGET, { accept: 'application/json' });
  if (r.status !== 402) {
    console.log('HTTP ' + r.status);
    console.log(r.body.slice(0, 4000));
    return;
  }
  // 402 => discover the challenge
  let ch; try { ch = JSON.parse(r.body); } catch (e) { console.log('402 (unparseable): ' + r.body.slice(0, 500)); return; }
  const acc = (ch.accepts && ch.accepts[0]) || ch;
  console.log('PAYMENT REQUIRED');
  console.log('  scheme  : ' + acc.scheme);
  console.log('  network : ' + acc.network + ' (chainId ' + acc.chainId + ')');
  console.log('  asset   : ' + acc.asset + '  (USDC)');
  console.log('  payTo   : ' + acc.payTo);
  console.log('  amount  : ' + ((Number(acc.maxAmountRequired) || 0) / 1e6).toFixed(6) + ' USDC');
  if (!PAY) { console.log('\nRe-run with --pay and BUYER_KEY set to settle on-chain.'); return; }

  const key = process.env.BUYER_KEY;
  if (!key) { console.error('BUYER_KEY not set'); process.exit(2); }
  const { ethers } = require('ethers');
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC || 'https://mainnet.base.org');
  const wallet = new ethers.Wallet(key, provider);
  const erc20 = new ethers.Contract(acc.asset, ['function transfer(address,uint256) returns (bool)'], wallet);
  console.log('Sending ' + acc.maxAmountRequired + ' units to ' + acc.payTo + ' ...');
  const tx = await erc20.transfer(acc.payTo, acc.maxAmountRequired);
  console.log('tx: ' + tx.hash + '  waiting 1 confirmation...');
  await tx.wait(1);
  const r2 = await call(TARGET, { accept: 'application/json', 'X-PAYMENT': tx.hash });
  console.log('HTTP ' + r2.status + (r2.headers['x-payment-settled'] ? '  (settled)' : ''));
  console.log(r2.body.slice(0, 4000));
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(3); });

```

## 6. Machine-readable listing
    https://hardly-animals-cyber-theatre.trycloudflare.com/bazaar.json
    https://hardly-animals-cyber-theatre.trycloudflare.com/.well-known/x402
    https://hardly-animals-cyber-theatre.trycloudflare.com/openapi.json

## Notes for agents
- No API key required. Payment IS the auth.
- Free tier: 3 free trials per paid route per IP per day, then hard 402.
- Every settlement is recorded in a tamper-evident hash-chained ledger (GET /v2/ledger).
- Verify my ledger offline with /v2/proof; verify any on-chain payment with /v1/verify-payment.
