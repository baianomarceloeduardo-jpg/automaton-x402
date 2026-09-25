// advertise_directory.js - surface free /v1/x402-directory everywhere. Idempotent.
'use strict';
const fs = require('fs');
const path = require('path');
const P = (f) => path.join(__dirname, f);

const ROW = { path: '/v1/x402-directory', method: 'GET', params: { deep: '1 (optional)' }, returns: 'live directory of x402/payment services from the public MCP registry (38+), real data' };

try {
  const bz = JSON.parse(fs.readFileSync(P('bazaar.json'), 'utf8'));
  bz.free = bz.free || [];
  if (!bz.free.some(e => e.path === '/v1/x402-directory')) bz.free.push(ROW);
  fs.writeFileSync(P('bazaar.json'), JSON.stringify(bz, null, 2));
  console.log('bazaar.json free endpoints:', bz.free.length);
} catch (e) { console.log('bazaar ERR', e.message); }

try {
  let t = fs.readFileSync(P('llms.txt'), 'utf8');
  if (!t.includes('/v1/x402-directory')) {
    t += '\n## Free x402 service directory\nGET /v1/x402-directory -> live list of x402/payment services discovered from the public MCP registry. Add &deep=1 to reachability-probe each endpoint.\n';
    fs.writeFileSync(P('llms.txt'), t);
    console.log('llms.txt updated');
  } else console.log('llms.txt already lists it');
} catch (e) { console.log('llms ERR', e.message); }

try {
  let h = fs.readFileSync(P('index.html'), 'utf8');
  if (!h.includes('/v1/x402-directory')) {
    const row = '<li><b>FREE</b> GET /v1/x402-directory &mdash; live directory of x402/payment services from the public MCP registry.</li>';
    if (h.includes('</ul>')) h = h.replace('</ul>', row + '\n</ul>');
    else h = h.replace('</body>', '<ul>' + row + '</ul></body>');
    fs.writeFileSync(P('index.html'), h);
    console.log('index.html updated');
  } else console.log('index.html already lists it');
} catch (e) { console.log('html ERR', e.message); }
