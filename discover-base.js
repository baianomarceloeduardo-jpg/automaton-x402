// discover-base.js — chain-anchored service discovery. ZERO dependencies (https only).
// Usable BOTH as a CLI and as a module (the HTTP overlay reuses these exports, so the CLI path
// and the server path can never drift apart).
//
// THE PROBLEM THIS SOLVES: a sovereign agent's public base URL is ephemeral (tunnels rotate), so
// every durable listing goes stale. Domains/registry listings need credentials or USDC. But the
// agent's WALLET ADDRESS is permanent and its on-chain history is public and credential-free.
// So: anchor the base URL on-chain, and let anyone recover the CURRENT base by scanning the
// address's transactions for the newest anchor. Discovery becomes as durable as the chain.
//
// Understood prefixes:
//   AUTOMATON-CAP v1 ... base=<url> sha256=<hash>   (capability manifest anchor)
//   AUTOMATON-BASE v1 base=<url> agent=<id>         (simple base anchor)
'use strict';
const https = require('https');

const SELF = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const PREFIXES = ['AUTOMATON-CAP v1', 'AUTOMATON-BASE v1'];

function indexers(a) {
  return [
    'https://base.blockscout.com/api/v2/addresses/' + a + '/transactions?filter=to%20%7C%20from',
    'https://base.blockscout.com/api/v2/addresses/' + a + '/transactions'
  ];
}

function get(url, timeoutMs) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (_) { return resolve(null); }
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, timeout: timeoutMs || 12000,
      headers: { 'user-agent': 'automaton-discovery/1.1', accept: 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} fin(j); });
    });
    req.on('error', () => fin(null));
    req.on('timeout', () => { req.destroy(); fin(null); });
  });
}

function parseAnchor(text) {
  if (!text || typeof text !== 'string') return null;
  const p = PREFIXES.find((x) => text.indexOf(x) === 0);
  if (!p) return null;
  const base = (text.match(/base=(\S+)/) || [])[1] || null;
  if (!base || !/^https?:\/\//.test(base)) return null;
  const sha = (text.match(/sha256=([0-9a-fA-F]{64})/) || [])[1] || null;
  const agent = (text.match(/agent=(\d+)/) || [])[1] || null;
  const ts = (text.match(/ts=(\S+)/) || [])[1] || null;
  return { prefix: p, base: base.replace(/\/+$/, ''), sha256: sha, agentId: agent, ts };
}

function hexToUtf8(hex) {
  try { return Buffer.from(String(hex || '').replace(/^0x/, ''), 'hex').toString('utf8'); } catch (_) { return ''; }
}

function itemsFrom(j) {
  if (!j) return [];
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.items)) return j.items;
  if (Array.isArray(j.result)) return j.result;
  return [];
}

// Core: resolve the CURRENT base for an address, from chain, with no credentials.
async function discoverBase(address) {
  let items = [], usedIndexer = null;
  for (const url of indexers(address)) {
    const j = await get(url, 6000);
    const it = itemsFrom(j);
    if (it.length) { items = it; usedIndexer = url; break; }
  }

  const found = [];
  for (const it of items) {
    const hex = it.raw_input || it.input || it.data || (it.tx && it.tx.input);
    const text = hexToUtf8(hex);
    const a = parseAnchor(text);
    if (a) found.push({
      ...a,
      tx: it.hash || it.tx_hash || null,
      block: (it.block_number != null ? it.block_number : (it.blockNumber != null ? parseInt(it.blockNumber, 16) : null)),
      from: (it.from && (it.from.hash || it.from)) || null
    });
  }
  found.sort((x, y) => (y.block || 0) - (x.block || 0));

  const latest = found[0] || null;
  return {
    ok: found.length > 0,
    address,
    anchorsFound: found.length,
    indexer: usedIndexer,
    latest,
    history: found.slice(0, 5),
    howToVerify: latest
      ? 'eth_getTransactionByHash(' + latest.tx + ') on any Base RPC; utf8-decode input; expect "' + latest.prefix + '" and base=' + latest.base
      : 'no anchor transaction found for this address in the indexer window',
    publishTip: 'Publish your own: send a 0-value self-tx on Base with calldata "' + PREFIXES[1] + ' base=<your https url> agent=<id>". That makes an ephemeral URL durably discoverable.'
  };
}

module.exports = { discoverBase, parseAnchor, hexToUtf8, itemsFrom, SELF, PREFIXES, indexers };

// ---- CLI -------------------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2).filter((a) => !['--json', '--self'].includes(a));
    const asJson = process.argv.includes('--json');
    const address = process.argv.includes('--self') ? SELF
      : (argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) || null);
    if (!address) { console.log('usage: node discover-base.js <0x address>|--self [--json]'); process.exit(2); }

    const out = await discoverBase(address);
    if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(out.ok ? 0 : 1); }

    console.log('address      ' + address);
    console.log('anchorsFound ' + out.anchorsFound + (out.indexer ? '  (via base.blockscout.com, no credentials)' : ''));
    if (!out.ok) { console.log('RESULT=NO_ANCHOR'); console.log(out.publishTip); process.exit(1); }
    console.log('CURRENT_BASE ' + out.latest.base);
    console.log('tx           ' + out.latest.tx);
    console.log('block        ' + out.latest.block);
    console.log('agentId      ' + (out.latest.agentId || '-'));
    console.log('sha256       ' + (out.latest.sha256 || '-'));
    console.log('anchoredAt   ' + (out.latest.ts || '-'));
    console.log('howToVerify  ' + out.howToVerify);
    process.exit(0);
  })();
}
