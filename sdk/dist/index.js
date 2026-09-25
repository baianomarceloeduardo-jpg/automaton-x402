export class ValueApiError extends Error {
    status;
    body;
    terms;
    constructor(message, status, body, terms) {
        super(message);
        this.name = 'ValueApiError';
        this.status = status;
        this.body = body;
        this.terms = terms;
    }
}
function objectRecord(value) {
    return value !== null && typeof value === 'object' ? value : undefined;
}
function parseTerms(body) {
    const accepts = objectRecord(body)?.accepts;
    if (!Array.isArray(accepts))
        return [];
    return accepts.filter((item) => {
        const t = objectRecord(item);
        return t?.scheme === 'exact' && t.network === 'base' && t.chainId === 8453 &&
            typeof t.asset === 'string' && typeof t.payTo === 'string' && typeof t.maxAmountRequired === 'string';
    });
}
function settlementHeaders(headers) {
    const result = {};
    for (const name of ['x-payment-settled', 'x-payment-tx', 'x-payment-from', 'x-free-trial', 'x-free-trial-remaining']) {
        const value = headers.get(name);
        if (value !== null)
            result[name] = value;
    }
    return result;
}
export class ValueApiClient {
    baseUrl;
    signer;
    fetchImpl;
    retries;
    baseDelayMs;
    maxDelayMs;
    jitter;
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.signer = options.signer;
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        this.retries = Math.max(0, Math.floor(options.retries ?? 3));
        this.baseDelayMs = Math.max(0, options.baseDelayMs ?? 200);
        this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? 3_000);
        this.jitter = options.jitter ?? ((upper) => Math.floor(Math.random() * (upper + 1)));
    }
    health() { return this.request('/health'); }
    pricing() { return this.request('/pricing'); }
    attest(data) {
        return this.request('/v2/attest', { method: 'POST', body: JSON.stringify({ data }), headers: { 'content-type': 'application/json' } });
    }
    batch(items) {
        const normalized = items.map((item) => typeof item === 'string' ? item : JSON.stringify(item));
        return this.request('/v2/batch', { method: 'POST', body: JSON.stringify({ items: normalized }), headers: { 'content-type': 'application/json' } });
    }
    proof(index, item) {
        return this.request(`/v2/proof?index=${encodeURIComponent(String(index))}&item=${encodeURIComponent(item)}`);
    }
    batchVerify(index, item) {
        return this.request(`/v2/batch/verify?index=${encodeURIComponent(String(index))}&item=${encodeURIComponent(item)}`);
    }
    readLedger(from = 0, limit = 50) {
        return this.request(`/v2/ledger?from=${encodeURIComponent(String(from))}&limit=${encodeURIComponent(String(limit))}`);
    }
    pubkey() { return this.request('/v2/pubkey'); }
    verify(index, dataHash) {
        const query = new URLSearchParams({ index: String(index) });
        if (dataHash !== undefined)
            query.set('dataHash', dataHash);
        return this.request(`/v2/verify?${query.toString()}`);
    }
    async request(path, init = {}) {
        const url = `${this.baseUrl}${path}`;
        const headers = new Headers(init.headers);
        const sendWithRetry = async (paymentHash) => {
            if (paymentHash)
                headers.set('X-PAYMENT', paymentHash);
            let lastError;
            for (let attempt = 0; attempt <= this.retries; attempt++) {
                try {
                    const response = await this.fetchImpl(url, { ...init, headers });
                    if (response.status < 500 || response.status > 599 || attempt === this.retries)
                        return response;
                    lastError = new Error(`HTTP ${response.status}`);
                }
                catch (error) {
                    lastError = error;
                    if (attempt === this.retries)
                        throw error;
                }
                const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** attempt));
                const delay = Math.max(0, Math.min(ceiling, this.jitter(ceiling)));
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
            throw lastError instanceof Error ? lastError : new Error('request_failed');
        };
        let response = await sendWithRetry();
        let terms;
        if (response.status === 402) {
            const body = await response.clone().json().catch(() => undefined);
            const accepted = parseTerms(body);
            if (this.signer && accepted.length > 0) {
                terms = accepted[0];
                const txHash = await this.signer(terms);
                if (!/^0x[0-9a-fA-F]{64}$/.test(txHash))
                    throw new TypeError('signer must return a 32-byte transaction hash');
                response = await sendWithRetry(txHash);
            }
            else {
                throw new ValueApiError('Payment required; no compatible signer is available', 402, body, accepted);
            }
        }
        const body = await response.json().catch(() => undefined);
        if (!response.ok) {
            const message = objectRecord(body)?.error;
            throw new ValueApiError(typeof message === 'string' ? message : `HTTP ${response.status}`, response.status, body);
        }
        const result = { data: body };
        if (terms)
            result.payment = { terms, settlementHeaders: settlementHeaders(response.headers) };
        return result;
    }
}
export function createClient(options) { return new ValueApiClient(options); }
