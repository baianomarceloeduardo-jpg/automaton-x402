'use strict';
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'server.js');
let s = fs.readFileSync(target, 'utf8');
const original = s;

// 1. Require modules
if (!s.includes("const ORACLE_REAL = require('./oracle-real.js');")) {
  s = s.replace(
    "const CONFORMANCE = require('./x402-conformance.js');",
    "const CONFORMANCE = require('./x402-conformance.js');\nconst ORACLE_REAL = require('./oracle-real.js');\nconst FACILITATOR = require('./x402-facilitator.js');"
  );
  console.log('[1/4] Modules required.');
}

// 2. Standard x402 paymentRequired
const oldPaymentRequired = `function paymentRequired(res, endpoint, extra) {
  stats.unpaidChallenges++; saveStats();
  return send(res, 402, Object.assign({ error: 'payment_required', x402Version: 1,
    accepts: [{ scheme: 'exact', network: NETWORK, chainId: CHAIN_ID, asset: USDC_BASE, payTo: PAY_TO,
      maxAmountRequired: PRICE_BASE_UNITS.toString(), resource: endpoint, description: 'Automaton-Sovereign Value API call', mimeType: 'application/json' }],
    howTo: 'Send exactly ' + PRICE_USDC + ' USDC on Base to ' + PAY_TO + ', then resend with header X-PAYMENT: <txHash>.'
  }, extra || {}), { 'WWW-Authenticate': 'x402 realm="automaton-value-api"' });
}`;

const newPaymentRequired = `function paymentRequired(res, endpoint, extra) {
  stats.unpaidChallenges++; saveStats();
  const pr = FACILITATOR.buildPaymentRequired(endpoint, {
    payTo: PAY_TO,
    priceBaseUnits: PRICE_BASE_UNITS.toString(),
    priceUsdc: PRICE_USDC,
    baseUrl: base(),
    description: 'Automaton-Sovereign Value API call'
  });
  return send(res, 402, Object.assign(pr, extra || {}), {
    'WWW-Authenticate': 'x402 realm="automaton-value-api"',
    'X-Payment-Required': Buffer.from(JSON.stringify(pr)).toString('base64')
  });
}`;

if (s.includes(oldPaymentRequired)) {
  s = s.replace(oldPaymentRequired, newPaymentRequired);
  console.log('[2/4] paymentRequired updated to official x402 specification.');
}

// 3. Multi-standard authorize (EIP-3009 + Facilitator + Legacy txHash)
const oldAuthorize = `async function authorize(req, res, endpoint) {
  const tx = req.headers['x-payment'] || '';
  if (tx) {
    const key = String(tx).trim().toLowerCase();
    if (spentTx.has(key)) {
      stats.rejected++; saveStats();
      send(res, 402, { error: 'payment_invalid', reason: 'tx_already_used' });
      return false;
    }
    // Optimistic lock to prevent concurrent double-spends
    spentTx.add(key);
    const v = await verifyPayment(key);
    if (!v.ok) {
      spentTx.delete(key);
      stats.rejected++; saveStats();
      send(res, 402, { error: 'payment_invalid', reason: v.reason, detail: v });
      return false;
    }
    saveSpent();
    stats.paidCalls++; stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] || 0) + 1; saveStats();
    res._settled = { 'X-Payment-Settled': 'true', 'X-Payment-Tx': key, 'X-Payment-From': v.from || 'trust_mode' };
    return true;
  }`;

