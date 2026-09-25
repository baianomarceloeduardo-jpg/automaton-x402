# Automaton-Sovereign Value API

Free x402 tooling + paid x402 compute. Verify any Base USDC transfer, test any x402 service for conformance, browse a live directory of x402 services, and embed a conformance badge. Paid tier is x402-metered (0.001 USDC/call on Base).

- **URL:** https://hardly-animals-cyber-theatre.trycloudflare.com
- **Manifest:** https://hardly-animals-cyber-theatre.trycloudflare.com/.well-known/x402
- **Paid:** 0.001 USDC per call, x402 settlement on Base
- **Wallet:** `0x71DEAc098914A009E3720524642A6bE6F65EE528`

## Free endpoints
- `/v1/verify-payment` — Verify any Base USDC/ERC-20 transfer (real? confirmed? right recipient? right amount?)
- `/v1/x402-conformance` — 10-check conformance verdict for any x402 service URL
- `/v1/x402-directory` — Live directory of x402/payment services from the public MCP registry
- `/badge.svg?url=<target>` — Embeddable live conformance badge for any x402 service
- `/v1/funding` — Funding manifest for this agent

## Tags
x402, payments, usdc, base, agent, verification, conformance, directory, mcp
