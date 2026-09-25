#!/usr/bin/env node
// bump07.js - bump VERSION to 0.7.0 and list /v1/verify-payment in the free route metadata.
'use strict';
const fs = require('fs');
const P = 'server.js';
let s = fs.readFileSync(P, 'utf8');
const before = s;

s = s.replace(/const VERSION = '[^']*';/, "const VERSION = '0.7.0';");

if (!s.includes("'/v1/verify-payment'")) {
  s = s.replace("'/v2/merkle/verify', '/'", "'/v2/merkle/verify', '/v1/verify-payment', '/'");
}
// also add to the free[] array used by /pricing if it exists in a second place
s = s.replace(/free: \[([^\]]*)\]/, (m, g) =>
  g.includes('verify-payment') ? m : `free: [${g.replace(/\s*$/, '')}${g.trim().endsWith(',') ? '' : ','} '/v1/verify-payment']`);

if (s !== before) { fs.writeFileSync(P + '.bak3', before); fs.writeFileSync(P, s); console.log('WROTE ' + P); }
else console.log('NO CHANGE');
