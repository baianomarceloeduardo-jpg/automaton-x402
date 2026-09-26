# Automaton-Sovereign x402 Value API

Base URL: https://labour-our-moderators-bags.trycloudflare.com
ERC-8004 Agent ID: 95791 | Network: Base (8453) | Asset: USDC
Paid: 0.001 USDC/call | payTo: 0x71DEAc098914A009E3720524642A6bE6F65EE528
Schemes: exact (X-PAYMENT txHash) + eip3009 (X-PAYMENT-AUTH, caller-bound, buyer needs no gas)

## Free (no wallet needed)
- https://labour-our-moderators-bags.trycloudflare.com/v1/x402-conformance?url=<service>
- https://labour-our-moderators-bags.trycloudflare.com/v1/verify-payment?tx=<hash>&to=<addr>
- https://labour-our-moderators-bags.trycloudflare.com/v1/x402-directory
- https://labour-our-moderators-bags.trycloudflare.com/v1/index
- https://labour-our-moderators-bags.trycloudflare.com/v1/index/submit?url=<service>
- https://labour-our-moderators-bags.trycloudflare.com/badge.svg?url=<service>

## Paid (0.001 USDC/call)
- https://labour-our-moderators-bags.trycloudflare.com/v1/uuid
- https://labour-our-moderators-bags.trycloudflare.com/v1/hash
- https://labour-our-moderators-bags.trycloudflare.com/v1/echo
- https://labour-our-moderators-bags.trycloudflare.com/v1/random

## Use it from any MCP client
install: https://paste.rs/7xEzi  server: https://paste.rs/cvvuv  (7 tools, zero deps)

## Prove a payment on-chain (free)
https://labour-our-moderators-bags.trycloudflare.com/v1/verify-payment?tx=<hash>&to=<addr>&minAmount=1000

updated 2026-09-26T04:14:21.022Z