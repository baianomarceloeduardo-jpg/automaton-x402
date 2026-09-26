// patch-money-path.js — fix the two defects found by live evidence capture.
//
// DEFECT 1: X-Payment-Tx empty on a REAL settled call.
//   server.js reads st.transaction, but the sovereign settler returns st.tx.
//   Result: a genuine on-chain settlement reported no tx hash to the payer.
//   (Also affects the legacy 'exact' path, v.transaction.)
//
// DEFECT 2: 402 challenges omit accepts[].
//   Machine-readable x402 challenges MUST advertise payable terms. Live capture showed
//   body keys = [error, reason] and accepts = undefined, so an agent could not discover
//   how to pay. Fixed by wrapping every in-scope `send(res, 402, {...})` in Object.assign
//   with a __challenge(endpoint, req) that emits both the 'exact' and 'eip3009' accepts.
//
// Both fixes are surgical text transforms on server.js, reversible via the .bak file.

const fs = require('fs');
const F = 'server.js';
let s = fs.readFileSync(F, 'utf8');
const before = s;

// ---------- backup once ----------
if (!fs.existsSync(F + '.bak-moneypath')) {
  fs.writeFileSync(F + '.bak-moneypath', s);
  console.log('backup written: server.js.bak-moneypath');
}

// ---------- FIX 1: tx propagation ----------
let f1 = 0;
const tx1 = "'X-Payment-Tx': String(st.transaction || '')";
if (s.includes(tx1)) { s = s.replace(tx1, "'X-Payment-Tx': String(st.transaction || st.tx || '')"); f1++; }
const tx2 = 'tx: st.transaction });';
if (s.includes(tx2)) { s = s.replace(tx2, 'tx: st.transaction || st.tx });'); f1++; }
const tx3 = 'v.transaction = st.transaction; v.payer = st.payer || v.payer;';
if (s.includes(tx3)) { s = s.replace(tx3, 'v.transaction = st.transaction || st.tx; v.payer = st.payer || st.from || v.payer;'); f1++; }
// queued path: surface the queued tx if a settler returned one
const tx4 = '"X-Payment-Settle-Note": String((st && st.reason) || "facilitator_unavailable").slice(0, 120) };';
if (s.includes(tx4)) {
  s = s.replace(tx4, '"X-Payment-Tx": String((st && (st.transaction || st.tx)) || ""), "X-Payment-Settle-Note": String((st && st.reason) || "facilitator_unavailable").slice(0, 120) };');
  f1++;
}
console.log('FIX 1 (tx propagation): ' + f1 + ' edit(s)');

// ---------- FIX 2a: inject __challenge helper ----------
const ANCHOR = 'function readBody(req, limit = 65536) {';
if (!s.includes('function __challenge(') && s.includes(ANCHOR)) {
  const helper = [
    '// __challenge: emit a machine-readable x402 challenge (both payable schemes) for any 402 body.',
    'function __challenge(endpoint, req) {',
    '  try {',
    '    if (!endpoint) return {};',
    "    const pbu = (typeof priceUnitsFor === 'function') ? String(priceUnitsFor(endpoint)) : '1000';",
    "    const pu = (typeof priceUsdcFor === 'function') ? priceUsdcFor(endpoint) : '0.001';",
    "    const base = (typeof requestBase === 'function') ? requestBase(req) : '';",
    '    const rq = FACILITATOR.buildPaymentRequired(endpoint, {',
    '      payTo: PAY_TO, priceBaseUnits: pbu, priceUsdc: pu, baseUrl: base,',
    "      method: (req && req.method) || 'GET', description: 'Automaton-Sovereign Value API call'",
    '    });',
    '    const out = { x402Version: rq.x402Version || 1, accepts: Array.isArray(rq.accepts) ? rq.accepts.slice() : [] };',
    "    if (!out.accepts.some(function (a) { return a && a.scheme === 'eip3009'; })) {",
    '      out.accepts.push({',
    "        scheme: 'eip3009', network: (typeof NETWORK !== 'undefined' ? NETWORK : 'base'),",
    '        maxAmountRequired: pbu, resource: base + endpoint,',
    "        description: 'Automaton-Sovereign Value API call', payTo: PAY_TO,",
    "        asset: (typeof USDC_BASE !== 'undefined' ? USDC_BASE : undefined), maxTimeoutSeconds: 60,",
    "        extra: { name: 'USD Coin', version: '2' }",
    '      });',
    '    }',
    "    out.schemes = ['eip3009', 'exact'];",
    "    out.howToPay = { exact: 'retry with header X-PAYMENT: <txHash>', eip3009: 'retry with header X-PAYMENT-AUTH: base64({payload,signature})' };",
    '    return out;',
    "  } catch (e) { return { x402Version: 1, accepts: [], _challengeError: String(e.message) }; }",
    '}',
    '',
  ].join('\n');
  s = s.replace(ANCHOR, helper + ANCHOR);
  console.log('FIX 2a: __challenge helper injected');
} else {
  console.log('FIX 2a: helper already present or anchor missing');
}

// ---------- FIX 2b: wrap in-scope send(res, 402, {...}) calls ----------
function wrap402Calls(src) {
  const MARK = 'send(res, 402, {';
  let out = src, count = 0, from = 0;
  for (;;) {
    const i = out.indexOf(MARK, from);
    if (i === -1) break;
    // find matching close brace for the object literal
    let j = i + MARK.length - 1; // index of '{'
    let depth = 0, k = j;
    for (; k < out.length; k++) {
      const c = out[k];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    if (k >= out.length) break; // unbalanced, skip
    // ensure this is inside the same logical expression (next non-space char is ')')
    let n = k + 1;
    const tail = out.slice(n, n + 4);
    if (/^\s*\)/.test(tail)) {
      const inject = "}, __challenge(typeof endpoint!=='undefined'?endpoint:null, typeof req!=='undefined'?req:null))";
      out = out.slice(0, i) + 'send(res, 402, Object.assign({' + out.slice(i + MARK.length, k) + inject + out.slice(n);
      count++;
      from = i + inject.length + 40;
    } else {
      from = k + 1;
    }
  }
  return { out, count };
}
const w = wrap402Calls(s);
s = w.out;
console.log('FIX 2b: wrapped ' + w.count + ' 402 challenge(s)');

// ---------- write ----------
if (s !== before) {
  fs.writeFileSync(F, s);
  console.log('server.js updated (' + (s.length - before.length) + ' bytes delta)');
} else {
  console.log('no changes applied');
}
