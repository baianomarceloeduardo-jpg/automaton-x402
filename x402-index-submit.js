// x402-index-submit.js v1.0.0 - free self-submission + queue for the x402 Service Index.
// Any service can add itself to the public benchmark. Zero auth, zero payment.
// Guards: http/https only, public hostname only (no private/loopback/link-local), dedup, cap.
'use strict';
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const QUEUE = path.join(__dirname, 'x402-index-submissions.json');
const MAX_QUEUE = 500;

function loadQueue() { try { return JSON.parse(fs.readFileSync(QUEUE, 'utf8')); } catch (e) { return { updated: null, subs: [] }; } }
function saveQueue(q) { try { fs.writeFileSync(QUEUE, JSON.stringify(q, null, 2)); } catch (e) {} }

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.indexOf(':') >= 0) { // IPv6
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v === '::';
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return true;
  return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254) ||
    p[0] >= 224;
}

function validate(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return { ok: false, reason: 'malformed_url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'unsupported_scheme' };
  if (!u.hostname || u.hostname.indexOf('.') < 0) return { ok: false, reason: 'hostname_required' };
  const norm = u.origin + (u.pathname === '/' ? '/' : u.pathname.replace(/\/$/, ''));
  return { ok: true, url: norm, hostname: u.hostname };
}

// returns Promise<{ok, url, status}> -- resolves the hostname and refuses private targets.
function submit(raw) {
  return new Promise(resolve => {
    const v = validate(raw);
    if (!v.ok) return resolve({ ok: false, reason: v.reason });
    dns.lookup(v.hostname, { all: true }, (err, addrs) => {
      if (err) return resolve({ ok: false, reason: 'dns_failed: ' + err.code });
      const list = [].concat(addrs || []);
      if (!list.length) return resolve({ ok: false, reason: 'dns_no_address' });
      if (list.some(a => isPrivateIp(a.address))) return resolve({ ok: false, reason: 'private_target_refused' });
      const q = loadQueue();
      if ((q.subs || []).some(s => s.url === v.url)) return resolve({ ok: true, url: v.url, status: 'already_queued' });
      if ((q.subs || []).length >= MAX_QUEUE) return resolve({ ok: false, reason: 'queue_full' });
      q.subs = (q.subs || []).concat([{ url: v.url, at: new Date().toISOString(), ip: list[0].address }]);
      q.updated = new Date().toISOString();
      saveQueue(q);
      resolve({ ok: true, url: v.url, status: 'queued' });
    });
  });
}

function queuedUrls() { return (loadQueue().subs || []).map(s => s.url); }

module.exports = { submit, validate, queuedUrls, loadQueue, isPrivateIp, MAX_QUEUE };
