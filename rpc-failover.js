// rpc-failover.js — multi-endpoint read layer. Zero deps beyond ethers.
//
// WHY: the sovereign settlement proof hit `error code -32016 "over rate limit"` on the public
// Base RPC immediately after a successful broadcast. A single public RPC is a single point of
// failure for the money path: any read (authorizationState, balanceOf, getBalance) can fail
// transiently and must NOT be interpreted as a business outcome ("nonce not consumed").
//
// DESIGN: reads go through FallbackProvider quorum=1 across several public Base endpoints, with
// an explicit retry loop on top. Writes (broadcast) use ONE provider so we never double-submit.

const RPC_LIST = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
  'https://1rpc.io/base',
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Reads: failover + retry. `fn(provider)` must be a read-only call.
async function withRetry(fn, { attempts = 5, baseMs = 600, label = 'read' } = {}) {
  const { ethers } = require('ethers');
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    // Build a fallback provider whose endpoint ORDER rotates each attempt, so a rate-limited
    // endpoint is not the one we keep hitting first.
    const rotated = RPC_LIST.slice(i % RPC_LIST.length).concat(RPC_LIST.slice(0, i % RPC_LIST.length));
    let provider;
    try {
      const providers = rotated.map(u => new ethers.JsonRpcProvider(u, 8453, { staticNetwork: true }));
      provider = providers.length > 1
        ? new ethers.FallbackProvider(providers, 8453, { quorum: 1 })
        : providers[0];
      return await fn(provider);
    } catch (e) {
      lastErr = e;
      const rl = e && (e.info && e.info.error && e.info.error.code === -32016) || /rate limit|429|timeout|ETIMEDOUT|ECONNRESET/i.test(String(e && e.message));
      if (i < attempts - 1) await sleep(baseMs * Math.pow(2, i) + Math.floor(Math.random() * 250));
      if (!rl && i >= 2) break; // non-transient failure: stop early
    } finally {
      try { if (provider && provider.destroy) provider.destroy(); } catch (e) {}
    }
  }
  throw lastErr || new Error(label + '_failed');
}

// Writes: one provider, chosen by probing the list until one answers.
async function writeProvider() {
  const { ethers } = require('ethers');
  for (const u of RPC_LIST) {
    try {
      const p = new ethers.JsonRpcProvider(u, 8453, { staticNetwork: true });
      await p.getBlockNumber();
      return p;
    } catch (e) { /* try next */ }
  }
  throw new Error('no_rpc_available_for_write');
}

module.exports = { RPC_LIST, withRetry, writeProvider, sleep };