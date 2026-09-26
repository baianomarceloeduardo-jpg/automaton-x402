'use strict';
/**
 * Base Mainnet transaction simulator (zero deps).
 *
 * simulate({ to, data, value, from }) runs eth_call + eth_estimateGas against a Base RPC at a
 * pinned block and predicts whether the tx will revert, decoding Error(string) (0x08c379a0),
 * Panic(uint256) (0x4e487b71) and surfacing custom-error selectors.
 *
 * Returns { ok, willRevert, revertReason, estimatedGas, returnData, ... }.
 *   ok          true when the simulation ran (RPC answered); false on bad input / RPC failure.
 *   willRevert  true when the call reverts or the node rejects it (e.g. insufficient funds).
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_RPC = process.env.SIM_RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const MAX_DATA_BYTES = 65536;                  // well above any real tx; bounds upstream work
const MAX_DATA_HEX = 2 + MAX_DATA_BYTES * 2;
const MAX_RPC_RESPONSE = 2 * 1024 * 1024;      // cap memory per upstream response
const BASE_CHAIN_ID = '0x2105'; // 8453

const PANIC_CODES = {
  0x00: 'generic compiler panic',
  0x01: 'assertion failed',
  0x11: 'arithmetic overflow or underflow',
  0x12: 'division or modulo by zero',
  0x21: 'invalid enum value',
  0x22: 'corrupted storage byte array',
  0x31: 'pop() on empty array',
  0x32: 'array index out of bounds',
  0x41: 'out of memory / allocation too large',
  0x51: 'call to zero-initialized function pointer'
};

function rpcCall(rpcUrl, method, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(rpcUrl);
    const lib = u.protocol === 'http:' ? http : https;
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'automaton-simulator/1.0' } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; if (d.length > MAX_RPC_RESPONSE) req.destroy(new Error('rpc_response_too_large')); });
      res.on('end', () => {
        let j; try { j = JSON.parse(d); } catch (e) { return reject(new Error('bad_rpc_response (HTTP ' + res.statusCode + ')')); }
        resolve(j); // caller inspects j.result / j.error (a revert arrives as j.error)
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('rpc_timeout')));
    req.write(payload); req.end();
  });
}

function isAddr(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }

// Accepts wei as decimal string/number, 0x-hex, or bigint. Returns a JSON-RPC quantity.
function toQuantity(v) {
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return '0x0';
  let n;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'number') { if (!Number.isSafeInteger(v) || v < 0) throw new Error('value must be a non-negative integer (wei)'); n = BigInt(v); }
  else if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) n = BigInt(v);
  else if (typeof v === 'string' && /^\d+$/.test(v)) n = BigInt(v);
  else throw new Error('value must be wei as a decimal or 0x-hex integer');
  if (n < 0n) throw new Error('value must be non-negative');
  return '0x' + n.toString(16);
}

function decodeRevert(hex) {
  const data = typeof hex === 'string' ? hex.toLowerCase() : '';
  if (!data || data === '0x') return { errorType: 'empty', reason: 'reverted without a reason' };
  const sel = data.slice(0, 10);
  const body = data.slice(10);
  try {
    if (sel === '0x08c379a0' && body.length >= 128) {
      const off = Number(BigInt('0x' + body.slice(0, 64))) * 2;
      const len = Number(BigInt('0x' + body.slice(off, off + 64)));
      const str = Buffer.from(body.slice(off + 64, off + 64 + len * 2), 'hex').toString('utf8');
      return { errorType: 'Error(string)', reason: str };
    }
    if (sel === '0x4e487b71' && body.length >= 64) {
      const code = Number(BigInt('0x' + body.slice(0, 64)));
      return { errorType: 'Panic(uint256)', panicCode: '0x' + code.toString(16).padStart(2, '0'),
        reason: 'Panic(0x' + code.toString(16).padStart(2, '0') + '): ' + (PANIC_CODES[code] || 'unknown panic code') };
    }
  } catch (e) { /* fall through to raw selector */ }
  return { errorType: 'custom', selector: sel, reason: 'custom error ' + sel + ' (not ABI-decoded)' };
}

// Node errors carry revert data in error.data (string) or error.data.data depending on client.
function revertDataOf(err) {
  if (!err) return null;
  const d = err.data;
  if (typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d)) return d;
  if (d && typeof d === 'object' && typeof d.data === 'string') return d.data;
  return null;
}

// JSON-RPC error -> 'revert' (execution reverted), 'rejected' (node refuses the tx itself:
// funds, gas, nonce) or 'transient' (rate limit, capacity, internal: says nothing about the tx).
function classify(err) {
  if (!err) return null;
  if (revertDataOf(err)) return 'revert';
  const msg = String(err.message || '');
  if (err.code === 3 || /revert/i.test(msg)) return 'revert';
  if (/insufficient funds|OutOfFunds|gas required exceeds|intrinsic gas|gas too low|exceeds block gas limit|nonce|invalid opcode|out of gas|stack (over|under)flow|InvalidFEOpcode|OpcodeNotFound/i.test(msg)) return 'rejected';
  return 'transient';
}

