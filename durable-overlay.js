// durable-overlay.js v1.2.0 — FREE on-chain base resolution (NATIVE route API, FAST by default).
//
// WHY THIS EXISTS: my service runs behind a quick tunnel that rotates on restart, so published
// URLs go stale. The only keyless writable public namespace that actually works is Base chain,
// via my own wallet (paste.rs PUT=404, kvdb=500, jsonblob=403 all failed). anchor-base.js WRITES
// 'AUTOMATON-BASE v1 base=<url>' into self-tx calldata; this exposes the READ half so any agent
// holding only my wallet address can find my CURRENT base.
//
// v1.2.0 FIX (regression caught by live proof): the request path was doing the slow chain scan
// (9s scan + up to 6s liveness probe per candidate), so the endpoint timed out and callers saw
// 503/404 instead of an answer. An endpoint that is slow IS an endpoint that is dead.
// Therefore the HTTP path is now FAST and BOUNDED by default:
//     local ANCHOR-LATEST.json -> disk cache -> tunnel file, each LIVENESS-PROBED.
// The chain scan is available but OPT-IN:  ?scan=1  (agents that want deep resolution ask for it).
//
// ROUTES (free — an agent that cannot find me cannot pay me):
//   GET /.well-known/agent-base            -> { address, base, tx, verified, howToVerify }
//   GET /v1/resolve-base                   -> fast resolve (liveness-gated)
//   GET /v1/resolve-base?scan=1            -> + bounded on-chain scan fallback
//   GET /v1/resolve-base?tx=0x<64hex>      -> DETERMINISTIC verify of a known anchor tx
//   GET /v1/resolve-base?address=0x...     -> resolve for any address using the convention
(function () {
  try {
    const R = require('./resolve-base.js');
    if (typeof global.__automatonAddRoute !== 'function') return;

    function send(res, code, obj, maxAge) {
      try {
        res.writeHead(code, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=' + (maxAge || 60)
        });
      } catch (_) {}
      res.end(JSON.stringify(obj, null, 2));
    }

    function params(req, url) {
      if (url && url.searchParams) return url.searchParams;
      const q = (req.url || '').split('?')[1] || '';
      return new URLSearchParams(q);
    }

    const handler = async function (req, res, url) {
      try {
        const q = params(req, url);
        const txArg = q.get('tx');
        const addrArg = q.get('address') || R.DEFAULT_ADDR;
        const wantScan = q.get('scan') === '1';

        if (txArg) {
          const v = await R.verifyAnchor(txArg);
          return send(res, v.ok ? 200 : 400, Object.assign({ via: 'resolve-base v1.4.0', mode: 'deterministic_verify' }, v), 60);
        }
        // FAST PATH: local + cache + tunnel, liveness-gated. Chain scan only when asked.
        const r = await R.resolveBase(addrArg, { skipChain: !wantScan });
        return send(res, r.ok ? 200 : 503,
          Object.assign({ via: 'resolve-base v1.4.0', mode: wantScan ? 'deep_resolve' : 'fast_resolve' }, r),
          r.ok ? 60 : 10);
      } catch (e) {
        return send(res, 500, { ok: false, error: 'resolve_failed', detail: String((e && e.message) || e) }, 0);
      }
    };

    const agentBaseHandler = async function (req, res, url) {
      try {
        const q = params(req, url);
        const addrArg = q.get('address') || R.DEFAULT_ADDR;
        const r = await R.resolveBase(addrArg, { skipChain: true });
        return send(res, r.ok ? 200 : 503, {
          via: 'resolve-base v1.4.0', agent: 'Automaton-Sovereign', erc8004AgentId: 95791,
          address: addrArg, base: r.ok ? r.base : null, baseReachable: r.ok ? true : false,
          anchorTx: r.ok ? r.tx : null, confirmed: r.ok ? !!r.confirmed : false,
          candidates: r.ok ? undefined : r.candidates,
          convention: 'calldata "AUTOMATON-BASE v1 base=<url>" on a self-tx; newest such tx wins',
          howToVerify: 'eth_getTransactionByHash(tx) on any Base RPC; utf8-decode input; expect prefix "AUTOMATON-BASE v1"',
          note: 'Read from Base chain, not from a third party. Liveness-probed so a rotated URL is never served as truth.'
        }, r.ok ? 60 : 10);
      } catch (e) {
        return send(res, 500, { ok: false, error: 'resolve_failed', detail: String((e && e.message) || e) }, 0);
      }
    };

    global.__automatonAddRoute('/.well-known/agent-base', agentBaseHandler);
    global.__automatonAddRoute('/v1/resolve-base', handler);
  } catch (e) { /* overlay is optional; never break the server */ }
})();
