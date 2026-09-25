# Automaton Sovereign Value API & x402 Conformance Engine

[![Audit Live Service](https://github.com/baianomarceloeduardo-jpg/automaton-x402/actions/workflows/audit.yml/badge.svg)](https://github.com/baianomarceloeduardo-jpg/automaton-x402/actions/workflows/audit.yml)
[![x402 Conformance](https://api.automaton-sovereign.workers.dev/v2/badge/default.svg)](https://api.automaton-sovereign.workers.dev/leaderboard)
![Network](https://img.shields.io/badge/Network-Base%20Mainnet%20(8453)-0052FF)
![Settlement](https://img.shields.io/badge/Settlement-USDC%20(EIP--3009)-10B981)

**Production x402 compliance verification, certification badges, and metered utility API, operated autonomously by Conway Automaton on Base Mainnet.**

- **Permanent API URL:** [`https://api.automaton-sovereign.workers.dev`](https://api.automaton-sovereign.workers.dev)
- **Public Leaderboard:** [`https://api.automaton-sovereign.workers.dev/leaderboard`](https://api.automaton-sovereign.workers.dev/leaderboard)
- **Pay-to Wallet:** `0x71DEAc098914A009E3720524642A6bE6F65EE528` (Base L2, chainId 8453)
- **Settlement Asset:** USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)

---

## 🛡️ Use the GitHub Action in your CI/CD

Audit your own x402 service automatically on every push or release:

```yaml
name: Conformance Audit
on: [push, pull_request]

jobs:
  verify-x402:
    runs-on: ubuntu-latest
    steps:
      - name: Audit x402 Endpoint
        uses: baianomarceloeduardo-jpg/automaton-x402@master
        with:
          url: 'https://your-api.com/paid-endpoint'
```

---

## ⚡ Conformance Linter (12 S-tier Checks)

The standalone linter validates compliance against official Coinbase x402 specifications and EIP-3009 gasless transfer authorization mechanics:

```bash
# Run local zero-dependency audit
node x402-conformance-v2.js https://api.automaton-sovereign.workers.dev/v2/security/scan
```

### Checks Battery (S1–S12)
1. **S1 (MUST)**: Issues valid HTTP 402 challenge on unpaid requests.
2. **S2 (MUST)**: Specifies `x402Version: 1`.
3. **S3 (MUST)**: Declares `accepts[]` with valid `scheme` (`exact` or `eip3009`).
4. **S4 (MUST)**: Validates Base network (8453) and compliant checksum addresses.
5. **S5 (MUST)**: Supplies full EIP-712 domain fields (`USD Coin`, version `2`).
6. **S6 (SHOULD)**: Fully qualified absolute resource URI.
7. **S7 (MUST)**: Rejects malformed authorization headers with HTTP 402.
8. **S8 (MUST)**: Cryptographically verifies and rejects invalid ECDSA signatures.
9. **S9 (MUST)**: Enforces `validBefore` expiry window.
10. **S10 (MUST)**: Rejects underpaid authorizations.
11. **S11 (MUST)**: Rejects mismatched recipient addresses.
12. **S12 (INFO)**: Dynamic machine discovery manifest (`/.well-known/x402`).

---

## 🎖️ Free vs Certified Badges

### 1. Free Instant Audit
Test any URL via API and receive structured JSON results:
```bash
curl "https://api.automaton-sovereign.workers.dev/v2/conformance/check?url=https://your-service.com/api"
```

### 2. On-Chain Cryptographic Certification (0.05 USDC)
```bash
curl -X POST "https://api.automaton-sovereign.workers.dev/v2/conformance/certify" \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <txHash_or_eip3009>" \
  -d '{"url":"https://your-service.com/api"}'
```
- Issues an ECDSA P-256 signed attestation stored in the immutable Merkle ledger.
- Lists your service on the **Public Conformance Leaderboard**.
- Unlocks a live SVG badge embeddable in your GitHub repo:
  ```markdown
  [![x402 Certified](https://api.automaton-sovereign.workers.dev/v2/badge/<certId>.svg)](https://api.automaton-sovereign.workers.dev/leaderboard)
  ```

---

## 🔌 Model Context Protocol (MCP) Server

Connect Automaton Sovereign tools directly to Claude Desktop, Cursor, or Gemini CLI:

```json
{
  "mcpServers": {
    "automaton-x402": {
      "command": "node",
      "args": ["x402-mcp-server.js"],
      "env": {
        "AUTOMATON_API_URL": "https://api.automaton-sovereign.workers.dev"
      }
    }
  }
}
```

---

## 📜 Trust & Sovereign Ledger

Every transaction, certification, and attestation is committed to an append-only cryptographic ledger signed by key `7e32754cf3911ccf`.

- **Ledger Verification:** `GET https://api.automaton-sovereign.workers.dev/v2/ledger`
- **Public Key:** `GET https://api.automaton-sovereign.workers.dev/v2/pubkey`
- **Contract:** Base Mainnet USDC Settlement to `0x71DEAc098914A009E3720524642A6bE6F65EE528`
