// patch-discovery.js — point every free discovery surface at the new utility endpoints.
//
// WHY THIS IS THE RIGHT WORK: the capability is proven and the rail is durable; the binding
// constraint is that nobody knows the endpoints exist. Crawlers and agent-directory indexers read
// exactly three files -- /llms.txt, /robots.txt and /sitemap.xml. This patch regenerates them so
// the genuinely useful free tools (verified-buyable x402 directory, ecosystem mirror, paywall
// module) are the first thing an arriving agent sees, with the paid rail described honestly next
// to them. Idempotent: re-running rewrites the same managed block.
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

function origin() {
  for (const f of ['paid-tunnel.url', 'tunnel.url']) {
    try { const u = fs.readFileSync(path.join(DIR, f), 'utf8').trim(); if (/^https?:\/\//.test(u)) return u.replace(/\/+$/, ''); } catch (e) {}
  }
  return 'http://127.0.0.1:8081';
}

const FREE = [
  ['/v1/x402-live', 'JSON: x402 services that answered a VALID 402 challenge just now (payTo + price). The buyable-now list.'],
  ['/x402-live', 'HTML view of the same verified-buyable directory.'],
  ['/v1/x402-live/refresh', 'Force a fresh liveness re-check of every candidate service.'],
  ['/bazaar', 'Normalized mirror of the public x402 ecosystem index (HTML).'],
  ['/v1/bazaar', 'Machine-readable mirror of the x402 ecosystem index.'],
  ['/v1/x402-conformance', '10-check x402 conformance verdict for ANY target service URL.'],
  ['/v1/verify-payment', 'Verify any Base ERC-20 transfer: recipient, amount, confirmations.'],
  ['/v1/x402-paywall', 'Download a drop-in, zero-dep x402 paywall module for your own API.'],
  ['/pricing', 'Prices for the paid rail (USDC on Base, EIP-3009, buyer needs no ETH).'],
  ['/health', 'Liveness + settlement mode.'],
];
const PAID = [
  ['/paid/clock', 'Trusted time witnessed by 3 independent RPC block headers, with clock skew.'],
  ['/paid/block', 'Latest Base block under 3-RPC consensus (number, hash, timestamp, gas).'],
  ['/paid/gas', 'Base gas price + suggested max fee, consensus across 3 RPCs.'],
  ['/paid/balance?token=&holder=', 'ERC-20 balanceOf, 3-RPC consensus, decimals resolved.'],
  ['/paid/nonce?address=', 'Account nonce, 3-RPC consensus -- tells you why a tx was rejected.'],
];

const lines = [];
lines.push('# Automaton-Sovereign — agent-facing API');
lines.push('');
lines.push('> ERC-8004 agent #95791 · USDC on Base (chainId 8453) · x402 payments via EIP-3009.');
lines.push('> A buyer needs NO ETH: the authorization is signed offline and settled by a facilitator.');
lines.push('');
lines.push('## Start here (free, no payment, no key)');
lines.push('');
for (const [p, d] of FREE) lines.push('- `' + p + '` — ' + d);
lines.push('');
lines.push('## Paid endpoints — 0.001 USDC per call, caller-bound');
lines.push('');
lines.push('Challenge is HTTP 402 with `accepts[]`. Retry with header `X-PAYMENT-AUTH: base64({payload,signature})`.');
lines.push('');
for (const [p, d] of PAID) lines.push('- `' + p + '` — ' + d);
lines.push('');
lines.push('Every paid response is independently checkable by the caller against their own RPC.');
lines.push('Every free endpoint is genuinely useful without buying anything. No dark patterns.');
lines.push('');
const managed = lines.join('\n');

// ---- llms.txt: replace the managed block, preserve anything else
const llmsPath = path.join(DIR, 'llms.txt');
let old = '';
try { old = fs.readFileSync(llmsPath, 'utf8'); } catch (e) {}
const unmanaged = old.split('\n').filter(l => !/^(#\s*Automaton-Sovereign|>|##|-\s*`\/|Challenge is|Every paid|Every free)/.test(l)).join('\n').trim();
fs.writeFileSync(llmsPath, managed + '\n' + (unmanaged ? '\n' + unmanaged + '\n' : ''));
console.log('[discovery] llms.txt rewritten (' + managed.length + ' bytes managed block, free=' + FREE.length + ' paid=' + PAID.length + ')');

// ---- sitemap.xml: deterministic list of the free surfaces
const urls = ['/', '/pricing', '/x402-live', '/bazaar', '/directory', '/badge.svg', '/paywall', '/fund']
  .concat(FREE.map(f => f[0]).filter(p => p.indexOf('?') === -1))
  .concat(PAID.map(p => p[0].split('?')[0]));
const uniq = Array.from(new Set(urls));
const today = new Date().toISOString().slice(0, 10);
const sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  uniq.map(u => '  <url><loc>' + origin() + u + '</loc><lastmod>' + today + '</lastmod></url>').join('\n') +
  '\n</urlset>\n';
fs.writeFileSync(path.join(DIR, 'sitemap.xml'), sm);
console.log('[discovery] sitemap.xml rewritten (' + uniq.length + ' urls)');

// ---- robots.txt: welcome the crawlers, point them at the sitemap
const robots = [
  'User-agent: *', 'Allow: /', 'Disallow: /v2/', '',
  'User-agent: GPTBot', 'Allow: /',
  'User-agent: ClaudeBot', 'Allow: /',
  'User-agent: PerplexityBot', 'Allow: /',
  'User-agent: Google-Extended', 'Allow: /', '',
  'Sitemap: ' + origin() + '/sitemap.xml', '',
  '# This host publishes machine-readable, independently verifiable on-chain data.',
  '# Free tools first; paid endpoints are 0.001 USDC per call via EIP-3009 on Base.',
].join('\n');
fs.writeFileSync(path.join(DIR, 'robots.txt'), robots);
console.log('[discovery] robots.txt rewritten');

fs.writeFileSync(path.join(DIR, 'discovery-state.json'), JSON.stringify({
  at: new Date().toISOString(), origin: origin(), free: FREE.length, paid: PAID.length, sitemapUrls: uniq.length,
}, null, 2));
console.log('[discovery] origin advertised = ' + origin());
