// sync-state.js — write ANCHOR-STATE.json from authoritative live state (tunnel.url) + latest anchor.
// This is the bridge that makes /v1/discover-base answer INSTANTLY from local truth (no indexer on
// the hot path), while the on-chain anchor remains the public verifiable proof for third parties.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const DIR = __dirname;
const SELF = '0x71DEAc098914A009E3720524642A6bE6F65EE528';

function liveBase() {
  try { const m = fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').match(/https?:\/\/[^\s'"]+/); return m ? m[0].replace(/\/+$/, '') : null; } catch (_) { return null; }
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

const base = liveBase();
if (!base) { console.log('SYNC=SKIP no_tunnel_url'); process.exit(0); }

// get latest on-chain anchor (bounded CLI that is proven to work and self-exits)
let chain = null;
try {
  const out = execFileSync(process.execPath, [path.join(DIR, 'discover-base.js'), '--self', '--json'], { cwd: DIR, encoding: 'utf8', timeout: 30000 });
  chain = JSON.parse(out);
} catch (_) {}

const latest = {
  prefix: 'AUTOMATON-CAP v1',
  base,                                    // AUTHORITATIVE: the live base my server is actually on
  agentId: (chain && chain.latest && chain.latest.agentId) || '95791',
  ts: new Date().toISOString(),
  tx: (chain && chain.latest && chain.latest.tx) || null,
  anchoredBase: (chain && chain.latest && chain.latest.base) || null
};

const state = {
  address: SELF,
  updatedAt: new Date().toISOString(),
  anchorsFound: (chain && chain.anchorsFound) || 1,
  latest,
  history: (chain && chain.history) || [latest],
  howToVerify: 'eth_getTransactionByHash(' + (latest.tx || '<tx>') + ') on any Base RPC; utf8-decode input',
  needsReanchor: !!(latest.tx && latest.anchoredBase && latest.anchoredBase !== base)
};
fs.writeFileSync(path.join(DIR, 'ANCHOR-STATE.json'), JSON.stringify(state, null, 2));
console.log('SYNC=OK base=' + base + ' anchored=' + (latest.anchoredBase || '-') + ' needsReanchor=' + state.needsReanchor);
