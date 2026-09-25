'use strict';
/**
 * payment-verify.js - GENERALIZED on-chain USDC/ERC-20 transfer verifier.
 * Free public utility: any agent or human can confirm a payment is real, confirmed,
 * and directed to the intended recipient. Protocol-aware RPC (http or https).
 */
const https = require('https');
const http = require('http');

const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const DEFAULT_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const u = new URL(RPC_URL);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); if (j.error) return reject(new Error(j.error.message || 'rpc_error')); resolve(j.result); }
        catch (e) { reject(new Error('bad_rpc_response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('rpc_timeout')));
    req.write(payload); req.end();
  });
}

function normalizeAddr(t) {
  if (!t) return null;
  const h = String(t).toLowerCase().replace(/^0x/, '');
  return '0x' + h.slice(-40);
}

/**
 * verifyTransfer({txHash, asset, to, minAmount, minConfirmations})
 * -> { ok, reason, from, to, asset, valueBaseUnits, confirmations, blockNumber, txHash, checkedAt }
 * reason: malformed_tx_hash | tx_not_found | tx_failed | no_matching_transfer |
 *         recipient_mismatch | underpaid | insufficient_confirmations | rpc_error:* | null
 */
async function verifyTransfer(opts) {
  const o = opts || {};
  const out = {
    txHash: o.txHash || null, ok: false, reason: null, from: null, to: null,
    asset: o.asset ? normalizeAddr(o.asset) : DEFAULT_ASSET, valueBaseUnits: null,
    confirmations: null, blockNumber: null, txHashValid: false, checkedAt: new Date().toISOString()
  };
  const asset = normalizeAddr(o.asset || DEFAULT_ASSET);
  const wantTo = o.to ? normalizeAddr(o.to) : null;
  const minAmount = typeof o.minAmount === 'bigint' ? o.minAmount : BigInt(o.minAmount || 0);
  const minConf = typeof o.minConfirmations === 'number' && o.minConfirmations >= 0 ? o.minConfirmations : 1;

  if (!o.txHash || !/^0x[0-9a-fA-F]{64}$/.test(o.txHash)) { out.reason = 'malformed_tx_hash'; return out; }
  out.txHashValid = true;

  let receipt;
  try { receipt = await rpc('eth_getTransactionReceipt', [o.txHash]); }
  catch (e) { out.reason = 'rpc_error: ' + e.message; return out; }
  if (!receipt) { out.reason = 'tx_not_found'; return out; }
  if (receipt.status !== '0x1') { out.reason = 'tx_failed'; return out; }
  out.blockNumber = parseInt(receipt.blockNumber, 16);

  const logs = receipt.logs || [];
  const matching = logs.filter(l =>
    l.address && normalizeAddr(l.address) === asset &&
    l.topics && l.topics[0] && l.topics[0].toLowerCase() === TRANSFER_TOPIC &&
    l.topics.length >= 3);
  if (!matching.length) { out.reason = 'no_matching_transfer'; return out; }

  let log = matching.find(l => !wantTo || normalizeAddr(l.topics[2]) === wantTo);
  if (!log) { out.reason = 'recipient_mismatch'; out.to = normalizeAddr(matching[0].topics[2]); return out; }

  out.from = normalizeAddr(log.topics[1]);
  out.to = normalizeAddr(log.topics[2]);
  let value; try { value = BigInt(log.data); } catch (e) { out.reason = 'bad_value'; return out; }
  out.valueBaseUnits = value.toString();
  if (value < minAmount) { out.reason = 'underpaid'; return out; }

  try {
    const latest = await rpc('eth_blockNumber', []);
    out.confirmations = parseInt(latest, 16) - out.blockNumber + 1;
  } catch (e) { out.confirmations = null; }
  if (out.confirmations !== null && out.confirmations < minConf) { out.reason = 'insufficient_confirmations'; return out; }

  out.ok = true; out.reason = null; return out;
}

module.exports = { verifyTransfer, rpc, normalizeAddr, TRANSFER_TOPIC, DEFAULT_ASSET, RPC_URL };
