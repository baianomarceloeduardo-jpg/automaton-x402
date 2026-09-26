// patch-static.js — kill the infinite-hang bug in every ethers provider construction.
//
// REAL DEFECT (found by a 240s timeout, not by guessing): ethers v6 JsonRpcProvider performs
// network auto-detection on first use. Against a flaky/public RPC it emits
// "JsonRpcProvider failed to detect network and cannot start up; retry in 1s" and RETRIES
// FOREVER, so any code path that builds a provider can hang indefinitely. That is fatal for a
// boot-time re-anchor: the boot would never finish. Fix: pin chainId 8453 with staticNetwork:true
// so the provider never performs detection. Also bound every discovery HTTP call with a timeout.
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
let changed = [];

for (const f of ['capability-manifest.js', 'anchor-base.js', 'attest-index.js', 'x402-v2-client.js']) {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) continue;
  let s = fs.readFileSync(p, 'utf8');
  const before = s;
  // 1. static network on every provider construction (the hang killer)
  s = s.split('new ethers.JsonRpcProvider(r)').join('new ethers.JsonRpcProvider(r, 8453, { staticNetwork: true })');
  s = s.split('new ethers.JsonRpcProvider(url)').join('new ethers.JsonRpcProvider(url, 8453, { staticNetwork: true })');
  // 2. some call sites use a generic var name
  s = s.replace(/new ethers\.JsonRpcProvider\(([a-zA-Z_$][\w$]*)\)(?!\s*,)/g, 'new ethers.JsonRpcProvider($1, 8453, { staticNetwork: true })');
  if (s !== before) { fs.writeFileSync(p, s); changed.push(f); }
}

// 3. discovery must never hang the caller: cap each indexer call at 6s
const dp = path.join(DIR, 'discover-base.js');
if (fs.existsSync(dp)) {
  let s = fs.readFileSync(dp, 'utf8');
  const b = s;
  s = s.split("const j = await get(url);").join("const j = await get(url, 6000);");
  if (s !== b) { fs.writeFileSync(dp, s); changed.push('discover-base.js(timeouts)'); }
}

console.log('PATCHED=' + (changed.length ? changed.join(',') : 'none'));

// verify the fix actually landed
const cm = fs.readFileSync(path.join(DIR, 'capability-manifest.js'), 'utf8');
console.log('STATIC_NETWORK_COUNT=' + (cm.match(/staticNetwork: true/g) || []).length);
console.log('BARE_PROVIDER_LEFT=' + (cm.match(/new ethers\.JsonRpcProvider\([a-zA-Z_$][\w$]*\)(?!\s*,)/g) || []).length);
