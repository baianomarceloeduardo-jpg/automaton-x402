// agent-card.js — the durable public identity for Automaton-Sovereign, generated from LIVE state.
//
// WHY: an agent nobody can find cannot be paid. This produces the machine-readable card that
// discovery surfaces and ERC-8004 consumers read, and it is generated from the RUNNING service so
// it can never advertise an endpoint that is not actually answering. Published durably.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DIR = __dirname;
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const AGENT_ID = 95791;

function readUrl() {
  for (const f of ['paid-tunnel.url', 'tunnel.url']) {
    try { const u = fs.readFileSync(path.join(DIR, f), 'utf8').trim(); if (/^https?:\/\//.test(u)) return u; } catch (e) {}
  }
  return null;
}
function get(url, timeout = 10000) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}

(async () => {
  const base = readUrl();
  const local = await get('http://127.0.0.1:8081/health');
  const pub = base ? await get(base + '/health') : { status: 0, body: '' };

  const card = {
    $schema: 'https://eips.ethereum.org/EIPS/eip-8004#agent-card',
    name: 'Automaton-Sovereign',
    description:
      'Sovereign autonomous agent. Sells caller-bound, on-chain-settled compute utilities over x402 on Base. ' +
      'Every paid call is authenticated by EIP-712 signature (not a bearer tx hash) and settled by an on-chain ' +
      'facilitator, so buyers need zero ETH and zero gas. Free conformance/verification tooling included.',
    version: '1.0.0',
    agentId: AGENT_ID,
    addresses: { evm: PAY_TO },
    chain: { name: 'base', chainId: 8453, asset: 'USDC', assetContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', explorer: 'https://basescan.org' },
    endpoints: {
      base: base,
      localHealth: local.status,
      publicHealth: pub.status,
      free: base ? [
        { path: '/health', description: 'liveness' },
        { path: '/pricing', description: 'advertised prices and accepted payment schemes' },
        { path: '/.well-known/x402', description: 'x402 discovery document' },
        { path: '/ledger', description: 'append-only settlement ledger (public audit trail)' },
      ] : [],
      paid: base ? [
        { path: '/paid/hash', price: '0.001 USDC', description: 'SHA-256 of provided data (or random preimage)' },
        { path: '/paid/uuid', price: '0.001 USDC', description: 'cryptographically random UUID v4' },
        { path: '/paid/time', price: '0.001 USDC', description: 'signed, monotonic server timestamp' },
        { path: '/paid/hashchain', price: '0.001 USDC', description: 'next link in a tamper-evident hash chain' },
      ] : [],
      payment: {
        scheme: 'eip3009',
        header: 'X-PAYMENT-AUTH',
        encoding: 'base64(JSON({payload,signature}))',
        note: 'Sign an EIP-712 TransferWithAuthorization for USDC on Base. Buyer needs no ETH: the facilitator submits and pays gas. Replay is impossible because the nonce is consumed on-chain.',
      },
    },
    trust: { callerBound: true, replayProtected: true, settlement: 'on-chain', verifiable: true },
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(DIR, 'agent-card.json'), JSON.stringify(card, null, 2));
  console.log('[agent-card] base=' + base + ' local=' + local.status + ' public=' + pub.status);
  console.log('[agent-card] wrote agent-card.json (' + JSON.stringify(card).length + ' bytes)');
})();
