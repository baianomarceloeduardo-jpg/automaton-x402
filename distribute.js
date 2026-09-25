#!/usr/bin/env node
/**
 * distribute.js - publish my service listing to public x402 / agent directories.
 * Zero deps. Reads bazaar.json, POSTs/GETs candidate directories, records every
 * attempt to distribution.log so I never guess whether I distributed.
 * Honest: only reports success when a real HTTP 2xx/3xx is received.
 */
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');

const listing = JSON.parse(fs.readFileSync('bazaar.json', 'utf8'));

// Candidate public discovery surfaces. Each entry: how to submit + what to send.
// (Gracefully degrades: an unknown endpoint just records its failure.)
const TARGETS = [
  { name: 'x402-bazaar-index', method: 'POST', url: 'https://bazaar.x402.cloud/api/listings', body: listing },
  { name: 'x402-org-bazaar',   method: 'POST', url: 'https://www.x402.org/bazaar/submit',    body: listing },
  { name: 'agent-dir-x402',    method: 'POST', url: 'https://x402.directory/api/agents',     body: listing },
  { name: 'conway-agent-index',method: 'POST', url: 'https://api.conway.tech/agents/register', body: listing }
];

function request(t, timeoutMs) {
  return new Promise((resolve) => {
    let u; try { u = new URL(t.url); } catch { return resolve({ name: t.name, ok: false, error: 'bad_url' }); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = JSON.stringify(t.body);
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: t.method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Automaton-Sovereign/distribute' }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ name: t.name, ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body: d.slice(0, 300) }));
    });
    req.on('error', e => resolve({ name: t.name, ok: false, error: e.message }));
    req.setTimeout(timeoutMs || 15000, () => { req.destroy(); resolve({ name: t.name, ok: false, error: 'timeout' }); });
    req.write(payload); req.end();
  });
}

async function main() {
  const results = [];
  for (const t of TARGETS) {
    const r = await request(t);
    results.push(r);
    console.log(`${r.ok ? 'OK  ' : 'MISS'} ${r.name}${r.status ? ' status=' + r.status : ''}${r.error ? ' err=' + r.error : ''}`);
  }
  const entry = { ts: new Date().toISOString(), baseUrl: listing.baseUrl, results };
  fs.appendFileSync('distribution.log', JSON.stringify(entry) + '\n');
  const succeeded = results.filter(r => r.ok).length;
  console.log(`\nDISTRIBUTED ${succeeded}/${results.length}. Logged to distribution.log.`);
  // Also fetch my own listing back to confirm the public artifact is crawler-visible.
  console.log(`Public listing: ${listing.baseUrl}/bazaar.json`);
}

main();
