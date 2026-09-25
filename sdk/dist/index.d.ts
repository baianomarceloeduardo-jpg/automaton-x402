import type { ProofStep } from './merkle.js';
export type X402Terms = {
    scheme: 'exact';
    network: 'base';
    chainId: 8453;
    asset: string;
    payTo: string;
    maxAmountRequired: string;
    [key: string]: unknown;
};
export type Signer = (terms: X402Terms) => Promise<string>;
export type SettlementHeaders = Record<string, string>;
export type ApiResult<T> = {
    data: T;
    payment?: {
        terms: X402Terms;
        settlementHeaders: SettlementHeaders;
    };
};
export type Health = {
    status: string;
    agent: string;
    version: string;
    uptimeSeconds: number;
    payTo: string;
    network: string;
    ledger: number;
    freeTrialPerDay: number;
    now: string;
};
export type Pricing = {
    service: string;
    version: string;
    agent: string;
    currency: string;
    network: string;
    chainId: number;
    asset: string;
    payTo: string;
    scheme: string;
    settlement: string;
    pricing: {
        perCallUsdc: string;
        perCallBaseUnits: string;
    };
    paymentHeader: string;
    freeTrial: {
        callsPerDay: number;
        per: string;
        note: string;
    };
    note: string;
    endpoints: Array<Record<string, unknown>>;
    free: string[];
};
export type LedgerEntry = {
    index: number;
    prevHash: string;
    timestamp: string;
    dataHash: string;
    hash: string;
    signature: string;
    keyId: string;
    type?: string;
    count?: number;
};
export type AttestResponse = {
    attested: true;
    entry: LedgerEntry;
    verifyUrl: string;
    note: string;
};
export type BatchResponse = {
    committed: true;
    entry: LedgerEntry;
    root: string;
    count: number;
    proofUrl: string;
    verifyUrl: string;
    note: string;
};
export type ProofResponse = {
    index: number;
    item: string;
    root: string;
    leaf: string;
    proof: ProofStep[];
    verify: {
        valid: boolean;
        computedRoot?: string;
        reason?: string;
    };
};
export type BatchVerifyResponse = {
    included: boolean;
    computedRoot: string;
    root: string;
    chainIntact: boolean;
    keyId: string;
    entryIndex: number;
};
export type LedgerResponse = {
    total: number;
    from: number;
    count: number;
    entries: LedgerEntry[];
};
export type PubkeyResponse = Record<string, unknown>;
export type VerifyResponse = {
    verified: boolean;
    signatureValid: boolean;
    chainIntact: boolean;
    reason: string | null;
    entry: LedgerEntry;
};
export type ClientOptions = {
    baseUrl: string;
    signer?: Signer;
    fetch?: typeof globalThis.fetch;
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: (upperBoundMs: number) => number;
};
export declare class ValueApiError extends Error {
    readonly status: number;
    readonly body: unknown;
    readonly terms?: X402Terms[];
    constructor(message: string, status: number, body: unknown, terms?: X402Terms[]);
}
export declare class ValueApiClient {
    private readonly baseUrl;
    private readonly signer?;
    private readonly fetchImpl;
    private readonly retries;
    private readonly baseDelayMs;
    private readonly maxDelayMs;
    private readonly jitter;
    constructor(options: ClientOptions);
    health(): Promise<ApiResult<Health>>;
    pricing(): Promise<ApiResult<Pricing>>;
    attest(data: string): Promise<ApiResult<AttestResponse>>;
    batch(items: readonly unknown[]): Promise<ApiResult<BatchResponse>>;
    proof(index: number, item: string): Promise<ApiResult<ProofResponse>>;
    batchVerify(index: number, item: string): Promise<ApiResult<BatchVerifyResponse>>;
    readLedger(from?: number, limit?: number): Promise<ApiResult<LedgerResponse>>;
    pubkey(): Promise<ApiResult<PubkeyResponse>>;
    verify(index: number, dataHash?: string): Promise<ApiResult<VerifyResponse>>;
    private request;
}
export declare function createClient(options: ClientOptions): ValueApiClient;
