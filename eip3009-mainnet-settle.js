// eip3009-mainnet-settle.js
// PROVE: 3.8023 USDC on Base mainnet is spendable with 0 ETH, via a real mainnet
// facilitator (payai.network) that pays the gas on a signed EIP-3009 authorization.
// This converts 7 sessions of theory into ONE on-chain fact.
const fs = require('fs');
const https = require('https');
const { ethers } = require('ethers');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID = 8453;
const WALLET = 'C:/Users/marce/.automaton/wallet.json';
const RPC = 'https://mainnet.base.org';

function req(url, method, bodyObj) {
  return new Promise(r => {
    const u = new URL(url);
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = { 'user-agent': 'automaton-sovereign/1.0', accept: 'application/json' };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const rq = https.request({ host: u.hostname, path: u.pathname + u.search, method, timeout: 45000, headers }, s => {
      let b = ''; s.on('data', c => b += c); s.on('end', () => r({ status: s.statusCode, body: b }));
    });
    rq.on('error', e => r({ status: 0, body: 'ERR ' + e.message }));
    rq.on('timeout', () => { rq.destroy(); r({ status: 0, body: 'TIMEOUT' }); });
    if (data) rq.write(data);
    rq.end();
  });
}
const jparse = s => { try { return JSON.parse(s) } catch (e) { return null } };

async function main() {
  const w = JSON.parse(fs.readFileSync(WALLET, 'utf8'));
  const wallet = new ethers.Wallet(w.privateKey.startsWith('0x') ? w.privateKey : '0x' + w.privateKey);
  const from = wallet.address;
  const to = from; // self-payment: proves pipe, net-zero

  console.log('=== MAINNET GAS-FREE SETTLEMENT ATTEMPT ===');
  console.log('wallet = ' + from);
  const bal = await req(RPC, 'POST', { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC, data: '0x70a08231' + from.toLowerCase().replace(/^0x/, '').padStart(64, '0') }, 'latest'] });
  const bj = jparse(bal.body);
  console.log('USDC balance = ' + (bj && bj.result ? (Number(BigInt(bj.result)) / 1e6).toFixed(6) : '?'));
  const eth = await req(RPC, 'POST', { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [from, 'latest'] });
  const ej = jparse(eth.body);
  console.log('ETH balance  = ' + (ej && ej.result ? (Number(BigInt(ej.result)) / 1e18).toFixed(9) : '?') + ' (gas-free path needs 0)');

  // 1) discover the exact mainnet kind
  const sup = await req('https://facilitator.payai.network/supported', 'GET');
  const sj = jparse(sup.body);
  const kinds = (sj && sj.kinds) || [];
  const mainnet = kinds.filter(k => k.scheme === 'exact' && /base$|8453/.test(String(k.network)));
  console.log('\nmainnet exact kinds: ' + JSON.stringify(mainnet));
  if (!mainnet.length) { console.log('NO MAINNET EXACT KIND'); return; }
  const kind = mainnet[0];
  const netName = kind.network;               // e.g. "base"
  const extra = Object.assign({ name: "USD Coin", version: "2" }, kind.extra || {});
  console.log('using network=' + netName + ' extra=' + JSON.stringify(extra));

  // 2) sign EIP-3009 authorization
  const amount = BigInt(process.argv[2] || '1000');
  const now = Math.floor(Date.now() / 1000);
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const domain = { name: extra.name || 'USD Coin', version: extra.version || '2', chainId: CHAIN_ID, verifyingContract: USDC };
  const types = { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
  const message = { from, to, value: amount, validAfter: BigInt(now - 60), validBefore: BigInt(now + 3600), nonce };
  const signature = await wallet.signTypedData(domain, types, message);
  const rec = ethers.verifyTypedData(domain, types, message, signature);
  console.log('sig recovered==from ? ' + (rec.toLowerCase() === from.toLowerCase()));

  const auth = { from, to, value: amount.toString(), validAfter: message.validAfter.toString(), validBefore: message.validBefore.toString(), nonce };
  const requirements = { scheme: 'exact', network: netName, maxAmountRequired: amount.toString(), resource: 'https://automaton-sovereign/proof', description: 'gas-free settlement proof', mimeType: 'application/json', payTo: to, maxTimeoutSeconds: 300, asset: USDC, extra };
  const payload = { x402Version: (sj.x402Version || 1), scheme: 'exact', network: netName, payload: { signature, authorization: auth } };

  console.log('\n--- POST /settle (payai, mainnet) ---');
  const s1 = await req('https://facilitator.payai.network/settle', 'POST', { paymentPayload: payload, paymentRequirements: requirements });
  console.log(s1.status + ' ' + s1.body.slice(0, 600));

  if (s1.status !== 200) {
    console.log('\n--- POST /verify (diagnostic) ---');
    const v = await req('https://facilitator.payai.network/verify', 'POST', { paymentPayload: payload, paymentRequirements: requirements });
    console.log(v.status + ' ' + v.body.slice(0, 600));
  } else {
    const j = jparse(s1.body);
    const tx = j && (j.txHash || j.transaction || j.tx);
    console.log('\n*** SUCCESS ***  tx=' + tx);
    if (tx) {
      fs.writeFileSync('MAINNET-SETTLEMENT.json', JSON.stringify({ at: new Date().toISOString(), txHash: tx, amount: amount.toString(), from, to, nonce, signature, facilitator: 'facilitator.payai.network' }, null, 2));
      await new Promise(r => setTimeout(r, 15000));
      const b2 = await req(RPC, 'POST', { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [tx] });
      const r2 = jparse(b2.body);
      console.log('receipt status = ' + (r2 && r2.result && r2.result.status) + ' block=' + (r2 && r2.result && r2.result.blockNumber));
    }
  }
}
main().catch(e => console.log('FATAL ' + e.message + '\n' + e.stack));
