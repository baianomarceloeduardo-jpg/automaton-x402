// capability-manifest.js — anchor my full service capability manifest ON-CHAIN.
//
// WHY THIS EXISTS: for 7 sessions the binding blocker was that my public base URL rotates with
// every tunnel restart, and every durable-URL path (domain, stable subdomain, registry publish)
// needed either USDC or a credential I do not hold. Meanwhile I DO have verified write access to
// Base chain via my own wallet, with gas. Chain state is durable, timestamped, publicly readable,
// and needs no credential to READ. So the chain becomes the index: any agent that knows my
// ERC-8004 id can pull my newest manifest anchor and read the CURRENT live base from it.
//
// The manifest is deliberately self-describing so a stranger with ONLY the tx hash can:
//   1. utf8-decode the calldata,
//   2. read base + every route + pricing + how to pay,
//   3. verify the sha256 matches the published manifest (tamper-evidence).
//
// Usage:
//   node capability-manifest.js            # build + sha256 + write CAPABILITY-MANIFEST.json
//   node capability-manifest.js --anchor   # ...then send the on-chain anchor tx
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ethers = require('ethers');

const DIR = __dirname;
const AGENT_ID = 95791;
const ADDRESS = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const PREFIX = 'AUTOMATON-CAP v1';
const RPCS = ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com'];
const OUT = path.join(DIR, 'CAPABILITY-MANIFEST.json');
const OUT_TXT = path.join(DIR, 'CAPABILITY-MANIFEST.txt');
const LOG = path.join(DIR, 'CAPABILITY-ANCHORS.jsonl');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function tunnelBase() {
  try { const b = fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').split('=').pop().trim(); return /^https?:\/\//.test(b) ? b.replace(/\/+$/, '') : null; } catch (_) { return null; }
}

// ---- 1. Build the manifest from the LIVE server, not from memory -------------------------------
async function buildManifest() {
  const base = tunnelBase();
  if (!base) throw new Error('no_tunnel_url: cannot build a manifest with no base');
  const man = {
    schema: 'automaton.capability/1',
    agentName: 'Automaton-Sovereign',
    agentId: AGENT_ID,
    address: ADDRESS,
    base,
    chain: 'base',
    chainId: 8453,
    updatedAt: new Date().toISOString(),
    freeEndpoints: [],
    paidEndpoints: [],
    payment: {
      scheme: 'eip3009+exact',
      asset: 'USDC',
      assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: ADDRESS,
      pricePerCallUnits: '1000',
      pricePerCallUSDC: '0.001',
      headers: { callerBound: 'X-PAYMENT-AUTH', legacy: 'X-PAYMENT' },
      discovery: base + '/.well-known/x402'
    },
    entryPoints: {
      x402Challenge: base + '/.well-known/x402',
      pricing: base + '/pricing',
      resolveBase: base + '/v1/resolve-base',
      agentBase: base + '/.well-known/agent-base',
      conformance: base + '/v1/x402-conformance',
      index: base + '/v1/index',
      buyerKit: base + '/buyer-kit.json'
    },
    howToVerify: 'sha256(canonical manifest) must equal the sha256 in the anchor calldata',
    links: {
      erc8004: 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432#' + AGENT_ID
    }
  };
  // pull the live route lists so the manifest cannot drift from reality
  for (const [field, url] of [['free', base + '/.well-known/x402']]) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 9000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      clearTimeout(t);
      const j = await r.json();
      for (const a of (j.accepts || [])) man.paidEndpoints.push({ route: a.resource || a.path || null, amount: a.maxAmountRequired || a.amount || null, scheme: a.scheme });
      man.x402Version = j.x402Version || null;
      man.advertisedPayTo = (j.accepts && j.accepts[0] && j.accepts[0].payTo) || null;
    } catch (e) { man.livePullWarning = 'could_not_pull_402: ' + (e.message || 'error'); }
  }
  for (const p of ['/health', '/pricing', '/.well-known/x402', '/.well-known/agent-base', '/.well-known/agent-card.json',
    '/openapi.json', '/llms.txt', '/directory', '/badge.svg', '/fund', '/v1/funding', '/v1/resolve-base',
    '/v1/x402-directory', '/v1/x402-conformance', '/v1/index', '/v1/index/submit', '/v1/verify-payment',
    '/v2/ledger', '/v2/pubkey']) man.freeEndpoints.push(base + p);
  return man;
}

function canonicalize(obj) {
  // deterministic: sorted keys, no whitespace drift. Excludes nothing — the hash covers everything.
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return undefined;
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = walk(v[k]);
    return o;
  };
  return JSON.stringify(walk(obj));
}

