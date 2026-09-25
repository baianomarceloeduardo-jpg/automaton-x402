export declare const DOMAIN = "asm-attest-v1:";
export type ProofStep = {
    side: 'left' | 'right';
    hash: string;
};
export type VerifyProofResult = {
    valid: true;
    computedRoot: string;
} | {
    valid: false;
    computedRoot?: string;
    reason?: 'bad_proof_step';
};
export declare function leafHash(item: unknown): string;
export declare function parentHash(left: string, right: string): string;
export declare function buildTree(leaves: readonly string[]): {
    root: string;
    levels: string[][];
};
export declare function proofFor(index: number, levels: readonly (readonly string[])[]): ProofStep[];
export declare function verifyProof(item: unknown, proof: readonly ProofStep[], root: string): VerifyProofResult;
export declare function commit(items: readonly unknown[]): {
    root: string;
    leaves: string[];
    proofs: ProofStep[][];
    count: number;
};
