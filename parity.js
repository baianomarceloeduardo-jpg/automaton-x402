'use strict';
// parity.js — prove the peer-authored SDK Merkle verifier agrees with my server's merkle.js.
const mine = require('./merkle.js');
const theirs = require('./sdk/merkle.cjs');
const cases = [
  ['alpha'],
  ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
  Array.from({ length: 17 }, (_, i) => 'item-' + i),
  Array.from({ length: 1000 }, (_, i) => 'bulk-' + i),
  ['single'],
  ['a\x00b', 'emoji-🙂', 'Ω', '']
];
let pass = 0, fail = 0;
for (const items of cases) {
  const a = mine.commit(items);
  const b = theirs.commit(items);
  const rootEq = a.root === b.root;
  let proofEq = a.proofs.length === b.proofs.length;
  if (proofEq) for (let i = 0; i < a.proofs.length; i++) {
    const pa = JSON.stringify(a.proofs[i]), pb = JSON.stringify(b.proofs[i]);
    if (pa !== pb) { proofEq = false; break; }
  }
  // cross-verify: my proof checked by their verifier, and vice-versa
  let cross = true;
  for (let i = 0; i < items.length; i++) {
    if (!theirs.verifyProof(items[i], a.proofs[i], a.root).valid) cross = false;
    if (!mine.verifyProof(items[i], b.proofs[i], b.root).valid) cross = false;
  }
  const ok = rootEq && proofEq && cross;
  console.log(`n=${String(items.length).padStart(4)}  root=${rootEq ? 'EQ' : 'DIFF'}  proofs=${proofEq ? 'EQ' : 'DIFF'}  crossVerify=${cross ? 'OK' : 'FAIL'}  => ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) { console.log('   mine.root=' + a.root + '\n   sdk.root =' + b.root); fail++; } else pass++;
}
// negative parity
const c = mine.commit(['x', 'y', 'z']);
const neg1 = theirs.verifyProof('nope', c.proofs[0], c.root).valid;
const neg2 = mine.verifyProof('nope', theirs.commit(['x', 'y', 'z']).proofs[0], c.root).valid;
console.log('negative parity (absent item rejected by both): ' + ((!neg1 && !neg2) ? 'PASS' : 'FAIL'));
console.log(`\nSDK<->server parity: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 && !neg1 && !neg2 ? 0 : 1);
