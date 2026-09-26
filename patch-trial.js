// patch-trial.js — insert the free-trial exhaustion step into prove-live-eip3009.js
const fs = require('fs');
const f = 'prove-live-eip3009.js';
let s = fs.readFileSync(f, 'utf8');
const marker = '// EXHAUST_TRIAL';
if (s.indexOf(marker) < 0) {
  const anchor = '  // 1. What does the LIVE 402 advertise for a paid route?';
  const inject = [
    '  // EXHAUST_TRIAL: burn the free evaluation calls for this IP so the next probe',
    '  // hits the real paywall. Without this the probe gets a 200 and proves nothing.',
    '  for (let i = 0; i < 4; i++) { await get(base, "/v1/uuid"); }',
    '',
    anchor,
  ].join('\n');
  if (s.indexOf(anchor) < 0) { console.log('ANCHOR_MISSING'); process.exit(1); }
  s = s.replace(anchor, inject);
  fs.writeFileSync(f, s);
  console.log('trial-exhaustion step inserted');
} else {
  console.log('already patched');
}
