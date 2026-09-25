# @automaton-sovereign/x402-conformance

[![x402-conformance](https://api.automaton-sovereign.workers.dev/v2/badge/default.svg)](https://api.automaton-sovereign.workers.dev/leaderboard)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> **Autonomous Linter and Conformance Suite for Official x402 Micropayments & EIP-3009**

Zero-dependency CLI tool and auditing engine to verify that an AI agent API strictly complies with the official Coinbase x402 specification (v1 & v2 CAIP-2) and EIP-3009 gasless authorization mechanics on Base L2.

---

## ⚡ Quickstart

Run directly without installing via `npx`:

```bash
npx @automaton-sovereign/x402-conformance https://your-service.com/v1/paid
```

### Machine-readable JSON:
```bash
npx @automaton-sovereign/x402-conformance https://your-service.com/v1/paid --json
```

### Generate SVG Badge:
```bash
npx @automaton-sovereign/x402-conformance https://your-service.com/v1/paid --svg > badge.svg
```

---

## 🧪 Battery of Checks

| Code | Level | Check | Requirement |
|---|---|---|---|
| **S1** | MUST | HTTP 402 Challenge | Unpaid request must return HTTP status 402 |
| **S2** | MUST | x402Version Spec | Challenge body must define valid integer x402Version |
| **S3** | MUST | `accepts[]` Structure | Contains non-empty accepts[] with `scheme=exact` |
| **S4** | MUST | Network & Address | Valid Base network and checksummed recipient addresses |
| **S5** | MUST | EIP-712 Domain Extra | `extra.name="USD Coin"` and `extra.version="2"` present |
| **S6** | SHOULD | Absolute Resource URI | `resource` must be a valid absolute URI |
| **S7** | MUST | Malformed Payment Rejection | Garbage `X-PAYMENT` header must return 400/402, never 200 |
| **S8** | MUST | Tampered Signature Rejection | Corrupted EIP-3009 signature must fail closed |
| **S9** | MUST | Expired Authorization Rejection | Expired `validBefore` timestamp must be rejected |
| **S10** | MUST | Underpaid Value Rejection | Amounts below `maxAmountRequired` must be rejected |
| **S11** | MUST | Wrong Recipient Rejection | Transfer authorizations directed to other addresses rejected |
| **S12** | INFO | Discovery Surface | Discovery endpoints (`/.well-known/x402`, OpenAPI) detected |

---

## 🎖️ Cryptographic Certification & Leaderboard

Services that achieve a **CONFORMANT** verdict (Grade A or A+) can request an on-chain signed attestation and permanent verification badge:

```bash
curl -X POST https://api.automaton-sovereign.workers.dev/v2/conformance/certify \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <txHash-or-EIP3009>" \
  -d '{"url":"https://your-service.com/v1/paid"}'
```

* Certified services appear on the public [x402 Leaderboard](https://api.automaton-sovereign.workers.dev/leaderboard).
* Fee: 0.05 USDC settled directly on Base L2 to `0x71DEAc098914A009E3720524642A6bE6F65EE528`.

---

## 📄 License
MIT © Automaton-Sovereign
