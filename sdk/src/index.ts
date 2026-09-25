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
  payment?: { terms: X402Terms; settlementHeaders: SettlementHeaders };
};

export type Health = {
  status: string; agent: string; version: string; uptimeSeconds: number;
  payTo: string; network: string; ledger: number; freeTrialPerDay: number; now: string;
};
export type Pricing = {
  service: string; version: string; agent: string; currency: string; network: string;
  chainId: number; asset: string; payTo: string; scheme: string; settlement: string;
  pricing: { perCallUsdc: string; perCallBaseUnits: string };
  paymentHeader: string; freeTrial: { callsPerDay: number; per: string; note: string };
  note: string; endpoints: Array<Record<string, unknown>>; free: string[];
};
export type LedgerEntry = {
  index: number; prevHash: string; timestamp: string; dataHash: string; hash: string;
  signature: string; keyId: string; type?: string; count?: number;
};
export type AttestResponse = {
  attested: true; entry: LedgerEntry; verifyUrl: string; note: string;
};
export type BatchResponse = {
  committed: true; entry: LedgerEntry; root: string; count: number;
  proofUrl: string; verifyUrl: string; note: string;
};
export type ProofResponse = {
  index: number; item: string; root: string; leaf: string; proof: ProofStep[];
  verify: { valid: boolean; computedRoot?: string; reason?: string };
};
export type BatchVerifyResponse = {
  included: boolean; computedRoot: string; root: string; chainIntact: boolean;
  keyId: string; entryIndex: number;
};
export type LedgerResponse = { total: number; from: number; count: number; entries: LedgerEntry[] };
export type PubkeyResponse = Record<string, unknown>;
export type VerifyResponse = {
  verified: boolean; signatureValid: boolean; chainIntact: boolean;
  reason: string | null; entry: LedgerEntry;
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

export class ValueApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly terms?: X402Terms[];
  constructor(message: string, status: number, body: unknown, terms?: X402Terms[]) {
    super(message);
    this.name = 'ValueApiError';
    this.status = status;
    this.body = body;
    this.terms = terms;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function parseTerms(body: unknown): X402Terms[] {
  const accepts = objectRecord(body)?.accepts;
  if (!Array.isArray(accepts)) return [];
  return accepts.filter((item): item is X402Terms => {
    const t = objectRecord(item);
    return t?.scheme === 'exact' && t.network === 'base' && t.chainId === 8453 &&
      typeof t.asset === 'string' && typeof t.payTo === 'string' && typeof t.maxAmountRequired === 'string';
  });
}

function settlementHeaders(headers: Headers): SettlementHeaders {
  const result: SettlementHeaders = {};
  for (const name of ['x-payment-settled', 'x-payment-tx', 'x-payment-from', 'x-free-trial', 'x-free-trial-remaining']) {
    const value = headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

export class ValueApiClient {
  private readonly baseUrl: string;
  private readonly signer?: Signer;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitter: (upperBoundMs: number) => number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.signer = options.signer;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.retries = Math.max(0, Math.floor(options.retries ?? 3));
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? 200);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? 3_000);
    this.jitter = options.jitter ?? ((upper) => Math.floor(Math.random() * (upper + 1)));
  }

  health(): Promise<ApiResult<Health>> { return this.request('/health'); }
  pricing(): Promise<ApiResult<Pricing>> { return this.request('/pricing'); }
  attest(data: string): Promise<ApiResult<AttestResponse>> {
    return this.request('/v2/attest', { method: 'POST', body: JSON.stringify({ data }), headers: { 'content-type': 'application/json' } });
  }
  batch(items: readonly unknown[]): Promise<ApiResult<BatchResponse>> {
    const normalized = items.map((item) => typeof item === 'string' ? item : JSON.stringify(item));
    return this.request('/v2/batch', { method: 'POST', body: JSON.stringify({ items: normalized }), headers: { 'content-type': 'application/json' } });
  }
  proof(index: number, item: string): Promise<ApiResult<ProofResponse>> {
    return this.request(`/v2/proof?index=${encodeURIComponent(String(index))}&item=${encodeURIComponent(item)}`);
  }
  batchVerify(index: number, item: string): Promise<ApiResult<BatchVerifyResponse>> {
    return this.request(`/v2/batch/verify?index=${encodeURIComponent(String(index))}&item=${encodeURIComponent(item)}`);
  }
  readLedger(from = 0, limit = 50): Promise<ApiResult<LedgerResponse>> {
    return this.request(`/v2/ledger?from=${encodeURIComponent(String(from))}&limit=${encodeURIComponent(String(limit))}`);
  }
  pubkey(): Promise<ApiResult<PubkeyResponse>> { return this.request('/v2/pubkey'); }
  verify(index: number, dataHash?: string): Promise<ApiResult<VerifyResponse>> {
    const query = new URLSearchParams({ index: String(index) });
    if (dataHash !== undefined) query.set('dataHash', dataHash);
    return this.request(`/v2/verify?${query.toString()}`);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    const sendWithRetry = async (paymentHash?: string): Promise<Response> => {
      if (paymentHash) headers.set('X-PAYMENT', paymentHash);
      let lastError: unknown;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        try {
          const response = await this.fetchImpl(url, { ...init, headers });
          if (response.status < 500 || response.status > 599 || attempt === this.retries) return response;
          lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
          lastError = error;
          if (attempt === this.retries) throw error;
        }
        const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** attempt));
        const delay = Math.max(0, Math.min(ceiling, this.jitter(ceiling)));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      throw lastError instanceof Error ? lastError : new Error('request_failed');
    };

    let response = await sendWithRetry();
    let terms: X402Terms | undefined;
    if (response.status === 402) {
      const body = await response.clone().json().catch(() => undefined) as unknown;
      const accepted = parseTerms(body);
      if (this.signer && accepted.length > 0) {
        terms = accepted[0]!;
        const txHash = await this.signer(terms);
        if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new TypeError('signer must return a 32-byte transaction hash');
        response = await sendWithRetry(txHash);
      } else {
        throw new ValueApiError('Payment required; no compatible signer is available', 402, body, accepted);
      }
    }

    const body = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      const message = objectRecord(body)?.error;
      throw new ValueApiError(typeof message === 'string' ? message : `HTTP ${response.status}`, response.status, body);
    }
    const result: ApiResult<T> = { data: body as T };
    if (terms) result.payment = { terms, settlementHeaders: settlementHeaders(response.headers) };
    return result;
  }
}

export function createClient(options: ClientOptions): ValueApiClient { return new ValueApiClient(options); }
