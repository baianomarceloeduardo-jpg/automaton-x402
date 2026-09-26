// facilitator-overlay.js — self-attaches the facilitator monitor routes to server.js
// via the module-scope route registry (global.__automatonAddRoute).
const monitor = require('./facilitator-monitor.js');

const CACHE_MS = 60 * 1000; // 60s cache: facilitators change, but not per-request
let cache = { at: 0, report: null, running: null };

async function getReport() {
  const now = Date.now();
  if (cache.report && (now - cache.at) < CACHE_MS) return cache.report;
  if (cache.running) return cache.running; // collapse concurrent misses
  cache.running = monitor.probeAll({})
    .then(all => { cache = { at: Date.now(), report: monitor.toReport(all), running: null }; return cache.report; })
    .catch(e => { cache.running = null; throw e; });
  return cache.running;
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length,
    'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' });
  res.end(body);
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

if (typeof global.__automatonAddRoute === 'function') {
  global.__automatonAddRoute('/v1/facilitators', async (req, res) => {
    try { sendJson(res, 200, await getReport()); } catch (e) { sendJson(res, 500, { error: 'monitor_failed', message: e.message }); }
  });

  global.__automatonAddRoute('/facilitators', async (req, res) => {
    let rep;
    try { rep = await getReport(); } catch (e) { rep = { error: e.message }; }
    const rows = (rep.facilitators || []).map(f => {
      const color = f.verdict === 'MAINNET_OK' ? '#22c55e' : f.verdict === 'TESTNET_ONLY' ? '#f59e0b' : '#ef4444';
      return '<tr><td><b>' + esc(f.name) + '</b></td><td><code>' + esc(f.url) + '</code></td>' +
        '<td style="color:' + color + ';font-weight:700">' + esc(f.verdict) + '</td>' +
        '<td>' + esc(f.httpStatus) + '</td><td>' + esc(f.latencyMs) + 'ms</td>' +
        '<td>' + esc(f.networks.join(', ') || '—') + '</td></tr>';
    }).join('');
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>x402 Facilitator Monitor</title>' +
      '<style>body{font:15px/1.5 system-ui,sans-serif;max-width:980px;margin:40px auto;padding:0 16px;background:#0b0f14;color:#e6edf3}' +
      'table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #24303f;padding:8px 10px;text-align:left;font-size:13px}' +
      'th{background:#141b24}code{background:#141b24;padding:2px 5px;border-radius:4px;font-size:12px}a{color:#58a6ff}</style></head><body>' +
      '<h1>x402 Facilitator Monitor</h1>' +
      '<p>Which x402 facilitator actually works for <b>Base mainnet</b>, right now. ' +
      '<code>x402.org/facilitator</code> is testnet-only for mainnet callers — picking it silently breaks settlement.</p>' +
      '<p>Checked ' + esc(rep.checkedAt || '—') + ' · machine-readable: <a href="/v1/facilitators">/v1/facilitators</a></p>' +
      '<table><tr><th>Name</th><th>URL</th><th>Verdict</th><th>HTTP</th><th>Latency</th><th>Networks</th></tr>' + rows + '</table>' +
      '<p style="color:#8b949e">Automaton-Sovereign · gas-free USDC checkout: <a href="/gasfree">/gasfree</a></p></body></html>';
    const buf = Buffer.from(html);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length, 'cache-control': 'public, max-age=60' });
    res.end(buf);
  });

  console.log('[facilitator-overlay] routes attached: /v1/facilitators /facilitators');
} else {
  console.error('[facilitator-overlay] route registry missing — server.js not patched');
}
