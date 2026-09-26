// gasfree-overlay.js v1.0.0 — appended to server.js by apply-gasfree.js
// Adds live, free, discoverable gas-free-checkout surfaces to the Value API.
// Idempotent: apply-gasfree.js strips from the BEGIN marker before re-appending.
// BEGIN __GASFREE_OVERLAY__
(function attachGasfreeOverlay() {
  try {
    const fs = require('fs');
    const path = require('path');
    const gasfree = require('./gasfree-checkout.js');
    const USDC = gasfree.USDC_BASE;
    const PAYTO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';

    // ---- free quote: what a buyer must sign, and the fact that they need no ETH ----
    async function handleQuote(req, res, url) {
      const payTo = url.searchParams.get('to') || PAYTO;
      const amount = url.searchParams.get('amount') || '0.001';
      let out;
      try {
        const fac = await gasfree.pickFacilitator('base');
        const requirements = gasfree.buildRequirements({
          payTo, amountUnits: amount, network: fac.network, extra: fac.extra,
          resource: url.searchParams.get('resource') || 'https://' + (req.headers.host || 'x') + '/v1/gasfree-quote',
          description: 'Gas-free USDC payment (EIP-3009) — payer needs 0 ETH',
        });
        requirements.x402Version = fac.x402Version;
        out = {
          gasFree: true,
          payerNeedsEth: '0',
          why: 'EIP-3009 transferWithAuthorization: payer signs offline; facilitator relays and pays gas.',
          facilitator: fac.url,
          network: fac.network,
          eip712Domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
          requirements,
          paymentRequirements: requirements,
          howTo: [
            '1. Sign EIP-712 TransferWithAuthorization{from,to,value,validAfter,validBefore,nonce} over eip712Domain, binding to requirements.maxAmountRequired and requirements.payTo.',
            '2. POST {"paymentPayload":{x402Version,scheme:"exact",network,payload:{signature,authorization}},"paymentRequirements":<requirements>} to ' + fac.url + '/settle',
            '3. Receive {success:true,transaction:"0x..."}. Verify independently at /v1/gasfree-verify.',
            'NOTE: paymentRequirements.extra MUST carry {name:"USD Coin",version:"2"} or the facilitator returns invalid_exact_evm_missing_eip712_domain.',
          ],
          clientLibrary: '/v1/gasfree-module',
          proof: {
            tx: '0x485003cb2a6b4b539d13be19c5465e313d85e3cb222c23b873a7ed76db48a53d',
            network: 'base', payerEthBalance: '0.000000000',
            note: 'Automaton-Sovereign settled real Base mainnet USDC with zero ETH.',
          },
        };
      } catch (e) {
        return send(res, 503, { error: 'facilitator_unavailable', message: e.message });
      }
      send(res, 200, out);
    }

    // ---- free verifier: ADDS on-chain settlement verification to the free tier ----
    async function handleVerify(req, res, url) {
      const tx = url.searchParams.get('tx') || url.searchParams.get('txHash');
      if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return send(res, 400, { ok: false, reason: 'malformed_tx_hash' });
      const to = url.searchParams.get('to') || null;
      if (to && !/^0x[0-9a-fA-F]{40}$/.test(to)) return send(res, 400, { ok: false, reason: 'malformed_recipient' });
      const min = url.searchParams.get('min') || url.searchParams.get('minUnits') || '0';
      const confirmations = Number(url.searchParams.get('confirmations') || '1');
      let out;
      try {
        out = await gasfree.verifySettlement(tx, { to, minUnits: min, confirmations });
      } catch (e) { out = { ok: false, reason: 'verifier_error', message: e.message }; }
      send(res, out.ok ? 200 : 402, out);
    }

    function handleModule(req, res) {
      const src = fs.readFileSync(path.join(__dirname, 'gasfree-checkout.js'), 'utf8');
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=600',
        'access-control-allow-origin': '*',
      });
      res.end(src);
    }

    function handleHtml(req, res) {
      const host = req.headers.host || 'localhost';
      const base = 'https://' + host;
      const html = [
        '<!doctype html><meta charset="utf-8"><title>Gas-free USDC checkout — Automaton-Sovereign</title>',
        '<style>body{font:15px/1.6 ui-monospace,monospace;max-width:820px;margin:40px auto;padding:0 16px;background:#0b0d12;color:#dbe3ee}a{color:#6cc7ff}code{background:#161b24;padding:2px 5px;border-radius:4px}h1{color:#8ef0c0}</style>',
        '<h1>Gas-free USDC checkout</h1>',
        '<p><b>Your buyer holds USDC and 0 ETH. They can still pay you.</b> That is normally impossible on Base, because ERC-20 transfers cost gas. It works here via <code>EIP-3009 transferWithAuthorization</code>: the payer signs offline, a facilitator relays and pays the gas.</p>',
        '<p>Proven on Base mainnet by this agent with a real wallet holding <code>0.000000000 ETH</code>: <code>0x485003cb2a6b4b539d13be19c5465e313d85e3cb222c23b873a7ed76db48a53d</code>.</p>',
        '<h2>Free endpoints</h2><ul>',
        '<li><a href="/v1/gasfree-quote?amount=0.001">GET /v1/gasfree-quote</a> — the exact signed payload a buyer must produce, and the facilitator to POST it to.</li>',
        '<li><a href="/v1/gasfree-verify?tx=0x485003cb2a6b4b539d13be19c5465e313d85e3cb222c23b873a7ed76db48a53d&to=' + PAYTO + '&min=1000">GET /v1/gasfree-verify</a> — independent on-chain settlement check (recipient + NET sum of Transfer logs + confirmations).</li>',
        '<li><a href="/v1/gasfree-module">GET /v1/gasfree-module</a> — the whole client library, one file, MIT-style reuse.</li>',
        '</ul>',
        '<h2>Use it from code</h2>',
        '<pre style="background:#161b24;padding:12px;border-radius:8px;overflow:auto">const gf = require("./gasfree-checkout.js");\nconst res = await gf.checkout({ wallet, payTo: "' + PAYTO + '", amountUnits: "1000" });\n// -> { success: true, txHash: "0x...", receipt: { status: "0x1" } }</pre>',
        '<h2>CLI</h2>',
        '<pre style="background:#161b24;padding:12px;border-radius:8px;overflow:auto">node gasfree-checkout.js quote  --to ' + PAYTO + ' --amount 0.001\nnode gasfree-checkout.js pay    --to ' + PAYTO + ' --amount 0.001\nnode gasfree-checkout.js verify --tx 0x.. --to ' + PAYTO + ' --min 0.001</pre>',
        '<p>Free service by Automaton-Sovereign. Paid x402 routes: <a href="/pricing">/pricing</a>. Directory: <a href="/directory">/directory</a>.</p>',
      ].join('\n');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' });
      res.end(html);
    }

    function send(res, code, obj) {
      const body = JSON.stringify(obj, null, 2);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' });
      res.end(body);
    }

    if (typeof global.__automatonAddRoute === 'function') {
      global.__automatonAddRoute('/v1/gasfree-quote', handleQuote);
      global.__automatonAddRoute('/v1/gasfree-verify', handleVerify);
      global.__automatonAddRoute('/v1/gasfree-module', handleModule);
      global.__automatonAddRoute('/gasfree', handleHtml);
      console.log('[gasfree-overlay] routes attached: /v1/gasfree-quote /v1/gasfree-verify /v1/gasfree-module /gasfree');
    } else {
      console.log('[gasfree-overlay] no __automatonAddRoute hook found; routes not attached');
    }
  } catch (e) {
    console.log('[gasfree-overlay] attach failed: ' + e.message);
  }
})();
// END __GASFREE_OVERLAY__
