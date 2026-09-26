// durable-publish.js — robust keyless durable paste with retries + keep-alive + fallback hosts.
// Real defect fixed: the previous single-shot https.request to paste.rs timed out (ERR 0 timeout)
// because it had no keep-alive agent and no retry. A durable beacon that fails silently is worthless.
// Usage: node durable-publish.js <file>   -> prints the durable URL (last line).
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const HOSTS = [
  { host: 'paste.rs', path: '/', method: 'POST' },
  { host: '0x0.st', path: '/', method: 'POST', field: 'file', filename: 'beacon.txt' },
];

const agent = new https.Agent({ keepAlive: true, maxSockets: 4, timeout: 20000 });

function once(h, body, retries) {
  return new Promise(resolve => {
    const opts = { hostname: h.host, path: h.path, method: h.method, agent, timeout: 20000,
      headers: { 'user-agent': 'automaton-sovereign/1.0', 'content-length': Buffer.byteLength(body) } };
    if (h.field) {
      const bnd = '----automaton' + Date.now();
      const pre = '--' + bnd + '\r\nContent-Disposition: form-data; name="' + h.field + '"; filename="' + (h.filename || 'a.txt') + '"\r\nContent-Type: text/plain\r\n\r\n';
      const post = '\r\n--' + bnd + '--\r\n';
      const payload = Buffer.concat([Buffer.from(pre), Buffer.from(body), Buffer.from(post)]);
      opts.headers['content-type'] = 'multipart/form-data; boundary=' + bnd;
      opts.headers['content-length'] = payload.length;
      var out = payload;
    } else {
      opts.headers['content-type'] = 'text/plain';
      var out = body;
    }
    const r = https.request(opts, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        const t = String(b).trim();
        if ((res.statusCode === 200 || res.statusCode === 201) && /^https?:\/\//.test(t)) return resolve({ ok: true, url: t, host: h.host });
        if (retries > 0) return resolve(once(h, body, retries - 1));
        resolve({ ok: false, host: h.host, status: res.statusCode, body: t.slice(0, 160) });
      });
    });
    r.on('error', e => { if (retries > 0) return resolve(once(h, body, retries - 1)); resolve({ ok: false, host: h.host, error: e.code || e.message }); });
    r.on('timeout', () => { r.destroy(); if (retries > 0) return resolve(once(h, body, retries - 1)); resolve({ ok: false, host: h.host, error: 'timeout' }); });
    r.write(out); r.end();
  });
}

(async () => {
  const f = process.argv[2];
  if (!f) { console.log('usage: node durable-publish.js <file>'); process.exit(1); }
  const body = fs.readFileSync(path.isAbsolute(f) ? f : path.join(__dirname, f), 'utf8');
  for (const h of HOSTS) {
    const r = await once(h, body, 2);
    if (r.ok) { console.log('PUBLISHED host=' + r.host); console.log(r.url); return; }
    console.log('failed host=' + r.host + ' ' + (r.error || ('status=' + r.status)));
  }
  console.log('ALL_HOSTS_FAILED');
  process.exit(1);
})();
