// patch-wallet-discovery.js — make local-settler.js find the key structurally.
// The bug: wallet.json's private key is not under the field names I guessed, so addr stayed
// undefined and ethers threw "unsupported addressable value". Discover by SHAPE (0x + 64 hex),
// derive the address from the key, never print either.

const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, 'local-settler.js');
let s = fs.readFileSync(F, 'utf8');

const NEW = `function discoverKeys(obj) {
  let pk = null, addr = null; const seen = new Set();
  (function walk(o) {
    if (!o || typeof o !== 'object' || seen.has(o)) return; seen.add(o);
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') {
        if (!pk && /^0x[0-9a-fA-F]{64}$/.test(v)) pk = v;
        else if (!pk && /^[0-9a-fA-F]{64}$/.test(v)) pk = '0x' + v;
        else if (!addr && /^0x[0-9a-fA-F]{40}$/.test(v)) addr = v;
      } else if (v && typeof v === 'object') walk(v);
    }
  })(obj);
  return { pk, addr };
}

function loadWallet() {
  const cands = [
    'C:/Users/marce/.automaton/wallet.json',
    path.join(__dirname, 'wallet.json'),
    path.join(__dirname, '..', '.automaton', 'wallet.json'),
  ];
  for (const c of cands) {
    try {
      if (!fs.existsSync(c)) continue;
      const d = discoverKeys(JSON.parse(fs.readFileSync(c, 'utf8')));
      if (!d.pk) continue;
      let addr = d.addr;
      if (!addr) { try { const { ethers } = require('ethers'); addr = new ethers.Wallet(d.pk).address; } catch (e) {} }
      return { pk: d.pk, addr, file: c };
    } catch (e) {}
  }
  return null;
}`;

const re = /function loadWallet\(\) \{[\s\S]*?\n\}/;
if (!re.test(s)) { console.log('ANCHOR_MISSING'); process.exit(1); }
s = s.replace(re, NEW);
fs.writeFileSync(F, s);
console.log('wallet discovery patched');