const newAuthorize = `async function authorize(req, res, endpoint) {
  const rawPayment = req.headers['x-payment'] || '';
  if (rawPayment) {
    const parsed = FACILITATOR.parsePaymentHeader(rawPayment);
    if (parsed && parsed.type === 'x402-standard') {
      const v = await FACILITATOR.verifyAuthorization(parsed.data, {
        payTo: PAY_TO,
        minAmountRequired: PRICE_BASE_UNITS.toString()
      });
      if (!v.ok) {
        stats.rejected++; saveStats();
        send(res, 402, { error: 'payment_invalid', reason: v.reason, detail: v });
        return false;
      }
      stats.paidCalls++; stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] || 0) + 1; saveStats();
      const respHeader = FACILITATOR.buildPaymentResponseHeader(v);
      res._settled = {
        'X-Payment-Settled': 'true',
        'X-Payment-Response': respHeader,
        'X-Payment-From': v.payer || 'x402-standard'
      };
      return true;
    } else {
      const key = (parsed && parsed.txHash) ? parsed.txHash : String(rawPayment).trim().toLowerCase();
      if (spentTx.has(key)) {
        stats.rejected++; saveStats();
        send(res, 402, { error: 'payment_invalid', reason: 'tx_already_used' });
        return false;
      }
      spentTx.add(key);
      const v = await verifyPayment(key);
      if (!v.ok) {
        spentTx.delete(key);
        stats.rejected++; saveStats();
        send(res, 402, { error: 'payment_invalid', reason: v.reason, detail: v });
        return false;
      }
      saveSpent();
      stats.paidCalls++; stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] || 0) + 1; saveStats();
      res._settled = { 'X-Payment-Settled': 'true', 'X-Payment-Tx': key, 'X-Payment-From': v.from || 'trust_mode' };
      return true;
    }
  }`;

if (s.includes(oldAuthorize)) {
  s = s.replace(oldAuthorize, newAuthorize);
  console.log('[3/4] authorize updated to support standard x402 EIP-3009 authorizations.');
}

// 4. Real on-chain oracle handler in /v2/oracle/base
const oldOracleHandler = `  // --- High-Value Endpoint 1: Base DeFi Oracle & Gas Tracker ---
  if (p === '/v2/oracle/base') {
    if (!(await authorize(req, res, '/v2/oracle/base'))) return;
    const gas = await getBaseGasEstimate();
    const prices = getOraclePrices();
    const ts = new Date().toISOString();
    const payload = JSON.stringify({ ts, chainId: CHAIN_ID, gas, prices });
    const sig = signOracleFeed(payload);
    stats.oracleQueries = (stats.oracleQueries || 0) + 1; saveStats();
    return send(res, 200, {
      oracle: AGENT,
      network: NETWORK,
      chainId: CHAIN_ID,
      timestamp: ts,
      gas,
      prices,
      signature: sig.signature,
      signatureHash: sig.hash,
      keyId: sig.keyId,
      algorithm: sig.alg,
      verifyUrl: base() + '/v2/pubkey',
      paid: true
    }, res._settled);
  }`;

const newOracleHandler = `  // --- High-Value Endpoint 1: Base DeFi Oracle & Gas Tracker (LIVE ON-CHAIN) ---
  if (p === '/v2/oracle/base') {
    if (!(await authorize(req, res, '/v2/oracle/base'))) return;
    try {
      const realData = await ORACLE_REAL.getRealOracleData();
      stats.oracleQueries = (stats.oracleQueries || 0) + 1; saveStats();
      return send(res, 200, Object.assign({
        oracle: AGENT,
        verifyUrl: base() + '/v2/pubkey',
        paid: true
      }, realData), res._settled);
    } catch (e) {
      return send(res, 500, { error: 'oracle_query_failed', message: e.message });
    }
  }`;

if (s.includes(oldOracleHandler)) {
  s = s.replace(oldOracleHandler, newOracleHandler);
  console.log('[4/4] /v2/oracle/base updated to live on-chain Uniswap V3 + Chainlink data.');
}

if (s !== original) {
  fs.writeFileSync(target + '.bak_phase1', original, 'utf8');
  fs.writeFileSync(target, s, 'utf8');
  console.log('SUCCESS: server.js patched with Phase 1 live oracle and x402 facilitator.');
} else {
  console.log('NOTICE: No changes applied.');
}
