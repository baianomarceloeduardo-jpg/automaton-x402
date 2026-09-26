// reanchor.js — self-healing re-anchor. Keeps the on-chain base anchor in sync with reality.
//
// WHY THIS IS THE KEYSTONE: chain-anchored discovery only works if the newest anchor points at the
// LIVE base. My tunnel URL rotates on every restart, so an anchor written once goes stale within
// hours — recreating exactly the problem it was meant to solve. This script closes the loop:
// if the live tunnel base differs from the last anchored base, re-anchor. Otherwise do nothing.
// It is cheap (a 0-value self-tx, ~33k gas), idempotent, and safe to run on every boot.
//
// Usage: node reanchor.js            # only re-anchors if base changed
//        node reanchor.js --force    # always re-anchor
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const DIR = __dirname;

function readBase() {
  try {
    const t = fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8');
    const m = t.match(/https?:\/\/[^\s'"]+/);
    return m ? m[0].replace(/\/+$/, '') : null;
  } catch (_) { return null; }
}

function lastAnchoredBase() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, 'CAPABILITY-LATEST.json'), 'utf8'));
    return j.base || null;
  } catch (_) { return null; }
}

// is the live base actually serving me? never anchor a dead URL.
async function liveOk(base) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 9000);
    const r = await fetch(base + '/health', { signal: c.signal });
    clearTimeout(t);
    return r.status === 200;
  } catch (_) { return false; }
}

(async () => {
  const force = process.argv.includes('--force');
  const base = readBase();
  if (!base) { console.log('REANCHOR=SKIP reason=no_tunnel_url'); return; }
  const prev = lastAnchoredBase();

  if (!force && prev === base) { console.log('REANCHOR=SKIP reason=base_unchanged ' + base); return; }

  const ok = await liveOk(base);
  if (!ok) { console.log('REANCHOR=SKIP reason=live_base_not_serving ' + base); return; }

  console.log('REANCHOR=GO prev=' + (prev || '-') + ' new=' + base);
  try {
    const out = execFileSync(process.execPath, [path.join(DIR, 'capability-manifest.js'), '--anchor'],
      { cwd: DIR, encoding: 'utf8', timeout: 180000 });
    const tx = (out.match(/ANCHOR_TX=(0x[0-9a-fA-F]{64})/) || [])[1] || null;
    const verified = /VERIFY_ONCHAIN=PASS/.test(out);
    console.log('REANCHOR=DONE tx=' + (tx || '?') + ' verified=' + verified);
    fs.appendFileSync(path.join(DIR, 'REANCHOR-LOG.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), base, prev, tx, verified }) + '\n');
  } catch (e) {
    console.log('REANCHOR=FAIL ' + String(e.message).slice(0, 300));
    fs.appendFileSync(path.join(DIR, 'REANCHOR-LOG.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), base, prev, error: String(e.message).slice(0, 300) }) + '\n');
  }
})();
