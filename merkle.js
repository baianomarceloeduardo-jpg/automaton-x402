'use strict';
/**
 * merkle.js — zero-dependency Merkle batching for the Automaton-Sovereign ledger.
 *
 * Turns N items into ONE signed ledger commitment (the root), plus a compact
 * inclusion proof per item. Anyone can verify "my item is in that committed
 * batch" using only the root (which is signed + hash-chained in the ledger) and
 * the proof — without trusting me.
 *
 * Leaf  = sha256(domain || item)          domain = 'asm-attest-v1:'
 * Node  = sha256(hex(left) || hex(right)) where left/right are 32-byte hashes
 * Odd node is promoted (duplicated) — standard, and documented via `siblingSide`.
 */
const crypto = require('crypto');
const DOMAIN = 'asm-attest-v1:';

function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function leafHash(item) { return sha256hex(DOMAIN + String(item)); }
function parentHash(a, b) { return sha256hex(Buffer.from(a, 'hex').toString('hex') + Buffer.from(b, 'hex').toString('hex')); }

function buildTree(leaves) {
  if (!leaves.length) throw new Error('no_leaves');
  let level = leaves.slice();
  const levels = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i], r = (i + 1 < level.length) ? level[i + 1] : level[i];
      next.push(parentHash(l, r));
    }
    levels.push(next); level = next;
  }
  return { root: level[0], levels };
}

function proofFor(index, levels) {
  const proof = [];
  let idx = index;
  for (let d = 0; d < levels.length - 1; d++) {
    const level = levels[d];
    const isRight = idx % 2 === 1;
    const sibIdx = isRight ? idx - 1 : idx + 1;
    const sibling = (sibIdx < level.length) ? level[sibIdx] : level[idx];
    proof.push({ side: isRight ? 'left' : 'right', hash: sibling });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function verifyProof(item, proof, root) {
  let h = leafHash(item);
  for (const step of proof) {
    if (!step || (step.side !== 'left' && step.side !== 'right')) return { valid: false, reason: 'bad_proof_step' };
    h = (step.side === 'left') ? parentHash(step.hash, h) : parentHash(h, step.hash);
  }
  return { valid: h === root, computedRoot: h };
}

/** Commit a batch of items. Returns { root, leaves, proofs, count }. */
function commit(items) {
  const leaves = items.map(leafHash);
  const { root, levels } = buildTree(leaves);
  const proofs = leaves.map((_, i) => proofFor(i, levels));
  return { root, leaves, proofs, count: items.length };
}

module.exports = { DOMAIN, sha256hex, leafHash, parentHash, buildTree, proofFor, verifyProof, commit };

// CLI self-test: node merkle.js "a" "b" "c" "d" "e"
if (require.main === module) {
  const items = process.argv.slice(2);
  const batch = items.length ? items : ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const c = commit(batch);
  console.log('items: ' + batch.length);
  console.log('root:  ' + c.root);
  let allOk = true;
  c.proofs.forEach((p, i) => {
    const v = verifyProof(batch[i], p, c.root);
    if (!v.valid) allOk = false;
    console.log('  #' + i + ' ' + (v.valid ? 'OK' : 'FAIL') + ' proofDepth=' + p.length + ' item=' + batch[i]);
  });
  // negatives
  const bad = verifyProof('not-in-batch', c.proofs[0], c.root);
  console.log('negative (absent item): ' + (bad.valid ? 'FAIL(wrongly accepted)' : 'OK(rejected)'));
  const wrongRoot = verifyProof(batch[0], c.proofs[0], '0'.repeat(64));
  console.log('negative (wrong root):  ' + (wrongRoot.valid ? 'FAIL(wrongly accepted)' : 'OK(rejected)'));
  process.exit(allOk && !bad.valid && !wrongRoot.valid ? 0 : 1);
}
