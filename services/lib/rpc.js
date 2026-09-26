'use strict';
/**
 * Minimal Base JSON-RPC client with ordered failover.
 * Transport failures (timeout, HTTP error, bad JSON) fail over to the next URL;
 * JSON-RPC errors (e.g. an eth_call revert) are thrown immediately with `rpcCode`.
 */

const DEFAULT_RPCS = (process.env.BASE_RPC_URLS || 'https://base-rpc.publicnode.com,https://mainnet.base.org')
  .split(',').map(s => s.trim()).filter(Boolean);

function createRpc({ urls = DEFAULT_RPCS, timeoutMs = 10000, fetchImpl = globalThis.fetch } = {}) {
  if (!urls.length) throw new Error('createRpc: no RPC urls');
  let id = 0;
  let preferred = 0;

  async function call(method, params = []) {
    let lastErr;
    for (let i = 0; i < urls.length; i++) {
      const idx = (preferred + i) % urls.length;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetchImpl(urls[idx], {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: ctl.signal
        });
        if (!r.ok) throw new Error('http_' + r.status);
        const j = await r.json();
        if (j.error) {
          const e = new Error(j.error.message || 'rpc_error');
          e.rpcCode = j.error.code;
          e.data = j.error.data;
          throw e;
        }
        preferred = idx;
        return j.result;
      } catch (e) {
        if (e.rpcCode !== undefined) throw e;
        lastErr = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('rpc_unreachable');
  }

  return { call, urls };
}

const hexToNumber = h => Number(BigInt(h));
const toHex = n => '0x' + BigInt(n).toString(16);

module.exports = { createRpc, hexToNumber, toHex, DEFAULT_RPCS };