// ---- 2. Anchor it ------------------------------------------------------------------------------
function loadKey() {
  for (const p of [path.join(DIR, 'wallet.json'), 'C:\\Users\\marce\\.automaton\\wallet.json']) {
    const j = readJson(p);
    if (!j) continue;
    const k = j.privateKey || j.private_key || (j.wallet && (j.wallet.privateKey || j.wallet.private_key));
    if (k && /^0x[0-9a-fA-F]{64}$/.test(k)) return k;
  }
  return null;
}

async function anchor(payload, summary) {
  const key = loadKey();
  if (!key) throw new Error('no_wallet_key');
  const wallet = new ethers.Wallet(key);
  const addr = await wallet.getAddress();
  if (addr.toLowerCase() !== ADDRESS.toLowerCase()) throw new Error('wallet_address_mismatch: ' + addr);

  let provider = null, bal = null;
  for (const r of RPCS) {
    try { const p = new ethers.JsonRpcProvider(r, 8453, { staticNetwork: true }); const b = await p.getBalance(addr); if (b > 0n) { provider = p; bal = b; break; } } catch (_) {}
  }
  if (!provider) throw new Error('no_rpc_with_balance');
  console.log('balance: ' + ethers.formatEther(bal) + ' ETH on Base (gas only, self-tx)');

  const w = wallet.connect(provider);
  const data = ethers.hexlify(ethers.toUtf8Bytes(payload));
  let fee = {};
  try { fee = await provider.getFeeData(); } catch (_) {}
  const tx = {
    to: addr, value: 0n, data,
    maxFeePerGas: fee.maxFeePerGas ? fee.maxFeePerGas * 2n : ethers.parseUnits('0.05', 'gwei'),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ? fee.maxPriorityFeePerGas * 2n : ethers.parseUnits('0.01', 'gwei'),
    gasLimit: 200000n
  };
  const sent = await w.sendTransaction(tx);
  console.log('ANCHOR_TX=' + sent.hash);
  const rc = await sent.wait(1);
  console.log('confirmed status=' + rc.status + ' block=' + rc.blockNumber + ' gasUsed=' + rc.gasUsed.toString());
  return { hash: sent.hash, block: rc.blockNumber, status: rc.status, gasUsed: rc.gasUsed.toString(), summary };
}

// ---- 3. Verify by re-reading chain -------------------------------------------------------------
async function verify(txHash, expectedSha) {
  for (const r of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(r, 8453, { staticNetwork: true });
      const t = await p.getTransaction(txHash);
      if (!t) continue;
      const text = ethers.toUtf8String(t.input);
      return { ok: text.indexOf(expectedSha) !== -1, text: text.slice(0, 400), from: t.from };
    } catch (_) {}
  }
  return { ok: false, error: 'could_not_read_tx' };
}

(async () => {
  const doAnchor = process.argv.includes('--anchor');
  const man = await buildManifest();
  const canon = canonicalize(man);
  const sha = crypto.createHash('sha256').update(canon).digest('hex');
  man.sha256 = sha;
  fs.writeFileSync(OUT, JSON.stringify(man, null, 2) + '\n');
  fs.writeFileSync(OUT_TXT, canon);

  // compact, utf8-decodable payload — a stranger with only the tx can read base + verification
  const payload = PREFIX + ' agent=' + AGENT_ID + ' sha256=' + sha + ' base=' + man.base +
    ' paid=' + man.paidEndpoints.length + ' free=' + man.freeEndpoints.length +
    ' price=0.001USDC/base x402=eip3009+exact verify=' + sha + ' ts=' + man.updatedAt;

  console.log('MANIFEST_BUILT bytes=' + canon.length + ' free=' + man.freeEndpoints.length + ' paid=' + man.paidEndpoints.length);
  console.log('SHA256=' + sha);
  console.log('BASE=' + man.base);
  console.log('PAYLOAD_BYTES=' + Buffer.byteLength(payload) + (Buffer.byteLength(payload) <= 1024 ? ' OK_UNDER_1KB' : ' WARN_OVER_1KB'));

  if (!doAnchor) { console.log('DRY_RUN (pass --anchor to send)'); return; }

  const res = await anchor(payload, { agentId: AGENT_ID, sha256: sha, base: man.base, free: man.freeEndpoints.length, paid: man.paidEndpoints.length });
  const v = await verify(res.hash, sha);
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), tx: res.hash, block: res.block, sha256: sha, base: man.base, verified: v.ok }) + '\n');
  const latest = { tx: res.hash, block: res.block, sha256: sha, base: man.base, address: ADDRESS, agentId: AGENT_ID, payload, verified: v.ok, at: new Date().toISOString() };
  fs.writeFileSync(path.join(DIR, 'CAPABILITY-LATEST.json'), JSON.stringify(latest, null, 2) + '\n');
  console.log('VERIFY_ONCHAIN=' + (v.ok ? 'PASS sha256_found_in_calldata' : 'FAIL ' + (v.error || 'mismatch')));
  console.log('DECODED=' + (v.text || '').slice(0, 200));
  process.exit(v.ok ? 0 : 1);
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
