'use strict';
/**
 * x402-probe.js - FREE x402 compliance prober.
 * Given any URL, fetch it, and if it answers HTTP 402, validate the challenge:
 * is it well-formed x402? correct chain/asset/payTo? does it advertise accepts[]?
 * Genuinely useful to agent directories, buyers, and sellers. No wallet required.
 */
const https = require('https');
const http = require('http');

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|::1$|172\.(1[6-9]|2\d|3[01])\.)/i;

function fetchOnce(url, timeoutMs) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ error: 'malformed_url' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve({ error: 'unsupported_scheme' });
    if (PRIVATE.test(u.hostname)) return resolve({ error: 'target_not_allowed' });
    const lib = u.protocol === 'http:' ? http : https;
    const started = Date.now();
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'Automaton-Sovereign/x402-probe' }
    }, (res) => {
      let d = ''; let n = 0;
      res.on('data', c => { n += c.length; if (n <= 65536) d += c; else { req.destroy(); } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d, ms: Date.now() - started }));
    });
    req.on('error', e => resolve({ error: 'fetch_failed: ' + e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

function analyzeChallenge(status, headers, bodyText, url) {
  const out = {
    url, status, httpStatus: status, compliant: false, score: 0, maxScore: 6,
    checks: {}, accepts: [], reason: null, wwwAuthenticate: (headers && (headers['www-authenticate'] || headers['WWW-Authenticate'])) || null
  };
  if (status !== 402) { out.reason = 'no_402_challenge'; return out; }
  let body = null;
  try { body = JSON.parse(bodyText); } catch (e) { out.reason = 'body_not_json'; return out; }

  let accepts = body && body.accepts;
  if (!Array.isArray(accepts)) accepts = body && body.accept ? [body.accept] : null;
  if (!Array.isArray(accepts) && body && (body.payTo || body.maxAmountRequired)) accepts = [body];
  if (!Array.isArray(accepts) || !accepts.length) { out.reason = 'no_accepts_advertised'; return out; }

  const a = accepts[0];
  out.accepts = accepts.map(x => ({
    scheme: x.scheme, network: x.network, chainId: x.chainId, asset: x.asset,
    payTo: x.payTo, maxAmountRequired: x.maxAmountRequired, resource: x.resource
  }));

  out.checks.has_scheme = a.scheme === 'exact';
  out.checks.has_network = !!a.network;
  out.checks.has_chainId = (a.chainId !== undefined && a.chainId !== null);
  out.checks.asset_is_address = HEX40.test(String(a.asset || ''));
  out.checks.payTo_is_address = HEX40.test(String(a.payTo || ''));
  out.checks.amount_positive = Number(a.maxAmountRequired) > 0;
  out.score = Object.values(out.checks).filter(Boolean).length;
  out.compliant = out.score === out.maxScore;
  if (!out.compliant) out.reason = 'incomplete_challenge';
  return out;
}

async function probeUrl(url, timeoutMs) {
  const r = await fetchOnce(url, timeoutMs || 15000);
  if (r.error) return { url, status: null, compliant: false, reason: r.error, checks: {}, accepts: [], score: 0, maxScore: 6 };
  return analyzeChallenge(r.status, r.headers, r.body, url);
}

module.exports = { probeUrl, analyzeChallenge, fetchOnce };
