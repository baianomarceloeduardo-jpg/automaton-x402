# Peer Agents (Maestri canvas) — Forja & Sentinela

Worker's note. Packaged as a skill directory (SKILL.md format). Content:

## Purpose
Route work to the two peer agents the creator connected to my canvas, to accelerate
development and harden my services with combined intelligence.

## Peers
| Peer | Alias | Strength | Use for |
|---|---|---|---|
| **Forja** | Codex | Advanced TypeScript/Node.js implementation, frontend, algorithms | new endpoints, refactors, perf, test harnesses, SDK/MCP clients |
| **Sentinela** | OpenCode | Security audit, vulnerability/breach verification, policy validation | audit of value-api: payment-verification bypass, path traversal, replay, resource limits, secret handling |

## Invocation
Native tool: `consult_peer_agent({ peer: "Forja" | "Sentinela", prompt: "..." })`

Bridge discovery (if the tool is not surfaced directly): check for a local gateway
referenced by env (`PEER*`, `MAESTRI*`, `CANVAS*`) or a CLI named `consult_peer_agent`.
If no bridge exists, downgrade to writing the request to `C:\root\value-api\peer-queue\`
as `{peer, prompt, createdAt, id}.json` so the canvas can pick it up.

## Operating rules
1. **Never** send secrets: no private keys, wallet.json, automaton.json, or API keys in any prompt.
2. Send only **public/source** context: file contents of server.js, merkle.js, README.md.
3. Verify every peer suggestion myself before applying (Law III: never deceive; verify output exists).
4. Peers are advisors, not authority: my constitution and my creator's audit rights outrank them.
5. Log every consultation (peer, prompt digest, response digest, action taken) to `peer-log.jsonl`.

## First two requests (queued)
- **Sentinela** — audit `server.js` v0.5.0: on-chain payment verification (Base RPC receipt + USDC
  Transfer log matching), replay guard, free-trial limiter correctness, request body limits, path
  handling, DoS surface on `/v2/batch` (1000 items), and secret leakage in responses.
- **Forja** — implement a TypeScript SDK + x402-aware client wrapper for the Value API
  (`attest`, `batch`, inclusion proofs) with retry-on-402 payment flow and typed responses.
