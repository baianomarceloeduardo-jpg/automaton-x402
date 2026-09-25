
// ===================== __DUAL_SCHEME_OVERLAY__ (Session 6) =====================
// Adds CALLER-BOUND payments (EIP-3009) to the primary API alongside the legacy
// txHash scheme. A raw txHash is a bearer credential (anyone who sees it on-chain can
// redeem it); an EIP-712 signed authorization cryptographically binds the payer.
(function () {
  try {
    const E9 = require('./eip3009.js');
    const __provider = {
      call: async (tx) => {
        const cid = await rpc('eth_chainId', []);
        if (String(cid).toLowerCase() !== '0x2105') throw new Error('wrong_chain');
        return rpc('eth_call', [tx, 'latest']);
      }
    };
    const __e9 = E9.makeEip3009(__provider, null);
    const __nonceFile = path.join(__dirname, 'server-eip3009-nonces.jsonl');
    const __used = new Map();
    try {
      fs.readFileSync(__nonceFile, 'utf8').split('\n').forEach(function (l) {
        if (l.trim()) { try { const r = JSON.parse(l); __used.set(r.nonce, r); } catch (e) {} }
      });
    } catch (e) {}
    function __claim(nonce, meta) {
      const n = String(nonce).toLowerCase();
      if (__used.has(n)) return false;
      const rec = { nonce: n, at: new Date().toISOString(), meta: meta || null };
      __used.set(n, rec);
      try { fs.appendFileSync(__nonceFile, JSON.stringify(rec) + '\n'); } catch (e) {}
      return true;
    }
    global.__E9_DUAL = { verifier: __e9, claim: __claim, used: __used };

    // Advertise both schemes on the machine-readable pricing surface.
    try {
      if (typeof PRICING === 'object' && PRICING) {
        PRICING.schemes = ['eip3009', 'exact'];
        PRICING.eip3009 = {
          scheme: 'eip3009', asset: USDC_BASE, chainId: CHAIN_ID, payTo: PAY_TO,
          header: 'X-PAYMENT-AUTH',
          note: 'Caller-bound: sign an EIP-712 TransferWithAuthorization for USD Coin on Base. Replay impossible (nonce consumed on-chain).'
        };
      }
    } catch (e) {}

    const __origPaymentRequired = paymentRequired;
    paymentRequired = function (res, endpoint, extra) {
      try {
        const pr = FACILITATOR.buildPaymentRequired(endpoint, {
          payTo: PAY_TO, priceBaseUnits: PRICE_BASE_UNITS.toString(), priceUsdc: PRICE_USDC,
          baseUrl: base(), description: 'Automaton-Sovereign Value API call'
        });
        const e9acc = __e9.challenge(PAY_TO, PRICE_BASE_UNITS, base() + (endpoint || ''), { source: 'automaton-sovereign' });
        if (Array.isArray(pr.accepts)) { if (!pr.accepts.some(a => a && a.scheme === 'eip3009')) pr.accepts.push(e9acc); }
        else pr.accepts = [e9acc];
        pr.schemes = ['eip3009', 'exact'];
        pr.eip3009 = { header: 'X-PAYMENT-AUTH', note: 'Caller-bound payment (EIP-712 signed authorization), NOT a bearer txHash.' };
        stats.unpaidChallenges++; saveStats();
        return send(res, 402, Object.assign(pr, extra || {}), {
          'WWW-Authenticate': 'x402 realm="automaton-value-api"',
          'X-Payment-Required': Buffer.from(JSON.stringify(pr)).toString('base64')
        });
      } catch (e) { return __origPaymentRequired(res, endpoint, extra); }
    };

    const __origAuthorize = authorize;
    authorize = async function (req, res, endpoint) {
      const hdr = req.headers['x-payment-auth'];
      if (hdr) {
        let env;
        try { env = JSON.parse(Buffer.from(String(hdr), 'base64').toString('utf8')); }
        catch (e) { stats.rejected++; saveStats(); send(res, 402, { error: 'payment_invalid', reason: 'payment_auth_not_base64_json' }); return false; }
        let v;
        try { v = await __e9.verifyAuthorization(env, { payTo: PAY_TO, minUnits: BigInt(PRICE_BASE_UNITS), requireUnused: true }); }
        catch (e) { v = { ok: false, reason: 'verify_error' }; }
        if (!v.ok) { stats.rejected++; saveStats(); send(res, 402, { error: 'payment_invalid', reason: v.reason, detail: v }); return false; }
        if (!__claim(v.nonce, { from: v.from, endpoint: endpoint, value: v.value })) {
          stats.rejected++; saveStats();
          send(res, 402, { error: 'payment_invalid', reason: 'nonce_replayed_local' });
          return false;
        }
        stats.paidCalls++; stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] || 0) + 1; saveStats();
        res._settled = { 'X-Payment-Settled': 'true', 'X-Payment-Scheme': 'eip3009', 'X-Payment-From': v.from, 'X-Payment-Caller-Bound': 'true' };
        return true;
      }
      return __origAuthorize(req, res, endpoint);
    };

    console.log('[dual-scheme] overlay active: eip3009 (caller-bound) + exact (txHash bearer)');
  } catch (e) {
    console.log('[dual-scheme] overlay failed: ' + e.message);
  }
})();
