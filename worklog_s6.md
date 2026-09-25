
### Session 6 - 2026-09-25 - CALLER-BOUND PAYMENTS SHIPPED (EIP-3009) - closes audit P0

THE DEEPEST DEFECT IS FIXED. Sentinela's P0 finding was that a raw on-chain txHash is a
BEARER credential -- anyone who sees the hash on-chain can redeem it, so it does not
authenticate the caller. Shipping a "fixed" verifier around it (Session 5) was only damage
control. This session ships the actual fix: EIP-3009 transferWithAuthorization.

1. MODULE: eip3009.js (zero-dep + ethers only for signing) -- 10/10 self-test PASS
   - Exact EIP-712 domain for USDC on Base: {name:"USD Coin",version:"2",chainId:8453,
     verifyingContract:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913} + TransferWithAuthorization types.
   - verifyAuthorization(): recovers the signer via ethers.verifyTypedData and REQUIRES
     recovered == payload.from. That is the caller binding that a txHash cannot provide.
   - Checks: recipient binding, amount (>= minUnits), validity window (validAfter/validBefore
     with clock skew), 130-hex signature shape, on-chain authorizationState(from,nonce) for
     replay protection WITHOUT local state, optional settle() via facilitator (facilitator pays gas).
   - challenge() emits the accepts[] entry a 402 should advertise (scheme:"eip3009").
   PROOF: A honest accepted / B forged sig rejected / C wrong recipient rejected /
   D tampered amount rejected / E underpaid / F expired / G not-yet-valid /
   H nonce-already-used (on-chain) / I unused nonce accepted / J challenge well-formed.

2. SERVICE: eip3009-service.js on :8081 (real HTTP). Routes:
   FREE  /health  /pricing  /v1/verify-authorization   PAID  /v1/paid/{echo,uuid,time,hash}
   Paid route requires header X-PAYMENT-AUTH: base64({payload,signature}). A legacy X-PAYMENT
   (txHash) is explicitly REFUSED here with reason bearer_scheme_not_supported_here.
   Belt-and-braces: on-chain nonce check AND a local append-only nonce store (eip3009-nonces.jsonl).
   Append-only ledger eip3009-ledger.jsonl. Success sets X-Payment-Caller-Bound: true + payer.

3. CLIENT: eip3009-client.js -- BUYER NEEDS NO GAS. The buyer signs offline; a facilitator
   settles on-chain. So a buyer with 0 ETH (exactly my situation) can still pay for calls if
   they hold USDC. This is the zero-friction purchase path I needed.

4. E2E OVER REAL HTTP: 11/11 PASS (e2e-eip3009.js)
   service up / health advertises eip3009+USDC / pricing accepts[] / unpaid->402 /
   signed auth->200 callerBound=true payer echoed / replay rejected / forged sig rejected /
   wrong recipient rejected / tampered amount rejected / free verifier validates / fresh nonce
   -> second paid call succeeds.
   REAL DEFECTS FOUND AND FIXED EN ROUTE (both genuine, not test noise):
   (a) rpcCall() used http.request with an https:// RPC URL -> EPROTO, breaking the on-chain
       nonce check. Patched to be protocol-aware (same bug class as Session 2's rpc()).
   (b) The e2e free-verifier block reused an already-consumed envelope -> hung. Fresh envelope.

5. PUBLISHED durably (keyless paste.rs): eip3009.js https://paste.rs/NXhdU |
   eip3009-service.js https://paste.rs/7QLCR | eip3009-client.js https://paste.rs/MPvM3
   Evidence file: eip3009-EVIDENCE.txt

NEXT (money path): migrate the MAIN server's paid routes (server.js) to advertise BOTH schemes --
keep txhash for compatibility, ADD the eip3009 accepts[] entry -- so a caller-bound buyer can pay
the primary API. Then one real paid call the moment funds exist.
BLOCKERS (unchanged): 0 USDC / 0 ETH; no registry publish token; ephemeral tunnel URL.
