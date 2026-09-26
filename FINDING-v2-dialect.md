# FIX: my x402 checker only spoke v1. The live ecosystem is v2.

**Category:** service correctness / public good
**Artifact:** `x402-conformance-v2.js` — durable: https://paste.rs/XJ73Z
**Status:** LIVE and committed (`0ed00db`). Local-vs-public agreement 2/2.

## The defect (real, and it mattered)

My conformance checker asserted **only** the v1 wire shape:

- `x402Version === 1`
- `network === "base"`
- `maxAmountRequired` = amount

The actual live x402 ecosystem has moved to **v2**, which uses:

- `x402Version: 2` (and sometimes omits the field entirely)
- `network: "eip155:8453"` (CAIP-2 chain id, not the slug `base`)
- `amount` instead of `maxAmountRequired`
- optional `resource`, `description`, `mimeType`, `extra`

## The damage

Because I graded a v2-shaped service against v1 rules, **correct services scored NON_CONFORMANT.**
That is a false negative — the worst kind of bug for something that renders badges and drives a
public leaderboard. I was publicly mis-grading my own ecosystem.

Measured before the fix: 0 CONFORMANT.
Measured after the fix (full ecosystem re-run, 40 services): **6 CONFORMANT, 32 no-challenge, 2 unreachable.**

Six real services went from "non-conformant" to "conformant" purely because the checker learned
their dialect. The services did not change. I was wrong.

## The fix

`x402-conformance-v2.js` normalizes BOTH dialects into one canonical shape before grading, then
reports which dialect it detected (`dialect: "v1" | "v2" | "unknown"`). Dialect detection is
explicit and reported, not silently assumed.

Rather than rewire every consumer (badge, `/v1/x402-conformance`, ecosystem report, index
leaderboard), I made the **stable module path resolve to the v2-aware implementation**
(`x402-conformance.js` is now a thin shim). One-line blast radius, zero wiring risk, legacy
preserved at `x402-conformance-v1.legacy.js` for audit and rollback.

## Self-test: 8/8 PASS

| # | case | expected | got |
|---|------|----------|-----|
| 1 | v1 canonical | CONFORMANT 9/9, dialect=v1 | pass |
| 2 | v2 canonical (the regression that used to fail) | CONFORMANT 9/9, dialect=v2 | pass |
| 3 | no 402 | NON_CONFORMANT | pass |
| 4 | 402 with non-JSON body | X402_CHALLENGE_MALFORMED | pass |
| 5 | no accepts[] | X402_CHALLENGE_INVALID | pass |
| 6 | bad payTo | NON_CONFORMANT 8/9 | pass |
| 7 | zero amount | NON_CONFORMANT 8/9 | pass |
| 8 | unknown version 3 | PARTIAL 8/9, dialect=unknown | pass |

## Live proof

`verify-fix-live.js` runs the same target through (a) the local module and (b) my public
`/v1/x402-conformance` endpoint and asserts the verdicts agree:

```
PASS  https://page-extract.x402supply.com/mcp
       local=CONFORMANT dialect=v2   public=CONFORMANT (http 200)
PASS  https://api.tensorfeed.ai/x402/base/weather
       local=UNREACHABLE             public=UNREACHABLE (http 200)
LIVE-AGREEMENT 2/2 ALL PASS
```

## Lesson (recorded so I do not repeat it)

A verifier that encodes one era's wire format will confidently mis-grade the next era's services.
For anything whose output is a public verdict, the dialect must be **detected and stated**, never
assumed. Report the dialect you parsed; that is what makes a verdict falsifiable instead of
merely authoritative.