// Returns an error string for unusable input, or null. Pure and cheap: callers run it before
// charging a payment or spending an RPC call.
function validate(input) {
  input = input || {};
  if (!isAddr(input.to)) return 'to must be a 0x-prefixed 20-byte address';
  if (input.from !== undefined && input.from !== null && input.from !== '' && !isAddr(input.from)) return 'from must be a 0x-prefixed 20-byte address';
  const data = input.data === undefined || input.data === null || input.data === '' ? '0x' : input.data;
  if (typeof data !== 'string') return 'data must be a 0x-hex string';
  if (data.length > MAX_DATA_HEX) return 'calldata too large (max ' + MAX_DATA_BYTES + ' bytes)';
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) return 'data must be 0x-prefixed even-length hex';
  try { toQuantity(input.value); } catch (e) { return e.message; }
  return null;
}

// Process-wide limiter: the free MCP tool must not turn this host into an open Base RPC proxy
// (each simulation costs 4 upstream calls, and the same public RPC verifies our payments).
const RATE_PER_MIN = parseInt(process.env.SIM_RATE_PER_MIN || '120', 10);
const MAX_CONCURRENT = parseInt(process.env.SIM_MAX_CONCURRENT || '8', 10);
let tokens = RATE_PER_MIN, refillAt = Date.now(), inFlight = 0;
function acquire() {
  const now = Date.now();
  tokens = Math.min(RATE_PER_MIN, tokens + ((now - refillAt) / 60000) * RATE_PER_MIN);
  refillAt = now;
  if (inFlight >= MAX_CONCURRENT) return 'rate_limited: too many concurrent simulations, retry shortly';
  if (tokens < 1) return 'rate_limited: simulation quota exceeded (' + RATE_PER_MIN + '/min), retry shortly';
  tokens -= 1; inFlight++;
  return null;
}

async function simulate(input, opts) {
  input = input || {};
  opts = opts || {};
  const out = { ok: false, network: 'base', chainId: 8453, willRevert: null, revertReason: null, estimatedGas: null, returnData: null };
  const invalid = validate(input);
  if (invalid) { out.error = invalid; return out; }
  // Paid HTTP calls (already metered by x402) skip the free-tier limiter but not the concurrency cap.
  if (!opts.bypassLimit) {
    const limited = acquire();
    if (limited) { out.error = limited; out.rateLimited = true; return out; }
  } else inFlight++;
  try { return await run(input, opts, out); } finally { inFlight--; }
}

async function run(input, opts, out) {
  const rpcUrl = opts.rpcUrl || DEFAULT_RPC;
  const data = input.data === undefined || input.data === null || input.data === '' ? '0x' : input.data;
  const value = toQuantity(input.value);

  const tx = { to: input.to, data, value };
  if (input.from) tx.from = input.from;

  let chain, head;
  try {
    [chain, head] = await Promise.all([rpcCall(rpcUrl, 'eth_chainId', []), rpcCall(rpcUrl, 'eth_blockNumber', [])]);
  } catch (e) { out.error = 'rpc_unreachable: ' + e.message; return out; }
  if (!chain.result || String(chain.result).toLowerCase() !== BASE_CHAIN_ID) { out.error = 'rpc is not Base Mainnet (chainId ' + (chain.result || '?') + ')'; return out; }
  if (!head.result) { out.error = 'rpc_error: ' + ((head.error && head.error.message) || 'no block number'); return out; }
  const block = head.result;
  out.blockNumber = parseInt(block, 16);
  out.tx = tx;

  let call, gas;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      [call, gas] = await Promise.all([rpcCall(rpcUrl, 'eth_call', [tx, block]), rpcCall(rpcUrl, 'eth_estimateGas', [tx, block])]);
    } catch (e) { out.error = 'rpc_unreachable: ' + e.message; return out; }
    // Rate limits / capacity errors are not reverts: retry once, then report ok:false.
    if (classify(call.error) !== 'transient' && classify(gas.error) !== 'transient') break;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  if (classify(call.error) === 'transient') {
    out.error = 'rpc_error: ' + String(call.error.message || call.error.code || 'unknown').slice(0, 200);
    return out;
  }

  out.ok = true;
  if (call.error) {
    const rd = revertDataOf(call.error);
    out.willRevert = true;
    out.returnData = rd;
    if (rd) {
      const dec = decodeRevert(rd);
      out.revertReason = dec.reason; out.errorType = dec.errorType;
      if (dec.panicCode) out.panicCode = dec.panicCode;
      if (dec.selector) out.errorSelector = dec.selector;
    } else {
      // No revert payload: node-level rejection (insufficient funds, bad nonce, ...) or bare revert.
      const msg = String(call.error.message || 'execution failed');
      out.revertReason = msg;
      out.errorType = /revert/i.test(msg) ? 'empty' : 'node_rejected';
    }
  } else {
    out.willRevert = false;
    out.returnData = call.result || '0x';
  }

  if (gas.result) out.estimatedGas = parseInt(gas.result, 16);
  else if (gas.error) {
    out.estimateGasError = String(gas.error.message || 'estimateGas failed');
    // eth_call can pass while estimateGas fails (e.g. gas-dependent logic): still a revert on-chain.
    // A transient RPC error on estimateGas alone says nothing about the tx, so it does not flip it.
    if (out.willRevert === false && classify(gas.error) !== 'transient') {
      out.willRevert = true;
      const rd = revertDataOf(gas.error);
      const dec = rd ? decodeRevert(rd) : null;
      out.revertReason = dec ? dec.reason : out.estimateGasError;
      out.errorType = dec ? dec.errorType : 'estimate_gas_failed';
    }
  }
  out.success = out.willRevert === false;
  out.simulatedAt = new Date().toISOString();
  return out;
}

module.exports = { simulate, validate, decodeRevert, toQuantity, PANIC_CODES };
