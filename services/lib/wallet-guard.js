'use strict';
/**
 * Automaton Sovereign: Wallet Spend Guard
 *
 * Prevents unauthorized or autonomous outbound fund drainage.
 * By default, outbound spending (EIP-3009 transfer authorizations, ERC-20 transfers,
 * and native ETH value transactions) is HARD-LOCKED.
 *
 * To permit an outbound transfer, the operator must explicitly set:
 *   ALLOW_OUTBOUND_SPEND=1
 * Optional daily spending limit:
 *   MAX_DAILY_SPEND_USDC (e.g. "5.0")
 *
 * Every blocked and allowed spend attempt is recorded to services/logs/spend-ledger.json.
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('./store');

const DEFAULT_LEDGER_FILE = path.join(__dirname, '..', 'logs', 'spend-ledger.json');

function isSpendLocked(env = process.env) {
  const flag = String(env.ALLOW_OUTBOUND_SPEND || '').trim().toLowerCase();
  return flag !== '1' && flag !== 'true';
}

function getDailySpendTotal(ledgerFile = DEFAULT_LEDGER_FILE, now = Date.now()) {
  const ledger = readJson(ledgerFile, { records: [] });
  const dayAgo = now - 24 * 60 * 60 * 1000;
  let total = 0;
  for (const r of ledger.records || []) {
    if (r.status === 'ALLOWED' && r.timestamp && new Date(r.timestamp).getTime() >= dayAgo) {
      total += Number(r.amountUsdc || 0);
    }
  }
  return total;
}

function recordSpendAttempt(entry, ledgerFile = DEFAULT_LEDGER_FILE) {
  try {
    const ledger = readJson(ledgerFile, { version: 1, records: [] });
    ledger.records = (ledger.records || []).concat(entry).slice(-500);
    writeJsonAtomic(ledgerFile, ledger);
  } catch (_) {
    // Ledger write failures should never mask the guard verdict
  }
}

function assertSpendAllowed({
  to,
  amount,
  token = 'USDC',
  reason = 'unspecified',
  env = process.env,
  ledgerFile = DEFAULT_LEDGER_FILE,
  now = Date.now()
}) {
  const timestamp = new Date(now).toISOString();
  const locked = isSpendLocked(env);

  if (locked) {
    recordSpendAttempt({
      timestamp,
      status: 'BLOCKED',
      to: String(to || '').toLowerCase(),
      amount: String(amount || '0'),
      token,
      reason,
      blockReason: 'ALLOW_OUTBOUND_SPEND is not enabled (read-only wallet mode)'
    }, ledgerFile);

    throw new Error(
      `[WALLET_SPEND_GUARD_BLOCKED] Outbound spend of ${amount} ${token} to ${to} rejected (${reason}). ` +
      `Wallet outbound spend is locked by default. Set ALLOW_OUTBOUND_SPEND=1 to permit.`
    );
  }

  // If unlocked, verify optional daily limit if applicable
  const isDecimal = String(amount).includes('.');
  const amountUsdc = token === 'USDC'
    ? (isDecimal ? parseFloat(amount) : Number(amount) / 1e6)
    : 0;

  const maxDaily = env.MAX_DAILY_SPEND_USDC ? parseFloat(env.MAX_DAILY_SPEND_USDC) : null;
  if (maxDaily != null && !isNaN(maxDaily)) {
    const currentDaily = getDailySpendTotal(ledgerFile, now);
    if (currentDaily + amountUsdc > maxDaily) {
      recordSpendAttempt({
        timestamp,
        status: 'BLOCKED',
        to: String(to || '').toLowerCase(),
        amount: String(amount || '0'),
        amountUsdc,
        token,
        reason,
        blockReason: `Daily cap of $${maxDaily.toFixed(2)} exceeded (current 24h total: $${currentDaily.toFixed(2)})`
      }, ledgerFile);

      throw new Error(
        `[WALLET_SPEND_GUARD_BLOCKED] Daily spend cap exceeded ($${maxDaily.toFixed(2)}). ` +
        `Current 24h total is $${currentDaily.toFixed(2)}.`
      );
    }
  }

  // Record allowed spend
  recordSpendAttempt({
    timestamp,
    status: 'ALLOWED',
    to: String(to || '').toLowerCase(),
    amount: String(amount || '0'),
    amountUsdc,
    token,
    reason
  }, ledgerFile);

  return true;
}

/**
 * Wraps an ethers.Wallet / Signer object with safety proxies on spend-capable methods.
 */
function createGuardedWallet(wallet, { env = process.env, ledgerFile = DEFAULT_LEDGER_FILE } = {}) {
  if (!wallet) return wallet;

  return new Proxy(wallet, {
    get(target, prop, receiver) {
      if (prop === 'signTypedData') {
        return async function (domain, types, value) {
          const isSpendAuth = types && (types.TransferWithAuthorization || types.ReceiveWithAuthorization || types.Permit);
          if (isSpendAuth) {
            const to = (value && (value.to || value.spender)) || 'unknown';
            const amount = (value && (value.value != null ? value.value.toString() : 'unknown')) || '0';
            const token = (domain && domain.name) || 'USDC';
            assertSpendAllowed({
              to,
              amount,
              token,
              reason: 'signTypedData ' + (types.TransferWithAuthorization ? 'TransferWithAuthorization' : Object.keys(types)[0]),
              env,
              ledgerFile
            });
          }
          return Reflect.apply(target.signTypedData, target, [domain, types, value]);
        };
      }

      if (prop === 'sendTransaction') {
        return async function (tx) {
          if (tx && tx.value && BigInt(tx.value) > 0n) {
            assertSpendAllowed({
              to: tx.to,
              amount: tx.value.toString(),
              token: 'ETH (wei)',
              reason: 'sendTransaction native transfer',
              env,
              ledgerFile
            });
          }
          return Reflect.apply(target.sendTransaction, target, [tx]);
        };
      }

      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });
}

module.exports = {
  isSpendLocked,
  assertSpendAllowed,
  createGuardedWallet,
  getDailySpendTotal,
  recordSpendAttempt,
  DEFAULT_LEDGER_FILE
};
