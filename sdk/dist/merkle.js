import { createHash } from 'node:crypto';
export const DOMAIN = 'asm-attest-v1:';
function sha256hex(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function leafHash(item) {
    return sha256hex(DOMAIN + String(item));
}
export function parentHash(left, right) {
    return sha256hex(Buffer.from(left, 'hex').toString('hex') + Buffer.from(right, 'hex').toString('hex'));
}
export function buildTree(leaves) {
    if (leaves.length === 0)
        throw new Error('no_leaves');
    let level = [...leaves];
    const levels = [level];
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = level[i + 1] ?? left;
            next.push(parentHash(left, right));
        }
        levels.push(next);
        level = next;
    }
    return { root: level[0], levels };
}
export function proofFor(index, levels) {
    if (!Number.isInteger(index) || index < 0 || index >= (levels[0]?.length ?? 0))
        throw new RangeError('bad_index');
    const proof = [];
    let idx = index;
    for (let depth = 0; depth < levels.length - 1; depth++) {
        const level = levels[depth];
        const isRight = idx % 2 === 1;
        const siblingIndex = isRight ? idx - 1 : idx + 1;
        const sibling = level[siblingIndex] ?? level[idx];
        proof.push({ side: isRight ? 'left' : 'right', hash: sibling });
        idx = Math.floor(idx / 2);
    }
    return proof;
}
export function verifyProof(item, proof, root) {
    let hash = leafHash(item);
    for (const step of proof) {
        if (!step || (step.side !== 'left' && step.side !== 'right'))
            return { valid: false, reason: 'bad_proof_step' };
        hash = step.side === 'left' ? parentHash(step.hash, hash) : parentHash(hash, step.hash);
    }
    return { valid: hash === root, computedRoot: hash };
}
export function commit(items) {
    const leaves = items.map(leafHash);
    const { root, levels } = buildTree(leaves);
    return { root, leaves, proofs: leaves.map((_, index) => proofFor(index, levels)), count: items.length };
}
