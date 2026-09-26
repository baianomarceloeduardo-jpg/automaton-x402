// history-overlay.js v1.0.0 - factory: installs free history endpoints onto an http server.
// Usage (from server.js module scope):  require('./history-overlay.js')(server);
// Free endpoints:
//   GET /v1/x402/history                 JSON: series + deltas
//   GET /v1/x402/history/record          append snapshot from current index state
//   GET /v1/x402/history/record?live=1   fresh index scan, then snapshot
//   GET /x402-history                    HTML digest
//   GET /x402-history.md                 Markdown digest (citable)
'use strict';
const H = require('./x402-history.js');

module.exports = function installHistoryOverlay(server) {
  if (!server || typeof server.listeners !== 'function') {
    console.error('[history-overlay] invalid server handle; not installed');
    return;
  }
  if (server.__historyOverlayInstalled) return; // idempotent
  server.__historyOverlayInstalled = true;

  function indexEntries() {
    try {
      const idx = require('./x402-index.js');
      if (typeof idx.load === 'function') {
        const r = idx.load();
        if (r) {
          if (Array.isArray(r)) return r;
          for (const key of ['services', 'rows', 'entries', 'results', 'leaderboard']) {
            if (Array.isArray(r[key])) return r[key];
          }
        }
      }
      if (typeof idx.leaderboard === 'function') {
        const l = idx.leaderboard();
        if (Array.isArray(l)) return l;
      }
    } catch (e) { /* index unavailable; history still serves what it has */ }
    return [];
  }

  function runLive(cb) {
    try {
      const idx = require('./x402-index.js');
      if (typeof idx.run !== 'function') return cb(null, indexEntries());
      const pick = r => {
        const arr = r && (Array.isArray(r) ? r : (r.services || r.rows || r.entries || r.leaderboard));
        return Array.isArray(arr) ? arr : indexEntries();
      };
      let settled = false;
      const done = (err, entries) => { if (!settled) { settled = true; cb(err, entries); } };
      const out = idx.run({}, function (err, res) { if (err) return done(err); done(null, pick(res)); });
      if (out && typeof out.then === 'function') out.then(r => done(null, pick(r))).catch(e => done(e));
      else if (Array.isArray(out)) done(null, pick(out));
      setTimeout(() => done(null, indexEntries()), 25000);
    } catch (e) { cb(e); }
  }

  function json(res, code, obj) {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=120',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(obj, null, 2));
  }

  const prev = server.listeners('request').slice();
  server.removeAllListeners('request');
  server.on('request', function (req, res) {
    let p = '/', q = '';
    try { const s = (req.url || '/').split('?'); p = decodeURIComponent(s[0]); q = s[1] || ''; } catch (e) { p = (req.url || '/').split('?')[0]; }

    if (p === '/v1/x402/history') {
      const snaps = H.series(60);
      const d = H.deltas(snaps);
      const lt = H.latest();
      return json(res, 200, {
        ok: true,
        artifact: 'x402 ecosystem history',
        snapshots: snaps.length,
        latest: lt ? { ts: lt.ts, day: lt.day, total: lt.total, conformant: lt.conformant, healthPct: lt.healthPct, tally: lt.tally } : null,
        change: d,
        series: snaps.map(s => ({ day: s.day, total: s.total, conformant: s.conformant, healthPct: s.healthPct })),
        note: 'Append-only observation log. Same-day rescans do not fabricate deltas.'
      });
    }

    if (p === '/x402-history.md') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(H.report());
    }

    if (p === '/x402-history') {
      const snaps = H.series(60);
      const d = H.deltas(snaps);
      const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      let html = '<!doctype html><meta charset=utf-8><title>x402 Ecosystem History</title>';
      html += '<style>body{font:15px/1.6 system-ui,sans-serif;max-width:860px;margin:48px auto;padding:0 20px;color:#111}'
        + 'table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}'
        + 'th{background:#f6f6f6}.up{color:#0a7d28}.down{color:#b3261e}code{background:#f2f2f2;padding:1px 4px}</style>';
      html += '<h1>x402 Ecosystem History</h1>';
      html += '<p>An append-only observation log of the live x402 ecosystem. Directories show what exists <em>now</em>; this shows what <strong>changed</strong>.</p>';
      if (!snaps.length) {
        html += '<p><em>No snapshots recorded yet.</em> Record one at <code>/v1/x402/history/record?live=1</code>.</p>';
      } else {
        html += '<p>Span: <strong>' + esc(snaps[0].day) + ' &rarr; ' + esc(snaps[snaps.length - 1].day) + '</strong> — ' + snaps.length + ' snapshot(s).</p>';
        html += '<table><tr><th>day</th><th>services</th><th>conformant</th><th>health</th></tr>';
        for (const s of snaps.slice(-30)) html += '<tr><td>' + esc(s.day) + '</td><td>' + s.total + '</td><td>' + s.conformant + '</td><td>' + s.healthPct + '%</td></tr>';
        html += '</table>';
        if (d) {
          html += '<h2>Change: ' + esc(d.fromDay) + ' &rarr; ' + esc(d.toDay) + '</h2><ul>';
          html += '<li>services: ' + d.fromTotal + ' &rarr; ' + d.toTotal + '</li>';
          const cls = d.toHealthPct >= d.fromHealthPct ? 'up' : 'down';
          html += '<li>health: ' + d.fromHealthPct + '% &rarr; <span class="' + cls + '">' + d.toHealthPct + '%</span></li>';
          html += '<li>added: ' + d.added.length + '</li><li>removed: ' + d.removed.length + '</li>';
          html += '<li>verdict drift: ' + d.changed.length + '</li></ul>';
          if (d.added.length) html += '<p><strong>New:</strong> ' + d.added.map(esc).join(', ') + '</p>';
          if (d.removed.length) html += '<p><strong>Gone:</strong> ' + d.removed.map(esc).join(', ') + '</p>';
        }
      }
      html += '<p style="margin-top:32px;font-size:13px;color:#555">Machine-readable: <code>/v1/x402/history</code> · Markdown: <code>/x402-history.md</code></p>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' });
      return res.end(html);
    }

    if (p === '/v1/x402/history/record') {
      // Write endpoint: only the local publisher (publish-history.ps1 -> 127.0.0.1, no proxy headers)
      // or a caller presenting HISTORY_RECORD_TOKEN may append. Public callers could otherwise flood
      // the append-only log and trigger unbounded live ecosystem scans.
      const peer = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
      const proxied = !!(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-host']);
      const token = process.env.HISTORY_RECORD_TOKEN;
      const local = (peer === '127.0.0.1' || peer === '::1') && !proxied;
      const authed = !!token && String(req.headers['x-admin-token'] || '') === token;
      if (!local && !authed) return json(res, 403, { ok: false, reason: 'record_is_operator_only', read: '/v1/x402/history' });
      const live = /(^|&|&amp;)live=1(&|$)/.test(q);
      if (live && installHistoryOverlay.__liveRunning) return json(res, 429, { ok: false, reason: 'live_scan_in_progress' });
      if (!live) {
        const s = H.append(H.snapshot(indexEntries()));
        return json(res, 200, { ok: true, recorded: true, mode: 'cached', day: s.day, total: s.total, conformant: s.conformant, healthPct: s.healthPct });
      }
      installHistoryOverlay.__liveRunning = true;
      return runLive(function (err, entries) {
        installHistoryOverlay.__liveRunning = false;
        if (err) return json(res, 502, { ok: false, reason: 'index_run_failed', detail: String((err && err.message) || err) });
        const s = H.append(H.snapshot(entries || []));
        return json(res, 200, { ok: true, recorded: true, mode: 'live', day: s.day, total: s.total, conformant: s.conformant, healthPct: s.healthPct });
      });
    }

    return prev.forEach(function (l) { l.call(server, req, res); });
  });

  console.log('[history-overlay] active: /v1/x402/history /v1/x402/history/record /x402-history /x402-history.md');
};
