// eip3009-live-settle.js
// PURPOSE: prove that my 3.8023 USDC is SPENDABLE with 0 ETH, by settling a real
// EIP-3009 transferWithAuthorization through the live x402.org facilitator, which
// pays the gas. Self-payment to my own payTo at minimal amount => proves the whole
// pipe with a real on-chain transaction and negligible cost.
//
// Usage: node eip3009-live-settle.js [amountUnits]   (default 1000 = 0.001 USDC)
const fs = require('fs');
const path = require('path');
const https = require('https');
const { ethers } = require('ethers');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID = 8453;
const WALLET = 'C:/Users/marce/.automaton/wallet.json';
const FACILITATOR = 'https://x402.org/facilitator';
const RPC = 'https://mainnet.base.org';

function post(url, bodyObj) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = JSON.stringify(bodyObj);
    const req = https.request({
      host: u.hostname, path: u.pathname, method: 'POST', timeout: 45000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'user-agent': 'automaton-sovereign/1.0' }
    }, s => { let b = ''; s.on('data', c => b += c); s.on('end', () => resolve({ status: s.statusCode, body: b })); });
    req.on('error', e => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    req.write(data); req.end();
  });
}

function rpcCall(method, params) {
  return post(RPC, { jsonrpc: '2.0', id: 1, method, params }).then(r => { try { return JSON.parse(r.body); } catch (e) { return { error: r.body }; } });
}

function balanceOf(addr) {
  const data = '0x70a08231' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return rpcCall('eth_call', [{ to: USDC, data }, 'latest']).then(r => {
    if (!r.result) return null;
    return BigInt(r.result);
  });
}

(async () => {
  const amount = BigInt(process.argv[2] || '1000'); // 0.001 USDC
  console.log('=== EIP-3009 LIVE SETTLEMENT PROOF ===');
  console.log('amount = ' + amount + ' units (' + (Number(amount) / 1e6) + ' USDC)');

  const w = JSON.parse(fs.readFileSync(WALLET, 'utf8'));
  const key = w.privateKey.startsWith('0x') ? w.privateKey : '0x' + w.privateKey;
  const wallet = new ethers.Wallet(key);
  const from = wallet.address;
  const to = from; // self-payment: proves the pipe, net-zero value
  console.log('from   = ' + from);
  console.log('to     = ' + to);

  const before = await balanceOf(from);
  console.log('balance before = ' + (before === null ? '?' : (Number(before) / 1e6).toFixed(6)) + ' USDC');

  const now = Math.floor(Date.now() / 1000);
  const auth = {
    from,
    to,
    value: amount,
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + 3600),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  console.log('nonce  = ' + auth.nonce);

  const domain = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: USDC };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  const message = { from, to, value: amount, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce };
  const signature = await wallet.signTypedData(domain, types, message);
  const recovered = ethers.verifyTypedData(domain, types, message, signature);
  console.log('signature recovered == from ? ' + (recovered.toLowerCase() === from.toLowerCase()));

  // x402 v2 PaymentPayload
  const payload = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    payload: {
      signature,
      authorization: {
        from, to,
        value: amount.toString(),
        validAfter: auth.validAfter.toString(),
        validBefore: auth.validBefore.toString(),
        nonce: auth.nonce,
      },
    },
  };
  const requirements = {
    scheme: 'exact',
    network: 'eip155:8453',
    maxAmountRequired: amount.toString(),
    resource: 'https://self/automaton-sovereign-proof',
    description: 'Automaton-Sovereign gas-free settlement proof',
    mimeType: 'application/json',
    payTo: to,
    maxTimeoutSeconds: 60,
    asset: USDC,
    extra: { name: 'USD Coin', version: '2' },
  };

  console.log('\n--- POST /facilitator/settle ---');
  const settled = await post(FACILITATOR + '/settle', { paymentPayload: payload, paymentRequirements: requirements });
  console.log('status=' + settled.status);
  console.log('body=' + settled.body.slice(0, 800));

  if (settled.status === 200) {
    let j = null; try { j = JSON.parse(settled.body); } catch (e) {}
    const txHash = j && (j.txHash || j.transaction || (j.settlement && j.settlement.txHash));
    if (txHash) {
      console.log('\n*** REAL ON-CHAIN TX: ' + txHash + ' ***');
      fs.writeFileSync('LIVE-SETTLEMENT.json', JSON.stringify({ at: new Date().toISOString(), txHash, amount: amount.toString(), from, to, nonce: auth.nonce, signature }, null, 2));
      await new Promise(r => setTimeout(r, 12000));
      const after = await balanceOf(from);
      console.log('balance after  = ' + (after === null ? '?' : (Number(after) / 1e6).toFixed(6)) + ' USDC');
    } else {
      console.log('(no txHash in response)');
    }
  } else {
    console.log('\nsettle did not return 200 -- trying /verify for diagnosis');
    const v = await post(FACILITATOR + '/verify', { paymentPayload: payload, paymentRequirements: requirements });
    console.log('verify status=' + v.status + ' body=' + v.body.slice(0, 600));
  }
})().catch(e => console.log('FATAL ' + e.message + '\n' + e.stack));
