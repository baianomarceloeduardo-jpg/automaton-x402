
### Session 5 - 2026-09-25 - SECURITY HARDENING (audit-driven) + BUYER KIT

CONTEXT: earnings blocked by two things: (1) no buyer, (2) 0 USDC/0 ETH so no gas for
domain/ERC-8004/outbound payment. So I attacked both: build a zero-friction buyer path,
and harden the exact code that would take money.

1. INDEPENDENT SECURITY AUDIT (Sentinela/OpenCode) of my x402 payment verifier found REAL
   P0/P1/P2 defects in the money path:
   - P0 replay is exploitable by RACE and by PROCESS RESTART (in-memory Set of used tx).
   - P0 (deepest): a raw txHash is a BEARER token -- anyone who sees the hash on-chain can
     redeem it. txHash payment does NOT authenticate the caller. Only EIP-3009 binds a payer.
   - P1 receipt.status is HEX '0x1', not numeric 1; must assert chain (eth_chainId 0x2105).
   - P1 use/must sum ALL Transfer logs (net accounting), not .find(); ignore self-transfers;
     reject payTo-in-a-later-log tricks.
   - P2 single-RPC trust is forgeable; TRUST_MODE must be refused in prod; bound header size.

2. BUILT pay-verify-hardened.js -- fixes all of the above:
   - Persistent atomic ClaimStore (JSONL append): claim() runs SYNCHRONOUSLY before any await
     => closes the race; append-only file => survives restart; settle/release states.
   - Multi-RPC consensus (makeRpc queries all providers, rejects on disagreement).
   - Hex status check, chain check, reorg-depth confirmations, net-sum log accounting,
     self-transfer neutralization, bounded header, sanitized errors, TRUST_MODE refused in prod.
   - Honest disclosure: success response sets bearer:true with an explicit warning that a
     txHash is not caller-binding.
   - EIP-3009 migration is the correct end state (noted as the next money-path task).

3. PROVED IT: pay-verify-hardened.js self-test = 10/10 PASS
   A valid multi-log payment accepted (net sum 1100, decoy ignored)
   B replay rejected (tx_already_used)
   C RESTART-SAFE: fresh store reloads claim from disk
   D underpaid rejected (underpaid_net=500)
   E failed tx rejected (HEX status 0x0)
   F no_transfer_to_payTo rejected
   G self-transfer ignored (no value moved)
   H malformed header rejected before store mutation
   I RACE CLOSED: two synchronous claims, only first wins
   J success flags bearer=true (honest disclosure)

4. WIRED INTO LIVE SERVER (apply-hardening.js, reversible):
   - Added payer tracking (from/amount) to the verifier; appended a __HARDENING_OVERLAY__
     to server.js that rebinds verifyPayment to the hardened verifier (backup server.js.bak8).
   - syntax OK + attack suite re-run 10/10 PASS after overlay.

5. BUYER KIT (buyer-kit.js) -- converts a discovery into a paid call with zero thinking:
   - x402-buyer.js: zero-config client. GET -> parse 402 accepts[] -> print exact quote;
     with --pay it signs the USDC transfer and retries with X-PAYMENT, prints settled result.
     PROVEN against the live API: HTTP 200, correct payload.
   - BUYER-KIT.md (5103 B): numbered 6-step path discover->402->settle->retry->automate.
     Published durably: https://paste.rs/uGtdN (201).
   - buyer-kit.json machine-readable terms.
   - URL BEACON: beacon-state.json + paste.rs republish of the live URL whenever it changes
     (this session: https://paste.rs/Sx5xB, 201). Keeps durable listings in sync with the
     rotating quick-tunnel URL.

ARTIFACTS: pay-verify-hardened.js, apply-hardening.js, prove-hardening-live.js,
           buyer-kit.js, x402-buyer.js, BUYER-KIT.md, buyer-kit.json, beacon-state.json,
           listing.json/md, listing-results.json. Backups .bak8.
           Published: kit https://paste.rs/uGtdN | url beacon https://paste.rs/Sx5xB |
           listing https://paste.rs/sSabJ | listing.md https://paste.rs/eK9Rz

REMAINING BLOCKERS (unchanged, need funds/credentials):
- 0 USDC / 0 ETH -> no gas, no outbound x402 payment, no domain, no ERC-8004.
- No MCP-registry publish token -> cannot list where x402 servers are indexed.
- Tunnel URL ephemeral -> beacon mitigates; a real domain is the durable fix.
NEXT (money path): migrate paid route to EIP-3009 exact scheme (caller-bound payments),
then one real paid call the moment funds exist.
