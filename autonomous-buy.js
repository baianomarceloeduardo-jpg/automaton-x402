// autonomous-buy.js — be a BUYER, not only a seller. One real, capped, on-chain x402 purchase.
//
// WHY: I have spent many sessions proving I can SELL (402 challenge, EIP-3009 verification,
// caller binding). I never proved I can BUY. An agent that cannot pay for things is not a
// participant in the economy, it is a shop with no door. This closes that.
//
// SAFETY RAILS (all enforced in code, not by convention):
//   - payTo comes from the target's LIVE 402 challenge, never from a cached index entry.
//     A stale cache is how you pay an attacker.
//   - refuse if asset != canonical USDC on Base, or chainId != 8453.
//   - refuse if payTo == my own address (no circular self-payment theatre).
//   - HARD cap on price per purchase; HARD cap on number of purchases.
//   - never log the private key; never print the signer's secret.
//
// Supports both schemes:
//   exact / txhash  -> broadcast an ERC-20 transfer on Base, retry with X-PAYMENT: <txHash>
//   eip3009         -> sign TransferWithAuthorization offline, retry with X-PAYMENT-AUTH
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const ethers = require('ethers');

const DIR = __dirname;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID = 8453;
const SELF = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const MAX_UNITS = BigInt(process.env.X402_BUY_MAX_UNITS || '1000'); // 0.001 USDC per purchase
const MAX_PURCHASES = Number(process.env.X402_BUY_MAX || 2);
const RPC = process.env.X402_RPC || 'https://mainnet.base.org';
const DRY = process.argv.includes('--dry');

const FOUR_SIG = 'transferWithAuthorization';

function req(url, { method = 'GET', headers = {}, timeout = 30000 } = {}) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'bad_url' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method, timeout,
      headers: Object.assign({ 'user-agent': 'automaton-buyer/1.0', accept: 'application/json' }, headers) }, res => {
      let b = ''; res.on('data', c => { if (b.length < 131072) b += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', e => resolve({ ok: false, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'timeout' }); });
    r.end();
  });
}

function loadWallet() {
  if (process.env.X402_PRIVATE_KEY) return new ethers.Wallet(process.env.X402_PRIVATE_KEY);
  const candidates = [
    process.env.X402_WALLET_FILE,
    '/root/.automaton/wallet.json',
    path.join(process.env.HOME || '/root', '.automaton', 'wallet.json'),
    'C:\\Users\\marce\\.automaton\\wallet.json',
    path.join(DIR, 'wallet.json'),
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const k = j.privateKey || j.private_key || (j.wallet && j.wallet.privateKey) || (j.account && j.account.privateKey);
      if (k) return new ethers.Wallet(k.startsWith('0x') ? k : '0x' + k);
    } catch (e) {}
  }
  throw new Error('no_signable_wallet_found');
}

// pick candidate targets from the index, excluding myself
function candidates(limit) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DIR, 'x402-live-cache.json'), 'utf8'));
    return (c.buyable || [])
      .filter(i => i.url && (!i.payTo || String(i.payTo).toLowerCase() !== SELF.toLowerCase()))
      .filter(i => !/127\.0\.0\.1|localhost|192\.168|10\./.test(i.url))
      .slice(0, limit);
  } catch (e) { return []; }
}

async function quoteLive(url) {
  const r = await req(url);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.status !== 402) return { ok: true, free: true, status: r.status, body: r.body.slice(0, 300) };
  let j; try { j = JSON.parse(r.body); } catch (e) { return { ok: false, error: 'challenge_unparseable' }; }
  return { ok: true, free: false, challenge: j, accepts: j.accepts || [] };
}

function pickAccept(quote) {
  for (const a of (quote.accepts || [])) {
    const payTo = String(a.payTo || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(payTo)) continue;
    if (payTo === SELF.toLowerCase()) continue;
    if (a.asset && String(a.asset).toLowerCase() !== USDC.toLowerCase()) continue;
    if (a.chainId && Number(a.chainId) !== CHAIN_ID) continue;
    let amt; try { amt = BigInt(a.maxAmountRequired); } catch (e) { continue; }
    if (amt > MAX_UNITS) continue;
    return { a, amt };
  }
  return null;
}

const { assertSpendAllowed } = require('./services/lib/wallet-guard');

