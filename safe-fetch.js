// safe-fetch.js — zero-dependency SSRF-hardened HTTP client.
//
// WHY THIS EXISTS: /v1/index/submit?url= accepts arbitrary URLs from the public and my benchmark
// engine later fetches them server-side. That is a textbook SSRF surface. Hoping a URL "looks"
// private is not a control. This module makes the fetch itself safe:
//
//   P0 DNS REBINDING: we resolve the hostname ONCE, validate EVERY returned address, then PIN the
//      validated IP into the socket via http.request's `lookup` option. The name is never resolved
//      a second time, so an attacker cannot pass the check with a public IP and then have DNS
//      flip to 127.0.0.1 / 169.254.169.254 before the connect.
//   P0 REDIRECTS: never followed. A 3xx is returned to the caller as a refusal, because a redirect
//      is the standard way to bounce a validated public URL to an internal host.
//   P1 ENCODED IPs: decimal (2130706433), octal (017700000001), hex (0x7f000001), and dotted forms
//      are normalized to real IPv4 before range checks.
//   P1 IPv6: ::1, ::ffff:127.0.0.1 (v4-mapped), fe80::/10, fc00::/7, ::, and multicast are all blocked.
//   P2 SIZE/TIME: hard body cap and hard timeout; sockets are destroyed, never left dangling.

'use strict';
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const DEFAULTS = { timeoutMs: 20000, maxBytes: 256 * 1024, maxRedirects: 0 };

// ---------- IP classification ----------

function ipv4ToInt(ip) {
  const p = ip.split('.').map(x => parseInt(x, 10));
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function blockedV4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable => refuse
  const inR = (cidr, bits) => {
    const m = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & m) === (ipv4ToInt(cidr) & m);
  };
  return (
    inR('0.0.0.0', 8) ||        // "this network"
    inR('10.0.0.0', 8) ||       // private
    inR('100.64.0.0', 10) ||    // CGNAT
    inR('127.0.0.0', 8) ||      // loopback
    inR('169.254.0.0', 16) ||   // link-local INCLUDING 169.254.169.254 metadata
    inR('172.16.0.0', 12) ||    // private
    inR('192.0.0.0', 24) ||     // IETF protocol assignments
    inR('192.168.0.0', 16) ||   // private
    inR('198.18.0.0', 15) ||    // benchmarking
    inR('224.0.0.0', 4) ||      // multicast
    inR('240.0.0.0', 4)         // reserved / broadcast
  );
}

function ipv6ToBytes(ip) {
  let s = ip.split('%')[0];
  // v4-mapped / v4-compatible tail
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  let v4 = null;
  if (tail) { v4 = ipv4ToInt(tail[1]); s = s.slice(0, tail.index) + ':' + s.slice(tail.index); }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const rest = parts.length === 2 ? (parts[1] ? parts[1].split(':').filter(Boolean) : []) : null;
  let groups = rest === null ? head : head.concat(new Array(8 - head.length - rest.length).fill('0')).concat(rest);
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    const v = parseInt(g, 16);
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  if (v4 !== null) { bytes[12] = (v4 >>> 24) & 0xff; bytes[13] = (v4 >>> 16) & 0xff; bytes[14] = (v4 >>> 8) & 0xff; bytes[15] = v4 & 0xff; }
  return bytes;
}

function blockedV6(ip) {
  const b = ipv6ToBytes(ip);
  if (!b) return true;
  const isZero = b.every(x => x === 0);
  if (isZero) return true;                                   // ::
  if (b.slice(0, 15).every(x => x === 0) && b[15] === 1) return true; // ::1 loopback
  const v4mapped = b.slice(0, 10).every(x => x === 0) && b[10] === 0xff && b[11] === 0xff;
  if (v4mapped) return blockedV4(b.slice(12).join('.'));     // ::ffff:127.0.0.1
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;  // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true;                   // fc00::/7 ULA
  if (b[0] === 0xff) return true;                            // ff00::/8 multicast
  return false;
}

function isBlockedIp(ip) {
  const t = net.isIP(ip);
  if (t === 4) return blockedV4(ip);
  if (t === 6) return blockedV6(ip);
  return true; // not an IP => refuse
}

// ---------- hostname normalization (defeats decimal/octal/hex/encoded tricks) ----------

function normalizeHost(hostname) {
  let h = String(hostname || '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);   // [::1]
  if (!h) return null;
  if (net.isIP(h)) return h;
  // single-label numeric forms: decimal 2130706433 / hex 0x7f000001 / octal 017700000001
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) {
    let n;
    if (/^0x/.test(h)) n = parseInt(h, 16);
    else if (/^0\d+$/.test(h)) n = parseInt(h, 8);
    else n = parseInt(h, 10);
    if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    }
  }
  return h;
}

// ---------- validation ----------

function assertSafeUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (e) { throw new Error('invalid_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme_not_allowed');
  const host = normalizeHost(u.hostname);
  if (!host) throw new Error('no_host');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('blocked_address');
    return { url: u, host };
  }
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error('bad_host_chars');
  return { url: u, host, needsDns: true };
}

function resolveAll(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return reject(new Error('dns_failed:' + err.code));
      resolve(Array.isArray(addrs) ? addrs : []);
    });
  });
}

// ---------- fetch ----------

async function safeFetch(rawUrl, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts);
  const info = assertSafeUrl(rawUrl);
  const u = info.url;

  let records;
  if (info.needsDns) {
    records = await resolveAll(info.host);
    if (!records.length) throw new Error('dns_no_records');
    for (const r of records) {
      if (isBlockedIp(r.address)) throw new Error('blocked_address:' + r.address);
    }
  } else {
    records = [{ address: info.host, family: net.isIP(info.host) }];
  }

  const pinned = records[0].address;
  const family = records[0].family || net.isIP(pinned);
  const lib = u.protocol === 'https:' ? https : http;

  return await new Promise((resolve, reject) => {
    const reqOpts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: cfg.method || 'GET',
      headers: Object.assign({ 'user-agent': 'automaton-safe-fetch/1.0', accept: '*/*' }, cfg.headers || {}),
      timeout: cfg.timeoutMs,
      // THE CONTROL: pin the validated IP. No second resolution => no rebinding window.
      lookup: (hn, o, cb) => cb(null, pinned, family),
      servername: u.hostname, // keep SNI/Host correct for TLS
    };
    // preserve original Host header semantics
    reqOpts.headers.host = u.host;

    const req = lib.request(reqOpts, (res) => {
      const code = res.statusCode | 0;
      if (code >= 300 && code < 400) {
        res.destroy();
        return resolve({ ok: false, reason: 'redirect_refused', status: code, location: res.headers.location || null, url: rawUrl, pinned });
      }
      let size = 0; const chunks = [];
      let done = false;
      const finish = (truncated) => {
        if (done) return; done = true;
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: code >= 200 && code < 300, status: code, headers: res.headers, body, truncated, bytes: size, url: rawUrl, pinned });
      };
      res.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > cfg.maxBytes) { res.destroy(); return finish(true); }
        chunks.push(c);
      });
      res.on('end', () => finish(false));
      res.on('error', () => finish(true));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', (e) => reject(new Error('request_failed:' + e.code)));
    if (cfg.body) req.write(cfg.body);
    req.end();
  });
}

module.exports = { safeFetch, assertSafeUrl, isBlockedIp, normalizeHost, blockedV4, blockedV6 };
