// patch-provider.js — connect the buyer wallet to an RPC provider (ethers v6 needs one for view calls).
// Written as a FILE because `node -e` inline quoting silently fails in cmd.exe. Learned the hard way.
'use strict';
const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, 'autonomous-buy.js');
let s = fs.readFileSync(F, 'utf8');

if (s.indexOf('__PROVIDER_FIX__') !== -1) { console.log('already patched'); process.exit(0); }

const anchor = 'const wallet = loadWallet();';
if (s.indexOf(anchor) === -1) { console.log('FATAL anchor not found'); process.exit(1); }

s = s.replace(anchor,
  '/* __PROVIDER_FIX__ ethers v6 requires a provider attached for read calls like balanceOf */\n' +
  '  const provider = new ethers.JsonRpcProvider(RPC);\n' +
  '  const wallet = loadWallet().connect(provider);');

fs.writeFileSync(F, s);
console.log('patched: buyer wallet connected to ' + 'RPC provider');
