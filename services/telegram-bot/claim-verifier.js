'use strict';
/**
 * Strict on-chain verification for the Telegram /claim <txHash> VIP flow.
 *
 * A claim is accepted only when the receipt shows, in THIS transaction:
 *   status 0x1, and USDC (native, Base) Transfer logs to the treasury summing >= minUnits,
 *   with >= minConfirmations and a block no older than maxAgeSec.
 * Each txHash activates VIP at most once (persistent store, reserved synchronously so two
 * concurrent claims of the same hash cannot both pass).
 *
 * Residual risk (documented, not solvable with a plain USDC transfer): a txHash is a bearer
 * credential, so whoever submits a fresh payment's hash first gets the pass. maxAgeSec keeps
 * old treasury inflows from being harvested.
 */
const fs = require('fs');

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TX_RE = /^0x[0-9a-fA-F]{64}$/;

const pad32 = addr => '0x' + '0'.repeat(24) + addr.toLowerCase().replace(/^0x/, '');

class UsedTxStore {
  constructor(file) {
    this.file = file;
    this.used = new Set();
    this.pending = new Set();
    try { for (const h of JSON.parse(fs.readFileSync(file, 'utf8')).used || []) this.used.add(h); } catch (e) {}
  }
  has(h) { return this.used.has(h) || this.pending.has(h); }
  reserve(h) { if (this.has(h)) return false; this.pending.add(h); return true; }
  release(h) { this.pending.delete(h); }
  commit(h) {
    this.pending.delete(h);
    this.used.add(h);
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ used: [...this.used] }, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

function createClaimVerifier({ rpc, treasury, store, minUnits = 2000000n, minConfirmations = 2, maxAgeSec = 48 * 3600, now = () => Date.now() }) {
  const wantTo = pad32(treasury);

  // Pure check of a receipt; exported for tests and reuse.
  function inspectReceipt(receipt) {
    if (!receipt) return { ok: false, reason: 'tx_not_found_or_pending' };
    if (receipt.status !== '0x1') return { ok: false, reason: 'tx_failed' };
    let total = 0n;
    let usdcTransfers = 0;
    let wrongRecipient = 0;
    for (const lg of receipt.logs || []) {
      if (!lg.topics || String(lg.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
      if (String(lg.address).toLowerCase() !== USDC_BASE) continue;
      if (lg.topics.length < 3) continue;
      usdcTransfers++;
      if (String(lg.topics[2]).toLowerCase() !== wantTo) { wrongRecipient++; continue; }
      try { total += BigInt(lg.data); } catch (e) { /* malformed data: ignore */ }
    }
    if (!usdcTransfers) return { ok: false, reason: 'no_usdc_transfer' };
    if (total === 0n && wrongRecipient) return { ok: false, reason: 'wrong_recipient' };
    if (total < minUnits) return { ok: false, reason: 'insufficient_amount', amountUnits: total.toString() };
    return { ok: true, amountUnits: total.toString() };
  }

  async function verify(txHash) {
    if (!TX_RE.test(String(txHash || ''))) return { ok: false, reason: 'invalid_hash' };
    const h = txHash.toLowerCase();
    if (!store.reserve(h)) return { ok: false, reason: 'already_used' };
    try {
      const receipt = await rpc('eth_getTransactionReceipt', [h]);
      const r = inspectReceipt(receipt);
      if (!r.ok) { store.release(h); return r; }
      const [latestHex, block] = await Promise.all([
        rpc('eth_blockNumber', []),
        rpc('eth_getBlockByNumber', [receipt.blockNumber, false])
      ]);
      const conf = Number(BigInt(latestHex) - BigInt(receipt.blockNumber)) + 1;
      if (conf < minConfirmations) { store.release(h); return { ok: false, reason: 'not_enough_confirmations', confirmations: conf }; }
      const ageSec = Math.floor(now() / 1000) - Number(BigInt(block.timestamp));
      if (ageSec > maxAgeSec) { store.release(h); return { ok: false, reason: 'tx_too_old', ageSec }; }
      store.commit(h);
      return { ok: true, amountUnits: r.amountUnits, confirmations: conf };
    } catch (e) {
      store.release(h);
      return { ok: false, reason: 'rpc_error', message: e.message };
    }
  }

  return { verify, inspectReceipt };
}

const REASON_PT = {
  invalid_hash: 'Hash de transação inválido.',
  already_used: 'Esta transação já foi usada para ativar um passe VIP.',
  tx_not_found_or_pending: 'Transação não encontrada ou ainda pendente. Tente novamente em alguns segundos.',
  tx_failed: 'A transação falhou on-chain (status diferente de sucesso).',
  no_usdc_transfer: 'Nenhuma transferência de USDC (Base) encontrada nesta transação.',
  wrong_recipient: 'A transferência de USDC não foi para a carteira do Automaton.',
  insufficient_amount: 'Valor insuficiente para o passe VIP.',
  not_enough_confirmations: 'Aguardando confirmações. Tente novamente em alguns segundos.',
  tx_too_old: 'Transação antiga demais para ativar um passe (limite de 48h).',
  rpc_error: 'Falha temporária ao consultar a Base. Tente novamente.'
};

const REASON_EN = {
  invalid_hash: 'Invalid transaction hash.',
  already_used: 'This transaction has already been used to activate a VIP pass.',
  tx_not_found_or_pending: 'Transaction not found or still pending on Base. Please retry in a few seconds.',
  tx_failed: 'The transaction failed on-chain (reverted status).',
  no_usdc_transfer: 'No native Base USDC Transfer found in this transaction.',
  wrong_recipient: 'The USDC transfer was not sent to the Automaton treasury wallet.',
  insufficient_amount: 'Insufficient amount for the VIP pass.',
  not_enough_confirmations: 'Awaiting block confirmations. Please retry in a few seconds.',
  tx_too_old: 'Transaction is too old to activate a pass (48h max age).',
  rpc_error: 'Temporary RPC error querying Base. Please try again.'
};

module.exports = { createClaimVerifier, UsedTxStore, REASON_PT, REASON_EN, USDC_BASE, TRANSFER_TOPIC, pad32 };
