// patch-rpc-fallback.js — make verifyAnchor independent of rate-limited public RPCs.
//
// THE DEFECT (measured): /v1/resolve-base?tx=... took 5241ms and returned 400. 5.24s is exactly
// the RPC_MS budget, i.e. every public Base RPC timed out together (they rate-limit aggressively).
// So deterministic verification of my OWN anchor was failing for a reason that has nothing to do
// with the anchor being wrong. A verification path that depends on one class of flaky endpoint is
// not a verification path.
//
// FIX: (1) widen the RPC pool; (2) add an INDEPENDENT indexer fallback (Blockscout REST) that is a
// different host with a different failure mode; (3) never let a null/absent result be reported the
// same way as an RPC outage.
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const F = path.join(DIR, 'resolve-base.js');

let s = fs.readFileSync(F, 'utf8');
const before = s;

// 1. wider RPC pool
s = s.replace(
  "const RPCS = ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com'];",
  "const RPCS = ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://1rpc.io/base', 'https://base.blockpi.network/v1/rpc/public'];"
);

// 2. blockscout fallback helper + use it when RPC consensus yields nothing
const OLD = `  if (!tx.ok) return { ok: false, error: tx.error };
  const t = tx.result;
  if (!t) return { ok: false, error: 'tx_not_found' };`;

const NEW = `  // Independent indexer fallback: different host, different failure mode from raw RPC.
  if (!tx.ok || !tx.result) {
    const bs = await blockscoutTx(txHash);
    if (bs) {
      const text2 = hexToUtf8(bs.raw_input || bs.input || '0x');
      const base2 = parseAnchor(text2);
      if (!base2) return { ok: false, error: 'not_an_anchor', decoded: text2.slice(0, 120), viaIndexer: true };
      return {
        ok: true, base: base2, tx: txHash, anchorText: text2,
        from: (bs.from && (bs.from.hash || bs.from)) || null,
        to: (bs.to && (bs.to.hash || bs.to)) || null,
        blockNumber: bs.block_number || bs.blockNumber || null,
        status: bs.status === 'ok' ? '0x1' : (bs.status || null),
        confirmed: bs.status === 'ok',
        witnesses: ['base.blockscout.com (indexer fallback)'],
        howToVerify: 'eth_getTransactionByHash(' + txHash + ') on any Base RPC; utf8-decode input; expect prefix "' + PREFIX + '"'
      };
    }
    return { ok: false, error: tx.error || 'tx_not_found', rpcTried: RPCS.length };
  }
  const t = tx.result;`;

if (s.indexOf(OLD) === -1) { console.log('PATCH=NOOP reason=target_block_not_found'); process.exit(1); }
s = s.replace(OLD, NEW);

// 3. insert the helper before verifyAnchor
s = s.replace(
  '// DETERMINISTIC, now CONCURRENT: verify a tx really is an anchor, from chain.',
  `// Independent indexer read (Blockscout Base). Returns null on any failure — never throws.
function blockscoutTx(txHash) {
  return new Promise((resolve) => {
    const url = 'https://base.blockscout.com/api/v2/transactions/' + txHash;
    let u; try { u = new URL(url); } catch (e) { return resolve(null); }
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => fin(null), 6000);
    const req = https.get({ hostname: u.hostname, path: u.pathname, timeout: 6000,
      headers: { 'user-agent': 'automaton-resolve-base/1.6', accept: 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { clearTimeout(timer); let j = null; try { j = JSON.parse(d); } catch (_) {} fin((j && (j.hash || j.raw_input)) ? j : null); });
    });
    req.on('error', () => { clearTimeout(timer); fin(null); });
    req.on('timeout', () => { req.destroy(); clearTimeout(timer); fin(null); });
  });
}

// DETERMINISTIC, now CONCURRENT: verify a tx really is an anchor, from chain.`
);

if (s === before) { console.log('PATCH=NOOP reason=no_change'); process.exit(1); }
fs.writeFileSync(F, s);
fs.writeFileSync(F + '.bak-rpcfb', before);
try { require(F); console.log('PATCH=APPLIED syntax=OK rpcs=6 blockscoutFallback=yes bytes=' + s.length); }
catch (e) { fs.writeFileSync(F, before); console.log('PATCH=REVERTED syntax_error=' + e.message); process.exit(1); }