async function payExact(wallet, url, payTo, amt) {
  const erc20 = new ethers.Contract(USDC, ['function transfer(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)'], wallet);
  const bal = await erc20.balanceOf(wallet.address);
  if (bal < amt) return { ok: false, error: 'insufficient_usdc', bal: bal.toString() };
  if (DRY) return { ok: true, dry: true, wouldSend: { to: payTo, units: amt.toString() } };
  assertSpendAllowed({ to: payTo, amount: amt.toString(), token: 'USDC', reason: 'autonomous-buy payExact' });
  const tx = await erc20.transfer(payTo, amt, { gasLimit: 80000 });
  const rcpt = await tx.wait();
  return { ok: true, txHash: tx.hash, block: rcpt.blockNumber, status: rcpt.status };
}

async function payEip3009(wallet, url, payTo, amt) {
  const domain = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: USDC };
  const types = { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
  const now = Math.floor(Date.now() / 1000);
  const payload = { from: wallet.address, to: payTo, value: amt.toString(),
    validAfter: String(now - 60), validBefore: String(now + 1800), nonce: '0x' + crypto.randomBytes(32).toString('hex') };
  if (DRY) return { ok: true, dry: true, wouldSign: payload };
  assertSpendAllowed({ to: payTo, amount: amt.toString(), token: 'USDC', reason: 'autonomous-buy payEip3009' });
  const signature = await wallet.signTypedData(domain, types, payload);
  return { ok: true, header: 'X-PAYMENT-AUTH',
    value: Buffer.from(JSON.stringify({ scheme: 'eip3009', payload, signature })).toString('base64'), payload };
}

(async () => {
  /* __PROVIDER_FIX__ ethers v6 requires a provider attached for read calls like balanceOf */
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = loadWallet().connect(provider);
  const log = [];
  const line = o => { const s = JSON.stringify(o); log.push(s); console.log(s); };
  line({ at: new Date().toISOString(), event: 'buyer_start', payer: wallet.address, dry: DRY,
    maxUnits: MAX_UNITS.toString(), maxPurchases: MAX_PURCHASES });

  const cands = candidates(8);
  if (!cands.length) { line({ event: 'no_candidates' }); return; }
  let purchases = 0, bought = 0;

  for (const c of cands) {
    if (purchases >= MAX_PURCHASES) break;
    const q = await quoteLive(c.url);
    if (!q.ok || q.free) { line({ event: 'skip', url: c.url, reason: q.ok ? 'not_metered(' + q.status + ')' : q.error }); continue; }
    const pick = pickAccept(q);
    if (!pick) { line({ event: 'skip', url: c.url, reason: 'no_acceptable_accept_entry_within_cap' }); continue; }

    const scheme = String(pick.a.scheme || '').toLowerCase();
    const isEip = /eip3009/.test(scheme);
    line({ event: 'target_selected', url: c.url, scheme, payTo: pick.a.payTo, units: pick.amt.toString(),
      priceUsdc: Number(pick.amt) / 1e6, liveChallenge: true });

    let pay, retryHeaders = {};
    if (isEip) {
      pay = await payEip3009(wallet, c.url, pick.a.payTo, pick.amt);
      if (!pay.ok) { line({ event: 'pay_failed', url: c.url, ...pay }); continue; }
      if (!pay.dry) retryHeaders['X-PAYMENT-AUTH'] = pay.value;
    } else {
      pay = await payExact(wallet, c.url, pick.a.payTo, pick.amt);
      if (!pay.ok) { line({ event: 'pay_failed', url: c.url, ...pay }); continue; }
      if (!pay.dry) retryHeaders['X-PAYMENT'] = pay.txHash;
    }
    purchases++;
    line({ event: 'payment_sent', url: c.url, scheme: isEip ? 'eip3009' : 'exact', ...pay });

    if (pay.dry) continue;
    const r2 = await req(c.url, { headers: retryHeaders });
    const served = r2.ok && r2.status === 200;
    if (served) bought++;
    line({ event: served ? 'PURCHASE_SUCCEEDED' : 'purchase_rejected', url: c.url, status: r2.ok ? r2.status : r2.error,
      callerBound: r2.headers ? r2.headers['x-payment-caller-bound'] : null,
      bodyHead: r2.body ? r2.body.slice(0, 400) : null });
    if (bought >= 1) break; // one genuine external purchase is proof enough; do not burn capital
  }

  line({ event: 'buyer_done', purchasesAttempted: purchases, purchasesSucceeded: bought });
  fs.appendFileSync(path.join(DIR, 'AUTONOMOUS-BUY-LOG.jsonl'), log.join('\n') + '\n');
})().catch(e => { console.log('FATAL ' + e.message); process.exit(2); });
