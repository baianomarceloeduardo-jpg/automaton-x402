// external-buy2.js v2.0.0 — REAL outbound x402 v2 purchase, using the exact `accepted` envelope
// the target's own error oracle demanded ("x402 v2 payment payload is missing accepted requirements").
// Every field of the envelope is taken from the target's live 402 challenge — nothing invented.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN = 8453;
const TARGET = process.argv[2] || 'https://api.onesource.io/api/chain/block-number';
const OUT = 'EXTERNAL-BUY.json';
const L = [];
const log = (...a) => { const s = a.join(' '); L.push(s); console.log(s); };

function loadEthers() {
  for (const c of ['ethers', 'C:/Users/marce/automaton/node_modules/ethers']) { try { return require(c); } catch (_) {} }
  return null;
}
function loadPk() {
  for (const c of ['C:/Users/marce/.automaton/wallet.json', path.join(__dirname, 'wallet.json')]) {
    try { const j = JSON.parse(fs.readFileSync(c, 'utf8')); const pk = j.privateKey || j.private_key; if (pk) return pk; } catch (_) {}
  }
  return null;
}
async function req(url, headers) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctl.signal, redirect: 'follow' });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
  } catch (e) { return { status: 0, headers: {}, body: 'ERR ' + String((e && e.message) || e) }; }
  finally { clearTimeout(t); }
}

(async () => {
  const ethers = loadEthers(); const pk = loadPk();
  if (!ethers || !pk) { log('ABORT ethers=' + !!ethers + ' pk=' + !!pk); fs.writeFileSync('external-buy.log', L.join('\n')); return; }
  const wallet = new ethers.Wallet(pk);
  log('WALLET ' + wallet.address);

  const r1 = await req(TARGET);
  log('STEP1 ' + r1.status);
  let accepts = []; try { accepts = JSON.parse(r1.body).accepts || []; } catch (_) {}
  const accepted = accepts.find((a) => a.scheme === 'exact' && String(a.network) === 'eip155:8453') || accepts[0];
  if (!accepted) { log('ABORT no accepts'); fs.writeFileSync('external-buy.log', L.join('\n')); return; }
  log('ACCEPTED ' + JSON.stringify(accepted));

  const payTo = accepted.payTo || accepted.recipient;
  const amount = String(accepted.amount || accepted.maxAmountRequired || '1000');
  const nonce = '0x' + crypto.randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const { assertSpendAllowed } = require('./services/lib/wallet-guard');
  assertSpendAllowed({ to: payTo, amount, token: 'USDC', reason: 'external-buy2 outbound purchase' });

  const auth = { from: wallet.address, to: payTo, value: amount, validAfter: '0', validBefore: String(now + 1800), nonce };
  const domain = { name: 'USD Coin', version: '2', chainId: CHAIN, verifyingContract: USDC };
  const types = { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] };
  const signature = await wallet.signTypedData(domain, types, auth);
  log('SIGNED to=' + payTo + ' value=' + amount + ' nonce=' + nonce.slice(0, 12) + '..');

  const envelope = { x402Version: 2, scheme: 'exact', network: 'eip155:8453', accepted, payload: { signature, authorization: auth } };
  const b64 = Buffer.from(JSON.stringify(envelope)).toString('base64');

  for (const hdrName of ['x-payment', 'payment-signature']) {
    const r = await req(TARGET, { [hdrName]: b64 });
    log('STEP2 ' + hdrName + ' -> ' + r.status + ' ' + (r.status === 200 ? '*** PAID ***' : '') + ' :: ' + r.body.replace(/\s+/g, ' ').slice(0, 500));
    if (r.status === 200) {
      fs.writeFileSync(OUT, JSON.stringify({ ok: true, target: TARGET, via: hdrName, accepted, authorization: auth, response: r.body.slice(0, 4000), at: new Date().toISOString() }, null, 2));
      log('SUCCESS wrote ' + OUT);
      log(r.body.slice(0, 800));
      break;
    }
  }
  fs.appendFileSync('external-buy.log', L.join('\n') + '\n');
})();
