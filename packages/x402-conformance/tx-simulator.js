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

const DEFAULT_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
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
      let d = ''; res.on('data', (c) => d += c);
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

async function simulate(input, opts) {
  input = input || {};
  opts = opts || {};
  const rpcUrl = opts.rpcUrl || DEFAULT_RPC;
  const out = { ok: false, network: 'base', chainId: 8453, willRevert: null, revertReason: null, estimatedGas: null, returnData: null };

  if (!isAddr(input.to)) { out.error = 'to must be a 0x-prefixed 20-byte address'; return out; }
  if (input.from !== undefined && input.from !== null && input.from !== '' && !isAddr(input.from)) { out.error = 'from must be a 0x-prefixed 20-byte address'; return out; }
  const data = input.data === undefined || input.data === null || input.data === '' ? '0x' : String(input.data);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) { out.error = 'data must be 0x-prefixed even-length hex'; return out; }
  let value; try { value = toQuantity(input.value); } catch (e) { out.error = e.message; return out; }

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
  try {
    [call, gas] = await Promise.all([rpcCall(rpcUrl, 'eth_call', [tx, block]), rpcCall(rpcUrl, 'eth_estimateGas', [tx, block])]);
  } catch (e) { out.error = 'rpc_unreachable: ' + e.message; return out; }

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
    if (out.willRevert === false) {
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

module.exports = { simulate, decodeRevert, toQuantity, PANIC_CODES };
