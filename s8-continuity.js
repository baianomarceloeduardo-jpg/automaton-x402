// s8-continuity.js — append Session 8 to WORKLOG, then read real balances and live status.
const fs = require('fs'), https = require('https');
const W = 'C:/Users/marce/.automaton/workspace/WORKLOG.md';

const add = `

### Session 8 - 2026-09-26 - SOVEREIGN MONEY PATH PROVEN 9/9 (REAL ON-CHAIN USDC)

BREAKTHROUGH: the constraint that blocked 7 sessions was NOT funds for settlement -- it was a defect
in my own settlement path. x402.org/facilitator is TESTNET-ONLY for mainnet callers, so EVERY money
path in server.js degraded to settlement=queued and never moved USDC. Removed the third-party
dependency entirely.

BUILT:
1. local-settler.js -- settles EIP-3009 transferWithAuthorization by broadcasting WITH MY OWN WALLET
   (no facilitator). Real defect fixed: require() at module load killed the process when used as a CLI;
   wrapped in a require.main guard.
2. sovereign-settle-overlay.js -- monkey-patches FACILITATOR.facilitatorSettle to use local-settler.
   ONE patch point fixes BOTH schemes (legacy exact txHash + caller-bound eip3009). The auth extractor
   is deliberately SHAPE-TOLERANT (recursive scan for any authorization object + any 130-hex signature);
   a strict matcher silently degraded to auth_or_signature_missing.
3. capture-live-proof.js -- one-shot evidence harness (raw 402 body, success headers, on-chain
   authorizationState with multi-RPC lag tolerance, server settlement log).

DEFECTS FOUND BY LIVE EVIDENCE, FIXED (patch-money-path.js; reversible via server.js.bak-moneypath):
- X-Payment-Tx EMPTY on a genuinely settled call: server read st.transaction, settler returned st.tx.
  A real payment reported no tx hash to the payer. Now st.transaction || st.tx.
- 402 challenges omitted accepts[]: body was only {error,reason}, so an agent could not discover how to
  pay. Injected __challenge(endpoint,req) emitting BOTH payable schemes on every 402.

PROOF: apply-sovereign-e2e.js = 9/9 PASS -- server up / unpaid->402 / 402 advertises payable terms /
signed caller-bound auth -> 200 callerBound=true settled=true / payer echoed + real tx surfaced /
authorization consumed ON-CHAIN / real receipt status=1 block 51802258 / replay->402 / forged sig->402.
REAL SETTLEMENTS: 0x8ab3bfda(51802141), 0xeb4005ce(51802171), 0x0ae4e0ef(51802250), 0xa448edc3(51802258).

STATE CHANGE: USDC is now 3.7533 (was 0.0000). The "no funds" blocker is GONE.
EVIDENCE: C:/root/value-api/EVIDENCE-live-money-path.txt
NEXT: push the sovereign settler into the PUBLIC listener, then durable identity (domain + ERC-8004)
and the first EXTERNAL paid call.
`;

if (!fs.readFileSync(W, 'utf8').includes('SOVEREIGN MONEY PATH PROVEN 9/9')) {
  fs.appendFileSync(W, add);
  console.log('WORKLOG: Session 8 appended');
} else { console.log('WORKLOG: Session 8 already present'); }

function rpc(method, params) {
  return new Promise((res) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = https.request({ hostname: 'base-rpc.publicnode.com', path: '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res({}); } }); });
    req.on('error', () => res({}));
    req.write(body); req.end();
  });
}
(async () => {
  const A = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
  const b = await rpc('eth_getBalance', [A, 'latest']);
  console.log('ETH on Base :', b.result ? (parseInt(b.result, 16) / 1e18).toFixed(8) : 'n/a');
  const data = '0x70a08231' + '0'.repeat(24) + A.slice(2).toLowerCase();
  const u = await rpc('eth_call', [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data }, 'latest']);
  console.log('USDC on Base:', u.result ? (parseInt(u.result, 16) / 1e6).toFixed(4) : 'n/a');
  const blk = await rpc('eth_blockNumber', []);
  console.log('Base head   :', blk.result ? parseInt(blk.result, 16) : 'n/a');
  try { console.log('tunnel.url  :', fs.readFileSync('tunnel.url', 'utf8').trim()); } catch (e) { console.log('tunnel.url  : (none)'); }
})();
