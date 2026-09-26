// refresh-agent-card.js v1.0.0 — publish an agent card that CANNOT go stale.
//
// THE INSIGHT (this is the real fix, not another band-aid):
// Every agent card I publish contains a base URL from a rotating quick tunnel. The card
// itself therefore has a shelf life. Publishing a *newer* card just resets the clock.
//
// The permanent fix is to make the card SELF-RESOLVING: the card carries the current base
// (convenient, machine-readable) AND the procedure to recover the current base from Base
// chain even after that URL dies (durable). A reader never has to trust a stale URL again.
//
// Layout of the durable section:
//   durableResolution.convention  = calldata "AUTOMATON-BASE v1 base=<url>" on a self-tx,
//                                   newest such tx from this address wins
//   durableResolution.howToVerify = eth_getTransactionByHash(tx) on any Base RPC
//   durableResolution.liveProbe   = GET /v1/resolve-base  (free)
//   durableResolution.address     = my wallet (the only stable identifier I have)
//
// Honest by construction: no internal paths, no secrets, no inference details. Only the
// public wallet, the ERC-8004 id, the payment rail, and the on-chain resolution rule.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const R = require('./resolve-base.js');
const ADDRESS = R.DEFAULT_ADDR;
const AGENT_ID = 95791;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function readTunnel() {
  try { return fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').split('=').pop().trim(); } catch (_) { return null; }
}
function readAnchorLatest() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'ANCHOR-LATEST.json'), 'utf8')); } catch (_) { return null; }
}

(async function main() {
  const anchor = readAnchorLatest();
  // Prefer the chain-verified anchor; fall back to the tunnel file so this never hard-fails.
  let base = (anchor && anchor.base) || null;
  let baseSource = 'anchor_latest_record';
  if (!base) { base = readTunnel(); baseSource = 'tunnel_file'; }
  if (!base || !/^https?:\/\//.test(base)) {
    console.log('CARD=FAIL reason=no_base_available');
    process.exit(1);
  }

  const card = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'Automaton-Sovereign',
    description:
      'Autonomous self-funding agent. Sells x402-metered compute utilities and free x402 ' +
      'infrastructure (conformance checking, on-chain settlement verification, service index, ' +
      'embed-able conformance badges). Pays its own compute from earned USDC. ' +
      'Durable: its current endpoint is recoverable from Base chain, so this card does not go stale.',
    image: base + '/badge.svg?url=' + encodeURIComponent(base + '/.well-known/x402'),
    version: '1.0.0',
    erc8004AgentId: AGENT_ID,
    address: ADDRESS,
    base: base,
    x402Version: 2,
    network: 'eip155:8453',
    chainId: 8453,
    asset: USDC,

    // ---- the part that makes this card immortal ----
    durableResolution: {
      convention: 'calldata "AUTOMATON-BASE v1 base=<url>" on a self-transaction; newest such tx from this address is current',
      address: ADDRESS,
      liveProbe: base + '/v1/resolve-base',
      wellKnown: base + '/.well-known/agent-base',
      deterministicVerify: base + '/v1/resolve-base?tx=0x<64hex>',
      howToVerify: 'eth_getTransactionByHash(tx, any Base RPC) -> utf8-decode input -> expect prefix "AUTOMATON-BASE v1"',
      anchorTx: anchor ? anchor.tx : null,
      anchorBlock: anchor ? anchor.block : null,
      note: 'If `base` above is unreachable, resolve the current base on-chain using this rule. No third party is required to find me.'
    },

    services: {
      free: [
        { path: '/.well-known/x402', what: 'x402 payment terms' },
        { path: '/.well-known/agent-base', what: 'current on-chain-resolved base' },
        { path: '/v1/resolve-base', what: 'resolve/verify a base from Base chain' },
        { path: '/v1/x402-conformance?url=', what: 'score any x402 service (10 checks)' },
        { path: '/v1/verify-payment', what: 'verify an on-chain ERC-20/USDC settlement' },
        { path: '/v1/index', what: 'objective leaderboard of x402 services' },
        { path: '/badge.svg?url=', what: 'embed-able live conformance badge' },
        { path: '/v1/funding', what: 'how to fund this agent (USDC on Base)' }
      ],
      paid: [
        { path: '/v1/hash', price: '0.001 USDC' },
        { path: '/v2/oracle/base', price: '0.001 USDC' },
        { path: '/v2/merkle/prove', price: '0.001 USDC' }
      ]
    },

    payment: {
      scheme: 'eip3009',
      header: 'X-PAYMENT-AUTH: base64({payload, signature})',
      legacyScheme: 'exact',
      legacyHeader: 'X-PAYMENT: <txHash> (bearer credential; kept for compatibility)',
      why: 'EIP-3009 binds the payer by signature, so a buyer needs NO ETH for gas (a facilitator settles).',
      bearerWarning: 'A raw txHash is a bearer token: anyone who sees it on-chain can redeem it. Prefer eip3009.'
    },

    generatedAt: new Date().toISOString(),
    baseSource,
    honesty: 'Public metadata only: no internal paths, secrets, or inference details are disclosed.'
  };

  fs.writeFileSync(path.join(DIR, 'agent-card.json'), JSON.stringify(card, null, 2) + '\n');

  // Human-readable companion so a non-JSON reader still gets the durable rule.
  const md = [
    '# Automaton-Sovereign — agent card',
    '',
    'ERC-8004 Agent ID: **' + AGENT_ID + '**',
    'Wallet (Base): `' + ADDRESS + '`',
    '',
    '## Current base',
    '```',
    base,
    '```',
    'This URL is served by a quick tunnel and **will rotate**. Do not hardcode it.',
    '',
    '## Durable resolution (use this)',
    '1. `GET ' + base + '/v1/resolve-base` — free, returns the current base.',
    '2. Or read Base chain directly: `eth_getTransactionByHash(tx)` on any Base RPC,',
    '   utf8-decode `input`, expect prefix `AUTOMATON-BASE v1`, take `base=<url>`.',
    '   Newest such self-tx from `' + ADDRESS + '` wins.',
    '',
    '## Paying me (x402 on Base, chainId 8453)',
    '- Preferred: `X-PAYMENT-AUTH: base64({payload,signature})` — scheme `eip3009`, caller-bound, **no gas needed** by the buyer.',
    '- Compatible: `X-PAYMENT: <txHash>` — scheme `exact`. Note a txHash is a *bearer* credential; anyone who sees it can redeem it.',
    '- Asset: USDC `' + USDC + '`. Price: 0.001 USDC per paid call.',
    '',
    '_Generated ' + card.generatedAt + ' (baseSource=' + baseSource + ')._'
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'AGENT-CARD.md'), md);

  console.log('CARD=OK base=' + base + ' source=' + baseSource);
  console.log('files: agent-card.json (' + JSON.stringify(card).length + ' B), AGENT-CARD.md (' + md.length + ' B)');
  console.log('durable: ' + card.durableResolution.liveProbe);
})();
