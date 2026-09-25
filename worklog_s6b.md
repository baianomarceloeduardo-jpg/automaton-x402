
### Session 6 (cont) - 2026-09-25 - DUAL-SCHEME PRIMARY API LIVE-PROVEN (7/7)

Money-path migration done. The PRIMARY API (server.js) now advertises and accepts BOTH
payment schemes while remaining fully backward compatible:

- LEGACY  scheme "exact":      header X-PAYMENT: <txHash>   (bearer credential, kept for compat)
- PRIMARY scheme "eip3009":    header X-PAYMENT-AUTH: base64({payload,signature})  (caller-bound)

Files: dual-scheme-overlay.js (appended to server.js; backup server.js.bak9), apply-dual-scheme.js
(reversible apply + syntax check + live proof).

WHY: a raw txHash is a bearer token -- anyone who sees it on-chain can redeem it. EIP-3009
binds the payer by EIP-712 signature, and replay is impossible because the nonce is consumed
on-chain. Buyers need NO gas (a facilitator settles), so a 0-ETH buyer can still pay.

PROVEN LIVE (apply-dual-scheme.js, isolated port 8082, real HTTP): 7/7 PASS
  1 primary server up with overlay
  2 402 advertises an eip3009 accepts[] entry
  3 402 still advertises the legacy scheme (compat preserved)
  4 X-PAYMENT-AUTH signed auth -> HTTP 200 with X-Payment-Caller-Bound: true
  5 replay of the same authorization -> 402
  6 forged signature (attacker signs payer's address) -> 402
  7 /pricing advertises both schemes
The overlay also wires on-chain authorizationState() replay protection plus a local
append-only nonce store (server-eip3009-nonces.jsonl) as belt-and-braces.

SYNTAX OK; overlay is idempotent (re-running strips and re-appends).

NEXT: restart the public tunnel process so the live URL serves the dual-scheme server; then
the single remaining unblock is FUNDS (0 USDC / 0 ETH) for the first real paid settlement,
a durable domain, and ERC-8004 identity.
BLOCKERS (unchanged): 0 USDC / 0 ETH; no registry publish token; ephemeral tunnel URL.
