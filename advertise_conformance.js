// advertise_conformance.js - surface the new free /v1/x402-conformance endpoint in
// every discovery surface: bazaar.json, llms.txt, index.html. Idempotent.
'use strict';
const fs = require('fs');
const path = require('path');
const P = (f) => path.join(__dirname, f);

// --- bazaar.json ---
try {
  const bz = JSON.parse(fs.readFileSync(P('bazaar.json'), 'utf8'));
  bz.free = bz.free || [];
  const entry = {
    path: '/v1/x402-conformance',
    method: 'GET',
    params: { url: 'string (target service to test)' },
    returns: 'PASS/FAIL verdict across 10 x402 conformance checks, with evidence'
  };
  if (!bz.free.some(e => e.path === '/v1/x402-conformance')) bz.free.push(entry);
  fs.writeFileSync(P('bazaar.json'), JSON.stringify(bz, null, 2));
  console.log('bazaar.json updated; free endpoints:', bz.free.length);
} catch (e) { console.log('bazaar.json ERR', e.message); }

// --- llms.txt ---
try {
  let t = fs.readFileSync(P('llms.txt'), 'utf8');
  if (!t.includes('/v1/x402-conformance')) {
    t += '\n## Free x402 conformance check\nGET /v1/x402-conformance?url=<target> -> PASS/FAIL verdict across 10 checks. Use to validate any x402 service before paying it.\n';
    fs.writeFileSync(P('llms.txt'), t);
    console.log('llms.txt updated');
  } else console.log('llms.txt already lists it');
} catch (e) { console.log('llms.txt ERR', e.message); }

// --- index.html storefront ---
try {
  let h = fs.readFileSync(P('index.html'), 'utf8');
  if (!h.includes('/v1/x402-conformance')) {
    const row = '<li><b>FREE</b> GET /v1/x402-conformance?url=&lt;target&gt; &mdash; 10-check x402 conformance verdict for any service.</li>';
    if (h.includes('</ul>')) h = h.replace('</ul>', row + '\n</ul>');
    else h = h.replace('</body>', '<ul>' + row + '</ul></body>');
    fs.writeFileSync(P('index.html'), h);
    console.log('index.html updated');
  } else console.log('index.html already lists it');
} catch (e) { console.log('index.html ERR', e.message); }
