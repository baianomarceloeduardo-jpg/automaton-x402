# Automaton-Sovereign Value API SDK

Small TypeScript SDK for the Automaton-Sovereign Value API, targeting Node.js 22. It has no runtime dependencies and uses the built-in `fetch` and `node:crypto` APIs.

## Build

```sh
npm install
npm run build
```

The package ships ESM from `dist/`. `index.cjs` and `merkle.cjs` are asynchronous CommonJS bridges: `require()` returns a Promise for the ESM module namespace.

## ESM usage

```ts
import { createClient, type X402Terms } from 'automaton-sovereign-value-api';

const client = createClient({
  baseUrl: 'https://your-value-api.example',
  // Called only after a compatible HTTP 402 response. Submit the exact USDC
  // payment on Base and return its transaction hash (0x + 64 hex characters).
  signer: async (terms: X402Terms) => payUsdcOnBase({
    asset: terms.asset,
    recipient: terms.payTo,
    amount: terms.maxAmountRequired,
    chainId: terms.chainId,
  }),
});

const health = await client.health();
console.log(health.data.status);

const created = await client.attest('release 2026.09.25');
console.log(created.data.entry.index);
if (created.payment) {
  console.log(created.payment.terms, created.payment.settlementHeaders);
}

const committed = await client.batch(['alpha', { sku: 'A-1' }]);
const proof = await client.proof(committed.data.entry.index, 'alpha');
console.log(proof.data.verify.valid);
```

The signer owns wallet selection, transaction construction, signing, and submission. The SDK passes the server's compatible `accepts[]` terms to it, retries the API request once with `X-PAYMENT: <txHash>`, and returns the accepted terms plus settlement headers alongside the response body as `ApiResult<T>`. It never handles private keys itself.

## Typed methods

- `health()` → `GET /health`
- `pricing()` → `GET /pricing`
- `attest(data)` → `POST /v2/attest` with `{ "data": string }`
- `batch(items)` → `POST /v2/batch` with `{ "items": string[] }`; non-string items are JSON-stringified like the API
- `proof(index, item)` → `GET /v2/proof`
- `batchVerify(index, item)` → `GET /v2/batch/verify`
- `readLedger(from, limit)` → `GET /v2/ledger`
- `pubkey()` → `GET /v2/pubkey`
- `verify(index, dataHash?)` → `GET /v2/verify?index=...` (the optional hash is also passed as `dataHash`)

Methods return `{ data, payment? }`. `payment` is present when this request paid after a 402 and contains `{ terms, settlementHeaders }`. A 402 without a configured compatible signer throws `ValueApiError` with its parsed `terms`.

Retry configuration is bounded: `retries` is the maximum number of retries after the initial attempt (default 3), with exponential delay, capped by `maxDelayMs` (default 3000 ms) and randomized jitter. It applies to network failures and HTTP 5xx responses. Set `retries: 0` to disable retries.

## Standalone Merkle verifier

```ts
import { commit, verifyProof } from 'automaton-sovereign-value-api/merkle';

const tree = commit(['alpha', 'beta', 'gamma']);
console.log(verifyProof('beta', tree.proofs[1]!, tree.root));
```

The implementation matches `merkle.js`: leaves are SHA-256 of UTF-8 `asm-attest-v1:` plus `String(item)`; parent hashes are SHA-256 of the concatenated lowercase hexadecimal child hashes; an unpaired final node is paired with itself, as the source implementation does.
