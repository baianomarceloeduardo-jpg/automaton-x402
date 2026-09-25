'use strict';
// parity2.js — correct parity check: the SDK's CJS shims are ASYNC (dynamic import), so await them.
const mine = require('./merkle.js');

const cases = [
  ['alpha'],
  ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
  Array.from({ length: 17 }, (_, i) => 'item-' + i),
  Array.from({ length: 1000 }, (_, i) => 'bulk-' + i),
  ['single'],
  ['a\x00b', 'emoji-🙂', 'Ω', '']
];

(async () => {
  const theirs = await require('./sdk/merkle.cjs');   // async bridge -> real module
  const api = theirs.default || theirs;
  const fn = (api.commit && api.verifyProof) ? api : api;
  if (typeof fn.commit !== 'function') { console.error('SDK has no commit(): exports=' + Object.keys(api)); process.exit(2); }

  let pass = 0, fail = 0;
  for (const items of cases) {
    const a = mine.commit(items);
    const b = fn.commit(items);
    const rootEq = a.root === b.root;
    let proofEq = a.proofs.length === b.proofs.length;
    if (proofEq) for (let i = 0; i < a.proofs.length; i++) {
      if (JSON.stringify(a.proofs[i]) !== JSON.stringify(b.proofs[i])) { proofEq = false; break; }
    }
    let cross = true;
    for (let i = 0; i < items.length; i++) {
      if (!fn.verifyProof(items[i], a.proofs[i], a.root).valid) cross = false;
      if (!mine.verifyProof(items[i], b.proofs[i], b.root).valid) cross = false;
    }
    const ok = rootEq && proofEq && cross;
    console.log(`n=${String(items.length).padStart(4)}  root=${rootEq ? 'EQ' : 'DIFF'}  proofs=${proofEq ? 'EQ' : 'DIFF'}  crossVerify=${cross ? 'OK' : 'FAIL'}  => ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) { console.log('   mine.root=' + a.root + '\n   sdk.root =' + b.root); fail++; } else pass++;
  }

  const c = mine.commit(['x', 'y', 'z']);
  const neg1 = fn.verifyProof('nope', c.proofs[0], c.root).valid;
  const neg2 = mine.verifyProof('nope', fn.commit(['x', 'y', 'z']).proofs[0], c.root).valid;
  const negOk = (!neg1 && !neg2);
  console.log('negative parity (absent item rejected by both): ' + (negOk ? 'PASS' : 'FAIL'));
  console.log(`\nSDK<->server parity: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 && negOk ? 0 : 1);
})();
