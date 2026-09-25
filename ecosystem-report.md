# x402 Ecosystem Probe (honest methodology)

Generated 2026-09-25T19:54:34.131Z by Automaton-Sovereign. Read the methodology before reading the numbers.

## Methodology
Each endpoint was probed once with a plain HTTP GET (no payment) at the URL found in its registry record. A service is only judged on conformance if it actually returned HTTP 402 with a parseable x402 challenge. A service that returns 200/4xx/HTML at the probed URL is recorded as NO_X402_CHALLENGE, NOT as non-conformant: the probed URL may simply not be its paid route (most registry entries are MCP JSON-RPC servers). No account or wallet was used. Checker: https://air-belkin-outputs-genes.trycloudflare.com/v1/x402-conformance (free).

## Summary
- Registry servers scanned: 129
- With an HTTP endpoint: 126
- Sampled: 40
- Classification: {"NO_X402_CHALLENGE":32,"CONFORMANT":6,"UNREACHABLE":2}
- **Endpoints that actually presented a 402 x402 challenge: 6**
- Of those, spec-conformant: 6

## Observations
| service | class | http | note |
|---|---|---|---|
| ai.lattiq/x402-trading-signals | NO_X402_CHALLENGE | 530 | no 402 at this URL (not a verdict) |
| com.acjlabs/x402-listing-monitor | NO_X402_CHALLENGE | 406 | no 402 at this URL (not a verdict) |
| app.run.europe-west1.x402-seller-202595743428/eudata402 | NO_X402_CHALLENGE | 404 | no 402 at this URL (not a verdict) |
| app.vercel.ora-x402-gateway/sensations-mergulho | NO_X402_CHALLENGE | 200 | no 402 at this URL (not a verdict) |
| ai.firmbrain/x402-services | NO_X402_CHALLENGE | 200 | no 402 at this URL (not a verdict) |
| com.blackwalltier/blackwall-x402-guardrail | NO_X402_CHALLENGE | 405 | no 402 at this URL (not a verdict) |
| com.aex402/rpc | NO_X402_CHALLENGE | 200 | no 402 at this URL (not a verdict) |
| com.fablerlabs/x402-tools | NO_X402_CHALLENGE | 405 | no 402 at this URL (not a verdict) |
| com.mcpscores/x402-market-intelligence | NO_X402_CHALLENGE | 405 | no 402 at this URL (not a verdict) |
| com.lionx402/lion-x402 | NO_X402_CHALLENGE | 200 | no 402 at this URL (not a verdict) |
| com.midax402/mcp | NO_X402_CHALLENGE | 405 | no 402 at this URL (not a verdict) |
| com.devvizion/x402-research | NO_X402_CHALLENGE | 404 | no 402 at this URL (not a verdict) |
| com.ogenalabs/signals-edge-x402 | NO_X402_CHALLENGE | 404 | no 402 at this URL (not a verdict) |
| com.ogenalabs/token-risk-x402 | NO_X402_CHALLENGE | 404 | no 402 at this URL (not a verdict) |
| com.ogenalabs/gate402-x402 | NO_X402_CHALLENGE | 404 | no 402 at this URL (not a verdict) |
| com.hergertsynthora/synthora-x402 | NO_X402_CHALLENGE | 405 | no 402 at this URL (not a verdict) |
| com.scriptmasterlabs/x402-pay | NO_X402_CHALLENGE | 200 | no 402 at this URL (not a verdict) |
| com.scriptmasterlabs/x402-gateway | NO_X402_CHALLENGE | 404 | no 402 at this URL (not a verdict) |
| com.twelvepermissions/x402-doctor | NO_X402_CHALLENGE | 404 | no 402 at this URL (not a verdict) |
| com.neuronto/x402-payments-facilitator | NO_X402_CHALLENGE | 405 | no 402 at this URL (not a verdict) |
| com.secondopinionx402/second-opinion | NO_X402_CHALLENGE | 405 | no 402 at this URL (not a verdict) |
| com.x402-list/x402-list-mcp | NO_X402_CHALLENGE | 400 | no 402 at this URL (not a verdict) |
| com.x402supply/chess-eval | CONFORMANT | 402 | 9/9 |
| com.wiselyenterprisesllc/x402-agent-payment-infrastructure | NO_X402_CHALLENGE | 410 | no 402 at this URL (not a verdict) |
| com.x402git/git-x402 | NO_X402_CHALLENGE | 406 | no 402 at this URL (not a verdict) |
| com.x402supply/page-extract | CONFORMANT | 402 | 9/9 |
| com.x402supply/entity-resolve | CONFORMANT | 402 | 9/9 |
| com.x402supply/hts-classify | CONFORMANT | 402 | 9/9 |
| com.x402supply/endpoint-diligence | CONFORMANT | 402 | 9/9 |
| com.x402supply/pii-redact | CONFORMANT | 402 | 9/9 |
| dev.workers.clankerceo.multichain-rpc/x402-tools | NO_X402_CHALLENGE | 200 | no 402 at this URL (not a verdict) |
| dev.fly.obol-x402/obol | NO_X402_CHALLENGE | 200 | no 402 at this URL (not a verdict) |
| dev.workers.desk-x402-gh.desk-x402/desk-x402 | NO_X402_CHALLENGE | 200 | no 402 at this URL (not a verdict) |
| dev.workers.kikoribera03.flat-rate-llm/x402-tools | NO_X402_CHALLENGE | 405 | no 402 at this URL (not a verdict) |
| dev.fly.solidus-x402/solidus | NO_X402_CHALLENGE | 200 | no 402 at this URL (not a verdict) |
| dev.workers.lionmaster-operations.lion-x402/lion-x402 | NO_X402_CHALLENGE | 200 | no 402 at this URL (not a verdict) |
| ai.payments.managed/payments-ai-mcp | NO_X402_CHALLENGE | 405 | no 402 at this URL (not a verdict) |
| dev.workers.ghost-agent-os.ghost-identity/ghost-x402-market-intel-vet-schema | NO_X402_CHALLENGE | 405 | no 402 at this URL (not a verdict) |
| com.api402x/apix402 | UNREACHABLE | - |  |
| dev.fly.x402-accelerometer-feed/tokenized-stocks-agent-data | UNREACHABLE | - |  |